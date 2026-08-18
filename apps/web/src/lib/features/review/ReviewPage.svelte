<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Flame, Gem, Lock, Star, Zap } from 'lucide-svelte';
	import {
		Badge,
		ClampedText,
		Field,
		Modal,
		Popover,
		Progress,
		recordTable,
		ScopeFilter,
		Term,
		statusIcon,
		trackPending,
		type Scope
	} from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import type { ReviewPagePort, ReviewResultRow } from '$lib/api/review-page-port';
	import { REVIEW_STATUS_CSV_FILENAME, reviewStatusCsv } from './review-export-csv';
	import { composeCapRefusal } from '$lib/api/accolades';
	import { composeStepBackRefusal } from '$lib/api/reviewers';
	import ResourceList from '$lib/features/workspace/components/ResourceList.svelte';
	import { isTopScore, scoreTone } from '$lib/features/workspace/components/score-tone';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import StandingMark from '$lib/features/workspace/components/StandingMark.svelte';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { applyParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import { formatArrival } from '$lib/features/workspace/recency';
	import ScopeChips from '$lib/features/reviewers/ScopeChips.svelte';
	import { resolveScope, type ScopeEntities } from '$lib/features/reviewers/scope-display';
	import LineupPanel, { sliceKeys } from './LineupPanel.svelte';
	import type { SliceKey } from './LineupPanel.svelte';
	import RoundSetup from './RoundSetup.svelte';
	import { ANONYMIZED_MEANS } from './copy';
	import type {
		AccoladeDef,
		AccoladeKey,
		MyReviewItem,
		ReviewPlan,
		ReviewRoundSetup,
		ReviewSubmissionDisplay,
		ScopeRef,
		ScoreStanding,
		SpeakerProfile
	} from '$lib/api/types';

	interface Props {
		port: ReviewPagePort;
	}

	let { port }: Props = $props();
	const api = $derived(port);
	const viewer = $derived(port.viewer);

	/**
	 * Whose surface this is. Review is the queue for both roles; only round setup
	 * and the review-policy brief vary here. Reviewer management and reminders
	 * stay on Reviewers; results and export stay on this page so the organizer
	 * does not learn a second navigation concept.
	 */
	const reviewerView = $derived(viewer.kind === 'reviewer');
	const ORGANIZER_VIEWS = ['queue', 'results'] as const;
	const organizerView = $derived(
		reviewerView ? 'queue' : paramIn('view', ORGANIZER_VIEWS, 'queue')
	);

	interface QueueRow {
		item: MyReviewItem;
		submission: ReviewSubmissionDisplay;
	}

	interface Draft {
		score?: number;
		comment: string;
	}

	/**
	 * What each mark on the scale is supposed to mean. Two reviewers agree on a
	 * number far more often when the number names a decision they would actually
	 * take, so the anchor word rides under the digit on the control itself and
	 * the threshold sentence behind it stays one press away — the same wording
	 * for every card, rather than re-invented per submission.
	 */
	interface ScoreAnchor {
		value: number;
		caption: string;
		threshold: string;
	}

	const scoreAnchors: ScoreAnchor[] = [
		{
			value: 1,
			caption: 'Pass',
			threshold: 'Does not fit this event; you would not schedule it.'
		},
		{ value: 2, caption: 'Weak', threshold: 'A fixable idea that cannot compete this round.' },
		{
			value: 3,
			caption: 'Solid',
			threshold: 'Worth a slot if the track has room; you would not fight for it.'
		},
		{ value: 4, caption: 'Strong', threshold: 'You would advocate for it in a tie.' },
		{
			value: 5,
			caption: 'Must-have',
			threshold: 'You would trade another accepted talk to keep it.'
		}
	];

	const accoladeIcon: Record<AccoladeKey, IconComponent> = {
		top_pick: Star,
		hidden_gem: Gem,
		crowd_draw: Flame,
		bold_bet: Zap
	};

	let loaded = $state(false);
	let plan = $state<ReviewPlan | null>(null);
	let rows = $state<QueueRow[]>([]);
	let drafts = $state<Record<string, Draft>>({});
	let committingId = $state<string | null>(null);
	let status = $state('');

	/** One fill per policy line the resolved brief states, at its own length. */
	const policyFills = [
		'min(34rem, 100%)',
		'min(38rem, 100%)',
		'min(26rem, 100%)',
		'min(42rem, 100%)'
	];

	/** The reviewer's own scope, read only when this is a reviewer's surface. */
	let scope = $state<ScopeRef[]>([]);
	let scopeEntities = $state<ScopeEntities>({ tracks: [], formats: [], sessions: [] });
	let briefLoaded = $state(false);

	let accoladeDefs = $state<AccoladeDef[]>([]);
	let accoladeBusy = $state<string | null>(null);
	/** Undefined is "not read yet"; null is "read, and there is no claim". */
	let standings = $state<Record<string, ScoreStanding | null>>({});
	/** Submitter profiles by address, read only when the plan is not blind. */
	let profiles = $state<Record<string, SpeakerProfile | null>>({});

	// Re-reading the plan is a reload, not a first load: the counter and the
	// reviewer list keep the numbers a person is reading and dim until the new
	// ones land. The skeletons below run only while there is nothing to keep.
	// What the shell already knows decides which composition holds the space: a
	// review count in the workspace summary means a plan exists, and without one
	// this screen resolves to its no-plan panel instead of the plan and columns.
	const planExpectation = $derived(api.workspace.reviewPlanExpectedSnapshot());
	const known = $derived(planExpectation !== null);
	const expectPlan = $derived(planExpectation === true);

	let planReloading = $state(false);
	const planReload = trackPending(() => planReloading);

	/** Counts behind the one setup action; null until the no-round panel needs them. */
	let roundSetup = $state<ReviewRoundSetup | null>(null);
	let setupOpen = $state(false);

	/**
	 * The round just opened: the plan header and roster take over from the
	 * setup panel, and the receipt records the act — undoable exactly until
	 * the first review is committed, which is when discarding starts erasing
	 * other people's work.
	 */
	async function roundOpened(opened: ReviewPlan) {
		plan = { ...opened };
		setupOpen = false;
		recordAction({
			area: 'review',
			label: `Opened round 1 — ${opened.total} review${opened.total === 1 ? '' : 's'} across ${opened.reviewers.length} reviewer${opened.reviewers.length === 1 ? '' : 's'}`,
			undo: async () => {
				await api.review.discardRound(opened.id);
				const plans = await api.review.plans();
				const current = plans[plans.length - 1];
				plan = current ? { ...current } : null;
				if (!plan) roundSetup = await api.review.roundSetup();
			}
		});
	}

	onMount(async () => {
		// The scope line answers a question about the person, not about the
		// queue, so it resolves on its own rather than holding the cards back.
		if (viewer.kind === 'reviewer') void loadBrief(viewer.reviewerId);

		// The mark vocabulary travels with the queue rather than after it: it is
		// the same four keys for every card, so a card that has arrived should
		// arrive complete instead of growing its marks a moment later.
		const [plans, queue, defs] = await Promise.all([
			api.review.plans(),
			api.review.myQueue(),
			api.review.accoladeDefs()
		]);
		// Rounds append, so the newest plan is the round in play; earlier ones
		// are closed history.
		const current = plans[plans.length - 1];
		plan = current ? { ...current } : null;
		accoladeDefs = defs;

		// Setting a round up is the chair's work: the counts behind the one
		// action resolve only when there is no round and someone who can open it.
		if (!current && !reviewerView) {
			void api.review.roundSetup().then((counts) => (roundSetup = counts));
		}

		const submissions = await Promise.all(
			queue.map((entry) => api.submissions.get(entry.submissionId))
		);
		const next: QueueRow[] = [];
		queue.forEach((entry, index) => {
			const submission = submissions[index];
			if (!submission) return;
			next.push({ item: { ...entry }, submission });
			drafts[entry.submissionId] = { score: entry.myScore, comment: entry.myComment ?? '' };
		});
		rows = next;
		loaded = true;

		// What the queue alone cannot say: the aggregate a committed review is
		// allowed to see, landing into slots the cards are already holding.
		await loadStandings(
			rows.filter((row) => row.item.committed).map((row) => row.item.submissionId)
		);
		await loadProfiles();
	});

	const scale = $derived(Array.from({ length: plan?.scaleMax ?? 5 }, (_, index) => index + 1));
	const openCount = $derived(rows.filter((row) => !row.item.committed).length);
	const completedCount = $derived(rows.length - openCount);

	// -------------------------------------------------------------------------
	// The queue's two intents are two zones (owner rework, 2026-08-15): working
	// the pass and consulting what it produced are different visits, and a
	// single scroll made the second one a hike past every unfinished card. The
	// address owns which zone is showing — the same scope grammar as the
	// Submissions trays, so the control is already learned.

	const QUEUE_SCOPES = ['to-review', 'completed'] as const;
	const queueScope = $derived(paramIn('scope', QUEUE_SCOPES, 'to-review'));

	const queueScopes = $derived<Scope[]>([
		{ value: 'to-review', label: 'To review', count: openCount },
		{ value: 'completed', label: 'Completed', count: completedCount }
	]);

	function switchScope(next: string) {
		// The default scope stays out of the address, so an unscoped link is clean.
		applyParams({ scope: next === 'to-review' ? null : next });
	}

	function switchOrganizerView(next: (typeof ORGANIZER_VIEWS)[number]) {
		applyParams({ view: next === 'queue' ? null : next });
	}

	let resultRows = $state<ReviewResultRow[] | null>(null);
	let resultsError = $state('');
	let resultsLoading = $state(false);
	let exporting = $state(false);

	async function loadResults() {
		if (resultsLoading) return;
		resultsLoading = true;
		resultsError = '';
		try {
			resultRows = await api.review.results();
		} catch (error) {
			resultsError =
				error instanceof Error ? error.message : 'Review results could not be loaded.';
			resultRows = [];
		} finally {
			resultsLoading = false;
		}
	}

	$effect(() => {
		if (!loaded || reviewerView || organizerView !== 'results') return;
		if (resultRows !== null || resultsLoading) return;
		void loadResults();
	});

	function downloadResults() {
		if (!resultRows || exporting) return;
		exporting = true;
		try {
			const href = URL.createObjectURL(
				new Blob([reviewStatusCsv(resultRows)], { type: 'text/csv;charset=utf-8' })
			);
			const link = document.createElement('a');
			link.href = href;
			link.download = REVIEW_STATUS_CSV_FILENAME;
			link.click();
			URL.revokeObjectURL(href);
			status = 'Downloaded review status.';
		} finally {
			exporting = false;
		}
	}

	/**
	 * Reviews committed during this visit. Committing is what earns the peer
	 * content, and that reveal must land on the card that was just pressed —
	 * so a just-committed card keeps its place in the To-review zone for the
	 * rest of the visit (in its completed presentation) instead of vanishing
	 * mid-read into the other scope. The counts move immediately; the card
	 * follows on the next arrival at the zone.
	 */
	let revealedIds = $state<string[]>([]);

	/** The rows the current zone shows; source order stays stable inside it. */
	const visibleRows = $derived(
		queueScope === 'completed'
			? rows.filter((row) => row.item.committed)
			: rows.filter((row) => !row.item.committed || revealedIds.includes(row.item.submissionId))
	);

	// Arriving at a zone resets the visit-local reveals: what was "just
	// committed" is only just-committed until the person moves on.
	$effect(() => {
		void queueScope;
		revealedIds = [];
	});
	// The panel describes the scale this plan actually uses, never a mark the
	// control does not offer.
	const guideAnchors = $derived(
		scoreAnchors.filter((anchor) => anchor.value <= (plan?.scaleMax ?? 5))
	);

	function anchorFor(value: number): ScoreAnchor | undefined {
		return scoreAnchors.find((anchor) => anchor.value === value);
	}

	/**
	 * Standing is an aggregate of other people's reviews, so it is read only for
	 * items whose own review is committed. An id the batch has no claim for is
	 * written back as null rather than left unread: a slot that keeps waiting
	 * for an answer that will never come is a lie about the load.
	 */
	async function loadStandings(submissionIds: string[]) {
		if (submissionIds.length === 0) return;
		const found = await api.review.standings(submissionIds);
		for (const submissionId of submissionIds) standings[submissionId] = found[submissionId] ?? null;
	}

	/**
	 * Who submitted the cards in my queue, read in one pass once they are on
	 * screen. A blind plan never asks: the whole point of anonymized review is
	 * that this reviewer does not learn who wrote it, so the identity is not
	 * fetched, not held, and not one relayout away from being visible.
	 */
	async function loadProfiles() {
		if (!plan || plan.anonymized) return;
		const emails = [...new Set(rows.flatMap((row) =>
			row.submission.speakers.flatMap((speaker) => speaker.email ? [speaker.email] : [])
		))];
		if (emails.length === 0) return;
		const found = await Promise.all(emails.map((email) => api.speakers.profile(email)));
		const next: Record<string, SpeakerProfile | null> = {};
		emails.forEach((email, index) => (next[email] = found[index]));
		profiles = next;
	}

	/**
	 * What this reviewer is asked to review, in the referenced records' own
	 * words. A generalist holds no refs at all, so nothing else is read: the
	 * vocabulary behind the chips is fetched only when there are chips, and the
	 * schedule only when a session is actually in scope.
	 */
	async function loadBrief(reviewerId: string) {
		const refs = await api.review.myScope(reviewerId);
		if (refs.length === 0) {
			briefLoaded = true;
			return;
		}
		const [tracks, formats, schedule] = await Promise.all([
			api.vocab.tracks(),
			api.vocab.formats(),
			refs.some((ref) => ref.kind === 'session') ? api.schedule.state() : undefined
		]);
		scope = refs;
		scopeEntities = { tracks, formats, sessions: schedule?.sessions ?? [] };
		briefLoaded = true;
	}

	const scopeDisplay = $derived(resolveScope(scope, scopeEntities));

	/**
	 * What this plan lets a reviewer see, and who reads what they write — the
	 * compact form of the same policy the Anonymized badge states in full. A
	 * reviewer here for one round has no other place to learn it, and it decides
	 * whether a candid comment is safe to write, so it is on the surface rather
	 * than behind a press. Only axes the plan actually carries are claimed.
	 */
	const visibilityPolicy = $derived.by(() => {
		if (!plan) return [];
		const lines = [
			plan.anonymized
				? 'You do not see who submitted, and submitters never see who reviewed them.'
				: 'You see who submitted; submitters never see who reviewed them.',
			'Your score and comment go to the other reviewers and the people running this round — never to the speaker.'
		];
		if (plan.antiAnchoring) {
			lines.push('Other reviewers’ scores stay hidden until you commit your own.');
		}
		// The term of art, taught once where it is first needed, so the control on
		// every card can stay two words. "Conflict of interest" is what
		// practitioners say; the sentence behind it is what makes it actionable.
		lines.push(
			'Know or work with whoever submitted something? That is a conflict of interest — step back from the card and it goes to another reviewer.'
		);
		return lines;
	});

	function percent(done: number, total: number): number {
		return total > 0 ? Math.round((done / total) * 100) : 0;
	}

	function draftFor(submissionId: string): Draft {
		return drafts[submissionId] ?? { comment: '' };
	}

	function setScore(submissionId: string, value: number) {
		drafts[submissionId] = { ...draftFor(submissionId), score: value };
	}

	function setComment(submissionId: string, value: string) {
		drafts[submissionId] = { ...draftFor(submissionId), comment: value };
	}

	/** Whether a capped key is already spent everywhere except on this card. */
	function isSpent(def: AccoladeDef, row: QueueRow): boolean {
		if (def.cap === undefined) return false;
		if (row.item.accolades?.includes(def.key)) return false;
		const holders = rows.filter(
			(other) =>
				other.item.submissionId !== row.item.submissionId &&
				other.item.accolades?.includes(def.key)
		);
		return holders.length >= def.cap;
	}

	/**
	 * The refusal a spent key answers with, or undefined while it can be
	 * pinned. Composed from the same sentence the pin operation refuses with
	 * (`$lib/api/accolades`), over the same queue the operation checks — one
	 * source, so what the surface warns and what a commit would answer cannot
	 * drift apart.
	 */
	function capRefusal(def: AccoladeDef, row: QueueRow): string | undefined {
		if (!isSpent(def, row)) return undefined;
		const titles = rows
			.filter(
				(other) =>
					other.item.submissionId !== row.item.submissionId &&
					other.item.accolades?.includes(def.key)
			)
			.map((other) => other.submission.title);
		return composeCapRefusal(def, titles);
	}

	/** The local queue mirrors the write the operation just made. */
	function applyAccolade(submissionId: string, key: AccoladeKey, pinned: boolean) {
		rows = rows.map((row) => {
			if (row.item.submissionId !== submissionId) return row;
			const current = row.item.accolades ?? [];
			const accolades = pinned
				? current.includes(key)
					? current
					: [...current, key]
				: current.filter((entry) => entry !== key);
			const item: MyReviewItem = { ...row.item, accolades };
			if (accolades.length === 0) delete item.accolades;
			return { ...row, item };
		});
	}

	/**
	 * A mark is a commit like any other: it answers with a receipt naming the
	 * mark and the submission it landed on, and its undo is the opposite pin.
	 */
	async function toggleAccolade(row: QueueRow, def: AccoladeDef) {
		if (accoladeBusy) return;
		const id = row.item.submissionId;
		const title = row.submission.title;
		const pinned = row.item.accolades?.includes(def.key) ?? false;
		accoladeBusy = `${id}:${def.key}`;
		const outcome = pinned
			? await api.review.unpinAccolade(id, def.key)
			: await api.review.pinAccolade(id, def.key);
		if (outcome.ok) {
			applyAccolade(id, def.key, !pinned);
			recordAction({
				area: 'review',
				label: `${pinned ? 'Unpinned' : 'Pinned'} ${def.label} on “${title}”`,
				undo: async () => {
					// The reverse pin can itself refuse — the cap may have filled
					// since the receipt was issued — and the card only mirrors a
					// write the operation actually accepted.
					const reverse = pinned
						? await api.review.pinAccolade(id, def.key)
						: await api.review.unpinAccolade(id, def.key);
					if (reverse.ok) {
						applyAccolade(id, def.key, pinned);
					} else {
						status = reverse.reason;
						recordAction({
							area: 'review',
							label: `Could not restore ${def.label} on “${title}”`,
							notUndoableReason: reverse.reason
						});
					}
				}
			});
		} else {
			// The operation is the authority on what it refused; the live
			// region says its words once.
			status = outcome.reason;
		}
		accoladeBusy = null;
	}

	/** Whether lining this review up against my own others has anything to show. */
	function hasOtherCommitted(submissionId: string): boolean {
		return rows.some((row) => row.item.submissionId !== submissionId && row.item.committed);
	}

	/* The line-up opens over the queue rather than replacing it: comparing one of
	   my reviews against my others is a closer look at the work I am already
	   doing, not a departure from it, and the queue stays exactly where I left it.
	   Which review is being lined up is scope, so it travels in the address — the
	   view is linkable and reloadable, and Back closes it because closing it and
	   stepping back out of it are the same act. */
	const lineupId = $derived(param('lineup'));
	const lineupSlice = $derived(paramIn('slice', sliceKeys, 'track'));
	const lineupRow = $derived(rows.find((row) => row.item.submissionId === lineupId));
	const lineupTitle = $derived(
		lineupRow ? `Line-up: “${lineupRow.submission.title}”` : 'Line-up'
	);

	let lineupOpen = $state(false);

	// The address is the authority on whether the line-up is open…
	$effect(() => {
		lineupOpen = lineupId !== null;
	});

	// …and a dialog that closed itself — Escape, backdrop, close button — writes
	// that back, so every way out leaves the same address behind.
	$effect(() => {
		if (lineupOpen || lineupId === null) return;
		void applyParams({ lineup: null, slice: null });
	});

	function openLineup(submissionId: string) {
		// A slice from an earlier line-up is not this one's scope: every anchor
		// opens on its own track before it is widened.
		void applyParams({ lineup: submissionId, slice: null }, { history: 'push' });
	}

	function switchLineupSlice(next: SliceKey) {
		applyParams({ slice: next === 'track' ? null : next }, { history: 'push' });
	}

	/**
	 * A review revised inside the line-up is the same review this queue is
	 * showing, so the card behind the dialog carries the new score out with it
	 * — including when the receipt puts the old one back.
	 */
	function applyReviewChange(item: MyReviewItem) {
		rows = rows.map((row) =>
			row.item.submissionId === item.submissionId ? { ...row, item: { ...item } } : row
		);
	}

	/**
	 * A refusal is a state of the control that would have acted, not a second
	 * control beside it. The disclosure primitive owns its trigger button, so
	 * the unavailable state is written onto that same button: it keeps its place
	 * and stays focusable, because `disabled` would put the reason out of a
	 * keyboard's reach.
	 */
	function unavailable(node: HTMLElement) {
		node.querySelector('.ui-popover__trigger')?.setAttribute('aria-disabled', 'true');
	}

	// Committing freezes the reviewer's own review and reveals peer scores in
	// place; the plan counter is re-read so the header matches the new total.
	async function commit(submissionId: string) {
		const draft = drafts[submissionId];
		if (!draft || draft.score === undefined || committingId) return;
		const title = rows.find((row) => row.item.submissionId === submissionId)?.submission.title;
		committingId = submissionId;
		await api.review.saveReview(submissionId, draft.score, draft.comment);
		const committed = await api.review.commitReview(submissionId);
		if (committed) {
			rows = rows.map((row) =>
				row.item.submissionId === submissionId ? { ...row, item: { ...committed } } : row
			);
			// The reveal lands on the card that was pressed: it stays in this zone,
			// in its committed presentation, until the person moves on.
			revealedIds = [...revealedIds, submissionId];
			// The receipt is the acknowledgement, and it says why this one is final.
			recordAction({
				area: 'review',
				label: `Committed your review of “${title ?? submissionId}” — ${draft.score}`,
				notUndoableReason: 'Peer scores are already revealed on this submission.'
			});
		}
		planReloading = true;
		try {
			const plans = await api.review.plans();
			const refreshed = plans[plans.length - 1];
			if (refreshed) plan = { ...refreshed };
		} finally {
			planReloading = false;
		}
		committingId = null;
		// Committing is what earns the peer content: the card asks for its
		// standing only now.
		if (committed) {
			await loadStandings([submissionId]);
		}
	}

	/* Stepping back is the reviewer's own act on their own card, and it is
	   consequential: the review leaves the queue and becomes work nobody holds.
	   So it arms in place — the control turns into the question, and the confirm
	   sits at a different position than the trigger, which is what keeps a
	   double-press from stepping back by accident. Keep, Escape, focus leaving,
	   or the timer all stand it down. */
	let armedStepBackId = $state<string | null>(null);
	let steppingBackId = $state<string | null>(null);
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;

	function armStepBack(row: QueueRow) {
		armedStepBackId = row.item.submissionId;
		clearTimeout(disarmTimer);
		disarmTimer = setTimeout(() => (armedStepBackId = null), 6000);
		status = `Confirm stepping back from “${row.submission.title}”.`;
		void tick().then(() =>
			document.getElementById(`confirm-step-back-${row.item.submissionId}`)?.focus()
		);
	}

	function disarmStepBack() {
		clearTimeout(disarmTimer);
		armedStepBackId = null;
	}

	function keepReview(row: QueueRow) {
		disarmStepBack();
		document.getElementById(`step-back-${row.item.submissionId}`)?.focus();
	}

	/** Standing down when focus leaves the armed question for anywhere outside it. */
	function armFocusout(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (next && (event.currentTarget as HTMLElement).contains(next)) return;
		disarmStepBack();
	}

	/**
	 * A conflict of interest, declared: the card leaves the queue and the
	 * receipt says what left and where it went. The operation is the authority
	 * on whether it happened — the card is dropped only after it answers.
	 */
	async function stepBack(row: QueueRow) {
		if (viewer.kind !== 'reviewer' || steppingBackId) return;
		const id = row.item.submissionId;
		const title = row.submission.title;
		disarmStepBack();
		steppingBackId = id;
		const outcome = await api.review.stepBack(id, viewer.reviewerId);
		if (outcome.ok) {
			rows = rows.filter((entry) => entry.item.submissionId !== id);
			recordAction({
				area: 'review',
				label: `Stepped back from “${title}” — conflict of interest`,
				notUndoableReason: 'The review has left your queue and is waiting for another reviewer.'
			});
		} else {
			status = outcome.reason;
		}
		steppingBackId = null;
	}

	/**
	 * A badge is the whole statement of the blinding policy, and whether a candid
	 * comment is safe to write depends on which direction is blind. A reviewer
	 * here for one round has nowhere else to learn it. It rides the mark's own
	 * ring rather than a `Term`, because the affordance follows the medium: a
	 * badge is already a box, and only running text takes a text affordance.
	 */

</script>

<!-- An armed question stands down the same way every other one does. -->
<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && armedStepBackId) disarmStepBack();
	}} />

<!-- Saves and reminders are announced once, from here; a commit answers with its
     own receipt, which names what it did and why it is final. -->
<p class="ui-sr-only" role="status">{status}</p>

<!-- One receipt at a time, on whichever surface is on top: a fixed banner in the
     page layer would sit under an open dialog's own scrim, so the line-up
     carries its own (below) while it is open. -->
{#if !lineupId}
	<CommitReceipt />
{/if}

{#if !loaded && !expectPlan}
	{#if known}
		<!-- Evidence says no review plan exists yet, so the no-plan panel is the
		     composition that holds this screen's space. -->
		<section class="opening" aria-label="Loading review plan">
			<p class="opening__title sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 12rem"></span></p>
			<p class="opening__copy">
				<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
				<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
				<span class="ui-skeleton skeleton-line" style="inline-size: 45%"></span>
			</p>
			<!-- A reviewer's version of this panel is one paragraph and no setup
			     actions, so its placeholder stops where the panel does. -->
			{#if !reviewerView}
				<p class="opening__copy">
					<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
					<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
					<span class="ui-skeleton skeleton-line" style="inline-size: 60%"></span>
				</p>
				<div class="opening__actions">
					<span class="ui-skeleton skeleton-action skeleton-action--lg"></span>
					<span class="ui-skeleton skeleton-action skeleton-action--lg"></span>
				</div>
			{/if}
		</section>
	{/if}
{:else if !loaded}
	<!-- Every placeholder here is the resolved composition's own markup holding
	     skeleton fills, so the plan header, the reviewer rows, and the queue
	     cards keep the geometry their resolved CSS gives them. -->
	<section class="plan plan--loading" aria-label="Loading review plan">
		<div class="plan__id">
			<p class="plan__name sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: 14rem"></span></p>
			<p class="plan__meta"><span class="ui-skeleton skeleton-line" style="inline-size: 11rem"></span></p>
		</div>
		<div class="plan__stat">
			<p class="plan__figure">
				<span class="plan__done"><span class="ui-skeleton skeleton-line" style="inline-size: 2.5rem"></span></span>
				<span class="plan__total"><span class="ui-skeleton skeleton-line" style="inline-size: 3.5rem"></span></span>
			</p>
			<div class="ui-progress">
				<div class="ui-progress__header">
					<span><span class="ui-skeleton skeleton-line" style="inline-size: 8rem"></span></span>
					<span><span class="ui-skeleton skeleton-line" style="inline-size: 2rem"></span></span>
				</div>
				<div class="ui-progress__track"></div>
			</div>
		</div>
	</section>
	{#if reviewerView}
		<!-- The brief holds its own lines while the scope resolves, so the queue
		     below it does not move once it does. -->
		<section class="brief" aria-label="Loading what you review">
			<p class="brief__scope"><span class="ui-skeleton skeleton-line" style="inline-size: 16rem"></span></p>
			<ul class="brief__policy">
				{#each policyFills as fill, index (index)}
					<li><span class="ui-skeleton skeleton-line" style="inline-size: {fill}"></span></li>
				{/each}
			</ul>
		</section>
	{/if}
	<section class="column column--queue" aria-label="Loading my queue">
		<div class="column__head">
			<h2 class="column__title">Review queue</h2>
			<!-- Stands at the scope set's own control height, so the head does not
			     grow when the zones arrive. -->
			<div class="column__scopes"><span class="ui-skeleton skeleton-action" style="inline-size: min(16rem, 100%)"></span></div>
		</div>
		<ul class="queue">
			{#each Array(3) as _, index (index)}
				<li class="card card--split" aria-hidden="true">
					<div class="card__evidence">
						<div class="card__id">
							<div class="card__head">
								<p class="card__title sk-head"><span class="ui-skeleton skeleton-line" style="inline-size: min(20rem, 100%)"></span></p>
							</div>
						</div>
						<div class="card__abstract">
							<span class="ui-skeleton skeleton-line" style="inline-size: 100%"></span>
							<span class="ui-skeleton skeleton-line" style="inline-size: 72%"></span>
						</div>
						<div class="card__materials">
							<span class="ui-skeleton skeleton-line" style="inline-size: 13rem"></span>
							<span class="ui-skeleton skeleton-line" style="inline-size: 6.5rem"></span>
						</div>
					</div>
					<div class="card__judgment">
						<div class="score">
							<div class="score__head">
								<span class="score__label"><span class="ui-skeleton skeleton-line" style="inline-size: 2.5rem"></span></span>
								<span class="score__guide"><span class="ui-skeleton skeleton-line" style="inline-size: 9.5rem"></span></span>
							</div>
							<span class="ui-skeleton skeleton-segmented"></span>
						</div>
						<div class="ui-field">
							<div class="ui-field__heading">
								<span class="ui-label"><span class="ui-skeleton skeleton-line" style="inline-size: 6rem"></span></span>
							</div>
							<span class="ui-skeleton skeleton-textarea card__comment"></span>
						</div>
						<div class="card__foot">
							<p class="card__lock"><span class="ui-skeleton skeleton-line" style="inline-size: 15rem"></span></p>
							<span class="ui-skeleton skeleton-action card__commit"></span>
						</div>
					</div>
					{#if reviewerView}
						<div class="stepback">
							<span class="ui-skeleton skeleton-action stepback__fill"></span>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{:else if !plan}
	<section class="opening" aria-labelledby="opening-heading">
		{#if reviewerView}
			<!-- Setting a round up is the chair's work, so a reviewer is told what
			     is true for them and offered nothing they cannot do. -->
			<h2 class="opening__title" id="opening-heading">No review round yet</h2>
			<p class="opening__copy">
				Nothing is assigned to you. Once the organizers open a round and hand out submissions,
				your queue appears here.
			</p>
		{:else}
			<h2 class="opening__title" id="opening-heading">No review round yet</h2>
			<p class="opening__copy">
				Review is one path: open the round, and every submission in the inbox goes to each reviewer
				whose scope covers it — their queues appear the moment it opens, and new submissions are
				handed out the same way as they arrive.
			</p>
			{#if roundSetup}
				{#if roundSetup.activeReviewers === 0}
					<!-- The round needs reviewers before it can hand anything out, so
					     the one action here is the prerequisite, not a disabled wish. -->
					<p class="opening__copy">
						Nobody is on the review roster yet{roundSetup.invitedReviewers > 0
							? ` — ${roundSetup.invitedReviewers} invited, none accepted so far`
							: ''}. Reviews need reviewers before the round can open.
					</p>
					<div class="opening__actions">
						<a class="ui-button ui-button--primary" href="/app/reviewers">Invite reviewers</a>
					</div>
				{:else}
					<p class="opening__facts">
						{roundSetup.activeReviewers} reviewer{roundSetup.activeReviewers === 1 ? '' : 's'} ready ·
						{roundSetup.submissions} submission{roundSetup.submissions === 1 ? '' : 's'} in the inbox ·
						<a href="/app/reviewers">Manage reviewers</a>
					</p>
					<div class="opening__actions">
						<button
							type="button"
							class="ui-button ui-button--primary"
							onclick={() => (setupOpen = true)}>
							Open the review round
						</button>
					</div>
				{/if}
			{:else}
				<!-- The counts behind the action, still resolving: same composition,
				     skeleton fills, so the panel never reflows when they land. -->
				<p class="opening__facts" aria-hidden="true">
					<span class="ui-skeleton skeleton-line" style="inline-size: 20rem"></span>
				</p>
				<div class="opening__actions">
					<button type="button" class="ui-button ui-button--primary" disabled>
						Open the review round
					</button>
				</div>
			{/if}
		{/if}
	</section>
{:else}
	<section class="plan" aria-labelledby="plan-heading">
		<div class="plan__id">
			<h2 class="plan__name" id="plan-heading">{plan.name}</h2>
			<p class="plan__meta">
				Reviews {plan.deadlineRelative}
				{#if !reviewerView}
					<span aria-hidden="true">·</span>
					<a href="/app/reviewers">Reviewer progress and reminders</a>
					<span aria-hidden="true">·</span>
					{#if organizerView === 'results'}
						<span>Results</span>
					{:else}
						<button
							type="button"
							class="plan__link"
							onclick={() => switchOrganizerView('results')}>Results</button>
					{/if}
				{/if}
				<!-- The badge is the whole statement of the blinding policy, and
				     whether a candid comment is safe to write depends on which
				     direction is blind. A reviewer here for one round has no way
				     to find that out except from the word itself. -->
				{#if plan.anonymized}
					<Popover
						label="Anonymized — what this means"
						onreveal={() => (status = ANONYMIZED_MEANS)}>
						{#snippet trigger()}
							<Badge>Anonymized</Badge>
						{/snippet}
						{#snippet children()}
							<p class="plan__means">{ANONYMIZED_MEANS}</p>
						{/snippet}
					</Popover>
				{/if}
			</p>
		</div>
		<div
			class="plan__stat"
			class:is-refreshing={planReload.visible}
			aria-busy={planReloading || undefined}>
			<p class="plan__figure">
				<span class="plan__done">{plan.done}</span>
				<span class="plan__total">of {plan.total}</span>
			</p>
			<Progress value={percent(plan.done, plan.total)} label="Reviews committed" />
		</div>
	</section>

	{#if reviewerView}
		<!-- First arrival: what this person is here to review, and what this plan
		     lets them see. Both are read once, at the top, before the queue. -->
		<section class="brief" aria-labelledby="brief-scope">
			<p class="brief__scope" id="brief-scope">
				{#if briefLoaded}
					{#if scopeDisplay.length > 0}<span class="brief__lede">You review:</span>{/if}
					<ScopeChips entries={scopeDisplay} allLabel="You review everything" />
				{:else}
					<span class="ui-skeleton skeleton-line" style="inline-size: 16rem"></span>
				{/if}
			</p>
			<ul class="brief__policy">
				{#each visibilityPolicy as line (line)}
					<li>{line}</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if organizerView === 'results'}
		<section class="column" aria-labelledby="results-heading">
			<div class="column__head">
				<h2 class="column__title" id="results-heading">Results</h2>
				<div class="column__scopes">
					<button
						type="button"
						class="ui-button ui-button--ghost ui-button--sm"
						onclick={() => switchOrganizerView('queue')}>
						Back to queue
					</button>
					<button
						type="button"
						class="ui-button ui-button--secondary ui-button--sm"
						disabled={resultsLoading || !resultRows || resultRows.length === 0}
						aria-busy={exporting || undefined}
						onclick={downloadResults}>
						Download review status
					</button>
				</div>
			</div>
			{#if resultsLoading && resultRows === null}
				<p class="zone-note" role="status">Loading current scores…</p>
			{:else if resultsError}
				<div class="queue-empty" role="status">
					<p class="queue-empty__title">Results are not available</p>
					<p class="queue-empty__hint">{resultsError}</p>
				</div>
			{:else if resultRows && resultRows.length === 0}
				<div class="queue-empty">
					<p class="queue-empty__title">No scored submissions yet</p>
					<p class="queue-empty__hint">
						Results appear here as reviews are committed. Progress and reminders stay on
						<a href="/app/reviewers">Reviewers</a>.
					</p>
				</div>
			{:else if resultRows}
				<p class="zone-note">
					Sorted by current aggregate. A small cohort keeps the number and does not invent a rank.
				</p>
				<div class="ui-table-wrap">
					<table class="ui-table ui-table--multiline" {@attach recordTable()}>
						<thead>
							<tr>
								<th>Submission</th>
								<th class="ui-table__number">Aggregate</th>
								<th class="ui-table__number">Reviews</th>
								<th>Standing</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							{#each resultRows as row (row.submissionId)}
								<tr>
									<td class="ui-cell--lead">
										<span class="ui-table__primary">{row.title}</span>
									</td>
									<td class="ui-table__number">
										{#if row.standing}
											{row.standing.value}
										{:else}
											<span class="verdict__none">No score yet</span>
										{/if}
									</td>
									<td class="ui-table__number">{row.reviews}</td>
									<td>
										{#if row.standing}
											<StandingMark standing={row.standing} form="both" quiet context={row.title} />
										{:else}
											<span class="verdict__none">Too early to rank</span>
										{/if}
									</td>
									<td class="ui-cell--state">
										{#if row.status === 'scored'}
											Scored
										{:else if row.status === 'in_review'}
											In review
										{:else}
											Not scored
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{:else}
	<section class="column column--queue" aria-labelledby="queue-heading">
		<!-- Two intents, two zones: working the pass, and consulting what it
		     produced. The scopes carry the counts, so no second count line; the
		     grammar is the Submissions trays', so the control is already learned. -->
		<div class="column__head">
			<h2 class="column__title" id="queue-heading">Review queue</h2>
			<div class="column__scopes">
				<ScopeFilter
					label="Review queue zones"
					scopes={queueScopes}
					value={queueScope}
					onchange={switchScope} />
			</div>
		</div>

		{#if rows.length === 0}
			<div class="queue-empty">
				<p class="queue-empty__title">Nothing is assigned to you.</p>
				{#if reviewerView}
					<!-- This tells a blocked person to go ask someone, so the one
					     word they need is the one naming who. "Chair" appears
					     nowhere in the product's own role names. -->
					<p class="queue-empty__hint">
						Ask the <Term
							term="chair"
							definition="The person running this review round — they set the plan up and decide who reviews what. In your workspace they hold the Event Manager or Workspace Admin role."
							onreveal={() => (status = 'Chair: the person running this review round.')} /> to
						distribute this plan's submissions, or pick up unassigned ones from Submissions once
						assignment opens.
					</p>
				{:else}
					<!-- The organizer opened the round without being in its pool:
					     true, ordinary, and not a fault — the work shows up as the
					     reviewers commit it. -->
					<p class="queue-empty__hint">
						You are running this round rather than reviewing in it. Progress lands beside each
						reviewer as they commit.
					</p>
				{/if}
			</div>
		{:else if visibleRows.length === 0}
			<!-- The zone is empty while the queue is not: say which zone, and where
			     its work went, instead of a generic nothing. -->
			<div class="queue-empty">
				{#if queueScope === 'to-review'}
					<p class="queue-empty__title">All caught up — every review is committed.</p>
					<p class="queue-empty__hint">
						Your {completedCount} committed review{completedCount === 1 ? ' is' : 's are'} in
						Completed, ready for comparison and amendment.
					</p>
				{:else}
					<p class="queue-empty__title">No committed reviews yet.</p>
					<p class="queue-empty__hint">
						Commit your first from To review — committed reviews land here with peer scores,
						standing, and your marks.
					</p>
				{/if}
			</div>
		{:else}
			{#if queueScope === 'to-review'}
				<!-- "Commit" is not the everyday Save: define its consequence once,
				     at the zone's entry, where the action becomes relevant. -->
				<p class="zone-note">
					Drafts save as you type. <Term
						term="Commit"
						definition="Committing finalises your score and comment for that submission and unlocks the other reviewers' — so it is deliberately one-way. Drafts save as you type; nothing is committed until you press the button."
						onreveal={() =>
							(status = 'Commit finalises your review and unlocks peer reviews. It is one-way.')} />
					finalises the review.
				</p>
			{:else}
				<!-- The coined marks, explained once at the zone's entry instead of
				     repeated verbatim under every card. The copy stays limited to
				     observable behavior: where marks appear and why two are capped. -->
				<p class="zone-note">
					Pinned marks appear beside your review on the chair's decision board. Top pick and
					Hidden gem are capped at 3 each — a mark you could give everything ranks nothing.
				</p>
			{/if}
			<ul class="queue">
				{#each visibleRows as row (row.item.submissionId)}
					{@const id = row.item.submissionId}
					{@const draft = draftFor(id)}
					{@const busy = committingId === id}
					<!-- The card is two zones with two intents: the evidence being judged
					     (title, who, abstract, materials) and the judgment being made (the
					     score and its consequences). Side by side at desktop width so the
					     eye moves between them without scrolling; stacked where the width
					     runs out. -->
					<li class="card card--split" class:card--committed={row.item.committed}>
						<div class="card__evidence">
						<div class="card__id">
							<div class="card__head">
								<h3 class="card__title" id="{id}-title">{row.submission.title}</h3>
								{#if row.item.committed && queueScope === 'to-review'}
									<!-- Only where the state varies: in the Completed zone every
									     card is committed and the zone already says so. Here it
									     marks the card that just flipped under the person's press. -->
									<span class="ui-badge ui-badge--success">Committed</span>
								{/if}
							</div>
							{#if !plan.anonymized}
								<!-- Only inside the open-review branch: a blind plan never renders
								     the submitter at all, so it cannot gain a way to look them up. -->
								<p class="card__by"
									>{#each row.submission.speakers as speaker, index (speaker.id ?? speaker.email ?? speaker.name)}{@const profile =
										speaker.email ? profiles[speaker.email] : undefined}{#if index > 0}{', '}{/if}{#if profile}<ProfilePeek
										{profile} />{:else}{speaker.name}{/if}{/each}</p>
								{/if}
						</div>
						<div class="card__abstract">
							<ClampedText lines={2} label={row.submission.title}>
								{row.submission.abstract}
							</ClampedText>
						</div>

						<!-- What the submitter gave us is judging evidence, so it stands on
						     the card rather than waiting behind a press — and when nothing
						     was attached, that absence is stated in place: a card that only
						     shows materials when there are some hides the fact a reviewer
						     is scoring without them. -->
						<div class="card__materials">
							<ResourceList resources={row.submission.resources} density="compact" />
							<p class="card__submeta">Submitted {formatArrival(row.submission.submittedAt)}</p>
						</div>
						</div>

						<div class="card__judgment">
						{#if row.item.committed}
							{@const standing = standings[id]}
							<dl class="verdict">
								<div class="verdict__group">
									<dt class="verdict__label">Your score</dt>
									<!-- The same value-ramp ink the peer chips wear: one score
									     vocabulary, one look, mine merely larger — it is the number
									     this card exists to hold. -->
									<dd class="verdict__score">
										{#if row.item.myScore !== undefined}
											<span
												class="ui-badge {scoreTone(row.item.myScore, plan.scaleMax)} verdict__mine"
												class:verdict__peer--top={isTopScore(row.item.myScore, plan.scaleMax)}
												>{row.item.myScore}</span>
										{/if}
									</dd>
								</div>
								<div class="verdict__group">
									<dt class="verdict__label">Peer scores</dt>
									<dd class="verdict__peers">
										{#if row.item.peerScores && row.item.peerScores.length > 0}
											{#each row.item.peerScores as peerScore, index (index)}
												<span
													class="ui-badge {scoreTone(peerScore, plan.scaleMax)}"
													class:verdict__peer--top={isTopScore(peerScore, plan.scaleMax)}>{peerScore}</span>
											{/each}
										{:else}
											<span class="verdict__none">No peer review committed yet</span>
										{/if}
									</dd>
								</div>
								<div class="verdict__group verdict__group--standing">
									<dt class="verdict__label">Standing in track</dt>
									<dd class="verdict__standing" aria-busy={standing === undefined || undefined}>
										{#if standing === undefined}
											<!-- The slot is held at the mark's own height, so the claim
											     lands in place instead of pushing the card down. -->
											<span class="ui-skeleton skeleton-mark"></span>
										{:else if standing}
											<StandingMark {standing} context={row.submission.title} />
										{:else}
											<span class="verdict__none">No scored comparison yet</span>
										{/if}
									</dd>
								</div>
							</dl>
							{#if row.item.myComment}
								<p class="verdict__comment">{row.item.myComment}</p>
							{/if}

							<!-- What this review is worth to me beyond its number, and the way
							     out to the rest of my own scoring. Both belong to a committed
							     review: a mark on a draft would rank nothing. -->
							<div class="marks">
								<div
									class="marks__keys"
									role="group"
									aria-label={`My marks on “${row.submission.title}”`}>
									{#each accoladeDefs as def (def.key)}
										{@const Icon = accoladeIcon[def.key]}
										{@const pinned = row.item.accolades?.includes(def.key) ?? false}
										{@const refusal = capRefusal(def, row)}
										{#if refusal}
											<span class="marks__slot" {@attach unavailable}>
												<Popover
													label={`${def.label} on “${row.submission.title}” — why this mark is unavailable`}
													onreveal={() => (status = refusal)}>
													{#snippet trigger()}
														<span
															class="ui-button ui-button--secondary ui-button--sm marks__key marks__key--spent">
															<Icon size={13} aria-hidden="true" />{def.label}
														</span>
													{/snippet}
													{#snippet children()}
														<p class="marks__reason">{refusal}</p>
													{/snippet}
												</Popover>
											</span>
										{:else}
											<button
												type="button"
												class="ui-button ui-button--secondary ui-button--sm marks__key"
												aria-pressed={pinned}
												aria-busy={accoladeBusy === `${id}:${def.key}` || undefined}
												disabled={accoladeBusy !== null}
												onclick={() => toggleAccolade(row, def)}>
												<Icon size={13} aria-hidden="true" />{def.label}
											</button>
										{/if}
									{/each}
								</div>
								{#if queueScope === 'to-review'}
									<!-- The reveal moment is the first time these coined marks
									     exist, so the card that just flipped teaches them; in the
									     Completed zone the explanation is said once, at the zone's
									     entry, instead of verbatim under every card. -->
									<p class="marks__about">
										Pinned marks appear beside your review on the chair's decision board.
										Top pick and Hidden gem are capped at 3 each — a mark you could give
										everything ranks nothing.
									</p>
								{/if}
								{#if hasOtherCommitted(id)}
									<button
										type="button"
										class="ui-button ui-button--soft ui-button--sm marks__line"
										onclick={() => openLineup(id)}>
										Line up with my other reviews
									</button>
								{:else}
									<span class="marks__slot" {@attach unavailable}>
										<Popover
											label={`Line up with my other reviews for “${row.submission.title}” — why this is unavailable`}
											onreveal={() => (status = 'No other committed reviews yet')}>
											{#snippet trigger()}
												<span
													class="ui-button ui-button--soft ui-button--sm marks__line marks__line--spent">
													Line up with my other reviews
												</span>
											{/snippet}
											{#snippet children()}
												<p class="marks__reason">No other committed reviews yet</p>
											{/snippet}
										</Popover>
									</span>
								{/if}
							</div>
						{:else}
							<div class="score">
								<div class="score__head">
									<span class="score__label" id="{id}-score-label">Score</span>
									<!-- The anchor words say which number; the thresholds say why.
									     They are one press away rather than five permanent
									     sentences on every card. -->
									<Popover
										label={`What the numbers mean for “${row.submission.title}”`}
										kind="word">
										{#snippet trigger()}
											<span class="score__guide">What the numbers mean</span>
										{/snippet}
										{#snippet children()}
											{#each guideAnchors as anchor (anchor.value)}
												<p class="guide">
													<span class="guide__mark">{anchor.value} {anchor.caption}</span>
													{anchor.threshold}
												</p>
											{/each}
										{/snippet}
									</Popover>
								</div>
								<div
									class="ui-segmented score__scale"
									role="group"
									aria-labelledby="{id}-score-label {id}-title">
									{#each scale as value (value)}
										{@const anchor = anchorFor(value)}
										<button
											type="button"
											class="ui-segmented__item score__step"
											aria-label={anchor ? `${value} ${anchor.caption}` : undefined}
											aria-pressed={draft.score === value}
											disabled={busy}
											onclick={() => setScore(id, value)}>
											<span class="score__value">{value}</span>
											{#if anchor}<span class="score__caption">{anchor.caption}</span>{/if}
										</button>
									{/each}
								</div>
							</div>

							<Field id="{id}-comment" label="Comment" optional>
								{#snippet children({ id: fieldId, describedBy })}
									<textarea
										class="ui-textarea card__comment"
										id={fieldId}
										aria-describedby={describedBy}
										disabled={busy}
										placeholder="What would make this a strong session — or what worries you?"
										value={draft.comment}
										oninput={(event) => setComment(id, event.currentTarget.value)}
									></textarea>
								{/snippet}
							</Field>

							<div class="card__foot">
								{#if plan.antiAnchoring}
									<p class="card__lock">
										<Lock size={13} aria-hidden="true" />
										Peer reviews unlock when you commit your own.
									</p>
								{/if}
								<button
									type="button"
									class="ui-button ui-button--primary ui-button--sm card__commit"
									disabled={draft.score === undefined || busy}
									onclick={() => commit(id)}>
									{busy ? 'Committing…' : 'Commit review'}
								</button>
							</div>
						{/if}
						</div>

						{#if reviewerView}
							{@const refusal = row.item.committed
								? composeStepBackRefusal(row.submission.title)
								: undefined}
							<div class="stepback">
								{#if refusal}
									<!-- The refusal is a state of the control that would have
									     acted, kept focusable so the reason is readable. -->
									<span class="marks__slot" {@attach unavailable}>
										<Popover
											label={`Step back from “${row.submission.title}” — why this is unavailable`}
											onreveal={() => (status = refusal)}>
											{#snippet trigger()}
												<span class="ui-button ui-button--ghost ui-button--sm stepback__spent">
													Step back
												</span>
											{/snippet}
											{#snippet children()}
												<p class="marks__reason">{refusal}</p>
											{/snippet}
										</Popover>
									</span>
								{:else if armedStepBackId === id}
									<div
										class="stepback__armed"
										role="group"
										aria-label={`Step back from “${row.submission.title}”?`}
										onfocusout={armFocusout}>
										<p class="stepback__q">
											Step back from this review? It leaves your queue and waits for another
											reviewer.
										</p>
										<div class="stepback__actions">
											<button
												type="button"
												class="ui-button ui-button--secondary ui-button--sm"
												id={`confirm-step-back-${id}`}
												aria-label={`Step back from “${row.submission.title}” — confirm`}
												aria-busy={steppingBackId === id || undefined}
												disabled={steppingBackId !== null}
												onclick={() => stepBack(row)}>Step back</button>
											<button
												type="button"
												class="ui-button ui-button--ghost ui-button--sm"
												aria-label={`Keep “${row.submission.title}” in your queue`}
												onclick={() => keepReview(row)}>Keep it</button>
										</div>
									</div>
								{:else}
								<!-- The verb only: what it is for is stated once, on arrival,
								     rather than under every card in the queue. -->
									<button
										type="button"
										class="ui-button ui-button--ghost ui-button--sm"
										id={`step-back-${id}`}
										aria-label={`Step back from “${row.submission.title}”`}
										onclick={() => armStepBack(row)}>Step back</button>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
	{/if}
{/if}

<!-- The comparison, over the queue it belongs to. It mounts with the address and
     leaves with it, so nothing is loaded for a dialog nobody opened. -->
<Modal bind:open={lineupOpen} title={lineupTitle} size="lg" dismissible>
	{#if lineupId}
		<LineupPanel
			{port}
			anchorId={lineupId}
			slice={lineupSlice}
			surface="modal"
			onSliceChange={switchLineupSlice}
			onReviewChange={applyReviewChange} />
		<CommitReceipt />
	{/if}
</Modal>

<RoundSetup {port} bind:open={setupOpen} setup={roundSetup} onOpened={roundOpened} />

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line box tall, the score control is segmented
	   height, the comment box is the textarea's own minimum, and an action is
	   control-height. Free-standing sized rectangles drift; these cannot. */
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

	.skeleton-segmented {
		display: inline-block;
		inline-size: min(26rem, 100%);
		/* The segmented control: five items at item height inside its 2px frame,
		   the anchor caption line included. */
		block-size: calc(var(--je-control-height-sm) + 4px + var(--score-caption-line));
		border-radius: calc(var(--je-radius-control) + 2px);
	}

	/* Stands for the standing mark at the mark's own height, so a card that is
	   still waiting for the aggregate is exactly as tall as one that has it. */
	.skeleton-mark {
		inline-size: min(15rem, 100%);
		block-size: var(--verdict-mark-height);
		border-radius: var(--je-radius-control);
	}

	/* Carries the comment box's own class, so its minimum sets the height. */
	.skeleton-textarea {
		display: block;
		border-radius: var(--je-radius-control);
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 8rem;
		border-radius: var(--je-radius-control);
		vertical-align: bottom;
	}

	.skeleton-action--lg {
		block-size: var(--je-control-height);
		inline-size: 13rem;
	}

	/* Plan header */
	.plan {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 22rem);
		align-items: center;
		gap: var(--je-space-3) var(--je-space-8);
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.plan__id {
		min-width: 0;
	}

	.plan__name {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.plan__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2);
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.plan__link {
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.plan__means {
		margin: 0;
	}

	.plan__stat {
		display: grid;
		gap: var(--je-space-2);
		min-width: 0;
	}

	/* Committing re-reads the plan. The counter and the reviewer cells it feeds
	   dim in place; tearing them down would hide where the change lands. */
	.plan__stat.is-refreshing {
		opacity: 0.55;
		pointer-events: none;
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.plan__figure {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		margin: 0;
	}

	.plan__done {
		font-size: var(--je-font-size-2xl);
		font-weight: 700;
		line-height: var(--je-leading-tight);
		font-variant-numeric: tabular-nums;
	}

	.plan__total {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* First arrival, for the person whose queue this is: what they were asked to
	   review, then what this plan lets them see. Quiet type on the page's own
	   ground — it is read once and then stops competing with the cards. */
	.brief {
		display: grid;
		gap: var(--je-space-2);
	}

	.brief__scope {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.brief__lede {
		color: var(--je-color-text-muted);
	}

	.brief__policy {
		list-style: none;
		display: grid;
		gap: var(--je-space-1);
		margin: 0;
		padding: 0;
		max-inline-size: 78ch;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-3);
		min-width: 0;
	}

	.column__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-3);
	}

	.column__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* The queue takes the working width the split card composition earns: the
	   evidence keeps a reading measure on the left while the judgment stands
	   beside it instead of below it. One cap for everyone who reviews, and a
	   container so the card decides its own composition from the width it
	   actually has, not from the viewport. */
	.column--queue {
		max-inline-size: 76rem;
		container-type: inline-size;
		container-name: review-queue;
	}

	/* The scope set needs a definite basis inside the head's flex line — in a
	   shrink-to-fit slot it resolves to zero and the chips vanish. Capped so
	   two zones do not stretch into a navigation bar. */
	.column__scopes {
		flex: 1 1 16rem;
		min-inline-size: 0;
		max-inline-size: 24rem;
	}

	/* What a zone says once, on arrival — the commit consequence, the marks'
	   meaning. Quiet: it is read once and then stops competing with the cards. */
	.zone-note {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		max-inline-size: 62ch;
	}

	/* Queue */
	.queue {
		list-style: none;
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
	}

	.card + .card {
		margin-block-start: var(--je-space-4);
	}

	.card {
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
	}

	/*
	 * Two zones with two intents: the evidence being judged and the judgment
	 * being made. Side by side while the queue's own width allows, so the eye
	 * moves between reading and scoring without scrolling; the hairline names
	 * the boundary between them.
	 */
	.card--split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(24rem, 27rem);
		gap: var(--je-space-3) var(--je-space-6);
	}

	.card__evidence {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-3);
		min-width: 0;
	}

	.card__judgment {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-3);
		min-width: 0;
		border-inline-start: 1px solid var(--je-color-border);
		padding-inline-start: var(--je-space-6);
	}

	/* The footer actions span the whole card, under both zones. */
	.card--split > .stepback {
		grid-column: 1 / -1;
	}

	@container review-queue (max-width: 55.99rem) {
		.card--split {
			grid-template-columns: minmax(0, 1fr);
		}

		/* Stacked, the boundary turns with the layout: what was beside is now
		   beneath, and the rule follows it. */
		.card__judgment {
			border-inline-start: 0;
			padding-inline-start: 0;
			border-block-start: 1px solid var(--je-color-border);
			padding-block-start: var(--je-space-3);
		}
	}

	.card--committed {
		border-color: var(--je-color-border);
	}

	.card__id {
		display: grid;
		gap: var(--je-space-1);
	}

	.card__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-3);
	}

	.card__title {
		margin: 0;
		font-size: var(--je-font-size-base);
		font-weight: 600;
		min-width: 0;
	}

	.card__abstract {
		margin: 0;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	/* Who is behind the card is a scan key on an open (non-blind) plan, so it
	   takes the quiet person recognition hue — the same ink the Submissions
	   queue taught. A blind plan renders no byline at all, so the hue can
	   never defeat anonymity. */
	.card__by {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		color: var(--je-color-recognition-person);
		line-height: var(--je-leading-normal);
	}

	/* The scale carries its own anchor words, so the caption line is a declared
	   quantity: the control's height and the placeholder that stands in for it
	   are both measured from it and cannot drift apart. */
	.score {
		--score-caption-line: 0.9rem;
		display: grid;
		justify-items: start;
		gap: var(--je-space-2);
	}

	.score__head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-3);
	}

	.score__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* It opens a panel in place; it does not go anywhere. Painting it as a link
	   promised navigation the press never delivers, and the ring on top of the
	   hover underline stacked two affordances on one control. Ink and a dotted
	   rest state say what this actually is: more about this, right here.
	   `Popover kind="word"` supplies the solid underline on hover and open. */
	.score__guide {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
		text-decoration: underline dotted;
		text-decoration-color: var(--je-color-border-strong);
		text-underline-offset: 0.15em;
	}

	/* Five thresholds share one row, each as wide as its own word needs; the
	   control stops growing where the numbers stop being scannable. */
	.score__scale {
		display: flex;
		inline-size: 100%;
		max-inline-size: 26rem;
	}

	.score__step {
		flex: 1 1 auto;
		min-inline-size: 0;
		flex-direction: column;
		justify-content: center;
		gap: 0;
		block-size: calc(var(--je-control-height-sm) - 2px + var(--score-caption-line));
		padding-inline: var(--je-space-2);
	}

	.score__value {
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		line-height: 1.15;
		font-variant-numeric: tabular-nums;
	}

	/* The anchor stays quiet on the selected item too: it names the mark, it is
	   not the mark. */
	.score__caption {
		max-inline-size: 100%;
		overflow: hidden;
		font-size: var(--je-font-size-2xs);
		font-weight: 500;
		line-height: var(--score-caption-line);
		color: var(--je-color-text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.guide {
		margin: 0;
	}

	.guide__mark {
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}

	.card__comment {
		min-block-size: 4.5rem;
	}

	/* The standing evidence zone: the typed tiles give it its identity across
	   cards without a label or a box, and the stated absence takes the same
	   place the rows would have. */
	.card__materials {
		display: grid;
		gap: var(--je-space-2);
	}

	/* When it arrived, in the quiet time hue: dwell is part of judging a queue,
	   and one consistent ink finds it without reading the sentence. */
	.card__submeta {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-recognition-time);
		font-variant-numeric: tabular-nums;
	}

	.card__foot {
		display: grid;
		grid-template-columns: minmax(0, 1fr) max-content;
		grid-template-areas: 'lock commit';
		align-items: center;
		gap: var(--je-space-3);
	}

	.card__lock {
		grid-area: lock;
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.card__commit {
		grid-area: commit;
	}

	/* Committed state: own score first, then what committing revealed. */
	.verdict {
		/* StandingMark's own block size, named once so the waiting slot and the
		   resolved mark are the same height. */
		--verdict-mark-height: 1.375rem;
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-6);
		margin: 0;
	}

	.verdict__group {
		display: grid;
		gap: var(--je-space-1);
		min-width: 0;
	}

	.verdict__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.verdict__score {
		margin: 0;
		min-block-size: 1.7rem;
	}

	/* My score wears the same value-ramp badge as the peer chips — one score
	   vocabulary, one look — merely larger, because it is the number this card
	   exists to hold. */
	.verdict__mine {
		font-size: var(--je-font-size-md);
		font-weight: 700;
		padding-inline: var(--je-space-3);
	}

	.verdict__peers {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
		margin: 0;
		min-block-size: 1.7rem;
	}

	/* The ramp's top step keeps the badge's full weight explicitly: it is the one
	   value on the scale that should still read as the top mark if the badge
	   primitive's own weight is ever relaxed. */
	.verdict__peer--top {
		font-weight: 700;
	}

	/* The aggregate is the widest thing in the row, so it takes the slack and
	   gives it back before the two score groups have to wrap. */
	.verdict__group--standing {
		flex: 1 1 16rem;
		max-inline-size: 24rem;
	}

	.verdict__standing {
		display: flex;
		min-inline-size: 0;
		align-items: center;
		min-block-size: var(--verdict-mark-height);
		margin: 0;
	}

	.verdict__none {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.verdict__comment {
		margin: 0;
		padding-inline-start: var(--je-space-3);
		border-inline-start: 2px solid var(--je-color-border);
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
	}

	/* My own marks, and the way out to the rest of my scoring. */
	.marks {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.marks__keys {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	/* Pinned is a held state, not a hover: the key keeps the marking tint for as
	   long as the mark is on this submission. Marking, not action — an accolade
	   held in the action colour read as a flagged problem on the very surface
	   where accept and decline live. */
	.marks__key[aria-pressed='true'] {
		border-color: var(--je-color-mark-border);
		background: var(--je-color-mark-surface);
		color: var(--je-color-mark-ink);
	}

	.marks__key :global(svg) {
		inline-size: 0.8125rem;
		block-size: 0.8125rem;
	}

	/* Spent keys and a line-up with nothing to line up against keep their place
	   and their words; the reason is behind the same control. */
	.marks__key--spent,
	.marks__line--spent {
		opacity: 0.48;
		cursor: not-allowed;
	}

	.marks__slot {
		display: inline-flex;
		min-inline-size: 0;
	}

	.marks__slot :global(.ui-popover__trigger) {
		border-radius: var(--je-radius-control);
	}

	.marks__reason {
		margin: 0;
	}

	.marks__about {
		margin: var(--je-space-2) 0 0;
		max-inline-size: 52ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Declaring a conflict of interest is ordinary professional conduct, not a
	   destructive act, so it sits as a quiet footer action under the card's own
	   dividing rule rather than competing with Commit. */
	.stepback {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-3);
	}

	/* Already committed: the control keeps its place and its word, and the
	   reason is behind the same control. */
	.stepback__spent {
		opacity: 0.48;
		cursor: not-allowed;
	}

	/* The armed question replaces the trigger in place and takes the row, so the
	   confirm never lands where the trigger just was. */
	.stepback__armed {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--je-space-2) var(--je-space-3);
		inline-size: 100%;
	}

	.stepback__q {
		margin: 0;
		max-inline-size: 44ch;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.stepback__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.stepback__fill {
		inline-size: 6rem;
	}

	.queue-empty,
	.opening {
		padding: var(--je-space-6);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.queue-empty__title {
		margin: 0;
		font-weight: 600;
	}

	.queue-empty__hint {
		margin: var(--je-space-1) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.opening {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		align-content: center;
		min-block-size: 16rem;
		padding: var(--je-space-8);
	}

	.opening__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.opening__copy {
		margin: 0;
		max-inline-size: 56ch;
		font-size: var(--je-font-size-md);
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	.opening__facts {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	.opening__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-1);
	}

	/* Narrow widths restructure: one column, and the card footer puts its note
	   and its action on separate lines instead of squeezing both onto one. */
	@media (max-width: 920px) {
		.plan {
			grid-template-columns: 1fr;
			align-items: start;
			gap: var(--je-space-4);
		}

		.card__foot {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas:
				'lock'
				'commit';
			align-items: start;
		}

		.card__commit {
			justify-self: stretch;
		}

		.opening {
			padding: var(--je-space-6);
		}
	}

	@media (max-width: 560px) {
		.column__head {
			align-items: flex-start;
		}

	}
</style>
