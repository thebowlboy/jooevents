<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ArrowLeft, Bot, CodeXml, Sparkles } from 'lucide-svelte';
	import { Button } from '$lib/ui';
	import type { TemplatesPagePort } from '$lib/api/templates-page-port';
	import { describePortFailure, type PortFailureView } from '$lib/api/port-failure';
	import { applyParams, clearParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import EmailRender from './EmailRender.svelte';
	import ScheduleSurfaceRender from './ScheduleSurfaceRender.svelte';
	import FormSurfaceRender from './FormSurfaceRender.svelte';
	import RosterSurfaceRender from './RosterSurfaceRender.svelte';
	import BrandTab from './BrandTab.svelte';
	import InlineEditor from './InlineEditor.svelte';
	import { diffAnyTemplate, type TemplateDiffEntry } from './template-diff';
	import {
		editableUnits,
		resolveUnit,
		withMergeEdit,
		withRosterKnobs,
		withScheduleKnobs,
		withTextStyle,
		withTextValue,
		type InlineEditResult,
		type InlineUnit
	} from './inline-edit';
	import { sameTextStyle, styleChangeSummary } from './text-style';
	import { applyFormLens } from '$lib/api/fields';
	import { isSurfaceTemplate } from '$lib/api/types';
	import type {
		AnyTemplate,
		EditClassification,
		EventTheme,
		FormSummary,
		MergeFieldDef,
		MessageTemplate,
		ModelChoice,
		PublicSpeakerCard,
		RegistryField,
		ReviseProgress,
		ScheduleState,
		SpeakerCategory,
		SurfaceBlock,
		SurfaceField,
		SurfaceTemplate,
		TemplateBlock,
		Track
	} from '$lib/api/types';

	interface Props {
		port: TemplatesPagePort;
	}

	let { port }: Props = $props();
	const api = $derived(port);

	type TabKey = 'messages' | 'surfaces' | 'brand';
	/**
	 * The revertable part of a template — what a revision snapshot carries.
	 * A message's content is its subject, blocks, and merge fields; a surface's
	 * is its blocks and question pool.
	 */
	type TemplateContent =
		| { subject: string; blocks: TemplateBlock[]; mergeFields: MergeFieldDef[] }
		| { blocks: SurfaceBlock[]; fields?: SurfaceField[]; submitLabel?: string };

	/**
	 * The assistant lane is paused (owner, 2026-08-12): the panel stays — it
	 * names what is coming and keeps the layout honest — but its controls are
	 * inert until the lane ships. The revise/draft machinery underneath is
	 * untouched and unit-tested; only this door is closed.
	 */
	const assistantPaused = true;

	const tabKeys = ['messages', 'surfaces', 'brand'] as const;
	const tabs: { key: TabKey; label: string }[] = [
		{ key: 'messages', label: 'Messages' },
		{ key: 'surfaces', label: 'Public surfaces' },
		{ key: 'brand', label: 'Brand' }
	];

	/** The tab and the open template are shareable state, so they live in the address. */
	const tab = $derived(paramIn('tab', tabKeys, 'messages'));
	const selectedId = $derived(param('template'));

	let library = $state<{ messages: MessageTemplate[]; surfaces: SurfaceTemplate[] } | null>(null);
	let theme = $state<EventTheme | null>(null);
	let eventName = $state('Your event');
	let eventMeta = $state('');

	/**
	 * The library's failure, kept beside its value. `reload` is re-triggered by
	 * every commit, revision, and undo on this page, so it carries a ticket: a
	 * slow earlier answer must never overwrite the fresher library already on
	 * screen, and a rejection must not leave `library` null forever behind a
	 * skeleton nothing is filling.
	 */
	let libraryFailure = $state<PortFailureView | null>(null);
	let libraryTicket = 0;

	async function reload() {
		const ticket = (libraryTicket += 1);
		try {
			const [list, brand, summary] = await Promise.all([
				api.templates.list(),
				api.theme.get(),
				api.workspace.summary(),
				registry ? reloadRegistry() : Promise.resolve()
			]);
			if (ticket !== libraryTicket) return;
			library = {
				messages: list.messages.map((template) => ({ ...template })),
				surfaces: list.surfaces.map((surface) => ({ ...surface }))
			};
			theme = brand;
			libraryFailure = null;
			if (summary.event) {
				eventName = summary.event.name;
				eventMeta = `${summary.event.dates} · ${summary.event.location}`;
			}
		} catch (error) {
			if (ticket !== libraryTicket) return;
			libraryFailure = describePortFailure(error, 'The template library could not be loaded.');
		}
	}

	let retryingLibrary = $state(false);
	async function retryLibrary() {
		retryingLibrary = true;
		try {
			await reload();
		} finally {
			retryingLibrary = false;
		}
	}

	/**
	 * The models an edit can be pinned to — server data end to end. Loaded once
	 * for the session; `auto` (the routing default) always leads the list.
	 */
	let modelChoices = $state<ModelChoice[]>([]);

	onMount(() => {
		void reload();
		// An unreadable model list leaves the routing default in place rather
		// than an empty picker waiting on choices that are not coming.
		void api.templates.modelChoices().then(
			(choices) => (modelChoices = choices),
			() => (modelChoices = [])
		);
	});

	/** The open template: the address names either kind, the list resolves it. */
	const current = $derived.by<AnyTemplate | null>(() => {
		if (!library) return null;
		return (
			library.messages.find((template) => template.id === selectedId) ??
			library.surfaces.find((surface) => surface.id === selectedId) ??
			null
		);
	});
	const missingSelection = $derived(Boolean(selectedId && library && !current));
	const currentIsSurface = $derived(current !== null && isSurfaceTemplate(current));
	let publicationStatus = $state<null | {
		state: 'never_published' | 'published' | 'changes_pending';
		publishedRevisionNumber: number | null;
	}>(null);
	let publishing = $state(false);
	let publicationError = $state('');
	let publicationTicket = 0;

	$effect(() => {
		const id = currentIsSurface ? current?.id : null;
		if (!id || !api.publication) {
			publicationStatus = null;
			publicationError = '';
			return;
		}
		const ticket = (publicationTicket += 1);
		void api.publication.status(id).then(
			(status) => {
				if (ticket === publicationTicket) publicationStatus = status;
			},
			() => {
				if (ticket === publicationTicket) publicationStatus = null;
			}
		);
	});

	/**
	 * What an auxiliary read for the open template could not answer. Only one
	 * template is open at a time, so one cell states it. Each loader is guarded
	 * against stacking, because the effects that drive them re-run whenever the
	 * open template changes — including back to one whose request is still open.
	 */
	let previewFailure = $state<PortFailureView | null>(null);
	let previewInFlight = $state<string[]>([]);

	function loadPreview(kind: string, read: () => Promise<void>) {
		if (previewInFlight.includes(kind)) return;
		previewInFlight = [...previewInFlight, kind];
		void read()
			.then(() => {
				previewFailure = null;
			})
			.catch((error: unknown) => {
				previewFailure = describePortFailure(error, 'This preview could not be loaded.');
			})
			.finally(() => {
				previewInFlight = previewInFlight.filter((entry) => entry !== kind);
			});
	}

	/**
	 * The real program a schedule surface previews, loaded when one is first
	 * opened and kept for the session: template edits never change the program.
	 */
	let program = $state<{ schedule: ScheduleState; tracks: Track[] } | null>(null);
	$effect(() => {
		if (program || !current || !isSurfaceTemplate(current) || current.kind !== 'schedule') return;
		loadPreview('schedule', async () => {
			const [schedule, trackList] = await Promise.all([api.schedule.state(), api.vocab.tracks()]);
			program = { schedule, tracks: trackList };
		});
	});

	/**
	 * The real lineup a roster surface previews — the same public projection the
	 * published page reads, so the operator is always looking at their actual
	 * roster in their actual order. Template edits never change who is on it.
	 */
	let lineup = $state<{ roster: PublicSpeakerCard[]; categories: SpeakerCategory[] } | null>(null);
	$effect(() => {
		if (lineup || !current || !isSurfaceTemplate(current) || current.kind !== 'speaker-roster') {
			return;
		}
		loadPreview('speaker-roster', async () => {
			const [roster, categories] = await Promise.all([
				api.speakers.publicRoster(),
				api.vocab.speakerCategories()
			]);
			lineup = { roster, categories };
		});
	});

	/**
	 * The surface decides how the application looks; the forms decide what is
	 * asked. The picker below previews this one template as any of the event's
	 * forms — a display lens over the served projection, applied client-side so
	 * switching forms is instant. The form in view is shareable state, so it
	 * lives in the address (`?form=`), which is also what the Forms page's
	 * Preview door writes.
	 */
	let formList = $state<FormSummary[] | null>(null);
	$effect(() => {
		if (formList || !current || !isSurfaceTemplate(current) || current.kind !== 'application-form')
			return;
		loadPreview('application-form', async () => {
			formList = await api.forms.list();
		});
	});
	const lensId = $derived(param('form'));
	const isApplicationSurface = $derived(
		current !== null && isSurfaceTemplate(current) && current.kind === 'application-form'
	);
	const lensForm = $derived(
		isApplicationSurface && lensId
			? (formList?.find((form) => form.id === lensId) ?? null)
			: null
	);

	/**
	 * The field registry, preloaded alongside the application-form surface so
	 * pressing a question opens its editor in the same frame — a press must
	 * never pay a fetch for data the surface already implied. Refreshed by
	 * every path that writes the registry (inline field commits, applied AI
	 * revisions, and receipt undos, all of which pass through `reload`).
	 */
	let registry = $state<RegistryField[] | null>(null);
	async function reloadRegistry() {
		registry = await api.fields.list();
	}
	$effect(() => {
		if (registry || !isApplicationSurface) return;
		loadPreview('field-registry', reloadRegistry);
	});

	/** How a non-open form names its state in the picker. */
	const statusWord: Record<FormSummary['status'], string> = {
		open: 'open',
		closed: 'closed',
		draft: 'draft'
	};

	function onLensPick(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		void applyParams({ form: value || null });
	}

	function lastRevision(template: AnyTemplate) {
		return template.revisions[template.revisions.length - 1];
	}

	function switchTab(next: TabKey) {
		if (tab === next) return;
		// One navigation: the tab changes and any open editor scope leaves with it.
		void applyParams({ tab: next === 'messages' ? null : next, template: null });
	}

	function openTemplate(id: string) {
		void applyParams({ template: id }, { history: 'push' });
	}

	function closeTemplate() {
		void clearParams(['template'], { history: 'push' });
	}

	async function publishCurrent() {
		if (!current || !isSurfaceTemplate(current) || !api.publication || publishing) return;
		publishing = true;
		publicationError = '';
		try {
			const outcome = await api.publication.publish(
				current.id,
				current.kind === 'application-form' ? (lensId ?? undefined) : undefined
			);
			if (!outcome.ok) {
				publicationError = outcome.reason;
				return;
			}
			publicationStatus = await api.publication.status(current.id);
			recordAction({
				area: 'templates',
				label: `Published “${current.name}” from revision ${current.revision}`,
				notUndoableReason: 'Public presentation rolls back by selecting an earlier immutable release.'
			});
		} finally {
			publishing = false;
		}
	}

	// -----------------------------------------------------------------------
	// Editor state: one iteration loop against the template the address names.

	let phase = $state<'idle' | 'classifying' | 'drafting'>('idle');
	let instruction = $state('');
	let classification = $state<EditClassification | null>(null);
	let progress = $state<ReviseProgress | null>(null);
	let draft = $state<AnyTemplate | null>(null);
	let draftNote = $state('');
	/** Which side of a draft the preview shows; every new draft opens on After. */
	let draftSide = $state<'before' | 'after'>('after');
	/** The pinned model for the next round; `auto` means routing decides. */
	let modelId = $state('auto');
	/** What the current draft is diffed against: committed, or the prior draft when refining. */
	let diffBase = $state<AnyTemplate | null>(null);
	/** Every instruction of the chain so a refine round builds on the draft, not the committed copy. */
	let instructionChain = $state<string[]>([]);
	let error = $state('');
	let busy = $state(false);

	/** An older revision being read; null means the editor shows the current copy. */
	let viewedRevision = $state<number | null>(null);
	let restoreError = $state('');

	/**
	 * Content of revisions this session has replaced, kept per template so an
	 * older revision chip can preview what it said. Seeded history carries no
	 * bodies, and the panel says so rather than inventing one.
	 */
	let knownBodies = $state<Record<string, Record<number, TemplateContent>>>({});

	let inputEl = $state<HTMLInputElement>();

	function contentOf(template: AnyTemplate): TemplateContent {
		const snap = $state.snapshot(template) as AnyTemplate;
		return isSurfaceTemplate(snap)
			? { blocks: snap.blocks, fields: snap.fields, submitLabel: snap.submitLabel }
			: { subject: snap.subject, blocks: snap.blocks, mergeFields: snap.mergeFields };
	}

	function rememberBody(templateId: string, revision: number, content: TemplateContent) {
		knownBodies = {
			...knownBodies,
			[templateId]: { ...(knownBodies[templateId] ?? {}), [revision]: content }
		};
	}

	// A different template in the address is a different editing session.
	let editorFor: string | null = null;
	$effect(() => {
		if (selectedId === editorFor) return;
		editorFor = selectedId;
		phase = 'idle';
		instruction = '';
		classification = null;
		progress = null;
		draft = null;
		draftNote = '';
		draftSide = 'after';
		modelId = 'auto';
		diffBase = null;
		instructionChain = [];
		error = '';
		busy = false;
		viewedRevision = null;
		restoreError = '';
		inlineUnit = null;
		inlineAnchor = null;
		inlineField = null;
		inlineBusy = false;
		inlinePreview = null;
	});

	const streaming = $derived(phase !== 'idle');
	const diff = $derived<TemplateDiffEntry[]>(
		draft && diffBase ? diffAnyTemplate(diffBase, draft) : []
	);
	const viewedMeta = $derived(
		current && viewedRevision !== null
			? (current.revisions.find((revision) => revision.number === viewedRevision) ?? null)
			: null
	);
	const viewedBody = $derived(
		current && viewedRevision !== null
			? (knownBodies[current.id]?.[viewedRevision] ?? null)
			: null
	);
	/**
	 * What the preview renders: an older revision's stored body, a draft side,
	 * or the committed copy — overlaid, while a unit editor is open, with that
	 * editor's pending changes so every keystroke is immediately in view.
	 */
	const previewTemplate = $derived.by<AnyTemplate | null>(() => {
		if (!current) return null;
		if (viewedRevision !== null) {
			if (!viewedBody) return null;
			// A stored body always came from this same template, so the merge stays in-kind.
			return { ...($state.snapshot(current) as AnyTemplate), ...viewedBody } as AnyTemplate;
		}
		// Before shows the committed copy, not the refine chain's prior draft:
		// it answers “what does the template say right now”.
		if (draft && draftSide === 'before') return current;
		return inlinePreview ?? draft ?? current;
	});

	/**
	 * What the preview actually paints: the working copy, seen through the form
	 * lens when one is selected. A draft suspends the lens — the draft edits the
	 * shared template and the registry, so its Before/After compare is honest
	 * only over the standard application; the row above the preview says so.
	 */
	const displayTemplate = $derived.by<AnyTemplate | null>(() => {
		if (!previewTemplate) return null;
		if (!lensForm || draft) return previewTemplate;
		const snap = $state.snapshot(previewTemplate) as AnyTemplate;
		if (!isSurfaceTemplate(snap) || snap.kind !== 'application-form') return previewTemplate;
		return applyFormLens(snap, lensForm);
	});

	async function refocus() {
		await tick();
		inputEl?.focus();
	}

	// -----------------------------------------------------------------------
	// Inline editing: click-to-edit over the preview's addressable units.

	let inlineUnit = $state<InlineUnit | null>(null);
	let inlineAnchor = $state<HTMLElement | null>(null);
	let inlineField = $state<RegistryField | null>(null);
	let inlineBusy = $state(false);
	/**
	 * The live working copy while a unit editor is open: the base document
	 * with the editor's pending changes applied, re-derived on every change so
	 * the preview is the feedback. Dropped whole on cancel — the preview snaps
	 * back exactly — and superseded by the committed copy on Done.
	 */
	let inlinePreview = $state<AnyTemplate | null>(null);
	let reserveEl = $state<HTMLElement>();

	/**
	 * Units are pressable only when the preview shows the working copy: the
	 * committed template, or an open draft's After side. History reads and the
	 * Before side stay inert, as does the preview while a round streams.
	 */
	const inlineEnabled = $derived(
		current !== null && viewedRevision === null && !streaming && (!draft || draftSide === 'after')
	);

	/** The template's declared tokens as the working copy carries them. */
	const workingMergeFields = $derived.by<MergeFieldDef[]>(() => {
		const doc = draft ?? current;
		return doc && !isSurfaceTemplate(doc) ? doc.mergeFields : [];
	});

	// Whatever makes the preview inert also closes an open unit editor.
	$effect(() => {
		if (!inlineEnabled && inlineUnit) closeInline(false);
	});

	// The pressed unit holds its outline while its editor is open — the
	// selected state both pointers share.
	$effect(() => {
		const el = inlineAnchor;
		if (!el) return;
		el.classList.add('ui-editable--active');
		return () => el.classList.remove('ui-editable--active');
	});

	function closeInline(refocusUnit = true) {
		const path = inlineUnit?.path;
		inlineUnit = null;
		inlineAnchor = null;
		inlineField = null;
		inlineBusy = false;
		inlinePreview = null;
		if (!refocusUnit || !path) return;
		// The commit may have re-rendered the preview; the unit is found again
		// by its path rather than by the element the press landed on.
		void tick().then(() => {
			reserveEl?.querySelector<HTMLElement>(`[data-edit="${path}"]`)?.focus();
		});
	}

	async function onUnitPress(path: string, el: HTMLElement) {
		if (!current || !inlineEnabled) return;
		// A press on the unit already being edited keeps its session: replacing
		// the open unit with one resolved from the live preview would hand Done
		// the pending words as the opening value and commit nothing.
		if (inlineUnit?.path === path) return;
		// A new unit's session starts from the base copy — any other session's
		// uncommitted preview drops first, exactly as an outside press drops it.
		if (inlineUnit) closeInline(false);
		const doc = draft ?? current;
		if (path.startsWith('fields.')) {
			// A question unit edits the registry record itself (one registry,
			// many doors), so the editor opens over the full definition — from
			// the preloaded cache, in the same frame as the press. The fallback
			// fetch runs only if a press beats the preload on a cold open.
			const id = path.slice('fields.'.length);
			let record = registry?.find((entry) => entry.id === id) ?? null;
			if (!record) {
				await reloadRegistry();
				record = registry?.find((entry) => entry.id === id) ?? null;
			}
			if (!record) return;
			inlineField = record;
			inlineUnit = { type: 'field', path, fieldId: id };
			inlineAnchor = el;
			return;
		}
		const unit = resolveUnit($state.snapshot(doc) as AnyTemplate, path);
		if (!unit) return;
		inlineField = null;
		inlineUnit = unit;
		inlineAnchor = el;
	}

	function inlineNote(unit: InlineUnit, result: InlineEditResult): string {
		if (result.type === 'merge') {
			const swapped = unit.type === 'merge' && result.swapKey !== unit.key;
			if (swapped && result.insertKey) return 'Swapped and inserted merge fields';
			return result.insertKey ? 'Inserted a merge field' : 'Swapped a merge field';
		}
		if (result.type === 'knobs') return 'Edited schedule layout';
		if (result.type === 'roster-knobs') return 'Edited roster layout';
		if (unit.type === 'text') {
			// A style change names itself in the note: 'Edited heading (size: 24px → 28px)'.
			const styled =
				result.type === 'text' && unit.styleKind
					? styleChangeSummary(unit.styleKind, unit.style, result.style)
					: [];
			return styled.length > 0 ? `Edited ${unit.noun} (${styled.join(', ')})` : `Edited ${unit.noun}`;
		}
		return 'Edited the template';
	}

	/**
	 * The base document with one unit's pending edit applied — what the live
	 * preview renders while its editor is open. Null when the result shape does
	 * not fit the unit, which leaves the preview on the base copy.
	 */
	function inlineDoc(base: AnyTemplate, unit: InlineUnit, result: InlineEditResult): AnyTemplate | null {
		if (result.type === 'text' && unit.type === 'text') {
			let doc = withTextValue(base, unit.path, result.value);
			if (unit.styleKind) doc = withTextStyle(doc, unit.path, result.style);
			return doc;
		}
		if (result.type === 'merge' && unit.type === 'merge') {
			return withMergeEdit(base as MessageTemplate, unit.blockIndex, unit.tokenIndex, {
				swapKey: result.swapKey,
				insertKey: result.insertKey || undefined
			});
		}
		if (result.type === 'knobs' && unit.type === 'knobs') {
			return withScheduleKnobs(base as SurfaceTemplate, unit.blockIndex, result.knobs);
		}
		if (result.type === 'roster-knobs' && unit.type === 'roster-knobs') {
			return withRosterKnobs(base as SurfaceTemplate, unit.blockIndex, result.knobs);
		}
		if (result.type === 'field' && unit.type === 'field') {
			// A question is a registry fact; the working copy patches only the
			// surface's projected pool, and the registry itself moves on Done.
			if (!isSurfaceTemplate(base)) return null;
			const doc = structuredClone(base);
			const pooled = doc.fields?.find((entry) => entry.id === unit.fieldId);
			if (!pooled) return null;
			if (result.patch.label !== undefined) pooled.label = result.patch.label;
			if (result.patch.help !== undefined) pooled.help = result.patch.help;
			if (result.patch.options !== undefined) pooled.options = result.patch.options;
			if (result.patch.required !== undefined) pooled.required = Boolean(result.patch.required.apply);
			return doc;
		}
		return null;
	}

	/** Live-to-view: every change in the open editor re-renders the preview. */
	function previewInline(result: InlineEditResult) {
		const unit = inlineUnit;
		if (!unit || !current) return;
		const base = $state.snapshot(draft ?? current) as AnyTemplate;
		inlinePreview = inlineDoc(base, unit, result);
		// The re-render can replace the annotated element the editor anchors
		// to; anchoring is by path, so a replaced element is re-resolved.
		void tick().then(() => {
			if (!inlineUnit || !inlineAnchor || inlineAnchor.isConnected) return;
			const el = reserveEl?.querySelector<HTMLElement>(`[data-edit="${inlineUnit.path}"]`);
			if (el) inlineAnchor = el;
		});
	}

	async function applyInline(result: InlineEditResult) {
		const unit = inlineUnit;
		if (!unit || !current) return;

		// A question is a registry fact, not template prose: it commits to the
		// one registry with its own receipt, and the next serve projects the
		// change back into the form. Never a template revision.
		if (unit.type === 'field' && result.type === 'field') {
			const record = inlineField;
			if (!record) return;
			const prior = {
				label: record.label,
				help: record.help ?? '',
				...(record.options ? { options: [...record.options] } : {}),
				required: { ...record.required }
			};
			if (JSON.stringify(prior) === JSON.stringify({ ...prior, ...result.patch })) {
				closeInline();
				return;
			}
			inlineBusy = true;
			const outcome = await api.fields.update(record.id, result.patch);
			if (!outcome.ok) {
				error = outcome.reason;
				inlineBusy = false;
				return;
			}
			// An open surface draft carries its own projected pool; keep it
			// current so the After side shows the question as it now reads.
			if (draft && isSurfaceTemplate(draft)) {
				const pooled = draft.fields?.find((entry) => entry.id === record.id);
				if (pooled) {
					if (result.patch.label !== undefined) pooled.label = result.patch.label;
					if (result.patch.help !== undefined) pooled.help = result.patch.help;
					if (result.patch.options !== undefined) pooled.options = result.patch.options;
					if (result.patch.required !== undefined) {
						pooled.required = Boolean(result.patch.required.apply);
					}
				}
			}
			await reload();
			const label = result.patch.label ?? record.label;
			recordAction({
				area: 'fields',
				label: `Edited the “${label}” question`,
				undo: async () => {
					await api.fields.update(record.id, prior);
					await reload();
				}
			});
			inlineBusy = false;
			closeInline();
			return;
		}

		const base = $state.snapshot(draft ?? current) as AnyTemplate;
		let next: AnyTemplate | null = null;
		if (result.type === 'text' && unit.type === 'text') {
			const value = result.value.trim();
			const textChanged = Boolean(value) && value !== unit.value.trim();
			const styleChanged =
				unit.styleKind !== undefined && !sameTextStyle(unit.styleKind, unit.style, result.style);
			if (!textChanged && !styleChanged) {
				closeInline();
				return;
			}
			let doc = base;
			if (textChanged) doc = withTextValue(doc, unit.path, value);
			if (styleChanged) doc = withTextStyle(doc, unit.path, result.style);
			next = doc;
		} else if (result.type === 'merge' && unit.type === 'merge') {
			if (result.swapKey === unit.key && !result.insertKey) {
				closeInline();
				return;
			}
			next = withMergeEdit(base as MessageTemplate, unit.blockIndex, unit.tokenIndex, {
				swapKey: result.swapKey,
				insertKey: result.insertKey || undefined
			});
		} else if (result.type === 'knobs' && unit.type === 'knobs') {
			if (JSON.stringify(result.knobs) === JSON.stringify(unit.knobs)) {
				closeInline();
				return;
			}
			next = withScheduleKnobs(base as SurfaceTemplate, unit.blockIndex, result.knobs);
		} else if (result.type === 'roster-knobs' && unit.type === 'roster-knobs') {
			if (JSON.stringify(result.knobs) === JSON.stringify(unit.knobs)) {
				closeInline();
				return;
			}
			next = withRosterKnobs(base as SurfaceTemplate, unit.blockIndex, result.knobs);
		}
		if (!next) {
			closeInline();
			return;
		}

		// While a draft is under review an inline edit refines the proposal in
		// place — the draft is the working copy, nothing commits, and Before
		// keeps showing the committed template.
		if (draft) {
			draft = next;
			closeInline();
			return;
		}

		const note = inlineNote(unit, result);
		const id = current.id;
		const name = current.name;
		const prior = current.revision;
		const replaced = contentOf(current);
		inlineBusy = true;
		const outcome = await api.templates.commitInline(id, next, note);
		if (!outcome.ok) {
			error = outcome.reason;
			inlineBusy = false;
			return;
		}
		rememberBody(id, prior, replaced);
		await reload();
		recordAction({
			area: 'templates',
			label: `${note} in “${name}”`,
			undo: async () => {
				await api.templates.revertTo(id, prior);
				await reload();
			}
		});
		inlineBusy = false;
		closeInline();
	}

	async function send(event: SubmitEvent) {
		if (assistantPaused) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		const text = instruction.trim();
		if (!text || streaming || !current || viewedRevision !== null) return;
		error = '';
		classification = null;
		progress = null;
		phase = 'classifying';
		const id = current.id;
		try {
			classification = await api.templates.classify(id, text, modelId);
			phase = 'drafting';
			// A refine round re-drafts from the committed copy with the whole
			// instruction chain, so the new draft carries every earlier round.
			const combined = [...instructionChain, text].join('\n');
			const base = draft
				? ($state.snapshot(draft) as AnyTemplate)
				: ($state.snapshot(current) as AnyTemplate);
			const result = await api.templates.revise(
				id,
				combined,
				(update) => (progress = update),
				modelId
			);
			diffBase = base;
			draft = result.draft;
			draftNote = result.note;
			draftSide = 'after';
			instructionChain = [...instructionChain, text];
			instruction = '';
		} catch (err) {
			// A failed round leaves everything as it was: the prior draft, its
			// diff base, and no stale stream line. A refusal carries its typed
			// reason (e.g. the locked email question) and says it verbatim.
			progress = null;
			error =
				err instanceof Error && err.name === 'ReviseRefusal'
					? err.message
					: 'Drafting failed — the template is unchanged. Try again.';
		}
		phase = 'idle';
		await refocus();
	}

	async function apply() {
		if (!draft || !current || busy) return;
		busy = true;
		error = '';
		const id = current.id;
		const name = current.name;
		const baseRevision = current.revision;
		const appliedRevision = draft.revision;
		const replaced = contentOf(current);
		// Applying a form draft syncs its field work (new questions, context and
		// requiredness changes) into the field registry; the registry as it
		// stands right now is what a compensating undo puts back.
		const fieldsBefore =
			isSurfaceTemplate(draft) && draft.kind === 'application-form'
				? structuredClone(await api.fields.list())
				: null;
		const outcome = await api.templates.applyRevision(id, $state.snapshot(draft) as AnyTemplate);
		if (!outcome.ok) {
			error = outcome.reason;
			busy = false;
			return;
		}
		rememberBody(id, baseRevision, replaced);
		await reload();
		discardDraftState();
		recordAction({
			area: 'templates',
			label: `Applied revision ${appliedRevision} to “${name}”`,
			undo: async () => {
				await api.templates.revertTo(id, baseRevision);
				if (fieldsBefore) {
					const registry = await api.fields.list();
					for (const field of registry) {
						if (!fieldsBefore.some((prior) => prior.id === field.id)) {
							await api.fields.remove(field.id);
						}
					}
					for (const prior of fieldsBefore) {
						const now = registry.find((field) => field.id === prior.id);
						if (!now) continue;
						if (
							JSON.stringify(now.required) !== JSON.stringify(prior.required) ||
							now.collectAt.join(' ') !== prior.collectAt.join(' ')
						) {
							await api.fields.update(prior.id, {
								required: prior.required,
								collectAt: prior.collectAt
							});
						}
					}
				}
				await reload();
			}
		});
		busy = false;
		await refocus();
	}

	function discardDraftState() {
		draft = null;
		draftNote = '';
		draftSide = 'after';
		diffBase = null;
		instructionChain = [];
		classification = null;
		progress = null;
	}

	async function discard() {
		discardDraftState();
		error = '';
		await refocus();
	}

	function viewRevision(number: number) {
		restoreError = '';
		viewedRevision = current && number === current.revision ? null : number;
	}

	/** One line per revision: the current copy names itself, older ones say who and why. */
	function revisionOptionLabel(revision: AnyTemplate['revisions'][number]) {
		if (current && revision.number === current.revision) return `rev ${revision.number} · current`;
		return `rev ${revision.number} — ${revision.by === 'agent' ? 'agent' : 'you'} · ${revision.note}`;
	}

	function onRevisionPick(event: Event & { currentTarget: HTMLSelectElement }) {
		viewRevision(Number(event.currentTarget.value));
	}

	async function restoreRevision(number: number) {
		if (!current || busy) return;
		busy = true;
		restoreError = '';
		const id = current.id;
		const name = current.name;
		const priorRevision = current.revision;
		const replaced = contentOf(current);
		const outcome = await api.templates.revertTo(id, number);
		if (!outcome.ok) {
			restoreError = outcome.reason;
			busy = false;
			return;
		}
		rememberBody(id, priorRevision, replaced);
		await reload();
		viewedRevision = null;
		recordAction({
			area: 'templates',
			label: `Restored revision ${number} of “${name}”`,
			undo: async () => {
				await api.templates.revertTo(id, priorRevision);
				await reload();
			}
		});
		busy = false;
	}

	const kindView: Record<TemplateDiffEntry['kind'], { label: string; tone: string }> = {
		added: { label: 'Added', tone: 'success' },
		removed: { label: 'Removed', tone: 'danger' },
		edited: { label: 'Edited', tone: 'info' }
	};
</script>

{#snippet rowButton(template: AnyTemplate)}
	{@const last = lastRevision(template)}
	<button type="button" class="tpl-row" onclick={() => openTemplate(template.id)}>
		<span class="tpl-row__main">
			<span class="tpl-row__name">{template.name}</span>
			<span class="tpl-row__purpose">{template.purpose}</span>
		</span>
		<span class="tpl-row__used">
			{#each template.usedBy as flow (flow)}
				<span class="ui-badge ui-badge--neutral">{flow}</span>
			{/each}
		</span>
		<span class="ui-badge ui-badge--neutral tpl-row__rev">
			{#if last?.by === 'agent'}
				<Bot size={12} aria-hidden="true" /><span class="ui-sr-only">last revised by the agent, </span>
			{/if}
			rev {template.revision}
		</span>
	</button>
{/snippet}

{#snippet templateRow(template: AnyTemplate)}
	<li>{@render rowButton(template)}</li>
{/snippet}

<nav class="chips" aria-label="Template areas">
	{#each tabs as entry (entry.key)}
		<button
			type="button"
			class="chips__tab"
			class:chips__tab--active={tab === entry.key}
			aria-pressed={tab === entry.key}
			onclick={() => switchTab(entry.key)}>
			{entry.label}
		</button>
	{/each}
</nav>

{#if tab === 'brand'}
	<!-- A saved brand re-reads the shared copy, so an editor opened next previews
	     the new brand without a full page load — the same path undo already takes. -->
	<BrandTab {port} onSaved={reload} />
{:else if libraryFailure && !library}
	<!-- The library answered, and the answer was no. Skeleton rows would keep
	     promising templates that nothing is fetching. -->
	<section class="card" role="alert" aria-label="Template library">
		<header class="card__head"><h2 class="card__title">Templates</h2></header>
		<p class="library-failure">{libraryFailure.message}</p>
		{#if libraryFailure.retryable}
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				aria-busy={retryingLibrary || undefined}
				disabled={retryingLibrary}
				onclick={retryLibrary}>Try again</button>
		{/if}
	</section>
{:else if !library}
	{#if selectedId}
		<!-- The editor's composition with skeleton fills: header lines, the
		     preview's reserved room, and the rail, so arrival replaces content
		     without moving the page. -->
		<div class="editor" aria-busy="true" aria-label="Loading template">
			<header class="card editor__head" aria-hidden="true">
				<span class="ui-skeleton sk-line" style="inline-size: 4.5rem"></span>
				<p class="editor__name"><span class="ui-skeleton sk-line" style="inline-size: 14rem"></span></p>
				<p class="editor__purpose"><span class="ui-skeleton sk-line" style="inline-size: min(26rem, 100%)"></span></p>
				<div class="editor__meta"><span class="ui-skeleton sk-chip"></span><span class="ui-skeleton sk-chip"></span></div>
			</header>
			<div class="editor__work" aria-hidden="true">
				<section class="card editor__preview"><span class="ui-skeleton sk-preview"></span></section>
				<aside class="card editor__rail">
					<span class="ui-skeleton sk-control"></span>
					<span class="ui-skeleton sk-line" style="inline-size: 12rem"></span>
					<span class="ui-skeleton sk-line" style="inline-size: 9rem"></span>
				</aside>
			</div>
		</div>
	{:else}
		{@const listTitle = tab === 'surfaces' ? 'Public surfaces' : 'Message templates'}
		<section class="card" aria-label={listTitle} aria-busy="true">
			<header class="card__head"><h2 class="card__title">{listTitle}</h2></header>
			<ul class="tpl-rows" aria-hidden="true">
				{#each Array(tab === 'surfaces' ? 2 : 4) as _, index (index)}
					<li class="tpl-row tpl-row--fill">
						<span class="tpl-row__main">
							<span class="tpl-row__name"><span class="ui-skeleton sk-line" style="inline-size: 11rem"></span></span>
							<span class="tpl-row__purpose"><span class="ui-skeleton sk-line" style="inline-size: min(22rem, 100%)"></span></span>
						</span>
						<span class="ui-skeleton sk-chip"></span>
						<span class="ui-skeleton sk-chip sk-chip--narrow"></span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{:else if missingSelection}
	<section class="card missing" aria-label="Template not found">
		<p class="missing__title">This template no longer exists.</p>
		<p class="missing__copy">It may have been removed, or the link is stale.</p>
		<Button variant="secondary" size="sm" onclick={closeTemplate}>
			<ArrowLeft size={14} aria-hidden="true" />{tab === 'surfaces' ? 'All surfaces' : 'All templates'}
		</Button>
	</section>
{:else if current && theme}
	<div class="editor">
		<header class="card editor__head">
			<button type="button" class="ui-button ui-button--ghost ui-button--sm editor__back" onclick={closeTemplate}>
				<ArrowLeft size={14} aria-hidden="true" />{currentIsSurface ? 'All surfaces' : 'All templates'}
			</button>
			<h2 class="editor__name">{current.name}</h2>
			<p class="editor__purpose">{current.purpose}</p>
			<div class="editor__meta">
				{#each current.usedBy as flow (flow)}
					<span class="ui-badge ui-badge--neutral">{flow}</span>
				{/each}
			</div>
			{#if currentIsSurface && api.publication}
				<div class="editor__publication">
					<Button
						size="sm"
						disabled={publicationStatus?.state === 'published'}
						loading={publishing}
						onclick={publishCurrent}>
						{publicationStatus?.state === 'published'
							? 'Published'
							: publicationStatus?.state === 'changes_pending' ? 'Publish update' : 'Publish'}
					</Button>
					{#if publicationStatus?.publishedRevisionNumber !== null
							&& publicationStatus?.publishedRevisionNumber !== undefined}
						<span>Public revision {publicationStatus.publishedRevisionNumber}</span>
					{/if}
				</div>
				{#if publicationError}
					<p class="editor__publication-error" role="alert">{publicationError}</p>
				{/if}
			{/if}
			<div class="revsel">
				<label class="revsel__label" for="tpl-revisions">Revision history</label>
				<select
					id="tpl-revisions"
					class="ui-select revsel__select"
					value={String(viewedRevision ?? current.revision)}
					onchange={onRevisionPick}>
					{#each [...current.revisions].reverse() as revision (revision.number)}
						<option value={String(revision.number)}>{revisionOptionLabel(revision)}</option>
					{/each}
				</select>
			</div>
			{#if isApplicationSurface}
				<!-- Which form this surface is being previewed as. The surface is the
				     shared presentation; each form composes its own question set,
				     configured on the Forms page — the door beside the picker. -->
				<div class="revsel editor__lens">
					<label class="revsel__label" for="tpl-form-lens">Previewing as</label>
					<select
						id="tpl-form-lens"
						class="ui-select editor__lens-select"
						value={lensId ?? ''}
						disabled={Boolean(draft)}
						onchange={onLensPick}>
						<option value="">Standard application</option>
						{#each formList ?? [] as lensChoice (lensChoice.id)}
							<option value={lensChoice.id}>
								{lensChoice.name}{lensChoice.status === 'open' ? '' : ` — ${statusWord[lensChoice.status]}`}
							</option>
						{/each}
					</select>
					{#if draft}
						<p class="editor__lens-note">
							A draft previews the standard application; the form view resumes after Apply or
							Discard.
						</p>
					{:else if lensForm}
						<a class="editor__lens-door" href={`/app/forms?form=${lensForm.id}`}>
							Configure its questions
						</a>
					{:else}
						<a class="editor__lens-door" href="/app/forms">Forms decide what’s asked</a>
					{/if}
				</div>
			{/if}
		</header>

		<div class="editor__work">
			<section class="card editor__preview" aria-label={currentIsSurface ? 'Surface preview' : 'Message preview'}>
				<!-- One reserved row: the copy's identity on the left, and — only while a
				     draft is under review — the Before/After switch on the right. Its
				     height fits the segmented control in every state, so the toggle's
				     arrival repaints the row without moving the preview below it. -->
				<div class="editor__top">
					<p class="editor__state">
						{#if viewedRevision !== null}
							Viewing revision {viewedRevision} — read only
						{:else if draft && draftSide === 'before'}
							<span class="ui-badge ui-badge--neutral">Current</span> Revision {current.revision}.
						{:else if draft}
							<span class="ui-badge ui-badge--info">Draft</span> Not applied yet.
						{:else}
							Current · revision {current.revision}
						{/if}
					</p>
					{#if draft && viewedRevision === null}
						<div class="ui-segmented editor__sides" role="group" aria-label="Compare draft with current">
							<button
								type="button"
								class="ui-segmented__item"
								aria-pressed={draftSide === 'before'}
								onclick={() => (draftSide = 'before')}>
								Before
							</button>
							<button
								type="button"
								class="ui-segmented__item"
								aria-pressed={draftSide === 'after'}
								onclick={() => (draftSide = 'after')}>
								After
							</button>
						</div>
					{/if}
				</div>
				<div
					class="editor__reserve"
					bind:this={reserveEl}
					use:editableUnits={{ enabled: inlineEnabled, onPress: onUnitPress }}>
					{#if displayTemplate}
						{@const shown = displayTemplate}
						{#if isSurfaceTemplate(shown)}
							{#if shown.kind === 'schedule'}
								{#if program}
									<ScheduleSurfaceRender
										template={shown}
										{theme}
										{eventName}
										{eventMeta}
										schedule={program.schedule}
										tracks={program.tracks}
										editable={inlineEnabled} />
								{:else if previewFailure}
									<p class="preview-failure" role="alert">{previewFailure.message}</p>
								{:else}
									<!-- The program is still on its way; the reserve keeps the room. -->
									<span class="ui-skeleton sk-preview" aria-hidden="true"></span>
								{/if}
							{:else if shown.kind === 'speaker-roster'}
								{#if lineup}
									<RosterSurfaceRender
										template={shown}
										{theme}
										{eventName}
										{eventMeta}
										roster={lineup.roster}
										categories={lineup.categories}
										editable={inlineEnabled} />
								{:else if previewFailure}
									<p class="preview-failure" role="alert">{previewFailure.message}</p>
								{:else}
									<span class="ui-skeleton sk-preview" aria-hidden="true"></span>
								{/if}
							{:else}
								<FormSurfaceRender
									template={shown}
									{theme}
									{eventName}
									{eventMeta}
									editable={inlineEnabled} />
							{/if}
						{:else}
							<EmailRender template={shown} {theme} {eventName} {eventMeta} editable={inlineEnabled} />
						{/if}
					{:else}
						<div class="editor__nobody">
							<p>No stored copy of revision {viewedRevision} to preview.</p>
							<p class="editor__nobody-sub">Only its note survives from before this session.</p>
						</div>
					{/if}
				</div>
				<!-- The one standing hint for the direct lane. Visibility, not
				     existence, tracks editability, so the card's geometry never
				     moves when a read-only view makes the line momentarily untrue. -->
				<p class="editor__hint" class:editor__hint--off={!inlineEnabled}>
					Click any text to edit it directly.
				</p>
				{#if inlineUnit && inlineAnchor}
					{#key `${inlineUnit.type}:${inlineUnit.path}`}
						<InlineEditor
							unit={inlineUnit}
							anchor={inlineAnchor}
							mergeFields={workingMergeFields}
							field={inlineField}
							busy={inlineBusy}
							onchange={previewInline}
							oncommit={applyInline}
							oncancel={() => closeInline()} />
					{/key}
				{/if}
			</section>

			<aside class="card editor__rail">
				{#if viewedRevision !== null && viewedMeta}
					<section class="restore" aria-label={`Revision ${viewedRevision}`}>
						<h3 class="rail__title">Revision {viewedRevision}</h3>
						<p class="restore__meta">
							{viewedMeta.at} · {viewedMeta.by === 'agent' ? 'Agent' : 'You'}
						</p>
						<p class="restore__note">{viewedMeta.note}</p>
						<div class="restore__actions">
							<Button size="sm" loading={busy} onclick={() => restoreRevision(viewedRevision ?? 0)}>
								Restore this version
							</Button>
							<Button variant="ghost" size="sm" disabled={busy} onclick={() => viewRevision(current.revision)}>
								Back to current
							</Button>
						</div>
						{#if restoreError}<p class="rail__error" role="alert">{restoreError}</p>{/if}
						<p class="restore__how">
							Restoring re-creates this content as a new revision on top — history moves forward, never
							rewrites.
						</p>
					</section>
				{:else}
					<section class="assistant" aria-label="Change it with AI">
						<!-- The lavender mark is the assistant's identity; while a draft
						     streams it breathes (opacity only) and goes still with the
						     stream. Everything else in the panel stays in neutral ink. -->
						<div class="assistant__head">
							<span class="assistant__mark" class:assistant__mark--working={streaming} aria-hidden="true">
								<Sparkles size={15} />
							</span>
							<div class="assistant__id">
								<h3 class="assistant__title">
									Change it with AI
									{#if assistantPaused}<span class="ui-badge ui-badge--neutral">Coming soon</span>{/if}
								</h3>
								<p class="assistant__sub">
									{#if assistantPaused}
										Soon you'll describe a change here and review a drafted revision before
										anything is applied.
									{:else}
										Each instruction is routed to the lightest profile that can do it.
									{/if}
								</p>
							</div>
						</div>
						<form class="bar" onsubmit={send}>
							<label class="ui-sr-only" for="tpl-instruction">Tell it what to change</label>
							<div class="bar__row">
								<input
									id="tpl-instruction"
									class="ui-control bar__input"
									type="text"
									placeholder="Tell it what to change…"
									autocomplete="off"
									disabled={assistantPaused}
									readonly={streaming}
									bind:this={inputEl}
									bind:value={instruction} />
								<Button
									type="submit"
									size="md"
									disabled={assistantPaused || !instruction.trim() || streaming}
									loading={streaming}>
									Send
								</Button>
							</div>
							<div class="bar__model">
								<label class="bar__model-label" for="tpl-model">Model</label>
								<select
									id="tpl-model"
									class="ui-select bar__model-select"
									disabled={assistantPaused || streaming}
									bind:value={modelId}>
									{#each modelChoices as choice (choice.id)}
										<option value={choice.id} title={choice.sub}>{choice.label}</option>
									{/each}
								</select>
							</div>
							<!-- One reserved slot for the routing and stream lines from the
							     moment a round starts. Content swaps; the height holds. No round
							     can start while the lane is paused, so the slot rests. -->
							{#if !assistantPaused}
								<div class="bar__slot">
								<div
									class="bar__status"
									class:bar__status--live={phase !== 'idle' || !!classification || !!progress}
									role="status">
									<p class="bar__routing">
										{#if classification}
											<span class="ui-badge ui-badge--neutral bar__profile">
												{classification.chosenBy === 'you'
													? `Your pick · ${classification.profileLabel}`
													: classification.profileLabel}
											</span>
											{#if classification.chosenBy === 'auto'}
												<span class="bar__reason">{classification.reason}</span>
											{/if}
										{:else if phase === 'classifying'}
											<span class="bar__hint">Routing the instruction…</span>
										{/if}
									</p>
									<p class="bar__progress">
										{#if progress?.status === 'drafting'}
											Drafting — <span class="bar__tokens">{progress.tokens}</span> tokens…
										{:else if progress?.status === 'done' && draft}
											Draft ready — <span class="bar__tokens">{progress.tokens}</span> tokens.
										{:else if progress?.status === 'classifying'}
											Preparing…
										{/if}
									</p>
								</div>
							</div>
							{/if}
							{#if error}<p class="rail__error" role="alert">{error}</p>{/if}
						</form>
					</section>

					{#if draft}
						<section class="diff" aria-label="What changed">
							<h3 class="rail__title">What changed</h3>
							{#if draftNote}<p class="diff__note">{draftNote}</p>{/if}
							<ul class="diff__list">
								{#each diff as entry, index (index)}
									{@const view = kindView[entry.kind]}
									<li class="diff__entry">
										<span class="ui-badge ui-badge--{view.tone}">{view.label}</span>
										<span class="diff__target">{entry.target}</span>
										{#if entry.kind === 'edited'}
											<span class="diff__text">
												<del class="diff__before">{entry.before}</del>
												<span class="diff__arrow" aria-hidden="true">→</span>
												<ins class="diff__after">{entry.after}</ins>
											</span>
										{:else if entry.before}
											<span class="diff__text"><del class="diff__before">{entry.before}</del></span>
										{:else if entry.after}
											<span class="diff__text"><ins class="diff__after">{entry.after}</ins></span>
										{/if}
									</li>
								{:else}
									<li class="diff__entry diff__entry--none">No structural change.</li>
								{/each}
							</ul>
							<div class="diff__actions">
								<Button size="sm" loading={busy} onclick={apply}>Apply</Button>
								<Button variant="secondary" size="sm" disabled={busy || streaming} onclick={refocus}>
									Refine
								</Button>
								<Button variant="ghost" size="sm" disabled={busy || streaming} onclick={discard}>
									Discard
								</Button>
							</div>
							<p class="diff__hint">
								Refine keeps this draft as the base for your next instruction. Nothing reaches the
								template until you apply.
							</p>
						</section>
					{/if}
				{/if}
			</aside>
		</div>
	</div>
{:else if tab === 'surfaces'}
	{#if library.surfaces.length === 0}
		<section class="card missing" aria-label="Public surfaces">
			<p class="missing__title">No public surfaces yet.</p>
			<p class="missing__copy">The schedule page and application form arrive with your first event.</p>
		</section>
	{:else}
		<section class="card" aria-label="Public surfaces">
			<header class="card__head"><h2 class="card__title">Public surfaces</h2></header>
			<ul class="tpl-rows">
				{#each library.surfaces as surface (surface.id)}
					<li class="tpl-pair">
						{@render rowButton(surface)}
						<!-- One page, two jobs: this list edits what it says, Embeds hands
						     you the code that puts it on your own site. R2 keeps the door
						     single — this is the only exit from a surface row to its
						     snippet, and it resolves to the same address the Speakers,
						     Schedule, and Forms doors resolve to. -->
						<a class="ui-button ui-button--ghost ui-button--sm tpl-pair__door"
							href={`/app/embeds?embed=${surface.id}`}>
							<CodeXml size={14} aria-hidden="true" />Embed<span class="ui-sr-only">
								{surface.name} on your site</span>
						</a>
					</li>
				{/each}
			</ul>
			<p class="tpl-note">
				Wording, layout, and brand live here. The code that puts one of these on your own website
				lives in <a href="/app/embeds">Embeds</a>.
			</p>
		</section>
	{/if}
{:else if library.messages.length === 0}
	<section class="card missing" aria-label="Message templates">
		<p class="missing__title">No templates yet.</p>
		<p class="missing__copy">Your starter set arrives with your first event.</p>
	</section>
{:else}
	<section class="card" aria-label="Message templates">
		<header class="card__head"><h2 class="card__title">Message templates</h2></header>
		<ul class="tpl-rows">
			{#each library.messages as template (template.id)}
				{@render templateRow(template)}
			{/each}
		</ul>
	</section>
{/if}

<CommitReceipt onUndone={reload} />

<style>
	/* Tab chips: the same shape the roster filters use, so switching an area's
	   facet reads identically everywhere. */
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1);
	}

	.chips__tab {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-1) var(--je-space-3);
		border: 1px solid transparent;
		border-radius: var(--je-radius-round);
		background: transparent;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
		cursor: pointer;
	}

	.chips__tab:hover {
		background: var(--je-color-surface);
		color: var(--je-color-text);
	}

	.chips__tab--active {
		background: var(--je-color-mark-surface);
		border-color: var(--je-color-mark-border);
		color: var(--je-color-text);
		font-weight: 600;
	}

	.card {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.card__head {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-block-size: var(--je-control-height-sm);
		margin-block-end: var(--je-space-2);
	}

	.card__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* Skeleton fills borrow their geometry from what they stand in for. */
	.sk-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.sk-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 6.5rem;
	}

	.sk-chip--narrow {
		inline-size: 3.5rem;
	}

	.sk-control {
		display: block;
		block-size: var(--je-control-height);
		border-radius: var(--je-radius-control);
	}

	.library-failure,
	.preview-failure {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.sk-preview {
		display: block;
		min-block-size: 38rem;
		border-radius: var(--je-radius-surface);
	}

	/* Template list */
	.tpl-rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.tpl-rows > li + li,
	.tpl-row--fill + .tpl-row--fill {
		border-block-start: 1px solid var(--je-color-border);
	}

	.tpl-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content max-content;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		inline-size: 100%;
		padding: var(--je-space-3) var(--je-space-2);
		border: 0;
		border-radius: var(--je-radius-control);
		background: transparent;
		text-align: start;
		cursor: pointer;
	}

	.tpl-row:hover {
		background: var(--je-color-surface-sunken);
	}

	.tpl-row--fill {
		cursor: default;
	}

	.tpl-row__main {
		display: grid;
		gap: 0.125rem;
		min-width: 0;
	}

	.tpl-row__name {
		font-size: var(--je-font-size-md);
		font-weight: 600;
		color: var(--je-color-text);
	}

	.tpl-row__purpose {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.tpl-row__used {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--je-space-1);
	}

	.tpl-row__rev {
		font-variant-numeric: tabular-nums;
	}

	/* A surface row and its one exit share a line: the row is the whole width it
	   can be, the door keeps its own target rather than living inside the row's
	   press area — two outcomes never share one target. */
	.tpl-pair {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-2);
	}

	.tpl-pair__door {
		flex: none;
	}

	/* Editor */
	.editor {
		display: grid;
		gap: var(--je-space-4);
	}

	.editor__head {
		display: grid;
		gap: var(--je-space-2);
		justify-items: start;
	}

	.editor__back {
		margin-inline-start: calc(var(--je-space-2) * -1);
	}

	.editor__name {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 650;
	}

	.editor__purpose {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		max-inline-size: 72ch;
	}

	.editor__meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1);
	}

	.editor__publication {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.editor__publication-error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	/* Revision history: one compact select. The closed control names the copy on
	   screen ("rev 2 · current"); each option is a single formatted line with
	   who made the revision and its note. */
	.revsel {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-1);
	}

	.revsel__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.revsel__select {
		inline-size: auto;
		max-inline-size: min(24rem, 100%);
		height: var(--je-control-height-sm);
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
	}

	.editor__work {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 26rem);
		gap: var(--je-space-4);
		align-items: start;
	}

	.editor__preview {
		display: grid;
		gap: var(--je-space-2);
	}

	/* One row, always present: which copy the preview shows, and the Before/After
	   switch while a draft is under review. Its minimum height fits the segmented
	   control, so the switch appearing never moves the preview below. */
	.editor__lens {
		margin-block-start: 0;
	}

	.editor__lens-select {
		max-inline-size: 20rem;
	}

	.editor__lens-door {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.editor__lens-door:hover {
		color: var(--je-color-text);
	}

	/* The reason the picker is inert while a draft is open, stated in place. */
	.editor__lens-note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.editor__top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2);
		min-block-size: calc(var(--je-control-height-sm) + 4px);
	}

	.editor__sides {
		flex: none;
	}

	.editor__state {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
		min-block-size: 1.5rem;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* The preview's reserved room: streaming, drafts, and revision reads swap
	   content inside a container that never collapses. */
	.editor__reserve {
		min-block-size: 38rem;
		display: grid;
		align-items: start;
	}

	.editor__reserve > :global(*) {
		grid-area: 1 / 1;
	}

	.editor__nobody {
		display: grid;
		place-content: center;
		gap: var(--je-space-1);
		min-block-size: 38rem;
		border: 1px dashed var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		text-align: center;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.editor__nobody p {
		margin: 0;
	}

	/* The quiet one-line hint under the preview. Hidden — never removed — while
	   the preview is inert, so the card's height holds. */
	.editor__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.editor__hint--off {
		visibility: hidden;
	}

	.editor__nobody-sub {
		font-size: var(--je-font-size-xs);
	}

	.editor__rail {
		display: grid;
		gap: var(--je-space-4);
		align-content: start;
	}

	.rail__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.rail__error {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-danger);
	}

	/* Assistant panel: the lavender mark is the only accented element — the
	   identity anchor for agent work, per the attribution rule. */
	.assistant {
		display: grid;
		gap: var(--je-space-3);
	}

	.assistant__head {
		display: flex;
		align-items: flex-start;
		gap: var(--je-space-2);
	}

	.assistant__mark {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		inline-size: 1.75rem;
		block-size: 1.75rem;
		border-radius: var(--je-radius-sm);
		background: var(--je-color-accent-lavender-soft);
		color: var(--je-color-accent-lavender-strong);
	}

	/* Breathes only while a round is streaming — opacity only, token-derived
	   period — and goes still the moment the stream ends. */
	.assistant__mark--working {
		animation: assistant-working var(--je-duration-loop) var(--je-ease) infinite alternate;
	}

	@keyframes assistant-working {
		from {
			opacity: 1;
		}

		to {
			opacity: 0.4;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.assistant__mark--working {
			animation: none;
		}
	}

	.assistant__id {
		display: grid;
		gap: 0.125rem;
		min-width: 0;
	}

	.assistant__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-text);
	}

	.assistant__sub {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Iteration bar */
	.bar {
		display: grid;
		gap: var(--je-space-2);
	}

	.bar__row {
		display: flex;
		gap: var(--je-space-2);
	}

	.bar__input {
		flex: 1;
		min-inline-size: 0;
	}

	/* The model pick stays quiet: a small labelled select, routing by default. */
	.bar__model {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
	}

	.bar__model-label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.bar__model-select {
		inline-size: auto;
		min-inline-size: 9rem;
		max-inline-size: 100%;
		height: var(--je-control-height-sm);
		font-size: var(--je-font-size-sm);
	}

	/* One slot under the input: suggestions or the status lines occupy the same
	   cell. It sizes to its content — at rest that is the chip row (or nothing),
	   so the panel carries no reserved blank strip; the two status lines claim
	   their height only while a round is live, and a round starting or ending is
	   the user's own press. */
	.bar__slot {
		display: grid;
		align-items: start;
	}

	.bar__status {
		grid-area: 1 / 1;
	}

	/* Two reserved lines: the routing decision and the stream. Content changes,
	   height does not. */
	.bar__status {
		display: grid;
		gap: 0.125rem;
		align-content: start;
	}


	.bar__routing {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Line reserves exist only while a round is live: mid-stream the text
	   changes but the geometry cannot, and at rest the empty lines are flat. */
	.bar__status--live .bar__routing {
		min-block-size: 1.5rem;
	}

	.bar__status--live .bar__progress {
		min-block-size: 1.25rem;
	}

	.bar__reason {
		min-width: 0;
	}

	.bar__hint {
		color: var(--je-color-text-muted);
	}

	.bar__progress {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.bar__tokens {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		color: var(--je-color-text);
	}

	/* Diff strip */
	.diff {
		display: grid;
		gap: var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-3);
	}

	.diff__note {
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.diff__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-2);
	}

	/* The second track can shrink to nothing, so a long before→after line wraps
	   inside the rail instead of widening the document. */
	.diff__entry {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: baseline;
		column-gap: var(--je-space-2);
		row-gap: 0.125rem;
		font-size: var(--je-font-size-sm);
	}

	.diff__entry--none {
		grid-template-columns: 1fr;
		color: var(--je-color-text-muted);
	}

	.diff__target {
		font-weight: 600;
	}

	.diff__text {
		grid-column: 1 / -1;
		min-width: 0;
		font-size: var(--je-font-size-xs);
		overflow-wrap: anywhere;
	}

	.diff__before {
		color: var(--je-color-text-muted);
		text-decoration: line-through;
	}

	.diff__arrow {
		margin-inline: var(--je-space-1);
		color: var(--je-color-text-muted);
	}

	.diff__after {
		text-decoration: none;
		font-weight: 600;
	}

	.diff__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.diff__hint {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Revision read + restore */
	.restore {
		display: grid;
		gap: var(--je-space-2);
	}

	.restore__meta {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.restore__note {
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.restore__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.restore__how {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The quiet honest line under the surfaces list. */
	.tpl-note {
		margin: var(--je-space-3) 0 0;
		padding-inline: var(--je-space-2);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Missing / empty */
	.missing {
		display: grid;
		justify-items: center;
		gap: var(--je-space-1);
		padding-block: var(--je-space-8);
		text-align: center;
	}

	.missing__title {
		margin: 0;
		font-weight: 600;
	}

	.missing__copy {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 1100px) {
		/* The editor stacks: preview first, the iteration bar beneath it. */
		.editor__work {
			grid-template-columns: minmax(0, 1fr);
		}

		.editor__reserve,
		.editor__nobody,
		.sk-preview {
			min-block-size: 24rem;
		}
	}

	@media (max-width: 920px) {
		/* Three facets ragged-wrapping read as debris; a grid keeps one rhythm
		   and gives every chip a touch-sized target. */
		.chips {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: var(--je-space-2);
		}

		.chips__tab {
			justify-content: center;
			min-block-size: 2.75rem;
			border-color: var(--je-color-border);
			background: var(--je-color-surface);
			font-size: var(--je-font-size-sm);
		}

		.chips__tab--active {
			background: var(--je-color-mark-surface);
		}

		.tpl-row {
			grid-template-columns: minmax(0, 1fr) max-content;
			grid-template-areas:
				'main rev'
				'used used';
			align-items: start;
		}

		.tpl-row__main {
			grid-area: main;
		}

		.tpl-row__rev {
			grid-area: rev;
		}

		.tpl-row__used {
			grid-area: used;
			justify-content: flex-start;
		}
	}
</style>
