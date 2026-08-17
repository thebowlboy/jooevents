<script lang="ts">
	/**
	 * How outbound mail presents itself: the address it is sent from, the name
	 * beside it, and where replies land.
	 *
	 * The from-address is read-only because it is installation configuration —
	 * mail is signed for it, so moving it per workspace would break SPF/DKIM
	 * alignment. The two workspace-editable values commit together against one
	 * head version, so this panel is one form with one save.
	 *
	 * The section is workspace-scoped: it answers before any event exists, so it
	 * reads its own state rather than waiting on the shell's event read.
	 */
	import { onMount } from 'svelte';
	import { UNCONFIGURED_MAIL_FROM_ADDRESS } from '@jooevents/contracts';
	import { Button, CopyValue, Field, Term } from '$lib/ui';
	import type { SettingsPagePort } from '$lib/api/settings-page-port';
	import type {
		SenderIdentityReadResult,
		SenderIdentityUpdate,
		SenderIdentityView
	} from '$lib/api/sender-identity-settings-port';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import {
		senderIdentityDirty,
		senderIdentityDraft,
		senderIdentityFieldControlId,
		senderIdentityReadSentence,
		senderIdentityRefusalSentence,
		senderIdentitySaveSentence,
		senderIdentitySupportCode,
		senderIdentityUpdate,
		senderPreview,
		senderPreviewLines,
		type SenderIdentityDraft
	} from './sender-identity-view';

	let { port }: { readonly port: SettingsPagePort } = $props();

	type ReadFailure = Exclude<SenderIdentityReadResult, { readonly kind: 'success' }>;

	let view = $state<SenderIdentityView | null>(null);
	let readFailure = $state<ReadFailure | null>(null);
	let loaded = $state(false);
	let reading = $state(false);
	let draft = $state<SenderIdentityDraft>({ displayName: '', replyToAddress: '' });
	let saving = $state(false);
	let saved = $state(false);
	let fieldErrors = $state({ display_name: '', reply_to_address: '' });
	/** A save failure that belongs to the whole unit rather than to one box. */
	let notice = $state<{ text: string; supportCode?: string; stale: boolean } | null>(null);

	const lifecycle = new AbortController();

	const dirty = $derived(view ? senderIdentityDirty(draft, view) : false);
	const lines = $derived(view ? senderPreviewLines(senderPreview(draft, view)) : null);

	async function load() {
		reading = true;
		const result = await port.senderIdentity.read({ signal: lifecycle.signal });
		if (lifecycle.signal.aborted) return;
		if (result.kind === 'success') {
			view = result.data;
			draft = senderIdentityDraft(result.data);
			readFailure = null;
			notice = null;
		} else {
			readFailure = result;
		}
		reading = false;
		loaded = true;
	}

	/**
	 * One save, whether it came from the button or from undoing one. Every arm
	 * of the result is answered: a refusal pins to the box that caused it, and
	 * anything else states what happened for the unit.
	 */
	async function commit(update: SenderIdentityUpdate): Promise<boolean> {
		saving = true;
		saved = false;
		notice = null;
		fieldErrors = { display_name: '', reply_to_address: '' };
		const result = await port.senderIdentity.save(update, { signal: lifecycle.signal });
		if (lifecycle.signal.aborted) return false;
		saving = false;
		if (result.kind === 'saved') {
			view = result.data;
			draft = senderIdentityDraft(result.data);
			saved = true;
			return true;
		}
		if (result.kind === 'refused') {
			fieldErrors = {
				...fieldErrors,
				[result.field]: senderIdentityRefusalSentence(result.code)
			};
			document.getElementById(senderIdentityFieldControlId[result.field])?.focus();
			return false;
		}
		notice = {
			text: senderIdentitySaveSentence(result),
			...(senderIdentitySupportCode(result)
				? { supportCode: senderIdentitySupportCode(result) }
				: {}),
			stale: result.kind === 'stale'
		};
		return false;
	}

	async function save(submitEvent: SubmitEvent) {
		submitEvent.preventDefault();
		const current = view;
		if (!current || saving) return;
		const previous = { displayName: current.displayName, replyToAddress: current.replyToAddress };
		// The same derivation the Save button's enabled state reads, so a save can
		// never send a pair the panel called unchanged.
		const committed = await commit(senderIdentityUpdate(draft, current));
		if (!committed) return;
		recordAction({
			area: 'settings',
			label: 'Changed the workspace email sender',
			// The compensator is another commit of the prior pair against the head
			// this panel currently holds, so a change landing in between is refused
			// with its own sentence rather than silently overwritten.
			undo: async () => {
				const head = view?.headVersion;
				if (head === undefined) return;
				await commit({ expectedHeadVersion: head, ...previous });
			}
		});
	}

	/** A save message describes the values as they were saved, so editing clears it. */
	function edited(field: 'display_name' | 'reply_to_address') {
		saved = false;
		notice = null;
		if (fieldErrors[field]) fieldErrors = { ...fieldErrors, [field]: '' };
	}

	onMount(() => {
		void load();
		return () => lifecycle.abort();
	});
</script>

{#snippet installationNote()}
	<p class="from__note">
		Set once for this installation, not per workspace: outbound mail is signed for this
		address, so a different one here would fail
		<Term
			term="SPF and DKIM"
			definition="Checks a receiving mail server runs against the sending domain’s DNS records to confirm a message really came from it." />
		checks and land in spam.
	</p>
{/snippet}

{#if !loaded}
	<!-- This panel's own markup holding skeleton fills, so the waiting page and
	     the resolved page share one geometry. -->
	<section class="panel" id="settings-email-sender" aria-label="Loading email sender">
		<header class="panel__head"><h2>Sender</h2></header>
		<div class="from">
			<span class="from__label">From address</span>
			<span class="from__value"><span class="ui-skeleton skeleton-line" style="inline-size: 16rem"></span></span>
			{@render installationNote()}
		</div>
		<div class="form" aria-hidden="true">
			{#each ['name', 'reply'] as key (key)}
				<div class="ui-field">
					<div class="ui-field__heading">
						<span class="ui-label"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
					</div>
					<span class="ui-skeleton skeleton-control"></span>
				</div>
			{/each}
			<dl class="preview">
				<dt>From</dt>
				<dd><span class="ui-skeleton skeleton-line" style="inline-size: min(22rem, 100%)"></span></dd>
				<dt>Reply-to</dt>
				<dd><span class="ui-skeleton skeleton-line" style="inline-size: min(18rem, 100%)"></span></dd>
			</dl>
			<div class="form__actions"><span class="ui-skeleton skeleton-action"></span></div>
		</div>
	</section>
{:else if readFailure}
	<section class="panel" id="settings-email-sender" aria-label="Email sender">
		<header class="panel__head"><h2>Sender</h2></header>
		<p class="state" role={readFailure.kind === 'denied' ? 'status' : 'alert'}>
			{senderIdentityReadSentence(readFailure)}
		</p>
		{#if senderIdentitySupportCode(readFailure)}
			<p class="state__support">
				Support code:
				<CopyValue value={senderIdentitySupportCode(readFailure) ?? ''} label="support code" />
			</p>
		{/if}
		{#if readFailure.kind === 'failure' && readFailure.retryable}
			<div class="form__actions">
				<Button size="sm" variant="secondary" loading={reading} onclick={() => void load()}>
					Try again
				</Button>
			</div>
		{/if}
	</section>
{:else if view}
	<section class="panel" id="settings-email-sender" aria-label="Email sender">
		<header class="panel__head"><h2>Sender</h2></header>

		<div class="from">
			<span class="from__label">From address</span>
			<span class="from__value">
				<CopyValue value={view.effective.fromAddress} label="from address" />
			</span>
			{#if view.effective.fromAddress === UNCONFIGURED_MAIL_FROM_ADDRESS}
				<!-- The contract's one unconfigured sentinel, compared exactly — a
				     suffix sniff would silently stop firing if the sentinel were
				     ever renamed. The consequence is stated here where the address
				     is read, not discovered at the first failed send. -->
				<p class="from__warning" role="alert">
					No sending address is configured for this installation yet, so JooEvents
					cannot send email — sign-in links included.
				</p>
			{/if}
			{@render installationNote()}
		</div>

		<!-- The operation owns acceptance, length included. A browser-native check
		     would gate the save behind copy nobody reviewed, and a `maxlength`
		     would truncate a pasted value without saying so — both in place of the
		     refusal that names the rule. -->
		<form class="form" novalidate onsubmit={save}>
			<Field
				id={senderIdentityFieldControlId.display_name}
				label="Sender name"
				error={fieldErrors.display_name}>
				{#snippet children({ id, describedBy, invalid })}
					<input
						class="ui-control"
						type="text"
						{id}
						aria-describedby={describedBy}
						aria-invalid={invalid}
						placeholder={view?.displayName === null
							? (view?.effective.fromDisplayName ?? '')
							: ''}
						bind:value={draft.displayName}
						oninput={() => edited('display_name')} />
				{/snippet}
			</Field>

			<Field
				id={senderIdentityFieldControlId.reply_to_address}
				label="Reply-to address"
				error={fieldErrors.reply_to_address}>
				{#snippet children({ id, describedBy, invalid })}
					<input
						class="ui-control"
						type="text"
						inputmode="email"
						autocomplete="email"
						spellcheck="false"
						{id}
						aria-describedby={describedBy}
						aria-invalid={invalid}
						placeholder={view?.replyToAddress === null
							? (view?.effective.replyToAddress ?? '')
							: ''}
						bind:value={draft.replyToAddress}
						oninput={() => edited('reply_to_address')} />
				{/snippet}
			</Field>

			<!-- What the next message carries, from the boxes as they stand. It
			     replaces per-field help: an emptied box shows its consequence here
			     rather than being described twice. Grouped rather than listed —
			     "Next message" is the only word saying these are not settings. -->
			<dl class="preview" role="group" aria-label="Next message">
				<dt>From</dt>
				<dd>{lines?.from}</dd>
				<dt>Reply-to</dt>
				<dd>{lines?.replyTo}</dd>
			</dl>

			<div class="form__actions">
				<Button type="submit" size="sm" loading={saving} disabled={!dirty}>Save</Button>
				<!-- The region stands before it has anything to say: a polite live
				     region inserted with its message is not reliably announced. -->
				<p class="form__saved" role="status">{saved ? 'Saved' : ''}</p>
			</div>

			{#if notice}
				<p class="form__notice" role="alert">
					{notice.text}
					{#if notice.supportCode}
						<span class="form__support">
							Support code: <CopyValue value={notice.supportCode} label="support code" />
						</span>
					{/if}
				</p>
				{#if notice.stale}
					<div class="form__actions">
						<Button size="sm" variant="secondary" loading={reading} onclick={() => void load()}>
							Reload
						</Button>
					</div>
				{/if}
			{/if}
		</form>
	</section>
{/if}

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

	/* A fact, not a control: label, value, and the one sentence that says why it
	   is not editable here. */
	.from {
		display: grid;
		gap: var(--je-space-1);
		max-inline-size: 52rem;
		margin-block-end: var(--je-space-4);
	}

	.from__label {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.from__value {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-block-size: var(--je-control-height-sm);
		font-family: var(--je-font-mono);
		font-size: var(--je-font-size-sm);
		overflow-wrap: anywhere;
	}

	.from__note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		max-inline-size: 58ch;
	}

	.from__warning {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
		max-inline-size: 58ch;
	}

	.form {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--je-space-4);
		max-inline-size: 52rem;
	}

	.preview,
	.form__actions,
	.form__notice {
		grid-column: 1 / -1;
	}

	/* The one place the two boxes are read together, so it sits sunken and
	   bounded rather than as another run of body copy. */
	.preview {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--je-space-1) var(--je-space-3);
		margin: 0;
		padding: var(--je-space-3);
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		font-size: var(--je-font-size-sm);
	}

	.preview dt {
		color: var(--je-color-text-muted);
	}

	.preview dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.form__actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-block-size: var(--je-control-height-sm);
	}

	.form__saved {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-success);
	}

	.form__notice,
	.state,
	.state__support {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		max-inline-size: 58ch;
	}

	.form__notice {
		color: var(--je-color-danger);
	}

	.form__support {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		color: var(--je-color-text-muted);
	}

	.state,
	.state__support {
		margin-block-end: var(--je-space-3);
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-control {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 6.5rem;
		border-radius: var(--je-radius-control);
		vertical-align: bottom;
	}

	@media (max-width: 920px) {
		.form {
			grid-template-columns: 1fr;
		}
	}
</style>
