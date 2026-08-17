<script lang="ts">
	/**
	 * Whether outbound mail can actually leave, and how to finish setting it up.
	 *
	 * Three claims, kept apart because they have different authorities: the
	 * provider's own readiness evidence (authoritative for sending), the public
	 * DNS records (advisory — they diagnose deliverability, they gate nothing),
	 * and a real test message a person confirms by looking in a mailbox. The
	 * setup steps come from the provider adapter's manifest, so this panel and
	 * a guided agent session read the same checklist.
	 */
	import { onMount } from 'svelte';
	import {
		EMAIL_READINESS_CURRENCY_REASON_CODES,
		type EmailDeliverabilityCheckProjection,
		type EmailSetupGuideProjection
	} from '@jooevents/contracts';
	import { Badge, Button, statusIcon, type IconComponent } from '$lib/ui';
	import type { SettingsEmailDeliveryPort } from '$lib/api/settings-page-port';
	import type { EmailProviderReadinessView } from '$lib/api/view-models/communications-provider-read';

	let { delivery }: { readonly delivery?: SettingsEmailDeliveryPort } = $props();

	let loaded = $state(false);
	let readiness = $state<EmailProviderReadinessView | null>(null);
	let guide = $state<EmailSetupGuideProjection | null>(null);
	/** True when the executors answered `not_available`: no provider is configured. */
	let unconfigured = $state(false);
	let readFailed = $state(false);
	let guideFailed = $state(false);

	let checking = $state(false);
	let checkNotice = $state<string | null>(null);
	let dnsChecking = $state(false);
	let dns = $state<EmailDeliverabilityCheckProjection | null>(null);
	let dnsNotice = $state<string | null>(null);
	let testRecipient = $state('');
	let testSending = $state(false);
	let testNotice = $state<string | null>(null);

	const lifecycle = new AbortController();

	/**
	 * Passed evidence expires within minutes by design, so "expired" and
	 * "never checked" are currency states of a possibly healthy connection,
	 * not defects; they get the quiet badge and a run-a-check sentence. The
	 * set is the contract's, shared with every surface making this call.
	 */
	const CURRENCY_REASONS = new Set<string>(EMAIL_READINESS_CURRENCY_REASON_CODES);

	const outboundState = $derived.by(() => {
		const outbound = readiness?.outbound;
		if (!outbound) return null;
		if (outbound.state === 'action_required' && CURRENCY_REASONS.has(outbound.reasonCode)) {
			return 'not_verified' as const;
		}
		return outbound.state;
	});

	const stateBadge: Record<
		'ready' | 'action_required' | 'unknown' | 'not_verified',
		{
			label: string;
			tone: 'success' | 'warning' | 'neutral';
			solid: boolean;
			icon: IconComponent;
			sentence: string;
		}
	> = {
		ready: {
			label: 'Ready',
			tone: 'success',
			solid: false,
			icon: statusIcon.ready,
			sentence: 'The provider accepted the last readiness check.'
		},
		action_required: {
			label: 'Action required',
			tone: 'warning',
			solid: true,
			icon: statusIcon.actionRequired,
			sentence: 'The provider connection is not ready to send.'
		},
		unknown: {
			label: 'Not set up',
			tone: 'neutral',
			solid: false,
			icon: statusIcon.notConfigured,
			sentence: 'No email provider is connected for this installation.'
		},
		not_verified: {
			label: 'Not verified',
			tone: 'neutral',
			solid: false,
			icon: statusIcon.notChecked,
			sentence:
				'The last readiness check has expired or has not run yet. Run a check to confirm sending works.'
		}
	};

	const recordLabel: Record<'spf' | 'dkim' | 'dmarc', string> = {
		spf: 'Sender authorization (SPF)',
		dkim: 'Message signature (DKIM)',
		dmarc: 'Delivery policy (DMARC)'
	};

	const recordBadge: Record<
		EmailDeliverabilityCheckProjection['records'][number]['state'],
		{ label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; solid: boolean }
	> = {
		found: { label: 'Found', tone: 'success', solid: false },
		missing: { label: 'Not found', tone: 'danger', solid: true },
		mismatch: { label: 'Different value', tone: 'warning', solid: true },
		lookup_failed: { label: 'Could not check', tone: 'neutral', solid: false }
	};

	const dnsSummary: Record<EmailDeliverabilityCheckProjection['overall'], string> = {
		pass: 'All three records resolve publicly with the expected values.',
		action_required:
			"At least one record is missing or different. Fix it where the domain's DNS is hosted, then check again.",
		unknown: 'Some records could not be checked. Try again in a moment.'
	};

	function setupFailureSentence(kind: 'refused' | 'transport_error', retryable?: boolean): string {
		if (kind === 'refused') return 'You do not have permission to run provider setup.';
		return retryable === false
			? 'This request was not valid.'
			: 'JooEvents could not be reached. Try again.';
	}

	/* Every await below can throw when the unmount abort lands mid-flight; an
	   aborted panel has nothing to report and must not leak an unhandled
	   rejection, so each function catches, keeps quiet on abort, and states a
	   transport failure otherwise. */

	async function loadReadiness() {
		if (!delivery) return;
		try {
			const result = await delivery.readiness({ signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			if (result.kind === 'success') {
				readiness = result.data;
				readFailed = false;
			} else {
				readFailed = true;
			}
		} catch {
			if (!lifecycle.signal.aborted) readFailed = true;
		}
	}

	async function loadGuide() {
		if (!delivery) return;
		try {
			const result = await delivery.guide({ signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			if (result.kind === 'completed') {
				guide = result.data;
				guideFailed = false;
			} else if (result.kind === 'not_available') {
				unconfigured = true;
			} else {
				guideFailed = true;
			}
		} catch {
			if (!lifecycle.signal.aborted) guideFailed = true;
		}
	}

	async function load() {
		if (!delivery) {
			loaded = true;
			return;
		}
		await Promise.all([loadReadiness(), loadGuide()]);
		if (lifecycle.signal.aborted) return;
		loaded = true;
	}

	async function runCheck() {
		if (!delivery || checking) return;
		checking = true;
		checkNotice = null;
		try {
			const result = await delivery.runReadinessCheck({ signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			if (result.kind === 'completed') {
				// Refresh before speaking: the sentence sits beside the badge, so
				// it may only claim what the refreshed connection state agrees with.
				await loadReadiness();
				if (lifecycle.signal.aborted) return;
				checkNotice = result.data.state !== 'passed'
					? 'The readiness check failed. The evidence is recorded; the steps below are the way forward.'
					: outboundState === 'ready'
						? 'The provider accepted the readiness check.'
						: 'The provider accepted the check, but the connection is still not ready to send — the steps below are the way forward.';
				return;
			}
			if (result.kind === 'not_available') {
				unconfigured = true;
				return;
			}
			checkNotice = setupFailureSentence(
				result.kind,
				result.kind === 'transport_error' ? result.retryable : undefined
			);
		} catch {
			if (!lifecycle.signal.aborted) checkNotice = setupFailureSentence('transport_error', true);
		} finally {
			checking = false;
		}
	}

	async function runDnsCheck() {
		if (!delivery || dnsChecking) return;
		dnsChecking = true;
		dnsNotice = null;
		try {
			const result = await delivery.checkDns({ signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			if (result.kind === 'completed') {
				dns = result.data;
				return;
			}
			if (result.kind === 'sender_domain_unavailable') {
				// A configured provider whose from-address has no public domain:
				// a completed answer about this installation, never "no provider".
				dns = null;
				dnsNotice =
					"The send-from address has no public domain to look up, so there are no DNS records to check. The provider's own readiness decides whether mail sends.";
				return;
			}
			if (result.kind === 'not_available') {
				unconfigured = true;
				return;
			}
			dnsNotice = setupFailureSentence(
				result.kind,
				result.kind === 'transport_error' ? result.retryable : undefined
			);
		} catch {
			if (!lifecycle.signal.aborted) dnsNotice = setupFailureSentence('transport_error', true);
		} finally {
			dnsChecking = false;
		}
	}

	async function sendTest(submitEvent: SubmitEvent) {
		submitEvent.preventDefault();
		if (!delivery || testSending) return;
		const recipient = testRecipient.trim();
		if (recipient.length === 0) {
			testNotice = 'Enter one full email address.';
			return;
		}
		testSending = true;
		testNotice = null;
		try {
			const result = await delivery.sendTest(recipient, { signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			if (result.kind === 'completed') {
				testNotice = result.data.state === 'accepted'
					? `The provider accepted the test message. Check the inbox — and the spam folder — at ${recipient}.`
					: result.data.state === 'acceptance_unknown'
						? 'It is not known whether the provider accepted the test message. Check the mailbox before sending another.'
						: 'The provider refused the test message.';
				return;
			}
			if (result.kind === 'invalid_recipient') {
				testNotice = 'Enter one full email address.';
				return;
			}
			if (result.kind === 'not_available') {
				unconfigured = true;
				return;
			}
			testNotice = setupFailureSentence(
				result.kind,
				result.kind === 'transport_error' ? result.retryable : undefined
			);
		} catch {
			if (!lifecycle.signal.aborted) testNotice = setupFailureSentence('transport_error', true);
		} finally {
			testSending = false;
		}
	}

	onMount(() => {
		void load();
		return () => lifecycle.abort();
	});
</script>

<section class="panel" id="settings-email-delivery" aria-label="Email delivery">
	<header class="panel__head"><h2>Delivery</h2></header>

	{#if !delivery}
		<p class="quiet">Delivery status is not part of this preview.</p>
	{:else if !loaded}
		<div class="status" aria-hidden="true">
			<span class="ui-skeleton skeleton-line" style="inline-size: 10rem"></span>
			<span class="ui-skeleton skeleton-line" style="inline-size: 22rem"></span>
		</div>
	{:else if unconfigured}
		<!-- The truth for a fresh installation: nothing to check yet, and the
		     configuration lives in the deployment, not in this workspace. -->
		<p class="quiet">
			Outbound email is not configured for this installation. An administrator connects a
			sending provider in the deployment configuration; once that is done, this panel
			verifies the connection and its DNS records.
		</p>
	{:else}
		{#if outboundState !== null}
			{@const badge = stateBadge[outboundState]}
			<div class="status">
				<Badge tone={badge.tone} emphasis={badge.solid} icon={badge.icon} value={badge.label} />
				<p class="status__sentence">
					{badge.sentence}
					{#if readiness?.provider}
						Provider: {readiness.provider.displayName}.
					{/if}
				</p>
			</div>
		{:else if readFailed}
			<p class="notice" role="alert">The delivery status could not be loaded. Try again.</p>
		{/if}

		<div class="actions">
			<Button size="sm" variant="secondary" loading={checking} onclick={() => void runCheck()}>
				Run readiness check
			</Button>
			<Button size="sm" variant="secondary" loading={dnsChecking} onclick={() => void runDnsCheck()}>
				Check DNS records
			</Button>
		</div>
		{#if checkNotice}
			<p class="notice" role="status">{checkNotice}</p>
		{/if}

		{#if dnsNotice}
			<p class="notice" role="status">{dnsNotice}</p>
		{/if}
		{#if dns}
			<div class="dns" role="group" aria-label="DNS records for {dns.domain}">
				<p class="dns__summary">{dnsSummary[dns.overall]}</p>
				<ul class="records">
					{#each dns.records as record (record.key)}
						{@const badge = recordBadge[record.state]}
						<li class="record">
							<span class="record__label">{recordLabel[record.key]}</span>
							<code class="record__name">{record.recordName}</code>
							<span class="record__state">
								<Badge tone={badge.tone} emphasis={badge.solid} value={badge.label} />
							</span>
							{#if record.state === 'mismatch'}
								<code class="record__observed">{record.observedValues.join(' · ')}</code>
							{/if}
						</li>
					{/each}
				</ul>
				<p class="dns__note">
					These checks read public DNS and are advisory — the provider's own readiness
					decides whether mail sends.
				</p>
			</div>
		{/if}

		{#if guideFailed}
			<!-- The steps exist and did not arrive — said so, with the retry beside
			     the failure it answers, instead of a section that silently never
			     renders. -->
			<div class="guide-failed">
				<p class="notice" role="alert">The setup steps could not be loaded.</p>
				<Button size="sm" variant="secondary" onclick={() => void loadGuide()}>Try again</Button>
			</div>
		{/if}
		{#if guide && outboundState !== 'ready'}
			<div class="guide" role="group" aria-label="Setup steps">
				<h3 class="guide__title">Setup steps</h3>
				<ol class="steps">
					{#each guide.steps as step (step.key)}
						<li class="step">
							<span class="step__title">{step.title}</span>
							<span class="step__instruction">
								{step.instruction}
								{#if step.officialLink}
									<a href={step.officialLink.href} target="_blank" rel="noreferrer">
										{step.officialLink.label}</a>
								{/if}
							</span>
						</li>
					{/each}
				</ol>
			</div>
		{/if}

		<form class="test" novalidate onsubmit={sendTest}>
			<label class="test__label" for="settings-email-delivery-test-recipient">
				Send a test message
			</label>
			<div class="test__row">
				<input
					class="ui-control"
					type="text"
					inputmode="email"
					autocomplete="email"
					spellcheck="false"
					id="settings-email-delivery-test-recipient"
					placeholder="you@example.com"
					bind:value={testRecipient}
					oninput={() => (testNotice = null)} />
				<Button type="submit" size="sm" loading={testSending}>Send test</Button>
			</div>
			<p class="test__note">
				The one proof no check can give: the message lands in a real mailbox, and you see
				whether it arrived in the inbox or in spam.
			</p>
			{#if testNotice}
				<p class="notice" role="status">{testNotice}</p>
			{/if}
		</form>
	{/if}
</section>

<style>
	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		margin-block-end: var(--je-space-4);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.quiet,
	.notice,
	.status__sentence,
	.dns__summary,
	.dns__note,
	.test__note {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		max-inline-size: 58ch;
	}

	.status {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-3);
		flex-wrap: wrap;
		margin-block-end: var(--je-space-4);
	}

	.actions {
		display: flex;
		gap: var(--je-space-3);
		flex-wrap: wrap;
		margin-block-end: var(--je-space-3);
	}

	.notice {
		margin-block-end: var(--je-space-3);
	}

	.dns {
		display: grid;
		gap: var(--je-space-2);
		margin-block-end: var(--je-space-4);
		padding: var(--je-space-3);
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
	}

	.records {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--je-space-2);
	}

	.record {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--je-space-1) var(--je-space-3);
		align-items: center;
		font-size: var(--je-font-size-sm);
	}

	.record__label {
		font-weight: 600;
	}

	.record__state {
		grid-column: 2;
		grid-row: 1;
		justify-self: end;
	}

	.record__name,
	.record__observed {
		grid-column: 1 / -1;
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.guide {
		margin-block-end: var(--je-space-4);
	}

	.guide-failed {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		flex-wrap: wrap;
		margin-block-end: var(--je-space-4);
	}

	.guide__title {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.steps {
		margin: 0;
		padding-inline-start: var(--je-space-5);
		display: grid;
		gap: var(--je-space-2);
		max-inline-size: 58ch;
	}

	.step {
		font-size: var(--je-font-size-sm);
	}

	.step__title {
		font-weight: 600;
		display: block;
	}

	.step__instruction {
		color: var(--je-color-text-muted);
	}

	.test {
		display: grid;
		gap: var(--je-space-2);
		max-inline-size: 32rem;
	}

	.test__label {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.test__row {
		display: flex;
		gap: var(--je-space-2);
		align-items: center;
	}

	.test__row input {
		flex: 1;
		min-inline-size: 0;
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}
</style>
