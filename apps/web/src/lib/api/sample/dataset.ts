import type {
	CommunicationMessage,
	CommunicationThreadEntry,
	EmailReadiness,
	EventSettings,
	EventTheme,
	Format,
	FormComposition,
	FormSummary,
	Member,
	MessageTemplate,
	MyReviewItem,
	RegistryField,
	Reviewer,
	ReviewPlan,
	ScheduleState,
	SpeakerCategory,
	SpeakerLink,
	SpeakerRow,
	Submission,
	SurfaceTemplate,
	TaskAssignment,
	TaskDef,
	Track,
	TrayKey,
	VocabStatus,
	Room,
	WorkspaceSummary
} from '../types';
import { parseZonedInstant, startOfLocalDate } from '@jooevents/contracts';

/**
 * Vocabulary as a dataset authors it. Lifecycle status and usage counts belong
 * to the API — status starts active and usage is counted from the records that
 * reference the entry — so a dataset states neither.
 */
export type TrackSeed = Omit<Track, 'status' | 'usage'> & { status?: VocabStatus };
export type FormatSeed = Omit<Format, 'status' | 'usage'> & { status?: VocabStatus };
export type RoomSeed = Omit<Room, 'status' | 'usage'> & { status?: VocabStatus };
export type SpeakerCategorySeed = Omit<SpeakerCategory, 'status' | 'speakerCount'> & {
	status?: VocabStatus;
};
export type ScheduleSeed = Omit<ScheduleState, 'rooms'> & { rooms: RoomSeed[] };

/**
 * A workspace summary as a dataset authors one. The arrival pulse belongs to
 * the API, which measures it from the submissions on every read, so a dataset
 * states no delta of its own — exactly as it states no vocabulary usage counts
 * and no reviewer load numbers.
 */
export type WorkspaceSummarySeed = Omit<WorkspaceSummary, 'arrivals'>;

/**
 * A roster entry as a dataset authors one. Public order belongs to the API — a
 * dataset states the order it wants by listing rows in it, exactly as it states
 * vocabulary order — so `position` is materialized on load rather than typed
 * out per row, where it would drift the moment a row moved.
 */
export type SpeakerSeed = Omit<SpeakerRow, 'position'> & { position?: number };

/**
 * A form as a dataset authors one. The effective question count is derived
 * from the registry and the composition at read time — a dataset never states
 * it, so the card's number can't disagree with the configurator's rows. An
 * omitted composition means the standard application.
 */
export type FormSeed = Omit<FormSummary, 'fieldCount' | 'composition'> & {
	composition?: Partial<FormComposition>;
};

/**
 * An ISO date a given number of days ahead, for authoring form close dates.
 * Sample scenarios stay perpetually mid-story, so their deadlines are relative
 * to the day the workspace is opened rather than pinned to dates that would
 * silently pass.
 */
export function closesInDays(days: number): string {
	const date = new Date();
	date.setDate(date.getDate() + days);
	return date.toISOString().slice(0, 10);
}

/**
 * Instants authored relative to load, so a scenario's arrival story holds on
 * any day it is opened: “arrived 2 h ago” stays two hours ago, and the New
 * mark always has something honest to compute against. Static ISO dates would
 * age out of every relative window within a week of being written.
 */
export function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * 3_600_000).toISOString();
}

export function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * A deadline the way the catalog stores one, authored relative to the day the
 * workspace is opened: the event-local calendar date `days` from today, plus
 * the first instant of the day after it.
 *
 * Deadlines used to be authored as a pair of rendered strings — `absolute: 'Aug
 * 11, 23:59 EDT'` beside `relative: 'tomorrow'` — pinned to a "today" the
 * scenario named in prose. Five days after they were written the panel was
 * telling an operator that a date five days past was still tomorrow. Storing
 * the date and spelling the distance at read time is what makes that
 * unrepresentable.
 */
export function dayDeadline(
	days: number,
	timezone: string
): { displayDate: string; effectiveAt: string } {
	const here = parseZonedInstant(new Date().toISOString(), timezone);
	const now = new Date();
	const base = here ?? {
		year: now.getUTCFullYear(),
		month: now.getUTCMonth() + 1,
		day: now.getUTCDate()
	};
	const target = new Date(Date.UTC(base.year, base.month - 1, base.day + days));
	const displayDate = target.toISOString().slice(0, 10);
	const boundary = startOfLocalDate(
		{
			year: target.getUTCFullYear(),
			month: target.getUTCMonth() + 1,
			day: target.getUTCDate() + 1
		},
		timezone
	);
	return {
		displayDate,
		effectiveAt: new Date(boundary ?? target.getTime() + 86_400_000).toISOString()
	};
}

/**
 * Previous entries to a surface, newest first — one per day, `days` deep. The
 * arrival window reads habit off distinct days, so a scenario states how often
 * this operator actually works here rather than stating the window it wants.
 */
export function visitedOnLastDays(days: number, hourOfDay = 9): string[] {
	const visits: string[] = [];
	for (let back = 1; back <= days; back += 1) {
		const at = new Date(Date.now() - back * 86_400_000);
		at.setHours(hourOfDay, 0, 0, 0);
		visits.push(at.toISOString());
	}
	return visits;
}

/**
 * The display string public listings and the shell read for an event's dates,
 * derived from the ISO pair — one derivation for settings edits and created
 * events alike.
 *
 * It is the product's one date vocabulary, re-exported here because the sample
 * modules already reach for it through this file. Nothing about a sample
 * dataset makes its dates spell differently from a live one, and the previous
 * local copy proved the point: it took the *end* year for both ends, so a
 * scenario spanning New Year read `Dec 30 – Jan 2, 2027` and lost 2026.
 */
export { formatDateRange } from '@jooevents/contracts';

/**
 * A reviewer as a dataset authors one: identity, lifecycle, scope. The load
 * numbers (assigned/done/stepped back/awaiting reassignment) belong to the
 * API, which sums them across the scenario's review plans, so a dataset
 * states none of them. `id` must be the member id of the same person — a
 * reviewer is a workspace member, never a parallel roster.
 */
export type ReviewerSeed = Omit<
	Reviewer,
	'assigned' | 'done' | 'steppedBack' | 'awaitingReassignment' | 'email'
> & { email: string };

/**
 * A submitter's self-description as a dataset authors it, keyed by the address
 * their submissions carry. Everything that is a fact about the event rather
 * than about the person — how many submissions they sent, whether they reached
 * the roster, which sessions they hold — belongs to the API, which counts and
 * joins it, so a dataset states none of it.
 */
export interface SpeakerProfileSeed {
	email: string;
	headline: string;
	location?: string;
	links?: SpeakerLink[];
}

/**
 * One complete, internally coherent workspace state. Every screen renders a
 * projection of exactly one dataset, so a dataset is also a testable product
 * scenario. Coherence rules for authors:
 * - `summary` counters, `submissionTrayTotals`, and detail rows must tell the
 *   same story; a demo count that links to a row slice must be backed by that
 *   exact slice rather than an undisclosed aggregate;
 * - every attention item must be reachable on its area's screen;
 * - ids referenced across slices (tracks, sessions, speakers, tasks) must exist;
 * - every listed submission carrying a `reviewAverage` must have that exact
 *   average present in its track's `reviewDistributions` entry, because the
 *   distribution is the population the row is ranked inside;
 * - every id in `reviewPlans[].reviewers` must be a `reviewers` entry's id (and
 *   therefore a member id), and each plan's `done`/`total` must equal its
 *   roster rows' summed done/assigned — the meter and the roster tell one
 *   story;
 * - every reviewer scope ref must resolve to a track, format, or session that
 *   exists in the scenario.
 */
export interface WorkspaceDataset {
	key: string;
	name: string;
	description: string;
	summary: WorkspaceSummarySeed;
	tracks: TrackSeed[];
	formats: FormatSeed[];
	submissions: Submission[];
	submissionTrayTotals: Record<TrayKey, number>;
	/**
	 * The operator's previous entry to the submissions surface — the rotation
	 * value the surface-visit row would report, as an ISO instant. What the New
	 * mark's since-your-last-visit arm computes against; absent plays as a
	 * first-ever visit, where only the 24-hour arm applies.
	 */
	previousVisit?: string;
	/**
	 * The operator's earlier entries to the workspace, newest first — how often
	 * they actually work here. The arrival window is chosen from this: somebody
	 * on most days gets today's diff, somebody occasional gets the week's, and
	 * somebody who has been away gets the whole absence. Absent means the single
	 * `previousVisit` is all that is known, which reads as an occasional visitor.
	 */
	visitHistory?: string[];
	reviewPlans: ReviewPlan[];
	/**
	 * The reviewer roster: workspace members who review, with their scope.
	 * Empty while nobody has been invited to review. Load numbers are summed
	 * from `reviewPlans` at read time, never stated here.
	 */
	reviewers: ReviewerSeed[];
	myQueue: MyReviewItem[];
	/**
	 * Track id → every scored submission's review average in that track, the
	 * whole population rather than the listed window. A standing is a claim
	 * about a population, so it is stated here instead of being inferred from
	 * the handful of rows a scenario happens to spell out.
	 */
	reviewDistributions?: Record<string, number[]>;
	/** The roster, listed in the order the public lineup starts in. */
	speakers: SpeakerSeed[];
	/**
	 * How the public roster groups people, in the order the groups appear.
	 * Absent or empty means one ungrouped list, which is the right answer for a
	 * small event and the state every event starts in.
	 */
	speakerCategories?: SpeakerCategorySeed[];
	/**
	 * Profiles for some of the people who submitted. Partial on purpose: a
	 * submitter nobody has written a profile for is the ordinary case, and every
	 * surface has to render it as plain text rather than as a control that opens
	 * nothing.
	 */
	speakerProfiles?: SpeakerProfileSeed[];
	taskDefs: TaskDef[];
	assignments: TaskAssignment[];
	schedule: ScheduleSeed;
	communications: CommunicationMessage[];
	/**
	 * Per-person communication threads keyed by roster speaker id — each entry
	 * is that person's own outcome, not the batch state. Sparse on purpose:
	 * a person nobody has written to renders as an explicit "nothing sent yet".
	 */
	threads: Record<string, CommunicationThreadEntry[]>;
	readiness: EmailReadiness;
	/** Message templates; empty while the workspace has no event yet. */
	templates: MessageTemplate[];
	/** Public surface templates (schedule page, application form); empty while the workspace has no event yet. */
	surfaces: SurfaceTemplate[];
	/**
	 * The person-and-talk field registry; empty while the workspace has no event
	 * yet. The application form's question pool is a projection of this — the
	 * apply-context fields — never a second copy.
	 */
	fieldRegistry: RegistryField[];
	/** The event's brand recipe and initials mark. */
	theme: EventTheme;
	forms: FormSeed[];
	settings: EventSettings | null;
	members: Member[];
}
