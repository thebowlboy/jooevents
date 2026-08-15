<script lang="ts">
	import { Field, Modal } from '$lib/ui';
	import type { CommunicationsPagePort } from '$lib/api/communications-page-port';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import EmailRender from '$lib/features/templates/EmailRender.svelte';
	import type { AudienceOption, EventTheme, MessageTemplate } from '$lib/api/types';

	interface Props {
		port: CommunicationsPagePort;
		open?: boolean;
		/** Stored message templates, read by the page; null while loading. */
		templates: MessageTemplate[] | null;
		/** The event brand behind the preview, loaded by the page; null while loading. */
		theme: EventTheme | null;
		eventName: string;
		eventMeta: string;
		/** A person the compose arrived scoped to; prefills a one-person audience. */
		personId: string | null;
		/** Called after a draft lands, so the page re-reads its queue. */
		onCreated: () => void | Promise<void>;
	}

	let {
		port,
		open = $bindable(false),
		templates,
		theme,
		eventName,
		eventMeta,
		personId,
		onCreated
	}: Props = $props();

	const api = $derived(port);

	let subject = $state('');
	/** Empty string is the blank start; otherwise the chosen template's id. */
	let templateId = $state('');
	let audienceId = $state('');
	let audiencesState = $state<LiveReadState<AudienceOption[]>>({ kind: 'resolving' });
	const audiencesRead = new LiveRead<AudienceOption[]>({
		read: async () => [...(await api.communications.audiences(personId ?? undefined))],
		fallback: 'The audiences could not be counted.',
		onChange: (state) => {
			audiencesState = state;
			if (state.kind === 'resolved') audienceId = state.value[0]?.id ?? '';
		}
	});
	const audiences = $derived(
		audiencesState.kind === 'resolved' ? audiencesState.value : null
	);
	let busy = $state(false);

	// Opening resets the fields (a composer is a fresh sheet) and reads the
	// audiences for the current scope; counts come from the API, never a
	// hardcoded roster.
	let openedFor: string | null | undefined = undefined;

	$effect(() => {
		if (!open) {
			openedFor = undefined;
			return;
		}
		const scope = personId;
		if (openedFor !== undefined && openedFor === scope) return;
		openedFor = scope;
		subject = '';
		templateId = '';
		// A fresh request per scope, and the newest one wins: reopening the
		// composer on another person while the first count is still in flight
		// used to let whichever answer landed last install its options, which was
		// not necessarily the scope now on screen. A rejection is now stated in
		// the picker instead of leaving "Counting audiences…" on screen forever.
		void audiencesRead.refresh();
	});

	const template = $derived(templates?.find((entry) => entry.id === templateId) ?? null);
	const audience = $derived(audiences?.find((entry) => entry.id === audienceId) ?? null);

	/**
	 * The preview renders exactly what will send: the stored template with the
	 * live subject line on top. An operator's rewritten subject is theirs and
	 * survives switching templates; only an empty subject or the previous
	 * template's untouched default is replaced.
	 */
	function pickTemplate(nextId: string) {
		const previousDefault = template?.subject ?? '';
		templateId = nextId;
		const next = templates?.find((entry) => entry.id === nextId);
		if (subject.trim() === '' || subject === previousDefault) {
			subject = next?.subject ?? '';
		}
	}

	const previewTemplate = $derived(
		template ? { ...template, subject: subject.trim() === '' ? template.subject : subject } : null
	);

	async function createDraft() {
		const line = subject.trim();
		if (!line || !audienceId || busy) return;
		busy = true;
		await api.communications.compose({
			subject: line,
			audienceId,
			...(templateId ? { templateId } : {})
		});
		await onCreated();
		busy = false;
		open = false;
	}
</script>

<Modal bind:open title="Compose message" size="lg">
	<div class="compose">
		<div class="compose__fields">
			<Field
				id="compose-template"
				label="Template"
				description="Starts the subject from the template; the subject stays editable.">
				{#snippet children({ id, describedBy })}
					<div class="tpl">
						<select
							class="ui-select tpl__select"
							{id}
							aria-describedby={describedBy}
							value={templateId}
							onchange={(event) => pickTemplate(event.currentTarget.value)}>
							<option value="">Start blank</option>
							{#each templates ?? [] as entry (entry.id)}
								<option value={entry.id}>{entry.name}</option>
							{/each}
						</select>
						{#if template}
							<!-- One fact, one door: the chosen template links to its editor. -->
							<a
								class="tpl__edit"
								href={`/app/templates?template=${template.id}`}
								aria-label={`Edit template — ${template.name}`}>
								Edit template
							</a>
						{/if}
					</div>
				{/snippet}
			</Field>
			<Field id="compose-subject" label="Subject" required>
				{#snippet children({ id, describedBy, invalid })}
					<input
						class="ui-control"
						type="text"
						{id}
						aria-describedby={describedBy}
						aria-invalid={invalid}
						placeholder="Travel and arrival details"
						bind:value={subject} />
				{/snippet}
			</Field>
			<Field id="compose-audience" label="Audience" description="Counted from the current records.">
				{#snippet children({ id, describedBy })}
					{#if audiences}
						<select class="ui-select" {id} aria-describedby={describedBy} bind:value={audienceId}>
							{#each audiences as option (option.id)}
								<option value={option.id}>{option.label} · {option.count}</option>
							{/each}
						</select>
					{:else if audiencesState.kind === 'unavailable'}
						<!-- No picker to wait on: the count is not coming, and a
						     disabled "Counting audiences…" would say it still is. -->
						<p class="audience-failure" role="alert">
							{audiencesState.message}
							{#if audiencesState.retryable}
								<button
									type="button"
									class="ui-button ui-button--ghost ui-button--sm"
									onclick={() => void audiencesRead.refresh()}>Try again</button>
							{/if}
						</p>
					{:else}
						<select class="ui-select" {id} aria-describedby={describedBy} disabled>
							<option>Counting audiences…</option>
						</select>
					{/if}
				{/snippet}
			</Field>
			<p class="note">
				This creates a draft in the queue{audience ? ` for ${audience.count} recipient${audience.count === 1 ? '' : 's'}` : ''}.
				Nothing sends until you review it — the review shows every recipient and what each one gets.
			</p>
		</div>
		<div class="compose__preview">
			<p class="compose__preview-label">Email preview</p>
			{#if previewTemplate && theme}
				<EmailRender template={previewTemplate} {theme} {eventName} {eventMeta} />
			{:else}
				<!-- Same footprint as a rendered email, so choosing a template never
				     jolts the dialog. -->
				<div class="compose__placeholder">
					<p class="compose__placeholder-title">
						{template ? 'Preparing the preview…' : 'No template chosen'}
					</p>
					<p class="compose__placeholder-hint">
						Pick a template to see the email exactly as recipients get it, with merge fields
						filled from their records. A blank message sends the subject with a plain body.
					</p>
				</div>
			{/if}
		</div>
	</div>
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" disabled={busy} onclick={close}>Cancel</button>
		<button
			type="button"
			class="ui-button ui-button--primary"
			disabled={busy || !subject.trim() || !audienceId}
			aria-busy={busy || undefined}
			onclick={createDraft}>
			{#if busy}<span class="ui-spinner" aria-hidden="true"></span>{/if}
			Create draft
		</button>
	{/snippet}
</Modal>

<style>
	/* Fields lead, the artifact follows: on a wide dialog they sit side by
	   side so edits and their consequence stay in one glance. */
	.compose {
		display: grid;
		grid-template-columns: minmax(16rem, 24rem) minmax(0, 1fr);
		gap: var(--je-space-6);
		align-items: start;
	}

	.compose__fields {
		display: grid;
		gap: var(--je-space-4);
	}

	.compose__preview {
		min-width: 0;
	}

	.compose__preview-label {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* The placeholder borrows the preview's own viewport treatment and holds
	   enough block size that a template choice grows the dialog downward
	   instead of reflowing what the person is reading. */
	.compose__placeholder {
		display: grid;
		align-content: center;
		justify-items: center;
		gap: var(--je-space-1);
		min-block-size: 18rem;
		padding: var(--je-space-8) var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface-sunken);
		text-align: center;
	}

	.compose__placeholder-title {
		margin: 0;
		font-weight: 600;
	}

	.compose__placeholder-hint {
		margin: 0;
		max-inline-size: 26rem;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.tpl {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
	}

	.tpl__select {
		flex: 1 1 auto;
		min-inline-size: 0;
	}

	.tpl__edit {
		flex: none;
		font-size: var(--je-font-size-sm);
	}

	.audience-failure {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.note {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* Narrow widths stack: fields first, the artifact under them. */
	@media (max-width: 920px) {
		.compose {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
