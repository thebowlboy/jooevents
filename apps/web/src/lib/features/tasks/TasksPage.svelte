<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Check } from 'lucide-svelte';
	import { Button, CopyValue, Field, Modal, statusIcon, trackPending } from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import { useWorkspaceGateway } from '$lib/api/workspace-gateway';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import ScopeChip from '$lib/features/workspace/components/ScopeChip.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, clearParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import type {
		AssignmentState,
		EngagementState,
		MessageTemplate,
		SpeakerProfile,
		SpeakerRow,
		TaskAssignment,
		TaskDef
	} from '$lib/api/types';

	const { api } = useWorkspaceGateway();

	type FilterKey = 'all' | 'incomplete' | 'overdue';

	interface SpeakerTaskRow {
		speaker: SpeakerRow;
		total: number;
		done: number;
		waived: number;
		outstanding: number;
		overdue: number;
	}

	const reminderSubjectDefault = 'Reminder: outstanding speaker tasks';

	/** Columns the loading matrix reserves so the header keeps its shape when definitions arrive. */
	const loadingColumns = 5;

	const filterKeys = ['all', 'incomplete', 'overdue'] as const;

	const filters: { key: FilterKey; label: string }[] = [
		{ key: 'all', label: 'All' },
		{ key: 'incomplete', label: 'Incomplete' },
		{ key: 'overdue', label: 'Overdue' }
	];

	/**
	 * A reminder never reaches someone whose engagement says otherwise. The
	 * reason travels with the exclusion, so the send review states it rather than
	 * quietly dropping a name.
	 */
	const excludedFromReminders: Partial<Record<EngagementState, string>> = {
		cancel_requested: 'Asked to cancel — nothing goes out until that request is settled',
		cancelled: 'Engagement is cancelled',
		declined: 'Declined the invitation'
	};

	const engagementLabel: Record<EngagementState, string> = {
		invited: 'Invited',
		confirmed: 'Confirmed',
		declined: 'Declined',
		cancel_requested: 'Cancellation requested',
		cancelled: 'Cancelled'
	};

	/* Lifecycle states are badged with the learned mapping, never plain text. */
	const engagementBadge: Record<EngagementState, string> = {
		invited: 'ui-badge--info',
		confirmed: 'ui-badge--success',
		declined: 'ui-badge--neutral',
		cancel_requested: 'ui-badge--danger ui-badge--solid',
		cancelled: 'ui-badge--neutral'
	};

	/* Same states as SpeakersPage, so the same glyphs. */
	const engagementIcon: Record<EngagementState, IconComponent> = {
		invited: statusIcon.invited,
		confirmed: statusIcon.confirmed,
		declined: statusIcon.declined,
		cancel_requested: statusIcon.cancelRequested,
		cancelled: statusIcon.cancelled
	};

	const stateLabel: Record<AssignmentState, string> = {
		todo: 'Not started',
		received: 'Received',
		complete: 'Complete',
		'late-complete': 'Done late',
		waived: 'Waived'
	};

	let defs = $state<TaskDef[] | null>(null);
	let assignments = $state<TaskAssignment[]>([]);
	let speakers = $state<SpeakerRow[]>([]);
	let loaded = $state(false);

	// Who each row is, keyed by their roster address. Null is a read that came
	// back with nothing, and it is kept: a speaker without a profile is the
	// ordinary case. Absent means "not asked yet", which renders as the plain
	// name it already was.
	let profiles = $state<Record<string, SpeakerProfile | null>>({});

	let selected = $state<string[]>([]);
	let openCell = $state<string | null>(null);
	let busyCell = $state<string | null>(null);
	let announcement = $state('');

	let reminderOpen = $state(false);
	let reminderSubject = $state(reminderSubjectDefault);
	let sending = $state(false);

	// One fact, one door: the reminder the send renders from is a stored
	// template, and the quiet link beside the action is the way to it. Resolved
	// from the template list; without a match no door renders.
	let templates = $state.raw<MessageTemplate[]>([]);
	const reminderTemplate = $derived(
		templates.find((template) => template.key === 'task-reminder') ?? null
	);

	// Both scopes are shareable state: the segmented control expresses the filter,
	// and a speaker scope arrives from a roster row asking "now deal with these".
	const filter = $derived(paramIn('filter', filterKeys, 'all'));
	const speakerScope = $derived(param('speaker') ?? '');

	let boardHeading = $state<HTMLHeadingElement>();

	// Re-reading the assignments is a reload, not a first load: the board keeps
	// the rows on screen and dims them until the replacement lands.
	let refreshing = $state(false);
	const reload = trackPending(() => refreshing);

	/**
	 * One pass for the whole board, after the rows are on screen. The roster is
	 * read once for this surface — waiving and accepting re-read the assignments,
	 * never the people — so there is no second answer for this one to race, and
	 * no address is ever asked about twice.
	 */
	async function loadProfiles(roster: SpeakerRow[]) {
		const emails = [...new Set(roster.map((speaker) => speaker.email))];
		if (emails.length === 0) return;
		const found = await Promise.all(emails.map((email) => api.speakers.profile(email)));
		const next: Record<string, SpeakerProfile | null> = {};
		emails.forEach((email, index) => (next[email] = found[index]));
		profiles = next;
	}

	onMount(async () => {
		const [taskDefs, taskAssignments, speakerRows, templateList] = await Promise.all([
			api.tasks.defs(),
			api.tasks.assignments(),
			api.speakers.list(),
			api.templates.list()
		]);
		defs = taskDefs;
		assignments = [...taskAssignments];
		speakers = speakerRows;
		templates = templateList.messages;
		loaded = true;
		// After the rows land, not with them: the matrix reserves the name's line
		// from first paint, so a profile arriving late changes ink and nothing else.
		await loadProfiles(speakerRows);
	});

	const cellKey = (taskId: string, speakerId: string) => `${taskId}::${speakerId}`;
	const isComplete = (state: AssignmentState) => state === 'complete' || state === 'late-complete';
	const isOutstanding = (state: AssignmentState) => state === 'todo' || state === 'received';
	const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

	/** A definition whose own due text reads as past due is called out in the column header. */
	const isDefOverdue = (def: TaskDef) => /overdue/i.test(def.dueRelative);

	const byCell = $derived(
		new Map(assignments.map((assignment) => [cellKey(assignment.taskId, assignment.speakerId), assignment]))
	);

	const rows = $derived(
		speakers
			.map((speaker) => {
				const own = assignments.filter((assignment) => assignment.speakerId === speaker.id);
				return {
					speaker,
					total: own.length,
					done: own.filter((assignment) => isComplete(assignment.state)).length,
					waived: own.filter((assignment) => assignment.state === 'waived').length,
					outstanding: own.filter((assignment) => isOutstanding(assignment.state)).length,
					overdue: own.filter((assignment) => assignment.overdue).length
				} satisfies SpeakerTaskRow;
			})
			.filter((row) => row.total > 0)
	);

	const scopedRows = $derived(
		speakerScope ? rows.filter((row) => row.speaker.id === speakerScope) : rows
	);

	const visibleRows = $derived(
		filter === 'incomplete'
			? scopedRows.filter((row) => row.outstanding > 0)
			: filter === 'overdue'
				? scopedRows.filter((row) => row.overdue > 0)
				: scopedRows
	);

	/* The segmented control already states the filter, so the chip exists for the
	   scope this surface has no other control for — one speaker — and names the
	   filter alongside it when the link carried both. */
	const scopedSpeaker = $derived(rows.find((row) => row.speaker.id === speakerScope)?.speaker);
	const scopeLabel = $derived(
		[filter === 'all' ? '' : filters.find((entry) => entry.key === filter)?.label, scopedSpeaker?.name]
			.filter(Boolean)
			.join(' · ')
	);

	function clearScope() {
		selected = [];
		openCell = null;
		// Pushed, so Back returns to the scoped matrix the operator arrived on.
		void clearParams(['speaker', 'filter'], { history: 'push' });
	}

	const completeCount = $derived(assignments.filter((assignment) => isComplete(assignment.state)).length);
	const waivedCount = $derived(assignments.filter((assignment) => assignment.state === 'waived').length);
	const overdueCount = $derived(assignments.filter((assignment) => assignment.overdue).length);
	const overdueSpeakers = $derived(rows.filter((row) => row.overdue > 0).length);
	const fullyDone = $derived(rows.filter((row) => row.outstanding === 0).length);
	const completePercent = $derived(
		assignments.length === 0 ? 0 : Math.round((completeCount / assignments.length) * 100)
	);

	const selectableVisible = $derived(
		visibleRows.filter((row) => row.outstanding > 0).map((row) => row.speaker.id)
	);
	const allSelected = $derived(
		selectableVisible.length > 0 && selectableVisible.every((id) => selected.includes(id))
	);
	const selectedRows = $derived(rows.filter((row) => selected.includes(row.speaker.id)));
	const columnCount = $derived((defs?.length ?? loadingColumns) + 2);

	/** The reviewed batch: who receives this, who does not, and why not. */
	const reminderRoster = $derived(
		selectedRows.map((row) => ({ row, reason: excludedFromReminders[row.speaker.state] }))
	);
	const reminderIncluded = $derived(reminderRoster.filter((entry) => !entry.reason));
	const reminderExcluded = $derived(reminderRoster.filter((entry) => entry.reason));
	const reminderOutstanding = $derived(
		reminderIncluded.reduce((total, entry) => total + entry.row.outstanding, 0)
	);

	function setFilter(next: FilterKey) {
		if (filter === next) return;
		selected = [];
		openCell = null;
		applyParams({ filter: next === 'all' ? null : next });
	}

	function toggleSpeaker(id: string) {
		selected = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
	}

	function toggleAllVisible() {
		selected = allSelected ? [] : selectableVisible;
	}

	/** Returns focus near the cell whose control was replaced by its new state. */
	async function restoreFocus(speakerId: string) {
		await tick();
		const picks = Array.from(document.querySelectorAll<HTMLElement>(`[data-pick="${speakerId}"]`));
		const onScreen = picks.find((element) => element.offsetParent !== null);
		(onScreen ?? boardHeading)?.focus();
	}

	async function reread() {
		refreshing = true;
		try {
			assignments = [...(await api.tasks.assignments())];
		} finally {
			refreshing = false;
		}
	}

	async function waive(def: TaskDef, speaker: SpeakerRow) {
		if (busyCell) return;
		const before = byCell.get(cellKey(def.id, speaker.id));
		if (!before) return;
		busyCell = cellKey(def.id, speaker.id);
		await api.tasks.markWaived(def.id, speaker.id);
		recordAction({
			area: 'tasks',
			label: `Waived “${def.name}” for ${speaker.name}`,
			undo: async () => {
				await api.tasks.restoreAssignment(def.id, speaker.id, before.state, before.overdue);
				await reread();
			}
		});
		await reread();
		busyCell = null;
		openCell = null;
		selected = selected.filter(
			(id) => (rows.find((row) => row.speaker.id === id)?.outstanding ?? 0) > 0
		);
		announcement = `${def.name} waived for ${speaker.name}.`;
		restoreFocus(speaker.id);
	}

	/**
	 * `Received` means the material is in and the queue is waiting on the
	 * organizer, so the cell is where that wait ends. The compensator puts the
	 * assignment back to received rather than guessing at a state.
	 */
	async function accept(def: TaskDef, speaker: SpeakerRow) {
		if (busyCell) return;
		const before = byCell.get(cellKey(def.id, speaker.id));
		if (!before) return;
		busyCell = cellKey(def.id, speaker.id);
		const outcome = await api.tasks.acceptFulfillment(def.id, speaker.id);
		if (outcome.ok) {
			recordAction({
				area: 'tasks',
				label: `Accepted “${def.name}” from ${speaker.name}`,
				undo: async () => {
					await api.tasks.restoreAssignment(def.id, speaker.id, before.state, before.overdue);
					await reread();
				}
			});
			announcement = `${def.name} accepted as complete for ${speaker.name}.`;
		} else {
			announcement = outcome.reason;
		}
		await reread();
		busyCell = null;
		openCell = null;
		selected = selected.filter(
			(id) => (rows.find((row) => row.speaker.id === id)?.outstanding ?? 0) > 0
		);
		restoreFocus(speaker.id);
	}

	function openReminder() {
		reminderSubject = reminderSubjectDefault;
		reminderOpen = true;
	}

	async function sendReminder() {
		const recipients = reminderIncluded.map((entry) => entry.row.speaker.id);
		if (recipients.length === 0 || sending) return;
		const subject = reminderSubject.trim() || reminderSubjectDefault;
		sending = true;
		await api.tasks.remind(recipients, subject);
		recordAction({
			area: 'tasks',
			label: `Sent “${subject}” to ${recipients.length} ${plural(recipients.length, 'speaker', 'speakers')}`,
			notUndoableReason: 'Email cannot be recalled after the provider accepts it.'
		});
		sending = false;
		reminderOpen = false;
		selected = [];
	}
</script>

{#snippet cell(def: TaskDef, speaker: SpeakerRow)}
	{@const key = cellKey(def.id, speaker.id)}
	{@const assignment = byCell.get(key)}
	{#if !assignment}
		<span class="ui-sr-only">Not assigned</span>
	{:else if assignment.state === 'complete'}
		<span class="cell-done" aria-hidden="true"><Check size={15} /></span>
		<span class="ui-sr-only">{stateLabel.complete}</span>
	{:else if assignment.state === 'received'}
		{@const Received = statusIcon.received}
		<!-- Received means it is in and waiting on us, so the cell is the exit from
		     that wait rather than a label describing it. -->
		<div class="cell-open">
			<button
				type="button"
				class="cell-trigger"
				class:cell-trigger--open={openCell === key}
				aria-expanded={openCell === key}
				aria-label={`Received — ${def.name} from ${speaker.name}. Accept it as complete.`}
				onclick={() => (openCell = openCell === key ? null : key)}>
				<span class="ui-badge ui-badge--info"
					><Received class="ui-badge__icon" aria-hidden="true" />Received</span
				>
			</button>
			{#if openCell === key}
				<button
					type="button"
					class="ui-button ui-button--primary ui-button--sm cell-confirm"
					disabled={busyCell !== null}
					onclick={() => accept(def, speaker)}>Accept as complete</button>
			{/if}
		</div>
	{:else if assignment.state === 'late-complete' || assignment.state === 'waived'}
		{@const Settled =
			assignment.state === 'waived' ? statusIcon.waived : statusIcon.lateComplete}
		<span class="ui-badge ui-badge--neutral"
			><Settled class="ui-badge__icon" aria-hidden="true" />{stateLabel[
				assignment.state
			]}</span
		>
	{:else}
		<div class="cell-open">
			<button
				type="button"
				class="cell-trigger"
				class:cell-trigger--open={openCell === key}
				aria-expanded={openCell === key}
				aria-label={`${assignment.overdue ? 'Overdue' : stateLabel.todo} — ${def.name} for ${speaker.name}`}
				onclick={() => (openCell = openCell === key ? null : key)}>
				{#if assignment.overdue}
					{@const Overdue = statusIcon.overdue}
					<span class="ui-badge ui-badge--warning ui-badge--solid"
						><Overdue class="ui-badge__icon" aria-hidden="true" />Overdue</span
					>
				{:else}
					<span class="cell-dash" aria-hidden="true">—</span>
				{/if}
			</button>
			{#if openCell === key}
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm cell-confirm"
					disabled={busyCell !== null}
					onclick={() => waive(def, speaker)}>Mark waived</button>
			{/if}
		</div>
	{/if}
{/snippet}

<section class="stats" aria-label="Task progress">
	{#if loaded}
		<article class="stat">
			<span class="stat__label">Assignments complete</span>
			<span class="stat__value">{completePercent}%</span>
			<span class="stat__sub">
				{completeCount} of {assignments.length} complete{waivedCount > 0 ? ` · ${waivedCount} waived` : ''}
			</span>
		</article>
		<article class="stat">
			<span class="stat__label">Overdue</span>
			<span class="stat__value" class:stat__value--attention={overdueCount > 0}>{overdueCount}</span>
			<span class="stat__sub" class:stat__sub--attention={overdueCount > 0}>
				{#if overdueCount > 0}
					past due across {overdueSpeakers} {plural(overdueSpeakers, 'speaker', 'speakers')}
				{:else}
					nothing past due
				{/if}
			</span>
		</article>
		<article class="stat">
			<span class="stat__label">Speakers fully done</span>
			<span class="stat__value">{fullyDone}</span>
			<span class="stat__sub">of {rows.length} with assignments</span>
		</article>
	{:else}
		{#each Array(3) as _, index (index)}
			<!-- The stat's own composition with skeleton fills, so the tile keeps
			     the height its label, figure, and note give it. -->
			<article class="stat" aria-hidden="true">
				<span class="stat__label"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
				<span class="stat__value"><span class="ui-skeleton skeleton-line" style="inline-size: 3rem"></span></span>
				<span class="stat__sub"><span class="ui-skeleton skeleton-line" style="inline-size: 10rem"></span></span>
			</article>
		{/each}
	{/if}
</section>

<section class="board" aria-label="Speaker tasks">
	<header class="board__head">
		<h2 class="board__title" tabindex="-1" bind:this={boardHeading}>Speaker tasks</h2>
		{#if loaded && scopeLabel}
			<ScopeChip label={scopeLabel} onclear={clearScope} />
		{/if}
		{#if loaded && rows.length > 0}
			<p class="board__note">
				Showing {visibleRows.length} of {rows.length}
				{plural(rows.length, 'speaker', 'speakers')} with assignments
			</p>
		{/if}
	</header>

	{#if loaded && rows.length === 0}
		<div class="blank blank--page">
			<p class="blank__title">No speaker tasks yet</p>
			<p class="blank__copy">
				Task definitions carry a rule — “all confirmed speakers”, “sessions in the workshop
				format” — and assignments appear on their own as each speaker confirms. Describe the rule
				once, or create a task definition and assign it by hand.
			</p>
			<Button size="sm">Create a task definition</Button>
		</div>
	{:else}
		<div class="ui-toolbar board__toolbar">
			<div class="ui-segmented" role="group" aria-label="Filter speakers">
				{#each filters as entry (entry.key)}
					<button
						type="button"
						class="ui-segmented__item"
						aria-pressed={filter === entry.key}
						onclick={() => setFilter(entry.key)}>{entry.label}</button>
				{/each}
			</div>
			{#if reminderTemplate}
				<a
					class="board__template"
					href={`/app/templates?template=${reminderTemplate.id}`}
					aria-label={`Reminder template — ${reminderTemplate.name}`}>
					Reminder template
				</a>
			{/if}
			<button
				type="button"
				class="ui-button ui-button--primary ui-button--sm board__remind"
				disabled={selected.length === 0 || sending}
				onclick={openReminder}>
				Send reminder{selected.length > 0 ? ` (${selected.length})` : ''}
			</button>
		</div>

		<div
			class="ui-table-wrap board__matrix"
			class:is-refreshing={reload.visible}
			aria-busy={refreshing || undefined}>
			<table class="ui-table ui-table--multiline matrix">
				<thead>
					<tr>
						<th class="matrix__pick" scope="col">
							<input
								type="checkbox"
								aria-label="Select all shown speakers with outstanding tasks"
								disabled={selectableVisible.length === 0}
								checked={allSelected}
								onchange={toggleAllVisible} />
						</th>
						<th class="matrix__speaker" scope="col">Speaker</th>
						{#if defs}
							{#each defs as def (def.id)}
								<th class="matrix__task" scope="col">
									<span class="matrix__task-name">{def.name}</span>
									<span class="matrix__due" class:matrix__due--overdue={isDefOverdue(def)}>
										{def.dueRelative}
									</span>
								</th>
							{/each}
						{:else}
							{#each Array(loadingColumns) as _, index (index)}
								<th class="matrix__task" scope="col">
									<span class="matrix__task-name"><span class="ui-skeleton skeleton-line" style="inline-size: 4.5rem"></span></span>
									<span class="matrix__due"><span class="ui-skeleton skeleton-line" style="inline-size: 3rem"></span></span>
								</th>
							{/each}
						{/if}
					</tr>
				</thead>
				<tbody>
					{#if !loaded}
						{#each Array(6) as _, index (index)}
							<!-- Mirrors the resolved matrix row cell-for-cell: the speaker
							     header holds its two lines and every task column keeps its
							     own cell, so the row height comes from the same metrics. -->
							<tr aria-hidden="true">
								<td class="matrix__pick"></td>
								<th class="matrix__speaker-cell" scope="row">
									<span class="ui-table__primary"><strong><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></strong></span>
									<span class="ui-table__secondary"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
								</th>
								{#each Array(loadingColumns) as _cell, cellIndex (cellIndex)}
									<td class="matrix__cell"><span class="cell-trigger ui-skeleton skeleton-mark"></span></td>
								{/each}
							</tr>
						{/each}
					{:else if visibleRows.length === 0}
						<tr class="blank-row">
							<td colspan={columnCount}>
								<div class="blank">
									<p class="blank__title">
										{filter === 'overdue' ? 'Nothing is overdue' : 'Every assignment is settled'}
									</p>
									<p class="blank__copy">
										{filter === 'overdue'
											? 'No speaker has a task past its due date right now.'
											: 'Every assigned task has been completed or waived.'}
									</p>
									<Button variant="secondary" size="sm" onclick={() => setFilter('all')}>
										Show all speakers
									</Button>
								</div>
							</td>
						</tr>
					{:else if defs}
						{#each visibleRows as row (row.speaker.id)}
							{@const Engagement = engagementIcon[row.speaker.state]}
							{@const profile = profiles[row.speaker.email]}
							<tr data-selected={selected.includes(row.speaker.id) ? 'true' : undefined}>
								<td class="matrix__pick">
									{#if row.outstanding > 0}
										<input
											type="checkbox"
											data-pick={row.speaker.id}
											aria-label={`Select ${row.speaker.name} for a reminder`}
											checked={selected.includes(row.speaker.id)}
											onchange={() => toggleSpeaker(row.speaker.id)} />
									{/if}
								</td>
								<th class="matrix__speaker-cell" scope="row">
									<!-- The name is what an operator is already reading when "who is
									     this?" arrives, so once a profile has landed the name answers
									     it in place. A speaker with nothing written about them keeps a
									     plain name rather than a control that opens nothing. -->
									<span class="ui-table__primary"
										><strong
											>{#if profile}<ProfilePeek {profile} />{:else}{row.speaker
													.name}{/if}</strong
										></span>
									<span class="ui-table__secondary">
										<span class="ui-badge {engagementBadge[row.speaker.state]}"
											><Engagement class="ui-badge__icon" aria-hidden="true" />{engagementLabel[
												row.speaker.state
											]}</span
										>
										{row.done} of {row.total} complete{row.waived > 0 ? ` · ${row.waived} waived` : ''}
									</span>
								</th>
								{#each defs as def (def.id)}
									<td class="matrix__cell">{@render cell(def, row.speaker)}</td>
								{/each}
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<div class="cards" class:is-refreshing={reload.visible} aria-busy={refreshing || undefined}>
			{#if !loaded}
				{#each Array(3) as _, index (index)}
					<!-- The card's own composition with skeleton fills: the speaker head
					     and one task row per column, each holding its two lines. -->
					<article class="card" aria-hidden="true">
						<div class="card__head">
							<div class="card__id">
								<p class="card__name sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></p>
								<p class="card__meta"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></p>
							</div>
						</div>
						<ul class="tasks">
							{#each Array(loadingColumns) as _row, rowIndex (rowIndex)}
								<li class="task">
									<div class="task__copy">
										<span class="task__name"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
										<span class="task__due"><span class="ui-skeleton skeleton-line" style="inline-size: 4rem"></span></span>
									</div>
									<div class="task__state"><span class="cell-trigger ui-skeleton skeleton-mark"></span></div>
								</li>
							{/each}
						</ul>
					</article>
				{/each}
			{:else if visibleRows.length === 0}
				<div class="blank blank--card">
					<p class="blank__title">
						{filter === 'overdue' ? 'Nothing is overdue' : 'Every assignment is settled'}
					</p>
					<p class="blank__copy">
						{filter === 'overdue'
							? 'No speaker has a task past its due date right now.'
							: 'Every assigned task has been completed or waived.'}
					</p>
					<Button variant="secondary" size="sm" onclick={() => setFilter('all')}>
						Show all speakers
					</Button>
				</div>
			{:else if defs}
				{#each visibleRows as row (row.speaker.id)}
					{@const Engagement = engagementIcon[row.speaker.state]}
					{@const profile = profiles[row.speaker.email]}
					<article class="card" data-selected={selected.includes(row.speaker.id) ? 'true' : undefined}>
						<div class="card__head">
							{#if row.outstanding > 0}
								<input
									class="card__pick"
									type="checkbox"
									data-pick={row.speaker.id}
									aria-label={`Select ${row.speaker.name} for a reminder`}
									checked={selected.includes(row.speaker.id)}
									onchange={() => toggleSpeaker(row.speaker.id)} />
							{/if}
							<div class="card__id">
								<!-- Same rule as the matrix line: the name carries the profile when
								     there is one, and stays a word when there is not. -->
								<h3 class="card__name">
									{#if profile}<ProfilePeek {profile} />{:else}{row.speaker.name}{/if}
								</h3>
								<p class="card__meta">
									<span class="ui-badge {engagementBadge[row.speaker.state]}"
										><Engagement class="ui-badge__icon" aria-hidden="true" />{engagementLabel[
											row.speaker.state
										]}</span
									>
									{row.done} of {row.total} complete{row.waived > 0 ? ` · ${row.waived} waived` : ''}
								</p>
							</div>
						</div>
						<ul class="tasks">
							{#each defs as def (def.id)}
								<li class="task">
									<div class="task__copy">
										<span class="task__name">{def.name}</span>
										<span class="task__due" class:task__due--overdue={isDefOverdue(def)}>
											{def.dueRelative}
										</span>
									</div>
									<div class="task__state">{@render cell(def, row.speaker)}</div>
								</li>
							{/each}
						</ul>
					</article>
				{/each}
			{/if}
		</div>
	{/if}
</section>

<p class="ui-sr-only" role="status">{announcement}</p>

<CommitReceipt onUndone={reread} />

<Modal bind:open={reminderOpen} title="Send task reminder">
	<p class="reminder__lede">
		{reminderIncluded.length}
		{plural(reminderIncluded.length, 'speaker', 'speakers')} with {reminderOutstanding} outstanding
		{plural(reminderOutstanding, 'task', 'tasks')} will receive this message. Nothing else is sent
		until you commit it here.
	</p>
	<Field id="reminder-subject" label="Subject" required>
		{#snippet children({ id, describedBy })}
			<input class="ui-control" type="text" {id} aria-describedby={describedBy} bind:value={reminderSubject} />
		{/snippet}
	</Field>

	<!-- Who receives this, named; and who does not, with the reason on the row.
	     A selection is not a permission to write to someone. -->
	<ul class="roster">
		{#each reminderRoster as entry (entry.row.speaker.id)}
			<li class="roster__row" class:roster__row--out={entry.reason}>
				<span class="roster__who">
					<span class="roster__name">{entry.row.speaker.name}</span>
					<span class="roster__mail"><CopyValue value={entry.row.speaker.email} label="email address" /></span>
				</span>
				{#if entry.reason}
					<span class="ui-badge ui-badge--warning ui-badge--solid roster__mark">Excluded</span>
					<span class="roster__reason">{entry.reason}</span>
				{:else}
					<span class="roster__detail">
						{entry.row.outstanding} outstanding {plural(entry.row.outstanding, 'task', 'tasks')}
					</span>
				{/if}
			</li>
		{/each}
	</ul>

	{#snippet footer(close)}
		<Button variant="ghost" onclick={close} disabled={sending}>Cancel</Button>
		<Button loading={sending} disabled={reminderIncluded.length === 0} onclick={sendReminder}>
			Send to {reminderIncluded.length}
			{plural(reminderIncluded.length, 'speaker', 'speakers')}
		</Button>
	{/snippet}
</Modal>

<style>
	/* Header numbers: one card per fact, value first so the row scans vertically. */
	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--je-space-3);
	}

	.stat {
		display: grid;
		grid-template-areas:
			'label'
			'value'
			'sub';
		gap: var(--je-space-1);
		min-block-size: 6.75rem;
		align-content: center;
		padding: var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, and a cell mark is the glyph the
	   matrix draws there. Free-standing sized rectangles drift; these cannot. */
	/* A heading's line box without the heading element: the placeholder keeps
	   the leading its resolved heading is given. */
	.sk-head {
		line-height: var(--je-leading-tight);
	}

	.skeleton-line {
		display: inline-block;
		block-size: 1em;
		/* One line box exactly: the line inherits the height it stands in for. */
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	/* Carries the cell trigger's own class, so a pending cell's box sets the
	   height here exactly as it does in the resolved matrix. */
	.skeleton-mark {
		display: inline-block;
		inline-size: 2.75rem;
		vertical-align: bottom;
	}

	.stat__label {
		grid-area: label;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.stat__value {
		grid-area: value;
		font-size: var(--je-font-size-xl);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.stat__value--attention {
		color: var(--je-color-warning);
	}

	.stat__sub {
		grid-area: sub;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.stat__sub--attention {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	.board__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-end: var(--je-space-3);
	}

	.board__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.board__title:focus-visible {
		outline: 2px solid var(--je-color-action);
		outline-offset: var(--je-space-1);
	}

	.board__note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.board__remind {
		margin-inline-start: auto;
	}

	/* The quiet door travels with the action it serves: it takes the push to the
	   end edge, and the button beside it gives up its own so the pair stays
	   together instead of splitting the free space. */
	.board__template {
		margin-inline-start: auto;
		font-size: var(--je-font-size-sm);
	}

	.board__template + .board__remind {
		margin-inline-start: 0;
	}

	/* Matrix: speakers down, task definitions across. */
	.matrix {
		min-inline-size: 55rem;
	}

	.matrix__pick {
		inline-size: 2.25rem;
	}

	.matrix__speaker {
		inline-size: 13rem;
	}

	.matrix__task {
		inline-size: 8rem;
		white-space: normal;
		text-align: center;
	}

	/* Every mark — tick, badge, or empty slot — resolves to the same centre,
	   so a column reads as one spine no matter what fills it. */
	.matrix__cell {
		text-align: center;
	}

	.matrix__task-name {
		display: block;
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		letter-spacing: normal;
		text-transform: none;
		color: var(--je-color-text);
	}

	.matrix__due {
		display: block;
		font-size: var(--je-font-size-2xs);
		font-weight: 400;
		letter-spacing: normal;
		text-transform: none;
		color: var(--je-color-text-muted);
	}

	.matrix__due--overdue {
		color: var(--je-color-warning);
		font-weight: 700;
	}

	/* Row headers stay data-shaped so selection and hover read across the row.
	   Three jobs are stacked here — who (identity), where they stand
	   (lifecycle), how far along (progress). Separating identity from the meta
	   line by one step, and holding the meta line together with a tighter gap,
	   makes the grouping legible without adding any new element. */
	.matrix__speaker-cell {
		display: grid;
		align-content: center;
		row-gap: var(--je-space-1);
		background: transparent;
		color: var(--je-color-text);
		font-size: var(--je-font-size-sm);
		font-weight: 400;
		letter-spacing: normal;
		text-transform: none;
		white-space: normal;
	}

	.matrix__speaker-cell .ui-table__secondary {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-2);
		overflow: visible;
	}

	.cell-done {
		display: inline-flex;
		color: var(--je-color-success);
	}

	.cell-open {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--je-space-1);
	}

	/* Outstanding cells are the only actionable ones, so they carry a resting
	   outline rather than revealing themselves on hover. */
	.cell-trigger {
		display: inline-flex;
		align-items: center;
		min-block-size: 1.5rem;
		padding-inline: var(--je-space-2);
		border: 1px dashed var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		background: transparent;
		cursor: pointer;
		transition:
			background var(--je-duration-fast) var(--je-ease),
			border-color var(--je-duration-fast) var(--je-ease);
	}

	.cell-trigger:hover {
		border-style: solid;
		background: var(--je-color-surface-sunken);
	}

	.cell-trigger:focus-visible {
		outline: none;
		box-shadow: var(--je-focus-ring);
	}

	.cell-trigger--open {
		border-style: solid;
		border-color: var(--je-color-action);
		background: var(--je-color-surface-selected);
	}

	.cell-dash {
		color: var(--je-color-text-subtle);
		font-size: var(--je-font-size-xs);
	}

	.cell-confirm {
		max-inline-size: 100%;
	}

	/* Waiving re-reads the assignments; the board dims in place so the person
	   keeps the row they were working in while the replacement arrives. */
	.board__matrix.is-refreshing tbody,
	.cards.is-refreshing {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	/* Narrow layout only; the matrix owns wide widths. */
	.cards {
		display: none;
	}

	.card {
		display: grid;
		gap: var(--je-space-3);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.card[data-selected='true'] {
		border-color: var(--je-color-action);
		background: var(--je-color-surface-selected);
	}

	/* The pick column keeps its width when a speaker has nothing outstanding, so
	   names stay on one line down the list. */
	.card__head {
		display: grid;
		grid-template-columns: 1.25rem minmax(0, 1fr);
		grid-template-areas: 'pick id';
		align-items: center;
		gap: var(--je-space-3);
	}

	.card__pick {
		grid-area: pick;
	}

	.card__id {
		grid-area: id;
		min-inline-size: 0;
	}

	.card__name {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 650;
	}

	.card__meta {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.tasks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-1);
	}

	.task {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		grid-template-areas: 'copy state';
		align-items: center;
		gap: var(--je-space-2) var(--je-space-3);
		padding-block: var(--je-space-2);
		min-block-size: 2.75rem;
	}

	.task + .task {
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.task__copy {
		grid-area: copy;
		display: grid;
		gap: 0;
		min-inline-size: 0;
	}

	.task__state {
		grid-area: state;
		justify-self: end;
	}

	.task__name {
		font-size: var(--je-font-size-md);
	}

	.task__due {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.task__due--overdue {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	/* The empty row is a message, not a record, so it keeps the plain surface. */
	.matrix tbody tr.blank-row:hover {
		background: transparent;
	}

	.blank {
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
		padding: var(--je-space-6) var(--je-space-2);
	}

	.blank--page,
	.blank--card {
		padding: var(--je-space-8);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.blank__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 650;
	}

	.blank__copy {
		margin: 0 0 var(--je-space-2);
		max-inline-size: 56ch;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.reminder__lede {
		margin: 0 0 var(--je-space-4);
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
	}

	/* The send's evidence: one row per person, exclusions carrying their reason
	   in the same line rather than in a footnote. */
	.roster {
		list-style: none;
		margin: var(--je-space-4) 0 0;
		padding: 0;
	}

	.roster__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		grid-template-areas: 'who detail';
		align-items: center;
		gap: var(--je-space-1) var(--je-space-3);
		padding-block: var(--je-space-2);
	}

	.roster__row + .roster__row {
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.roster__row--out {
		grid-template-areas:
			'who mark'
			'reason reason';
	}

	.roster__who {
		grid-area: who;
		display: grid;
		min-inline-size: 0;
	}

	.roster__name {
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.roster__row--out .roster__name {
		color: var(--je-color-text-muted);
		text-decoration: line-through;
	}

	.roster__mail {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		overflow-wrap: anywhere;
	}

	.roster__detail {
		grid-area: detail;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.roster__mark {
		grid-area: mark;
	}

	.roster__reason {
		grid-area: reason;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-warning);
	}

	@media (max-width: 920px) {
		/* The stat becomes a single wide row: label and detail read left, the
		   number stays on the right edge where the eye returns for it. */
		.stats {
			grid-template-columns: minmax(0, 1fr);
		}

		.stat {
			grid-template-columns: minmax(0, 1fr) max-content;
			grid-template-areas:
				'label value'
				'sub value';
			align-items: center;
			min-block-size: 4rem;
			padding: var(--je-space-3);
		}

		.stat__value {
			align-self: center;
		}

		.board__toolbar {
			border-block-end: 1px solid var(--je-color-border);
			border-radius: var(--je-radius-surface);
		}

		.board__remind,
		.board__template {
			margin-inline-start: 0;
		}

		/* Per-speaker cards replace the matrix; a squeezed grid would carry the
		   same data with none of the meaning. */
		.board__matrix {
			display: none;
		}

		.cards {
			display: grid;
			gap: var(--je-space-3);
			margin-block-start: var(--je-space-3);
		}

		/* Touch-safe control sizes regardless of the desktop density. */
		.card__pick {
			inline-size: 1.25rem;
			block-size: 1.25rem;
		}

		.cell-open {
			align-items: flex-end;
		}

		.cell-trigger {
			min-block-size: 2.25rem;
			padding-inline: var(--je-space-3);
		}
	}
</style>
