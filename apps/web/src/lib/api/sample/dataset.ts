import type {
	EmailReadiness,
	EventSettings,
	EventTheme,
	Format,
	FormSummary,
	Member,
	MessageTemplate,
	MyReviewItem,
	OutboxMessage,
	RegistryField,
	ReviewPlan,
	ScheduleState,
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
export type ScheduleSeed = Omit<ScheduleState, 'rooms'> & { rooms: RoomSeed[] };

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
 *   distribution is the population the row is ranked inside.
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
	myQueue: MyReviewItem[];
	/**
	 * Track id → every scored submission's review average in that track, the
	 * whole population rather than the listed window. A standing is a claim
	 * about a population, so it is stated here instead of being inferred from
	 * the handful of rows a scenario happens to spell out.
	 */
	reviewDistributions?: Record<string, number[]>;
	speakers: SpeakerRow[];
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
	outbox: OutboxMessage[];
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
	forms: FormSummary[];
	settings: EventSettings | null;
	members: Member[];
}
