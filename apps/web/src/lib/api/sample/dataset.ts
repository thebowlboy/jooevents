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
 * The display string public listings and the shell read for an event's dates,
 * derived from the ISO pair — one derivation for settings edits and created
 * events alike.
 */
export function formatDateRange(startIso: string, endIso: string): string {
	const start = new Date(`${startIso}T12:00:00`);
	const end = new Date(`${endIso}T12:00:00`);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${startIso} – ${endIso}`;
	const month = (date: Date) => date.toLocaleDateString('en-US', { month: 'short' });
	const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
	if (sameMonth) {
		return start.getDate() === end.getDate()
			? `${month(start)} ${start.getDate()}, ${start.getFullYear()}`
			: `${month(start)} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
	}
	return `${month(start)} ${start.getDate()} – ${month(end)} ${end.getDate()}, ${end.getFullYear()}`;
}

/**
 * A reviewer as a dataset authors one: identity, lifecycle, scope. The load
 * numbers (assigned/done/stepped back/awaiting reassignment) belong to the
 * API, which sums them across the scenario's review plans, so a dataset
 * states none of them. `id` must be the member id of the same person — a
 * reviewer is a workspace member, never a parallel roster.
 */
export type ReviewerSeed = Omit<
	Reviewer,
	'assigned' | 'done' | 'steppedBack' | 'awaitingReassignment'
>;

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
 *   same story (rows are a representative window; totals carry the real size);
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
	summary: WorkspaceSummary;
	tracks: TrackSeed[];
	formats: FormatSeed[];
	submissions: Submission[];
	submissionTrayTotals: Record<TrayKey, number>;
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
