/**
 * Data contracts for the workspace API. The current implementation serves these
 * from in-memory sample datasets; the shapes are the integration surface the
 * real transport will honor, so screens code against these types only.
 */

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

/**
 * How many records point at a vocabulary entry right now, counted by the
 * server. A client renders these numbers; it never derives them.
 */
export interface VocabUsage {
	/** Submissions carrying this track or format. */
	submissions: number;
	/** Sessions carrying this track or format. */
	sessions: number;
	/** Scheduled sessions sitting in this room. */
	placements: number;
}

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
}

export interface Room {
	id: string;
	name: string;
	capacity: number;
	status: VocabStatus;
	usage: VocabUsage;
}

// ---------------------------------------------------------------------------
// Workspace summary (shell + overview)

export type AttentionSeverity = 'now' | 'soon' | 'fyi';

export type AreaKey =
	| 'overview'
	| 'submissions'
	| 'review'
	| 'decisions'
	| 'speakers'
	| 'tasks'
	| 'schedule'
	| 'messages'
	| 'templates'
	| 'forms'
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
	/** Short human rendering of the governing deadline, e.g. 'due Aug 28'. */
	deadlineLabel?: string;
	/** Machine twin of deadlineLabel for the future real pace computation. */
	deadlineIso?: string;
}

export interface DeadlineItem {
	label: string;
	absolute: string;
	relative: string;
	tone: 'ok' | 'warning' | 'blocked';
}

export interface ActivityItem {
	id: string;
	actor: 'agent' | 'person' | 'you';
	name: string;
	text: string;
	time: string;
}

export type TrayKind =
	| 'late'
	| 'discarded'
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
	tone?: 'attention';
}

export interface NavCounts {
	submissions?: string;
	review?: string;
	decisions?: { value: string; tone: 'warning' | 'danger' };
	speakers?: string;
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
	stats: StatItem[];
	attention: AttentionItem[];
	pipeline: PipelineStage[];
	deadlines: DeadlineItem[];
	activity: ActivityItem[];
	trays: TrayCount[];
}

// ---------------------------------------------------------------------------
// Submissions and triage

export type TrayKey = 'inbox' | 'set-aside' | 'late' | 'discarded';

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

export interface Submission {
	id: string;
	title: string;
	abstract: string;
	speakers: SubmissionSpeaker[];
	trackId: string;
	formatId: string;
	submittedAt: string;
	source: 'cfp' | 'direct_entry' | 'import';
	tray: TrayKey;
	setAsideBy?: string;
	decision: DecisionState;
	/** True when the current decision has been communicated to the submitter. */
	notified: boolean;
	signals: SignalChip[];
	/** Attached materials (slides, recordings, supporting links). */
	resources?: SubmissionResource[];
	reviewAverage?: number;
	reviewCount: number;
	appealCount?: number;
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
}

/**
 * One amendment of an already-committed review. The prior score and comment are
 * kept rather than overwritten: after peer content unlocks, changing your mind
 * is legitimate, but silently rewriting what you committed before you saw the
 * peers would erase the only evidence that the change was post-unlock.
 */
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
	submission: Submission;
	standing: ScoreStanding | null;
}

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
export interface SpeakerSession {
	id: string;
	title: string;
}

export interface SpeakerRow {
	id: string;
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

export interface SessionItem {
	id: string;
	title: string;
	speakerNames: string[];
	trackId: string;
	formatId: string;
	durationMin: number;
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

export type OutboxState = 'draft' | 'scheduled' | 'sending' | 'sent' | 'held';

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
	sender: string;
	replyModel: string;
	irreversibleNote: string;
}

export interface OutboxMessage {
	id: string;
	subject: string;
	audience: string;
	audienceCount: number;
	state: OutboxState;
	sentAt?: string;
	/** Present while held: the reason and next remedy (e.g. provider not ready). */
	heldReason?: string;
	deliveredCount: number;
	bouncedCount: number;
	bounces: { email: string; reason: string }[];
	/** Present on drafts: the reviewable batch projection. */
	review?: MessageReview;
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
export type SurfaceKind = 'schedule' | 'application-form';

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
// Forms

export type FormTarget = 'general' | 'category' | 'slot' | 'evergreen';

export interface FormSummary {
	id: string;
	name: string;
	target: FormTarget;
	status: 'draft' | 'open' | 'closed';
	closesRelative?: string;
	version: number;
	submissionCount: number;
	fieldCount: number;
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
}

/** Structured outcome for operations that can be legitimately refused. */
export type MutationOutcome = { ok: true } | { ok: false; reason: string };
