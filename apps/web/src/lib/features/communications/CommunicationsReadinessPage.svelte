<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge, CopyValue, statusIcon } from '$lib/ui';
	import type {
		CommunicationsReadinessFailure,
		CommunicationsReadinessPagePort
	} from '$lib/api/communications-readiness-page-port';
	import type { EmailProviderReadinessView } from '$lib/api/view-models/communications-provider-read';

	let { port }: { readonly port: CommunicationsReadinessPagePort } = $props();

	let readiness = $state<EmailProviderReadinessView | null>(null);
	let failure = $state<CommunicationsReadinessFailure | null>(null);
	let loading = $state(false);
	const lifecycle = new AbortController();

	function failureCopy(state: CommunicationsReadinessFailure): string {
		if (state.kind === 'access_denied') {
			return 'You don’t have access to email-provider readiness for this workspace.';
		}
		if (state.kind === 'unavailable') {
			return 'Email-provider readiness is not available in this build.';
		}
		return state.error.retryable
			? 'Email-provider readiness couldn’t be reached. Try again.'
			: 'Email-provider readiness couldn’t be loaded.';
	}

	function supportCode(state: CommunicationsReadinessFailure): string | undefined {
		return state.kind === 'transport_error'
			? state.error.correlationId
			: state.correlationId;
	}

	async function load() {
		loading = true;
		failure = null;
		try {
			const result = await port.read({ signal: lifecycle.signal });
			if (lifecycle.signal.aborted) return;
			if (result.kind === 'success') readiness = result.data;
			else failure = result;
		} catch {
			if (!lifecycle.signal.aborted) {
				failure = {
					kind: 'transport_error',
					error: { code: 'network_unavailable', retryable: true }
				};
			}
		} finally {
			if (!lifecycle.signal.aborted) loading = false;
		}
	}

	const providerLabel = $derived(readiness?.provider?.displayName);
	const attentionNeeded = $derived(readiness?.outbound.state === 'action_required');
	const checks = $derived(readiness
		? [
				{ key: 'outbound', label: 'Outbound sending', state: readiness.outbound.state },
				{ key: 'callbacks', label: 'Delivery reports', state: readiness.callbacks.state },
				{ key: 'inbound', label: 'Inbound replies', state: readiness.inbound.state }
			]
		: []);

	function checkPresentation(state: (typeof checks)[number]['state']) {
		switch (state) {
			case 'ready':
				return { label: 'Ready', tone: 'success' as const, icon: statusIcon.ready };
			case 'action_required':
				return {
					label: 'Action required', tone: 'warning' as const,
					emphasis: true, icon: statusIcon.actionRequired
				};
			case 'unknown':
				return { label: 'Not checked', tone: 'neutral' as const, icon: statusIcon.notChecked };
			case 'not_supported':
				return { label: 'Not supported', tone: 'neutral' as const, icon: statusIcon.notConfigured };
			case 'not_enabled':
				return { label: 'Not enabled', tone: 'neutral' as const, icon: statusIcon.notConfigured };
		}
	}

	onMount(() => {
		void load();
		return () => lifecycle.abort();
	});
</script>

{#if readiness}
	<section
		class="card"
		class:card--attention={attentionNeeded}
		class:is-refreshing={loading}
		aria-busy={loading || undefined}
		aria-label="Email delivery">
		<header class="card__head">
			<h2 class="card__title">Email delivery</h2>
			{#if providerLabel}<span class="card__meta">via {providerLabel}</span>{/if}
		</header>
		{#if attentionNeeded}
			<p class="card__note">
				Outbound sending needs attention. Messages remain unsent until readiness is restored.
			</p>
		{:else if readiness.outbound.state === 'unknown'}
			<p class="card__note">No outbound email provider is ready for this workspace yet.</p>
		{/if}
		<ul class="checks">
			{#each checks as check (check.key)}
				{@const presentation = checkPresentation(check.state)}
				<li class="check" class:check--action={check.state === 'action_required'}>
					<span class="check__label">{check.label}</span>
					<Badge
						tone={presentation.tone}
						emphasis={presentation.emphasis ?? false}
						icon={presentation.icon}>{presentation.label}</Badge>
				</li>
			{/each}
		</ul>
	</section>
{:else if failure}
	<section class="card state" aria-labelledby="email-delivery-unavailable" role="alert">
		<header class="card__head">
			<h2 class="card__title" id="email-delivery-unavailable">Email delivery</h2>
		</header>
		<p class="state__copy">{failureCopy(failure)}</p>
		{#if supportCode(failure)}
			<p class="state__support">
				Support code: <CopyValue value={supportCode(failure) ?? ''} label="support code" />
			</p>
		{/if}
		{#if failure.kind === 'transport_error' && failure.error.retryable}
			<button class="ui-button ui-button--secondary ui-button--sm" type="button" disabled={loading} onclick={() => void load()}>
				{loading ? 'Trying again…' : 'Try again'}
			</button>
		{/if}
	</section>
{:else}
	<section class="card" aria-label="Email delivery">
		<header class="card__head">
			<h2 class="card__title">Email delivery</h2>
			<span class="card__meta"><span class="ui-skeleton skeleton-line"></span></span>
		</header>
		<ul class="checks" aria-hidden="true">
			{#each Array(3) as _, index (index)}
				<li class="check">
					<span class="check__label"><span class="ui-skeleton skeleton-line skeleton-label"></span></span>
					<span class="ui-skeleton skeleton-chip"></span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	/* This is the tuned delivery card's smallest independent composition. Keeping
	   it separate avoids importing the full page and its unavailable send/history API. */
	.card {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.card--attention {
		border: 2px solid var(--je-color-warning-fill);
		padding: calc(var(--je-space-4) - 1px);
	}

	.card__head {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-block-size: var(--je-control-height-sm);
		margin-block-end: var(--je-space-3);
	}

	.card__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.card__meta,
	.card__note,
	.state__copy,
	.state__support {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.card__note {
		margin: 0 0 var(--je-space-3);
	}

	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.check {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-3);
		min-block-size: var(--je-control-height-sm);
		padding-block: var(--je-space-2);
	}

	.check + .check {
		border-block-start: 1px solid var(--je-color-border);
	}

	.check__label {
		font-size: var(--je-font-size-md);
		font-weight: 500;
	}

	.is-refreshing .checks {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.state__copy,
	.state__support {
		margin: 0 0 var(--je-space-3);
		max-inline-size: 58ch;
	}

	.skeleton-line {
		display: inline-block;
		inline-size: 4.5rem;
	}

	.skeleton-label {
		inline-size: 10rem;
	}
</style>
