<script lang="ts">
	import { tick } from 'svelte';
	import { Checkbox, ChoiceGroup, Field, Modal } from '$lib/ui';
	import type { CommunicationsPagePort } from '$lib/api/communications-page-port';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import { reachSentence } from '$lib/api/audience-union';
	import { templateKinds } from '$lib/api/template-kinds';
	import EmailRender from '$lib/features/templates/EmailRender.svelte';
	import InlineEditor from '$lib/features/templates/InlineEditor.svelte';
	import {
		editableUnits,
		inlineEditNote,
		messageInlineDoc,
		resolveUnit,
		type InlineEditResult,
		type InlineUnit
	} from '$lib/features/templates/inline-edit';
	import type {
		AudienceOption,
		AudiencePreview,
		EventTheme,
		MessageTemplate
	} from '$lib/api/types';

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
		/**
		 * Called after a template is minted or edited here, so the page re-reads
		 * the store both surfaces share.
		 */
		onTemplatesChanged: () => void | Promise<void>;
	}

	let {
		port,
		open = $bindable(false),
		templates,
		theme,
		eventName,
		eventMeta,
		personId,
		onCreated,
		onTemplatesChanged
	}: Props = $props();

	const api = $derived(port);

	let subject = $state('');
	/** Empty string is the blank start; otherwise the chosen template's id. */
	let templateId = $state('');
	/** The picked audiences, in pick order — the order that decides whose copy a shared person gets. */
	let audienceIds = $state<string[]>([]);
	let audiencesState = $state<LiveReadState<AudienceOption[]>>({ kind: 'resolving' });
	const audiencesRead = new LiveRead<AudienceOption[]>({
		read: async () => [...(await api.communications.audiences(personId ?? undefined))],
		fallback: 'The audiences could not be counted.',
		onChange: (state) => {
			audiencesState = state;
			// The first option is the scoped person when the compose arrived
			// scoped, and otherwise the widest ordinary group — so a scoped
			// compose opens on that person and can still gain groups beside them.
			if (state.kind === 'resolved') {
				const first = state.value[0]?.id;
				audienceIds = first ? [first] : [];
			}
		}
	});
	const audiences = $derived(
		audiencesState.kind === 'resolved' ? audiencesState.value : null
	);
	let busy = $state(false);

	/**
	 * What the current combination actually comes to, resolved by the API from
	 * the same records and the same union the draft will freeze — so the number
	 * here and the number the review states are one claim, never a sum of the
	 * chips (which would count anyone in two groups twice).
	 */
	let preview = $state<AudiencePreview | null>(null);
	let showWho = $state(false);
	// A plain let, deliberately outside the graph: it records which request is
	// newest, so a slow answer for a selection nobody is on any more cannot
	// install itself over the current one.
	let previewToken = 0;

	$effect(() => {
		const ids = [...audienceIds];
		const token = ++previewToken;
		// The list belongs to the selection that produced it; a changed selection
		// closes it rather than leaving other people's names on screen.
		showWho = false;
		if (ids.length === 0) {
			preview = null;
			return;
		}
		void api.communications.previewRecipients(ids).then((next) => {
			if (token === previewToken) preview = next;
		});
	});

	function toggleAudience(id: string) {
		audienceIds = audienceIds.includes(id)
			? audienceIds.filter((entry) => entry !== id)
			: [...audienceIds, id];
	}

	const recipientBadge: Record<
		AudiencePreview['rows'][number]['state'],
		{ tone: string; label: string }
	> = {
		// The review's own words for the same three states: what a person is told
		// while picking must not be renamed when the send is examined.
		included: { tone: 'success', label: 'Included' },
		excluded: { tone: 'warning', label: 'Excluded' },
		blocked: { tone: 'danger', label: 'Could not be prepared' }
	};

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
		// A composer is a fresh sheet, and so is the step it opens on.
		step = 'compose';
		closeInline();
		// A fresh request per scope, and the newest one wins: reopening the
		// composer on another person while the first count is still in flight
		// used to let whichever answer landed last install its options, which was
		// not necessarily the scope now on screen. A rejection is now stated in
		// the picker instead of leaving "Counting audiences…" on screen forever.
		void audiencesRead.refresh();
	});

	const template = $derived(templates?.find((entry) => entry.id === templateId) ?? null);

	// ------------------------------------------------------------- new template

	/**
	 * The composer is one dialog, and the wizard is a step inside it rather than
	 * a second dialog over the first: this product stacks no modals anywhere, and
	 * a dialog over a dialog would fight the focus trap the composer already
	 * owns. Cancel returns to the fields exactly as they were left.
	 */
	let step = $state<'compose' | 'new-template'>('compose');
	let newName = $state('');
	let newKind = $state(templateKinds[0]!.id);
	let creating = $state(false);
	let createError = $state('');

	function openNewTemplate() {
		newName = '';
		newKind = templateKinds[0]!.id;
		createError = '';
		step = 'new-template';
	}

	async function createTemplate() {
		const name = newName.trim();
		if (!name || creating) return;
		creating = true;
		createError = '';
		try {
			const made = await api.templates.create({ name, kind: newKind });
			await onTemplatesChanged();
			// Selected the way any other pick selects, so the subject seeds from
			// the new template exactly as it would from a starter.
			pickTemplate(made.id, made);
			step = 'compose';
		} catch (error) {
			createError = error instanceof Error ? error.message : 'The template could not be created.';
		} finally {
			creating = false;
		}
	}

	// ------------------------------------------------------- edit in the preview

	/**
	 * The preview is editable whenever a stored template is on screen and nothing
	 * is mid-commit. The teaching line follows this same value rather than the
	 * branch, so the composer never offers a press it would refuse.
	 */
	const inlineEnabled = $derived(template !== null && !busy && step === 'compose');

	let inlineUnit = $state<InlineUnit | null>(null);
	let inlineAnchor = $state<HTMLElement | null>(null);
	let inlineBusy = $state(false);
	let inlinePreview = $state<MessageTemplate | null>(null);
	let reserveEl = $state<HTMLElement>();

	// Whatever makes the preview inert also closes an open unit editor.
	$effect(() => {
		if (!inlineEnabled && inlineUnit) closeInline();
	});

	// The pressed unit holds its outline while its editor is open.
	$effect(() => {
		const el = inlineAnchor;
		if (!el) return;
		el.classList.add('ui-editable--active');
		return () => el.classList.remove('ui-editable--active');
	});

	function closeInline() {
		inlineUnit = null;
		inlineAnchor = null;
		inlineBusy = false;
		inlinePreview = null;
	}

	function onUnitPress(path: string, el: HTMLElement) {
		if (!template || !inlineEnabled) return;
		if (inlineUnit?.path === path) return;
		inlinePreview = null;
		const unit = resolveUnit(template, path);
		if (!unit) return;
		inlineUnit = unit;
		inlineAnchor = el;
	}

	/** Live-to-view: every change in the open editor re-renders the preview. */
	function previewInline(result: InlineEditResult) {
		const unit = inlineUnit;
		if (!unit || !template) return;
		inlinePreview = messageInlineDoc($state.snapshot(template) as MessageTemplate, unit, result);
		// The re-render can replace the annotated element the editor anchors to;
		// anchoring is by path, so a replaced element is re-resolved.
		void tick().then(() => {
			if (!inlineUnit || !inlineAnchor || inlineAnchor.isConnected) return;
			const el = reserveEl?.querySelector<HTMLElement>(`[data-edit="${inlineUnit.path}"]`);
			if (el) inlineAnchor = el;
		});
	}

	/**
	 * Commits the edit as the template's next revision through the same
	 * organizer-lane write the Templates editor makes — one history, whichever
	 * surface the change was made on.
	 */
	async function applyInline(result: InlineEditResult) {
		const unit = inlineUnit;
		if (!unit || !template) return;
		const next = messageInlineDoc($state.snapshot(template) as MessageTemplate, unit, result);
		if (!next) {
			closeInline();
			return;
		}
		inlineBusy = true;
		const outcome = await api.templates.commitInline(
			template.id,
			next,
			inlineEditNote(unit, result)
		);
		if (!outcome.ok) {
			createError = outcome.reason;
			inlineBusy = false;
			return;
		}
		await onTemplatesChanged();
		closeInline();
	}

	/**
	 * The preview renders exactly what will send: the stored template with the
	 * live subject line on top. An operator's rewritten subject is theirs and
	 * survives switching templates; only an empty subject or the previous
	 * template's untouched default is replaced.
	 */
	function pickTemplate(nextId: string, known?: MessageTemplate) {
		const previousDefault = template?.subject ?? '';
		templateId = nextId;
		// A freshly minted template is passed in rather than looked up: the
		// picker's list is the page's prop, and seeding must not depend on when
		// that re-read reaches this component.
		const next = known ?? templates?.find((entry) => entry.id === nextId);
		if (subject.trim() === '' || subject === previousDefault) {
			subject = next?.subject ?? '';
		}
	}

	// The open editor's pending copy wins over the stored one, so the preview
	// shows the edit as it is typed; the subject stays the composer's own field.
	const previewTemplate = $derived.by(() => {
		const base = inlinePreview ?? template;
		return base ? { ...base, subject: subject.trim() === '' ? base.subject : subject } : null;
	});

	async function createDraft() {
		const line = subject.trim();
		if (!line || audienceIds.length === 0 || busy) return;
		busy = true;
		await api.communications.compose({
			subject: line,
			audienceIds,
			...(templateId ? { templateId } : {})
		});
		await onCreated();
		busy = false;
		open = false;
	}
</script>

<Modal
	bind:open
	title={step === 'new-template' ? 'New template' : 'Compose message'}
	size="lg">
	{#if step === 'new-template'}
		<!-- One step, not a ceremony: a name and what kind of thing it is. The
		     composer's own fields are untouched behind it, so Cancel is a return
		     rather than a restart. -->
		<div class="wizard">
			<Field id="new-template-name" label="Name" required description="What you’ll pick it by later.">
				{#snippet children({ id, describedBy, invalid })}
					<input
						class="ui-control"
						type="text"
						{id}
						aria-describedby={describedBy}
						aria-invalid={invalid}
						placeholder="Venue change"
						bind:value={newName} />
				{/snippet}
			</Field>
			<fieldset class="kinds">
				<legend class="kinds__legend">What kind</legend>
				{#each templateKinds as kind (kind.id)}
					<label class="kind" class:kind--picked={newKind === kind.id}>
						<input
							type="radio"
							name="new-template-kind"
							class="ui-sr-only"
							value={kind.id}
							checked={newKind === kind.id}
							onchange={() => (newKind = kind.id)} />
						<span class="kind__label">{kind.label}</span>
						<span class="kind__description">{kind.description}</span>
					</label>
				{/each}
			</fieldset>
			{#if createError}<p class="wizard__error" role="alert">{createError}</p>{/if}
		</div>
	{:else}
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
						<!-- A control, not an option: an <option> that opens a dialog is a
						     trap on keyboard and touch, where choosing it in order to read
						     it is the same act as committing to it. -->
						<button type="button" class="tpl__new" onclick={openNewTemplate}>New template…</button>
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
			<!-- Audiences combine, so the control is a set of choices rather than a
			     list of alternatives: a dropdown could only ever say "instead of",
			     and the question here is "as well as". Marking, not the action
			     colour — the checkbox primitive already carries that. -->
			<div class="audience">
				{#if audiences}
					<ChoiceGroup legend="Audience">
						{#each audiences as option (option.id)}
							<Checkbox
								label={`${option.label} · ${option.count}`}
								checked={audienceIds.includes(option.id)}
								onchange={() => toggleAudience(option.id)} />
						{/each}
					</ChoiceGroup>
					<!-- The combined figure, resolved rather than added up, and the
					     door to the people behind it. Live, because it answers a
					     question the last press just changed. -->
					<p class="reach" aria-live="polite">
						{#if preview}
							{reachSentence(preview)}
							{#if preview.rows.length > 0}
								<button
									type="button"
									class="reach__who"
									aria-expanded={showWho}
									aria-controls="compose-who"
									onclick={() => (showWho = !showWho)}>See who</button>
							{/if}
						{:else if audienceIds.length === 0}
							Pick at least one audience.
						{:else}
							Counting who this reaches…
						{/if}
					</p>
					{#if showWho && preview}
						<!-- Who, and whether — never addresses or their copy. Picking an
						     audience is not the authoritative check, so it discloses less
						     than the review does. -->
						<ul class="who" id="compose-who">
							{#each preview.rows as person, index (index)}
								{@const badge = recipientBadge[person.state]}
								<li class="who__row">
									<span class="who__name">{person.name}</span>
									<span class="ui-badge ui-badge--{badge.tone}">{badge.label}</span>
									{#if person.reason}<span class="who__reason">{person.reason}</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}
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
					<ChoiceGroup legend="Audience">
						<p class="audience__pending">Counting audiences…</p>
					</ChoiceGroup>
				{/if}
			</div>
			<p class="note">
				This creates a draft in the queue. Nothing sends until you review it — the review shows
				every recipient and what each one gets.
			</p>
		</div>
		<div class="compose__preview">
			<!-- The caption states the preview's edit capability, both halves of it:
			     what this is, and — only while a press would actually be answered —
			     how to change it. -->
			<p class="compose__preview-label">
				Email preview{#if inlineEnabled} · click any text to edit it.{/if}
			</p>
			{#if previewTemplate && theme}
				<div bind:this={reserveEl} use:editableUnits={{ enabled: inlineEnabled, onPress: onUnitPress }}>
					<EmailRender
						template={previewTemplate}
						{theme}
						{eventName}
						{eventMeta}
						editable={inlineEnabled} />
				</div>
				{#if inlineUnit && inlineAnchor}
					{#key `${inlineUnit.type}:${inlineUnit.path}`}
						<InlineEditor
							unit={inlineUnit}
							anchor={inlineAnchor}
							mergeFields={template?.mergeFields ?? []}
							busy={inlineBusy}
							onchange={previewInline}
							oncommit={applyInline}
							oncancel={closeInline} />
					{/key}
				{/if}
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
	{/if}
	{#snippet footer(close)}
		{#if step === 'new-template'}
			<button
				type="button"
				class="ui-button ui-button--ghost"
				disabled={creating}
				onclick={() => (step = 'compose')}>Cancel</button>
			<button
				type="button"
				class="ui-button ui-button--primary"
				disabled={creating || !newName.trim()}
				aria-busy={creating || undefined}
				onclick={createTemplate}>
				{#if creating}<span class="ui-spinner" aria-hidden="true"></span>{/if}
				Create
			</button>
		{:else}
			<button type="button" class="ui-button ui-button--ghost" disabled={busy} onclick={close}>Cancel</button>
			<button
				type="button"
				class="ui-button ui-button--primary"
				disabled={busy || !subject.trim() || audienceIds.length === 0}
				aria-busy={busy || undefined}
				onclick={createDraft}>
				{#if busy}<span class="ui-spinner" aria-hidden="true"></span>{/if}
				Create draft
			</button>
		{/if}
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

	/* A door beside the picker, in the same text voice as the edit link next to
	   it — nothing is committed by pressing it. */
	.tpl__new {
		flex: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-link);
		text-decoration: underline;
		cursor: pointer;
	}

	.tpl__new:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
		border-radius: var(--je-radius-control);
	}

	.wizard {
		display: grid;
		gap: var(--je-space-4);
		max-inline-size: 34rem;
	}

	.kinds {
		display: grid;
		gap: var(--je-space-2);
		margin: 0;
		padding: 0;
		border: 0;
	}

	.kinds__legend {
		padding: 0;
		margin-block-end: var(--je-space-2);
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	/* Marking, not action: a picked card takes the mark surface every selected
	   thing in this product takes, never the action colour. */
	.kind {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		cursor: pointer;
	}

	.kind:hover {
		border-color: var(--je-color-border-strong);
	}

	.kind--picked {
		border-color: var(--je-color-mark-border);
		background: var(--je-color-mark-surface);
	}

	.kind:has(input:focus-visible) {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.kind__label {
		font-weight: 600;
	}

	.kind__description {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.wizard__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.tpl__edit {
		flex: none;
		font-size: var(--je-font-size-sm);
	}

	.audience {
		display: grid;
		gap: var(--je-space-2);
	}

	.audience__pending {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* The consequence of the choices above it, in the quiet voice a derived
	   fact takes — the chips are the control, this is what they came to. */
	.reach {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* A door to detail already on this surface, so it takes the text
	   affordance rather than a button's box: nothing is committed by it. */
	.reach__who {
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: var(--je-color-link);
		text-decoration: underline;
		cursor: pointer;
	}

	.reach__who:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
		border-radius: var(--je-radius-control);
	}

	.who {
		list-style: none;
		display: grid;
		gap: var(--je-space-1);
		max-block-size: 14rem;
		overflow-y: auto;
		margin: 0;
		padding: var(--je-space-2);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface-sunken);
	}

	.who__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-sm);
	}

	.who__name {
		min-inline-size: 0;
	}

	.who__reason {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
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
