<script lang="ts">
	import { tick } from 'svelte';
	import { Checkbox, ChoiceGroup, Field, Modal } from '$lib/ui';
	import type { CommunicationsPagePort } from '$lib/api/communications-page-port';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import { reachSentence } from '$lib/api/audience-union';
	import { templateKind, templateKinds, type SectionKind } from '$lib/api/template-kinds';
	import EmailRender from '$lib/features/templates/EmailRender.svelte';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import InlineEditor from '$lib/features/templates/InlineEditor.svelte';
	import {
		blockKind,
		editableUnits,
		inlineEditNote,
		insertedUnitPath,
		messageInlineDoc,
		resolveUnit,
		sectionEditNote,
		unitBlockIndex,
		withInsertedBlock,
		withRemovedBlock,
		type InlineEditResult,
		type InlineUnit
	} from '$lib/features/templates/inline-edit';
	import SectionAddMenu from '$lib/features/templates/SectionAddMenu.svelte';
	import NewTemplateWizard from '$lib/features/templates/NewTemplateWizard.svelte';
	import type {
		AudienceOption,
		AudiencePreview,
		EventTheme,
		MessageTemplate,
		SpeakerProfile
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
	const live = $derived(api.source.kind === 'live');

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
		}).catch(() => {
			if (token === previewToken) preview = null;
		});
	});

	/**
	 * Profiles for the named rows, keyed by roster id.
	 *
	 * Read only when the list is actually opened, and only for rows the roster
	 * holds: the preview payload itself carries no addresses, and this is the
	 * ordinary individual-disclosure door rather than a standing read of
	 * everyone's contact details.
	 */
	let whoProfiles = $state<Record<string, SpeakerProfile | null>>({});

	$effect(() => {
		const ask = api.speakers?.profileById;
		const rows = showWho ? (preview?.rows ?? []) : [];
		const ids = rows.map((row) => row.speakerId).filter((id): id is string => id !== undefined);
		if (!ask || ids.length === 0) return;
		const wanted = ids.filter((id) => !(id in whoProfiles));
		if (wanted.length === 0) return;
		void Promise.all(wanted.map((id) => ask(id).catch(() => null))).then((found) => {
			const next = { ...whoProfiles };
			wanted.forEach((id, index) => (next[id] = found[index] ?? null));
			whoProfiles = next;
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
		// A composer is a fresh sheet, and so is the step it opens on and the
		// one-off it starts from — last compose's words are not this one's.
		step = 'compose';
		oneOff = seedOneOff();
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
	let creating = $state(false);
	let canCreateTemplate = $state(false);
	/** Refusals from this surface's own writes: an inline commit, a draft prepare. */
	let createError = $state('');
	let wizard = $state<ReturnType<typeof NewTemplateWizard> | null>(null);

	function openNewTemplate() {
		step = 'new-template';
		// The component owns the fields; opening asks it for a fresh sheet.
		void tick().then(() => wizard?.reset());
	}

	/** The wizard minted one: select it here exactly as any other pick selects. */
	async function onWizardCreated(made: MessageTemplate) {
		await onTemplatesChanged();
		// The subject seeds from the new template exactly as it would from a starter.
		pickTemplate(made.id, made);
		step = 'compose';
	}

	// ------------------------------------------------------- edit in the preview

	/**
	 * The body of a compose that named no template.
	 *
	 * A blank start is still a document. Without one the composer had nothing to
	 * preview, nothing to edit, and minted a draft whose review could only
	 * announce that it had no body — a message you could send but never read.
	 * The one-off is seeded from the registry's bare-start scaffold, edited in
	 * place like any template, and frozen onto the message on Create.
	 *
	 * It is anonymous on purpose: it belongs to this compose, is listed nowhere,
	 * and its edits commit to local state rather than to a library revision,
	 * because there is no library record to revise.
	 */
	function seedOneOff(): MessageTemplate {
		const bare = templateKind('blank') ?? templateKinds[templateKinds.length - 1]!;
		return {
			id: 'one-off',
			key: 'one-off',
			name: 'One-off message',
			purpose: bare.purpose,
			subject: bare.subject,
			blocks: structuredClone(bare.blocks),
			mergeFields: structuredClone(bare.mergeFields),
			revision: 1,
			revisions: [],
			usedBy: []
		};
	}

	let oneOff = $state<MessageTemplate>(seedOneOff());

	/** What the preview renders and Create freezes: the stored template, or the one-off. */
	const document_ = $derived(template ?? oneOff);

	/**
	 * The preview is editable whenever a body is on screen and nothing is
	 * mid-commit — which is always, now that a blank start has one. The teaching
	 * line follows this same value rather than the branch, so the composer never
	 * offers a press it would refuse.
	 */
	const inlineEnabled = $derived(!busy && step === 'compose' && (!live || !template));

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
		if (!inlineEnabled) return;
		if (inlineUnit?.path === path) return;
		inlinePreview = null;
		const unit = resolveUnit(document_, path);
		if (!unit) return;
		inlineUnit = unit;
		inlineAnchor = el;
	}

	/** Live-to-view: every change in the open editor re-renders the preview. */
	function previewInline(result: InlineEditResult) {
		const unit = inlineUnit;
		if (!unit) return;
		inlinePreview = messageInlineDoc($state.snapshot(document_) as MessageTemplate, unit, result);
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
		if (!unit) return;
		const next = messageInlineDoc($state.snapshot(document_) as MessageTemplate, unit, result);
		if (!next) {
			closeInline();
			return;
		}
		// A one-off has no library record to revise, so its edit lands in the
		// composer's own state. Nothing is written to the template store, and
		// nothing needs to be re-read.
		if (!template) {
			oneOff = next;
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

	// ------------------------------------------------------------- sections

	/** The open add menu: where a section would land, and what to anchor it to. */
	let addMenu = $state<{ index: number; anchor: HTMLElement } | null>(null);

	function openAddMenu(index: number, anchor: HTMLElement) {
		if (!inlineEnabled) return;
		// One floating panel at a time: the section being added is the new subject.
		closeInline();
		addMenu = { index, anchor };
	}

	/** The insertion path that needs no hover — the same one touch and keyboard use. */
	function addBesideOpenUnit(side: 'above' | 'below', anchor: HTMLElement) {
		const at = inlineUnit ? unitBlockIndex(inlineUnit) : null;
		if (at === null) return;
		openAddMenu(side === 'above' ? at : at + 1, anchor);
	}

	/**
	 * One structural write, branching exactly where `applyInline` branches: a
	 * one-off has no library record to revise, so it lands in composer state and
	 * freezes into the draft on Create; a named template earns a revision through
	 * the same organizer-lane write the Templates editor makes.
	 *
	 * Returns the committed document so the caller can re-derive paths from it
	 * rather than from the copy it computed before the write.
	 */
	async function commitStructure(
		next: MessageTemplate,
		note: string
	): Promise<MessageTemplate | null> {
		if (!template) {
			oneOff = next;
			return next;
		}
		inlineBusy = true;
		const outcome = await api.templates.commitInline(template.id, next, note);
		if (!outcome.ok) {
			createError = outcome.reason;
			inlineBusy = false;
			return null;
		}
		await onTemplatesChanged();
		inlineBusy = false;
		return next;
	}

	/**
	 * Inserts the chosen section and opens its editor — insert-then-type is one
	 * gesture. Paths are re-derived from the committed document and the anchor is
	 * re-queried from the live DOM, never carried across the write.
	 */
	async function insertSection(kind: SectionKind) {
		const menu = addMenu;
		addMenu = null;
		if (!menu) return;
		const at = menu.index;
		const written = await commitStructure(
			withInsertedBlock($state.snapshot(document_) as MessageTemplate, at, kind),
			sectionEditNote('add', kind)
		);
		if (!written) return;

		const path = insertedUnitPath(kind, at);
		// A divider has no words, so nothing opens — the honest answer, not a failure.
		if (!path) return;
		await tick();
		const unit = resolveUnit(document_, path);
		const el = reserveEl?.querySelector<HTMLElement>(`[data-edit="${path}"]`);
		if (!unit || !el) return;
		inlineUnit = unit;
		inlineAnchor = el;
	}

	/** Removes the section whose editor is open; an emptied document is honest. */
	async function removeOpenSection() {
		const at = inlineUnit ? unitBlockIndex(inlineUnit) : null;
		if (at === null) return;
		const block = document_.blocks[at];
		if (!block) return;
		const next = withRemovedBlock($state.snapshot(document_) as MessageTemplate, at);
		const note = sectionEditNote('remove', blockKind(block));
		closeInline();
		await commitStructure(next, note);
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
		const base = inlinePreview ?? document_;
		return { ...base, subject: subject.trim() === '' ? base.subject : subject };
	});

	async function createDraft() {
		const line = subject.trim();
		if (!line || audienceIds.length === 0 || busy) return;
		busy = true;
		createError = '';
		try {
			await api.communications.compose({
				subject: line,
				audienceIds,
				// One or the other, never both: a named template is the body, and a
				// blank start freezes the one-off as written at this moment.
				...(templateId
					? { templateId }
					: { document: $state.snapshot(oneOff) as MessageTemplate })
			});
			await onCreated();
			open = false;
		} catch (error) {
			createError = error instanceof Error ? error.message : 'The draft could not be prepared.';
		} finally {
			busy = false;
		}
	}
</script>

<Modal
	bind:open
	title={step === 'new-template' ? 'New template' : 'Compose message'}
	size="lg">
	{#if step === 'new-template'}
		<!-- The composer's own fields are untouched behind it, so Cancel is a
		     return rather than a restart. -->
		<NewTemplateWizard
			bind:this={wizard}
			bind:busy={creating}
			bind:canCreate={canCreateTemplate}
			create={(input) => api.templates.create(input)}
			oncreated={onWizardCreated} />
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
						{#if !live}
							<button type="button" class="tpl__new" onclick={openNewTemplate}>New template…</button>
						{/if}
						{#if template}
							<!-- One fact, one door: the chosen template links to its editor. -->
							{#if !live}<a
								class="tpl__edit"
								href={`/app/templates?template=${template.id}`}
								aria-label={`Edit template — ${template.name}`}>
								Edit template
							</a>{/if}
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
			<!-- Every lane resolves the same ordered union server-side before a
			     live draft freezes it; chip counts are facts, never added together. -->
			<div class="audience">
				{#if audiences}
					<ChoiceGroup legend="Audience">
						{#each audiences as option (option.id)}
							<Checkbox
								label={option.count === undefined ? option.label : `${option.label} · ${option.count}`}
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
								{@const profile = person.speakerId ? whoProfiles[person.speakerId] : null}
								<li class="who__row">
									<!-- A name on the roster opens the profile every other name in
									     the product opens — one person, asked for by press. Anyone
									     the roster does not hold stays plain text. -->
									<span class="who__name">
										{#if profile}<ProfilePeek {profile} />{:else}{person.name}{/if}
									</span>
									<span class="ui-badge ui-badge--{badge.tone}">{badge.label}</span>
									{#if person.via}
										<!-- Which chip put them here: the first group that claimed
										     them, which is whose copy they receive. -->
										<span class="who__via">via {person.via}</span>
									{/if}
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
			{#if createError}<p class="audience-failure" role="alert">{createError}</p>{/if}
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
					<!-- Insertion rides the same gate as editing: where the live lane
					     turns inline editing off, nothing structural is offered either. -->
					<EmailRender
						template={previewTemplate}
						{theme}
						{eventName}
						{eventMeta}
						editable={inlineEnabled}
						onInsert={inlineEnabled ? openAddMenu : undefined} />
				</div>
				{#if inlineUnit && inlineAnchor}
					{#key `${inlineUnit.type}:${inlineUnit.path}`}
						<InlineEditor
							unit={inlineUnit}
							anchor={inlineAnchor}
							mergeFields={document_.mergeFields}
							busy={inlineBusy}
							onchange={previewInline}
							oncommit={applyInline}
							oncancel={closeInline}
							onAddSection={inlineEnabled ? addBesideOpenUnit : undefined}
							onRemoveSection={inlineEnabled ? removeOpenSection : undefined} />
					{/key}
				{/if}
				{#if addMenu}
					<SectionAddMenu
						anchor={addMenu.anchor}
						onpick={insertSection}
						oncancel={() => (addMenu = null)} />
				{/if}
			{:else}
				<!-- There is always a document now, so the only thing this can be
				     waiting on is the brand. Same footprint as a rendered email, so
				     its arrival never jolts the dialog. -->
				<div class="compose__placeholder">
					<p class="compose__placeholder-title">Preparing the preview…</p>
					<p class="compose__placeholder-hint">
						The email appears here exactly as recipients get it, with merge fields filled from
						their records.
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
				disabled={creating || !canCreateTemplate}
				aria-busy={creating || undefined}
				onclick={() => void wizard?.submit()}>
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

	.who__reason,
	.who__via {
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
