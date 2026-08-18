<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ChevronDown, TriangleAlert } from 'lucide-svelte';
	import {
		Badge,
		CopyValue,
		Field,
		Modal,
		Popover,
		revealTarget,
		shouldIgnoreRowPress,
		situationIcon,
		statusIcon
	} from '$lib/ui';
	import type { ReviewersPagePort } from '$lib/api/reviewers-page-port';
	import type { ReminderPreview } from '$lib/api/tasks-page-port';
	import RecipientEmailPeek from '$lib/features/workspace/components/RecipientEmailPeek.svelte';
	import VerbatimBodyPeek from '$lib/features/workspace/components/VerbatimBodyPeek.svelte';
	import { LiveRead, type LiveReadState } from '$lib/api/live-read';
	import {
		applyParams,
		clearParams,
		param,
		paramIn
	} from '$lib/features/workspace/url-state.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { sessionCoveredBy } from '$lib/api/reviewers';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import ScopeChip from '$lib/features/workspace/components/ScopeChip.svelte';
	import type {
		EventTheme,
		Format,
		Reviewer,
		ReviewerRoster,
		ReviewerStatus,
		ScopeRef,
		SessionItem,
		Track,
		UncoveredReview
	} from '$lib/api/types';
	import CoveragePanel from './CoveragePanel.svelte';
	import InviteReviewersModal from './InviteReviewersModal.svelte';
	import ScopeChips from './ScopeChips.svelte';
	import ScopePicker from './ScopePicker.svelte';
	import { parseScopeParam, resolveRef, resolveScope, scopeKey } from './scope-display';
	import { reviewReminderBatch } from './reminder-batch';

	interface Props {
		port: ReviewersPagePort;
	}

	let { port }: Props = $props();
	const api = $derived(port);
	const reminderAvailability = $derived(api.tasks.reminderAvailability);
	const remindersAvailable = $derived(reminderAvailability.kind === 'available');

	type FilterKey = 'all' | 'invited' | 'needs-cover';

	// The roster is this surface's spine; the scope vocabulary is what the chips
	// and the scope editor resolve refs against. They are two reads with two
	// owners, so they are held apart: a composition that cannot serve scope
	// targets must not blank the roster, which was exactly the old failure —
	// one rejected read in a joined `Promise.all` left every row a skeleton
	// with nothing still on its way.
	let rosterState = $state<LiveReadState<ReviewerRoster>>({ kind: 'resolving' });
	const rosterRead = new LiveRead<ReviewerRoster>({
		read: () => api.reviewers.list(),
		fallback: 'The reviewer roster could not be loaded.',
		onChange: (state) => (rosterState = state)
	});
	const roster = $derived(rosterState.kind === 'resolved' ? rosterState.value : null);

	type ScopeVocabulary = {
		readonly tracks: Track[];
		readonly formats: Format[];
		readonly sessions: SessionItem[];
	};

	let vocabularyState = $state<LiveReadState<ScopeVocabulary>>({ kind: 'resolving' });
	const vocabularyRead = new LiveRead<ScopeVocabulary>({
		read: async () => {
			const [trackList, formatList, schedule] = await Promise.all([
				api.vocab.tracks(),
				api.vocab.formats(),
				api.schedule.state()
			]);
			return {
				tracks: trackList,
				formats: formatList,
				// Collecting and programmed sessions are scope targets; a draft slot
				// stays organizer-only and is never offered.
				sessions: schedule.sessions.filter(
					(session) => session.state === 'collecting' || session.state === 'programmed'
				)
			};
		},
		fallback: 'Scope targets could not be loaded.',
		onChange: (state) => (vocabularyState = state)
	});
	const vocabulary = $derived(
		vocabularyState.kind === 'resolved' ? vocabularyState.value : null
	);
	/** Empty until served: an unresolved vocabulary offers no target, never a wrong one. */
	const tracks = $derived(vocabulary?.tracks ?? []);
	const formats = $derived(vocabulary?.formats ?? []);
	const sessions = $derived(vocabulary?.sessions ?? []);
	let expandedId = $state<string | null>(null);
	/** The expanded row's scope draft; applied as one consequential write. */
	let draft = $state<ScopeRef[]>([]);
	let scopeError = $state('');
	let busyId = $state<string | null>(null);
	let inviteOpen = $state(false);
	let removeOpen = $state(false);
	let removeTarget = $state<Reviewer | null>(null);
	let announcement = $state('');
	let remindingId = $state<string | null>(null);
	let remindedIds = $state<string[]>([]);
	let selectedIds = $state<string[]>([]);
	let replacementOpen = $state(false);
	let acceptCoverageOpen = $state(false);
	let vacancyTarget = $state<UncoveredReview | null>(null);
	let replacementReviewerId = $state('');
	let vacancyBusy = $state(false);
	let vacancyError = $state('');

	const filterKeys = ['all', 'invited', 'needs-cover'] as const;

	/** The roster's filter is shareable state, so it lives in the address. */
	const filter = $derived(paramIn('filter', filterKeys, 'all'));

	const filters: { key: FilterKey; label: string }[] = [
		{ key: 'all', label: 'All' },
		{ key: 'invited', label: 'Invited' },
		/* This view isolates reviewers whose assigned work still needs coverage. */
		{ key: 'needs-cover', label: 'Need another reviewer' }
	];

	/* The same states, names, and tones the Settings member list uses: a
	   reviewer is a workspace member, so one state keeps one name. */
	const statusBadge: Record<ReviewerStatus, { label: string; tone: 'success' | 'info' }> = {
		active: { label: 'Active', tone: 'success' },
		invited: { label: 'Invited', tone: 'info' }
	};

	const entities = $derived({ tracks, formats, sessions });

	/**
	 * A deep filter by scope entity: `?scope=track:trk-ai` shows the reviewers
	 * holding that ref. A session address widens to implied coverage — the
	 * reviewers whose scope covers the session through its own ref, its track,
	 * or its format — because that is the population the coverage door counted:
	 * the number on the door and the list behind it must agree. Generalists
	 * deliberately stay out — the empty state answers with the generalist count
	 * instead of pretending they are scoped.
	 */
	const scopeRef = $derived(parseScopeParam(param('scope')));
	const scopeLabel = $derived(scopeRef ? resolveRef(scopeRef, entities).label : null);

	function inScope(row: Reviewer): boolean {
		if (!scopeRef) return true;
		if (scopeRef.kind === 'session') {
			const session = sessions.find((entry) => entry.id === scopeRef.id);
			if (session) return sessionCoveredBy(row.scope, session);
		}
		return row.scope.some((ref) => ref.kind === scopeRef.kind && ref.id === scopeRef.id);
	}

	function matchesFilter(row: Reviewer, key: FilterKey): boolean {
		if (key === 'invited') return row.status === 'invited';
		// Uncovered work only: a step-back someone else already picked up is
		// history, and the roster is a work surface.
		if (key === 'needs-cover') return row.awaitingReassignment > 0;
		return true;
	}

	const reviewers = $derived(roster?.reviewers ?? []);
	const scoped = $derived(reviewers.filter(inScope));
	const filtered = $derived(scoped.filter((row) => matchesFilter(row, filter)));
	const counts = $derived<Record<FilterKey, number>>({
		all: scoped.length,
		invited: scoped.filter((row) => row.status === 'invited').length,
		'needs-cover': scoped.filter((row) => row.awaitingReassignment > 0).length
	});
	const activeCount = $derived(reviewers.filter((row) => row.status === 'active').length);
	const visibleIds = $derived(remindersAvailable ? filtered.map((row) => row.id) : []);
	const selectedRows = $derived(
		reviewers.filter((row) => selectedIds.includes(row.id))
	);
	const allVisibleSelected = $derived(
		visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
	);

	/** Re-read after a write: always a fresh request, and the newest one wins. */
	async function load() {
		await rosterRead.refresh();
		pruneSelection();
	}

	function pruneSelection() {
		const known = new Set(reviewers.map((row) => row.id));
		selectedIds = selectedIds.filter((id) => known.has(id));
	}

	function isSelected(id: string): boolean {
		return selectedIds.includes(id);
	}

	function toggleSelected(id: string, chosen: boolean) {
		selectedIds = chosen
			? [...new Set([...selectedIds, id])]
			: selectedIds.filter((entry) => entry !== id);
	}

	function toggleAllVisible() {
		if (allVisibleSelected) {
			const hidden = new Set(visibleIds);
			selectedIds = selectedIds.filter((id) => !hidden.has(id));
			return;
		}
		selectedIds = [...new Set([...selectedIds, ...visibleIds])];
	}

	function clearSelection() {
		selectedIds = [];
	}

	let retryingRoster = $state(false);
	async function retryRoster() {
		retryingRoster = true;
		try {
			// The scope vocabulary may have failed with it; one visible retry is
			// the person's whole answer to "this surface didn't load".
			await Promise.all([
				rosterRead.refresh(),
				vocabularyState.kind === 'unavailable' ? vocabularyRead.refresh() : Promise.resolve()
			]);
		} finally {
			retryingRoster = false;
		}
	}

	onMount(() => {
		// Both reads start together and land independently. Neither awaits the
		// other, so neither can hold the other hostage.
		void rosterRead.read();
		void vocabularyRead.read();
	});

	function switchFilter(next: FilterKey) {
		if (filter === next) return;
		expandedId = null;
		// One navigation: a filter pass replaces whatever single reviewer the
		// address was scoped to, and both facts change together.
		applyParams({ filter: next === 'all' ? null : next, reviewer: null });
	}

	function clearScope() {
		void clearParams(['scope'], { history: 'push' });
	}

	function startDraft(id: string) {
		const row = reviewers.find((entry) => entry.id === id);
		draft = row ? row.scope.map((ref) => ({ ...ref })) : [];
		scopeError = '';
	}

	function toggleRow(id: string) {
		if (expandedId === id) {
			expandedId = null;
		} else {
			expandedId = id;
			startDraft(id);
		}
		// The address named one reviewer; the moment the operator opens or closes
		// a row themselves, what is showing is theirs rather than the link's.
		if (askedReviewer && askedReviewer !== expandedId) {
			void clearParams(['reviewer'], { history: 'push' });
		}
	}

	/**
	 * The row is a bigger door to the same detail, for the pointer only. The
	 * chevron stays the one focusable switch carrying `aria-expanded`, so the
	 * accessible tree gains nothing to disambiguate and the keyboard path is
	 * exactly what it was. The press routes through `toggleRow`, so opening by
	 * row seeds the scope draft and hands back a `?reviewer=` arrival exactly
	 * as the chevron does. Which presses belong to the row's own controls — or
	 * to a text selection — is the shared row-press contract in `$lib/ui`.
	 */
	function onRowPress(event: MouseEvent, id: string) {
		if (shouldIgnoreRowPress(event)) return;
		toggleRow(id);
	}

	/**
	 * Arriving from elsewhere: `?reviewer=` lands on that person's row — open,
	 * scrolled to, and marked — so a link handed over by the review plan keeps
	 * its promise instead of dropping someone at the top of a list to search.
	 */
	const askedReviewer = $derived(param('reviewer'));

	// A plain let, deliberately outside the graph: it records which arrival has
	// already been answered, so a repaint cannot steal focus back a second time.
	let revealedReviewer: string | null = null;

	$effect(() => {
		const id = askedReviewer;
		const ready = roster;
		if (!ready || !id) {
			revealedReviewer = null;
			return;
		}
		if (revealedReviewer === id) return;
		revealedReviewer = id;
		const row = ready.reviewers.find((entry) => entry.id === id);
		if (!row) return;
		expandedId = id;
		startDraft(id);
		announcement = `${row.name} — their reviewer row is open.`;
		void showRow(row);
	});

	async function showRow(row: Reviewer) {
		// A filter the link never asked for can hide the row it did ask for, so
		// the roster widens rather than landing on an empty state.
		if (!matchesFilter(row, filter) || !inScope(row)) {
			await applyParams({ filter: null, scope: null });
		}
		await tick();
		// The roster renders twice — a table and, below a breakpoint, cards —
		// and only one of the two is laid out; the arrival goes to whichever is
		// actually on screen.
		const shown = Array.from(
			document.querySelectorAll<HTMLElement>(`[data-reviewer="${row.id}"]`)
		).find((element) => element.offsetWidth > 0);
		revealTarget(shown ?? null);
	}

	// ------------------------------------------------------------------ scope

	function draftEquals(row: Reviewer): boolean {
		const a = draft.map(scopeKey).sort().join('|');
		const b = row.scope.map(scopeKey).sort().join('|');
		return a === b;
	}

	function toggleDraftRef(ref: ScopeRef) {
		const key = scopeKey(ref);
		draft = draft.some((entry) => scopeKey(entry) === key)
			? draft.filter((entry) => scopeKey(entry) !== key)
			: [...draft, ref];
		scopeError = '';
	}

	function scopeReceiptLabel(row: Reviewer, next: ScopeRef[]): string {
		if (next.length === 0) return `Cleared ${row.name}’s scope — they review everything`;
		const head = resolveRef(next[0], entities).label;
		const rest = next.length - 1;
		return `Scoped ${row.name} to ${head}${rest > 0 ? ` and ${rest} more` : ''}`;
	}

	async function applyScope(row: Reviewer) {
		const next = draft.map((ref) => ({ ...ref }));
		busyId = row.id;
		try {
			const outcome = await api.reviewers.setScope(row.id, next);
			if (!outcome.ok) {
				scopeError = outcome.reason;
				return;
			}
			const label = scopeReceiptLabel(row, next);
			recordAction({ label, area: 'Reviewers' });
			await load();
			announcement = `${label}.`;
		} finally {
			busyId = null;
		}
	}

	function resetDraft(row: Reviewer) {
		draft = row.scope.map((ref) => ({ ...ref }));
		scopeError = '';
	}

	// ----------------------------------------------------------------- roster

	function openRemove(row: Reviewer) {
		removeTarget = row;
		removeOpen = true;
	}

	async function confirmRemove() {
		const target = removeTarget;
		if (!target || !roster) return;
		removeOpen = false;
		busyId = target.id;
		try {
			await api.reviewers.remove(target.id);
			recordAction({
				label: `Removed ${target.name} from the reviewer roster`,
				area: 'Reviewers',
				undo: () => api.reviewers.restore(target.id)
			});
			expandedId = null;
			await load();
			announcement = `${target.name} is off the reviewer roster.`;
		} finally {
			busyId = null;
			removeTarget = null;
		}
	}

	function onInvited(added: number) {
		void load();
		announcement = `${added} reviewer ${added === 1 ? 'invitation' : 'invitations'} recorded.`;
	}

	/**
	 * The sentence behind the uncovered badge, in the chair's order: what is
	 * uncovered, then why it came free. Loads here are sums across plans, so
	 * the wording claims no single plan.
	 */
	function coverageGap(row: Reviewer): string {
		const gap = row.awaitingReassignment;
		const covered = row.steppedBack - gap;
		const reviews = `${gap} ${gap === 1 ? 'review' : 'reviews'}`;
		const carried = covered > 0 ? ` The other ${covered} already moved to another reviewer.` : '';
		return `${reviews} nobody is covering. ${row.name} stepped back from ${row.steppedBack} because of a conflict of interest — they know or work with the submitter.${carried} Uncovered reviews stay in their assigned count until someone picks them up or you accept the current coverage.`;
	}

	function replacementName(reviewerId: string): string {
		return reviewers.find((reviewer) => reviewer.id === reviewerId)?.name ?? reviewerId;
	}

	function openReplacement(entry: UncoveredReview) {
		vacancyTarget = entry;
		replacementReviewerId = entry.replacementCandidates?.find((candidate) => candidate.scopeMatch)?.reviewerId ?? '';
		vacancyError = '';
		replacementOpen = true;
	}

	function openAcceptCoverage(entry: UncoveredReview) {
		vacancyTarget = entry;
		vacancyError = '';
		acceptCoverageOpen = true;
	}

	async function confirmReplacement() {
		const target = vacancyTarget;
		if (!target?.assignmentId || target.assignmentVersion === undefined || !replacementReviewerId) return;
		vacancyBusy = true;
		vacancyError = '';
		try {
			const outcome = await api.reviewers.assignReplacement({
				assignmentId: target.assignmentId,
				expectedAssignmentVersion: target.assignmentVersion,
				reviewerId: replacementReviewerId
			});
			if (!outcome.ok) {
				vacancyError = outcome.reason;
				return;
			}
			const name = replacementName(replacementReviewerId);
			recordAction({ label: `Assigned ${name} to “${target.title}”`, area: 'Reviewers' });
			replacementOpen = false;
			await load();
			announcement = `${name} now covers “${target.title}”.`;
			vacancyTarget = null;
		} finally {
			vacancyBusy = false;
		}
	}

	async function confirmAcceptCoverage() {
		const target = vacancyTarget;
		if (!target?.assignmentId || target.assignmentVersion === undefined) return;
		vacancyBusy = true;
		vacancyError = '';
		try {
			const outcome = await api.reviewers.acceptCoverage({
				assignmentId: target.assignmentId,
				expectedAssignmentVersion: target.assignmentVersion
			});
			if (!outcome.ok) {
				vacancyError = outcome.reason;
				return;
			}
			recordAction({ label: `Accepted current review coverage for “${target.title}”`, area: 'Reviewers' });
			acceptCoverageOpen = false;
			await load();
			announcement = `Current review coverage accepted for “${target.title}”.`;
			vacancyTarget = null;
		} finally {
			vacancyBusy = false;
		}
	}

	/**
	 * What one uncovered review costs the submission it came off, graded by the
	 * evidence the entry carries. Three states, in the order a chair ranks them:
	 *
	 * - nobody else holds it, so review of it has stopped — the sharp one;
	 * - every other assigned review is already committed, so the submission is
	 *   read and the open slot is information, not a problem;
	 * - otherwise it is still moving but short, and the committed count says how
	 *   short.
	 *
	 * Stopped is tested first: a submission handed to one reviewer alone also
	 * satisfies "every other review is in" arithmetically, and reading that as
	 * settled would announce a stalled submission as fine.
	 *
	 * An absent remaining count claims none of them — the composition did not
	 * count coverage, so the title stands on its own rather than borrowing a zero.
	 */
	function uncoveredConsequence(entry: UncoveredReview): string {
		const remaining = entry.remainingReviewers;
		if (remaining === undefined) return '';
		if (remaining === 0) return 'has nobody else reviewing it — review of this submission has stopped';
		const reviews = entry.reviewsIn;
		if (reviews && reviews.committed === reviews.planned - 1) {
			return `${reviews.committed} of ${reviews.planned} reviews are in — only this slot is open`;
		}
		const held = `still has ${remaining} other ${remaining === 1 ? 'reviewer' : 'reviewers'} on it`;
		if (!reviews) return held;
		if (reviews.committed === 0) return `${held} — none committed yet`;
		return `${held} — ${reviews.committed} ${reviews.committed === 1 ? 'review' : 'reviews'} in`;
	}

	/**
	 * The spoken form of the same panel: the gap sentence, then every named
	 * review with its consequence, so the sharp fact reaches the live region on
	 * the press that reveals it rather than only the eye.
	 */
	function coverageAnnouncement(row: Reviewer): string {
		const named = (row.uncovered ?? []).map((entry) => {
			const consequence = uncoveredConsequence(entry);
			return consequence ? `“${entry.title}” ${consequence}.` : `“${entry.title}”.`;
		});
		return [coverageGap(row), ...named].join(' ');
	}

	function isBehind(row: Reviewer): boolean {
		return row.status === 'active' && row.assigned > 0 && row.done / row.assigned < 0.5;
	}

	// ------------------------------------------------------------ the reminder

	/**
	 * A reminder is an email to a person, so it gets a ceremony: who it goes to,
	 * the subject as it will read, and the body itself before anything is sent.
	 * A send that happened on one press was a send nobody had seen.
	 */
	const REMINDER_SUBJECT = 'Review reminder';

	let remindTargets = $state<Reviewer[]>([]);
	let remindOpen = $state(false);
	let remindSubject = $state(REMINDER_SUBJECT);
	let remindPreview = $state.raw<ReminderPreview | null>(null);
	let remindError = $state('');
	let theme = $state.raw<EventTheme | null>(null);
	const remindBatch = $derived(reviewReminderBatch(remindTargets));

	function openRemind(rows: Reviewer[]) {
		if (!remindersAvailable || remindingId || rows.length === 0) return;
		remindTargets = rows;
		remindSubject = REMINDER_SUBJECT;
		remindPreview = null;
		remindError = '';
		remindOpen = true;
		// Asked of the sending lane, so the words on screen are the words it mails.
		void api.tasks.reminderPreview?.().then(
			(next) => (remindPreview = next),
			() => (remindPreview = null)
		);
		void api.theme?.get().then(
			(brand) => (theme = brand),
			() => (theme = null)
		);
	}

	async function confirmRemind() {
		const recipients = remindBatch.included.map((entry) => entry.reviewer);
		if (recipients.length === 0 || remindingId) return;
		remindingId = recipients[0]!.id;
		remindError = '';
		try {
			await api.tasks.remind(
				recipients.map((row) => row.id),
				remindSubject.trim() || REMINDER_SUBJECT
			);
			remindedIds = [...new Set([...remindedIds, ...recipients.map((row) => row.id)])];
			announcement =
				recipients.length === 1
					? `Review reminder sent to ${recipients[0]!.name}.`
					: `Review reminder sent to ${recipients.length} reviewers.`;
			remindOpen = false;
			if (selectedIds.length > 0) selectedIds = [];
		} catch (error) {
			remindError =
				error instanceof Error ? error.message : 'The review reminder could not be sent.';
			announcement = remindError;
		} finally {
			remindingId = null;
		}
	}
</script>

{#snippet status(row: Reviewer)}
	{@const badge = statusBadge[row.status]}
	<Badge tone={badge.tone}>{badge.label}</Badge>
{/snippet}

{#snippet scopeCell(row: Reviewer, allLabel: string)}
	<!-- Stored refs only — the minimal truth. Sessions a track or format ref
	     implies are derived where they are needed (editor, coverage), never
	     minted into chips. -->
	<ScopeChips entries={resolveScope(row.scope, entities)} {allLabel} />
{/snippet}

{#snippet coverageWhy(row: Reviewer)}
	<!-- The chair's order kept: what is uncovered and why it came free, then
	     which reviews those are. The list is the part the count cannot carry.
	     Only a stopped submission inks — a slot open on one every other reviewer
	     has already reviewed is information, and a warning voice there would
	     spend attention on something nothing is owed on. -->
	<p class="load__why">{coverageGap(row)}</p>
	{#if row.uncovered && row.uncovered.length > 0}
		<ul class="gap">
			{#each row.uncovered as entry (entry.submissionId)}
				{@const consequence = uncoveredConsequence(entry)}
				<li class="gap__item">
					<span class="gap__title">{entry.title}</span>
					{#if consequence}
						<span class="gap__said" class:gap__said--stopped={entry.remainingReviewers === 0}>
							{consequence}
						</span>
					{/if}
					{#if entry.assignmentId && entry.assignmentVersion !== undefined}
						<span class="gap__actions">
							<button
								type="button"
								class="ui-button ui-button--secondary ui-button--sm"
								onclick={() => openReplacement(entry)}>Assign reviewer</button>
							<button
								type="button"
								class="ui-button ui-button--ghost ui-button--sm"
								onclick={() => openAcceptCoverage(entry)}>Accept coverage</button>
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet loadCell(row: Reviewer)}
	{#if row.assigned > 0}
		<span class="load__count">{row.done} / {row.assigned}</span>
		<span class="ui-progress__track load__bar" aria-hidden="true">
			<span class="ui-progress__value" style:transform="scaleX({row.done / row.assigned})"></span>
		</span>
		{#if row.awaitingReassignment > 0}
			<!-- Rendered only while uncovered: covered step-backs are biography,
			     and the uncovered reviews stay inside this row's assigned count —
			     the denominator never moves when someone steps back. -->
			<span class="load__gap">
				<Popover
					label="{row.awaitingReassignment} need another reviewer — why"
					onreveal={() => (announcement = coverageAnnouncement(row))}>
					{#snippet trigger()}
						<Badge tone="warning" icon={statusIcon.needsReviewer}>
							{row.awaitingReassignment} need another reviewer
						</Badge>
					{/snippet}
					{#snippet children()}
						{@render coverageWhy(row)}
					{/snippet}
				</Popover>
			</span>
		{/if}
	{:else}
		<span class="load__none">Nothing assigned</span>
	{/if}
	{#if remindersAvailable && remindedIds.includes(row.id)}
		<span class="load__sent">Reminder sent</span>
	{:else if remindersAvailable && isBehind(row)}
		<button
			type="button"
			class="ui-button ui-button--secondary ui-button--sm load__remind"
			disabled={remindingId !== null}
			aria-busy={remindingId === row.id}
			onclick={() => openRemind([row])}>Remind</button>
	{/if}
{/snippet}

{#snippet detail(row: Reviewer)}
	<!-- The editor is what this expansion is for, so it takes the full width
	     and leads; roster removal is real but rare, and sits demoted in the
	     quiet footer row below — destructive voice kept, ceremony unchanged. -->
	<div class="detail">
		<div class="detail__main">
			<h3 class="detail__heading">What they review</h3>
			{#if draft.length === 0}
				<!-- The heading asks; this answers — derived from the draft, the same
				     value the picker marks, so the words and the chips can never
				     disagree mid-edit. Words at full presence, never a minted chip:
				     generalist stays the absence of scope. -->
				<p class="detail__fact">Everything</p>
			{/if}
			<p class="detail__hint">
				A submission lands in their queue when it matches any selection — that set is the
				reviewer’s scope. With nothing selected they review everything: every submission in each
				plan they join.
			</p>
			{#if vocabularyState.kind === 'unavailable'}
				<!-- No picker at all rather than an empty one: a picker with no
				     options states "this event has no tracks, formats, or sessions",
				     which is a different and false claim. -->
				<p class="detail__error" role="status">
					{vocabularyState.message} Scope can’t be edited until they load.
				</p>
			{:else if vocabulary}
				<ScopePicker {tracks} {formats} {sessions} selected={draft} ontoggle={toggleDraftRef} />
			{:else}
				<p class="detail__hint" role="status">Loading scope targets…</p>
			{/if}
			{#if scopeError}
				<p class="detail__error" role="alert">{scopeError}</p>
			{/if}
			<div class="detail__actions">
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					disabled={busyId !== null || draftEquals(row)}
					aria-busy={busyId === row.id}
					onclick={() => applyScope(row)}>Apply scope</button>
				{#if !draftEquals(row)}
					<button
						type="button"
						class="ui-button ui-button--ghost ui-button--sm"
						disabled={busyId !== null}
						onclick={() => resetDraft(row)}>Reset</button>
					<!-- The condition, stated where it resolves: the roster row above
					     and this editor deliberately disagree while a draft is open,
					     and this line is the sentence that reconciles them. -->
					<p class="detail__pending" role="status">
						Not applied yet — the roster still shows {row.name}’s saved scope.
					</p>
				{/if}
			</div>
		</div>
		<div class="detail__footer">
			<p class="detail__footer-copy">
				Removing {row.name} takes them off this roster only: reviews they committed stay, and
				anything still assigned to them keeps counting until another reviewer covers it. Their
				workspace membership is managed in Settings.
			</p>
			<button
				type="button"
				class="ui-button ui-button--danger ui-button--sm"
				disabled={busyId !== null}
				onclick={() => openRemove(row)}>Remove from roster</button>
		</div>
	</div>
{/snippet}

<div class="head">
	<nav class="chips" aria-label="Reviewer filters">
		{#each filters as entry (entry.key)}
			<button
				type="button"
				class="chips__tab"
				class:chips__tab--active={filter === entry.key}
				aria-pressed={filter === entry.key}
				onclick={() => switchFilter(entry.key)}>
				{entry.label}
				<span
					class="chips__count"
					class:chips__count--attention={entry.key === 'needs-cover' && counts['needs-cover'] > 0}
					>{roster ? counts[entry.key] : '–'}</span>
			</button>
		{/each}
	</nav>
	<button
		type="button"
		class="ui-button ui-button--secondary ui-button--sm head__invite"
		onclick={() => (inviteOpen = true)}>
		Invite reviewers
	</button>
	<p class="head__note">
		Scope narrows what lands in a reviewer’s queue — never what a plan lets them see. Loads count
		every review plan together.
	</p>
</div>

{#if roster && scopeRef}
	<ScopeChip label={`Scoped to ${scopeLabel}`} onclear={clearScope} />
{/if}

{#if reminderAvailability.kind === 'unavailable'}
	<p class="reminder-availability" role="status">{reminderAvailability.reason}</p>
{/if}

<section aria-label="Reviewer roster">
	{#if rosterState.kind === 'unavailable' && rosterState.retryable}
		<!-- The read answered, and its answer was "no". Skeleton rows here would
		     promise a roster that is not on its way. -->
		<div class="panel" role="alert">
			<span class="panel__mark" aria-hidden="true"><TriangleAlert size={22} /></span>
			<p class="panel__title">The reviewer roster could not be loaded</p>
			<p class="panel__copy">{rosterState.message}</p>
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				aria-busy={retryingRoster || undefined}
				disabled={retryingRoster}
				onclick={retryRoster}>Try again</button>
		</div>
	{:else if rosterState.kind === 'unavailable'}
		<!-- Not bound in this composition: retrying reaches the same absence. That
		     is a fact about the workspace, not a failure this person caused or can
		     repair, so it takes neither the alarm glyph, the assertive live region,
		     nor a retry that would only re-answer "no". -->
		{@const Situation = statusIcon.notConfigured}
		<div class="panel">
			<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
			<p class="panel__title">The reviewer roster is not available here</p>
			<p class="panel__copy">{rosterState.message}</p>
		</div>
	{:else if roster && filtered.length === 0}
		<div class="panel">
			{#if reviewers.length === 0}
				{@const Situation = situationIcon.emptyRoster}
				<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">No reviewers yet</p>
				<p class="panel__copy">
					Reviewers are workspace members with review access. Invite them by email here — each one
					reviews everything until you narrow their scope to tracks, formats, or sessions.
				</p>
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					onclick={() => (inviteOpen = true)}>Invite reviewers</button>
			{:else if scopeRef && scoped.length === 0}
				{@const Situation = situationIcon.filteredEmpty}
				<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">Nobody is scoped to {scopeLabel}</p>
				<p class="panel__copy">
					{#if roster.generalists > 0}
						{roster.generalists}
						{roster.generalists === 1 ? 'generalist still reviews' : 'generalists still review'}
						everything, this included. Scope someone here from their row, or invite a reviewer with
						this as their initial scope.
					{:else}
						No generalists cover it either. Scope someone from their row, or invite a reviewer
						with this as their initial scope.
					{/if}
				</p>
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					onclick={clearScope}>Show all reviewers</button>
			{:else if filter === 'needs-cover'}
				{@const Situation = situationIcon.allClear}
				<span class="panel__mark panel__mark--clear" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">Nothing needs covering</p>
				<p class="panel__copy">
					No reviews are waiting on another reviewer across {scoped.length}
					{scoped.length === 1 ? 'reviewer' : 'reviewers'}.
				</p>
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					onclick={() => switchFilter('all')}>Show the full roster</button>
			{:else}
				{@const Situation = situationIcon.filteredEmpty}
				<span class="panel__mark" aria-hidden="true"><Situation size={22} /></span>
				<p class="panel__title">No open invitations</p>
				<p class="panel__copy">
					Everyone on the roster has arrived. Inviting more reviewers adds them here.
				</p>
				<button
					type="button"
					class="ui-button ui-button--secondary ui-button--sm"
					onclick={() => switchFilter('all')}>Show the full roster</button>
			{/if}
		</div>
	{:else}
		<div class="ui-table-wrap roster__table">
			<table class="ui-table ui-table--multiline">
				<thead>
					<tr>
						{#if remindersAvailable}
							<th class="col-select">
								<input
									type="checkbox"
									aria-label="Select all shown reviewers"
									disabled={!roster || visibleIds.length === 0}
									checked={allVisibleSelected}
									onchange={toggleAllVisible} />
							</th>
						{/if}
						<th class="col-reviewer">Reviewer</th>
						<th class="col-status">Status</th>
						<th>Reviews</th>
						<th class="col-load ui-table__number">Done</th>
						<th class="col-expand"><span class="ui-sr-only">Details</span></th>
					</tr>
				</thead>
				<tbody>
					{#if !roster}
						{#each Array(5) as _, index (index)}
							<!-- Mirrors the resolved multiline row cell-for-cell, so the row
							     height is set by the same table metrics as real rows. -->
							<tr aria-hidden="true">
								{#if remindersAvailable}
									<td class="col-select"><span class="ui-skeleton skeleton-action--icon"></span></td>
								{/if}
								<td class="col-reviewer">
									<span class="ui-table__primary"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
									<span class="ui-table__secondary"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></span>
								</td>
								<td><span class="ui-skeleton skeleton-chip skeleton-chip--narrow"></span></td>
								<td><span class="ui-skeleton skeleton-chip"></span></td>
								<td class="ui-table__number">
									<span class="load__count"><span class="ui-skeleton skeleton-line" style="inline-size: 2.5rem"></span></span>
									<span class="ui-progress__track load__bar"></span>
								</td>
								<td class="col-expand"><span class="ui-skeleton skeleton-action--icon"></span></td>
							</tr>
						{/each}
					{:else}
						{#each filtered as row (row.id)}
							<!-- The pointer target is the row; the switch is still the chevron
							     inside it, which is why no role or tabindex is added here. -->
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<!-- `data-arrival-host`: the mark for `?reviewer=` belongs to the
							     whole row, which is what the eye reads as "this person" —
							     the anchor inside it only says where to land. -->
							<tr
								class="row"
								class:is-open={expandedId === row.id}
								data-arrival-host
								onclick={(event) => onRowPress(event, row.id)}>
								{#if remindersAvailable}
									<td class="col-select">
										<input
											type="checkbox"
											aria-label={`Select ${row.name}`}
											checked={isSelected(row.id)}
											onchange={(event) => toggleSelected(row.id, event.currentTarget.checked)} />
									</td>
								{/if}
								<td class="col-reviewer">
									<!-- The arrival anchor for `?reviewer=`: the scroll and the caret
									     stop on the name, so a table scrolled sideways still opens on
									     the column the link was about. -->
									<div class="who" data-reviewer={row.id}>
										<span class="ui-table__primary"><strong>{row.name}</strong></span>
										{#if row.email}
											<span class="ui-table__secondary"
												><CopyValue value={row.email} label="email address" /></span>
										{/if}
									</div>
								</td>
								<td>{@render status(row)}</td>
								<!-- Under the "Reviews" header, "Everything" completes the
								     sentence the column started. -->
								<td>{@render scopeCell(row, 'Everything')}</td>
								<td class="ui-table__number">{@render loadCell(row)}</td>
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
									<td colspan={remindersAvailable ? 6 : 5}>{@render detail(row)}</td>
								</tr>
							{/if}
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Narrow composition: the same roster restructured so name, status, and
		     the disclosure never compete for one crushed line. -->
		<ul class="roster__cards">
			{#if !roster}
				{#each Array(4) as _, index (index)}
					<li class="card" aria-hidden="true">
						<div class="card__head" class:card__head--no-pick={!remindersAvailable}>
							{#if remindersAvailable}
								<span class="card__pick ui-skeleton skeleton-action--icon"></span>
							{/if}
							<span class="card__copy">
								<span class="card__name"><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
								<span class="card__email"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></span>
							</span>
							<span class="card__toggle ui-skeleton skeleton-action--icon"></span>
							<span class="card__tags">
								<span class="ui-skeleton skeleton-chip skeleton-chip--narrow"></span>
								<span class="ui-skeleton skeleton-chip"></span>
							</span>
						</div>
					</li>
				{/each}
			{:else}
				{#each filtered as row (row.id)}
					<li class="card" data-reviewer={row.id}>
						<!-- The whole summary — everything above the expanded editor — is
						     the door; the toggle inside it stays the one focusable switch,
						     which is why no role or tabindex is added here. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="card__head card__head--door"
							class:card__head--no-pick={!remindersAvailable}
							onclick={(event) => onRowPress(event, row.id)}>
							{#if remindersAvailable}
								<label class="card__pick">
									<input
										type="checkbox"
										aria-label={`Select ${row.name}`}
										checked={isSelected(row.id)}
										onchange={(event) => toggleSelected(row.id, event.currentTarget.checked)} />
								</label>
							{/if}
							<span class="card__copy">
								<span class="card__name">{row.name}</span>
								{#if row.email}
									<span class="card__email"><CopyValue value={row.email} label="email address" /></span>
								{/if}
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
								{@render status(row)}
								{#if row.assigned > 0}
									<span class="card__load">{row.done} / {row.assigned} done</span>
								{:else}
									<span class="card__load">Nothing assigned</span>
								{/if}
								{#if row.awaitingReassignment > 0}
									<!-- The same disclosure as the table, not a plain badge: the
									     named reviews are the point, and a card is exactly where a
									     press is the only way in. -->
									<span class="load__gap">
										<Popover
											label="{row.awaitingReassignment} need another reviewer — why"
											onreveal={() => (announcement = coverageAnnouncement(row))}>
											{#snippet trigger()}
												<Badge tone="warning" icon={statusIcon.needsReviewer}>
													{row.awaitingReassignment} need another reviewer
												</Badge>
											{/snippet}
											{#snippet children()}
												{@render coverageWhy(row)}
											{/snippet}
										</Popover>
									</span>
								{/if}
								{#if remindersAvailable && remindedIds.includes(row.id)}
									<span class="load__sent">Reminder sent</span>
								{:else if remindersAvailable && isBehind(row)}
									<button
										type="button"
										class="ui-button ui-button--secondary ui-button--sm"
										disabled={remindingId !== null}
										aria-busy={remindingId === row.id}
										onclick={() => openRemind([row])}>Remind</button>
								{/if}
							</span>
							<!-- Cards have no column header, so the words carry the whole
							     sentence: "Reviews everything". -->
							<span class="card__scope">{@render scopeCell(row, 'Reviews everything')}</span>
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

{#if remindersAvailable && selectedIds.length > 0}
	<div class="bulkbar" role="toolbar" aria-label="Selected reviewers">
		<span class="bulkbar__count">{selectedIds.length} selected</span>
		<button
			type="button"
			class="ui-button ui-button--primary ui-button--sm"
			disabled={remindingId !== null}
			onclick={() => openRemind(selectedRows)}>
			Remind selected
		</button>
		<button type="button" class="ui-button ui-button--ghost ui-button--sm" onclick={clearSelection}>
			Clear
		</button>
	</div>
{/if}

{#if roster && reviewers.length > 0}
	<CoveragePanel
		coverage={roster.coverage}
		generalists={roster.generalists}
		trackOrder={tracks.map((track) => track.id)}
		{activeCount}
		invitedCount={reviewers.length - activeCount} />
{/if}

<InviteReviewersModal {port} bind:open={inviteOpen} {tracks} {formats} {sessions} oninvited={onInvited} />

<Modal bind:open={replacementOpen} title="Assign a replacement reviewer">
	{#if vacancyTarget}
		<p class="modal__copy">
			Choose who should pick up “{vacancyTarget.title}”. Reviewers in scope come first, then
			lowest current load.
		</p>
		{#if vacancyTarget.replacementCandidates && vacancyTarget.replacementCandidates.length > 0}
			<fieldset class="replacement">
				<legend class="ui-sr-only">Replacement reviewer</legend>
				{#each vacancyTarget.replacementCandidates as candidate (candidate.reviewerId)}
					<label class="replacement__row" class:replacement__row--blocked={!candidate.scopeMatch}>
						<input
							type="radio"
							name="replacement-reviewer"
							value={candidate.reviewerId}
							bind:group={replacementReviewerId}
							disabled={!candidate.scopeMatch || vacancyBusy} />
						<span class="replacement__copy">
							<strong>{replacementName(candidate.reviewerId)}</strong>
							<span>{candidate.assigned} current {candidate.assigned === 1 ? 'review' : 'reviews'}</span>
							{#if candidate.conflict}<span class="replacement__conflict">{candidate.conflict}</span>{/if}
						</span>
					</label>
				{/each}
			</fieldset>
		{:else}
			<p class="modal__copy">No other active reviewer is available for this submission.</p>
		{/if}
		{#if vacancyError}<p class="modal__error" role="alert">{vacancyError}</p>{/if}
	{/if}
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" disabled={vacancyBusy} onclick={close}>Cancel</button>
		<button
			type="button"
			class="ui-button ui-button--primary"
			disabled={!replacementReviewerId || vacancyBusy}
			aria-busy={vacancyBusy}
			onclick={confirmReplacement}>Assign reviewer</button>
	{/snippet}
</Modal>

<Modal bind:open={acceptCoverageOpen} title="Accept the current coverage?">
	{#if vacancyTarget}
		<p class="modal__copy">
			“{vacancyTarget.title}” will continue with {vacancyTarget.remainingReviewers ?? 'its current'}
			{vacancyTarget.remainingReviewers === 1 ? ' reviewer' : ' reviewers'}. This retires the open
			review slot; it does not claim another review was completed.
		</p>
		{#if vacancyError}<p class="modal__error" role="alert">{vacancyError}</p>{/if}
	{/if}
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" disabled={vacancyBusy} onclick={close}>Keep slot open</button>
		<button
			type="button"
			class="ui-button ui-button--secondary"
			disabled={vacancyBusy}
			aria-busy={vacancyBusy}
			onclick={confirmAcceptCoverage}>Accept coverage</button>
	{/snippet}
</Modal>

<Modal bind:open={removeOpen} title="Remove this reviewer?">
	{#if removeTarget}
		<p class="modal__copy">
			{removeTarget.name} comes off the reviewer roster. Reviews they committed stay in every plan,
			and anything still assigned to them keeps counting until another reviewer covers it. Their
			workspace membership is unchanged — manage that in Settings.
		</p>
	{/if}
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" onclick={close}>Keep reviewer</button>
		<button type="button" class="ui-button ui-button--danger" onclick={confirmRemove}>
			Remove reviewer
		</button>
	{/snippet}
</Modal>

<!-- A reminder is an email to a person, so it is reviewed before it is sent:
     who receives it, the subject as it will read, and the body itself. -->
<Modal bind:open={remindOpen} title="Send review reminder">
	{#if remindTargets.length > 0}
		<p class="modal__copy">
			{remindBatch.included.length}
			{remindBatch.included.length === 1 ? 'reviewer receives' : 'reviewers receive'}
			this email. Excluded people stay listed with the reason. Nothing is sent until you commit it
			here.
		</p>
		<Field id="remind-subject" label="Subject" required>
			{#snippet children({ id, describedBy })}
				<input
					class="ui-control"
					type="text"
					{id}
					aria-describedby={describedBy}
					bind:value={remindSubject} />
			{/snippet}
		</Field>
		{#if remindError}
			<p class="modal__error" role="alert">{remindError}</p>
		{/if}
		{#if remindPreview?.kind === 'template' && theme}
			<RecipientEmailPeek
				template={remindPreview.template}
				{theme}
				eventName=""
				eventMeta=""
				recipient={{ name: remindBatch.included[0]?.reviewer.name ?? 'each reviewer' }}
				subject={remindSubject}
				hint="Reviewer reminders ride the speaker-task reminder lane, so this is that lane’s copy." />
		{:else if remindPreview?.kind === 'plain'}
			<VerbatimBodyPeek
				subject={remindSubject.trim() || 'Review reminder'}
				body={remindPreview.body}
				note="Reviewer reminders ride the speaker-task reminder lane, so this is that lane’s copy." />
		{/if}
		<ul class="remind-roster">
			{#each remindBatch.roster as entry (entry.reviewer.id)}
				<li class="remind-roster__row" class:remind-roster__row--out={Boolean(entry.reason)}>
					<span class="remind-roster__who">
						<span class="remind-roster__name">{entry.reviewer.name}</span>
						{#if entry.reviewer.email}
							<span class="remind-roster__mail">
								<CopyValue value={entry.reviewer.email} label="email address" />
							</span>
						{/if}
					</span>
					{#if entry.reason}
						<span class="ui-badge ui-badge--warning ui-badge--solid">Excluded</span>
						<span class="remind-roster__reason">{entry.reason}</span>
					{:else}
						<span class="remind-roster__detail">
							{entry.reviewer.done} of {entry.reviewer.assigned} reviews are in
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#snippet footer(close)}
		<button type="button" class="ui-button ui-button--ghost" disabled={remindingId !== null} onclick={close}>
			Cancel
		</button>
		<button
			type="button"
			class="ui-button ui-button--primary"
			disabled={remindingId !== null || !remindSubject.trim() || remindBatch.included.length === 0}
			aria-busy={remindingId !== null || undefined}
			onclick={confirmRemind}>
			Send {remindBatch.included.length}
			{remindBatch.included.length === 1 ? 'reminder email' : 'reminder emails'}
		</button>
	{/snippet}
</Modal>

<!-- A roster restore is an explicit forward operation over its retained revoked row.
     After it commits, re-read the roster and resync the open editor. -->
<CommitReceipt
	onUndone={async () => {
		await load();
		if (expandedId) startDraft(expandedId);
	}} />

<p class="ui-sr-only" role="status">{announcement}</p>

<style>
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

	.head__invite {
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

	/* The uncovered count climbs one rung of the status ladder while work is
	   actually waiting on a chair. */
	.chips__count--attention {
		padding: 0.0625rem var(--je-space-2);
		border-radius: var(--je-radius-round);
		font-weight: 650;
		background: var(--je-color-warning-soft);
		color: var(--je-color-warning);
	}

	.head__note {
		grid-column: 1 / -1;
		margin: 0;
		max-inline-size: 72ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Empty states say which kind of empty this is before the sentence is read:
	   a roster that never started, a filter hiding data, or a clear queue. */
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

	.panel__mark {
		display: grid;
		place-items: center;
		color: var(--je-color-text-subtle);
	}

	.panel__mark--clear {
		color: var(--je-color-text-muted);
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
		display: grid;
		min-inline-size: 0;
	}

	.col-select {
		inline-size: 2.25rem;
	}

	.reminder-availability {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.col-reviewer {
		inline-size: 16rem;
	}

	.col-status {
		inline-size: 6.5rem;
	}

	.col-load {
		inline-size: 12rem;
	}

	.col-expand {
		inline-size: 2.5rem;
	}

	/* Load is reviewer-management evidence: the figure and equal-endpoint bar
	   support comparison, while Remind appears only for a person who is behind. */
	.load__count {
		display: block;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
	}

	.load__bar {
		display: block;
		block-size: 0.25rem;
		inline-size: 100%;
		margin-block-start: var(--je-space-1);
	}

	.load__bar .ui-progress__value {
		display: block;
	}

	.load__gap {
		display: block;
		margin-block-start: var(--je-space-1);
	}

	.load__why {
		margin: 0;
	}

	/* The named reviews under the gap sentence: title, then what the vacancy
	   costs that submission. Stopped review takes the danger voice because it
	   is a different state, not a louder one. */
	.gap {
		margin: var(--je-space-3) 0 0;
		padding: var(--je-space-3) 0 0;
		border-block-start: 1px solid var(--je-color-border);
		list-style: none;
		display: grid;
		gap: var(--je-space-2);
	}

	.gap__title {
		display: block;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
	}

	.gap__said {
		display: block;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.gap__said--stopped {
		font-weight: 600;
		color: var(--je-color-danger);
	}

	.gap__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-2);
	}

	.load__none {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.load__remind,
	.load__sent {
		margin-block-start: var(--je-space-2);
	}

	.load__sent {
		display: block;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-success);
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

	/* Marked things tint; open things lift. The open pair keeps the table's
	   full surface brightness and gains a lifted boundary framing row and
	   expansion as one raised unit. */
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

	/* The editor leads the expansion at full width; the removal footer is a
	   separated quiet row beneath it. */
	.detail {
		display: grid;
		gap: var(--je-space-4);
		padding: var(--je-space-3) var(--je-space-2) var(--je-space-4);
	}

	.detail__footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2) var(--je-space-4);
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	.detail__footer-copy {
		margin: 0;
		max-inline-size: 64ch;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.detail__heading {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* The heading's answer while the draft is empty: total coverage in words,
	   at full presence — the widest scope must not be the faintest line. */
	.detail__fact {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-md);
		font-weight: 600;
		color: var(--je-color-text);
	}

	.detail__hint {
		margin: 0 0 var(--je-space-3);
		max-inline-size: 56ch;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.detail__pending {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.detail__error {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.detail__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-3);
	}

	.modal__copy {
		margin: 0;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.modal__error {
		margin: var(--je-space-3) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-danger);
	}

	.replacement {
		display: grid;
		gap: var(--je-space-2);
		margin: var(--je-space-4) 0 0;
		padding: 0;
		border: 0;
	}

	.replacement__row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: var(--je-space-3);
		min-block-size: var(--je-control-height);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
		cursor: pointer;
	}

	.replacement__row--blocked {
		cursor: not-allowed;
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	.replacement__row input {
		margin-block-start: 0.2rem;
	}

	.replacement__copy {
		display: grid;
		gap: var(--je-space-1);
		font-size: var(--je-font-size-sm);
	}

	.replacement__copy span {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.replacement__row .replacement__conflict {
		color: var(--je-color-warning);
	}

	/* Narrow cards */
	.roster__cards {
		display: none;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

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
			'pick copy toggle'
			'pick tags tags'
			'pick scope scope';
		column-gap: var(--je-space-3);
		row-gap: var(--je-space-2);
		align-items: center;
	}

	.card__pick {
		grid-area: pick;
		align-self: start;
		margin-block-start: 0.2rem;
	}

	.card__head--no-pick {
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'copy toggle'
			'tags tags'
			'scope scope';
	}

	/* The card's summary is the table row's door in the narrow composition; a
	   skeleton head is not one, which is what the modifier separates. These
	   cards mostly meet a coarse pointer, so no chrome is added beyond the
	   cursor — the toggle's own states already carry the affordance. */
	.card__head--door {
		cursor: pointer;
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

	.card__load {
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.card__scope {
		grid-area: scope;
	}

	.card__detail {
		margin-block-start: var(--je-space-3);
		padding-block-start: var(--je-space-3);
		border-block-start: 1px solid var(--je-color-border);
	}

	.bulkbar {
		position: sticky;
		inset-block-end: var(--je-space-4);
		margin-inline: auto;
		width: fit-content;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-2) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-round);
		box-shadow: var(--je-shadow-md);
	}

	.bulkbar__count {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		margin-inline-end: var(--je-space-2);
		font-variant-numeric: tabular-nums;
	}

	.remind-roster {
		display: grid;
		gap: var(--je-space-2);
		margin: var(--je-space-4) 0 0;
		padding: 0;
		list-style: none;
	}

	.remind-roster__row {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-control);
	}

	.remind-roster__row--out {
		background: var(--je-color-surface-sunken);
	}

	.remind-roster__who,
	.remind-roster__name {
		display: grid;
		min-inline-size: 0;
	}

	.remind-roster__mail,
	.remind-roster__detail,
	.remind-roster__reason {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 920px) {
		.head {
			grid-template-columns: minmax(0, 1fr);
		}

		/* Three filters ragged-wrapping read as debris; a grid keeps one rhythm
		   and gives every chip a touch-sized target. The wide third chip takes
		   the whole last row so the layout reads 2+1 on purpose. */
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

		.chips__tab:last-child {
			grid-column: 1 / -1;
		}

		.head__invite {
			justify-self: stretch;
		}

		.roster__table {
			display: none;
		}

		.roster__cards {
			display: block;
		}

		.detail {
			padding: 0;
		}
	}

	@media (max-width: 768px) {
		/* The badge keeps its compact visual weight while the button owns a full
		   phone target. The pseudo-element expands hit-testing without making the
		   status mark look like a primary action or shifting the card around it. */
		.load__gap :global(.ui-popover__trigger) {
			position: relative;
		}

		.load__gap :global(.ui-popover__trigger)::after {
			content: '';
			position: absolute;
			z-index: 1;
			inset-inline: -0.25rem;
			inset-block-start: 50%;
			block-size: 2.75rem;
			transform: translateY(-50%);
		}
	}
</style>
