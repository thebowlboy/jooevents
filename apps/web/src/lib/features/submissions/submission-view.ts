/**
 * What a submission row and its detail *say* — kept out of the templates so the
 * two surfaces that render submissions (the triage queue and the decision
 * board) cannot drift, and so the wording is testable without a browser.
 *
 * Three defects live here as rules rather than as review vigilance:
 *
 * 1. **A vocabulary id is not a label.** `?? id` used to manufacture one, which
 *    is how nine empty capsules and nine raw ids both shipped from the same
 *    line. Resolution is a three-state answer — named, absent, or not yet
 *    knowable — because those are three different things to say and only one of
 *    them is "No track".
 * 2. **An absence that matters is said in words and made findable.** A
 *    submission with no track is a real population an organizer has to work
 *    through, so it gets a scope in the track filter and a word on the row's
 *    quietest rung.
 * 3. **A state has one tone everywhere.** The decision vocabulary maps to
 *    `StatusIconKey`s and nothing else; tone and glyph come from `badgeFor` at
 *    the render site, so no surface can invent its own loudness for a state
 *    another surface already named.
 */

import type { StatusIconKey } from '$lib/ui';
import type {
	DecisionState,
	Format,
	ReviewRoundStatus,
	SignalChip,
	Submission,
	SubmissionOrigin,
	Track,
	TrayKey
} from '$lib/api/types';

/**
 * The track filter's scope for submissions carrying no track at all.
 *
 * A reserved id rather than a separate parameter: the scope answers the same
 * question the other options answer ("which track?"), so it belongs in the same
 * control and the same address key. `none` is therefore not available as a
 * track id — a constraint worth one line here and no code anywhere else.
 */
export const NO_TRACK_SCOPE = 'none';

/** Whether the address is asking for the untracked population. */
export function isNoTrackScope(trackId: string): boolean {
	return trackId === NO_TRACK_SCOPE;
}

/**
 * What the port is asked for. The untracked scope is not a track, so it is not
 * a track filter either: the tray comes back whole and the narrowing happens
 * here, over rows the surface is already holding.
 */
export function trackQuery(trackId: string): string | undefined {
	if (trackId.length === 0 || isNoTrackScope(trackId)) return undefined;
	return trackId;
}

/** Whether one row carries no track. Deliberately vocabulary-free: emptiness is
 *  a fact about the row, knowable before the event's tracks have been read. */
export function hasNoTrack(row: Pick<Submission, 'trackId'>): boolean {
	return row.trackId.trim().length === 0;
}

/** The rows the current track scope selects, out of the rows on hand. */
export function rowsInTrackScope<T extends Pick<Submission, 'trackId'>>(
	rows: readonly T[],
	trackId: string
): T[] {
	return isNoTrackScope(trackId) ? rows.filter(hasNoTrack) : [...rows];
}

/**
 * A vocabulary value as the surface may state it.
 *
 * `unresolved` is the state the old `?? id` fallback was hiding: the row names
 * a category the vocabulary read has not landed for, or does not contain. The
 * honest rendering of that is *nothing at all* — neither a chip nor the claim
 * that the submission has no track, because both would be assertions the
 * surface cannot make yet.
 */
export type VocabLabel =
	| { readonly kind: 'named'; readonly name: string }
	| { readonly kind: 'none' }
	| { readonly kind: 'unresolved' };

function resolve(
	entries: readonly { readonly id: string; readonly name: string }[],
	id: string
): VocabLabel {
	if (id.trim().length === 0) return { kind: 'none' };
	const name = entries.find((entry) => entry.id === id)?.name?.trim();
	return name === undefined || name.length === 0 ? { kind: 'unresolved' } : { kind: 'named', name };
}

/** The row's track, as a thing the surface may say. */
export function trackLabel(tracks: readonly Track[], id: string): VocabLabel {
	return resolve(tracks, id);
}

/** The row's format, as a thing the surface may say. */
export function formatLabel(formats: readonly Format[], id: string): VocabLabel {
	return resolve(formats, id);
}

/** The event's track order — what walks the accent palette from the top, so the
 *  same track wears one colour on every surface that reads the same list. */
export function trackOrder(tracks: readonly Track[]): string[] {
	return tracks.map((track) => track.id);
}

export const trayLabels: Record<TrayKey, string> = {
	inbox: 'Inbox',
	/* Plain words, because these four are the fates an operator sorts into and
	   none of them is a decision the submitter ever sees. "Set aside" replaced
	   "Folded": a coinage that taught nothing, and whose nearest reading —
	   poker, where you fold your *own* hand — is the reverse of what happens.
	   "Set aside" stays the judgment-free parking; "Spam" names the junk
	   population and uses the familiar email model, where a filter flags
	   suspects, a human confirms, and "Not spam" is the available reversal.
	   The tray remains retained and recoverable. */
	'set-aside': 'Set aside',
	late: 'Late',
	spam: 'Spam'
};

export const TRAY_ORDER: readonly TrayKey[] = ['inbox', 'set-aside', 'late', 'spam'];

/** One member of the tray scope set, before the surface attaches its glyph. */
export interface TrayScope {
	readonly value: TrayKey;
	readonly label: string;
	readonly count?: number;
}

/**
 * The four trays as a scope set.
 *
 * Counts join only once the totals are known: a scope announcing "0" before the
 * read lands is a claim about a population nobody has counted. The chips are
 * equal-width either way, so the number arrives without moving anything.
 */
export function trayScopes(totals: Readonly<Record<TrayKey, number>> | null): TrayScope[] {
	return TRAY_ORDER.map((value) => ({
		value,
		label: trayLabels[value],
		...(totals ? { count: totals[value] } : {})
	}));
}

/**
 * The decision vocabulary: one word and one keyed state per outcome.
 *
 * Tone and glyph are deliberately absent — they come from `badgeFor(key)` at
 * the render site, which is what stops "Un-notified" from being soft amber on
 * one surface and solid amber on another. Emphasis is not here either: it is a
 * decision about the region a badge sits in, and a column of solid badges is
 * always wrong.
 */
export interface DecisionStatus {
	readonly key: StatusIconKey;
	readonly label: string;
}

export const decisionStatus: Record<DecisionState, DecisionStatus> = {
	/* The base vocabulary states the neutral fact. Actionable custody adds the
	   organizer-facing next step through `decisionStatusFor` below. */
	undecided: { key: 'notStarted', label: 'No decision' },
	accepted: { key: 'accepted', label: 'Accepted' },
	waitlisted: { key: 'waitlisted', label: 'Waitlisted' },
	declined: { key: 'declined', label: 'Declined' },
	withdrawn: { key: 'withdrawn', label: 'Withdrawn' }
};

/**
 * The decision wording the organizer needs on this row.
 *
 * Inbox and Late are decision-bearing custody: an undecided row there needs
 * the organizer's action. Set aside and Spam are deliberately outside the
 * decision pass, so "Needs decision" would manufacture an obligation the tray
 * explicitly suspended; those rows keep the neutral "No decision" fact.
 */
export function decisionStatusFor(
	row: Pick<Submission, 'decision' | 'tray'>
): DecisionStatus {
	if (row.decision === 'undecided' && (row.tray === 'inbox' || row.tray === 'late')) {
		return { key: 'notStarted', label: 'Decision needed' };
	}
	return decisionStatus[row.decision];
}

/** The one compact state label for a decided row whose result is still owed. */
export const noticeStatus = { key: 'unnotified', label: 'Result not sent' } as const;

/** Whether a decided row is still owed its notice. Withdrawal is the submitter's
 *  own act, so it is never waiting on a message from the organizer. */
export function awaitsNotice(row: Pick<Submission, 'decision' | 'notified'>): boolean {
	return row.decision !== 'undecided' && row.decision !== 'withdrawn' && !row.notified;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The review standing in words, for the detail — where there is a line to spend
 * on saying what the figure means. The row's own cell shows the bare average,
 * because "4.8 / 3" beside it reads as a score out of three.
 */
export function reviewSummary(row: Pick<Submission, 'reviewAverage' | 'reviewCount'>): string {
	if (row.reviewCount === 0) return 'No reviews yet';
	if (row.reviewAverage === undefined) return `${plural(row.reviewCount, 'review')}, no average yet`;
	return `${row.reviewAverage.toFixed(1)} average of ${plural(row.reviewCount, 'review')}`;
}

/**
 * Two clocks, two homes (owner rework, 2026-08-15).
 *
 * **Arrival lives in its own column, on every row.** It is the value the
 * arrival groups are sorted by, which is exactly what earns a column
 * (`design-system.md` §Adjacency is comprehension; columns are comparison) —
 * and the organizer's own recall runs on it: "I remember what was here last
 * time" only works if every row states when it came. The earlier design
 * suppressed arrival on any row a reviewer had touched ("age is pressure");
 * that conflated pressure with information. A bare quiet timestamp in a
 * constant slot pressures nobody, and hiding it made most of the inbox
 * clockless.
 *
 * **The one clock that is pressure — a decided row whose result was never
 * sent — stays in the metadata sentence and names itself**, because it is a
 * different fact than the arrival and two meanings must not share one slot.
 */
export function noticeAge(
	row: Pick<Submission, 'decision' | 'decidedAt' | 'notified'>
): string | null {
	return awaitsNotice(row) && row.decidedAt !== undefined ? row.decidedAt : null;
}

/** The station-group vocabulary the queue renders rows inside. `all` is a flat
 *  tray with no group bands (set-aside, spam). */
export type RowSection = 'review' | 'deciding' | 'notice' | 'done' | 'all';

/** What the Decision cell may say for a row inside a given section. */
export interface DecisionCell {
	readonly status?: DecisionStatus;
	/** Whether the row additionally carries the "Result not sent" mark. */
	readonly notice: boolean;
	/** A quiet absence note instead of a badge — the resting fact on the
	 *  quietest rung, like "No reviews yet" one column over. */
	readonly absent?: string;
}

const UNDECIDED_CELL: DecisionCell = Object.freeze({ notice: false, absent: 'No decision yet' });

/**
 * The Decision cell, deduplicated against the group band above it.
 *
 * "If every row would say the same thing, it is not a row's thing to say"
 * (`design-system.md` §An empty cell says why it is empty). Inside the two
 * undecided station groups the state is constant by construction — the band
 * already reads "In review" or "Decision needed" — so the rows drop the badge.
 * A fully blank cell read as a defect beside the decided groups' filled ones
 * (owner, 2026-08-15), so the resting fact stays, on the quietest rung: the
 * same small absence note the Reviews column uses for "No reviews yet". Inside
 * "Results not sent" the band carries the owed notice and the rows carry only
 * what varies: the verdict. Flat trays have no band to lean on, so their rows
 * keep the full badged projection.
 */
export function decisionCellFor(
	row: Pick<Submission, 'decision' | 'tray' | 'notified'>,
	section: RowSection
): DecisionCell {
	if (section === 'review' || section === 'deciding') return UNDECIDED_CELL;
	if (section === 'notice') return { status: decisionStatus[row.decision], notice: false };
	if (section === 'done') return { status: decisionStatus[row.decision], notice: false };
	return { status: decisionStatusFor(row), notice: awaitsNotice(row) };
}

// ---------------------------------------------------------------------------
// The journey: how far along its line a submission is (owner, 2026-08-15).
//
// The stations say which group a row sits in; the journey says how much of the
// whole line is behind it — submitted, reviewed, decided, result sent,
// scheduled — as one compact strip the eye can compare down the page. Pure
// projection over state the row already carries (plus the round target and the
// accepted row's origin), computed on read, stored nowhere.

export type JourneyState = 'done' | 'current' | 'upcoming' | 'skipped';

export interface JourneyStep {
	readonly key: 'submitted' | 'reviewed' | 'decided' | 'sent' | 'scheduled';
	readonly label: string;
	readonly state: JourneyState;
	/** The step's own fact, for the breakdown — never rendered on the strip. */
	readonly note: string;
}

function stepPlural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The five steps, each answered independently — done, skipped (this row's line
 * genuinely does not pass through it), or open — and then exactly one open
 * step is marked `current`: the first one, which is what "how far along" means.
 * Independence matters because the tail steps are not strictly ordered in
 * life: an accepted talk may be placed before its result is sent, and both
 * dots simply state their own truth.
 *
 * `origin` is the accepted row's landing: undefined = not read yet (renders as
 * not-yet-placed until the read lands), null = read, and it went nowhere.
 */
export function journeyOf(
	row: Pick<Submission, 'decision' | 'notified' | 'reviewCount' | 'tray'>,
	input: {
		readonly round: Pick<ReviewRoundStatus, 'open' | 'reviewsPerSubmission'> | null;
		readonly origin?: SubmissionOrigin | null;
		/** The arrival in words, composed by the caller who owns the clock. */
		readonly arrival?: string;
	} = { round: null }
): JourneyStep[] {
	const decided = row.decision !== 'undecided';
	const parked = !decided && (row.tray === 'set-aside' || row.tray === 'spam');
	const target = input.round?.open ? input.round.reviewsPerSubmission : undefined;

	// Reviewed: covered while an open round still owes it reviews; done once
	// reviews exist and nothing more is owed; a line that reached its verdict
	// with no reviews at all did not pass through this step.
	const reviewOpen =
		!decided && input.round?.open === true && row.reviewCount < (target ?? Infinity);
	const reviewed: Omit<JourneyStep, 'state'> & { done: boolean; skipped: boolean } = {
		key: 'reviewed',
		label: 'Reviewed',
		done: row.reviewCount > 0 && !reviewOpen,
		skipped: row.reviewCount === 0 && (decided || parked || input.round?.open !== true),
		note: reviewOpen
			? target === undefined
				? `${stepPlural(row.reviewCount, 'review')} in — round still open`
				: `${row.reviewCount} of ${target} reviews in`
			: row.reviewCount > 0
				? `${stepPlural(row.reviewCount, 'review')} in`
				: 'No reviews'
	};

	const sentSkipped = row.decision === 'withdrawn' || parked;
	const scheduledSkipped =
		row.decision === 'declined' || row.decision === 'withdrawn' || parked;

	const steps: (Omit<JourneyStep, 'state'> & { done: boolean; skipped: boolean })[] = [
		{
			key: 'submitted',
			label: 'Submitted',
			done: true,
			skipped: false,
			note: input.arrival ?? ''
		},
		reviewed,
		{
			key: 'decided',
			label: 'Decided',
			done: decided,
			skipped: parked,
			note: decided
				? decisionStatus[row.decision].label
				: parked
					? row.tray === 'set-aside'
						? 'Set aside — not being decided'
						: 'Marked as spam — not being decided'
					: reviewOpen
						? 'After the reviews'
						: 'Waiting on a decision'
		},
		{
			key: 'sent',
			label: 'Result sent',
			done: decided && !sentSkipped && row.notified,
			skipped: sentSkipped,
			note:
				row.decision === 'withdrawn'
					? 'Nothing owed — withdrawn by the submitter'
					: parked
						? 'Nothing owed'
						: decided
							? row.notified
								? 'Sent'
								: 'Result not sent'
							: 'After the decision'
		},
		{
			key: 'scheduled',
			label: 'Scheduled',
			done: row.decision === 'accepted' && input.origin != null,
			skipped: scheduledSkipped,
			note:
				row.decision === 'accepted'
					? input.origin
						? `${input.origin.kind === 'spawn' ? 'Became' : 'Joined'} “${input.origin.title}”`
						: 'Not placed yet'
					: row.decision === 'waitlisted'
						? 'If promoted from the waitlist'
						: scheduledSkipped
							? 'Not scheduled'
							: 'After acceptance'
		}
	];

	let currentTaken = false;
	return steps.map((step) => {
		const state: JourneyState = step.done
			? 'done'
			: step.skipped
				? 'skipped'
				: currentTaken
					? 'upcoming'
					: 'current';
		if (state === 'current') currentTaken = true;
		return { key: step.key, label: step.label, state, note: step.note };
	});
}

/**
 * Signal family tones, in one place so a chip in a row and the same chip in the
 * detail are one fact in one ink. These are palette accents rather than status
 * tones: a signal says what a machine noticed, not how a lifecycle stands.
 */
export const signalTone: Record<SignalChip['family'], 'sea' | 'lavender' | 'warning'> = {
	quality: 'sea',
	draw: 'lavender',
	integrity: 'warning'
};
