<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { ArrowLeft, GripVertical, Lock } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Checkbox,
		CopyValue,
		DatePicker,
		DescribedSelect,
		Field,
		Modal,
		createRowDrag,
		motionMs,
		statusIcon
	} from '$lib/ui';
	import type { DescribedOption, IconComponent } from '$lib/ui';
	import type {
		ApplicationSurfacePublication,
		FormPublishReview,
		FormsPagePort
	} from '$lib/api/forms-page-port';
	import { standaloneUrl } from '$lib/features/embeds/embed-snippet';
	import { param, paramFlag, applyParams, clearParams } from '$lib/features/workspace/url-state.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import type {
		FieldGroup,
		FieldKind,
		Format,
		FormComposition,
		FormFieldRow,
		FormSummary,
		FormTarget,
		RegistryField,
		Track
	} from '$lib/api/types';

	let { port }: { readonly port: FormsPagePort } = $props();

	let forms = $state<FormSummary[] | null>(null);
	let newFormOpen = $state(false);
	let publishReviewOpen = $state(false);
	let publishReview = $state<FormPublishReview | null>(null);
	let publishError = $state('');
	$effect(() => {
		if (!publishReviewOpen && publishReview) {
			publishReview = null;
			publishError = '';
		}
	});

	// A link may open the creation dialog — `/app/forms?new=1` — because a GET
	// may open a surface: the empty-inbox CFP nudge and the Overview attention
	// item land inside the act, not at an area name. Publishing stays the
	// separate, deliberate commit.
	const newAsked = $derived(paramFlag('new'));
	let newHonoured = false;

	$effect(() => {
		if (!newAsked) {
			newHonoured = false;
			return;
		}
		if (newHonoured) return;
		newHonoured = true;
		newFormOpen = true;
	});

	// Closing the dialog leaves a clean address behind, so a reload does not
	// reopen a dialog the operator already dismissed. Creation is not a
	// dismissal: its own navigation clears the flag in the same write, and
	// racing it here would wipe the `form` param it just pushed.
	$effect(() => {
		if (!newFormOpen && newAsked && newHonoured && !creating) void clearParams(['new']);
	});

	/** The open form's configurator is shareable state, so it lives in the address. */
	const formId = $derived(param('form'));

	onMount(() => {
		void reloadForms();
		// The application surface the Preview door lands on: one template serves
		// every form, so the id is resolved once.
		void port.templates.applicationFormSurfaceId().then(
			(id) => (surfaceId = id),
			() => (surfaceId = null)
		);
		// The other half of "is the public address actually live": the shared
		// application page's own release. A form and its page publish
		// separately, and an address serves only when both stand.
		void port.templates.applicationSurfacePublication().then(
			(publication) => (surfacePublication = publication),
			() => (surfacePublication = null)
		);
		// Target references resolve against the live vocabulary and sessions at
		// render time — a form stores only the reference, never a copied name.
		void Promise.all([port.vocab.tracks(), port.vocab.formats(), port.schedule.sessions()]).then(
			([trackList, formatList, sessions]) => {
				tracks = trackList;
				formats = formatList;
				sessionTitles = Object.fromEntries(
					sessions.map((session) => [session.id, session.title])
				);
				collectingSessions = sessions
					.filter((session) => session.state === 'collecting')
					.map((session) => ({ id: session.id, title: session.title }));
			}
		);
	});

	async function reloadForms() {
		forms = await port.forms.list();
	}

	let tracks = $state<Track[]>([]);
	let formats = $state<Format[]>([]);
	let sessionTitles = $state<Record<string, string>>({});
	let collectingSessions = $state<{ id: string; title: string }[]>([]);

	/**
	 * The application page's release state: `undefined` while it resolves,
	 * `null` when this composition cannot say, otherwise the exact serving pin.
	 */
	let surfacePublication = $state<ApplicationSurfacePublication | undefined>(undefined);

	/**
	 * A form's public address, spelled against whatever host serves this
	 * console — the same working answer the Embeds builder gives.
	 */
	function publicAddress(id: string): string {
		const origin =
			typeof window === 'undefined' ? 'https://your-event.example' : window.location.origin;
		return standaloneUrl(origin, {
			kind: 'application-form',
			scope: { kind: 'form', formId: id }
		});
	}

	function publicationServes(formId: string): boolean {
		return surfacePublication?.kind === 'any'
			|| (surfacePublication?.kind === 'pinned' && surfacePublication.formId === formId);
	}

	function publicationMismatch(formId: string): boolean {
		return surfacePublication?.kind === 'pinned' && surfacePublication.formId !== formId;
	}

	const pinnedFormId = $derived(
		surfacePublication?.kind === 'pinned' ? surfacePublication.formId : null
	);

	// Plain-language target labels: the badge says which kind of door this is;
	// the reference it points at is said in the target line beside it.
	const targetBadge: Record<FormTarget['kind'], { label: string; tone: string }> = {
		general: { label: 'Open call', tone: 'sea' },
		category: { label: 'Category pool', tone: 'lavender' },
		session: { label: 'Session proposal', tone: 'lavender' }
	};

	/** The target's reference as a sentence — null for the open call, whose badge says it all. */
	function targetLine(target: FormTarget): string | null {
		if (target.kind === 'category') {
			const pool = target.category === 'track' ? tracks : formats;
			const name = pool.find((entry) => entry.id === target.id)?.name;
			return name ? `Collects for the ${name} ${target.category}` : null;
		}
		if (target.kind === 'session') {
			const title = sessionTitles[target.sessionId];
			return title ? `Collects proposals for “${title}”` : null;
		}
		return null;
	}

	const todayIso = new Date().toISOString().slice(0, 10);

	function formatCloseDate(iso: string): string {
		return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	/** The close date as the card says it — relative while near, absolute when far. */
	function closesLabel(closesAt: string): string {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const days = Math.round((new Date(`${closesAt}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
		if (days < 0) return 'close date has passed';
		if (days === 0) return 'closes today';
		if (days === 1) return 'closes tomorrow';
		if (days <= 60) return `closes in ${days} days`;
		return `closes ${formatCloseDate(closesAt)}`;
	}

	const statusLabel: Record<FormSummary['status'], string> = {
		open: 'Open',
		closed: 'Closed',
		draft: 'Draft'
	};

	/* Replaces the status dot: the glyph says which of the three states this is,
	   where a coloured dot only said that there was one. */
	const statusGlyph: Record<FormSummary['status'], IconComponent> = {
		open: statusIcon.formOpen,
		closed: statusIcon.formClosed,
		draft: statusIcon.draft
	};

	function countLabel(count: number, singular: string) {
		return `${count} ${count === 1 ? singular : `${singular}s`}`;
	}

	// -----------------------------------------------------------------------
	// New form: creation asks only what is the organizer's to decide at birth —
	// a name, where accepted submissions go, and (optionally) when intake
	// closes. Everything else starts as the standard application and is trimmed
	// on the questions page the creation lands on. Intent-described drafting
	// arrives with the assistant slice as a peer entry point, not a mode here.

	let newName = $state('');
	let newTargetKind = $state<FormTarget['kind']>('general');
	/** The chosen category, encoded `track:<id>` or `format:<id>` for one native select. */
	let newCategoryRef = $state('');
	let newSessionId = $state('');
	let newClosesAt = $state('');
	let creating = $state(false);

	// Each open of the dialog is a fresh form, not the residue of the last one.
	$effect(() => {
		if (!newFormOpen) return;
		newName = '';
		newTargetKind = 'general';
		newCategoryRef = '';
		newSessionId = '';
		newClosesAt = '';
	});

	const activeTracks = $derived(tracks.filter((track) => (track.status ?? 'active') === 'active'));
	const activeFormats = $derived(
		formats.filter((format) => (format.status ?? 'active') === 'active')
	);

	/**
	 * What each target means, said where the choice is made — the described
	 * dropdown every option-with-consequences picker uses. On touch it opens as
	 * a full sheet, so the options read side by side without anchored-popover
	 * viewport juggling. Options are live: a category target is offered only
	 * while the vocabulary has entries, and a session target only while a
	 * session is actually collecting proposals — never simulated.
	 */
	const targetOptions = $derived.by(() => {
		const options: DescribedOption<FormTarget['kind']>[] = [
			{
				value: 'general',
				label: 'The open call',
				description:
					'Anyone can apply. Accepted talks join the general pool and are scheduled from there.'
			}
		];
		if (activeTracks.length > 0 || activeFormats.length > 0) {
			options.push({
				value: 'category',
				label: 'A category pool',
				description: 'Collects for one track or format that has no scheduled day yet.'
			});
		}
		if (collectingSessions.length > 0) {
			options.push({
				value: 'session',
				label: 'One specific session',
				description:
					'Proposals for a planned session that is collecting — say, a panel seeking panelists.'
			});
		}
		return options;
	});

	/** Picking a kind lands on a valid reference; the second field refines it. */
	function chooseTargetKind(kind: FormTarget['kind']) {
		newTargetKind = kind;
		if (kind === 'category' && !newCategoryRef) {
			newCategoryRef = activeTracks[0]
				? `track:${activeTracks[0].id}`
				: activeFormats[0]
					? `format:${activeFormats[0].id}`
					: '';
		}
		if (kind === 'session' && !newSessionId) {
			newSessionId = collectingSessions[0]?.id ?? '';
		}
	}

	const newTarget = $derived.by((): FormTarget | null => {
		if (newTargetKind === 'general') return { kind: 'general' };
		if (newTargetKind === 'category') {
			const [category, id] = newCategoryRef.split(':');
			if ((category !== 'track' && category !== 'format') || !id) return null;
			return { kind: 'category', category, id };
		}
		return newSessionId ? { kind: 'session', sessionId: newSessionId } : null;
	});

	const createReady = $derived(newName.trim().length > 0 && newTarget !== null);

	async function createForm(event?: SubmitEvent) {
		event?.preventDefault();
		if (!createReady || !newTarget || creating) return;
		creating = true;
		const created = await port.forms.create({
			name: newName.trim(),
			target: newTarget,
			...(newClosesAt ? { closesAt: newClosesAt } : {})
		});
		await reloadForms();
		newFormOpen = false;
		// The new form opens on its questions — creation's receipt is the arrival.
		// One write carries the whole address change: the questions page in, the
		// `?new=1` door flag out. `creating` stays up until it lands so the
		// dismissal cleanup cannot race a second write over it.
		await applyParams({ form: created.id, new: null }, { history: 'push' });
		creating = false;
	}

	// -----------------------------------------------------------------------
	// The configurator: one form's answer to "which questions, required where,
	// offering which options" — a checklist over the shared registry, never a
	// second field editor. Definitions stay with Settings → Speaker fields.

	let surfaceId = $state<string | null>(null);
	let form = $state<FormSummary | null>(null);
	let rows = $state<FormFieldRow[] | null>(null);
	let missingForm = $state(false);
	/**
	 * The composition being edited: the stored truth plus every unapplied tick.
	 * Checkbox presses land here instantly and nothing reaches the form until
	 * Apply commits the whole session as one act with one receipt.
	 */
	let draft = $state<FormComposition | null>(null);
	/** Operation id currently in flight; every control else waits its turn. */
	let pending = $state('');
	let refusals = $state<Record<string, string>>({});
	let message = $state('');
	/** The placement advisor's one-sentence reason, shown by the row it placed until the next action. */
	let placedId = $state('');
	let placedReason = $state('');
	/** Row ids whose option list is expanded. */
	let openOptions = $state<Record<string, boolean>>({});
	/** The in-flow Apply row, watched so the floating twin yields to it. */
	let applyRowEl = $state<HTMLElement>();
	let applyRowInView = $state(false);

	// A different form in the address is a different configuration session.
	let configuredFor: string | null = null;
	$effect(() => {
		if (formId === configuredFor) return;
		configuredFor = formId;
		form = null;
		rows = null;
		missingForm = false;
		pending = '';
		refusals = {};
		message = '';
		placedId = '';
		placedReason = '';
		openOptions = {};
		draft = null;
		if (formId) void reloadForm(formId, { resetDraft: true });
	});

	async function reloadForm(id: string, options: { resetDraft?: boolean } = {}) {
		const [summary, fieldRows] = await Promise.all([port.forms.get(id), port.forms.fields(id)]);
		if (id !== formId) return;
		form = summary;
		rows = fieldRows;
		missingForm = summary === null;
		// A registry reload (adding a scoped question) keeps the unapplied ticks;
		// a session start, an apply, or an apply-undo re-syncs to the stored truth.
		if (options.resetDraft || draft === null) {
			draft = summary ? (structuredClone($state.snapshot(summary.composition)) as FormComposition) : null;
		}
	}

	/** Re-reads the open form and the card list; also the refresh hook a receipt's undo calls. */
	async function reloadAll(options: { resetDraft?: boolean } = {}) {
		await Promise.all([reloadForms(), formId ? reloadForm(formId, options) : Promise.resolve()]);
	}

	const kindLabels: Record<FieldKind, string> = {
		text: 'text',
		textarea: 'long text',
		email: 'email',
		url: 'link',
		phone: 'phone',
		number: 'number',
		date: 'date',
		datetime: 'date & time',
		select: 'select',
		multiselect: 'multi-select',
		checkbox: 'checkbox',
		file: 'file'
	};
	const kindOrder: FieldKind[] = [
		'text',
		'textarea',
		'url',
		'phone',
		'number',
		'date',
		'datetime',
		'select',
		'multiselect',
		'checkbox',
		'file'
	];

	const groupHeadings: Record<FieldGroup, string> = {
		identity: 'Identity',
		contact: 'Contact',
		presence: 'Links & social',
		talk: 'Talk',
		logistics: 'Logistics',
		materials: 'Materials',
		other: 'General',
		consent: 'Consent'
	};

	const sourceNames: Record<'tracks' | 'formats', { plural: string; singular: string }> = {
		tracks: { plural: 'tracks', singular: 'track' },
		formats: { plural: 'formats', singular: 'format' }
	};

	/** One checklist row as the working draft answers it. */
	interface RowView {
		row: FormFieldRow;
		included: boolean;
		required: boolean;
		requiredOverridden: boolean;
		options?: { id: string; name: string; exposed: boolean }[];
		exposureAll: boolean;
	}

	function viewOf(row: FormFieldRow): RowView {
		const id = row.field.id;
		const scoped = row.field.formScope === formId;
		const override = draft?.requiredOverrides[id];
		const exposure = draft?.optionExposure[id];
		return {
			row,
			included: scoped || !(draft?.excludedFieldIds.includes(id) ?? false),
			required: override ?? row.field.required.apply === true,
			requiredOverridden: override !== undefined,
			...(row.options
				? {
						options: row.options.map((option) => ({
							id: option.id,
							name: option.name,
							exposed: !exposure || exposure.includes(option.id)
						}))
					}
				: {}),
			exposureAll: !exposure
		};
	}

	/**
	 * The rows in registry order, cut into runs of consecutive same-group rows.
	 * A heading renders per run with its asked-count, so interleaved groups keep
	 * the user's layout — never re-sorted to make the headings tidier.
	 */
	interface Segment {
		key: string;
		group: FieldGroup;
		rows: RowView[];
	}
	const segments = $derived.by(() => {
		const out: Segment[] = [];
		for (const row of rows ?? []) {
			const last = out[out.length - 1];
			if (!last || last.group !== row.field.group) {
				out.push({ key: `${out.length}-${row.field.group}`, group: row.field.group, rows: [] });
			}
			out[out.length - 1].rows.push(viewOf(row));
		}
		return out;
	});

	/** How many composition facts the draft changes against the stored form. */
	const pendingCount = $derived.by(() => {
		if (!form || !draft) return 0;
		const base = form.composition;
		let count = 0;
		const baseExcluded = new Set(base.excludedFieldIds);
		const draftExcluded = new Set(draft.excludedFieldIds);
		for (const id of draftExcluded) if (!baseExcluded.has(id)) count += 1;
		for (const id of baseExcluded) if (!draftExcluded.has(id)) count += 1;
		const overrideKeys = new Set([
			...Object.keys(base.requiredOverrides),
			...Object.keys(draft.requiredOverrides)
		]);
		for (const key of overrideKeys) {
			if (base.requiredOverrides[key] !== draft.requiredOverrides[key]) count += 1;
		}
		const exposureKeys = new Set([
			...Object.keys(base.optionExposure),
			...Object.keys(draft.optionExposure)
		]);
		for (const key of exposureKeys) {
			const before = base.optionExposure[key];
			const after = draft.optionExposure[key];
			if (
				Boolean(before) !== Boolean(after) ||
				(before && after && (before.length !== after.length || before.some((id) => !after.includes(id))))
			) {
				count += 1;
			}
		}
		return count;
	});

	/** Whether the draft asks anything other than the standard application. */
	const draftDeviates = $derived.by(() => {
		if (!draft) return false;
		return (
			draft.excludedFieldIds.length > 0 ||
			Object.keys(draft.requiredOverrides).length > 0 ||
			Object.keys(draft.optionExposure).length > 0
		);
	});

	/** The floating Apply twin shows only while the in-flow row is off-screen. */
	const showFloatingApply = $derived(pendingCount > 0 && !applyRowInView);
	$effect(() => {
		const el = applyRowEl;
		if (!el) {
			applyRowInView = false;
			return;
		}
		const observer = new IntersectionObserver(([entry]) => {
			applyRowInView = entry.isIntersecting;
		});
		observer.observe(el);
		return () => observer.disconnect();
	});

	function begin(opId: string) {
		pending = opId;
		message = '';
		placedId = '';
		placedReason = '';
	}

	function clearRefusal(map: Record<string, string>, id: string): Record<string, string> {
		return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
	}

	// Checkbox presses edit only the local draft — instant, silent, reversible
	// by re-pressing or Discard. Apply commits the session as one reviewed act.

	function toggleIncluded(view: RowView) {
		if (!draft || pending) return;
		const id = view.row.field.id;
		refusals = clearRefusal(refusals, id);
		const excluded = new Set(draft.excludedFieldIds);
		if (view.included) excluded.add(id);
		else excluded.delete(id);
		draft = { ...draft, excludedFieldIds: [...excluded] };
	}

	function toggleRequired(view: RowView) {
		if (!draft || pending) return;
		const id = view.row.field.id;
		const next = !view.required;
		const registryDefault = view.row.field.required.apply === true;
		const overrides = { ...draft.requiredOverrides };
		// Matching the shared default clears the override instead of pinning it,
		// so "overridden" always means "differs".
		if (next === registryDefault) delete overrides[id];
		else overrides[id] = next;
		draft = { ...draft, requiredOverrides: overrides };
	}

	function clearRequiredOverride(view: RowView) {
		if (!draft || pending) return;
		const overrides = { ...draft.requiredOverrides };
		delete overrides[view.row.field.id];
		draft = { ...draft, requiredOverrides: overrides };
	}

	function toggleOption(view: RowView, optionId: string) {
		if (!draft || pending || !view.options) return;
		const id = view.row.field.id;
		const nextIds = view.options
			.filter((option) => (option.id === optionId ? !option.exposed : option.exposed))
			.map((option) => option.id);
		if (nextIds.length === 0) {
			// The refusal states itself at the attempt, before anything commits.
			refusals = {
				...refusals,
				[id]: 'A choice question needs at least one option — hide the question instead'
			};
			return;
		}
		refusals = clearRefusal(refusals, id);
		draft = { ...draft, optionExposure: { ...draft.optionExposure, [id]: nextIds } };
	}

	function offerAll(view: RowView) {
		if (!draft || pending || view.exposureAll) return;
		refusals = clearRefusal(refusals, view.row.field.id);
		const exposure = { ...draft.optionExposure };
		delete exposure[view.row.field.id];
		draft = { ...draft, optionExposure: exposure };
	}

	/** Drafts the standard application; Apply is still the act that commits it. */
	function resetToStandard() {
		if (!draft || pending) return;
		refusals = {};
		draft = { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} };
	}

	/** Drops every unapplied tick and returns to the stored truth. */
	function discardDraft() {
		if (!form || pending) return;
		refusals = {};
		draft = structuredClone($state.snapshot(form.composition)) as FormComposition;
	}

	// -----------------------------------------------------------------------
	// Reordering. Order is the one registry's user-owned order (the same fact
	// Settings shows), so a drop commits immediately through `port.fields.move`
	// with its own receipt — arrangement is not composition, and the Apply bar
	// never gates it. The checklist hides non-apply fields, so a drop lands the
	// row immediately before its visible successor; hidden onboarding fields
	// between two rows never split a drop.

	const rowDrag = createRowDrag({
		rowSelector: '.qrow',
		onMove: (from, to) => void moveRow(from, to)
	});

	async function moveRow(from: number, to: number) {
		if (pending || !rows) return;
		const flat = segments.flatMap((segment) => segment.rows);
		const view = flat[from];
		if (!view || from === to) return;
		const others = flat.filter((_, index) => index !== from);
		const fieldId = view.row.field.id;
		const fieldLabel = view.row.field.label;
		const fromPosition = view.row.field.position;
		let target: number;
		if (to >= others.length) {
			const lastPosition = others[others.length - 1].row.field.position;
			target = (lastPosition > fromPosition ? lastPosition - 1 : lastPosition) + 1;
		} else {
			const successor = others[to].row.field.position;
			target = successor > fromPosition ? successor - 1 : successor;
		}
		// The checklist lands where the row was dropped now; commit and reload
		// confirm it against the stored order.
		const nextRows = rows.filter((row) => row !== view.row);
		const insertAt = to >= others.length ? nextRows.length : nextRows.indexOf(others[to].row);
		nextRows.splice(insertAt, 0, view.row);
		rows = nextRows;
		begin(`move-${fieldId}`);
		const outcome = await port.fields.move(fieldId, target);
		if (outcome.ok) {
			await reloadAll();
			const neighbor = to >= others.length ? null : others[to].row.field.label;
			const said = neighbor
				? `Moved “${fieldLabel}” before “${neighbor}”`
				: `Moved “${fieldLabel}” to the end`;
			message = said;
			recordAction({
				area: 'forms',
				label: said,
				undo: async () => {
					await port.fields.move(fieldId, fromPosition);
					await reloadAll();
				}
			});
		} else {
			await reloadAll();
			message = outcome.reason;
		}
		pending = '';
		await tick();
		document.getElementById(`grip-${fieldId}`)?.focus();
	}

	async function applyDraft() {
		if (!form || !draft || pending || pendingCount === 0) return;
		const target = form;
		const changes = pendingCount;
		const next = structuredClone($state.snapshot(draft)) as FormComposition;
		begin('apply');
		const outcome = await port.forms.setComposition(target.id, next);
		if (outcome.ok) {
			await reloadAll({ resetDraft: true });
			const said = `Applied ${changes} question ${changes === 1 ? 'change' : 'changes'} to ${target.name}`;
			message = said;
			recordAction({
				area: 'forms',
				label: said,
				notUndoableReason: 'Edit the current questions and apply another change'
			});
		} else {
			message = outcome.reason;
		}
		pending = '';
	}

	// -----------------------------------------------------------------------
	// Intake: the close date and the lifecycle move live together under the
	// header. Both are single-field edits, so each commits immediately with its
	// own receipt — no draft session, no Apply bar.

	async function saveClosing(next: string) {
		if (!form || pending) return;
		const target = form;
		const prior = target.closesAt ?? null;
		const value = next || null;
		if (value === prior) return;
		begin('closing');
		const outcome = await port.forms.setClosing(target.id, value);
		if (outcome.ok) {
			await reloadAll();
			const said = value
				? `“${target.name}” now closes ${formatCloseDate(value)}`
				: `Removed the close date — “${target.name}” stays open until you close it`;
			message = said;
			recordAction({
				area: 'forms',
				label: said,
				notUndoableReason: 'Edit the current close date and apply another change'
			});
		} else {
			message = outcome.reason;
		}
		pending = '';
	}

	async function changeStatus(status: 'open' | 'closed') {
		if (!form || pending) return;
		const target = form;
		if (target.status === 'draft') return;
		begin('lifecycle');
		const outcome = await port.forms.setStatus(target.id, status);
		if (outcome.ok) {
			await reloadAll();
			const said =
				status === 'open'
					? `Reopened “${target.name}” — it accepts applications again`
					: `Closed “${target.name}” — on-time editing is locked; late arrivals join the late tray`;
			message = said;
			recordAction({
				area: 'forms',
				label: said,
				undo: async () => {
					await port.forms.setStatus(target.id, status === 'closed' ? 'open' : 'closed');
					await reloadAll();
				}
			});
		} else {
			message = outcome.reason;
		}
		pending = '';
	}

	async function preparePublication() {
		if (!form || pending || form.status !== 'draft') return;
		begin('publish-review');
		const prepared = await port.forms.preparePublish(form.id);
		pending = '';
		if (!prepared.ok) {
			message = prepared.reason;
			return;
		}
		publishReview = prepared.review;
		publishError = '';
		publishReviewOpen = true;
	}

	function cancelPublication() {
		publishReviewOpen = false;
		publishReview = null;
		publishError = '';
	}

	async function confirmPublication() {
		if (!publishReview || pending) return;
		begin('publish');
		const review = publishReview;
		const outcome = await port.forms.publish(review);
		pending = '';
		if (!outcome.ok) {
			publishError = outcome.reason;
			return;
		}
		cancelPublication();
		await reloadAll();
		const said = `Published and opened “${review.formName}”`;
		message = said;
		recordAction({ area: 'forms', label: said,
			notUndoableReason: 'Close the Form if it must stop accepting applications' });
	}

	/** A question scoped to this form is removed from the registry — it exists nowhere else. */
	async function removeScoped(view: RowView) {
		if (pending || !form) return;
		const keep = $state.snapshot(view.row.field) as RegistryField;
		const index = keep.position;
		begin(`remove-${keep.id}`);
		refusals = clearRefusal(refusals, keep.id);
		const outcome = await port.fields.remove(keep.id);
		if (outcome.ok) {
			await reloadAll();
			recordAction({
				area: 'forms',
				label: `Removed the “${keep.label}” question`,
				undo: async () => {
					await port.fields.restore(keep, index);
					await reloadAll();
				}
			});
		} else {
			refusals = { ...refusals, [keep.id]: outcome.reason };
			message = outcome.reason;
		}
		pending = '';
	}

	// -----------------------------------------------------------------------
	// Add a question only this form asks. It registers in the one registry with
	// this form's scope — answers land on the person/talk like any other field —
	// and the placement advisor picks where it enters.

	let newKind = $state<FieldKind>('text');
	let newLabel = $state('');
	let newHelp = $state('');
	let newOptions = $state('');

	const optionsNeeded = $derived(newKind === 'select' || newKind === 'multiselect');
	const parsedOptions = $derived(
		newOptions
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
	);
	const addReady = $derived(
		newLabel.trim().length > 0 && (!optionsNeeded || parsedOptions.length > 0)
	);

	async function addScoped(event: SubmitEvent) {
		event.preventDefault();
		if (!addReady || pending || !form) return;
		const target = form;
		begin('add');
		const { field, placement } = await port.fields.add({
			kind: newKind,
			label: newLabel.trim(),
			...(newHelp.trim() ? { help: newHelp.trim() } : {}),
			...(optionsNeeded ? { options: parsedOptions } : {}),
			collectAt: ['apply'],
			formScope: target.id
		});
		await reloadAll();
		placedId = field.id;
		placedReason = placement.reason;
		message = `Added “${field.label}”. ${placement.reason}`;
		recordAction({
			area: 'forms',
			label: `Added the “${field.label}” question to ${target.name}`,
			undo: async () => {
				await port.fields.remove(field.id);
				await reloadAll();
			}
		});
		newKind = 'text';
		newLabel = '';
		newHelp = '';
		newOptions = '';
		pending = '';
		await tick();
		document.getElementById(`form-question-${field.id}`)?.scrollIntoView({ block: 'nearest' });
	}

	const previewHref = $derived(
		surfaceId && formId
			? `/app/templates?tab=surfaces&template=${surfaceId}&form=${formId}`
			: null
	);

	/** Where the application page publishes — the same door Preview opens. */
	const surfaceEditorHref = $derived(
		surfaceId ? `/app/templates?tab=surfaces&template=${surfaceId}` : null
	);
</script>

{#snippet publicationWarning(title: string, message: string)}
	<div class="conf__address-warn">
		<Alert tone="warning" {title} {message} />
		{#if surfaceEditorHref}
			<a class="ui-button ui-button--secondary ui-button--sm" href={surfaceEditorHref}>
				Publish the page in Templates
			</a>
		{/if}
	</div>
{/snippet}

{#if formId}
	<!-- ================= One form's questions ================= -->
	<div class="conf" aria-busy={!rows && !missingForm}>
		<a
			class="conf__back"
			href="/app/forms"
			onclick={(event) => {
				event.preventDefault();
				void clearParams(['form'], { history: 'push' });
			}}>
			<ArrowLeft size={14} aria-hidden="true" /> All forms
		</a>

		{#if missingForm}
			<section class="card conf__missing">
				<p class="conf__missing-title">This form no longer exists.</p>
				<p class="conf__missing-copy">It may have been removed in another tab.</p>
			</section>
		{:else}
			<header class="conf__head">
				<div class="conf__title">
					{#if form}
						{@const target = targetBadge[form.target.kind]}
						{@const Status = statusGlyph[form.status]}
						<h1 class="conf__name">{form.name}</h1>
						<span class="ui-badge ui-badge--{target.tone}">{target.label}</span>
						<span class="conf__status">
							<span class="conf__glyph conf__glyph--{form.status}" aria-hidden="true">
								<Status size={14} />
							</span>
							<span>{statusLabel[form.status]}</span>
						</span>
					{:else}
						<h1 class="conf__name">
							<span class="ui-sr-only">Loading form</span>
							<span class="ui-skeleton sk-line" style="inline-size: 14rem" aria-hidden="true"></span>
						</h1>
					{/if}
				</div>
				<p class="conf__meta">
					{#if form}
						{@const line = targetLine(form.target)}
						{#if line}{line} · {/if}Version {form.version} ·
						{countLabel(form.submissionCount, 'submission')} ·
						{countLabel(form.fieldCount, 'question')}
					{:else}
						<span class="ui-skeleton sk-line" style="inline-size: 16rem"></span>
					{/if}
				</p>
				<!-- Intake: when the door shuts, and the one lifecycle move. The
				     labels and geometry stand before data; only the value-carrying
				     controls wait for it. -->
				<div class="conf__intake">
					<Field
						id="form-closes"
						label="Closes"
						optional
						description="On-time editing locks at close; late arrivals land in the late tray. Empty — the form stays open until you close it.">
						{#snippet children({ id, describedBy })}
							<div class="conf__closes">
								{#if form}
									<DatePicker
										{id}
										{describedBy}
										label="close date"
										min={todayIso}
										disabled={pending !== ''}
										value={form.closesAt ?? ''}
										onchange={(value) => void saveClosing(value)} />
									{#if form.closesAt}
										<!-- Quiet danger: removing the close date is consequential —
										     the form then stays open until somebody closes it by
										     hand — but it is not this region's primary, which is the
										     date itself. A ghost control understated the consequence;
										     a filled red one would have taken the region's one
										     accent-dominant slot from the lifecycle commit beside it.
										     Filled danger stays inside confirming dialogs. -->
										<Button
											variant="danger-quiet"
											size="sm"
											disabled={pending !== ''}
											onclick={() => void saveClosing('')}>
											Remove close date
										</Button>
									{/if}
								{:else}
									<span
										class="ui-skeleton sk-action"
										style="inline-size: 11rem"
										aria-hidden="true"></span>
								{/if}
							</div>
						{/snippet}
					</Field>
					<div class="conf__lifecycle">
						{#if form}
							{#if form.status === 'draft'}
								<Button
									size="sm"
									loading={pending === 'lifecycle'}
									disabled={pending !== '' && pending !== 'lifecycle'}
									onclick={() => void preparePublication()}>
									Publish and open
								</Button>
							{:else if form.status === 'open'}
								<Button
									variant="secondary"
									size="sm"
									loading={pending === 'lifecycle'}
									disabled={pending !== '' && pending !== 'lifecycle'}
									onclick={() => void changeStatus('closed')}>
									Close form
								</Button>
							{:else}
								<Button
									variant="secondary"
									size="sm"
									loading={pending === 'lifecycle'}
									disabled={pending !== '' && pending !== 'lifecycle'}
									onclick={() => void changeStatus('open')}>
									Reopen form
								</Button>
							{/if}
						{:else}
							<span class="ui-skeleton sk-action" aria-hidden="true"></span>
						{/if}
					</div>
				</div>
				<!-- The two releases behind one address, read together: the form's
				     own publication (badged in the title) and the application
				     page's. An address is live only when both stand, and the trap
				     this block exists to prevent is sharing a URL that fail-closes. -->
				<div class="conf__address">
					<p class="conf__address-label" id="conf-address-label">Public address</p>
					{#if !form || surfacePublication === undefined}
							<!-- The resolved composition's own two lines (address, then its
							     state sentence) with skeleton fills, so resolution cannot
							     move the questions below — a drag in flight would land a
							     row off if this region grew under it. -->
							<p class="conf__address-line" aria-busy="true">
								<span class="ui-skeleton sk-line" style="inline-size: 18rem" aria-hidden="true"
								></span>
							</p>
							<p class="conf__address-note" aria-busy="true">
								<span class="ui-skeleton sk-line" style="inline-size: 24rem" aria-hidden="true"
								></span>
							</p>
					{:else if surfacePublication === null}
						<p class="conf__address-line">Publication status couldn’t be checked.</p>
						<p class="conf__address-note">Reload this page to check again.</p>
					{:else if form.status === 'draft'}
						<p class="conf__address-note">
							Not live yet — this form hasn’t been published and opened.
						</p>
						<p class="conf__address-note">Publish and open it when it is ready.</p>
					{:else if surfacePublication.kind === 'none'}
						{@render publicationWarning(
							'The application page isn’t published',
							'This form’s address turns visitors away until the page is published.'
						)}
					{:else if publicationMismatch(form.id)}
						{@render publicationWarning(
							'The application page is published for a different form',
							'This address turns visitors away until the page is published for this form.'
						)}
					{:else if publicationServes(form.id)}
							{@const address = publicAddress(form.id)}
							<p class="conf__address-line">
								<a
									class="conf__address-url"
									href={address}
									target="_blank"
									rel="noopener"
									aria-describedby="conf-address-label">{address}</a>
								<CopyValue value={address} label="Copy the public address" />
							</p>
							<p class="conf__address-note">
								{#if form.status === 'open'}
									The application page is published — this address takes applications.
								{:else}
									<!-- The weakest sentence true on every composition: the live
									     lane serves a closed form's address as an absent page,
									     while the sample lane still shows its questions. -->
									Closed — this address no longer accepts applications.
								{/if}
							</p>
					{/if}
				</div>
				<div class="conf__actions">
					{#if previewHref}
						<a class="ui-button ui-button--secondary ui-button--sm" href={previewHref}>
							Preview this form
						</a>
					{/if}
					<!-- The split taught where it applies: questions here, look there. -->
					<p class="conf__split">
						This page decides what’s asked. How it looks — wording, sections, brand — lives with
						the application surface, where the preview opens.
					</p>
				</div>
			</header>

			<section class="panel" aria-label="Questions">
				<header class="panel__head">
					<div class="panel__title">
						<h2>Questions</h2>
						<p class="ui-sr-only" role="status">{message}</p>
					</div>
					<p class="panel__note">
						Tick a question to ask it on this form; nothing changes until you apply. Unticking never
						deletes — the question and any answers stay, and other forms keep asking it.
					</p>
				</header>

				{#if !rows}
					<ul class="qrows" aria-hidden="true">
						{#each Array(8) as _row, rowIndex (rowIndex)}
							<li class="qrow">
								<div class="qrow__line">
									<span class="ui-skeleton sk-box"></span>
									<span class="qrow__name"
										><span class="ui-skeleton sk-line" style="inline-size: 10rem"></span></span>
									<span class="ui-skeleton sk-action"></span>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<div class="qgroups" use:rowDrag.container>
						{#each segments as segment (segment.key)}
							{@const asked = segment.rows.filter((row) => row.included).length}
							<h3 class="qgroup__label" id={`qgroup-${segment.key}`}>
								{groupHeadings[segment.group]}
								<span class="qgroup__count">{asked} of {segment.rows.length} asked</span>
							</h3>
							<ul class="qrows" aria-labelledby={`qgroup-${segment.key}`}>
								{#each segment.rows as view (view.row.field.id)}
									{@const field = view.row.field}
									{@const refusal = refusals[field.id] ?? ''}
									{@const scoped = field.formScope === formId}
									<li
										class="qrow"
										id={`form-question-${field.id}`}
										animate:flip={{ duration: motionMs('normal') }}>
										<div class="qrow__line">
											{#if scoped}
												<!-- A question that exists only on this form is not
												     tickable off — it is removable, below. -->
												<span class="qrow__gap" aria-hidden="true"></span>
											{:else if field.locked}
												<Checkbox
													label={`Ask “${field.label}” on this form`}
													hideLabel
													checked
													disabled />
											{:else}
												<Checkbox
													label={`Ask “${field.label}” on this form`}
													hideLabel
													checked={view.included}
													disabled={pending === 'apply'}
													onchange={() => toggleIncluded(view)} />
											{/if}
											<span class="qrow__name" class:qrow__name--off={!view.included}>
												<span class="qrow__label">{field.label}</span>
												{#if field.locked}
													<span class="qrow__lock" role="img" aria-label="Locked">
														<Lock size={12} aria-hidden="true" />
													</span>
												{/if}
												<span class="ui-badge ui-badge--neutral qrow__kind"
													>{kindLabels[field.kind]}</span>
												{#if scoped}
													<span class="ui-badge ui-badge--lavender">Only this form</span>
												{/if}
											</span>
											<span class="qrow__controls">
												{#if view.included}
													<Checkbox
														label="Required"
														checked={view.required}
														disabled={pending === 'apply'}
														onchange={() => toggleRequired(view)} />
													{#if view.requiredOverridden}
														<button
															type="button"
															class="ui-button ui-button--ghost ui-button--sm"
															disabled={pending === 'apply'}
															onclick={() => clearRequiredOverride(view)}>
															Use shared default
														</button>
													{/if}
												{/if}
												{#if scoped}
													<Button
														variant="ghost"
														size="sm"
														aria-label={`Remove “${field.label}”`}
														disabled={pending !== '' && pending !== `remove-${field.id}`}
														loading={pending === `remove-${field.id}`}
														onclick={() => removeScoped(view)}>Remove</Button>
												{/if}
											</span>
											<button
												type="button"
												id={`grip-${field.id}`}
												class="ui-button ui-button--ghost ui-button--icon ui-button--sm ui-drag-handle qrow__grip"
												aria-label={`Reorder “${field.label}” — drag, or press the arrow keys`}
												disabled={pending !== ''}
												use:rowDrag.handle>
												<GripVertical size={14} aria-hidden="true" />
											</button>
										</div>
										{#if field.locked}
											<p class="qrow__note">
												Email is the application’s key — every form asks it.
											</p>
										{/if}
										{#if view.options && view.included}
											{@const source = sourceNames[field.optionSource ?? 'tracks']}
											{@const offered = view.options.filter((option) => option.exposed).length}
											<div class="qrow__source">
												<p class="qrow__source-line">
													Options come from your {source.plural} ·
													{#if view.exposureAll}
														offering all {view.options.length}, new {source.plural} included
													{:else}
														offering {offered} of {view.options.length} · new {source.plural} stay
														hidden
													{/if}
												</p>
												<button
													type="button"
													class="ui-button ui-button--ghost ui-button--sm"
													aria-expanded={Boolean(openOptions[field.id])}
													onclick={() =>
														(openOptions = {
															...openOptions,
															[field.id]: !openOptions[field.id]
														})}>
													{openOptions[field.id] ? 'Done choosing' : 'Choose options'}
												</button>
												{#if !view.exposureAll}
													<button
														type="button"
														class="ui-button ui-button--ghost ui-button--sm"
														disabled={pending === 'apply'}
														onclick={() => offerAll(view)}>
														Offer all, future ones too
													</button>
												{/if}
											</div>
											{#if openOptions[field.id]}
												<fieldset class="qrow__optlist">
													<legend class="ui-sr-only">
														Options “{field.label}” offers on this form
													</legend>
													{#each view.options as option (option.id)}
														<Checkbox
															label={option.name}
															checked={option.exposed}
															disabled={pending === 'apply'}
															onchange={() => toggleOption(view, option.id)} />
													{/each}
													<a class="qrow__vocab" href="/app/settings/program">
														Manage {source.plural} in Settings
													</a>
												</fieldset>
											{/if}
										{/if}
										{#if placedId === field.id}
											<p class="qrow__placed">{placedReason}</p>
										{/if}
										{#if refusal}
											<p class="qrow__refusal">{refusal}</p>
										{/if}
									</li>
								{/each}
							</ul>
						{/each}
					</div>

					{#if pendingCount > 0}
						<!-- The session's own commit, directly under what it commits. The
						     floating twin below yields the moment this row scrolls into view. -->
						<div class="applyrow" bind:this={applyRowEl}>
							<Button size="sm" loading={pending === 'apply'} onclick={applyDraft}>
								Apply {pendingCount}
								{pendingCount === 1 ? 'change' : 'changes'}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={pending === 'apply'}
								onclick={discardDraft}>
								Discard changes
							</Button>
							<p class="applyrow__note">Nothing is asked differently until you apply.</p>
						</div>
					{/if}

					<form class="composer" onsubmit={addScoped} aria-label="Add a question only this form asks">
						<h3 class="composer__title">Add a question only this form asks</h3>
						<div class="composer__grid">
							<Field id="form-field-kind" label="Kind">
								{#snippet children({ id, describedBy })}
									<select
										class="ui-select"
										{id}
										aria-describedby={describedBy}
										disabled={pending !== ''}
										bind:value={newKind}>
										{#each kindOrder as kind (kind)}
											<option value={kind}>{kindLabels[kind]}</option>
										{/each}
									</select>
								{/snippet}
							</Field>
							<Field id="form-field-label" label="Label">
								{#snippet children({ id, describedBy })}
									<input
										class="ui-control"
										type="text"
										{id}
										aria-describedby={describedBy}
										disabled={pending !== ''}
										bind:value={newLabel} />
								{/snippet}
							</Field>
							<div class="composer__wide">
								<Field
									id="form-field-help"
									label="Help"
									optional
									description="Short guidance shown beside the question.">
									{#snippet children({ id, describedBy })}
										<input
											class="ui-control"
											type="text"
											{id}
											aria-describedby={describedBy}
											disabled={pending !== ''}
											bind:value={newHelp} />
									{/snippet}
								</Field>
							</div>
							{#if optionsNeeded}
								<div class="composer__wide">
									<Field id="form-field-options" label="Choices" description="One choice per line.">
										{#snippet children({ id, describedBy })}
											<textarea
												class="ui-textarea"
												rows="3"
												{id}
												aria-describedby={describedBy}
												disabled={pending !== ''}
												bind:value={newOptions}></textarea>
										{/snippet}
									</Field>
								</div>
							{/if}
						</div>
						<Button
							type="submit"
							variant="secondary"
							size="sm"
							disabled={!addReady || pending !== ''}
							loading={pending === 'add'}>Add question</Button>
					</form>

					<footer class="panel__foot">
						{#if draftDeviates}
							<!-- Drafts the standard application; Apply above stays the commit. -->
							<Button variant="ghost" size="sm" disabled={pending === 'apply'} onclick={resetToStandard}>
								Reset to the standard application
							</Button>
						{/if}
						<p class="panel__foot-note">
							Shared questions are defined once in
							<a href="/app/settings/program#settings-speaker-fields">Settings → Speaker fields</a> —
							asking or dropping one here changes only this form.
						</p>
					</footer>
				{/if}
			</section>
		{/if}
	</div>
{:else}
	<!-- ================= The form list ================= -->
	<div class="head">
		<!-- The forms' outgoing look lives with the templates: this door opens the
		     shared brand tab rather than growing a second styling surface here. -->
		<a
			class="ui-button ui-button--ghost ui-button--sm"
			href="/app/templates?tab=brand"
			aria-label="Brand &amp; style — Templates">
			Brand &amp; style
		</a>
		<button
			type="button"
			class="ui-button ui-button--primary ui-button--sm head__new"
			aria-haspopup="dialog"
			onclick={() => (newFormOpen = true)}>New form</button>
	</div>

	<section class="list" aria-label="Forms" aria-busy={!forms}>
		{#if !forms}
			<!-- The card's own composition with skeleton fills, so the grid holds the
			     footprint the resolved cards give it. -->
			<div class="cards" aria-hidden="true">
				{#each Array(3) as _, index (index)}
					<article class="card">
						<div class="card__head">
							<p class="card__name"><span class="ui-skeleton sk-line" style="inline-size: 9rem"></span></p>
							<span class="ui-skeleton sk-chip"></span>
						</div>
						<p class="card__status"><span class="ui-skeleton sk-line" style="inline-size: 8rem"></span></p>
						<p class="card__meta"><span class="ui-skeleton sk-line" style="inline-size: 12rem"></span></p>
						<div class="card__actions">
							<span class="ui-skeleton sk-action"></span>
							<span class="ui-skeleton sk-action"></span>
						</div>
					</article>
				{/each}
			</div>
		{:else if forms.length === 0}
			<div class="empty">
				<h2 class="empty__title">No forms yet</h2>
				<p class="empty__copy">
					Open your call for proposals (CFP) by starting from the standard application — a
					complete form, already arranged, that you trim to fit.
				</p>
				<button
					type="button"
					class="ui-button ui-button--primary ui-button--sm"
					aria-haspopup="dialog"
					onclick={() => (newFormOpen = true)}>New form</button>
			</div>
		{:else}
			<!-- One cause shared by every open card is said once, above them: the
			     application page all these addresses render through isn't
			     published, so no address is live whatever the cards say. -->
			{#if surfacePublication?.kind === 'none' && forms.some((entry) => entry.status === 'open')}
				<div class="list__warn">
					{@render publicationWarning(
						'The application page isn’t published',
						'Open forms have public addresses, but the page they render isn’t published — every address turns visitors away.'
					)}
				</div>
			{:else if pinnedFormId
				&& forms.some((entry) => entry.status === 'open' && entry.id !== pinnedFormId)}
				<div class="list__warn">
					{@render publicationWarning(
						'The application page serves only one open form',
						'Other open-form addresses turn visitors away until the page is published for them.'
					)}
				</div>
			{/if}
			<div class="cards">
				{#each forms as form (form.id)}
					{@const target = targetBadge[form.target.kind]}
					{@const line = targetLine(form.target)}
					{@const Status = statusGlyph[form.status]}
					<article class="card">
						<div class="card__head">
							<h2 class="card__name">{form.name}</h2>
							<span class="ui-badge ui-badge--{target.tone}">{target.label}</span>
						</div>
						{#if line}
							<p class="card__target">{line}</p>
						{/if}
						<p class="card__status">
							<span class="card__glyph card__glyph--{form.status}" aria-hidden="true"
								><Status size={14} /></span
							>
							{statusLabel[form.status]}
							{#if form.status === 'open'}
								{#if form.closesAt}
									· <span class="card__closes">{closesLabel(form.closesAt)}</span>
								{:else}
									· <span class="card__rolling">no close date</span>
								{/if}
							{/if}
						</p>
						<p class="card__meta">
							Version {form.version} · {countLabel(form.submissionCount, 'submission')} · {countLabel(
								form.fieldCount,
								'question'
							)}
						</p>
						<div class="card__actions">
							<a
								class="ui-button ui-button--secondary ui-button--sm"
								href={`/app/forms?form=${form.id}`}
								onclick={(event) => {
									event.preventDefault();
									void applyParams({ form: form.id }, { history: 'push' });
								}}>Questions</a>
							{#if surfaceId}
								<a
									class="ui-button ui-button--secondary ui-button--sm"
									href={`/app/templates?tab=surfaces&template=${surfaceId}&form=${form.id}`}>
									Preview
								</a>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	<p class="mix">
		One event can run several forms at the same time: an open call, a pool for a track or format
		that has no day yet, and a proposal form for one specific session. Each form carries its own
		target and close date — a form without one stays open until you close it — and accepted
		submissions follow the target.
	</p>
{/if}

<Modal bind:open={newFormOpen} title="New form">
	<form class="newform" onsubmit={createForm} aria-label="New form">
		<p class="newform__copy">
			Every new form starts as the standard application — the classic call for proposals (CFP),
			complete and arranged — and you trim it to fit on the questions page this lands on.
		</p>
		<Field id="new-form-name" label="Name">
			{#snippet children({ id, describedBy })}
				<input
					class="ui-control"
					type="text"
					{id}
					aria-describedby={describedBy}
					placeholder="e.g. Lightning talk applications"
					disabled={creating}
					bind:value={newName} />
			{/snippet}
		</Field>
		<Field id="new-form-target" label="Collects for" description="Where accepted submissions go.">
			{#snippet children({ id, describedBy })}
				<DescribedSelect
					{id}
					{describedBy}
					label="Collects for"
					options={targetOptions}
					disabled={creating}
					value={newTargetKind}
					onchange={chooseTargetKind} />
			{/snippet}
		</Field>
		{#if newTargetKind === 'category'}
			<Field id="new-form-category" label="Which track or format">
				{#snippet children({ id, describedBy })}
					<select
						class="ui-select"
						{id}
						aria-describedby={describedBy}
						disabled={creating}
						bind:value={newCategoryRef}>
						{#if activeTracks.length > 0}
							<optgroup label="Tracks">
								{#each activeTracks as track (track.id)}
									<option value={`track:${track.id}`}>{track.name}</option>
								{/each}
							</optgroup>
						{/if}
						{#if activeFormats.length > 0}
							<optgroup label="Formats">
								{#each activeFormats as format (format.id)}
									<option value={`format:${format.id}`}>{format.name}</option>
								{/each}
							</optgroup>
						{/if}
					</select>
				{/snippet}
			</Field>
		{:else if newTargetKind === 'session'}
			<Field
				id="new-form-session"
				label="Which session"
				description="Sessions currently collecting proposals.">
				{#snippet children({ id, describedBy })}
					<select
						class="ui-select"
						{id}
						aria-describedby={describedBy}
						disabled={creating}
						bind:value={newSessionId}>
						{#each collectingSessions as session (session.id)}
							<option value={session.id}>{session.title}</option>
						{/each}
					</select>
				{/snippet}
			</Field>
		{/if}
		<Field
			id="new-form-closes"
			label="Closes"
			optional
			description="Leave empty for no close date — the form stays open until you close it.">
			{#snippet children({ id, describedBy })}
				<DatePicker
					{id}
					{describedBy}
					label="close date"
					min={todayIso}
					disabled={creating}
					bind:value={newClosesAt} />
			{/snippet}
		</Field>
	</form>

	{#snippet footer(close: () => void)}
		<Button variant="ghost" size="sm" disabled={creating} onclick={close}>Cancel</Button>
		<Button size="sm" disabled={!createReady} loading={creating} onclick={() => void createForm()}>
			Create form
		</Button>
	{/snippet}
</Modal>

{#if formId && rows}
	<!-- The floating twin of the Apply row: present while unapplied ticks exist
	     and the in-flow row is out of view, so the commit is always one press
	     away without scrolling. Class-driven transform/opacity on tokens; the
	     exit rides the faster tier; reduced motion zeroes both. -->
	<div class="applybar" class:applybar--in={showFloatingApply} inert={!showFloatingApply}>
		<p class="applybar__count">
			{pendingCount}
			{pendingCount === 1 ? 'change' : 'changes'} not applied
		</p>
		<Button size="sm" loading={pending === 'apply'} onclick={applyDraft}>Apply</Button>
		<Button variant="ghost" size="sm" disabled={pending === 'apply'} onclick={discardDraft}>
			Discard
		</Button>
	</div>
{/if}

<Modal bind:open={publishReviewOpen} title="Review publication">
	{#if publishReview}
		<div class="publish-review">
			<p>Nothing has changed yet. Confirm what will be published and opened.</p>
			<dl>
				<div><dt>Form</dt><dd>{publishReview.formName}</dd></div>
				<div><dt>Action</dt><dd>Publish and open</dd></div>
				<div><dt>Version</dt><dd>{publishReview.versionNumber}</dd></div>
				<div><dt>Resulting state</dt><dd>Open</dd></div>
				<div><dt>Application surfaces updated</dt><dd>{publishReview.surfaceSuccessorCount}</dd></div>
			</dl>
			<p class="publish-error" role="status">{publishError}</p>
		</div>
	{/if}
	{#snippet footer(_close: () => void)}
		<Button variant="ghost" disabled={pending !== ''} onclick={cancelPublication}>Cancel</Button>
		<Button loading={pending === 'publish'} disabled={pending !== '' || !publishReview}
			onclick={() => void confirmPublication()}>Publish and open</Button>
	{/snippet}
</Modal>

<CommitReceipt onUndone={() => reloadAll()} />

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--je-space-2);
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
		gap: var(--je-space-4);
	}

	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a chip is badge-height, an action
	   is control-height. Free-standing sized rectangles drift; these cannot. */
	.sk-line {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.sk-chip {
		display: inline-block;
		align-self: center;
		block-size: 1.35rem;
		inline-size: 5rem;
	}

	.sk-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 4.5rem;
		border-radius: var(--je-radius-control);
	}

	.sk-box {
		display: inline-block;
		inline-size: 1.0625rem;
		block-size: 1.0625rem;
		border-radius: 3px;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
		min-block-size: 9.5rem;
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.card__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2);
	}

	.card__name {
		margin: 0;
		flex: 1 1 10rem;
		min-inline-size: 0;
		font-size: var(--je-font-size-base);
		font-weight: 600;
		line-height: var(--je-leading-snug);
	}

	/* The reference the badge points at — one line, at the ink of a fact. */
	.card__target {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.card__status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
		margin: 0;
		font-size: var(--je-font-size-md);
	}

	/* Replaces the former status dot. A dot could only say "there is a state";
	   the glyph says which one, so the word beside it is confirmed rather than
	   decoded. Open is the only status that earns status ink — closed and draft
	   are ordinary facts, not conditions needing a response. */
	.card__glyph {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		color: var(--je-color-text-subtle);
	}

	.publish-review { display: grid; gap: var(--je-space-4); }
	.publish-review > p { margin: 0; color: var(--je-color-text-muted); }
	.publish-review dl { display: grid; gap: var(--je-space-2); margin: 0; }
	.publish-review dl div { display: grid; grid-template-columns: minmax(10rem, .45fr) minmax(0, 1fr); gap: var(--je-space-3); }
	.publish-review dt { color: var(--je-color-text-muted); }
	.publish-review dd { margin: 0; overflow-wrap: anywhere; }
	.publish-error { min-block-size: 1.25rem; color: var(--je-color-danger) !important; }
	@media (max-width: 36rem) {
		.publish-review dl div { grid-template-columns: 1fr; gap: var(--je-space-1); }
	}

	.card__glyph--open {
		color: var(--je-color-success);
	}

	.card__closes {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	.card__rolling {
		color: var(--je-color-text-muted);
	}

	.card__meta {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: auto;
	}

	.empty {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		min-block-size: 9.5rem;
		align-content: center;
		padding: var(--je-space-8);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.empty__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.empty__copy {
		margin: 0;
		max-inline-size: 52ch;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.mix {
		margin: 0;
		max-inline-size: 78ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.newform {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
	}

	.newform__copy {
		margin: 0;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	/* ================= Configurator ================= */

	.conf {
		display: grid;
		gap: var(--je-space-4);
	}

	.conf__back {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		justify-self: start;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
		text-decoration: none;
	}

	.conf__back:hover {
		color: var(--je-color-text);
		text-decoration: underline;
	}

	.conf__head {
		display: grid;
		gap: var(--je-space-2);
	}

	.conf__title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.conf__name {
		margin: 0;
		font-size: var(--je-font-size-xl);
		font-weight: 650;
		line-height: var(--je-leading-snug);
	}

	.conf__status {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.conf__glyph {
		display: grid;
		place-items: center;
		color: var(--je-color-text-subtle);
	}

	.conf__glyph--open {
		color: var(--je-color-success);
	}

	.conf__meta {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* The close date and the lifecycle move share one row: they are the two
	   halves of "when is this door open". The lifecycle control aligns with the
	   date control, not the field's label line. */
	.conf__intake {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--je-space-3) var(--je-space-6);
		margin-block-start: var(--je-space-2);
	}

	.conf__closes {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
	}

	.conf__lifecycle {
		display: flex;
		align-items: center;
		min-block-size: var(--je-control-height);
	}

	.conf__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-4);
	}

	/* One address, two release records: label as the quiet question, the URL
	   or the reason it is not live as the answer beneath it. */
	.conf__address {
		display: grid;
		gap: var(--je-space-1);
		justify-items: start;
		margin-block-start: var(--je-space-2);
	}

	.conf__address-label {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		line-height: var(--je-leading-snug);
	}

	.conf__address-line {
		margin: 0;
		display: flex;
		align-items: center;
		gap: var(--je-space-1);
		min-inline-size: 0;
		max-inline-size: 100%;
	}

	/* A live address navigates, so it reads as a link; long hosts wrap rather
	   than widening the page. */
	.conf__address-url {
		min-inline-size: 0;
		overflow-wrap: anywhere;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-link);
	}

	.conf__address-note {
		margin: 0;
		max-inline-size: 58ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.conf__address-warn,
	.list__warn {
		display: grid;
		gap: var(--je-space-2);
		justify-items: start;
	}

	/* The list section carries no own gap; the shared-cause notice keeps a
	   group boundary from the cards it speaks for. */
	.list__warn {
		margin-block-end: var(--je-space-4);
	}

	.conf__split {
		margin: 0;
		max-inline-size: 58ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.conf__missing {
		padding: var(--je-space-6);
	}

	.conf__missing-title {
		margin: 0 0 var(--je-space-1);
		font-weight: 600;
	}

	.conf__missing-copy {
		margin: 0;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
	}

	.card {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: grid;
		gap: var(--je-space-2);
		margin-block-end: var(--je-space-4);
	}

	.panel__title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.panel__note {
		margin: 0;
		max-inline-size: 62ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.qgroups {
		/* The drag slot indicator positions against this box. */
		position: relative;
		display: grid;
		gap: var(--je-space-3);
	}

	/* Quiet running heads: the grouping annotates the registry's order, and the
	   asked-count makes each group's coverage legible at a glance. */
	.qgroup__label {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-3);
		margin: 0;
		font-size: var(--je-font-size-2xs);
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-subtle);
	}

	.qgroup__count {
		font-weight: 500;
		text-transform: none;
		letter-spacing: normal;
		font-variant-numeric: tabular-nums;
	}

	.qrows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.qrow {
		padding-block: var(--je-space-1);
		border-block-end: 1px solid var(--je-color-border-subtle);
	}

	.qrow__line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-3);
	}

	/* Holds the checkbox column for rows that have no checkbox, so labels align. */
	.qrow__gap {
		inline-size: 1.0625rem;
		flex-shrink: 0;
	}

	.qrow__name {
		display: inline-flex;
		flex: 1 1 12rem;
		align-items: center;
		gap: var(--je-space-2);
		min-inline-size: 0;
		font-size: var(--je-font-size-md);
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	/* An unasked question stays present and legible — it is one tick from being
	   asked — but recedes so the form's actual shape reads at a glance. */
	.qrow__name--off .qrow__label {
		color: var(--je-color-text-muted);
	}

	.qrow__lock {
		display: inline-flex;
		color: var(--je-color-text-subtle);
	}

	.qrow__controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin-inline-start: auto;
		order: 5;
	}

	/* The grab handle sits at the line's end — on a phone that is the thumb's
	   corner, and the controls wrap to their own line beneath it. */
	.qrow__grip {
		order: 10;
	}

	.qrow__req {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* A standing fact, at the ink of a fact, not a warning. */
	.qrow__note {
		margin: 2px 0 0;
		padding-inline-start: calc(1.0625rem + var(--je-space-3));
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-subtle);
	}

	.qrow__source {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		margin-block-start: 2px;
		padding-inline-start: calc(1.0625rem + var(--je-space-3));
	}

	.qrow__source-line {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.qrow__optlist {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
		margin: var(--je-space-2) 0 var(--je-space-1) calc(1.0625rem + var(--je-space-3));
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.qrow__vocab {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The advisor's reason is context for one arrival; the next action retires it. */
	.qrow__placed {
		margin: 2px 0 0;
		padding-inline-start: calc(1.0625rem + var(--je-space-3));
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* A refused attempt is an event: it states its reason on the row it belongs
	   to and stays until the next attempt. */
	.qrow__refusal {
		margin: 2px 0 0;
		padding-inline-start: calc(1.0625rem + var(--je-space-3));
		font-size: var(--je-font-size-sm);
		font-weight: 650;
		color: var(--je-color-danger);
	}

	.composer {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		max-inline-size: 52rem;
		margin-block-start: var(--je-space-4);
	}

	.composer__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.composer__grid {
		display: grid;
		grid-template-columns: 12rem minmax(0, 1fr);
		gap: var(--je-space-3);
		inline-size: 100%;
	}

	.composer__wide {
		grid-column: 1 / -1;
	}

	.applyrow {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		margin-block-start: var(--je-space-4);
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.applyrow__note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The floating commit affordance. The hidden state owns the exit timing
	   (the faster tier), the shown state the entrance — leaving feels lighter
	   than arriving, and the zeroed tokens still reduced motion entirely. */
	.applybar {
		position: fixed;
		inset-block-end: var(--je-space-4);
		inset-inline-end: var(--je-space-4);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		padding: var(--je-space-2) var(--je-space-3);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-md);
		opacity: 0;
		transform: translateY(0.5rem);
		pointer-events: none;
		transition:
			opacity var(--je-duration-fast) var(--je-ease),
			transform var(--je-duration-fast) var(--je-ease);
	}

	.applybar--in {
		opacity: 1;
		transform: none;
		pointer-events: auto;
		transition:
			opacity var(--je-duration-normal) var(--je-ease-out),
			transform var(--je-duration-normal) var(--je-ease-out);
	}

	.applybar__count {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
	}

	.panel__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-start: var(--je-space-4);
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.panel__foot-note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.panel__foot-note a {
		color: inherit;
	}

	@media (max-width: 920px) {
		.head__new {
			inline-size: 100%;
		}

		.cards {
			grid-template-columns: 1fr;
		}

		.empty {
			padding: var(--je-space-6) var(--je-space-4);
		}

		.composer__grid {
			grid-template-columns: 1fr;
		}

		.qrow__controls {
			margin-inline-start: calc(1.0625rem + var(--je-space-3));
			inline-size: 100%;
			order: 20;
		}

		.applybar {
			inset-inline-start: var(--je-space-3);
			inset-inline-end: var(--je-space-3);
			justify-content: space-between;
		}
	}
</style>
