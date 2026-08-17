<script lang="ts">
	import { onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import { ArrowDown, ArrowUp, ChevronRight, Flame, Gem, MailWarning, Star, Zap } from 'lucide-svelte';
	// The situation glyph for a surface whose measurement has not been set up.
	import { CircleDashed as NoPlan } from 'lucide-svelte';
	import {
		Alert,
		Badge,
		Button,
		Field,
		Modal,
		PENDING_MIN_VISIBLE_MS,
		Popover,
		TrackChip,
		badgeFor,
		motionMs,
		recordTable,
		revealTarget,
		shouldIgnoreRowPress,
		trackPending
	} from '$lib/ui';
	import type { IconComponent } from '$lib/ui';
	import ProfilePeek from '$lib/features/workspace/components/ProfilePeek.svelte';
	import ReviewSurface, {
		includedCount,
		templateDoor
	} from '$lib/features/workspace/components/ReviewSurface.svelte';
	import ScopeChip from '$lib/features/workspace/components/ScopeChip.svelte';
	import StandingMark from '$lib/features/workspace/components/StandingMark.svelte';
	import SubmissionRecordDetail from '$lib/features/submissions/SubmissionRecordDetail.svelte';
	import LineupPanel, { sliceKeys } from '$lib/features/review/LineupPanel.svelte';
	import type { SliceKey } from '$lib/features/review/LineupPanel.svelte';
	import {
		awaitsNotice,
		decisionStatusFor,
		noticeStatus,
		trackLabel,
		trackOrder
	} from '$lib/features/submissions/submission-view';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import { applyParams, clearParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import { describePortFailure, type PortFailureView } from '$lib/api/port-failure';
	import type { DecisionsPagePort } from '$lib/api/decisions-page-port';
	import type { ReviewPagePort } from '$lib/api/review-page-port';
	import type {
		AccoladeDef,
		AccoladeKey,
		DecisionState,
		EmailReadiness,
		MessageReview,
		MessageTemplate,
		NotificationDispatch,
		ScoreStanding,
		SpeakerProfile,
		Submission,
		SubmissionReview,
		Track
	} from '$lib/api/types';

	interface Props {
		port: DecisionsPagePort;
		/** The already-composed review projection in the sample workspace. */
		lineupPort?: ReviewPagePort;
		/** Live review authority resolves only when the comparison is requested. */
		resolveLineupPort?: () => Promise<ReviewPagePort>;
	}

	let { port, lineupPort: providedLineupPort, resolveLineupPort }: Props = $props();
	const api = $derived(port);

	/** The three decisions an organizer applies here. `withdrawn` is submitter-owned. */
	type Verdict = 'accepted' | 'waitlisted' | 'declined';

	let rows = $state<Submission[] | null>(null);
	let tracks = $state<Track[]>([]);
	let selected = $state<string[]>([]);
	let sortDir = $state<'asc' | 'desc'>('desc');
	let announcement = $state('');

	/*
	 * The deciding room (owner rework, 2026-08-15). Opening a candidate used to
	 * insert a screen-tall detail into the table — the pass disappeared under
	 * it, and the verdict stayed up on the collapsed row, an arm's length from
	 * the evidence it judges. The room is the same candidates opened one at a
	 * time *over* the pass instead: evidence beside the verdict, previous/next
	 * walking the table's own order, and a verdict advancing to the next
	 * undecided candidate — read, decide, next, without ever re-finding your
	 * place. Which candidate is scope, so it travels in the address
	 * (`?submission=`, the key deep links already used), and Back, Escape, the
	 * close button and the backdrop all return to the pass with the last
	 * candidate's row revealed.
	 */
	const openId = $derived(param('submission'));
	let roomOpen = $state(false);
	/** What the room last showed — the row the table reveals on close. */
	let lastInspected: string | null = null;

	$effect(() => {
		roomOpen = openId !== null;
	});

	// The dialog closed itself — Escape, backdrop, the X — so the address
	// follows, and the pass shows where the person left off.
	$effect(() => {
		if (roomOpen || openId === null) return;
		void applyParams({ submission: null }).then(() => revealLast());
	});

	$effect(() => {
		const id = openId;
		if (!id) return;
		lastInspected = id;
		const row = rows?.find((entry) => entry.id === id);
		if (!row) return;
		void loadReviews(row);
		// Keyed traversal changes the dialog under a reader without a focus
		// move, so the polite region says which candidate is now showing.
		announcement = `“${row.title}” — open for deciding.`;
	});

	/** No graph reads: a plain DOM lookup, so closing cannot re-fire it. */
	function revealLast() {
		if (!lastInspected) return;
		const anchor = document.querySelector<HTMLElement>(`[data-submission="${lastInspected}"]`);
		if (anchor) revealTarget(anchor);
	}

	function openRoom(id: string) {
		void applyParams({ submission: id }, { history: 'push' });
	}

	/** Walking candidates is one act of reading, so it replaces rather than
	 *  stacking a history entry per step. */
	function showCandidate(id: string) {
		void applyParams({ submission: id });
	}

	/*
	 * A line-up is a closer look at the decision pass, not a new workflow. Keep
	 * the table mounted beneath a modal and put only its scope in the address:
	 * Back, Escape, the close button and the backdrop all return to the exact
	 * row and scroll position the organizer was using.
	 */
	const lineupId = $derived(param('lineup'));
	const lineupSlice = $derived(paramIn('slice', sliceKeys, 'track'));
	const lineupRow = $derived(rows?.find((row) => row.id === lineupId));
	const lineupTitle = $derived(lineupRow ? `Line-up: “${lineupRow.title}”` : 'Line-up');
	let lineupOpen = $state(false);
	let resolvedLineupPort = $state.raw<ReviewPagePort | null>(null);
	let lineupPortFailure = $state<string | null>(null);
	let lineupPortRequest = 0;

	$effect(() => {
		lineupOpen = lineupId !== null;
	});

	$effect(() => {
		if (providedLineupPort) resolvedLineupPort = providedLineupPort;
	});

	$effect(() => {
		if (lineupOpen || lineupId === null) return;
		void applyParams({ lineup: null, slice: null });
	});

	$effect(() => {
		const id = lineupId;
		if (!id || resolvedLineupPort || !resolveLineupPort) return;
		const token = (lineupPortRequest += 1);
		lineupPortFailure = null;
		void resolveLineupPort()
			.then((next) => {
				if (token === lineupPortRequest) resolvedLineupPort = next;
			})
			.catch((error: unknown) => {
				if (token !== lineupPortRequest) return;
				lineupPortFailure = describePortFailure(
					error,
					'The comparison could not be loaded.'
				).message;
			});
	});

	function openLineup(submissionId: string) {
		void applyParams({ lineup: submissionId, slice: null }, { history: 'push' });
	}

	function switchLineupSlice(next: SliceKey) {
		void applyParams({ slice: next === 'track' ? null : next }, { history: 'push' });
	}

	// The committed reviews behind a row's average, read once per submission the
	// first time its row opens. A decision re-read does not change any review,
	// so an entry never goes stale within a session.
	let reviewsBy = $state<Record<string, SubmissionReview[]>>({});
	// A per-row read the port refused, kept as its reviewed copy so the open
	// detail states the refusal instead of holding a loading treatment for an
	// answer that is already refused (aggregates-only live evidence).
	let reviewRefusals = $state<Record<string, string>>({});
	/**
	 * The candidate reads failed and nothing newer has landed. While `rows` is
	 * still null this replaces the first-load skeletons (a skeleton over a
	 * refused answer claims work that is not happening); with rows on screen it
	 * renders as a notice over the kept truth. `retryable` follows the port's
	 * own classification — a terminal refusal never offers a retry.
	 */
	let loadFailure = $state<PortFailureView | null>(null);
	/** A decision that did not commit, stated in the port's reviewed copy. */
	let decideNotice = $state<{ title: string; message: string } | null>(null);
	/** The notification projection/readiness refusal, rendered inside the dialog. */
	let notifyRefusal = $state<string | null>(null);
	/** The plan's scale, for inking each review's score chip. */
	let scaleMax = $state(5);
	/** Submissions the current person holds a committed review on. */
	let myCommitted = $state<string[]>([]);
	/** In-flight notification send; decisions track their own rows via `pendingIds`. */
	let busy = $state(false);

	let confirmOpen = $state(false);
	let pendingVerdict = $state<Verdict>('accepted');
	let pendingDecisionIds = $state<string[]>([]);
	let pendingFromBulk = $state(false);
	let acceptanceTrackIds = $state<Record<string, string>>({});
	let notifyOpen = $state(false);
	let subject = $state('Your submission decision');
	/**
	 * What the committed send did, in the port's own record. Null until a send
	 * in this dialog lands; the panel states this result rather than the count
	 * the dialog asked for, so a commit nobody received never reads as mail
	 * that went out.
	 */
	let dispatch = $state.raw<NotificationDispatch | null>(null);
	/** The reviewed batch: the ids below are exactly the ids the send commits. */
	let notifyIds = $state.raw<string[]>([]);
	let notifyReview = $state.raw<MessageReview | null>(null);
	let notifyReadiness = $state.raw<EmailReadiness | null>(null);
	/**
	 * Whether this event has a review plan at all. `plansRead` separates "not
	 * asked yet" from "asked, and there is none" so a row never claims a setup
	 * gap that has not been confirmed.
	 */
	let hasPlan = $state(false);
	let plansRead = $state(false);

	/** Stored templates, read once so the review's template fact can be a door. */
	let templates = $state.raw<MessageTemplate[] | null>(null);

	// One fact, one door on this surface: only the review's template line links
	// to the stored template it renders from (see `templateDoor`).
	const notifyDoor = $derived(templateDoor(notifyReview?.templateLabel, templates));

	const uid = $props.id();

	// Evidence from the already-fetched workspace summary decides whether the
	// conditional banner deserves a placeholder: a skeleton for a banner that
	// resolves to absent would collapse the page upward when data arrives.
	const expectBanner = $derived(api.workspace.decisionAttentionExpectedSnapshot() === true);

	const verdicts: { value: Verdict; label: string }[] = [
		{ value: 'accepted', label: 'Accept' },
		{ value: 'waitlisted', label: 'Waitlist' },
		{ value: 'declined', label: 'Decline' }
	];

	const verdictCopy: Record<Verdict, { verb: string; past: string }> = {
		accepted: { verb: 'Accept', past: 'accepted' },
		waitlisted: { verb: 'Waitlist', past: 'waitlisted' },
		declined: { verb: 'Decline', past: 'declined' }
	};

	/** Only organizer decisions can be pending a notification. */
	function isDecided(row: Submission): boolean {
		return row.decision !== 'undecided' && row.decision !== 'withdrawn';
	}

	/** The reviewer's own marks, drawn in the vocabulary the whole product uses. */
	const accoladeIcon: Record<AccoladeKey, IconComponent> = {
		top_pick: Star,
		hidden_gem: Gem,
		crowd_draw: Flame,
		bold_bet: Zap
	};

	// Where each candidate's average stands among the scored submissions in its
	// track, and which accolades this reviewer pinned to it. Both are read
	// alongside the rows rather than after them, so a row arrives complete.
	let standings = $state<Record<string, ScoreStanding>>({});
	let standingsRead = $state(false);
	let accoladeDefs = $state.raw<AccoladeDef[]>([]);
	let myAccolades = $state.raw<Record<string, AccoladeKey[]>>({});

	// Who submitted, keyed by the address on the submission. Null is a read that
	// came back with nothing, and it is kept: a submitter without a profile is
	// the ordinary case, and asking again on every decision re-read would spend a
	// round trip to learn the same nothing. Absent means "not asked yet", which
	// renders as the plain name it already was.
	let profiles = $state<Record<string, SpeakerProfile | null>>({});

	/** The pinned keys for one submission, in catalog order. */
	function pinnedFor(submissionId: string): AccoladeDef[] {
		const keys = myAccolades[submissionId];
		if (!keys || keys.length === 0) return [];
		return accoladeDefs.filter((def) => keys.includes(def.key));
	}

	// A reload keeps the candidates a person is reading and dims them until the
	// replacement lands; only the first load, with nothing to keep, uses skeletons.
	let refreshing = $state(false);
	const reload = trackPending(() => refreshing, { minVisibleMs: PENDING_MIN_VISIBLE_MS });

	/** Only the latest issued load may write, so overlapping re-reads cannot land stale. */
	let loadSeq = 0;

	/**
	 * One pass for the whole table, after the candidates are on screen. Only
	 * addresses this session has never asked about are read, so the re-read that
	 * follows every decision costs nothing. The map is replaced rather than
	 * mutated, so the ticket is what stops an older pass from clobbering entries
	 * a newer one already wrote.
	 */
	async function loadProfiles(landed: Submission[], seq: number) {
		const emails = [
			...new Set(landed.flatMap((row) => row.speakers.map((speaker) => speaker.email)))
		].filter((email) => !(email in profiles));
		if (emails.length === 0) return;
		const found = await Promise.all(emails.map((email) => api.speakers.profile(email)));
		if (seq !== loadSeq) return;
		const next = { ...profiles };
		emails.forEach((email, index) => (next[email] = found[index]));
		profiles = next;
	}

	/**
	 * Candidates are the inbox and late trays. Set-aside and spam submissions
	 * are triage outcomes, so they are never decided from this table.
	 *
	 * The table-wide dim is a reload treatment: first paint has skeletons and
	 * nothing to keep, and a quiet re-read resolves on the rows that asked for
	 * it, so only a visible re-read with rows on screen turns it on.
	 */
	async function load({ quiet = false }: { quiet?: boolean } = {}) {
		const seq = ++loadSeq;
		if (!quiet && rows !== null) refreshing = true;
		let landed: Submission[] = [];
		try {
			try {
				const [inbox, late] = await Promise.all([
					api.submissions.list({ tray: 'inbox' }),
					api.submissions.list({ tray: 'late' })
				]);
				if (seq !== loadSeq) return;
				landed = [...inbox.rows, ...late.rows];
				rows = landed;
				loadFailure = null;
				// A room showing a candidate the newest result set no longer holds
				// would be deciding on a submission the operator can no longer see.
				if (openId !== null && !landed.some((row) => row.id === openId)) roomOpen = false;
				// The marks already on screen stay on screen: a decision re-read does
				// not change any average, and blanking them back to a pending figure
				// would flash the whole column for nothing. Only the flag reopens, so
				// rows that arrived without a mark yet show the pending figure.
				standingsRead = false;
			} finally {
				if (seq === loadSeq) refreshing = false;
			}
			// One batch for the whole table, read after the rows are on screen. The
			// average cells reserve the mark's geometry from first paint, so these
			// resolve in place rather than widening the column under the reader.
			if (landed.length === 0) {
				standingsRead = true;
				return;
			}
			// The standing marks and the submitter profiles are two independent reads
			// of the same landed rows, so neither waits on the other.
			const [marks] = await Promise.all([
				api.review.standings(landed.map((row) => row.id)),
				loadProfiles(landed, seq)
			]);
			if (seq !== loadSeq) return;
			standings = marks;
			standingsRead = true;
		} catch (error) {
			// The failure becomes surfaced state, never an unhandled rejection: an
			// eternal skeleton over a refused answer was the exact defect here.
			if (seq === loadSeq) loadFailure = describePortFailure(error);
		}
	}

	/**
	 * The mount reads plus the first candidate load, re-runnable as the failure
	 * surface's retry. A failure lands in `loadFailure` with the port's own
	 * copy and retryability instead of rejecting out of `onMount`.
	 */
	async function boot() {
		loadFailure = null;
		try {
			// The accolades land with the first rows, so a pinned cluster is never a
			// late arrival that pushes a title sideways.
			const [trackList, settings, queue, defs, templateList, planList] = await Promise.all([
				api.vocab.tracks(),
				api.settings.get(),
				api.review.myQueue(),
				api.review.accoladeDefs(),
				api.templates.list(),
				api.review.plans()
			]);
			tracks = trackList;
			templates = templateList.messages;
			// Read once, only to tell "nobody has reviewed this yet" apart from
			// "there is nowhere to review it": the two look identical in a row and
			// need completely different things from the organizer.
			hasPlan = planList.length > 0;
			plansRead = true;
			scaleMax = planList[0]?.scaleMax ?? 5;
			if (settings) subject = `Your submission decision — ${settings.name}`;
			accoladeDefs = defs;
			myCommitted = queue.filter((item) => item.committed).map((item) => item.submissionId);
			myAccolades = Object.fromEntries(
				queue
					.filter((item) => item.accolades && item.accolades.length > 0)
					.map((item) => [item.submissionId, item.accolades as AccoladeKey[]])
			);
		} catch (error) {
			loadFailure = describePortFailure(error);
			return;
		}
		await load();
	}

	onMount(() => {
		void boot();
	});

	// Submissions without a review average sort last in both directions, so
	// reversing the column never buries the scored rows under unscored ones.
	const sorted = $derived.by(() => {
		if (!rows) return [];
		const factor = sortDir === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			if (a.reviewAverage === undefined || b.reviewAverage === undefined) {
				return (a.reviewAverage === undefined ? 1 : 0) - (b.reviewAverage === undefined ? 1 : 0);
			}
			return (a.reviewAverage - b.reviewAverage) * factor;
		});
	});

	const decidedCount = $derived(sorted.filter(isDecided).length);
	const unnotified = $derived(sorted.filter((row) => isDecided(row) && !row.notified));
	/** One email per speaker on an un-notified submission. */
	const recipientCount = $derived(unnotified.reduce((sum, row) => sum + row.speakers.length, 0));

	// An alert reading "3 decisions not yet notified" lands here with its scope
	// in the address, so the table opens on exactly those decisions. The
	// chip says so on the surface and clears it in one press.
	const scoped = $derived(param('scope') === 'unnotified');
	const scopeLabel = 'Results not sent';


	// The schedule pool's "collecting — N proposals" count lands here the same
	// way, with its session in the address: the table narrows to the proposals
	// aimed at that target. The scope lives only in the URL; both scopes stack.
	const targetScope = $derived(param('target'));
	const targeted = $derived(
		targetScope ? sorted.filter((row) => row.targetSessionId === targetScope) : sorted
	);
	const visible = $derived(
		scoped ? targeted.filter((row) => isDecided(row) && !row.notified) : targeted
	);

	// -------------------------------------------------------------------------
	// The pass (23 §3): undecided candidates above, decided below, and a verdict
	// moves the row between them — so the working set visibly shrinks toward
	// zero instead of staying exactly as long as when the pass began.

	/** Verdicts order the decided group by what still needs doing, then recency. */
	const decidedRank: Record<DecisionState, number> = {
		accepted: 0,
		waitlisted: 1,
		declined: 2,
		withdrawn: 3,
		undecided: 4
	};

	const stillToDecide = $derived(visible.filter((row) => row.decision === 'undecided'));
	const decidedRows = $derived.by(() =>
		visible
			.filter((row) => row.decision !== 'undecided')
			.sort(
				(a, b) =>
					decidedRank[a.decision] - decidedRank[b.decision] ||
					(b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')
			)
	);

	/**
	 * One flat keyed list — headers and rows together — because the FLIP that
	 * carries a just-decided row down into the Decided group can only animate
	 * reordering inside a single keyed each. Each item renders as its own
	 * `<tbody>` so a row and its expansion stay one animatable unit.
	 */
	type DisplayItem =
		| { kind: 'header'; id: string; label: string; count: number }
		| { kind: 'row'; id: string; row: Submission };

	const display = $derived.by<DisplayItem[]>(() => {
		const items: DisplayItem[] = [];
		if (stillToDecide.length > 0) {
			items.push({
				kind: 'header',
				id: 'group-open',
				label: 'Still to decide',
				count: stillToDecide.length
			});
			for (const row of stillToDecide) items.push({ kind: 'row', id: row.id, row });
		}
		if (decidedRows.length > 0) {
			items.push({ kind: 'header', id: 'group-decided', label: 'Decided', count: decidedRows.length });
			for (const row of decidedRows) items.push({ kind: 'row', id: row.id, row });
		}
		return items;
	});

	/**
	 * The finale: the pass is finished — every candidate on this surface holds
	 * a decision — and the empty working set becomes the hand-off. Scoped views
	 * keep their own empties; the finale belongs to the full pass only.
	 */
	const finaleActive = $derived(
		rows !== null && visible.length > 0 && stillToDecide.length === 0 && !scoped && !targetScope
	);

	/** Sessions in the program pool still waiting on a slot, for the finale's door. */
	let unplacedCount = $state<number | null>(null);
	// Outside the graph: which finale activation the read answered.
	let placementTicket = 0;
	$effect(() => {
		if (!finaleActive) {
			placementTicket += 1;
			unplacedCount = null;
			return;
		}
		const ticket = ++placementTicket;
		void api.schedule.state().then((state) => {
			if (ticket !== placementTicket) return;
			const placed = new Set(state.placements.map((placement) => placement.sessionId));
			unplacedCount = state.sessions.filter(
				(session) => session.state === 'programmed' && !placed.has(session.id)
			).length;
		}).catch(() => {
			// Null stays "not known": the finale simply keeps its placement door
			// shut instead of surfacing a count nobody read.
			if (ticket === placementTicket) unplacedCount = null;
		});
	});

	const waitlistedCount = $derived(visible.filter((row) => row.decision === 'waitlisted').length);

	/** The targeted session's title, read once per target so the chip can name it. */
	let targetTitle = $state<string | null>(null);
	// A plain let, outside the graph: which target the title read has answered,
	// so a repaint cannot re-issue the read.
	let titleReadFor: string | null = null;
	$effect(() => {
		const id = targetScope;
		if (!id) {
			titleReadFor = null;
			targetTitle = null;
			return;
		}
		if (titleReadFor === id) return;
		titleReadFor = id;
		targetTitle = null;
		void api.schedule.state().then((state) => {
			if (titleReadFor !== id) return;
			targetTitle = state.sessions.find((session) => session.id === id)?.title ?? null;
		}).catch(() => {
			// The chip keeps naming the scope's shape; the filter is never anonymous.
		});
	});

	// The chip names the session as soon as the title read lands; until then it
	// still names the scope's shape, so the filter is never anonymous.
	const targetLabel = $derived(
		targetTitle ? `Proposals for “${targetTitle}”` : 'Proposals for one session'
	);

	function clearScope() {
		selected = [];
		// Pushed, so the Back button returns to the scoped view it came from.
		void clearParams(['scope'], { history: 'push' });
	}

	function clearTargetScope() {
		selected = [];
		void clearParams(['target'], { history: 'push' });
	}

	async function loadReviews(row: Submission) {
		if (row.reviewCount === 0 || row.id in reviewsBy || row.id in reviewRefusals) return;
		try {
			const landed = await api.review.forSubmission(row.id);
			reviewsBy = { ...reviewsBy, [row.id]: landed };
		} catch (error) {
			// A refused per-reviewer read renders as the port's own copy in the
			// detail, never as a loading treatment for an already-refused answer.
			reviewRefusals = { ...reviewRefusals, [row.id]: describePortFailure(error).message };
		}
	}

	/**
	 * The row is a bigger door to the room, for the pointer only. The chevron
	 * stays the one focusable trigger; which presses belong to the row's own
	 * controls — or to a text selection — is the shared row-press contract in
	 * `$lib/ui`.
	 */
	function onRowPress(event: MouseEvent, id: string) {
		if (shouldIgnoreRowPress(event)) return;
		openRoom(id);
	}

	// -------------------------------------------------------------------------
	// The room's own facts, derived from the same groups the table renders.

	/** The rows as rendered — down the pass, then through the decided group. */
	const orderedRows = $derived([...stillToDecide, ...decidedRows]);
	/** The candidate the room shows. Read from all candidates, not the scoped
	 *  view: a deep link to a scope-hidden row still keeps its promise. */
	const openRow = $derived(rows?.find((row) => row.id === openId) ?? null);
	const openIndex = $derived(orderedRows.findIndex((row) => row.id === openId));

	function step(delta: number) {
		if (orderedRows.length === 0) return;
		const from = openIndex === -1 ? (delta > 0 ? -1 : 0) : openIndex;
		const next = orderedRows[Math.min(Math.max(from + delta, 0), orderedRows.length - 1)];
		if (next && next.id !== openId) showCandidate(next.id);
	}

	/**
	 * A verdict from the room advances the pass: the decided candidate leaves
	 * the undecided group, and the room moves to the one now standing where it
	 * stood — read, decide, next. Every keyed or pressed verdict is the same
	 * receipted forward move it is on the row, so no confirm interrupts the
	 * rhythm; when the last undecided candidate is decided the room closes onto
	 * the finale. Re-deciding an already-decided candidate stays put — that is
	 * a correction, not the pass moving.
	 */
	async function decideFromRoom(row: Submission, verdict: Verdict) {
		if (row.decision === verdict) return;
		const wasUndecided = row.decision === 'undecided';
		const index = stillToDecide.findIndex((entry) => entry.id === row.id);
		const outcome = decideRow(row, verdict);
		// The trackless-accept confirm took over: the person answers it and
		// returns to this candidate; advancing under a dialog would move the
		// room behind their back.
		if (!(outcome instanceof Promise)) return;
		const committed = await outcome;
		if (!committed || !wasUndecided || !roomOpen) return;
		if (stillToDecide.length === 0) {
			roomOpen = false;
			return;
		}
		const next = stillToDecide[Math.min(Math.max(index, 0), stillToDecide.length - 1)];
		if (next) showCandidate(next.id);
	}

	/** j/k walk the candidates; a/w/d decide — the reading-speed pass of 05 §3,
	 *  now carried by the room. */
	const verdictKeys: Record<string, Verdict> = { a: 'accepted', w: 'waitlisted', d: 'declined' };

	function onKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (orderedRows.length === 0) return;
		if (!roomOpen) {
			// From the table, j or k starts the pass: the room opens on the first
			// candidate still waiting (or the top of the table once none are).
			if (event.key === 'j' || event.key === 'k') {
				const first = stillToDecide[0] ?? orderedRows[0];
				if (first) openRoom(first.id);
			}
			return;
		}
		if (event.key === 'j') return step(1);
		if (event.key === 'k') return step(-1);
		const verdict = verdictKeys[event.key];
		if (!verdict || !openRow) return;
		void decideFromRoom(openRow, verdict);
	}

	const allSelected = $derived(visible.length > 0 && selected.length === visible.length);

	/** Labels count the reviewed recipients once the projection has arrived. */
	const emailCount = $derived(notifyReview ? includedCount(notifyReview) : recipientCount);

	/* Position in the event's own track list walks the accent palette from the
	   top, so a track wears the same colour here as on the submissions queue. */
	const trackIds = $derived(trackOrder(tracks));

	function plural(count: number, word: string) {
		return `${count} ${word}${count === 1 ? '' : 's'}`;
	}

	function toggleSelected(id: string) {
		selected = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
	}

	function toggleAll() {
		selected = allSelected ? [] : visible.map((row) => row.id);
	}

	function toggleSort() {
		sortDir = sortDir === 'desc' ? 'asc' : 'desc';
	}

	// A decision resolves on the rows it commits, not on the whole table: the
	// committed rows dim in place while a quiet full re-read fetches the new
	// truth, and every other row stays readable and actionable.
	//
	// `pendingIds` is the in-flight truth and blocks repeat activation from the
	// first frame. The dim keys off the tracker, so a commit faster than the
	// grace tier leaves no trace; `dimmedIds` carries the rows through the
	// minimum-visible tail after the work lands, so a shown dim never blinks.
	let pendingIds = $state<string[]>([]);
	let dimmedIds = $state<string[]>([]);
	const deciding = trackPending(() => pendingIds.length > 0, {
		minVisibleMs: PENDING_MIN_VISIBLE_MS
	});

	$effect(() => {
		if (pendingIds.length === 0 && !deciding.visible && dimmedIds.length > 0) dimmedIds = [];
	});

	/**
	 * Accepting is a graduation: a row that names a still-collecting session
	 * joins it, and every other acceptance lands a new unplaced session in the
	 * program pool. The receipt states where each landed and carries the door
	 * there, so the organizer can keep batching without losing the placement
	 * debt. Corrections are later guarded decisions; the receipt never offers
	 * compensation for the graduation.
	 */
	function acceptanceReceipt(committed: Submission[]) {
		const joined = committed.filter((row) => row.targetSessionId).length;
		const pooled = committed.length - joined;
		const head =
			committed.length === 1 ? `Accepted “${committed[0].title}”` : `Accepted ${committed.length}`;
		const landing =
			joined === 0
				? 'added to the program pool'
				: pooled === 0
					? committed.length === 1
						? 'joined its session'
						: 'joined their sessions'
					: `${pooled} new in the program pool, ${joined} joined ${joined === 1 ? 'a session' : 'sessions'}`;
		return {
			label: `${head} — ${landing}`,
			href: '/app/schedule?tray=unplaced',
			hrefLabel: committed.length === 1 ? 'Place it' : 'Place them'
		};
	}

	/**
	 * Resolves true only when the verdict committed. A refusal never escapes as
	 * a rejection: the row re-syncs to the server's truth and the port's own
	 * copy renders as the page notice — the typed `target_unavailable`
	 * re-offer included — instead of vanishing into a floated promise.
	 */
	async function decide(
		ids: string[],
		decision: DecisionState,
		label: string,
		trackIdsBySubmission: Readonly<Record<string, string>> = {}
	): Promise<boolean> {
		// A row already committing is dropped rather than committed twice.
		const targets = ids.filter((id) => !pendingIds.includes(id));
		if (targets.length === 0) return true;
		const committed = (rows ?? []).filter((row) => targets.includes(row.id));
		decideNotice = null;
		pendingIds = [...pendingIds, ...targets];
		dimmedIds = [...new Set([...dimmedIds, ...targets])];
		try {
			try {
				await api.decisions.decide(targets, decision, trackIdsBySubmission);
			} catch (error) {
				// A failed write can still have committed (a timeout, a dropped
				// response), so re-sync from the server while the failure surfaces.
				void load();
				decideNotice = {
					title: targets.length === 1 ? 'The decision was not applied' : 'The decisions were not applied',
					message: describePortFailure(error, 'The decision could not be completed.').message
				};
				return false;
			}
			const graduation = decision === 'accepted' ? acceptanceReceipt(committed) : null;
				recordAction({
					area: 'decisions',
					label: graduation?.label ?? label,
					href: graduation?.href,
					hrefLabel: graduation?.hrefLabel,
					notUndoableReason: 'Choose another result if this decision needs correcting.'
				});
			await load({ quiet: true });
			return true;
		} finally {
			pendingIds = pendingIds.filter((id) => !targets.includes(id));
		}
	}

	/**
	 * Returns the commit's own promise where the verdict goes straight through,
	 * and nothing where the trackless-accept confirm takes over — which is how
	 * the room knows whether the pass may advance.
	 */
	function decideRow(row: Submission, verdict: Verdict): Promise<boolean> | undefined {
		if (row.decision === verdict) return undefined;
		if (
			verdict === 'accepted' &&
			!row.targetSessionId &&
			row.trackId === '' &&
			tracks.filter((track) => track.status === 'active').length > 1
		) {
			pendingVerdict = verdict;
			pendingDecisionIds = [row.id];
			pendingFromBulk = false;
			prepareAcceptanceTracks([row.id]);
			confirmOpen = true;
			return undefined;
		}
		const past = verdictCopy[verdict].past;
		return decide([row.id], verdict, `${past[0].toUpperCase()}${past.slice(1)} “${row.title}”`);
	}

	function askBulk(verdict: Verdict) {
		pendingVerdict = verdict;
		pendingDecisionIds = [...selected];
		pendingFromBulk = true;
		prepareAcceptanceTracks(selected);
		confirmOpen = true;
	}

	function prepareAcceptanceTracks(ids: readonly string[]) {
		const active = tracks.filter((track) => track.status === 'active');
		const next: Record<string, string> = {};
		for (const row of (rows ?? []).filter((candidate) => ids.includes(candidate.id))) {
			if (row.targetSessionId || row.trackId !== '' || active.length === 0) continue;
			next[row.id] = active.length === 1 ? active[0]!.id : '';
		}
		acceptanceTrackIds = next;
	}

	const acceptanceRowsNeedingTrack = $derived(
		pendingVerdict === 'accepted'
			? (rows ?? []).filter(
					(row) => pendingDecisionIds.includes(row.id) && !row.targetSessionId && row.trackId === ''
				)
			: []
	);
	const acceptanceTracksReady = $derived(
		tracks.filter((track) => track.status === 'active').length === 0 ||
			acceptanceRowsNeedingTrack.every((row) => acceptanceTrackIds[row.id])
	);

	async function confirmBulk() {
		const ids = pendingDecisionIds;
		if (!acceptanceTracksReady) return;
		confirmOpen = false;
		const committed = await decide(
			ids,
			pendingVerdict,
			`Set ${plural(ids.length, 'submission')} to ${verdictCopy[pendingVerdict].past}`,
			acceptanceTrackIds
		);
		// A refused bulk verdict keeps the picks: the notice names why, and the
		// selection is what a corrected retry acts on.
		if (committed && pendingFromBulk) selected = [];
		pendingDecisionIds = [];
		acceptanceTrackIds = {};
	}

	// The dialog opens on the reviewable batch and then fills in: the projection
	// and provider readiness arrive into a shell that already holds its place.
	// A refusal fills the same shell with the port's own copy — the dialog must
	// never hold its loading footprint for an answer that is already refused.
	async function openNotify() {
		const ids = unnotified.map((row) => row.id);
		dispatch = null;
		notifyIds = ids;
		notifyReview = null;
		notifyReadiness = null;
		notifyRefusal = null;
		notifyOpen = true;
		try {
			const [projection, delivery] = await Promise.all([
				api.decisions.reviewNotification(ids),
				api.communications.readiness()
			]);
			if (!notifyOpen || notifyIds !== ids) return;
			notifyReview = projection;
			notifyReadiness = delivery;
		} catch (error) {
			if (!notifyOpen || notifyIds !== ids) return;
			notifyRefusal = describePortFailure(
				error,
				'The notification review could not be loaded.'
			).message;
		}
	}

	/**
	 * The send's outcome in one line, from the committed result: acceptance by
	 * an outbound provider is what "sent" means here, so a release nobody
	 * accepted is stated as committed — never as email that went out.
	 */
	function dispatchTitle(result: NotificationDispatch): string {
		if (result.sent === null) return `${plural(result.committed, 'notification')} committed`;
		if (result.sent === 0) {
			return `${plural(result.committed, 'notification')} committed — nothing sent`;
		}
		if (result.sent === result.committed) return `${plural(result.sent, 'email')} sent`;
		return `${result.sent} of ${plural(result.committed, 'email')} sent`;
	}

	/** The same truth in the receipt trail, which outlives the dialog. */
	function dispatchReceiptLabel(result: NotificationDispatch): string {
		if (result.sent === null) {
			return `Committed ${plural(result.committed, 'decision notification')}`;
		}
		if (result.sent === 0) {
			return `Committed ${plural(result.committed, 'decision notification')} — nothing sent`;
		}
		if (result.sent === result.committed) {
			return `Sent ${plural(result.sent, 'decision notification')}`;
		}
		return `Sent ${result.sent} of ${plural(result.committed, 'decision notification')}`;
	}

	async function sendNotifications() {
		busy = true;
		try {
			const result = await api.decisions.notify(notifyIds, subject);
			recordAction({
				area: 'decisions',
				label: dispatchReceiptLabel(result),
				// Both halves are true of every committed send: the release is
				// immutable, and any copy a provider did accept is gone.
				notUndoableReason:
					'A committed release cannot be withdrawn, and email cannot be recalled once a provider accepts it.'
			});
			dispatch = result;
			await load();
		} catch (error) {
			// Nothing was pretended sent; the dialog states the refusal in place.
			notifyRefusal = describePortFailure(error, 'The notifications were not sent.').message;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if !rows}
	{#if expectBanner && !loadFailure}
		<!-- The banner's own composition with skeleton fills: geometry comes from
		     the same classes the resolved banner uses, so it cannot drift. -->
		<section class="banner" aria-hidden="true">
			<span class="banner__plate ui-skeleton"></span>
			<div class="banner__copy">
				<p class="banner__title"><span class="ui-skeleton skeleton-line" style="inline-size: 18rem"></span></p>
				<p class="banner__detail"><span class="ui-skeleton skeleton-line" style="inline-size: 26rem"></span></p>
			</div>
			<span class="ui-skeleton skeleton-action"></span>
		</section>
	{/if}
{:else if unnotified.length > 0 && !finaleActive}
	<!-- While the pass still has undecided rows the un-notified gap keeps its
	     ambient banner; once the pass completes, the finale below carries the
	     same send door and this yields — one door per fact on one page. -->
	<section class="banner" aria-labelledby="{uid}-banner">
		<span class="banner__plate" aria-hidden="true"><MailWarning size={16} /></span>
		<div class="banner__copy">
			<p class="banner__title" id="{uid}-banner">
				{recipientCount === 1
					? '1 speaker has not been told their result'
					: `${recipientCount} speakers have not been told their result`}
			</p>
			<p class="banner__detail">
				A verdict does not contact anyone. Review and send each result when you are ready.
			</p>
		</div>
		<button type="button" class="ui-button ui-button--primary ui-button--sm banner__action" onclick={openNotify}>
			Send their results
		</button>
	</section>
{/if}

{#if openId === null}
	<!-- While the room is open its own receipt rides inside the dialog's top
	     layer; a fixed banner down here would sit under the scrim. -->
	<CommitReceipt />
{/if}

{#if loadFailure && rows !== null}
	<!-- The kept rows are yesterday's truth; the notice says the re-read behind
	     them failed, in the port's own copy. Keyed so a fresh failure replaces
	     a dismissed one instead of inheriting its hidden state. -->
	{#key loadFailure}
		<Alert
			tone="danger"
			title="The candidate list could not be refreshed"
			message={loadFailure.message} />
	{/key}
{/if}

{#if decideNotice}
	{#key decideNotice}
		<Alert tone="danger" title={decideNotice.title} message={decideNotice.message} dismissible />
	{/key}
{/if}

<p class="ui-sr-only" role="status">{announcement}</p>

<section class="table-region" aria-labelledby="{uid}-heading">
	<header class="head">
		<h2 class="head__title" id="{uid}-heading">Candidates</h2>
		{#if scoped}
			<ScopeChip label={scopeLabel} onclear={clearScope} />
		{/if}
		{#if targetScope}
			<ScopeChip label={targetLabel} onclear={clearTargetScope} />
		{/if}
		{#if rows}
			<p class="head__note">
				{#if scoped}
					{plural(visible.length, 'decision')} waiting on a notification, of {plural(sorted.length, 'candidate')}.
				{:else if targetScope}
					{plural(visible.length, 'proposal')} aimed at this session, of {plural(sorted.length, 'candidate')}.
				{:else if sorted.length - decidedCount > 0}
					<!-- Pace, not inventory: the number that shrinks as the pass moves. -->
					{sorted.length - decidedCount} of {plural(sorted.length, 'candidate')} still to decide —
					set-aside and spam submissions are not decided here.
				{:else}
					All {plural(sorted.length, 'candidate')} decided — set-aside and spam submissions
					are not decided here.
				{/if}
			</p>
		{:else if !loadFailure}
			<p class="head__note" aria-hidden="true"><span class="ui-skeleton skeleton-line" style="inline-size: min(28rem, 100%)"></span></p>
		{/if}
	</header>

	<!-- Said once for the surface: every "No reviews yet" below has one shared
	     cause, and repeating it per row would state one fact as many. Deciding
	     without scores is allowed, so this reports a gap rather than blocking
	     the table — and it carries the way to close it, because a fact shown
	     without its next step is the defect the orientation grammar exists to
	     prevent. -->
	{#if rows && rows.length > 0 && plansRead && !hasPlan}
		<p class="no-plan">
			<span class="no-plan__mark" aria-hidden="true"><NoPlan size={14} /></span>
			<span>
				No review plan yet, so nothing here has a score. You can still decide without
				one. <a href="/app/review">Set up review</a>
			</span>
		</p>
	{/if}

	<div class="ui-table-wrap" class:is-refreshing={reload.visible} aria-busy={refreshing || undefined}>
		<!-- The attachment restores what a display change costs: table roles once
		     the row re-composes into a record, and the column names mirrored onto
		     the cells that stack. Below the columns' width the pass becomes
		     rail · candidate · decision · affordance, with track, average and the
		     verdict buttons stacked and labelled beneath — nothing off-screen. -->
		<table class="ui-table ui-table--multiline" {@attach recordTable()}>
			<thead>
				<tr>
					<th class="col-check ui-pick-cell">
						<label class="ui-pick">
							<input type="checkbox" aria-label="Select all candidates" checked={allSelected} onchange={toggleAll} />
						</label>
					</th>
					<th>Submission</th>
					<th>Track</th>
					<th
						class="ui-table__number col-avg"
						aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}>
						<button type="button" class="ui-button ui-button--ghost ui-button--sm sort" onclick={toggleSort}>
							Review avg
							{#if sortDir === 'asc'}
								<ArrowUp size={12} aria-hidden="true" />
							{:else}
								<ArrowDown size={12} aria-hidden="true" />
							{/if}
							<span class="ui-sr-only">
								— sorted {sortDir === 'asc' ? 'lowest first' : 'highest first'}, activate to reverse
							</span>
						</button>
					</th>
					<th>Decision</th>
					<th>Set decision</th>
					<th class="col-expand"><span class="ui-sr-only">Details</span></th>
				</tr>
			</thead>
			{#if !rows}
				{#if loadFailure}
					<!-- The reads behind the first paint failed or refused: the typed
					     state replaces the skeletons, because a skeleton claims work
					     that is no longer happening. Only a retryable failure offers
					     a retry; a terminal refusal renders as exactly the refusal. -->
					<tbody>
						<tr>
							<td colspan="7">
								<div class="empty" role="alert">
									<p class="empty__title">The candidates could not be loaded.</p>
									<p class="empty__hint">{loadFailure.message}</p>
									{#if loadFailure.retryable}
										<button
											type="button"
											class="ui-button ui-button--secondary ui-button--sm"
											onclick={() => void boot()}>Try again</button>
									{/if}
								</div>
							</td>
						</tr>
					</tbody>
				{:else}
				<tbody>
					{#each Array(8) as _, index (index)}
						<!-- Mirrors the resolved multiline row cell-for-cell, so the row
						     height is set by the same table metrics as real rows. -->
						<tr aria-hidden="true">
							<td class="col-check ui-pick-cell"></td>
							<td class="ui-cell--lead">
								<span class="ui-table__primary title-line"><span class="ui-skeleton skeleton-line" style="inline-size: 16rem"></span></span>
								<span class="ui-table__secondary"><span class="ui-skeleton skeleton-line" style="inline-size: 9rem"></span></span>
							</td>
							<td><span class="ui-skeleton skeleton-chip"></span></td>
							<td class="ui-table__number">
								<span class="avg">
									<span class="avg__mark avg__pending">
										<span class="ui-skeleton skeleton-line avg__num" style="inline-size: 1.75rem"></span>
									</span>
								</span>
							</td>
							<td class="ui-cell--state"><span class="ui-skeleton skeleton-chip"></span></td>
							<td><span class="ui-skeleton skeleton-action skeleton-action--rowacts"></span></td>
							<td class="col-expand ui-cell--trail"><span class="ui-skeleton skeleton-action skeleton-action--icon"></span></td>
						</tr>
					{/each}
				</tbody>
				{/if}
			{:else if visible.length === 0}
				<tbody>
					<tr>
						<td colspan="7">
							<div class="empty">
								{#if scoped}
									<p class="empty__title">Every speaker here has been notified.</p>
									<p class="empty__hint">
										No decided submission here still needs a notification. The full list of
										{plural(sorted.length, 'candidate')} is one press away.
									</p>
									<button type="button" class="ui-button ui-button--secondary ui-button--sm" onclick={clearScope}>
										Show all candidates
									</button>
								{:else if targetScope}
									<p class="empty__title">No proposals aim at this session.</p>
									<p class="empty__hint">
										Nothing in the candidate list targets it. The full list of
										{plural(sorted.length, 'candidate')} is one press away.
									</p>
									<button
										type="button"
										class="ui-button ui-button--secondary ui-button--sm"
										onclick={clearTargetScope}>
										Show all candidates
									</button>
								{:else}
									<p class="empty__title">No submissions need a decision.</p>
									<p class="empty__hint">
										Candidates appear here once submissions reach the inbox or late tray. Ask an agent to
										screen the incoming submissions, or open Submissions and work through them yourself.
									</p>
									<a class="ui-button ui-button--secondary ui-button--sm" href="/app/submissions">
										Open Submissions
									</a>
								{/if}
							</div>
						</td>
					</tr>
				</tbody>
				{:else}
					{#if finaleActive}
						<!-- The pass is finished, and the working set's empty slot becomes
						     the hand-off: what the decisions just created, each with its
						     door — never an automatic next act (23 §3). The un-notified
						     banner yields to this while it shows, so the send keeps one
						     door on the page. -->
						<tbody>
							<tr class="finale-row">
								<td colspan="7">
									<div class="finale">
										<p class="finale__title">Every candidate is decided.</p>
										<div class="finale__actions">
											{#if unnotified.length > 0}
												<button
													type="button"
													class="ui-button ui-button--primary ui-button--sm"
													onclick={openNotify}>
												Send their results
												</button>
											{/if}
											{#if (unplacedCount ?? 0) > 0}
												<a
													class="ui-button ui-button--secondary ui-button--sm"
													href="/app/schedule?tray=unplaced">
													Place {plural(unplacedCount ?? 0, 'session')}
												</a>
											{/if}
										</div>
										{#if waitlistedCount > 0}
											<p class="finale__note">
												{plural(waitlistedCount, 'waitlisted submission')}
												{waitlistedCount === 1
													? 'holds here until you promote or release it.'
													: 'hold here until you promote or release them.'}
											</p>
										{/if}
										{#if unnotified.length === 0 && unplacedCount === 0 && waitlistedCount === 0}
											<p class="finale__note">
												Notified and placed too — the remaining program work lives on the schedule.
											</p>
										{/if}
									</div>
								</td>
							</tr>
						</tbody>
					{/if}
					{#each display as item (item.id)}
					<tbody animate:flip={{ duration: motionMs('normal') }}>
					{#if item.kind === 'header'}
						<!-- The pass said in place: the working set above, what it has
						     produced below. A verdict carries its row from one group to
						     the other under the eye — the count pair is the pace. -->
						<tr class="station">
							<td colspan="7">
								<div class="station__line">
									<span class="station__label">{item.label}</span>
									<span class="station__count">{item.count}</span>
								</div>
							</td>
						</tr>
					{:else}
						{@const row = item.row}
						{@const status = decisionStatusFor(row)}
						{@const rowTrack = trackLabel(tracks, row.trackId)}
						{@const rowPending = pendingIds.includes(row.id)}
						{@const pinned = pinnedFor(row.id)}
						{@const standing = standings[row.id]}
						<!-- The pointer target is the row; the focusable trigger is the
						     chevron inside it, which is why no role or tabindex is added
						     here. The row is also the return anchor for the room: closing
						     it reveals this row, marked, where the person left off. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<tr
							class="row"
							data-submission={row.id}
							data-selected={selected.includes(row.id) ? 'true' : undefined}
							class:is-deciding={deciding.visible && dimmedIds.includes(row.id)}
							aria-busy={rowPending || undefined}
							onclick={(event) => onRowPress(event, row.id)}>
							<td class="col-check ui-pick-cell">
								<label class="ui-pick">
									<input
										type="checkbox"
										aria-label={`Select “${row.title}”`}
										checked={selected.includes(row.id)}
										disabled={rowPending}
										onchange={() => toggleSelected(row.id)} />
								</label>
							</td>
							<td class="ui-cell--lead">
								<span class="ui-table__primary title-line">
									<span class="title-line__text">{row.title}</span>
									{#if row.tray === 'late'}
										<!-- Candidates come from the inbox AND the late tray; on the
										     submissions page the tray tab says which, here the row
										     must say it itself. Provenance, not urgency: a quiet
										     neutral word, never an amber alarm. -->
										<Badge tone="neutral" value="Late" />
									{/if}
									{#if pinned.length > 0}
										<!-- One disclosure for the whole cluster: the marks are read as a
										     group, and naming each one is what the panel is for. -->
										<Popover
											label={`${pinned.map((def) => def.label).join(', ')} — accolades you pinned to “${row.title}”`}
											kind="figure">
											{#snippet trigger()}
												<span class="accolades">
													{#each pinned as def (def.key)}
														{@const Mark = accoladeIcon[def.key]}
														<Mark size={13} aria-hidden="true" />
													{/each}
												</span>
											{/snippet}
											{#snippet children()}
												{#each pinned as def (def.key)}
													<p class="accolade">{def.label} — pinned by you</p>
												{/each}
											{/snippet}
										</Popover>
									{/if}
								</span>
								<!-- The submitter is a scan key, and once a profile has landed for
								     that address it is also the way to read who they are without
								     leaving the table. A name with no profile behind it stays plain
								     text: a control that opens nothing is worse than a word that
								     never claimed to be one. -->
								<span class="ui-table__secondary scan"
									>{#each row.speakers as speaker, index (speaker.email)}{@const profile =
										profiles[speaker.email]}{#if index > 0}{', '}{/if}{#if profile}<ProfilePeek
											{profile} />{:else}{speaker.name}{/if}{/each}</span>
							</td>
							<!-- A category, not a state: a squared chip in its own hue, so an
							     amber track can never be read as an amber warning. A candidate
							     with no track draws nothing at all and says so in words — the
							     empty capsule this column used to hold nine of. Until the
							     vocabulary read lands the cell has nothing it can say, so it
							     withdraws from the record rather than labelling empty space. -->
							<td class:ui-cell--detail={rowTrack.kind === 'unresolved'}>
								{#if rowTrack.kind === 'named'}
									<TrackChip name={rowTrack.name} id={row.trackId} order={trackIds} />
								{:else if rowTrack.kind === 'none'}
									<span class="no-track">No track</span>
								{/if}
							</td>
							<!-- The mirrored column name would be the sort button's whole
							     accessible sentence, so the record line names itself. The average
							     is the comparison this surface exists for and keeps its line at
							     every width. -->
							<td class="ui-table__number" data-label="Review avg">
								{#if row.reviewCount > 0}
									<!-- The average alone. A bare “4.8 / 3” beside it reads as a score
									     out of three, which is the one thing it never means; the panel's
									     lead line says “4.8 average of 3 reviews” in words that cannot be
									     misread. -->
									<span class="avg">
										<span class="avg__mark">
											{#if standing}
												<!-- Wide enough for the pack, the strip carries the disclosure and
												     the figure stays the number to quote; narrow drops to the
												     figure, which then carries it. One press either way; every
												     sentence stays in the panel. -->
												<span class="avg__wide">
													<StandingMark {standing} form="both" quiet stripWidth="9rem" context={row.title} />
												</span>
												<span class="avg__narrow">
													<StandingMark {standing} form="figure" quiet context={row.title} />
												</span>
											{:else}
												<!-- Reviews are in but no average came back. Rare, and a dash
												     here would read as "not reviewed" — the one thing this row
												     is not. -->
												{#if row.reviewAverage === undefined}
													<span class="absent">No average yet</span>
												{:else}
													<span class="avg__num">{row.reviewAverage.toFixed(1)}</span>
												{/if}
											{/if}
										</span>
									</span>
								{:else}
									<!-- The row's own fact. Why there are no reviews *anywhere* is a
									     fact about the event, not about this submission, so it is
									     stated once above the table rather than repeated down every
									     row — nine identical cells are noise, not nine answers. -->
									<span class="absent">No reviews yet</span>
								{/if}
							</td>
							<!-- The one state on the record's primary line. Undecided is a
							     state, not an absence, so it wears the same badge shape as every
							     other: a dash left the reader to guess between "nobody has
							     decided", "still being reviewed", and "something is pending".
							     Tone and glyph come from the shared status vocabulary — the same
							     lookup the submissions queue reads, which is what stopped
							     "Un-notified" from being soft here and solid there. Emphasis is
							     spent on the region's one primary action, never on a column. -->
							<td class="ui-cell--state">
								<span class="decision">
									<Badge {...badgeFor(status.key)} value={status.label} />
									{#if awaitsNotice(row)}
										<Badge {...badgeFor(noticeStatus.key)} value={noticeStatus.label} />
									{/if}
								</span>
							</td>
							<td>
								<span class="rowacts" role="group" aria-label={`Set decision for “${row.title}”`}>
									{#each verdicts as verdict (verdict.value)}
										<button
											type="button"
											class="ui-button ui-button--sm rowacts__btn rowacts__btn--{verdict.value}"
											aria-pressed={row.decision === verdict.value}
											disabled={rowPending}
											onclick={() => decideRow(row, verdict.value)}>{verdict.label}</button>
									{/each}
								</span>
							</td>
							<td class="col-expand ui-cell--trail">
								<!-- The door to the room: a dialog trigger, not an expansion
								     switch, so it points inward rather than down. -->
								<button
									type="button"
									class="ui-button ui-button--ghost ui-button--icon ui-button--sm expand"
									aria-haspopup="dialog"
									aria-label={`Open “${row.title}” for deciding`}
									onclick={() => openRoom(row.id)}>
									<ChevronRight size={15} />
								</button>
							</td>
						</tr>
					{/if}
					</tbody>
					{/each}
				{/if}
		</table>
	</div>
</section>

<!-- The deciding room: one candidate over the pass, evidence beside verdict.
     An inspection surface is left the moment you are done looking, so it is
     dismissible; the verdict buttons inside are the same receipted forward
     moves the row offers, at the point where the reading happens. -->
<Modal bind:open={roomOpen} title={openRow?.title ?? 'Candidate'} size="lg" dismissible>
	{#if openRow}
		{@const roomTrack = trackLabel(tracks, openRow.trackId)}
		{@const roomPending = pendingIds.includes(openRow.id)}
		{#snippet roomActions()}
			{#if openRow}
				{#each verdicts as verdict (verdict.value)}
					<button
						type="button"
						class="ui-button ui-button--sm rowacts__btn rowacts__btn--{verdict.value}"
						aria-pressed={openRow.decision === verdict.value}
						disabled={roomPending}
						onclick={() => void decideFromRoom(openRow, verdict.value)}>{verdict.label}</button>
				{/each}
				{#if myCommitted.includes(openRow.id)}
					<button
						type="button"
						class="ui-button ui-button--secondary ui-button--sm room__lineup"
						onclick={() => openLineup(openRow.id)}>
						Line up with my other reviews
					</button>
				{/if}
			{/if}
		{/snippet}
		{#snippet roomFootnote()}
			{#if openRow && openRow.reviewCount > 0 && openRow.id in reviewRefusals}
				{reviewRefusals[openRow.id]}
			{:else}
				<!-- The banner's own sentence, repeated at the point of action — same
				     fact, same words, and no internal noun ("the table") a reader
				     has never been given. -->
				A verdict does not contact anyone. Review and send each result when you are ready.
			{/if}
		{/snippet}
		{#if decideNotice}
			{#key decideNotice}
				<Alert tone="danger" title={decideNotice.title} message={decideNotice.message} dismissible />
			{/key}
		{/if}
		<div class="room-detail">
			<SubmissionRecordDetail
				submission={openRow}
				track={roomTrack}
				trackOrder={trackIds}
				presentation="inline"
				reviews={openRow.reviewCount === 0 || openRow.id in reviewRefusals
					? undefined
					: (reviewsBy[openRow.id] ?? 'loading')}
				{scaleMax}
				actions={roomActions}
				footnote={roomFootnote} />
		</div>
		<CommitReceipt />
	{/if}
	{#snippet footer(_close)}
		<!-- The traversal bar: where the pass stands, and the way through it.
		     The keys are taught where they act; every one of them is also a
		     button, so the keyboard is a shortcut and never the only door. -->
		<p class="room__keys" aria-hidden="true">
			<kbd>a</kbd> accept · <kbd>w</kbd> waitlist · <kbd>d</kbd> decline
		</p>
		<p class="room__pace">
			{#if openIndex !== -1}
				Candidate {openIndex + 1} of {orderedRows.length} ·
			{/if}
			{stillToDecide.length} still to decide
		</p>
		<div class="room__step">
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				disabled={openIndex <= 0}
				onclick={() => step(-1)}>← Previous</button>
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				disabled={openIndex === -1 || openIndex >= orderedRows.length - 1}
				onclick={() => step(1)}>Next →</button>
		</div>
	{/snippet}
</Modal>

<Modal bind:open={lineupOpen} title={lineupTitle} size="lg" dismissible>
	{#if lineupId && resolvedLineupPort}
		<LineupPanel
			port={resolvedLineupPort}
			anchorId={lineupId}
			slice={lineupSlice}
			surface="modal"
			onSliceChange={switchLineupSlice} />
	{:else if lineupPortFailure}
		<Alert tone="danger" title="The line-up could not be loaded" message={lineupPortFailure} />
	{:else}
		<div class="lineup-resolving" role="status" aria-label="Loading line-up">
			<span class="ui-skeleton lineup-resolving__heading" aria-hidden="true"></span>
			<span class="ui-skeleton lineup-resolving__body" aria-hidden="true"></span>
			<span class="ui-sr-only">Loading line-up…</span>
		</div>
	{/if}
</Modal>

{#if selected.length > 0}
	<div class="bulkbar" role="toolbar" aria-label="Bulk decisions">
		<span class="bulkbar__count">{selected.length} selected</span>
		{#each verdicts as verdict (verdict.value)}
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				disabled={selected.some((id) => pendingIds.includes(id))}
				onclick={() => askBulk(verdict.value)}>{verdictCopy[verdict.value].verb}</button>
		{/each}
		<button type="button" class="ui-button ui-button--ghost ui-button--sm" onclick={() => (selected = [])}>
			Clear
		</button>
	</div>
{/if}

<Modal
	bind:open={confirmOpen}
	title={`${verdictCopy[pendingVerdict].verb} ${plural(pendingDecisionIds.length, 'submission')}?`}>
	<p class="modal__lead">
		Sets {plural(pendingDecisionIds.length, 'submission')} to {verdictCopy[pendingVerdict].past}. Nothing is
		emailed until you compose notifications.
	</p>
	<p class="modal__note">Any of them can be decided again before that send.</p>
	{#if pendingVerdict === 'accepted' && acceptanceRowsNeedingTrack.length > 0 && tracks.filter((track) => track.status === 'active').length > 1}
		<div class="modal__fields">
			<p class="modal__note">
				This event uses tracks. Classify each new program session before accepting it.
			</p>
			{#each acceptanceRowsNeedingTrack as row (row.id)}
				<Field id={`accept-track-${row.id}`} label={row.title}>
					{#snippet children({ id, describedBy })}
						<select
							class="ui-control"
							{id}
							aria-describedby={describedBy}
							bind:value={acceptanceTrackIds[row.id]}>
							<option value="" disabled>Choose a track</option>
							{#each tracks.filter((track) => track.status === 'active') as track (track.id)}
								<option value={track.id}>{track.name}</option>
							{/each}
						</select>
					{/snippet}
				</Field>
			{/each}
		</div>
	{/if}
	{#snippet footer(close)}
		<Button variant="secondary" size="sm" onclick={close}>Cancel</Button>
		<Button size="sm" disabled={!acceptanceTracksReady} onclick={confirmBulk}>
			{verdictCopy[pendingVerdict].verb} {pendingDecisionIds.length}
		</Button>
	{/snippet}
</Modal>

{#snippet subjectField()}
	<Field
		id="{uid}-subject"
		label="Subject"
		description="Each recipient receives their own decision in the body.">
		{#snippet children({ id, describedBy })}
			<input class="ui-control" type="text" {id} aria-describedby={describedBy} bind:value={subject} />
		{/snippet}
	</Field>
{/snippet}

<Modal bind:open={notifyOpen} title="Compose decision notifications">
	{#if dispatch === null}
		<p class="modal__lead notify__lead">
			{plural(recipientCount, 'speaker')} across {plural(unnotified.length, 'submission')}
			{recipientCount === 1 ? 'has' : 'have'} not been told the result. A verdict does not contact
			anyone; this send is the step that does.
		</p>
		{#if notifyRefusal}
			<!-- The projection or readiness read refused: the shell fills with the
			     port's own copy instead of holding loading skeletons for an answer
			     that is already refused. Send stays disabled — nothing is sent and
			     nothing pretends to be. -->
			<Alert tone="warning" title="Notifications are not available" message={notifyRefusal} />
		{:else}
			<ReviewSurface
				review={notifyReview}
				readiness={notifyReadiness}
				previewLabel="Their decision line"
				subject={subjectField}
				templateDoor={notifyDoor} />
		{/if}
	{:else}
		<!-- The committed send stated as the port recorded it: what a provider
		     accepted, what it did not, and why — the same truth the reloaded
		     page still shows on its un-notified rows. -->
		<Alert
			tone={dispatch.sent !== null && dispatch.sent === dispatch.committed ? 'success' : 'warning'}
			title={dispatchTitle(dispatch)}
			message={dispatch.note} />
	{/if}
	{#snippet footer(close)}
		{#if dispatch === null}
			<Button variant="secondary" size="sm" onclick={close}>Cancel</Button>
			<Button
				size="sm"
				loading={busy}
				disabled={!notifyReview || emailCount === 0}
				onclick={sendNotifications}>
				Send {plural(emailCount, 'email')}
			</Button>
		{:else}
			<Button variant="secondary" size="sm" onclick={close}>Done</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	/* Skeleton fills borrow their geometry from the composition they stand in
	   for: a text line is one line-box tall, a chip is badge-height, an action
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
		inline-size: 6rem;
	}

	.skeleton-action {
		display: inline-block;
		block-size: var(--je-control-height-sm);
		inline-size: 10.5rem;
		border-radius: var(--je-radius-control);
	}

	.skeleton-action--rowacts {
		inline-size: 11.5rem;
	}

	.skeleton-action--icon {
		inline-size: var(--je-control-height-sm);
	}

	/* The single attention surface on this page: tinted card plus a solid plate,
	   amber because the work is pending rather than broken. */
	.banner {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		align-items: center;
		gap: var(--je-space-3) var(--je-space-4);
		padding: var(--je-space-3) var(--je-space-4);
		border: 1px solid color-mix(in srgb, var(--je-color-warning-fill) 38%, transparent);
		border-radius: var(--je-radius-surface);
		background:
			linear-gradient(var(--je-color-warning-soft), var(--je-color-warning-soft)),
			var(--je-color-surface);
	}

	.banner__plate {
		display: grid;
		place-items: center;
		inline-size: 2rem;
		block-size: 2rem;
		border-radius: var(--je-radius-control);
		background: var(--je-color-warning-emphasis);
		color: var(--je-color-warning-emphasis-contrast);
	}

	.banner__copy {
		min-width: 0;
	}

	.banner__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.banner__detail {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-3);
		margin-block-end: var(--je-space-3);
	}

	.head__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.head__note {
		margin: 0;
		margin-inline-start: auto;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The ghost button's own padding is cancelled on the side the column is
	   aligned to, so its label sits on the same edge as the figures below it
	   rather than one control-padding short of it. */
	.sort {
		margin-inline-end: calc(var(--je-space-2) * -1);
		text-transform: inherit;
		letter-spacing: inherit;
	}

	/* A full reload (decision correction, notification send) re-reads everything; the rows dim
	   in place so nobody loses their spot to skeletons. */
	tbody {
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	.ui-table-wrap.is-refreshing tbody {
		opacity: 0.55;
		pointer-events: none;
	}

	/* A decision resolves on the rows it committed: they dim and go inert while
	   the quiet re-read lands, and every other row stays live. */
	tbody tr {
		transition: opacity var(--je-duration-fast) var(--je-ease);
	}

	tbody tr.is-deciding {
		opacity: 0.55;
		pointer-events: none;
	}

	.col-expand {
		inline-size: 2.5rem;
	}

	/* The whole row opens its detail, so the whole row says so. Only the data
	   rows: the detail, the empty state and the skeletons are not doors. The
	   hover tint the table already gives every row is the other half of the
	   affordance and is left alone. */
	tr.row {
		cursor: pointer;
	}

	.empty {
		display: grid;
		justify-items: center;
		gap: var(--je-space-3);
		padding: var(--je-space-8) var(--je-space-4);
		text-align: center;
	}

	.empty__title {
		margin: 0;
		font-weight: 600;
	}

	.empty__hint {
		margin: 0;
		max-inline-size: 52ch;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		white-space: normal;
	}

	.muted {
		color: var(--je-color-text-muted);
	}

	.no-plan {
		display: flex;
		align-items: flex-start;
		gap: var(--je-space-2);
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-warning);
	}

	.no-plan__mark {
		display: flex;
		/* Optically centred on the first line rather than the paragraph box, so
		   the glyph sits with the sentence when the copy wraps. */
		padding-block-start: 0.1em;
		flex-shrink: 0;
	}

	.no-plan a {
		color: inherit;
		font-weight: 650;
	}

	/* Station group headers: the pass and its output, named between the rows.
	   Caps like the other region titles, count in figures beside the label —
	   the pair that shrinks and grows as verdicts land. Same band recipe as
	   the submissions page: column-head fill, flush hairlines, no faked gap. */
	tr.station td {
		padding-block: var(--je-space-2);
		background: var(--je-color-page);
		border-block: 1px solid var(--je-color-border-strong);
	}

	.station__line {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
	}

	.station__label {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.station__count {
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text);
	}

	/* The finale holds the empty working set's slot: centered like an empty
	   state, because that is what it is — an empty queue whose next steps are
	   already known. Doors, never automation. */
	.finale {
		display: grid;
		justify-items: center;
		gap: var(--je-space-3);
		padding: var(--je-space-6) var(--je-space-4);
		text-align: center;
	}

	.finale__title {
		margin: 0;
		font-weight: 600;
	}

	.finale__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--je-space-2);
	}

	.finale__actions:empty {
		display: none;
	}

	.finale__note {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* An absence note, not a value: it sits in a number column, so it stays
	   small and quiet enough that the eye still reads the scored rows as the
	   column's content and skips these rather than trying to compare them. */
	.absent {
		font-size: var(--je-font-size-xs);
		font-weight: 400;
		font-variant-numeric: normal;
		color: var(--je-color-text-subtle);
		white-space: nowrap;
	}

	/* A setup gap is the organizer's to close, so it carries attention ink; a
	   row simply waiting on reviewers does not. */
	.absent--blocked {
		color: var(--je-color-warning);
	}

	/* Speaker identity is a scan key on this surface; it keeps full ink even on
	   the metadata line. */
	.scan {
		color: var(--je-color-text);
		font-weight: 500;
	}

	/* An unassigned category, said in words on the quietest rung. It takes no
	   chip: a chip asserts a category, and there is none to assert. The
	   submissions queue carries the matching filter scope. */
	.no-track {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-subtle);
	}

	.col-check {
		inline-size: 2rem;
	}

	/* The title owns the line and the pinned marks sit at its end, because they
	   are read as part of naming the submission. */
	/* The line reserves badge height whether or not this row carries one, so a
	   conditional chip (Late, accolades) never makes one row stand taller than
	   its neighbours — the same geometric stability the loading shells keep. */
	.title-line {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-width: 0;
		min-block-size: 1.375rem;
	}

	/* One line, like every `ui-table__primary strong` in the product: a dense
	   verdict pass is scanned, and a wrapping title both breaks the scan and
	   leaves the skeleton under-reserving the row it stands in for. The whole
	   name stays one press away in the expansion and in every aria-label. */
	.title-line__text {
		min-inline-size: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.accolades {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		color: var(--je-color-accent-lavender-strong);
	}

	.accolade {
		margin: 0;
	}

	/* The average cell reserves its resolved box from the first skeleton paint
	   onward, so the standing read lands as ink alone and the column never moves
	   under someone mid-scan. The reservation is one number, declared on the
	   wrapper so the header cell and the body cells cannot disagree; the strip's
	   width is added to it at the only widths that can pay for it. */
	.ui-table-wrap {
		/* Below the strip's breakpoint the mark is the quiet figure alone, so the
		   reservation covers the column's real widest content there: the sort
		   header and the “No reviews yet” absence note. Every sentence lives in
		   the panel. The strip's width joins at the only widths that can pay for
		   it, below. */
		--avg-w: 7rem;
	}

	/* Column width stated once, so auto layout keeps it across skeleton,
	   pending, and resolved rather than redistributing on every arrival. The
	   allowance beyond the reservation is the cell's own padding; the extra that
	   used to pay for a “/ N” suffix went with the suffix. */
	.col-avg {
		inline-size: calc(var(--avg-w) + 1.5rem);
	}

	/* One column, one edge. The sort header, the figures, the pending fills, and
	   the em dash standing for “not scored yet” all end where the column ends, so
	   a row with no average still reads as the same column as the rows above it. */
	.ui-table__number {
		text-align: end;
	}

	/* Both levels of the mark align to that edge too: the reserved box against
	   the cell, and the mark against the reserved box. The strip still precedes
	   the figure — the pair moves as one, so the number a person quotes lands on
	   the column's edge with its pack beside it. */
	.avg {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--je-space-2);
		min-block-size: 1.375rem;
	}

	/* Flex, not block: the mark is an inline-flex box, and a line box would add
	   a baseline strut under it and grow the row when the standing lands. */
	.avg__mark {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		inline-size: var(--avg-w);
		min-inline-size: 0;
	}

	.avg__pending {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		block-size: 1.375rem;
	}

	/* Mirrors the resolved figure's numeral exactly, so the average that is
	   already known is shown at the size it will keep. */
	.avg__num {
		flex: 0 0 auto;
		font-size: var(--je-font-size-base);
		font-weight: 700;
		line-height: 1.375rem;
	}


	.avg__narrow {
		display: flex;
		align-items: center;
		min-inline-size: 0;
	}

	/* Measured, not guessed: below this the strip's column squeezes titles into
	   a second line, so the strip starts where it costs the title nothing it
	   does not already pay today — re-measured after the details column joined
	   the row. */
	.avg__wide {
		display: none;
	}

	@media (min-width: 1536px) {
		.ui-table-wrap {
			/* Measured, not guessed: the quiet strip-and-figure pair renders at
			   ~11.2rem, so the reservation covers it with the cell's own slack
			   rather than holding a phrase the quiet form never draws. */
			--avg-w: 12rem;
		}

		.avg__wide {
			display: flex;
			align-items: center;
			min-inline-size: 0;
		}

		.avg__narrow {
			display: none;
		}
	}

	.decision {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1);
	}

	.rowacts {
		display: flex;
		gap: var(--je-space-1);
	}

	/* Full words with learned tints: the buttons are their own legend. */
	.rowacts__btn--accepted {
		background: var(--je-color-success-soft);
		color: var(--je-color-success);
	}

	.rowacts__btn--waitlisted {
		background: var(--je-color-accent-lavender-soft);
		color: var(--je-color-accent-lavender-strong);
	}

	.rowacts__btn--declined {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	/* The applied decision stays visible at the point of action, so re-clicking
	   it is never mistaken for a change. */
	.rowacts__btn[aria-pressed='true'] {
		box-shadow: inset 0 0 0 1.5px currentColor;
		font-weight: 700;
	}

	.bulkbar {
		position: sticky;
		inset-block-end: var(--je-space-4);
		align-self: center;
		max-inline-size: 100%;
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-2) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-round);
		box-shadow: var(--je-shadow-md);
	}

	/*
	 * The deciding room's own geometry. The record component brings its inline
	 * two-column layout (evidence + rail); the room only sizes the ground it
	 * stands on and re-stacks it where the dialog is the whole screen.
	 */
	.room-detail {
		padding-block: var(--je-space-2);
	}

	/* The rail's verdicts read exactly like the row's — same classes, same
	   tints — stretched to the rail's width so the pressed state is unmissable
	   beside the evidence it judges. */
	.room-detail :global(.rowacts__btn) {
		inline-size: 100%;
	}

	.room-detail :global(.room__lineup) {
		margin-block-start: var(--je-space-2);
	}

	@media (max-width: 47.99rem) {
		/* Full-screen dialog: no room for a rail beside the evidence, so the
		   record stacks — the same collapse the table's record width performs. */
		.room-detail :global(.ui-detail) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* The traversal bar: keys taught quietly at the left, the pace in the
	   middle, the way through at the right. The footer is the dialog's own
	   pinned strip, so the controls hold still while the evidence scrolls. */
	.room__keys {
		margin: 0;
		margin-inline-end: auto;
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-subtle);
	}

	.room__keys kbd {
		font-family: inherit;
		padding: 0 var(--je-space-1);
		border: 1px solid var(--je-color-border);
		border-radius: 4px;
		background: var(--je-color-surface);
	}

	.room__pace {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.room__step {
		display: flex;
		gap: var(--je-space-2);
	}

	@media (max-width: 47.99rem) {
		.room__keys {
			display: none;
		}
	}

	.lineup-resolving {
		display: grid;
		gap: var(--je-space-6);
	}

	.lineup-resolving__heading {
		inline-size: min(22rem, 70%);
		block-size: 1lh;
	}

	.lineup-resolving__body {
		inline-size: 100%;
		block-size: min(30rem, 55dvh);
		border-radius: var(--je-radius-md);
	}

	.bulkbar__count {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		margin-inline-end: var(--je-space-2);
		font-variant-numeric: tabular-nums;
	}

	.modal__lead {
		margin: 0;
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
	}

	.modal__note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.modal__fields {
		display: grid;
		gap: var(--je-space-3);
		margin-block-start: var(--je-space-3);
	}

	.notify__lead {
		margin-block-end: var(--je-space-5);
	}

	/*
	 * ══ The record ═══════════════════════════════════════════════════════════
	 *
	 * What this surface adds once the shared table has re-composed its rows.
	 * Last in the sheet on purpose: these are overrides of the column rules
	 * above, and a cascade order is easier to keep true than a specificity
	 * argument. The query asks the table wrapper, exactly as the primitive
	 * does, so the two can never disagree about when a row stops being a row.
	 */
	/*
	 * The compact columns (same recipe as the submissions queue, measured
	 * 2026-08-15): between the record threshold and full width the columns
	 * overflowed their wrapper by up to 168px — the lead cell's nowrap
	 * identity line set the floor. In this range the lead trades its intrinsic
	 * claim for the remaining width and the metadata sentence wraps exactly as
	 * the record presentation already allows. Nothing leaves the screen and
	 * the wrapper never scrolls sideways.
	 */
	@container je-table (min-width: 52rem) and (max-width: 74rem) {
		.ui-table :global(.ui-table__secondary) {
			overflow: visible;
			text-overflow: clip;
			white-space: normal;
		}

		td.ui-cell--lead {
			inline-size: 100%;
			max-inline-size: 0;
		}
	}

	@container je-table (max-width: 51.99rem) {
		/* A record grows downward, which is the one direction a phone has: the
		   candidate's name stops being an ellipsis the moment there is no column
		   to protect, and the Late mark and the accolades drop below the title
		   rather than squeezing the name they qualify. */
		.title-line {
			flex-wrap: wrap;
		}

		.title-line__text {
			overflow: visible;
			text-overflow: clip;
			white-space: normal;
			/* And it takes the whole line, so what qualifies it — the Late mark,
			   the accolade cluster — follows underneath with the record's full
			   width rather than competing with the name for a 153px column. */
			flex: 1 0 100%;
		}

		/* A category is a scan key, and at record width its chip has a labelled
		   line of its own — so it wraps rather than truncating. The full name
		   lives in `title`, which is a pointer affordance a touch reader never
		   receives, so a clipped chip on a phone is a name nobody can recover. */
		.ui-table :global(.ui-track__label) {
			overflow: visible;
			text-overflow: clip;
			white-space: normal;
		}

		/* A labelled line below the primary line has the whole record to use.
		   The primitive leaves it in the identity column, which the state and
		   the affordance have already narrowed — measured at 390px that left a
		   value 41px of room, truncated a track name to "Mo…", and stacked the
		   three verdicts into a column. */
		.ui-table.ui-table--multiline > tbody > tr > :global(td[data-label]) {
			grid-column: 2 / -1;
			/* A chip is a box drawn around a word; blockified into a grid cell it
			   would stretch to the column and read as a banner. */
			justify-items: start;
		}

		/* The average's reserved box exists so a column cannot reflow under a
		   reader mid-scan. A record has no column to protect, so the figure
		   sits with its own label instead of at a right edge that is gone. */
		.ui-table__number {
			text-align: start;
		}

		.avg {
			justify-content: flex-start;
		}

		.avg__mark {
			inline-size: auto;
		}

		/* Three full-word verdicts at touch height: the pass is what this
		   surface is for, so it keeps its controls on the record rather than
		   sending them behind a disclosure. */
		.rowacts {
			flex-wrap: wrap;
		}

		/* The header row keeps only its controls here — select-all and the sort
		   switch — so the strip is the band rather than one cell of it wearing
		   the column-head fill alone. The group still lays out as a table
		   header inside a block table, which shrink-wraps it to the width of
		   the controls it kept. */
		thead {
			display: block;
		}

		thead tr {
			background: var(--je-color-page);
		}

		thead th {
			background: none;
		}

		.station__line {
			flex-wrap: wrap;
		}

	}

	/*
	 * A phone, where the record has no width to spare. A decided candidate
	 * carries two states, and side by side they took 210px of a 334px record,
	 * leaving the candidate's name a 68px column. Capped, the second state
	 * stacks under the first and the identity keeps the room it needs.
	 */
	@container je-table (max-width: 30rem) {
		.ui-cell--state {
			max-inline-size: 7rem;
		}
	}

	/* Narrow widths restructure: the banner's action moves under its copy and the
	   dense table scrolls inside its own wrapper. */
	@media (max-width: 920px) {
		.banner {
			grid-template-columns: max-content minmax(0, 1fr);
			grid-template-areas:
				'plate copy'
				'. action';
		}

		.banner__plate {
			grid-area: plate;
		}

		.banner__copy {
			grid-area: copy;
		}

		.banner__action {
			grid-area: action;
			justify-self: start;
		}

		.head__note {
			margin-inline-start: 0;
		}

		.bulkbar {
			inset-block-end: var(--je-space-3);
			padding-inline: var(--je-space-3);
		}
	}
</style>
