<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ChevronDown, TriangleAlert } from 'lucide-svelte';
	import {
		CopyValue,
		revealTarget,
		shouldIgnoreRowPress,
		situationIcon,
		statusIcon
	} from '$lib/ui';
	import type { SpeakersPagePort } from '$lib/api/speakers-page-port';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import { applyParams, clearParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import SpeakerCommunications from './SpeakerCommunications.svelte';
	import SpeakerLineup from './SpeakerLineup.svelte';
	import {
		assignmentStateBadge,
		engagementStateBadge,
		overdueBadge
	} from './engagement-vocabulary';
	import { speakerRecordHref } from '$lib/api/speaker-record';
	import type { SpeakerRow, TaskAssignment, TaskDef } from '$lib/api/types';

	interface Props {
		port: SpeakersPagePort;
	}

	let { port }: Props = $props();
	const api = $derived(port);

	type FilterKey = 'all' | 'confirmed' | 'awaiting' | 'attention' | 'incomplete';

	/**
	 * The roster answers two different questions and they want different shapes.
	 * `roster` chases people — states, tasks, cancellations, one row per person
	 * with its own disclosure. `lineup` curates what the public sees — one
	 * ordered sequence, groups, who is on it at all. Same records, so this is a
	 * view of one surface rather than two surfaces; and it is shareable state,
	 * so it lives in the address.
	 */
	const viewKeys = ['roster', 'lineup'] as const;
	type ViewKey = (typeof viewKeys)[number];
	const view = $derived(paramIn('view', viewKeys, 'roster'));

	function switchView(next: ViewKey) {
		if (view === next) return;
		expandedId = null;
		actionError = '';
		// A view change replaces the scope the other view was carrying: a filter
		// and a single-speaker arrival both belong to the roster view.
		void applyParams({
			view: next === 'roster' ? null : next,
			...(next === 'lineup' ? { filter: null, speaker: null } : {})
		});
	}

	let rosterState = $state<
		LiveReadState<{
			readonly speakers: SpeakerRow[];
			readonly defs: TaskDef[];
			readonly assignments: TaskAssignment[];
		}>
	>({ kind: 'resolving' });
	const resolvedRoster = $derived(rosterState.kind === 'resolved' ? rosterState.value : null);
	const speakers = $derived(resolvedRoster?.speakers ?? null);
	const taskDefs = $derived(resolvedRoster?.defs ?? []);
	const assignments = $derived(resolvedRoster?.assignments ?? []);
	let expandedId = $state<string | null>(null);
	let busyId = $state<string | null>(null);
	let announcement = $state('');

	const filterKeys = ['all', 'confirmed', 'awaiting', 'attention', 'incomplete'] as const;

	/** The roster's filter is shareable state, so it lives in the address. */
	const filter = $derived(paramIn('filter', filterKeys, 'all'));

	const filters: { key: FilterKey; label: string; sub?: string }[] = [
		{ key: 'all', label: 'All' },
		{ key: 'confirmed', label: 'Confirmed' },
		{ key: 'awaiting', label: 'Awaiting confirmation' },
		{ key: 'attention', label: 'Needs attention' },
		/* The playful name never travels alone: a plain subtitle says what the
		   list is, and being visible text it reaches the accessible name too. */
		{ key: 'incomplete', label: 'The naughty list', sub: 'tasks incomplete' }
	];

	/* The shared vocabulary: one meaning, one badge, across the roster row, the
	   record page, and the task matrix. */
	const stateBadge = engagementStateBadge;

	/** A speaker needs attention when they asked to cancel or hold overdue tasks. */
	function needsAttention(row: SpeakerRow): boolean {
		return row.state === 'cancel_requested' || row.overdueTasks > 0;
	}

	function matchesFilter(row: SpeakerRow, key: FilterKey): boolean {
		if (key === 'confirmed') return row.state === 'confirmed';
		if (key === 'awaiting') return row.state === 'invited';
		if (key === 'attention') return needsAttention(row);
		// Who still has to be chased, overdue or not — the same fact the row's
		// done/total fraction already states.
		if (key === 'incomplete') return row.tasksDone < row.tasksTotal;
		return true;
	}

	const rows = $derived(speakers ?? []);
	const filtered = $derived(rows.filter((row) => matchesFilter(row, filter)));
	const counts = $derived<Record<FilterKey, number>>({
		all: rows.length,
		confirmed: rows.filter((row) => row.state === 'confirmed').length,
		awaiting: rows.filter((row) => row.state === 'invited').length,
		attention: rows.filter(needsAttention).length,
		incomplete: rows.filter((row) => row.tasksDone < row.tasksTotal).length
	});
	const cancellationPending = $derived(rows.some((row) => row.state === 'cancel_requested'));

	/**
	 * The surface's one read. It answers three ways — still arriving, arrived,
	 * or cannot be answered — and the third is rendered as itself. Before this,
	 * any rejection here left `speakers` null with nothing still in flight, so
	 * the roster held skeleton rows for the rest of the session.
	 */
	const rosterRead = new LiveRead<{
		readonly speakers: SpeakerRow[];
		readonly defs: TaskDef[];
		readonly assignments: TaskAssignment[];
	}>({
		read: async () => {
			// The roster advertises "3 overdue" per speaker; the assignments behind
			// that number are read here so the row's own panel can name them.
			const [defs, taskAssignments, rows] = await Promise.all([
				api.tasks.defs(),
				api.tasks.assignments(),
				api.speakers.list()
			]);
			// Fresh row objects so a committed mutation repaints the roster in place.
			return { speakers: rows.map((row) => ({ ...row })), defs, assignments: taskAssignments };
		},
		fallback: 'The speaker roster could not be loaded.',
		onChange: (state) => (rosterState = state)
	});

	/** Re-read after a write: a fresh request every time, newest answer wins. */
	async function load() {
		await rosterRead.refresh();
	}

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		try {
			await rosterRead.refresh();
		} finally {
			retrying = false;
		}
	}

	onMount(() => {
		void rosterRead.read();
	});

	function switchFilter(next: FilterKey) {
		if (filter === next) return;
		expandedId = null;
		// One navigation, not two: a filter pass replaces whatever single speaker
		// the address was scoped to, and both facts change together.
		applyParams({ filter: next === 'all' ? null : next, speaker: null });
	}

	function toggleRow(id: string) {
		expandedId = expandedId === id ? null : id;
		// The address named one speaker; the moment the operator opens or closes a
		// row themselves, what is showing is theirs rather than the link's — so the
		// scope leaves the address, and Back puts the scoped arrival back.
		if (askedSpeaker && askedSpeaker !== expandedId) {
			void clearParams(['speaker'], { history: 'push' });
		}
	}

	/**
	 * The row is a bigger door to the same detail, for the pointer only. The
	 * chevron stays the one focusable switch carrying `aria-expanded`, so the
	 * accessible tree gains nothing to disambiguate and the keyboard path is
	 * exactly what it was. The press routes through `toggleRow`, so opening by
	 * row hands back a `?speaker=` arrival exactly as the chevron does. Which
	 * presses belong to the row's own controls — the copy control, the toggle,
	 * a panel opened over the row — or to a text selection, is the shared
	 * row-press contract in `$lib/ui`.
	 *
	 * Roster only. The public lineup is a separate component behind the view
	 * switch, where a row press would fight the drag that reorders it.
	 */
	function onRowPress(event: MouseEvent, id: string) {
		if (shouldIgnoreRowPress(event)) return;
		toggleRow(id);
	}

	/**
	 * Arriving from elsewhere: `?speaker=` lands on that person's roster row —
	 * open, scrolled to, and marked — so a link handed over by a profile keeps
	 * its promise instead of dropping someone at the top of a list to search.
	 * The roster is a crowd of alike rows, so the arrival is marked.
	 */
	const askedSpeaker = $derived(param('speaker'));

	// A plain let, deliberately outside the graph: it records which arrival has
	// already been answered, so a repaint cannot steal focus back a second time.
	let revealedSpeaker: string | null = null;

	$effect(() => {
		const id = askedSpeaker;
		const ready = speakers;
		if (!ready || !id) {
			revealedSpeaker = null;
			return;
		}
		if (revealedSpeaker === id) return;
		revealedSpeaker = id;
		const row = ready.find((entry) => entry.id === id);
		if (!row) return;
		expandedId = id;
		announcement = `${row.name} — ${stateBadge[row.state].label}. Their roster row is open.`;
		void showRow(row);
	});

	async function showRow(row: SpeakerRow) {
		// A filter the link never asked for can hide the row it did ask for, so the
		// roster widens to the full list rather than landing on an empty state.
		if (!matchesFilter(row, filter)) await applyParams({ filter: null });
		await tick();
		// The roster renders twice — a table and, below a breakpoint, cards — and
		// only one of the two is laid out. Scrolling to the hidden one would move
		// nothing, so the arrival goes to whichever is actually on screen.
		const shown = Array.from(
			document.querySelectorAll<HTMLElement>(`[data-speaker="${row.id}"]`)
		).find((element) => element.offsetWidth > 0);
		revealTarget(shown ?? null);
	}

	/**
	 * A refused act stays on screen with its reason: both response acts are
	 * consequential commits fenced on the engagement's version, so a stale row
	 * or lost authority resolves `{ ok: false }` rather than throwing — and the
	 * roster reloads either way, because a refusal usually means the row moved.
	 */
	let actionError = $state('');

	async function recordConfirmation(row: SpeakerRow) {
		busyId = row.id;
		actionError = '';
		try {
			const outcome = await api.speakers.recordConfirmation(row.id);
			if (!outcome.ok) {
				actionError = outcome.reason;
				await load();
				return;
			}
			await load();
			announcement = `${row.name} is now confirmed.`;
		} finally {
			busyId = null;
		}
	}

	async function acceptCancellation(row: SpeakerRow) {
		busyId = row.id;
		actionError = '';
		try {
			const outcome = await api.speakers.acceptCancellation(row.id);
			if (!outcome.ok) {
				actionError = outcome.reason;
				await load();
				return;
			}
			await load();
			announcement = `${row.name}’s cancellation is recorded. Nothing has been sent.`;
		} finally {
			busyId = null;
		}
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return '?';
		const first = parts[0].charAt(0);
		const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
		return `${first}${last}`.toUpperCase();
	}


	/** States that still owe the organizer a decision or a follow-up. */
	function hasNextStep(row: SpeakerRow): boolean {
		return row.state === 'invited' || row.state === 'cancel_requested' || row.state === 'cancelled';
	}

	interface SpeakerTask {
		def: TaskDef;
		assignment: TaskAssignment;
	}

	/* Open obligations first, then anything still outstanding, then what is
	   settled — so the panel answers "which ones are late" in its first line
	   rather than in its fifth. Definition order is preserved inside each group,
	   which keeps this list in the same sequence as the task matrix. */
	const taskRank = (assignment: TaskAssignment) =>
		assignment.overdue ? 0 : assignment.state === 'todo' || assignment.state === 'received' ? 1 : 2;

	function tasksFor(speakerId: string): SpeakerTask[] {
		const own: SpeakerTask[] = [];
		for (const def of taskDefs) {
			const assignment = assignments.find(
				(entry) => entry.taskId === def.id && entry.speakerId === speakerId
			);
			if (assignment) own.push({ def, assignment });
		}
		return own.sort((a, b) => taskRank(a.assignment) - taskRank(b.assignment));
	}

	/* The same state vocabulary the task matrix uses: one meaning, one badge. */
	const assignmentBadge = assignmentStateBadge;

	/**
	 * Where this speaker's outstanding work is worked. The scope travels in the
	 * address, so the matrix opens already filtered to them — and to what is late
	 * when anything is.
	 */
	function tasksHref(row: SpeakerRow): string {
		const overdue = tasksFor(row.id).some((entry) => entry.assignment.overdue);
		return `/app/tasks?speaker=${row.id}${overdue ? '&filter=overdue' : ''}`;
	}
</script>

<!-- Session titles are separate records, so they get a structural divider
     rather than the interpunct this app uses for a single item's own
     attributes ("Priya Nair · Talk"). One glyph cannot mean both "more about this"
     and "a different thing", and at two long titles the dot was invisible.
     The rule is decorative; the comma beside it is what assistive technology
     hears. -->
{#snippet sessionList(row: SpeakerRow)}
	{#each row.sessions as session, index (session.id)}
		{#if index > 0}<span class="sessions__sep"><span class="ui-sr-only">, </span></span>{/if}
		<span class="sessions__title">{session.title}</span>
	{/each}
{/snippet}

{#snippet stateChip(row: SpeakerRow)}
	{@const badge = stateBadge[row.state]}
	{@const Engagement = badge.icon}
	<span class="ui-badge ui-badge--{badge.tone}" class:ui-badge--solid={badge.solid}
		><Engagement class="ui-badge__icon" aria-hidden="true" />{badge.label}</span
	>
{/snippet}

{#snippet taskProgress(row: SpeakerRow)}
	{#if row.tasksTotal > 0}
		<span class="tasks">
			<span class="tasks__count">{row.tasksDone}/{row.tasksTotal}</span>
			{#if row.overdueTasks > 0}
				{@const Overdue = statusIcon.overdue}
				<span class="ui-badge ui-badge--warning"
					><Overdue class="ui-badge__icon" aria-hidden="true" />{row.overdueTasks} overdue</span
				>
			{/if}
		</span>
	{:else}
		<span class="muted" aria-hidden="true">—</span>
		<span class="ui-sr-only">No tasks assigned yet</span>
	{/if}
{/snippet}

{#snippet visibility(row: SpeakerRow)}
	{#if row.publiclyVisible}
		{@const Shown = statusIcon.published}
		<span class="ui-badge ui-badge--sea"
			><Shown class="ui-badge__icon" aria-hidden="true" />Public</span
		>
		{#if !row.contentApproved}
			<span class="tba">Shows as TBA</span>
		{/if}
	{:else}
		{@const Concealed = statusIcon.unpublished}
		<span class="ui-badge ui-badge--neutral"
			><Concealed class="ui-badge__icon" aria-hidden="true" />Hidden</span
		>
	{/if}
{/snippet}

{#snippet detail(row: SpeakerRow)}
	{@const tasks = tasksFor(row.id)}
	<div class="detail" class:detail--single={!hasNextStep(row)}>
		<div class="detail__main">
			<!-- The expansion stays the in-pass summary; the record is the whole
			     answer. A named control carries the exit so the pass is only left
			     on purpose, and it is the same URL the profile peek and every
			     other person-shaped link resolve to. -->
			<a class="ui-button ui-button--soft ui-button--sm detail__record" href={speakerRecordHref(row.id)}
				>Open record</a>
			<h3 class="detail__heading">Sessions</h3>
			{#if row.sessions.length > 0}
				<ul class="detail__sessions">
					{#each row.sessions as session (session.id)}
						<!-- A speaker's session is a place on the schedule, so the title is
						     the way to it — already on the right day, already focused. -->
						<li><a href={`/app/schedule?session=${session.id}`}>{session.title}</a></li>
					{/each}
				</ul>
			{:else}
				<p class="detail__none">No session is linked to this engagement.</p>
			{/if}

			{#if tasks.length > 0}
				<div class="detail__section detail__section--spaced">
					<h3 class="detail__heading">Tasks</h3>
					<a class="ui-button ui-button--soft ui-button--sm" href={tasksHref(row)}>Open in Tasks</a>
				</div>
				<ul class="detail__tasks">
					{#each tasks as entry (entry.def.id)}
						{@const badge = entry.assignment.overdue
							? overdueBadge
							: assignmentBadge[entry.assignment.state]}
						{@const State = badge.icon}
						<li class="task">
							<span class="task__name">{entry.def.name}</span>
							<span class="ui-badge ui-badge--{badge.tone}" class:ui-badge--solid={badge.solid}
								><State class="ui-badge__icon" aria-hidden="true" />{badge.label}</span>
							<span class="task__due">{entry.def.dueRelative}</span>
						</li>
					{/each}
				</ul>
			{/if}

			<SpeakerCommunications {port} speakerId={row.personId ?? row.id} />

			{#if row.note}
				<h3 class="detail__heading detail__heading--spaced">Note</h3>
				<p class="detail__note">{row.note}</p>
			{/if}
		</div>

		{#if hasNextStep(row)}
			<div class="detail__side">
				{#if row.state === 'invited'}
					<h3 class="detail__heading">Confirmation</h3>
					<p class="detail__hint">
						Speakers confirm from their own portal link. This records that the speaker agreed
						outside the product — attributed to you, not to them.
					</p>
				{:else if row.state === 'cancel_requested'}
					<div class="ui-alert ui-alert--danger">
						<span class="ui-alert__icon plate" aria-hidden="true"><TriangleAlert size={16} /></span>
						<div class="ui-alert__copy">
							<p class="ui-alert__title">Nothing about this has been sent</p>
							<p class="ui-alert__message">
								The request is recorded here only. No speaker message, public update, or schedule
								change happens until you commit one — call first if you want to.
							</p>
						</div>
					</div>
				{:else if row.state === 'cancelled'}
					<h3 class="detail__heading">Cancellation</h3>
					<p class="detail__hint">
						The cancellation is recorded. Nothing has gone out — write the message when you are
						ready.
					</p>
				{/if}
				<div class="detail__actions">
					{#if row.state === 'invited'}
						<button
							type="button"
							class="ui-button ui-button--secondary ui-button--sm"
							disabled={busyId !== null}
							aria-busy={busyId === row.id}
							onclick={() => recordConfirmation(row)}>Record confirmation</button>
					{:else if row.state === 'cancel_requested'}
						<button
							type="button"
							class="ui-button ui-button--danger ui-button--sm"
							disabled={busyId !== null}
							aria-busy={busyId === row.id}
							onclick={() => acceptCancellation(row)}>Accept cancellation</button>
					{/if}
					{#if hasNextStep(row)}
						<!-- The compose dialog opens scoped to this person; a GET never
						     sends anything. -->
						<a
							class="ui-button ui-button--secondary ui-button--sm"
							href={`/app/messages?compose=1&person=${row.id}`}>
							Compose email
						</a>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<div class="views">
	<div class="ui-segmented" role="group" aria-label="What this page is for">
		<button
			type="button"
			class="ui-segmented__item"
			aria-pressed={view === 'roster'}
			onclick={() => switchView('roster')}>Roster</button>
		<button
			type="button"
			class="ui-segmented__item"
			aria-pressed={view === 'lineup'}
			onclick={() => switchView('lineup')}>Public lineup</button>
	</div>
</div>

{#if view === 'lineup'}
	<SpeakerLineup {port} />
{:else}
<div class="head">
	<nav class="chips" aria-label="Speaker filters">
		{#each filters as entry (entry.key)}
			<button
				type="button"
				class="chips__tab"
				class:chips__tab--active={filter === entry.key}
				class:chips__tab--wide={entry.key === 'incomplete'}
				aria-pressed={filter === entry.key}
				onclick={() => switchFilter(entry.key)}>
				{entry.label}
				{#if entry.sub}<span class="chips__sub">{entry.sub}</span>{/if}
				<span
					class="chips__count"
					class:chips__count--attention={entry.key === 'attention' &&
						counts.attention > 0 &&
						!cancellationPending}
					class:chips__count--blocking={entry.key === 'attention' && cancellationPending}
					>{speakers ? counts[entry.key] : '–'}</span>
			</button>
		{/each}
	</nav>
	<button type="button" class="ui-button ui-button--secondary ui-button--sm head__add">
		Add a speaker directly
	</button>
	<p class="head__note">
		Nothing reaches a public surface until a speaker is confirmed and their content is approved.
	</p>
</div>

{#if actionError}<p class="roster__error" role="alert">{actionError}</p>{/if}

<section aria-label="Speaker roster">
	{#if rosterState.kind === 'unavailable'}
		<!-- Nothing is still arriving, so nothing here pretends to be. -->
		<div class="panel" role="alert">
			<span class="panel__mark" aria-hidden="true"><TriangleAlert size={22} /></span>
			<p class="panel__title">The speaker roster is unavailable</p>
			<p class="panel__copy">{rosterState.message}</p>
			{#if rosterState.retryable}
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					aria-busy={retrying || undefined}
					disabled={retrying}
					onclick={retry}>Try again</button>
			{/if}
		</div>
	{:else if speakers && filtered.length === 0}
		<div class="panel">
			{#if rows.length === 0}
				{@const Situation = situationIcon.emptyRoster}
				<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">No speakers yet</p>
				<p class="panel__copy">
					Accepting a submission creates that speaker’s engagement here automatically — invitation,
					confirmation, tasks, and visibility all follow from it. For an invited keynote or a
					replacement, add a speaker directly instead.
				</p>
				<a class="ui-button ui-button--secondary ui-button--sm" href="/app/decisions">Review decisions</a>
			{:else if filter === 'attention'}
				{@const Situation = situationIcon.allClear}
				<span class="panel__mark panel__mark--clear" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">Nothing needs attention</p>
				<p class="panel__copy">
					No cancellation requests and no overdue tasks across {rows.length} speakers.
				</p>
				<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={() => switchFilter('all')}>
					Show the full roster
				</button>
			{:else if filter === 'incomplete'}
				{@const Situation = situationIcon.allClear}
				<span class="panel__mark panel__mark--clear" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">Nobody’s on the naughty list</p>
				<p class="panel__copy">
					All {rows.length} speakers have finished every task.
				</p>
				<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={() => switchFilter('all')}>
					Show the full roster
				</button>
			{:else}
				{@const Situation = situationIcon.filteredEmpty}
				<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">No speakers in this filter</p>
				<p class="panel__copy">
					{rows.length} speakers are on the roster; none of them are in this state right now.
				</p>
				<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={() => switchFilter('all')}>
					Show the full roster
				</button>
			{/if}
		</div>
	{:else}
		<div class="ui-table-wrap roster__table">
			<table class="ui-table ui-table--multiline">
				<thead>
					<tr>
						<th class="col-speaker">Speaker</th>
						<th class="col-state">Engagement</th>
						<th>Sessions</th>
						<th class="col-tasks">Tasks</th>
						<th class="col-visibility">Visibility</th>
						<th class="col-expand"><span class="ui-sr-only">Details</span></th>
					</tr>
				</thead>
				<tbody>
					{#if !speakers}
						{#each Array(6) as _, index (index)}
							<!-- Mirrors the resolved multiline row cell-for-cell, so the row
							     height is set by the same table metrics as real rows. -->
							<tr aria-hidden="true">
								<td class="col-speaker">
									<div class="who">
										<span class="ui-avatar who__mark ui-skeleton"></span>
										<span class="who__copy">
											<span class="ui-table__primary"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
											<span class="ui-table__secondary"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></span>
										</span>
									</div>
								</td>
								<td><span class="ui-skeleton skeleton-chip"></span></td>
								<td><span class="ui-skeleton skeleton-line" style="inline-size: min(14rem, 100%)"></span></td>
								<td class="ui-table__number"><span class="ui-skeleton skeleton-line" style="inline-size: 2.5rem"></span></td>
								<td><span class="ui-skeleton skeleton-chip skeleton-chip--narrow"></span></td>
								<td class="col-expand"><span class="ui-skeleton skeleton-action--icon"></span></td>
							</tr>
						{/each}
					{:else}
						{#each filtered as row (row.id)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<!-- `data-arrival-host`: the mark for `?speaker=` belongs to the
							     whole row, which is what the eye reads as "this person" —
							     the anchor inside it only says where to land. -->
							<tr
								class="row"
								class:is-open={expandedId === row.id}
								data-arrival-host
								onclick={(event) => onRowPress(event, row.id)}>
								<td class="col-speaker">
									<!-- The arrival anchor for `?speaker=`: the scroll and the caret
									     stop on the name, so a table scrolled sideways still opens on
									     the column the link was about. -->
									<div class="who" data-speaker={row.id}>
										<span class="ui-avatar who__mark" aria-hidden="true">{initials(row.name)}</span>
										<span class="who__copy">
											<span class="ui-table__primary"><strong>{row.name}</strong></span>
											<span class="ui-table__secondary"><CopyValue value={row.email} label="email address" /></span>
										</span>
									</div>
								</td>
								<td>{@render stateChip(row)}</td>
								<td>
									{#if row.sessions.length > 0}
										<span class="ui-clamp__body ui-clamp__body--clipped sessions"
											>{@render sessionList(row)}</span
										>
									{:else}
										<span class="muted" aria-hidden="true">—</span>
										<span class="ui-sr-only">No session linked</span>
									{/if}
								</td>
								<td class="ui-table__number">{@render taskProgress(row)}</td>
								<td>{@render visibility(row)}</td>
								<td class="col-expand">
									<button
										type="button"
										class="ui-button ui-button--ghost ui-button--icon ui-button--sm expand"
										class:expand--open={expandedId === row.id}
										aria-expanded={expandedId === row.id}
										aria-label={`Details for ${row.name}`}
										onclick={() => toggleRow(row.id)}>
										<ChevronDown size={15} />
									</button>
								</td>
							</tr>
							{#if expandedId === row.id}
								<tr class="detail-row">
									<td colspan="6">{@render detail(row)}</td>
								</tr>
							{/if}
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Narrow composition: the same roster restructured so name, state, and the
		     disclosure never compete for one crushed line. -->
		<ul class="roster__cards">
			{#if !speakers}
				{#each Array(4) as _, index (index)}
					<!-- The card's own composition with skeleton fills: mark, the two
					     name lines, the disclosure, then tags and sessions. -->
					<li class="card" aria-hidden="true">
						<div class="card__head">
							<span class="ui-avatar card__mark ui-skeleton"></span>
							<span class="card__copy">
								<span class="card__name"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
								<span class="card__email"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></span>
							</span>
							<span class="card__toggle ui-skeleton skeleton-action--icon"></span>
							<span class="card__tags">
								<span class="ui-skeleton skeleton-chip"></span>
								<span class="ui-skeleton skeleton-chip skeleton-chip--narrow"></span>
							</span>
							<span class="card__sessions"><span class="ui-skeleton skeleton-line" style="inline-size: min(16rem, 100%)"></span></span>
						</div>
					</li>
				{/each}
			{:else}
				{#each filtered as row (row.id)}
					<li class="card" data-speaker={row.id}>
						<!-- The whole summary — everything above the expanded detail — is
						     the door; the toggle inside it stays the one focusable switch,
						     which is why no role or tabindex is added here. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="card__head card__head--door" onclick={(event) => onRowPress(event, row.id)}>
							<span class="ui-avatar card__mark" aria-hidden="true">{initials(row.name)}</span>
							<span class="card__copy">
								<span class="card__name">{row.name}</span>
								<span class="card__email"><CopyValue value={row.email} label="email address" /></span>
							</span>
							<button
								type="button"
								class="ui-button ui-button--ghost ui-button--icon ui-button--sm expand card__toggle"
								class:expand--open={expandedId === row.id}
								aria-expanded={expandedId === row.id}
								aria-label={`Details for ${row.name}`}
								onclick={() => toggleRow(row.id)}>
								<ChevronDown size={15} />
							</button>
							<span class="card__tags">
								{@render stateChip(row)}
								{@render visibility(row)}
								{@render taskProgress(row)}
							</span>
							{#if row.sessions.length > 0}
								<span class="card__sessions">{@render sessionList(row)}</span>
							{/if}
						</div>
						{#if expandedId === row.id}
							<div class="card__detail">{@render detail(row)}</div>
						{/if}
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</section>
{/if}

<p class="ui-sr-only" role="status">{announcement}</p>

<CommitReceipt onUndone={load} />

<style>
	/* The one control that says which of the roster's two jobs is on screen. */
	.views {
		display: flex;
		margin-block-end: var(--je-space-4);
	}

	.head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-4);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1);
	}

	.head__add {
		justify-self: end;
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

	.chips__count {
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
	}

	/* The subtitle stays plain whatever the chip does: muted, small, never bold,
	   so the joke reads first and the meaning is one glance behind it. */
	.chips__sub {
		font-size: var(--je-font-size-xs);
		font-weight: 400;
		color: var(--je-color-text-muted);
	}

	/* Actionable counts climb the status ladder: soft amber while only tasks are
	   late, solid red while a cancellation is waiting on a decision. */
	.chips__count--attention {
		padding: 0.0625rem var(--je-space-2);
		border-radius: var(--je-radius-round);
		font-weight: 650;
		background: var(--je-color-warning-soft);
		color: var(--je-color-warning);
	}

	.chips__count--blocking {
		padding: 0.0625rem var(--je-space-2);
		border-radius: var(--je-radius-round);
		font-weight: 650;
		background: var(--je-color-danger-emphasis);
		color: var(--je-color-danger-emphasis-contrast);
	}

	.head__note {
		grid-column: 1 / -1;
		margin: 0;
		max-inline-size: 72ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The same refusal grammar the lineup already speaks: one line, danger ink. */
	.roster__error {
		margin: var(--je-space-3) 0 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-danger);
	}

	/* No reserved height: the resolved list takes its natural size, however
	   short; the mirrored rows carry the footprint during the initial load. */
	.roster__cards {
		display: none;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	/* Says which kind of empty this is before the sentence is read: a roster
	   that never started, a filter hiding data, or a genuinely clear queue.
	   Subtle ink — an empty state is not a status event. */
	.panel__mark {
		display: grid;
		place-items: center;
		color: var(--je-color-text-subtle);
	}

	.panel__mark--clear {
		color: var(--je-color-text-muted);
	}

	.panel {
		display: grid;
		justify-items: center;
		align-content: center;
		gap: var(--je-space-3);
		min-block-size: 14rem;
		padding: var(--je-space-8) var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		text-align: center;
	}

	.panel__title {
		margin: 0;
		font-weight: 600;
	}

	.panel__copy {
		margin: 0;
		max-inline-size: 52ch;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, a chip is badge-height, an action
	   is control-height. Free-standing sized rectangles drift; these cannot. */
	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.skeleton-chip {
		display: inline-block;
		block-size: 1.35rem;
		inline-size: 6.5rem;
	}

	.skeleton-chip--narrow {
		inline-size: 4rem;
	}

	.skeleton-action--icon {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: var(--je-control-height-sm);
		border-radius: var(--je-radius-control);
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-inline-size: 0;
	}

	.who__copy {
		display: grid;
		min-inline-size: 0;
	}

	/* One clamped line so a long session title cannot claim the speaker column's
	   width; the full list is in the row's detail. */
	.sessions {
		--ui-clamp-lines: 1;
		color: var(--je-color-text-muted);
	}

	/* A hairline rule, not a dot: it reads as a boundary between records at a
	   glance, and it survives two long titles sitting side by side. */
	.sessions__sep {
		display: inline-block;
		inline-size: 1px;
		block-size: 0.85em;
		margin-inline: var(--je-space-2);
		translate: 0 0.14em;
		background: var(--je-color-border-strong);
	}

	.muted {
		color: var(--je-color-text-muted);
	}

	.tasks {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-2);
	}

	.tasks__count {
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}

	.tba {
		display: block;
		margin-block-start: var(--je-space-1);
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}

	.col-speaker {
		inline-size: 17rem;
	}

	.col-state {
		inline-size: 11rem;
	}

	.col-tasks {
		inline-size: 9rem;
	}

	.col-visibility {
		inline-size: 8rem;
	}

	.col-expand {
		inline-size: 2.5rem;
	}

	.expand :global(svg) {
		transition: rotate var(--je-duration-fast) var(--je-ease);
	}

	.expand--open :global(svg) {
		rotate: 180deg;
	}

	/* The whole row opens its detail, so the whole row says so. Only the data
	   rows: the detail and the skeletons are not doors. The hover tint the
	   table already gives every row is the other half of the affordance and
	   is left alone. */
	tr.row {
		cursor: pointer;
	}

	/* Marked things tint; open things lift. The pair in hand keeps the table's
	   full surface brightness — on a white list a tint can only recede, and the
	   row being worked on must never read below its neighbours — so a lifted
	   boundary frames row and expansion as one raised unit instead. */
	tr.is-open td {
		border-bottom-color: transparent;
		background: var(--je-color-surface);
		border-top: 2px solid var(--je-color-border-strong);
	}

	tr.is-open td:first-child {
		border-inline-start: 2px solid var(--je-color-border-strong);
	}

	tr.is-open td:last-child {
		border-inline-end: 2px solid var(--je-color-border-strong);
	}

	.detail-row td {
		background: var(--je-color-surface);
		border-bottom: 2px solid var(--je-color-border-strong);
	}

	.detail-row td:first-child {
		border-inline-start: 2px solid var(--je-color-border-strong);
	}

	.detail-row td:last-child {
		border-inline-end: 2px solid var(--je-color-border-strong);
	}

	.detail {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: var(--je-space-6);
		padding: var(--je-space-3) var(--je-space-2) var(--je-space-4);
	}

	.detail--single {
		grid-template-columns: minmax(0, 1fr);
	}

	/* The exit from the pass, before the summary it summarises. It sits on its
	   own line at the group-to-group tier so it belongs to the whole expansion
	   rather than to the Sessions heading beneath it. */
	.detail__record {
		display: inline-flex;
		margin-block-end: var(--je-space-4);
	}

	.detail__heading {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* The heading's own bottom margin spaces it from the content below when it
	   stands alone. Inside this row it becomes a centring bug: flexbox centres the
	   margin box, so an 8px bottom margin lifts the visible heading by half of it.
	   The section owns that spacing instead, and the heading centres on its ink. */
	.detail__section {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		margin-block-end: var(--je-space-2);
	}

	.detail__section .detail__heading {
		margin-block-end: 0;
	}

	.detail__section--spaced {
		margin-block-start: var(--je-space-4);
	}

	.detail__heading--spaced {
		margin-block-start: var(--je-space-4);
	}

	.detail__sessions {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--je-space-1);
		font-size: var(--je-font-size-md);
	}

	/* Name, state, and due date read as one line per obligation; the state sits
	   next to the name because "which ones are late" is the question this list
	   exists to answer. */
	/* The three columns live on the list, not on each row: a row that owns its
	   own `max-content` columns sizes them to its own text, so every state
	   landed at a different x and nothing aligned. Sizing to content rather
	   than stretching also keeps the state beside its task instead of pushing
	   it to the far edge of a wide column. */
	.detail__tasks {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		grid-template-columns: minmax(0, max-content) max-content max-content;
		justify-content: start;
		gap: var(--je-space-1) var(--je-space-4);
	}

	.task {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
	}

	.task__name {
		font-size: var(--je-font-size-md);
		min-inline-size: 0;
	}

	.task__due {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.detail__none,
	.detail__note,
	.detail__hint {
		margin: 0;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.detail__hint {
		margin-block-end: var(--je-space-3);
		max-inline-size: 48ch;
	}

	.detail__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-3);
	}

	/* Act-now tier: tinted card plus a solid emphasis plate, shown only for the
	   open row so at most one is on screen. */
	.plate {
		display: grid;
		place-items: center;
		inline-size: 1.75rem;
		block-size: 1.75rem;
		margin: 0;
		border-radius: var(--je-radius-control);
		background: var(--je-color-danger-emphasis);
		color: var(--je-color-danger-emphasis-contrast);
	}

	/* Narrow cards */
	.card {
		padding: var(--je-space-3);
		border-block-end: 1px solid var(--je-color-border);
	}

	.card:last-child {
		border-block-end: 0;
	}

	.card__head {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas:
			'mark copy toggle'
			'.    tags tags'
			'.    sessions sessions';
		column-gap: var(--je-space-3);
		row-gap: var(--je-space-2);
		align-items: center;
	}

	/* The card's summary is the table row's door in the narrow composition; a
	   skeleton head is not one, which is what the modifier separates. These
	   cards mostly meet a coarse pointer, so no chrome is added beyond the
	   cursor — the toggle's own states already carry the affordance. */
	.card__head--door {
		cursor: pointer;
	}

	.card__mark {
		grid-area: mark;
	}

	.card__copy {
		grid-area: copy;
		display: grid;
		min-inline-size: 0;
	}

	.card__name {
		font-size: var(--je-font-size-md);
		font-weight: 650;
		line-height: var(--je-leading-snug);
	}

	.card__email {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.card__toggle {
		grid-area: toggle;
	}

	.card__tags {
		grid-area: tags;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
	}

	.card__sessions {
		grid-area: sessions;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
	}

	.card__detail {
		margin-block-start: var(--je-space-3);
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	@media (max-width: 920px) {
		.head {
			grid-template-columns: minmax(0, 1fr);
		}

		/* Four filters ragged-wrapping read as debris; a two-column grid keeps one
		   rhythm and gives every chip a touch-sized target. */
		.chips {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: var(--je-space-2);
		}

		.chips__tab {
			justify-content: space-between;
			min-block-size: 2.75rem;
			border-color: var(--je-color-border);
			background: var(--je-color-surface);
			font-size: var(--je-font-size-sm);
		}

		.chips__tab--active {
			background: var(--je-color-mark-surface);
		}

		/* Five chips in two columns would leave a dangler; the naughty list takes
		   the whole last row so the layout reads 2+2+1 on purpose. */
		.chips__tab--wide {
			grid-column: 1 / -1;
		}

		/* On the full-width chip the auto margin keeps the subtitle beside its
		   label, and the count holds the far edge like every other chip. */
		.chips__tab--wide .chips__sub {
			margin-inline-end: auto;
		}

		.head__add {
			justify-self: stretch;
		}

		.roster__table {
			display: none;
		}

		.roster__cards {
			display: block;
		}

		.detail {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--je-space-4);
			padding: 0;
		}
	}
</style>
