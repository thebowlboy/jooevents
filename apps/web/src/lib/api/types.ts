/**
 * Data contracts for the workspace API. The current implementation serves these
 * from in-memory sample datasets; the shapes are the integration surface the
 * real transport will honor, so screens code against these types only.
 */

import type { ArrivalPulse } from '@jooevents/contracts';
import type { ThemeRecipe } from '../theme/theme-contract';

// ---------------------------------------------------------------------------
// Event and vocabulary

export interface EventInfo {
	id: string;
	name: string;
	dates: string;
	location: string;
	timezone: string;
	phase: string;
	today: string;
}

/** Counts retained by the resettable sample workflow projection. */
export interface WorkflowVocabUsage {
	/** Submissions carrying this track or format. */
	submissions: number;
	/** Sessions carrying this track or format. */
	sessions: number;
	/** Scheduled sessions sitting in this room. */
	placements: number;
}

/** Reference evidence returned by the canonical Program Vocabulary projection. */
export interface ReferenceVocabUsage {
	/** Mutable effective-state references which a reviewed merge may repoint. */
	currentReferences: number;
	/** Immutable published/versioned references which must remain resolvable. */
	historicalPins: number;
}

/**
 * Server-counted vocabulary usage. Sample and live sources retain their exact
 * factual units rather than translating one set of counts into the other.
 */
export type VocabUsage = WorkflowVocabUsage | ReferenceVocabUsage;

/**
 * A retired entry is no longer offered for new use; everything already
 * pointing at it keeps rendering, permanently.
 */
export type VocabStatus = 'active' | 'retired';

export interface Track {
	id: string;
	name: string;
	accent: 'lavender' | 'sea' | 'neutral';
	status: VocabStatus;
	usage: VocabUsage;
}

export interface Format {
	id: string;
	name: string;
	status: VocabStatus;
	usage: VocabUsage;
	/**
	 * The planned length a new session of this format starts from — a default
	 * the creation form fills in, never a constraint. Absent means the format
	 * carries no opinion and creation falls back to the grid's slot length.
	 */
	defaultDurationMin?: number;
}

export interface Room {
	id: string;
	name: string;
	/** Null means the organizer has not set a capacity; it never means zero. */
	capacity: number | null;
	status: VocabStatus;
	usage: VocabUsage;
}

/**
 * How the public roster groups the people on it — "Keynotes", "Workshop
 * leads", "Panel". Event vocabulary like tracks and formats, not a speaker
 * attribute invented per surface: one list names the groups, every public
 * presentation reads that list, and its order is the order they appear in.
 *
 * A category is a *presentation* grouping, deliberately separate from track
 * (which is what a session is about) and from engagement state (which is where
 * a person stands with the organizer). Those already exist and answer other
 * questions.
 */
export interface SpeakerCategory {
	id: string;
	name: string;
	accent: 'lavender' | 'sea' | 'neutral';
	status: VocabStatus;
	/**
	 * Roster entries filed under this group. A plain count rather than a
	 * {@link WorkflowVocabUsage}: that shape counts submissions, sessions, and
	 * placements, and a category is pointed at by none of the three.
	 */
	speakerCount: number;
}

// ---------------------------------------------------------------------------
// Workspace summary (shell + overview)

export type AttentionSeverity = 'now' | 'soon' | 'fyi';

export type AreaKey =
	| 'overview'
	| 'pulse'
	| 'submissions'
	| 'review'
	| 'decisions'
	| 'speakers'
	| 'reviewers'
	| 'tasks'
	| 'files'
	| 'schedule'
	| 'messages'
	| 'templates'
	| 'forms'
	| 'embeds'
	| 'approvals'
	| 'integrations'
	| 'settings';

export interface AttentionItem {
	id: string;
	severity: AttentionSeverity;
	area: AreaKey;
	title: string;
	detail: string;
	action: string;
	/**
	 * Where the action lands, carrying the scope named in the sentence — e.g.
	 * `/app/decisions?scope=unnotified` for "12 not yet notified". Absent when
	 * the area root already is the answer; the renderer falls back to it.
	 */
	href?: string;
}

export interface PipelineStage {
	key: 'collect' | 'triage' | 'review' | 'decide' | 'speakers' | 'schedule' | 'comms';
	label: string;
	headline: string;
	sub: string;
	state: 'ok' | 'attention' | 'blocked';
	/**
	 * Scenario totals for the stage's own unit of work — never a row-window
	 * count. A stage without progress has no honest denominator, and the UI
	 * must not render a meter for it.
	 */
	progress?: { done: number; required: number };
	/**
	 * How progress stands against the stage's governing deadline, not against
	 * 100%: a high fraction close to its deadline is still 'behind' — that
	 * asymmetry is the point. Authored per scenario in sample data until the
	 * real computation lands.
	 */
	paceTone?: 'ahead' | 'on' | 'behind' | 'overdue';
	/**
	 * The deadline this lane answers to. `qualifier` is the verb the date takes
	 * on this stage — "due", "notify by", "publish target" — and the date itself
	 * is stored, never rendered: the lane's countdown is spelled at read time so
	 * it cannot age into a lie between one visit and the next.
	 */
	deadline?: {
		qualifier: string;
		displayDate: string;
		effectiveAt: string;
		/** The thing it gated is closed, so it reads `Passed`, not `Overdue`. */
		settled?: boolean;
	};
}

/**
 * A deadline as the catalog stores one: the event-local calendar date the
 * organizer set, plus the end-exclusive boundary instant that decides its
 * state. Never a rendered string — the state, the countdown, and the absolute
 * are all spelled by the one date vocabulary at read time, so a scenario
 * cannot narrate "in 3 days" beside a date that says otherwise.
 */
export interface DeadlineItem {
	label: string;
	/** `2026-08-22` — what the organizer typed, in the event's zone. */
	displayDate: string;
	/** The first instant of the following event-local day. */
	effectiveAt: string;
	/** The obligation is discharged: reads `Passed`, not `Overdue`. */
	settled?: boolean;
	/** A qualifier a countdown cannot carry — "blocked by 5 conflicts". */
	note?: string;
}

export interface ActivityItem {
	id: string;
	actor: 'agent' | 'person' | 'you';
	name: string;
	text: string;
	/** When it happened, as an instant. The words are the vocabulary's job. */
	at: string;
}

export type TrayKind =
	| 'late'
	| 'spam'
	| 'unresolved-import'
	| 'stranded-drafts'
	| 'inbound-mail'
	| 'bounced'
	| 'appeals';

export interface TrayCount {
	/* The glyph is chosen from this, never by matching the label text. */
	kind: TrayKind;
	label: string;
	count: number;
	/**
	 * The screen these rows live on. Absent while a tray has no surface yet, and
	 * the pill then renders as text: a control that looks pressable and does
	 * nothing is worse than a number that never claimed to be one.
	 */
	href?: string;
}

export interface StatItem {
	label: string;
	value: string;
	sub: string;
	/**
	 * The figure's state in the learned mapping — green healthy, amber needs
	 * attention soon, red blocked. Absent where the figure is inventory rather
	 * than a state, because a count of things is not good or bad by itself.
	 *
	 * One field rather than two: the sub-line's ink and the meter's fill are two
	 * channels for the same fact, and giving them separate inputs is how a tile
	 * ends up amber above a green bar.
	 */
	health?: 'ok' | 'attention' | 'blocked';
	/**
	 * Draws a meter under the value. Only where a real denominator exists — a
	 * ratio invented to fill the bar is worse than no bar, and `sub` keeps the
	 * absolute digits either way.
	 */
	progress?: { done: number; required: number };
}

/**
 * What has arrived, and over which window — the Overview's answer to *what
 * changed since I last had this in my head*.
 *
 * Computed from the submissions themselves at read time, never authored: a
 * scenario cannot narrate "+2 this week" that its own rows do not back, and an
 * authored delta ages into a falsehood the day after it is written. The window
 * choice, the buckets, and the words all come from the shared engine in
 * `@jooevents/contracts`.
 */
export interface SubmissionArrivals {
	/** The pulse over the held population; spam rows are not in it. */
	pulse: ArrivalPulse;
	/** How the held total is composed, by the tray each row sits in. */
	held: { inbox: number; setAside: number; late: number };
	/**
	 * Kept and recoverable, and deliberately outside every figure above. A
	 * spam proposal is not part of what the event has to work through, so
	 * counting it in the total would overstate the load — but it is not gone
	 * either, so the breakdown still says how many and where they are.
	 */
	spam: number;
}

export interface NavCounts {
	submissions?: string;
	review?: string;
	decisions?: { value: string; tone: 'warning' | 'danger' };
	speakers?: string;
	reviewers?: string;
	tasks?: { value: string; tone: 'warning' | 'danger' };
	schedule?: { value: string; tone: 'warning' | 'danger' };
	messages?: string;
	templates?: string;
}

export interface WorkspaceSummary {
	event: EventInfo | null;
	/** Areas not yet unlocked (no event yet, or prerequisites missing). */
	lockedAreas: AreaKey[];
	navCounts: NavCounts;
	/**
	 * The computed arrival tile. Null where nothing has been collected yet —
	 * a workspace with no event has no population to measure a diff against,
	 * and zero-over-nothing is a claim rather than a measurement.
	 */
	arrivals: SubmissionArrivals | null;
	stats: StatItem[];
	attention: AttentionItem[];
	pipeline: PipelineStage[];
	deadlines: DeadlineItem[];
	activity: ActivityItem[];
	trays: TrayCount[];
}

// ---------------------------------------------------------------------------
// Submissions and triage

export type TrayKey = 'inbox' | 'set-aside' | 'late' | 'spam';

export type DecisionState = 'undecided' | 'accepted' | 'waitlisted' | 'declined' | 'withdrawn';

export interface SignalChip {
	key: string;
	label: string;
	family: 'quality' | 'draw' | 'integrity';
	score?: number;
	rationale: string;
	source: string;
}

export interface SubmissionSpeaker {
	name: string;
	email: string;
}

export interface SubmissionResource {
	name: string;
	kind: 'slides' | 'video' | 'document' | 'link';
	/** Human-readable qualifier: file type and size, or the link's domain. */
	detail: string;
}

/**
 * The least-disclosure submission evidence served to an assigned reviewer.
 *
 * This is deliberately narrower than the organizer's Intake submission: a
 * Review queue needs candidate content, not tray/decision state or contact
 * authority. `speakers` is empty when the round withholds participant identity;
 * a sample source may additionally carry an email so its profile treatment can
 * remain demonstrable, but the retained live projection does not disclose one.
 */
export interface ReviewSubmissionDisplay {
	id: string;
	title: string;
	abstract: string;
	speakers: {
		id?: string;
		name: string;
		email?: string;
	}[];
	trackId?: string;
	formatId?: string;
	targetSessionId?: string;
	submittedAt: string;
	resources?: SubmissionResource[];
}

export interface Submission {
	id: string;
	title: string;
	abstract: string;
	speakers: SubmissionSpeaker[];
	trackId: string;
	formatId: string;
	/**
	 * When this record arrived — an ISO instant, stamped by the server clock at
	 * commit. Surfaces derive their own words from it (“2 h ago”, “Jul 2”); the
	 * instant is also what the New mark and the oldest-waiting fact compute
	 * from, so a pre-formatted label here would make both dishonest.
	 */
	submittedAt: string;
	source: 'cfp' | 'direct_entry' | 'import';
	/**
	 * Who keyed this record in, for rows that did not arrive through the public
	 * form — the "direct entry by whom" provenance grammar. A display name
	 * projected from the creating commit's attribution, never client-declared;
	 * absent on `cfp` rows, whose provenance is the submitter themselves.
	 */
	enteredBy?: string;
	/**
	 * The collecting session this proposal asks to join, when the submitter
	 * (or the form's fixed target) named one. Routing state, not membership:
	 * the proposer reaches the session's roster only if this submission is
	 * accepted, and acceptance into a target that has since closed re-offers
	 * spawn/re-target instead of failing silently.
	 */
	targetSessionId?: string;
	tray: TrayKey;
	setAsideBy?: string;
	decision: DecisionState;
	/**
	 * When the current decision landed — ISO instant, absent while undecided.
	 * Orders the decided groups and lets un-notified copy state its age; the
	 * moment itself already exists in the decision history, this only asks the
	 * projection to carry it.
	 */
	decidedAt?: string;
	/** True when the current decision has been communicated to the submitter. */
	notified: boolean;
	signals: SignalChip[];
	/** Attached materials (slides, recordings, supporting links). */
	resources?: SubmissionResource[];
	reviewAverage?: number;
	reviewCount: number;
	appealCount?: number;
}

/**
 * What the organizer supplies when keying a submission in by hand. Everything
 * else the row carries — source, attribution, arrival date, tray — is the
 * server's to state, so it is absent here by construction.
 */
export interface DirectEntryInput {
	title: string;
	/** Optional on purpose: the organizer often knows the talk before the paragraph exists. */
	abstract?: string;
	speakers: SubmissionSpeaker[];
	trackId: string;
	formatId: string;
	/**
	 * Where the entry lands: the review inbox as an undecided candidate that
	 * competes like any other arrival, or accepted at creation — the invited
	 * path, which graduates into the program immediately.
	 */
	disposition: 'inbox' | 'accepted';
	/** A still-collecting session this entry proposes to join. */
	targetSessionId?: string;
}

export interface SubmissionQuery {
	tray?: TrayKey;
	trackId?: string;
	formatId?: string;
	search?: string;
}

/**
 * What a search actually did, so the surface can say it.
 *
 * `matched` and `scanned` are both required because a list can be short for two
 * different reasons, and a reader cannot tell them apart from the rows alone:
 * few records matched, or few records were looked at. An empty result that
 * claims absence over a population it never examined is the more expensive of
 * the two mistakes.
 */
export interface SearchOutcome {
	/** The query these numbers describe, for echoing back verbatim. */
	query: string;
	/** Records that matched. */
	matched: number;
	/** Records the search examined. */
	scanned: number;
}

export interface SubmissionPage {
	rows: Submission[];
	/** Full population per tray (rows are a representative window). */
	trayTotals: Record<TrayKey, number>;
	/** Present only when the query carried a search. */
	search?: SearchOutcome;
}

// ---------------------------------------------------------------------------
// Review

/**
 * One review left without a reviewer, named rather than counted. The count
 * alone says work came free; this says which submission it was and what the
 * vacancy costs that submission.
 *
 * `remainingReviewers` is that cost: how many other reviewers still hold this
 * submission. 0 is the sharp one — nobody is reviewing it at all, so review of
 * it has stopped, which outranks a submission that is merely short a slot.
 * Absent means the composition could not count remaining coverage and states
 * none; a missing count is not a zero, and a consumer renders no consequence
 * rather than inventing one. Authored per scenario in sample data until the
 * real computation lands.
 */
export interface UncoveredReview {
	assignmentId?: string;
	assignmentVersion?: number;
	roundId?: string;
	submissionId: string;
	title: string;
	remainingReviewers?: number;
	replacementCandidates?: readonly ReviewReplacementCandidate[];
	/**
	 * How much reviewing the submission has actually banked: `committed` reviews
	 * in, out of the `planned` reviewers it was handed to, the vacated slot
	 * included. It grades the vacancy that `remainingReviewers` alone overstates
	 * — when every other assigned review is already committed, the submission is
	 * effectively read and the open slot is information rather than attention.
	 *
	 * Absent means the composition did not count committed reviews and states
	 * none; a missing count is not a zero, and a consumer renders no "N of M"
	 * claim rather than implying the submission has nothing in.
	 */
	reviewsIn?: { committed: number; planned: number };
}

export interface ReviewReplacementCandidate {
	reviewerId: string;
	displayName?: string;
	assigned: number;
	scopeMatch: boolean;
	conflict?: string;
}

export interface ReviewerProgress {
	id: string;
	name: string;
	assigned: number;
	done: number;
	/**
	 * Reviews this person stepped back from because they know or work with the
	 * submitter. History: it says why their count is short, not that anything is
	 * wrong.
	 */
	steppedBack: number;
	/**
	 * The subset of `steppedBack` that no other reviewer has picked up, so the
	 * submission is currently short a review. This is the only part a chair can
	 * act on, and the only part the roster raises.
	 *
	 * An uncovered review stays in the original reviewer's `assigned`, so the
	 * plan's denominator does not move when someone steps back — the work still
	 * exists, it is simply nobody's yet.
	 */
	awaitingReassignment: number;
	/**
	 * Which reviews those are, when the composition can name them: one entry per
	 * uncovered review, so `uncovered.length` equals `awaitingReassignment`.
	 * Absent leaves the count as the only claim.
	 */
	uncovered?: UncoveredReview[];
}

export interface ReviewPlan {
	id: string;
	name: string;
	scaleMax: number;
	deadlineRelative: string;
	anonymized: boolean;
	done: number;
	total: number;
	reviewers: ReviewerProgress[];
	/** Peer content unlocks only after own review is committed (default on). */
	antiAnchoring: boolean;
	/**
	 * How many committed reviews the plan wants per submission. What separates
	 * “in review” from “waiting on a decision” for an undecided row while the
	 * round is open; absent means the round never states a per-item target and
	 * every covered row stays in review until the round closes.
	 */
	reviewsPerSubmission?: number;
}

/**
 * The one review-round fact the submissions inbox needs: is a round open over
 * the candidates, and how far along is it. A station projection input, not a
 * plan editor — the full plan stays on the Review surface.
 */
export interface ReviewRoundStatus {
	open: boolean;
	name: string;
	/** Whole-round completion, 0–100, from the plan's own done/total. */
	percentDone: number;
	/** The plan's own deadline words (“due tomorrow”), stated not derived. */
	dueLabel: string;
	/**
	 * How urgently the deadline should ink: calm until it closes in, warning
	 * inside the last two days, danger once passed. The live projection
	 * computes this from the real instant; a consumer never parses the words.
	 */
	deadlineTone: 'calm' | 'warning' | 'danger';
	reviewsPerSubmission?: number;
}

/**
 * Where an accepted submission went — the spawn/attach provenance read back
 * from the program, so the row that graduated can carry a door to the session
 * it became or joined.
 */
export interface SubmissionOrigin {
	sessionId: string;
	title: string;
	kind: 'spawn' | 'attach';
}

/**
 * One amendment of an already-committed review. The prior score and comment are
 * kept rather than overwritten: after peer content unlocks, changing your mind
 * is legitimate, but silently rewriting what you committed before you saw the
 * peers would erase the only evidence that the change was post-unlock.
 */
/**
 * What opening the review round will do, counted from current records by the
 * API: the active reviewer pool, the submissions in play, and the reviews the
 * scope-match hand-out produces. The dialog renders these numbers; it never
 * derives them.
 */
export interface ReviewRoundSetup {
	/** Reviewers who accepted and will receive a queue the moment the round opens. */
	activeReviewers: number;
	/** Invited but not yet accepted — named so the hand-out states who is not in it. */
	invitedReviewers: number;
	/** Submissions in the inbox right now. */
	submissions: number;
	/** Total reviews the hand-out produces (sum of per-reviewer loads). */
	expectedReviews: number;
	/** Who gets how many, by scope match; generalists carry everything. */
	perReviewer: { id: string; name: string; assigned: number }[];
}

export interface ReviewRevision {
	score: number;
	comment: string;
	at: string;
	/** True when the amendment happened after peer scores were revealed. */
	postUnlock: boolean;
}

/** A reviewer's own mark on a submission, carried as an explicit key. */
export type AccoladeKey = 'top_pick' | 'hidden_gem' | 'crowd_draw' | 'bold_bet';

/**
 * An accolade a reviewer may pin. A cap makes the mark mean something: three
 * top picks is a ranking, thirty is a shrug.
 */
export interface AccoladeDef {
	key: AccoladeKey;
	label: string;
	/** Maximum submissions this reviewer may hold the key on. Absent = uncapped. */
	cap?: number;
}

export interface MyReviewItem {
	submissionId: string;
	myScore?: number;
	myComment?: string;
	committed: boolean;
	peerScores?: number[];
	/** Oldest first; the last entry is what a revert puts back. */
	revisions?: ReviewRevision[];
	accolades?: AccoladeKey[];
}

/** Where a score sits inside its comparison slice. */
export type StandingBand = 'top' | 'upper' | 'mid' | 'lower' | 'bottom' | 'few';

/**
 * One submission's score against the slice it is compared against, computed by
 * the server so every surface renders the same claim. `points` and `bins` are
 * alternatives, not both: a countable slice ships its actual values, a large
 * one ships binned mass.
 */
export interface ScoreStanding {
	/** This submission's review average. */
	value: number;
	scaleMax: number;
	/** Committed reviews on this submission. */
	reviews: number;
	/** Scored submissions in the slice, including this one. */
	n: number;
	/** Median of the whole slice, one decimal. */
	median: number;
	band: StandingBand;
	/** Standardized standing sentence; never a claim the slice cannot support. */
	phrase: string;
	slice: { label: string; trackId?: string };
	/** The OTHER submissions' averages, present when n <= 120. */
	points?: number[];
	/** 24 bin counts over [1, scaleMax], present when n > 120. */
	bins?: number[];
	/** Greater than 1 when one plotted dot stands for several submissions. */
	dotK?: number;
}

/** A reviewer's own committed review beside the submission it belongs to. */
export interface ComparableCard {
	item: MyReviewItem;
	submission: ReviewSubmissionDisplay;
	standing: ScoreStanding | null;
}

/**
 * One committed review on a submission, as a review-read surface (the decision
 * table's expansion, a submission detail) shows it. Reviewer identity is the
 * plan-local label, never a name; the caller's own committed review is the one
 * exception, marked `mine` and labeled accordingly.
 */
export interface SubmissionReview {
	/** Plan-local reviewer label ("Reviewer B"), or "You" when `mine`. */
	reviewer: string;
	/** True when this is the caller's own committed review. */
	mine?: boolean;
	score: number;
	comment?: string;
	committedAt: string;
	/**
	 * The score this one replaced, present only when the change happened after
	 * peer content unlocked — the delta a chair reads as calibration evidence.
	 */
	amendedFrom?: number;
}

// ---------------------------------------------------------------------------
// Reviewer roster and scope

/** The kinds of governed records a reviewer scope may reference. */
export type ScopeRefKind = 'track' | 'format' | 'session';

/**
 * One entry in a reviewer's scope: a typed reference to a record that exists —
 * a track, a format, or a session — never a free-floating tag. The referenced
 * entry's own lifecycle applies: a retired track keeps rendering inside an
 * existing scope, it is just not offered for new scoping.
 */
export interface ScopeRef {
	kind: ScopeRefKind;
	id: string;
}

/**
 * A reviewer's lifecycle, deliberately thin: invited (access reservation
 * recorded, not yet arrived) → active. Removal takes the record off the
 * roster rather than adding a third state.
 */
export type ReviewerStatus = 'invited' | 'active';

/**
 * One person on the reviewer roster. A reviewer is a workspace member (the
 * Speaker Reviewer preset, or another role that includes review), so `id` is
 * that member's id — one identity across the roster, the review plans, and
 * Settings.
 *
 * `scope` is a union: a submission is in scope when it matches *any* ref. An
 * empty scope is the generalist default — this reviewer reviews everything.
 * Scope narrows workload only; it never adjusts visibility policy or a plan's
 * blind/peer gates.
 *
 * The load numbers are server-counted sums across every review plan; a client
 * renders them, never derives them. Invariants: `awaitingReassignment <=
 * steppedBack`, and an uncovered review stays inside the original reviewer's
 * `assigned`, so a plan's denominator never moves when someone steps back
 * over a conflict of interest.
 */
export interface Reviewer {
	id: string;
	name: string;
	/** Organizer-authorized contact address; absent when the projection does not disclose one. */
	email?: string;
	status: ReviewerStatus;
	scope: ScopeRef[];
	assigned: number;
	done: number;
	steppedBack: number;
	awaitingReassignment: number;
	/**
	 * The uncovered reviews behind `awaitingReassignment`, concatenated across
	 * every plan that names them. Absent when no plan named them, which is why
	 * a consumer falls back to the count rather than reading an empty list as
	 * "none".
	 */
	uncovered?: UncoveredReview[];
}

/**
 * Coverage for one scope target, server-counted. `reviewers` counts active
 * reviewers holding the ref in scope — generalists are deliberately not
 * folded in, so a zero here is answered by the roster's generalist count
 * rather than hidden by it. `submissions` counts what falls inside the ref
 * today.
 */
export interface CoverageRow {
	ref: ScopeRef;
	/** The referenced entity's own name: track/format name, session title. */
	label: string;
	/** Present when the ref points at a retired entry — it keeps rendering and keeps filtering; the flag suggests re-scoping. */
	retired?: boolean;
	reviewers: number;
	submissions: number;
}

/**
 * The coverage projection, or the stated reason a composition cannot count it.
 *
 * Coverage is a panel beside the roster, not the roster's spine. A composition
 * that cannot count it truthfully says so here and still serves the roster;
 * modelling the absence as a value is what keeps a missing coverage owner from
 * failing the whole read and leaving the surface waiting on an answer that was
 * never coming.
 */
export type ReviewerCoverage =
	| { readonly kind: 'served'; readonly rows: CoverageRow[] }
	| { readonly kind: 'unavailable'; readonly reason: string };

/**
 * The reviewers surface's one read: the roster, the generalist count, and the
 * coverage projection. `generalists` counts active reviewers with no scope,
 * kept beside the coverage rows so "zero scoped reviewers" and "uncovered"
 * stay distinct claims.
 */
export interface ReviewerRoster {
	reviewers: Reviewer[];
	generalists: number;
	coverage: ReviewerCoverage;
}

/**
 * One address's outcome from a reviewer invite. A multi-address invite
 * reports per line, so one bad address never hides what happened to the rest.
 */
export type ReviewerInviteLine =
	| { email: string; ok: true; reviewer: Reviewer }
	| { email: string; ok: false; reason: string };

// ---------------------------------------------------------------------------
// Speakers and tasks

export type EngagementState =
	| 'invited'
	| 'confirmed'
	| 'declined'
	| 'cancel_requested'
	| 'cancelled';

/**
 * A session this engagement is attached to. The id is carried alongside the
 * title because a speaker's session is a place on the schedule, not a string:
 * without it the roster can name a session it cannot take anyone to.
 */
/**
 * Where and when a session actually sits on the grid, in the words a reader
 * sees. Display-ready on purpose: `day` and `room` are the schedule's own
 * `ScheduleDayInfo.label` and `Room.name`, and `time` is the placement's clock
 * range on the event's day-start offset — so a consumer never re-derives a
 * second time format from `startMin`.
 *
 * Absent means not placed, or not counted at this seam: a session with no
 * placement row, a composition that cannot see the schedule, or a placement
 * whose day or room no longer resolves to a real one. A consumer renders
 * nothing rather than guessing, and never prints a raw key — a machine date
 * wearing a label's clothes is worse than silence.
 */
export interface SessionPlacementDisplay {
	day: string;
	/** Clock range on the event's own day start, e.g. `09:00–09:30`. */
	time: string;
	room: string;
}

export interface SpeakerSession {
	id: string;
	title: string;
	/** Where this session is placed, when the composition counted it. */
	placement?: SessionPlacementDisplay;
}

export interface SpeakerRow {
	id: string;
	/**
	 * Canonical Person identity when the row comes from a retained live
	 * projection. `id` remains the engagement/roster-row address used by the
	 * Speakers surface; consumers joining Session roster refs must use this
	 * person key and must not infer identity from an email address.
	 */
	personId?: string;
	name: string;
	email: string;
	state: EngagementState;
	sessions: SpeakerSession[];
	tasksDone: number;
	tasksTotal: number;
	overdueTasks: number;
	publiclyVisible: boolean;
	contentApproved: boolean;
	note?: string;
	/**
	 * Where this person sits in the public lineup, ascending. Roster state, not
	 * surface state: one order serves the standalone page, every embed of it,
	 * and anything else that lists speakers, so a reorder is never re-done per
	 * surface. Dense and unique within the roster; the API owns renumbering.
	 */
	position: number;
	/** The public grouping this person appears under; absent means ungrouped. */
	categoryId?: string;
}

/** One event/person record in the organizer-owned public lineup editor. */
export interface SpeakerLineupRow {
	/** Canonical person identity inside the organizer surface. */
	id: string;
	/** One engagement row the roster view can open for this person. */
	rosterId: string;
	name: string;
	state: EngagementState;
	sessions: SpeakerSession[];
	publiclyVisible: boolean;
	contentApproved: boolean;
	position: number;
	categoryId?: string;
}

/**
 * One person as the public roster shows them: what they said about themselves
 * joined to what they are in this event, already ordered and already filtered
 * to who may be shown.
 *
 * A named public projection rather than a filtered `SpeakerRow`: the roster row
 * carries organizer-only facts (address, task counts, cancellation notes) that
 * must not travel to a surface at all, and a surface that received the whole row
 * could render them by accident. Everything here is publishable by construction.
 */
export interface PublicSpeakerCard {
	id: string;
	name: string;
	/** Their own one-line description. Absent while nothing is approved to show. */
	headline?: string;
	/** Their approved longer introduction, shown by the single-person profile layout. */
	biography?: string;
	location?: string;
	links: SpeakerLink[];
	sessions: SpeakerSession[];
	categoryId?: string;
	/**
	 * True when this person is published but their content is not approved yet —
	 * the roster's existing "shows as TBA" state, carried so the surface can say
	 * so rather than inventing a biography.
	 */
	provisional: boolean;
}

/**
 * Where a link points as a *kind of place*, not as a string to be sniffed.
 *
 * An organizer reading a profile is asking "who is this person, and can I put
 * them on a stage" — and the answer is carried by which networks they are on
 * before it is carried by any particular URL. Stating the kind in data means the
 * surface can mark and order the row without parsing hosts, and a profile that
 * comes from somewhere other than a seed later cannot smuggle in a mark the
 * product never chose.
 */
export type SpeakerLinkKind = 'x' | 'linkedin' | 'github' | 'website' | 'other';

/** An address a speaker offers about themselves, off this product. */
export interface SpeakerLink {
	kind: SpeakerLinkKind;
	/** What the chip says: a handle, a domain — short enough to sit in a row. */
	label: string;
	href: string;
}

/**
 * Who a submitter is, in their own words, beside what they are to *this* event.
 *
 * Identity travels by email because that is what a submission carries: a person
 * who has written to the CFP has a profile whether or not they were ever
 * admitted to the roster. `speakerId` and `sessions` are therefore present only
 * when a roster entry shares the address, and `submissionCount` is counted in
 * this event, never claimed by the profile's author.
 */
export interface SpeakerProfile {
	name: string;
	email: string;
	headline: string;
	location?: string;
	links?: SpeakerLink[];
	/** Submissions in this event carrying this address. */
	submissionCount: number;
	/** Present with a roster entry that has engagements. */
	sessions?: SpeakerSession[];
	/** Present when this person is on the speaker roster. */
	speakerId?: string;
}

export interface TaskDef {
	id: string;
	name: string;
	kind: 'upload' | 'confirm' | 'form' | 'link';
	required: boolean;
	dueAbsolute: string;
	dueRelative: string;
}

export type AssignmentState = 'todo' | 'received' | 'complete' | 'late-complete' | 'waived';

export interface TaskAssignment {
	taskId: string;
	speakerId: string;
	state: AssignmentState;
	overdue: boolean;
}

// ---------------------------------------------------------------------------
// Schedule

export interface ScheduleDayInfo {
	key: string;
	label: string;
}

/**
 * Where a session stands in its lifecycle. A `draft` is a private editorial
 * sketch, visible to organizers only. A `collecting` session is a slot still
 * gathering applicants — a legitimate reviewer-scope target, since the
 * reviewers scoped to it see everyone who applied — while a `programmed`
 * session has its content settled. Placement is orthogonal to state: a
 * collecting session may hold a planned slot on the grid, and only program
 * releases make anything public.
 */
export type SessionState = 'draft' | 'collecting' | 'programmed';

/** One person on a session roster; retained live rows carry canonical Person identity. */
export interface SessionSpeaker {
	/** Optional only for sample/legacy page data; live Session projections always set it. */
	personId?: string;
	name: string;
	email: string;
	role?: 'speaker' | 'moderator' | 'host' | 'panelist';
	position?: number;
}

export interface SessionItem {
	id: string;
	title: string;
	speakers: SessionSpeaker[];
	trackId: string;
	formatId: string;
	durationMin: number;
	state: SessionState;
	/**
	 * The accepted submissions this session grew from — the spawn or attach
	 * provenance the speakers panel narrates. Absent on purely editorial
	 * sessions; never a membership list (the roster is `speakers`).
	 */
	originSubmissionIds?: string[];
}

export interface PlacementConflict {
	severity: 'block' | 'warn';
	reason: string;
}

/**
 * A typed time reservation on the grid — lunch, a transition buffer, a five-
 * minute gap placed for precision. Per-room by design: "every room" convenience
 * mints one break per room so each column's physics stays self-contained.
 */
export interface BreakBlock {
	id: string;
	label: string;
	dayKey: string;
	roomId: string;
	/** Minutes from day start. */
	startMin: number;
	durationMin: number;
}

export interface Placement {
	sessionId: string;
	dayKey: string;
	roomId: string;
	/** Minutes from day start. */
	startMin: number;
	conflicts: PlacementConflict[];
}

export interface ScheduleState {
	days: ScheduleDayInfo[];
	rooms: Room[];
	dayStart: string;
	slotMinutes: number;
	slotsPerDay: number;
	sessions: SessionItem[];
	placements: Placement[];
	breaks: BreakBlock[];
	published: boolean;
}

export interface SlotSuggestion {
	dayKey: string;
	roomId: string;
	startMin: number;
	note: string;
	conflict?: PlacementConflict;
}

// ---------------------------------------------------------------------------
// Communications

export type CommunicationState =
	| 'draft'
	| 'scheduled'
	| 'sending'
	| 'sent'
	| 'held'
	| 'accepted'
	| 'acceptance_unknown'
	| 'failed';

/**
 * Who authorized a send: the operator, an agent draft the operator committed,
 * or a standing policy acting on a recorded rule. Attribution renders in the
 * established vocabulary (lavender marks agents; policy reads as automatic).
 */
export type CommunicationActor =
	| 'you'
	| 'agent'
	| 'policy'
	| { readonly kind: 'human'; readonly displayLabel: string };

export interface RecipientRow {
	name: string;
	email: string;
	/**
	 * `excluded` is policy — the audience rules or a suppression kept this person
	 * out. `blocked` is a fault — their message could not be assembled, usually a
	 * merge value the record does not have. Both stay in the list as rows rather
	 * than collapsing into a count, because a number beside a table the people
	 * are not in is a number nobody can act on.
	 */
	state: 'included' | 'excluded' | 'blocked';
	/** Present on exclusions and blocks: why this person is not being sent to. */
	reason?: string;
	/** Sample resolved merge value shown in the per-recipient preview. */
	mergeSample?: string;
	/**
	 * This person's own resolved merge values, keyed by merge-field key. Feeds
	 * the rendered per-recipient preview; the recipient's name resolves
	 * `speaker.name` implicitly, so only values beyond it need stating.
	 */
	mergeValues?: Record<string, string>;
	/**
	 * The server's own handle for this person's resolved copy, when the lane
	 * renders server-side. It is what a rendered-preview read is asked for, so a
	 * ceremony can show the exact artifact rather than re-deriving one. Absent
	 * wherever the body is composed from a stored template in the browser.
	 */
	recipientResolutionId?: string;
	/**
	 * The stored template this person's copy renders from, by template key, when
	 * one send does not give everyone the same one — a decision batch mails an
	 * acceptance to one speaker and a waitlist notice to another. Absent means
	 * the review's single stated template covers every row.
	 */
	templateKey?: string;
}

/**
 * One recipient's email as the server rendered it — the artifact itself, not a
 * description of it.
 *
 * `plainText` is what a ceremony shows. The rendered HTML is deliberately not
 * carried here: nothing in this application renders server-produced markup, and
 * introducing the first such sink is a decision with its own review, not a
 * side-effect of showing someone what they are about to send.
 *
 * `warningCodes` are the renderer's own reservations about this copy. They are
 * surfaced rather than swallowed: a warning nobody sees is a warning that did
 * not happen.
 */
export interface RenderedEmailPreview {
	subject: string;
	plainText: string;
	warningCodes: string[];
}

/**
 * The deliberate-send review projection: everything a human needs to answer
 * who receives this, what each person sees, why it is allowed, and what
 * happens next — without a provider console.
 */
export interface MessageReview {
	templateLabel: string;
	audienceLabel: string;
	binding: 'current_snapshot';
	recipients: RecipientRow[];
	sender?: string;
	replyModel?: string;
	irreversibleNote: string;
}

/**
 * What a committed send actually did, from the sending port's own records.
 * `committed` messages became releases the workspace cannot withdraw; `sent`
 * counts the ones an outbound provider accepted, and is null only when the
 * port could not read that state (the commit still happened either way).
 * `note` states what became of the rest and where that state can be seen. A
 * port that commits without delivering reports `sent: 0` and says so — the
 * surface never restates a request count as mail somebody received.
 */
export interface NotificationDispatch {
	committed: number;
	sent: number | null;
	note: string;
}

export interface CommunicationMessage {
	id: string;
	/** The release batch reference used by the live delivery timeline. */
	messageRefId?: string;
	subject: string;
	audience: string;
	audienceCount?: number;
	state: CommunicationState;
	/** Registered purpose the send is authorized under — the row's scan key. */
	purpose: string;
	/** One sentence of provenance: the fact or intent that made this send exist. */
	cause: string;
	/** Door to the causal record when its rows live on another surface. */
	causeHref?: string;
	actor: CommunicationActor;
	/** The stored template the content came from, when one was used. */
	templateId?: string;
	/**
	 * The message's own body when it came from no stored template — a one-off
	 * written in the composer and frozen onto the send.
	 *
	 * Template-shaped so the review ceremony renders it through the one email
	 * rendering path, but it is not a library record: it is listed nowhere, has
	 * no revisions worth keeping, and belongs to this message alone. Present
	 * exactly when `templateId` is absent and the operator wrote something.
	 */
	document?: MessageTemplate;
	sentAt?: string;
	/** Present while held: the reason and next remedy (e.g. provider not ready). */
	heldReason?: string;
	deliveredCount?: number;
	bouncedCount?: number;
	bounces?: {
		deliveryId?: string;
		deliveryVersion?: number;
		email: string;
		reason: string;
		/** Exact marked-resend copy in sample evidence; live reads it from the retained release. */
		resendPreview?: RenderedEmailPreview;
	}[];
	/** Provider evidence available on a live batch; no field implies no such fact. */
	deliveryEvidence?: {
		materialized?: number;
		accepted?: number;
		delivered?: number;
		acceptanceUnknown?: number;
		knownFailed?: number;
		stateReason?: string;
	};
	/** Present on drafts: the reviewable batch projection. */
	review?: MessageReview;
}

/**
 * A currently actionable condition on the communications surface — a derived,
 * rebuildable projection, never a fire-once flag. Each item names its reason,
 * how many people it affects, and the one safe next action.
 */
export interface CommunicationAttentionItem {
	id: string;
	/** `action` is act-now/blocked (danger); `soon` needs attention (warning). */
	severity: 'action' | 'soon';
	reason: string;
	/** The remedy or what happens next, stated in place. */
	detail: string;
	/** Affected people, when the condition counts them. */
	count?: number;
	/** The message row carrying the evidence, when one does. */
	messageId?: string;
	action: { label: string; kind: 'review' | 'open-message' | 'setup' | 'open-schedule' };
}

/**
 * One entry in a person's communications thread — the per-recipient projection,
 * so `outcome` is this person's own fact (their copy bounced) rather than the
 * batch state. Organizer-visible, non-security mail only.
 */
export interface CommunicationThreadEntry {
	id: string;
	/** The batch row in history this entry came from, when it is still listed. */
	messageId?: string;
	at: string;
	purpose: string;
	subject: string;
	outcome:
		| 'delivered'
		| 'sent'
		| 'bounced'
		| 'scheduled'
		| 'accepted'
		| 'acceptance_unknown'
		| 'failed'
		| 'attempting';
	actor: CommunicationActor;
}

/** A person's communications thread: who it is about plus their entries, newest first. */
export interface CommunicationThread {
	personId: string;
	personName: string;
	entries: CommunicationThreadEntry[];
}

export interface CommunicationDeliveryTimelineEntry {
	id: string;
	deliveryId: string;
	recipient: string;
	actor: CommunicationActor;
	state: 'pending' | 'attempting' | 'accepted' | 'delivered' | 'bounced' | 'acceptance_unknown' | 'failed';
	at: string;
	attemptNumber?: number;
	attemptKind?: 'original' | 'marked_resend';
	reason?: string;
}

export interface CommunicationDeliveryTimeline {
	messageId: string;
	entries: CommunicationDeliveryTimelineEntry[];
	/** Exact marked-resend artifacts, keyed to bounced delivery ids. */
	resendPreviews: Array<RenderedEmailPreview & { deliveryId: string }>;
}

/** A sendable audience, resolved and counted by the API from current records. */
export interface AudienceOption {
	id: string;
	label: string;
	/** Absent until the authoritative preview resolves the live audience. */
	count?: number;
	/** Present when the audience is one person (a scoped compose). */
	personId?: string;
}

/**
 * One person in the compose-time audience preview: who they are, and whether
 * this send will reach them. It shares `RecipientRow`'s state vocabulary so the
 * words do not change between picking an audience and reviewing the send, but
 * it is deliberately narrower — no address, no resolved copy. Choosing an
 * audience is not the authoritative check, and it must not disclose more about
 * the people in it than the review discloses when the send is examined.
 */
export interface AudiencePreviewRow {
	name: string;
	state: RecipientRow['state'];
	/** Present on exclusions and blocks: why this person is not being sent to. */
	reason?: string;
	/**
	 * The roster id of the person this row resolved to, when they are on it.
	 * It opens the same profile disclosure their name opens everywhere else —
	 * one person, one door, asked for one at a time. It widens nothing: the list
	 * still carries no addresses, and the peek is the app's ordinary
	 * individual-disclosure surface rather than a bulk read.
	 */
	speakerId?: string;
	/**
	 * Which selected group put them in this send — the first one that claimed
	 * them, which is the group whose copy they receive under the union's
	 * first-claim rule. Absent when only one group is selected, where naming it
	 * would only repeat the single chip above.
	 */
	via?: string;
}

/**
 * What a combination of audiences comes to, resolved from current records.
 * `reach` counts the people actually sent to and `overlap` the people more than
 * one selected group claimed — never a sum of the groups' own counts, which
 * would double-count anyone the groups share.
 */
export interface AudiencePreview {
	rows: AudiencePreviewRow[];
	reach: number;
	overlap: number;
	/** The combined audience in words, e.g. "Confirmed speakers + Reviewers". */
	label: string;
}

export type ReadinessState = 'ready' | 'action_required' | 'unknown' | 'not_applicable';

export interface EmailReadiness {
	provider: string;
	outbound: ReadinessState;
	callbacks: ReadinessState;
	inbound: ReadinessState;
}

// ---------------------------------------------------------------------------
// Message templates and event brand

/** A text unit's bounded weight choice. */
export type TextStyleWeight = 'regular' | 'semibold';

/** A text unit's bounded alignment choice. */
export type TextStyleAlign = 'start' | 'center';

/**
 * Optional style tags a text unit may carry — bounded choices, never free CSS.
 * `size` is a literal pixel number, clamped to the bounded range (10–72,
 * integers) and compiled verbatim into the artifact HTML, so the output stays
 * email-safe and self-contained. An absent property renders the unit's
 * default: each unit kind's own base size, `regular`, `start`.
 */
export interface TextStyle {
	size?: number;
	weight?: TextStyleWeight;
	align?: TextStyleAlign;
}

/**
 * One block of a message template body. Heading and paragraph text may carry
 * merge tokens written `{{key}}` (e.g. `{{speaker.name}}`), resolved per
 * recipient at render time. A button's `href` is a symbolic product reference
 * (`portal.tasks`, `event.schedule`) the renderer resolves into a real
 * address — never a raw URL, so a template cannot point outside the product.
 * The message footer is renderer-owned and is never expressed as a block.
 *
 * Text-bearing blocks may carry `suggestedVars`: the merge keys most likely to
 * belong in that block, surfaced as one-press insert chips in its editor. Keys
 * must exist in the template's `mergeFields`; the full set stays reachable one
 * step deeper regardless.
 */
export type TemplateBlock =
	| { type: 'heading'; text: string; style?: TextStyle; suggestedVars?: string[] }
	| { type: 'paragraph'; text: string; style?: TextStyle; suggestedVars?: string[] }
	| { type: 'details'; rows: { label: string; value: string }[]; suggestedVars?: string[] }
	| { type: 'button'; label: string; href: string }
	| { type: 'divider' };

/** A merge token a template uses, with a realistic sample for previews. */
export interface MergeFieldDef {
	key: string;
	label: string;
	sample: string;
}

/** One entry in a template's revision history. */
export interface TemplateRevisionMeta {
	number: number;
	at: string;
	by: 'you' | 'agent';
	note: string;
}

export interface MessageTemplate {
	id: string;
	/** Stable purpose key ('decision-accepted', 'task-reminder', ...). */
	key: string;
	name: string;
	purpose: string;
	subject: string;
	blocks: TemplateBlock[];
	/** Every token the subject or blocks use has a definition here. */
	mergeFields: MergeFieldDef[];
	revision: number;
	revisions: TemplateRevisionMeta[];
	/** The product flows that send with this template. */
	usedBy: string[];
}

/**
 * The event's brand: the portable theme recipe plus the short initials mark,
 * derived from the event name by default.
 */
export interface EventTheme extends ThemeRecipe {
	markText: string;
}

/**
 * How a template edit instruction will be run: a quick wording-only touch or a
 * comprehensive structural pass. The label names the processing profile the
 * server chose; it is data, never derived client-side.
 */
export interface EditClassification {
	scope: 'quick' | 'comprehensive';
	profileLabel: string;
	reason: string;
	/**
	 * Who picked the profile: `auto` when routing chose it (label and reason
	 * describe the routed profile), `you` when the organizer pinned a model
	 * (label echoes the picked model).
	 */
	chosenBy: 'auto' | 'you';
}

/**
 * One model an edit can be pinned to, or the routing default. Server data end
 * to end — ids and labels are display values from the api, never constants in
 * feature code. The recommended default is always listed first.
 */
export interface ModelChoice {
	id: string;
	label: string;
	/** One supporting line under the label, when the choice needs explaining. */
	sub?: string;
}

/**
 * A one-tap starter instruction for a template's kind. The text is a real
 * `revise` instruction: pressing it produces a visible draft change.
 */
export interface TemplateSuggestion {
	text: string;
}

/** Progress of a template revision while it streams. */
export interface ReviseProgress {
	status: 'classifying' | 'drafting' | 'done';
	tokens: number;
}

// ---------------------------------------------------------------------------
// Person-and-talk field registry

/**
 * Every kind of answer the product can collect. One union shared by the field
 * registry and public surface rendering, so a registry field can always be
 * rendered wherever it is asked.
 */
export type FieldKind =
	| 'text'
	| 'textarea'
	| 'email'
	| 'url'
	| 'phone'
	| 'number'
	| 'date'
	| 'datetime'
	| 'select'
	| 'multiselect'
	| 'checkbox'
	| 'file';

/**
 * Where a field is collected: the CFP application, confirmed-speaker
 * onboarding, or the portal's editable self-view. Contexts select from one
 * registry — they never fork it — so promoting an applicant never re-asks
 * what the application already answered.
 */
export type FieldContext = 'apply' | 'onboard' | 'profile';

/** The event vocabularies a choice field can draw its options from. */
export type FieldOptionSource = 'tracks' | 'formats';

/**
 * The canonical placement ladder a field list is organized by, in its fixed
 * order. Consent always renders last.
 */
export type FieldGroup =
	| 'identity'
	| 'contact'
	| 'presence'
	| 'talk'
	| 'logistics'
	| 'materials'
	| 'other'
	| 'consent';

/** One field in the event's person-and-talk registry, defined once and projected into contexts. */
export interface RegistryField {
	id: string;
	kind: FieldKind;
	label: string;
	/** Short guidance rendered beside the control. */
	help?: string;
	/** Per-context requiredness; a context not named here collects the field as optional. */
	required: Partial<Record<FieldContext, boolean>>;
	/** The contexts that ask this field. */
	collectAt: FieldContext[];
	/** Choices, for `select` and `multiselect` fields only. */
	options?: string[];
	/**
	 * Where a choice field's options come from when they are event vocabulary
	 * rather than typed-in strings. A sourced field serves the live vocabulary at
	 * read time — options are never copied into the field — so adding a track
	 * changes every form that offers the question. `options` is ignored when set.
	 */
	optionSource?: FieldOptionSource;
	group: FieldGroup;
	/** Order within the whole list, user-owned after first placement. */
	position: number;
	/** Id of the one form it belongs to, when form-scoped. */
	formScope?: string;
	/** Cannot be deleted or removed from apply (email-in-apply only). */
	locked?: boolean;
}

// ---------------------------------------------------------------------------
// Public surface templates

/** Which public surface a template describes. */
export type SurfaceKind = 'schedule' | 'application-form' | 'speaker-roster';

/**
 * One block of a public surface template. The same revisable-block shape
 * messages use, with surface-specific types: a schedule listing carries its
 * display options as data, and a form section names its questions by reference
 * into the template's field pool — never inline, so a question can move
 * between sections without being retyped.
 */
export type SurfaceBlock =
	| { type: 'hero'; title: string; intro: string; titleStyle?: TextStyle; introStyle?: TextStyle }
	| {
			type: 'schedule-days';
			grouping: 'day' | 'track';
			showRoom: boolean;
			showTrack: boolean;
			showSpeakers: boolean;
			density: 'cozy' | 'compact';
	  }
	| {
			type: 'roster-list';
			/**
			 * How the people are laid out. `profile` is the single-person
			 * presentation — one card with the whole biography — and is what an
			 * embed scoped to one speaker renders; it is authorable too, because a
			 * one-person roster is a real thing (a keynote page).
			 */
			layout: 'grid' | 'list' | 'strip' | 'profile';
			grouping: 'none' | 'category';
			showHeadline: boolean;
			showSessions: boolean;
			showLinks: boolean;
			density: 'cozy' | 'compact';
	  }
	| {
			type: 'form-section';
			title: string;
			description?: string;
			/**
			 * The ladder groups whose apply-context registry fields this section
			 * asks. When present, the section's `fieldRefs` are served derived from
			 * the field registry; a section without `groups` keeps its refs as
			 * authored.
			 */
			groups?: FieldGroup[];
			fieldRefs: string[];
	  }
	| { type: 'note'; text: string; style?: TextStyle };

/** One question in an application form's field pool, referenced by `form-section` blocks. */
export interface SurfaceField {
	id: string;
	label: string;
	kind: FieldKind;
	required: boolean;
	/** Choices, for `select` and `multiselect` fields only. */
	options?: string[];
	/** Short guidance rendered beside the control. */
	help?: string;
	/** The ladder group the question classifies into, so a per-form view can rebuild section membership. */
	group: FieldGroup;
	/** Names the one form this question belongs to; absent for shared questions. */
	formScope?: string;
	/** Present when the options are served from an event vocabulary. */
	optionSource?: FieldOptionSource;
	/**
	 * The live vocabulary behind a sourced field's options — id and name per
	 * active entry — so a per-form view can offer a subset without re-reading
	 * the vocabulary. `options` already carries the resolved names.
	 */
	optionChoices?: { id: string; name: string }[];
}

/**
 * A public surface (the published schedule, the application form) as a
 * template: the same revision machinery as message templates — classify,
 * revise, apply, revert — over surface blocks instead of email blocks.
 */
export interface SurfaceTemplate {
	id: string;
	kind: SurfaceKind;
	name: string;
	purpose: string;
	blocks: SurfaceBlock[];
	/** The question pool `form-section` blocks reference. Application forms only. */
	fields?: SurfaceField[];
	/** The submit button's wording. Application forms only; absent renders the default. */
	submitLabel?: string;
	revision: number;
	revisions: TemplateRevisionMeta[];
	/** The product surfaces that render from this template. */
	usedBy: string[];
}

/**
 * Any revisable template. Discriminated by shape rather than an added tag:
 * a surface template carries `kind`, a message template carries `subject` and
 * never `kind` — narrow with `isSurfaceTemplate`.
 */
export type AnyTemplate = MessageTemplate | SurfaceTemplate;

/** Narrows an {@link AnyTemplate}: surface templates carry `kind`; message templates do not. */
export function isSurfaceTemplate(template: AnyTemplate): template is SurfaceTemplate {
	return 'kind' in template;
}

// ---------------------------------------------------------------------------
// Embeds

/**
 * Which slice of a surface's data one embed shows.
 *
 * A closed union rather than a query string: an embed is a public request path,
 * so what it may ask for is enumerated here and validated at the boundary. It
 * selects among the surface's own published projections; it never carries a
 * filter expression, a field list, or anything an organizer-only projection
 * could satisfy.
 */
export type EmbedScope =
	| { kind: 'all' }
	/** The public roster, narrowed to one speaker category. */
	| { kind: 'category'; categoryId: string }
	/** One person's public card — the individual-speaker embed. */
	| { kind: 'speaker'; speakerId: string }
	/** The schedule, narrowed to one day. */
	| { kind: 'day'; dayKey: string }
	/** One application form's questions, rendered through the shared surface. */
	| { kind: 'form'; formId: string };

/**
 * How the embed's code reaches the host page. Three mechanisms, because host
 * pages differ in what they permit and each one costs something different:
 *
 * - `inline` — a custom element rendered into a shadow root. Our styles cannot
 *   leak out and the host's cannot leak in, the block grows with its content
 *   (no fixed height, no nested scrollbar), and the content is part of the host
 *   document. Needs the host to allow one script tag.
 * - `frame` — an iframe. Same isolation from a separate document, and it works
 *   where scripts are stripped, but the host must be told a height and
 *   `match-site` styling is impossible across the document boundary.
 *
 * A third option — an anchor to the hosted page — is deliberately *not* a
 * delivery: the hosted page has its own address, handed out as a link rather
 * than as markup, and offering the same thing twice in two shapes is one
 * control too many.
 */
export type EmbedDelivery = 'inline' | 'frame';

/**
 * Where the embed's look comes from.
 *
 * `event` paints the event's own brand, so the embed reads as a continuation of
 * the event. `match-site` leaves the two inherited properties that carry a
 * site's voice — font family and text colour — undeclared at the embed root, so
 * the host page's own cascade supplies them while every structural decision
 * (layout, spacing, radii, borders, accent) stays ours. Unavailable through
 * `frame`, where nothing inherits across the document boundary.
 */
export type EmbedStyleMode = 'event' | 'match-site';

/** How the embed sits in whatever box the host page gives it. */
export interface EmbedFit {
	/** Widest the content may run, in px; null lets it fill the host's box. */
	maxWidth: number | null;
	align: 'start' | 'center';
}

/**
 * One embed, as an organizer configures it. Everything a snippet needs and
 * nothing a snippet must not carry: no session, no capability token, no
 * organizer projection, no style payload.
 */
export interface EmbedSpec {
	surfaceId: string;
	kind: SurfaceKind;
	scope: EmbedScope;
	fit: EmbedFit;
	style: EmbedStyleMode;
	delivery: EmbedDelivery;
	/**
	 * The host origins allowed to frame this embed. Empty means any origin, which
	 * only a read-only surface may choose; a surface that accepts submissions
	 * always carries an allowlist.
	 */
	allowedOrigins: string[];
}

/** One thing an organizer can put on their site, as the picker lists it. */
export interface EmbedTarget {
	/** Stable key for the address (`?embed=`): the surface, plus the scope when the scope names the target. */
	key: string;
	surfaceId: string;
	kind: SurfaceKind;
	scope: EmbedScope;
	name: string;
	/** One line: what a visitor sees. */
	purpose: string;
	/** How many records it currently shows — an empty embed is worth knowing about before pasting it. */
	count: number;
	/** What `count` counts, singular ('session', 'speaker', 'question'). */
	countNoun: string;
	/** True when the surface accepts submissions, which binds the origin allowlist. */
	acceptsSubmissions: boolean;
	/** Canonical surface-head policy; every embed kind denies framing when this is empty. */
	allowedOrigins: string[];
}

// ---------------------------------------------------------------------------
// Forms

/**
 * Where accepted submissions go — routing, never placement authority. A
 * category or session target names its reference; the referenced name is
 * resolved live at render time, never copied onto the form. Availability
 * (whether and when intake closes) is a separate axis: any target can run
 * without a close date.
 */
export type FormTarget =
	| { kind: 'general' }
	| { kind: 'category'; category: 'track' | 'format'; id: string }
	| { kind: 'session'; sessionId: string };

/**
 * How one form composes the shared field registry: which apply-context
 * questions it leaves out, where its requiredness differs from the registry
 * default, and which vocabulary options its sourced choice fields offer.
 * A form that keeps all three empty asks the standard application — the
 * baseline is the product's opinion, and deviation is the opt-in.
 */
export interface FormComposition {
	/** Shared apply-context questions this form does not ask. Never the locked email field. */
	excludedFieldIds: string[];
	/** Per-form requiredness where it differs from the registry's apply default. */
	requiredOverrides: Record<string, boolean>;
	/**
	 * Per sourced field, the vocabulary entry ids this form offers. A field
	 * absent here offers every current and future active entry — the live
	 * default; a listed subset is pinned and new entries stay out until chosen.
	 */
	optionExposure: Record<string, string[]>;
}

export interface FormSummary {
	id: string;
	name: string;
	target: FormTarget;
	status: 'draft' | 'open' | 'closed';
	/** The exact published form version; null until the first publication. */
	currentPublishedVersionId: string | null;
	/**
	 * ISO date (yyyy-mm-dd) after which normal intake ends — the materialized
	 * fixed-anchor close deadline. Absent = no close date: the form stays open
	 * until closed by hand (the evergreen availability). Close semantics are
	 * soft by default: on-time editing locks, late arrivals join the late tray.
	 */
	closesAt?: string;
	version: number;
	submissionCount: number;
	/** Questions this form effectively asks — derived from the registry and the composition, never stored. */
	fieldCount: number;
	composition: FormComposition;
}

/**
 * One registry question as a form's configuration surface sees it: the shared
 * definition plus this form's answer to "asked here?", "required here?", and —
 * for vocabulary-sourced choice fields — "which options are offered?".
 */
export interface FormFieldRow {
	field: RegistryField;
	/** Whether this form asks the question. */
	included: boolean;
	/** Effective requiredness on this form (override or registry default). */
	required: boolean;
	/** True when `required` comes from a per-form override rather than the registry. */
	requiredOverridden: boolean;
	/** For vocabulary-sourced fields: every active entry, with this form's exposure. */
	options?: { id: string; name: string; exposed: boolean }[];
	/** True when the form offers all current and future entries (no pinned subset). */
	exposureAll: boolean;
}

/** One event as the sidebar switcher offers it — a serve-time projection. */
export interface WorkspaceEventOption {
	id: string;
	name: string;
	dates: string;
	location: string;
	/** Which data source renders this event; switching activates it. */
	scenarioKey: string;
	current: boolean;
}

// ---------------------------------------------------------------------------
// Account — the signed-in person, as the account menu sees them.

/**
 * An email change in flight. The change commits only after both mailboxes
 * confirm — the current address approves it, the new address proves receipt —
 * and until then the account keeps its current address.
 */
export interface AccountEmailChange {
	newEmail: string;
	confirmedCurrent: boolean;
	confirmedNew: boolean;
}

export interface AccountInfo {
	name: string;
	email: string;
	pendingEmailChange: AccountEmailChange | null;
}

// ---------------------------------------------------------------------------
// Settings

/** Role presets; a preset is copied into a concrete, editable role. */
export const rolePresets = [
	'Workspace Admin',
	'Event Manager',
	'Speaker Manager',
	'Speaker Reviewer',
	'Scheduler',
	'Communications Coordinator',
	'Viewer'
] as const;

/**
 * What each preset can do and its key limit, for choosing a role. Each entry
 * states capability first, then the boundary that separates it from the next
 * broader role.
 */
export const rolePresetDescriptions: Readonly<Record<(typeof rolePresets)[number], string>> = {
	'Workspace Admin':
		'Full control of the workspace: every event permission plus team access, roles, integrations, and audit history.',
	'Event Manager':
		'Runs the event end to end — settings, speakers, submission decisions, schedule and publishing, communications. No team-access or integration management.',
	'Speaker Manager':
		'Maintains speaker profiles and contact details and handles speaker communication. Sees submissions and the schedule without scoring or editing them.',
	'Speaker Reviewer':
		'Reads, scores, and comments on submissions. No private contact details and no accept/reject decisions.',
	Scheduler:
		'Builds the working schedule — sessions, rooms, timing — with full speaker and submission context. Publishing stays a separate permission.',
	'Communications Coordinator':
		'Drafts and sends messages to speakers and attendees, with the contact details and schedule context that requires. Cannot edit records.',
	Viewer:
		'Read-only: event details, speaker directory, submissions, and the working schedule. No private contact details.'
};

export type MemberStatus = 'active' | 'invited' | 'pending_review';

export interface Member {
	id: string;
	name: string;
	email: string;
	role: string;
	/** Defaults to active when absent. */
	status?: MemberStatus;
}

export interface EventSettings {
	name: string;
	dates: string;
	/** ISO date (yyyy-mm-dd); the display string above is derived from these. */
	startDate?: string;
	endDate?: string;
	location: string;
	timezone: string;
	venueNote: string;
	/**
	 * Schedule-grid day window and slot length. The three values are present
	 * together or all null; all-null (or absent in sample data) means the event
	 * publishes no grid. dayStart/dayEnd are zero-padded HH:MM; slotMinutes is
	 * one of 5, 10, 15, 20, 30, or 60 and divides the day window exactly.
	 */
	dayStart?: string | null;
	dayEnd?: string | null;
	slotMinutes?: number | null;
	/** Off by default: profile revisions become publication-eligible automatically. */
	profileContentReview?: boolean;
	/**
	 * Whether the hosted public pages ask to be indexed by search engines.
	 *
	 * Off until the organizer turns it on, and deliberately so: a call for
	 * proposals, a half-built programme, and a lineup that is still being
	 * announced are all pages an event wants to *hand out* long before it wants
	 * them found by strangers — and un-indexing a page that has already been
	 * crawled is far harder than indexing one that has not. The link works
	 * either way; this only governs the robots directive.
	 */
	publicIndexing?: boolean;
}

/** Structured outcome for operations that can be legitimately refused. */
export type MutationOutcome = { ok: true } | { ok: false; reason: string };
