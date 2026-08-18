import type {
	AccoladeDef,
	AccoladeKey,
	AccountEmailChange,
	AccountInfo,
	AnyTemplate,
	ComparableCard,
	DirectEntryInput,
	EditClassification,
	EmailReadiness,
	EmbedTarget,
	EventSettings,
	EventTheme,
	FieldContext,
	FieldKind,
	Format,
	FormComposition,
	FormFieldRow,
	FormSummary,
	FormTarget,
	Member,
	MergeFieldDef,
	MessageReview,
	MessageTemplate,
	ModelChoice,
	MutationOutcome,
	MyReviewItem,
	AttentionItem,
	AudienceOption,
	SessionItem,
	SessionSpeaker,
	SessionState,
	CommunicationAttentionItem,
	CommunicationMessage,
	CommunicationThread,
	CommunicationThreadEntry,
	RecipientRow,
	Placement,
	BreakBlock,
	PlacementConflict,
	RegistryField,
	Reviewer,
	ReviewerInviteLine,
	ReviewerRoster,
	ReviewerStatus,
	ReviewPlan,
	ReviewRoundSetup,
	ReviewRoundStatus,
	SubmissionOrigin,
	ReviewerProgress,
	ReviseProgress,
	Room,
	ScheduleState,
	ScopeRef,
	ScoreStanding,
	SlotSuggestion,
	PublicSpeakerCard,
	SpeakerCategory,
	SpeakerProfile,
	SpeakerRow,
	Submission,
	SubmissionArrivals,
	SubmissionPage,
	SubmissionQuery,
	SubmissionReview,
	SurfaceBlock,
	SurfaceField,
	SurfaceTemplate,
	SurfaceKind,
	TaskAssignment,
	TaskDef,
	TemplateSuggestion,
	Track,
	WorkspaceEventOption,
	TrayKey,
	VocabStatus,
	WorkspaceSummary
} from './types';
import { isSurfaceTemplate } from './types';
import { normalizeThemeRecipe } from '../theme/theme-contract';
import type {
	FormSeed,
	FormatSeed,
	ReviewerSeed,
	RoomSeed,
	SpeakerCategorySeed,
	TrackSeed,
	WorkspaceDataset
} from './sample/dataset';
import { formatUsage, removalBlockReason, roomUsage, trackUsage, type VocabUsageSource } from './vocab';
import {
	composeStepBackRefusal,
	coverageRows,
	isGeneralist,
	planLoad,
	scopeMatches,
	scopeRefCount
} from './reviewers';
import {
	persistCreatedEvent,
	resolveDataset,
	sampleLatencyMs,
	sampleResidency,
	sampleViewer,
	setScenarioCookie,
	workspaceEvents
} from './sample/registry';
import { summarizeArrivals } from '@jooevents/contracts';
import { formatDateRange } from './sample/dataset';
import {
	createSampleSenderIdentityStore,
	type SampleSenderIdentityUpdate
} from './sample/sender-identity';
import { setOperatorEntryAuthCookie } from './composition/entry-deps';
import { computeStanding, tintStep } from './standing';
import { accoladeCatalog, composeCapRefusal } from './accolades';
import { suggestPlacement, type PlacementSuggestion } from './placement';
import {
	asSurfaceField,
	contextFields,
	projectApplicationForm,
	sectionFieldIds,
	type ServeVocab
} from './fields';
import { compareMatches, matchFields, parseSearch } from './search';
import { submissionFields } from './searchable';
import { createListSource, RESIDENT_ROW_CEILING } from './residency';

/**
 * Workspace API, currently served from an in-memory sample dataset. Screens
 * call these functions exactly as they will call the real transport; mutations
 * update the working copy so a session behaves like a live product until the
 * page reloads. Aggregate counters reflect the loaded scenario; row-level
 * mutations update the rows and the counters they can derive, not every
 * narrative number.
 */

/**
 * The loaded scenario, with the two roster facts the API owns materialized.
 *
 * Public order is one of them: a dataset states the lineup by listing rows in
 * it, and load turns that into dense positions the reorder path can move. Doing
 * it here rather than in every dataset keeps a moved row from having to be
 * renumbered by hand in five files.
 */
type LoadedWorkspace = Omit<WorkspaceDataset, 'speakers' | 'speakerCategories' | 'summary'> & {
	speakers: SpeakerRow[];
	speakerCategories: SpeakerCategorySeed[];
	summary: WorkspaceSummary;
};

function loadWorkspace(): LoadedWorkspace {
	const seed = structuredClone(resolveDataset());
	return {
		...seed,
		// The arrival pulse is a measurement over the rows, so it is materialized
		// here rather than authored — and it is refreshed on every read, because
		// what counts as "today" moves while the tab stays open.
		summary: { ...seed.summary, arrivals: null },
		speakers: seed.speakers.map((row, index) => ({ ...row, position: row.position ?? index })),
		speakerCategories: seed.speakerCategories ?? []
	};
}

const db = loadWorkspace();
const embedAllowedOrigins = new Map<SurfaceKind, string[]>();
const removedReviewers = new Map<string, { readonly seed: ReviewerSeed; readonly index: number }>();

/** True while the app is running on sample data instead of a live backend. */
export const sampleMode = true;

/**
 * Which fiction is loaded. Every count on screen belongs to this scenario, so a
 * surface saying "sample data" can name the story rather than leaving the
 * numbers' truth value unstated.
 */
/** An email change in flight for the signed-in account; like every sample mutation it lives until reload. */
let pendingEmailChange: AccountEmailChange | null = null;

/**
 * Who is signed in, resolved from the viewer projection: the reviewer
 * projection is that reviewer's own member row (a reviewer is a workspace
 * member), the organizer projection is the first active member.
 */
function accountIdentity(): { name: string; email: string } {
	const viewer = sampleViewer();
	const member =
		(viewer.kind === 'reviewer'
			? db.members.find((entry) => entry.id === viewer.reviewerId)
			: undefined) ??
		db.members.find((entry) => (entry.status ?? 'active') === 'active') ??
		db.members[0];
	return member ? { name: member.name, email: member.email } : { name: 'Signed in', email: '' };
}

export const sampleScenario: { key: string; name: string; description: string } = {
	key: db.key,
	name: db.name,
	description: db.description
};

const latency = () => new Promise((resolve) => setTimeout(resolve, sampleLatencyMs()));

const overlaps = (aStart: number, aDur: number, bStart: number, bDur: number) =>
	aStart < bStart + bDur && bStart < aStart + aDur;

function sessionDuration(sessionId: string): number {
	return db.schedule.sessions.find((s) => s.id === sessionId)?.durationMin ?? db.schedule.slotMinutes;
}

function conflictsFor(sessionId: string, dayKey: string, roomId: string, startMin: number): PlacementConflict[] {
	const found: PlacementConflict[] = [];
	const duration = sessionDuration(sessionId);
	const session = db.schedule.sessions.find((s) => s.id === sessionId);
	for (const other of db.schedule.placements) {
		if (other.sessionId === sessionId || other.dayKey !== dayKey) continue;
		const otherSession = db.schedule.sessions.find((s) => s.id === other.sessionId);
		if (!otherSession) continue;
		if (!overlaps(startMin, duration, other.startMin, otherSession.durationMin)) continue;
		if (other.roomId === roomId) {
			const room = db.schedule.rooms.find((r) => r.id === roomId);
			found.push({ severity: 'block', reason: `Overlaps “${otherSession.title}” in ${room?.name ?? 'the same room'}` });
		}
		// Person conflicts key on the address, not the printed name: two people
		// who spell their names alike must never be conflated into one block.
		const shared = session?.speakers.find((speaker) =>
			otherSession.speakers.some((other) => other.email === speaker.email)
		);
		if (shared && other.roomId !== roomId) {
			found.push({ severity: 'block', reason: `${shared.name} is scheduled in another room at the same time` });
		}
	}
	// A break is a deliberate reservation, not physics: overlapping one warns —
	// visibly, on the card — but never blocks publication.
	for (const brk of db.schedule.breaks) {
		if (brk.dayKey !== dayKey || brk.roomId !== roomId) continue;
		if (!overlaps(startMin, duration, brk.startMin, brk.durationMin)) continue;
		const room = db.schedule.rooms.find((r) => r.id === roomId);
		found.push({ severity: 'warn', reason: `Runs into “${brk.label}” in ${room?.name ?? 'this room'}` });
	}
	return found;
}

function recomputeAllConflicts(): void {
	for (const placement of db.schedule.placements) {
		const computed = conflictsFor(placement.sessionId, placement.dayKey, placement.roomId, placement.startMin);
		// Seeded warnings (capacity notes a dataset authored) survive recompute;
		// break-overlap warnings are computed, so they are dropped here and
		// re-derived by conflictsFor — otherwise each recompute would stack a copy.
		const seeded = placement.conflicts.filter(
			(c) => c.severity === 'warn' && !c.reason.startsWith('Runs into “')
		);
		placement.conflicts = [...computed, ...seeded];
	}
}

function scheduleBlockCount(): number {
	return db.schedule.placements.filter((p) => p.conflicts.some((c) => c.severity === 'block')).length;
}

function syncScheduleCounters(): void {
	const blocks = scheduleBlockCount();
	if (blocks > 0) db.summary.navCounts.schedule = { value: String(blocks), tone: 'danger' };
	else delete db.summary.navCounts.schedule;
}

// ---------------------------------------------------------------------------
// The round-up: what still stands between the program and done. Every count
// here is a projection over sessions, placements, and rosters — computed,
// never authored, so a scenario cannot narrate a pending number its own rows
// do not back. The nav count above keeps its separate meaning (broken
// physics); remaining work never inflates a danger badge.

function placedSessionIds(): Set<string> {
	return new Set(db.schedule.placements.map((placement) => placement.sessionId));
}

/**
 * The four computed attention items, replaced in place by id on every
 * program mutation. Placeholder-first is legitimate working state, so the
 * roster gap stays `fyi`; the other two are ordinary `soon` work.
 */
function syncProgramRoundup(): void {
	const placed = placedSessionIds();
	const usesTracks = db.tracks.some((track) => track.status === 'active');
	const needsTrack = usesTracks
		? db.schedule.sessions.filter(
				(session) => session.state !== 'draft' && session.trackId === ''
			).length
		: 0;
	const unplaced = db.schedule.sessions.filter(
		(session) => session.state === 'programmed' && !placed.has(session.id)
	).length;
	const needsSpeakers = db.schedule.sessions.filter(
		(session) => session.state === 'programmed' && session.speakers.length === 0
	).length;
	const heldSlots = db.schedule.sessions.filter(
		(session) => session.state === 'collecting' && placed.has(session.id)
	).length;

	const computed: AttentionItem[] = [];
	if (needsTrack > 0) {
		computed.push({
			id: 'program-needs-track',
			severity: 'soon',
			area: 'schedule',
			title: `${needsTrack} program session${needsTrack === 1 ? '' : 's'} need${needsTrack === 1 ? 's' : ''} a track`,
			detail: 'This event sorts its programme into tracks, and these sessions have none.',
			action: 'Choose tracks',
			href: '/app/schedule?tray=needs-track'
		});
	}
	if (unplaced > 0) {
		computed.push({
			id: 'program-unplaced',
			severity: 'soon',
			area: 'schedule',
			title: `${unplaced} session${unplaced === 1 ? '' : 's'} await${unplaced === 1 ? 's' : ''} placement`,
			detail: 'Accepted or added to the program, not yet on the grid.',
			action: 'Open the program pool',
			href: '/app/schedule?tray=unplaced'
		});
	}
	if (needsSpeakers > 0) {
		computed.push({
			id: 'program-needs-speakers',
			severity: 'fyi',
			area: 'schedule',
			title: `${needsSpeakers} program session${needsSpeakers === 1 ? '' : 's'} need${needsSpeakers === 1 ? 's' : ''} speakers`,
			detail: 'Placeholders are fine — attribute people when they are known.',
			action: 'Review sessions',
			href: '/app/schedule?tray=needs-speakers'
		});
	}
	if (heldSlots > 0) {
		computed.push({
			id: 'program-undecided-in-place',
			severity: 'soon',
			area: 'schedule',
			/* "Held slot" and "collecting session" are both words this product
			   invented, and neither is defined anywhere a first-time organizer
			   would meet them. What is actually true is plain: a session is
			   sitting on the grid holding time for proposals nobody has answered. */
			title: `${heldSlots} session${heldSlots === 1 ? '' : 's'} on the grid ${heldSlots === 1 ? 'is' : 'are'} still collecting proposals`,
			detail: 'Each one holds its time on the schedule until you decide what goes in it.',
			action: 'Review held slots',
			href: '/app/schedule?tray=undecided-in-place'
		});
	}

	const authored = db.summary.attention.filter(
		(item) =>
			item.id !== 'program-needs-track' &&
			item.id !== 'program-unplaced' &&
			item.id !== 'program-needs-speakers' &&
			item.id !== 'program-undecided-in-place'
	);
	db.summary.attention = [...authored, ...computed];
}

// Scenario attention lists are authored; the round-up items are not. They are
// derived once the scenario is loaded and after every mutation that can move
// them, so every dataset gets truthful tray items without narrating counts.
syncProgramRoundup();

// ---------------------------------------------------------------------------
// The arrival pulse. What is new is a fact about the rows, so it is measured
// from them on every read rather than authored: a scenario cannot narrate a
// delta its own submissions do not back, and a delta written into a file is
// wrong the day after it is written.
//
// Spam proposals are excluded from every figure here. They are kept and
// recoverable, but they are not part of what this event has to work through,
// and counting them would overstate the load on every surface that reads this.

/** The operator's earlier entries to the workspace, newest first. */
function visitHistory(): string[] {
	if (db.visitHistory && db.visitHistory.length > 0) return db.visitHistory;
	return db.previousVisit ? [db.previousVisit] : [];
}

function submissionArrivals(): SubmissionArrivals | null {
	const timezone = db.summary.event?.timezone;
	if (!timezone) return null;
	const held = db.submissions.filter((row) => row.tray !== 'spam');
	const pulse = summarizeArrivals({
		arrivals: held.map((row) => row.submittedAt),
		visits: visitHistory(),
		timezone,
		now: Date.now()
	});
	if (pulse === null) return null;
	return {
		pulse,
		held: {
			inbox: held.filter((row) => row.tray === 'inbox').length,
			setAside: held.filter((row) => row.tray === 'set-aside').length,
			late: held.filter((row) => row.tray === 'late').length
		},
		spam: db.submissions.length - held.length
	};
}

/**
 * The summary with its pulse brought up to date, as the same object every time.
 * Recomputed rather than cached because the window itself moves — a workspace
 * left open across midnight would otherwise keep counting yesterday as today —
 * and returned by identity because callers compare snapshots.
 */
function refreshedSummary(): WorkspaceSummary {
	db.summary.arrivals = submissionArrivals();
	return db.summary;
}

/** Every program mutation funnels through here so no caller can forget a sync. */
function programChanged(): void {
	recomputeAllConflicts();
	syncScheduleCounters();
	syncProgramRoundup();
}

/**
 * A person joins the operational roster the moment a session names them:
 * graduation seeds the engagement as `invited` (04 §7's lifecycle), and an
 * existing row simply gains the session link. Returns the roster row.
 */
function upsertRosterRow(speaker: SessionSpeaker, session: SessionItem): SpeakerRow {
	let row = db.speakers.find((entry) => entry.email === speaker.email);
	if (!row) {
		row = {
			id: mintId('spk'),
			name: speaker.name,
			email: speaker.email,
			state: 'invited',
			sessions: [],
			tasksDone: 0,
			tasksTotal: 0,
			overdueTasks: 0,
			publiclyVisible: false,
			contentApproved: false,
			position: db.speakers.length
		};
		db.speakers.push(row);
	}
	if (!row.sessions.some((entry) => entry.id === session.id)) {
		row.sessions = [...row.sessions, { id: session.id, title: session.title }];
	}
	return row;
}

function dropSessionFromRosterRow(email: string, sessionId: string): void {
	const row = db.speakers.find((entry) => entry.email === email);
	if (!row) return;
	row.sessions = row.sessions.filter((entry) => entry.id !== sessionId);
}

/**
 * What acceptance did to the program, kept so a decision reversal can
 * compensate rather than guess: a spawned session unspawns while nothing else
 * references it; an attach restores the roster it appended to (16 §4).
 */
type GraduationRecord =
	| { kind: 'spawn'; sessionId: string }
	| { kind: 'attach'; sessionId: string; addedEmails: string[]; wasState: SessionState };

const graduations = new Map<string, GraduationRecord>();

function formatDefaultDuration(formatId: string): number {
	return (
		db.formats.find((format) => format.id === formatId)?.defaultDurationMin ??
		db.schedule.slotMinutes
	);
}

/** Roster merge under append policy: never clobber, never duplicate a person. */
function mergeSpeakers(session: SessionItem, incoming: readonly SessionSpeaker[]): string[] {
	const added: string[] = [];
	for (const speaker of incoming) {
		if (session.speakers.some((existing) => existing.email === speaker.email)) continue;
		session.speakers = [...session.speakers, { name: speaker.name, email: speaker.email }];
		added.push(speaker.email);
	}
	return added;
}

/**
 * Acceptance routing (16 §4): a submission that names a still-collecting
 * session attaches to it — merging proposers into the roster and graduating a
 * held slot in place — and every other acceptance spawns a session into the
 * pool. Both leave a compensation record.
 */
function graduateSubmission(submission: Submission): void {
	if (graduations.has(submission.id)) return;
	const target = submission.targetSessionId
		? db.schedule.sessions.find((session) => session.id === submission.targetSessionId)
		: undefined;
	if (target && target.state !== 'programmed') {
		const wasState = target.state;
		const added = mergeSpeakers(target, submission.speakers);
		target.originSubmissionIds = [...(target.originSubmissionIds ?? []), submission.id];
		target.state = 'programmed';
		for (const speaker of submission.speakers) upsertRosterRow(speaker, target);
		graduations.set(submission.id, {
			kind: 'attach',
			sessionId: target.id,
			addedEmails: added,
			wasState
		});
		return;
	}
	// Spawn — also the structured exit when a named target has since been
	// programmed or removed: the acceptance still lands somewhere visible.
	const session: SessionItem = {
		id: mintId('ses'),
		title: submission.title,
		speakers: submission.speakers.map((speaker) => ({ name: speaker.name, email: speaker.email })),
		trackId: submission.trackId,
		formatId: submission.formatId,
		durationMin: formatDefaultDuration(submission.formatId),
		state: 'programmed',
		originSubmissionIds: [submission.id]
	};
	db.schedule.sessions = [...db.schedule.sessions, session];
	for (const speaker of submission.speakers) upsertRosterRow(speaker, session);
	graduations.set(submission.id, { kind: 'spawn', sessionId: session.id });
}

/**
 * Compensation for a reversed acceptance. A spawned session that gained
 * nothing since (no slot, no extra origin, roster as seeded) disappears; one
 * that did stays standing — Q15's widening — with the submission unlinked. An
 * attach restores roster-before and the collecting state the slot had.
 */
function ungraduateSubmission(submission: Submission): void {
	const record = graduations.get(submission.id);
	if (!record) return;
	graduations.delete(submission.id);
	const session = db.schedule.sessions.find((entry) => entry.id === record.sessionId);
	if (!session) return;
	if (record.kind === 'spawn') {
		const placed = placedSessionIds().has(session.id);
		const untouched =
			(session.originSubmissionIds ?? []).length === 1 &&
			session.speakers.length === submission.speakers.length;
		if (!placed && untouched) {
			for (const speaker of session.speakers) dropSessionFromRosterRow(speaker.email, session.id);
			db.schedule.sessions = db.schedule.sessions.filter((entry) => entry.id !== session.id);
		} else {
			session.originSubmissionIds = (session.originSubmissionIds ?? []).filter(
				(id) => id !== submission.id
			);
		}
		return;
	}
	session.speakers = session.speakers.filter(
		(speaker) => !record.addedEmails.includes(speaker.email)
	);
	for (const email of record.addedEmails) dropSessionFromRosterRow(email, session.id);
	session.originSubmissionIds = (session.originSubmissionIds ?? []).filter(
		(id) => id !== submission.id
	);
	if ((session.originSubmissionIds ?? []).length === 0) session.state = record.wasState;
}

/**
 * Which rows a submission query selects, and in what order.
 *
 * One function, called by both sides of the residency seam: the server path
 * runs it over the whole table, the resident path runs it over a held scope.
 * They agree because they are the same code — the alternative, two
 * implementations kept in step by a test, is how "it filters differently in
 * production" happens.
 */
function selectSubmissions(rows: readonly Submission[], query: SubmissionQuery): SubmissionPage {
	// Scope narrows first, so `scanned` counts the records the search was
	// actually asked about rather than the whole table.
	const scoped = rows.filter((submission) => {
		if (query.tray && submission.tray !== query.tray) return false;
		if (query.trackId && submission.trackId !== query.trackId) return false;
		if (query.formatId && submission.formatId !== query.formatId) return false;
		return true;
	});

	const parsed = parseSearch(query.search ?? '');
	if (parsed.terms.length === 0) {
		return { rows: scoped, trayTotals: db.submissionTrayTotals };
	}

	// Ranked, then tie-broken on id: the same query must return the same order
	// every time, or a keystroke reshuffles rows under the reader.
	const matched = scoped
		.map((submission) => ({ submission, match: matchFields(submissionFields(submission), parsed) }))
		.filter((entry) => entry.match !== null)
		.sort((a, b) =>
			compareMatches(
				{ match: a.match!, key: a.submission.id },
				{ match: b.match!, key: b.submission.id }
			)
		)
		.map((entry) => entry.submission);

	return {
		rows: matched,
		trayTotals: db.submissionTrayTotals,
		search: { query: query.search ?? '', matched: matched.length, scanned: scoped.length }
	};
}

/** Bumped by every mutation, so a held scope can tell it has gone stale. */
let submissionsVersion = 0;

/**
 * Submissions behind the residency seam.
 *
 * The scope is the event rather than the tray: trays are disjoint partitions of
 * the same small population, so holding all of them costs almost nothing extra
 * and makes switching between them local too. Track, format, and search are
 * filters within the scope, never part of its key.
 *
 * In sample mode both ports read the same in-memory tables, which is exactly
 * the point — it makes the two modes comparable on identical data. When the
 * real transport lands this composition moves client-side in front of HTTP, and
 * the ports become one GET for the scope and one GET per query.
 */
const submissionList = createListSource<Submission, SubmissionQuery, SubmissionPage>(
	{
		scopeKey: () => `event:${db.key}`,
		async loadScope() {
			await latency();
			// Copied rather than shared, so a held scope behaves like one that
			// crossed a network: mutations reach it through invalidation, not by
			// aliasing the store.
			return {
				rows: db.submissions.map((submission) => ({ ...submission })),
				complete: db.submissions.length <= RESIDENT_ROW_CEILING,
				version: `${db.key}:${submissionsVersion}`
			};
		},
		async queryServer(query) {
			await latency();
			return selectSubmissions(db.submissions, query);
		},
		applyLocally: selectSubmissions
	},
	{ residency: sampleResidency }
);

/** Every submission mutation ends here, so no caller can forget to invalidate. */
function submissionsChanged(): void {
	submissionsVersion += 1;
	submissionList.invalidate();
}

function moveTrayCount(from: Submission['tray'], to: Submission['tray']): void {
	db.submissionTrayTotals[from] = Math.max(0, db.submissionTrayTotals[from] - 1);
	db.submissionTrayTotals[to] += 1;
	// Every tray mutation moves a count, so invalidating here covers all five of
	// them at once rather than asking five call sites to remember. The two
	// decision mutations do not move a tray and say so themselves.
	submissionsChanged();
}

let mintSequence = 0;

/** Session-unique ids for records minted by sample-mode mutations. */
function mintId(prefix: string): string {
	mintSequence += 1;
	return `${prefix}-local-${mintSequence}`;
}

/**
 * The records vocabulary usage is counted from. Lists and removal guards read
 * the same source through the same predicates, so a count on screen and the
 * check behind a removal can never disagree.
 */
function usageSource(): VocabUsageSource {
	return {
		submissions: db.submissions,
		sessions: db.schedule.sessions,
		placements: db.schedule.placements
	};
}

function asTrack(seed: TrackSeed): Track {
	return { ...seed, status: seed.status ?? 'active', usage: trackUsage(seed.id, usageSource()) };
}

function asFormat(seed: FormatSeed): Format {
	return { ...seed, status: seed.status ?? 'active', usage: formatUsage(seed.id, usageSource()) };
}

function asRoom(seed: RoomSeed): Room {
	return { ...seed, status: seed.status ?? 'active', usage: roomUsage(seed.id, usageSource()) };
}

function asSpeakerCategory(seed: SpeakerCategorySeed): SpeakerCategory {
	return {
		...seed,
		status: seed.status ?? 'active',
		speakerCount: db.speakers.filter((row) => row.categoryId === seed.id).length
	};
}

/** The roster in public order — the one sequence every public presentation reads. */
function orderedRoster(): SpeakerRow[] {
	return [...db.speakers].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/**
 * The roster as the public sees it: ordered, narrowed to who may be shown, and
 * carrying only publishable facts.
 *
 * A person marked public whose content is not approved renders as themselves
 * without a biography — the roster's own "shows as TBA" state — rather than
 * being dropped. Dropping them would make the lineup's length depend on how far
 * along the organizer's admin is, which is exactly the surprise a published
 * page must not spring.
 */
function publicRoster(): PublicSpeakerCard[] {
	return orderedRoster()
		.filter((row) => row.publiclyVisible)
		.map((row) => {
			const profile = profileFor(row.email);
			const provisional = !row.contentApproved;
			const card: PublicSpeakerCard = {
				id: row.id,
				name: row.name,
				links: provisional ? [] : (profile?.links ?? []),
				sessions: row.sessions.map((session) => ({ ...session })),
				provisional
			};
			if (!provisional && profile?.headline) card.headline = profile.headline;
			if (!provisional && profile?.location) card.location = profile.location;
			if (row.categoryId) card.categoryId = row.categoryId;
			return card;
		});
}

/**
 * Positions after moving one entry to an index in the public order. Returns the
 * whole renumbered sequence rather than patching one row, because a move is a
 * statement about the sequence: leaving gaps or ties would make the next move's
 * arithmetic depend on how many moves came before it.
 */
function movedOrder(ids: string[], id: string, toIndex: number): string[] {
	const from = ids.indexOf(id);
	if (from === -1) return ids;
	const next = [...ids];
	next.splice(from, 1);
	next.splice(Math.min(Math.max(toIndex, 0), next.length), 0, id);
	return next;
}

/** Retire and restore only move the lifecycle mark; nothing else is touched. */
function setStatus(seed: { status?: VocabStatus } | undefined, status: VocabStatus): MutationOutcome {
	if (seed) seed.status = status;
	return { ok: true };
}

/**
 * One roster entry: the seeded identity joined to load numbers summed across
 * the scenario's review plans — server-counted, never authored twice.
 */
function asReviewer(seed: ReviewerSeed): Reviewer {
	return { ...seed, scope: seed.scope.map((ref) => ({ ...ref })), ...planLoad(seed.id, db.reviewPlans) };
}

/**
 * The first scope ref that names nothing, or undefined while every ref
 * resolves. Scope is grounded in records that exist — a ref to nothing is
 * refused, never stored. Retired entries still resolve: an existing scope
 * keeps rendering them, and offering only active entries for new scoping is
 * the caller's filter, the same split the vocabulary lists use.
 */
function unresolvedScopeRef(scope: readonly ScopeRef[]): ScopeRef | undefined {
	return scope.find((ref) => {
		if (ref.kind === 'track') return !db.tracks.some((track) => track.id === ref.id);
		if (ref.kind === 'format') return !db.formats.some((format) => format.id === ref.id);
		return !db.schedule.sessions.some((session) => session.id === ref.id);
	});
}

function submissionTitle(submissionId: string): string {
	return db.submissions.find((row) => row.id === submissionId)?.title ?? submissionId;
}

/**
 * The round in play: rounds append, so the newest plan is the one reviewers
 * are working and the one a commit counts against. Earlier rounds stay as
 * closed history.
 */
function activePlan(): ReviewPlan | undefined {
	return db.reviewPlans[db.reviewPlans.length - 1];
}

/**
 * The workspace summary as it stood before a round opened, kept so discarding
 * the round restores every counter, lane, and attention item exactly.
 */
const roundSummaryPrior = new Map<string, WorkspaceSummary>();

/** 'today', 'tomorrow', or 'in N days' for a same-or-future ISO date. */
function relativeDays(iso: string): string {
	const target = new Date(`${iso}T12:00:00`);
	const today = new Date();
	today.setHours(12, 0, 0, 0);
	const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
	if (days <= 0) return 'today';
	if (days === 1) return 'tomorrow';
	return `in ${days} days`;
}

/**
 * One submission's standing inside its own track, or null when the claim
 * cannot be made: no average yet, or no scored population to rank inside.
 * Shared by the single and batch reads so both answer identically.
 */
function standingFor(submissionId: string): ScoreStanding | null {
	const submission = db.submissions.find((row) => row.id === submissionId);
	if (!submission || submission.reviewAverage === undefined) return null;
	const population = db.reviewDistributions?.[submission.trackId];
	if (!population || population.length === 0) return null;
	// The population includes this submission; the comparison is against the
	// others, so exactly one copy of its own average comes out.
	const others = [...population];
	const own = others.indexOf(submission.reviewAverage);
	if (own >= 0) others.splice(own, 1);
	const track = db.tracks.find((entry) => entry.id === submission.trackId);
	return computeStanding(
		submission.reviewAverage,
		activePlan()?.scaleMax ?? 5,
		others,
		submission.reviewCount,
		{ label: track?.name ?? 'Track', trackId: submission.trackId }
	);
}

/** A small stable seed from an id, so derived sample facts survive re-reads. */
function hashSeed(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(hash);
}

/**
 * `total` split into `n` scores on [1, scaleMax], summing exactly. The seed
 * spreads the split so five reviews of one submission are not five copies of
 * its rounded average, without moving the sum the average is derived from.
 */
function splitScores(total: number, n: number, scaleMax: number, seed: number): number[] {
	if (n <= 0) return [];
	const feasible = Math.min(Math.max(total, n), n * scaleMax);
	const base = Math.floor(feasible / n);
	const extra = feasible - base * n;
	const scores = Array.from({ length: n }, (_, index) => base + (index < extra ? 1 : 0));
	for (let index = 0; index + 1 < n; index += 2) {
		if (((seed >> index) & 3) === 0 && scores[index] < scaleMax && scores[index + 1] > 1) {
			scores[index] += 1;
			scores[index + 1] -= 1;
		}
	}
	return scores;
}

/** Reviewer voices per absolute score band, lowest to highest. */
const REVIEW_COMMENT_BANDS: string[][] = [
	[
		'Does not fit this program — the abstract reads as a product pitch, not a talk.',
		'I could not find the talk in this; what would the audience walk away with?'
	],
	[
		'A fixable idea, but it cannot compete this round without a concrete case study.',
		'The topic is fine; the treatment stays too shallow for our audience.'
	],
	[
		'Solid and safe. Worth a slot if the track has room; I would not fight for it.',
		'Competent coverage of known ground — fine as a program filler.'
	],
	[
		'Strong submission; I would advocate for it in a tie.',
		'Clear structure and a real production story. This one earns its slot.'
	],
	[
		'Must-have — I would trade another accepted talk to keep this.',
		'The standout of my batch. Do not lose this speaker.'
	]
];

const REVIEW_COMMITTED_AT = ['8 days ago', '6 days ago', '5 days ago', '3 days ago', '2 days ago', 'yesterday'];

/**
 * The committed reviews behind one submission's aggregate. The dataset states
 * only the count and the average — the same way it states reviewer load — so
 * the individual scores are derived from that aggregate here, deterministically
 * per submission, and always sum back to it: the list and the cell above it
 * tell one story. The caller's own committed review keeps its real score and
 * comment from the queue; every other identity is the plan-local label a
 * review-read surface is allowed to see.
 */
function reviewsFor(submission: Submission): SubmissionReview[] {
	const count = submission.reviewCount;
	if (count === 0) return [];
	const scaleMax = activePlan()?.scaleMax ?? 5;
	const seed = hashSeed(submission.id);
	const own = db.myQueue.find((item) => item.submissionId === submission.id && item.committed);
	const reviews: SubmissionReview[] = [];

	if (own && own.myScore !== undefined) {
		const mine: SubmissionReview = {
			reviewer: 'You',
			mine: true,
			score: own.myScore,
			committedAt: REVIEW_COMMITTED_AT[seed % REVIEW_COMMITTED_AT.length]
		};
		if (own.myComment) mine.comment = own.myComment;
		const lastRevision = own.revisions?.[own.revisions.length - 1];
		if (lastRevision?.postUnlock && lastRevision.score !== own.myScore) {
			mine.amendedFrom = lastRevision.score;
		}
		reviews.push(mine);
	}

	const othersCount = count - reviews.length;
	const ownScore = reviews[0]?.score ?? 0;
	const scores =
		submission.reviewAverage === undefined
			? Array.from({ length: othersCount }, (_, index) =>
					Math.min(scaleMax, Math.max(1, Math.round(scaleMax / 2) + ((seed >> index) & 1)))
				)
			: splitScores(Math.round(submission.reviewAverage * count) - ownScore, othersCount, scaleMax, seed);

	const roster = activePlan()?.reviewers ?? [];
	scores.forEach((score, index) => {
		const rosterIndex = roster.length > 0 ? (seed + index) % Math.max(roster.length, othersCount) : index;
		const entry: SubmissionReview = {
			reviewer: `Reviewer ${String.fromCharCode(65 + (rosterIndex % 26))}`,
			score,
			committedAt: REVIEW_COMMITTED_AT[(seed + index * 3) % REVIEW_COMMITTED_AT.length]
		};
		// Roughly two of three reviews carry words; a bare score is an ordinary
		// committed review, and every surface has to read it as one.
		if ((seed + index) % 3 !== 0) {
			const band = REVIEW_COMMENT_BANDS[tintStep(score, scaleMax)];
			entry.comment = band[(seed + index) % band.length];
		}
		// One post-unlock amendment now and then, so the delta flag a chair reads
		// as calibration evidence is exercised by the sample.
		if ((seed + index) % 7 === 0 && score > 1) entry.amendedFrom = score - 1;
		reviews.push(entry);
	});

	return reviews.sort((a, b) => b.score - a.score);
}

/**
 * One submitter's profile, joined to what they are in this event.
 *
 * The authored part is only what the person says about themselves; the counted
 * part — how many submissions carry this address, and the roster entry and its
 * sessions when one shares it — is read here so no surface has to derive it.
 * Addresses are compared case-insensitively because a mailbox is, but the
 * profile answers with the address as authored.
 */
function profileFor(email: string): SpeakerProfile | null {
	const key = email.trim().toLowerCase();
	const seed = db.speakerProfiles?.find((entry) => entry.email.trim().toLowerCase() === key);
	if (!seed) return null;
	const submissions = db.submissions.filter((submission) =>
		submission.speakers.some((speaker) => speaker.email.trim().toLowerCase() === key)
	);
	const roster = db.speakers.find((speaker) => speaker.email.trim().toLowerCase() === key);
	const submitted = submissions
		.flatMap((submission) => submission.speakers)
		.find((speaker) => speaker.email.trim().toLowerCase() === key);
	const profile: SpeakerProfile = {
		name: roster?.name ?? submitted?.name ?? seed.email,
		email: seed.email,
		headline: seed.headline,
		submissionCount: submissions.length
	};
	if (seed.location) profile.location = seed.location;
	if (seed.links && seed.links.length > 0) profile.links = seed.links;
	if (roster) {
		profile.speakerId = roster.id;
		if (roster.sessions.length > 0) profile.sessions = roster.sessions;
	}
	return profile;
}

function communicationEntry(
	subject: string,
	audience: string,
	audienceCount: number,
	state: CommunicationMessage['state'],
	provenance: Pick<CommunicationMessage, 'purpose' | 'cause' | 'actor'> &
		Partial<Pick<CommunicationMessage, 'causeHref' | 'templateId' | 'review'>>
): CommunicationMessage {
	const message: CommunicationMessage = {
		id: mintId('msg'),
		subject,
		audience,
		audienceCount,
		state,
		sentAt: state === 'sent' ? 'Just now' : undefined,
		deliveredCount: state === 'sent' ? audienceCount : 0,
		bouncedCount: 0,
		bounces: [],
		...provenance
	};
	db.communications.unshift(message);
	return message;
}

/**
 * A delivered send lands in each recipient's own thread. Matching is by the
 * roster's email — the sample stand-in for the real person/engagement relation
 * the thread projection carries.
 */
function appendThreadEntries(message: CommunicationMessage, emails: string[]): void {
	for (const email of emails) {
		const speaker = db.speakers.find((row) => row.email === email);
		if (!speaker) continue;
		const entries = db.threads[speaker.id] ?? (db.threads[speaker.id] = []);
		entries.unshift({
			id: mintId('thr'),
			messageId: message.id,
			at: 'Just now',
			purpose: message.purpose,
			subject: message.subject,
			outcome: 'sent',
			actor: message.actor
		});
	}
}

/**
 * The workspace's outbound sender presentation. Settings edits it and message
 * previews quote it, so both read the one store rather than composing a From
 * line of their own.
 */
const senderIdentityStore = createSampleSenderIdentityStore({
	installationDisplayName: () => db.summary.event?.name ?? 'JooEvents'
});

function senderIdentity(): string {
	return senderIdentityStore.line();
}

function audienceOptions(personId?: string): AudienceOption[] {
	const options: AudienceOption[] = [];
	if (personId) {
		const person = db.speakers.find((row) => row.id === personId);
		if (person) {
			options.push({ id: `person-${person.id}`, label: `Only ${person.name}`, count: 1, personId: person.id });
		}
	}
	const confirmed = db.speakers.filter((row) => row.state === 'confirmed').length;
	options.push({ id: 'confirmed-speakers', label: 'Confirmed speakers', count: confirmed });
	const unnotified = db.submissions
		.filter((submission) => submission.decision === 'accepted' && !submission.notified)
		.flatMap((submission) => submission.speakers).length;
	options.push({ id: 'accepted-unnotified', label: 'Accepted · results not sent', count: unnotified });
	options.push({
		id: 'reviewers',
		label: 'Reviewers',
		count: db.reviewers.filter((row) => row.status === 'active').length
	});
	return options;
}

/** The subject each person reads: their name resolved, other tokens from declared samples. */
function resolvedSubject(subject: string, template: MessageTemplate | undefined, name: string): string {
	if (!template) return subject;
	return template.subject.replace(/\{\{([^}]+)\}\}/g, (token, key: string) => {
		if (key === 'speaker.name') return name;
		return template.mergeFields.find((field) => field.key === key)?.sample ?? token;
	});
}

/** Resolves an audience option into reviewable recipient rows from current records. */
function audienceRecipients(
	audience: AudienceOption,
	template: MessageTemplate | undefined,
	subject: string
): RecipientRow[] {
	const row = (name: string, email: string): RecipientRow => ({
		name,
		email,
		state: 'included',
		mergeSample: resolvedSubject(subject, template, name)
	});
	if (audience.personId) {
		const person = db.speakers.find((entry) => entry.id === audience.personId);
		return person ? [row(person.name, person.email)] : [];
	}
	if (audience.id === 'confirmed-speakers') {
		return db.speakers.filter((entry) => entry.state === 'confirmed').map((entry) => row(entry.name, entry.email));
	}
	if (audience.id === 'reviewers') {
		return db.reviewers
			.filter((entry) => entry.status === 'active')
			.map((entry) => row(entry.name, entry.email));
	}
	if (audience.id === 'accepted-unnotified') {
		return db.submissions
			.filter((submission) => submission.decision === 'accepted' && !submission.notified)
			.flatMap((submission) => {
				// The submission is the recipient's own context: its title and
				// format resolve their copy's merge fields.
				const format = db.formats.find((entry) => entry.id === submission.formatId);
				return submission.speakers.map((speaker) => ({
					...row(speaker.name, speaker.email),
					mergeValues: {
						'submission.title': submission.title,
						...(format ? { 'submission.format': format.name } : {})
					}
				}));
			});
	}
	return [];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How a template edit instruction is routed, as data. The model *names* here
 * are display data the server reports beside its choice; no identifier of any
 * model lives in feature code.
 */
const reviseProfiles = {
	quick: { label: 'Quick touch', model: 'Claude Haiku' },
	comprehensive: { label: 'Full pass', model: 'Claude Sonnet' }
} as const;

/**
 * The models an organizer can pin an edit to, plus the routing default —
 * always first, always recommended. Mock server data shaped like the real
 * profile listing: every id and label here is display data the api serves;
 * feature code never imports them as constants.
 */
const templateModelChoices: ModelChoice[] = [
	{ id: 'auto', label: 'Auto', sub: 'Routes each request to the lightest model that can do it' },
	{ id: 'gpt-5-6-sol', label: 'GPT 5.6 Sol', sub: 'Strong all-round drafting at a steady pace' },
	{ id: 'sonnet-5', label: 'Sonnet 5', sub: 'Quick and precise on focused wording changes' },
	{ id: 'opus-5', label: 'Opus 5', sub: 'The deepest rewrites — takes its time' }
];

/**
 * How the mock stream paces per pinned model: a token budget factor over the
 * routed default and a per-tick delay. Opus drafts longer and slower; the
 * others sit near the default. Deterministic display data only.
 */
const modelPacing: Record<string, { tokenFactor: number; tickMs: number }> = {
	'gpt-5-6-sol': { tokenFactor: 1.15, tickMs: 110 },
	'sonnet-5': { tokenFactor: 1, tickMs: 100 },
	'opus-5': { tokenFactor: 1.5, tickMs: 150 }
};

const autoPacing = { tokenFactor: 1, tickMs: 120 };

/**
 * Wording that implies changing structure, not just words — of a message's
 * blocks or of a public surface's sections, questions, and grouping.
 */
const structuralPattern =
	/restructur|rewrit|reorder|remove|rework|section|question|\bfield\b|\bgroup(?:ing|ed|s)?\b/i;

function classifyInstruction(instruction: string, modelId?: string): EditClassification {
	const words = instruction.trim().split(/\s+/).filter(Boolean).length;
	const scope = structuralPattern.test(instruction) || words > 12 ? 'comprehensive' : 'quick';
	// A pinned model bypasses routing: the scope heuristic still sizes the run,
	// but the label echoes the pick instead of naming a routed profile.
	const pinned =
		modelId && modelId !== 'auto'
			? templateModelChoices.find((choice) => choice.id === modelId)
			: undefined;
	if (pinned) {
		return { scope, profileLabel: pinned.label, reason: 'Your pick', chosenBy: 'you' };
	}
	const profile = reviseProfiles[scope];
	return {
		scope,
		profileLabel: `${profile.label} · ${profile.model}`,
		reason: scope === 'quick' ? 'Wording-only change' : 'Structural change across blocks',
		chosenBy: 'auto'
	};
}

/**
 * Starter instructions per template kind. Every string here is wording the
 * revise transformations genuinely understand, so pressing one always yields
 * a visible draft change — never dead example copy.
 */
function suggestionsFor(template: AnyTemplate): TemplateSuggestion[] {
	if (!isSurfaceTemplate(template)) {
		return [{ text: 'Warmer tone' }, { text: 'Tighten it' }, { text: 'Add a deadline row' }];
	}
	if (template.kind === 'schedule') {
		return [{ text: 'Group by track' }, { text: 'More compact cards' }, { text: 'Hide rooms' }];
	}
	// The application form's useful changes are field work: each chip is a
	// registry operation the revise vocabulary executes through the placement
	// advisor and the one field registry.
	return [
		{ text: 'Add a travel question' },
		{ text: 'Ask about dietary needs' },
		{ text: 'Make headline optional' }
	];
}

function firstSentence(text: string): string {
	// A `{{merge.token}}` is one opaque unit: the dot inside its key never ends
	// a sentence, so trimming can never cut a token in half.
	const match = text.match(/^(?:\{\{[^}]*\}\}|[^.!?])*[.!?]/);
	return match ? match[0].trim() : text;
}

/**
 * A deterministic transformation of the current template, driven by the
 * instruction's keywords, plus a one-sentence account of what changed. Works
 * on a deep copy: a draft never touches the stored template.
 */
function reviseDraft(current: MessageTemplate, instruction: string): { draft: MessageTemplate; note: string } {
	const draft = structuredClone(current);
	const changes: string[] = [];

	if (/short|tight/i.test(instruction)) {
		for (const block of draft.blocks) {
			if (block.type === 'paragraph') block.text = firstSentence(block.text);
		}
		changes.push('trimmed each paragraph to its first sentence');
	}
	if (/warm|friendly/i.test(instruction)) {
		const opening = draft.blocks.find((block) => block.type === 'paragraph');
		if (opening) {
			// The greeting only names the recipient when the template already
			// declares the token; a draft never uses an undeclared merge field.
			const greeting = draft.mergeFields.some((field) => field.key === 'speaker.name')
				? 'It’s genuinely good to be writing to you, {{speaker.name}}.'
				: 'It’s genuinely good to be writing this one.';
			const rest = opening.text.slice(firstSentence(opening.text).length).trim();
			opening.text = rest ? `${greeting} ${rest}` : greeting;
			changes.push('rewrote the greeting to open more warmly');
		}
	}
	if (/deadline/i.test(instruction)) {
		if (!draft.mergeFields.some((field) => field.key === 'task.due')) {
			draft.mergeFields.push({ key: 'task.due', label: 'Due', sample: 'Sep 11, 23:59 EDT' });
		}
		const details = draft.blocks.find((block) => block.type === 'details');
		if (details) {
			if (!details.rows.some((row) => row.label === 'Due')) {
				details.rows.push({ label: 'Due', value: '{{task.due}}' });
			}
			changes.push('added the due date to the details block');
		} else {
			const at = draft.blocks.findIndex((block) => block.type === 'button');
			draft.blocks.splice(at === -1 ? draft.blocks.length : at, 0, {
				type: 'details',
				rows: [{ label: 'Due', value: '{{task.due}}' }]
			});
			changes.push('added a details block carrying the due date');
		}
	}
	if (/button|\bcta\b/i.test(instruction)) {
		const button = draft.blocks.find((block) => block.type === 'button');
		if (button) {
			button.label = 'Take the next step';
			changes.push('renamed the call-to-action button');
		}
	}
	if (changes.length === 0) {
		draft.subject = `Quick word — ${draft.subject.charAt(0).toLowerCase()}${draft.subject.slice(1)}`;
		const opening = draft.blocks.find((block) => block.type === 'paragraph');
		if (opening) opening.text = `Here’s where things stand. ${opening.text}`;
		changes.push('adjusted the subject line and opening phrasing');
	}

	const account = changes.join(', then ');
	return { draft, note: `${account.charAt(0).toUpperCase()}${account.slice(1)}.` };
}

/**
 * A revise instruction the field registry refuses rather than drafts — e.g.
 * removing the locked email question. The message is the same typed reason a
 * direct registry mutation returns, surfaced as the round's error.
 */
export class ReviseRefusal extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'ReviseRefusal';
	}
}

/** One field operation parsed from a revise instruction line. */
type FieldOp =
	| { op: 'ask'; topic: string }
	| { op: 'requirement'; label: string; required: boolean }
	| { op: 'remove'; label: string };

const opQuotes = /[“”"']/g;

/**
 * The form surface's field vocabulary: one operation per instruction line, so
 * a refine chain replays every round's field work in order.
 */
function parseFieldOps(instruction: string): FieldOp[] {
	const ops: FieldOp[] = [];
	for (const line of instruction.split('\n')) {
		const flip = line.match(/\bmake\s+(?:the\s+)?(.+?)\s+(optional|required)\b/i);
		if (flip) {
			ops.push({
				op: 'requirement',
				label: flip[1].replace(opQuotes, '').trim(),
				required: flip[2].toLowerCase() === 'required'
			});
			continue;
		}
		const remove = line.match(
			/\b(?:remove|delete|drop)\s+(?:the\s+)?(.+?)(?:\s+(?:question|field))?\s*[.!?]?\s*$/i
		);
		if (remove) {
			ops.push({ op: 'remove', label: remove[1].replace(opQuotes, '').trim() });
			continue;
		}
		const add =
			line.match(/\badd\s+(?:(?:a|an|another)\s+)?(.+?)\s+question\b/i) ??
			line.match(/\bask\s+(?:about|for)\s+(?:the\s+)?(.+?)\s*[.!?]?\s*$/i);
		if (add) ops.push({ op: 'ask', topic: add[1].replace(opQuotes, '').trim() });
	}
	return ops;
}

/** Loose label match: an instruction names a question by part of its label. */
function matchesLabel(label: string, needle: string): boolean {
	const a = label.toLowerCase();
	const b = needle.toLowerCase();
	return a === b || a.includes(b) || b.includes(a);
}

/** The label a minted question takes when no registry question matches the topic. */
function fieldLabelFor(topic: string): string {
	const known: Record<string, string> = { travel: 'Travel plans' };
	const label = known[topic.toLowerCase()] ?? topic;
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Executes parsed field operations against a copied working view of the
 * registry and reprojects the draft's pool and sections from it — the same
 * derivation every serve applies, so the After side previews exactly what
 * applying will make the form say. Real registry mutations happen only on
 * apply (`syncDraftFields`); until then everything here is simulated.
 */
function applyFieldOps(draft: SurfaceTemplate, ops: FieldOp[], changes: string[]): void {
	const working = orderedRegistry().map((field) => structuredClone(field));
	for (const op of ops) {
		if (op.op === 'ask') {
			const existing = working.find(
				(field) => !field.formScope && matchesLabel(field.label, op.topic)
			);
			if (existing) {
				if (!existing.collectAt.includes('apply')) {
					existing.collectAt = [...existing.collectAt, 'apply'];
					changes.push(`asked the existing “${existing.label}” question on the application`);
				}
				continue;
			}
			const label = fieldLabelFor(op.topic);
			const placement = suggestPlacement({ kind: 'text', label }, working);
			working.splice(placement.index, 0, {
				id: mintId('fld'),
				kind: 'text',
				label,
				required: {},
				collectAt: ['apply'],
				group: placement.group,
				position: placement.index
			});
			const reason = placement.reason.replace(/\.$/, '');
			changes.push(
				`added the “${label}” question (${reason.charAt(0).toLowerCase()}${reason.slice(1)})`
			);
		} else if (op.op === 'requirement') {
			const field = working.find(
				(entry) => entry.collectAt.includes('apply') && matchesLabel(entry.label, op.label)
			);
			if (!field || Boolean(field.required.apply) === op.required) continue;
			field.required = { ...field.required, apply: op.required };
			changes.push(`made “${field.label}” ${op.required ? 'required' : 'optional'} on the application`);
		} else {
			const field = working.find(
				(entry) =>
					entry.collectAt.includes('apply') && !entry.formScope && matchesLabel(entry.label, op.label)
			);
			if (!field) continue;
			if (field.locked) throw new ReviseRefusal(lockedFieldRefusal);
			field.collectAt = field.collectAt.filter((context) => context !== 'apply');
			changes.push(`removed the “${field.label}” question from the application`);
		}
	}
	if (changes.length === 0) return;
	working.forEach((field, index) => {
		field.position = index;
	});
	draft.fields = contextFields(working, 'apply').map((field) =>
		asSurfaceField(field, 'apply', serveVocab())
	);
	for (const block of draft.blocks) {
		if (block.type === 'form-section' && block.groups) {
			block.fieldRefs = sectionFieldIds(working, block.groups, 'apply');
		}
	}
}

/**
 * The surface counterpart of `reviseDraft`: deterministic keyword-driven
 * transformations of a public surface's blocks, on a deep copy, with the same
 * one-sentence account. The stored template is never touched.
 */
function reviseSurfaceDraft(
	current: SurfaceTemplate,
	instruction: string
): { draft: SurfaceTemplate; note: string } {
	const draft = structuredClone(current);
	const changes: string[] = [];
	const hero = draft.blocks.find((block) => block.type === 'hero');
	const listing = draft.blocks.find((block) => block.type === 'schedule-days');

	if (listing && /track/i.test(instruction) && listing.grouping !== 'track') {
		listing.grouping = 'track';
		changes.push('regrouped the schedule by track');
	}
	if (listing && /compact/i.test(instruction) && listing.density !== 'compact') {
		listing.density = 'compact';
		changes.push('tightened the listing to the compact density');
	}
	if (listing && /hide (the )?rooms?/i.test(instruction) && listing.showRoom) {
		listing.showRoom = false;
		changes.push('hid the room on each session');
	} else if (listing && /show (the )?rooms?/i.test(instruction) && !listing.showRoom) {
		listing.showRoom = true;
		changes.push('showed the room on each session');
	}
	// Field work first: an instruction naming a question is a registry
	// operation through the placement seam, not a section-copy tweak. The
	// generic section branch below only answers when no field op matched.
	const fieldOps = draft.kind === 'application-form' ? parseFieldOps(instruction) : [];
	if (fieldOps.length > 0) {
		applyFieldOps(draft, fieldOps, changes);
	} else if (draft.kind === 'application-form' && /section|question/i.test(instruction)) {
		const fields = draft.fields ?? [];
		const referenced = new Set(
			draft.blocks.flatMap((block) => (block.type === 'form-section' ? block.fieldRefs : []))
		);
		const unplaced = fields.find((field) => !referenced.has(field.id));
		if (unplaced) {
			// The pool already holds an unasked question: place it before inventing one.
			draft.blocks.push({ type: 'form-section', title: 'One more thing', fieldRefs: [unplaced.id] });
			changes.push(`added a section asking the unplaced “${unplaced.label}” question`);
		} else {
			const extra: SurfaceField = {
				id: `question-${fields.length + 1}`,
				label: 'Anything we should have asked?',
				kind: 'textarea',
				required: false,
				help: 'Optional — whatever the form left no room for.',
				group: 'other'
			};
			draft.fields = [...fields, extra];
			const last = [...draft.blocks].reverse().find((block) => block.type === 'form-section');
			if (last) last.fieldRefs = [...last.fieldRefs, extra.id];
			else draft.blocks.push({ type: 'form-section', title: 'One more thing', fieldRefs: [extra.id] });
			changes.push('added a follow-up question to the last section');
		}
	}
	if (/short|tight/i.test(instruction)) {
		for (const block of draft.blocks) {
			if (block.type === 'note') block.text = firstSentence(block.text);
		}
		if (hero) hero.intro = firstSentence(hero.intro);
		changes.push('trimmed the intro and notes to their first sentence');
	}
	if (/warm|friendly/i.test(instruction) && hero) {
		hero.intro = `We’re glad you’re here. ${hero.intro}`;
		changes.push('opened the hero more warmly');
	}
	if (changes.length === 0) {
		if (hero) {
			hero.intro = `In short: ${hero.intro.charAt(0).toLowerCase()}${hero.intro.slice(1)}`;
			changes.push('rephrased the hero intro');
		} else {
			changes.push('left the structure unchanged');
		}
	}

	const account = changes.join(', then ');
	return { draft, note: `${account.charAt(0).toUpperCase()}${account.slice(1)}.` };
}

/**
 * Prior content per template revision, kept so a revert can restore what a
 * revision actually said rather than only its metadata. Populated when a
 * revision is applied; seeded history carries no bodies.
 */
const templateSnapshots = new Map<
	string,
	Map<number, { subject: string; blocks: MessageTemplate['blocks']; mergeFields: MergeFieldDef[] }>
>();

function snapshotTemplate(stored: MessageTemplate): void {
	const byRevision = templateSnapshots.get(stored.id) ?? new Map();
	byRevision.set(
		stored.revision,
		structuredClone({ subject: stored.subject, blocks: stored.blocks, mergeFields: stored.mergeFields })
	);
	templateSnapshots.set(stored.id, byRevision);
}

/** The same forward-only history store for surface templates. */
const surfaceSnapshots = new Map<
	string,
	Map<number, { blocks: SurfaceBlock[]; fields?: SurfaceField[]; submitLabel?: string }>
>();

function snapshotSurface(stored: SurfaceTemplate): void {
	const byRevision = surfaceSnapshots.get(stored.id) ?? new Map();
	byRevision.set(
		stored.revision,
		structuredClone({ blocks: stored.blocks, fields: stored.fields, submitLabel: stored.submitLabel })
	);
	surfaceSnapshots.set(stored.id, byRevision);
}

// ---------------------------------------------------------------------------
// Field registry

/** The registry in its user-owned order — the truth every read and splice works over. */
function orderedRegistry(): RegistryField[] {
	return [...db.fieldRegistry].sort((a, b) => a.position - b.position);
}

/** Persists an ordered registry back, renumbering positions to match. Relative user order is never changed here. */
function commitRegistryOrder(ordered: RegistryField[]): void {
	ordered.forEach((field, index) => {
		field.position = index;
	});
	db.fieldRegistry = ordered;
}

const lockedFieldRefusal =
	'Email is how applicants are identified and reached — it cannot be removed from the application';

/**
 * The live vocabularies a sourced choice field draws options from, in the
 * shape the derivation seam consumes. Options resolve at serve time, so a
 * track added in Settings appears on the next read of every form offering the
 * question — nothing copies the vocabulary anywhere.
 */
function serveVocab(): ServeVocab {
	return {
		tracks: db.tracks.map((seed) => ({
			id: seed.id,
			name: seed.name,
			status: seed.status ?? 'active'
		})),
		formats: db.formats.map((seed) => ({
			id: seed.id,
			name: seed.name,
			status: seed.status ?? 'active'
		}))
	};
}

/**
 * The registry → form derivation seam, applied at serve time: an
 * application-form surface template stores its prose, and every read projects
 * the current registry's apply-context fields into its pool and its sections'
 * fieldRefs. A field edited through any door changes the served form on the
 * next read; nothing keeps a second copy in sync.
 */
function servedSurface(stored: SurfaceTemplate): SurfaceTemplate {
	return projectApplicationForm(stored, db.fieldRegistry, serveVocab());
}

/** A stored form with its composition normalized; datasets may omit the parts they don't use. */
function formComposition(seed: FormSeed): FormComposition {
	return {
		excludedFieldIds: seed.composition?.excludedFieldIds ?? [],
		requiredOverrides: seed.composition?.requiredOverrides ?? {},
		optionExposure: seed.composition?.optionExposure ?? {}
	};
}

/**
 * The questions a form effectively asks: shared apply-context fields minus the
 * form's exclusions, plus the extras scoped to it. The card number and the
 * configurator's checked rows both read this — one derivation, no drift.
 */
function formFieldIds(seed: FormSeed): string[] {
	const excluded = new Set(formComposition(seed).excludedFieldIds);
	return contextFields(db.fieldRegistry, 'apply', seed.id)
		.filter((field) => !excluded.has(field.id))
		.map((field) => field.id);
}

/** A form as the API serves it: the seed plus its derived question count and normalized composition. */
function asForm(seed: FormSeed): FormSummary {
	return {
		id: seed.id,
		name: seed.name,
		target: seed.target,
		status: seed.status,
		currentPublishedVersionId: seed.status === 'draft'
			? null
			: `${seed.id}:published:${seed.version}`,
		...(seed.closesAt ? { closesAt: seed.closesAt } : {}),
		version: seed.version,
		submissionCount: seed.submissionCount,
		fieldCount: formFieldIds(seed).length,
		composition: formComposition(seed)
	};
}

/**
 * Reconciles an applied form draft with the field registry. The form editor is
 * a door onto the one registry, so what the applied draft asks becomes what
 * the registry says the application asks: a question the draft minted
 * registers with `collectAt: ['apply']` at the placement advisor's spot; an
 * existing question the draft asks joins the apply context; requiredness
 * follows the draft's pool; and an apply question the draft dropped leaves the
 * apply context — never deleted, its answers and other contexts stay. The
 * locked email question and fields scoped to other forms are untouched.
 */
function syncDraftFields(draft: SurfaceTemplate): void {
	if (draft.kind !== 'application-form') return;
	const pool = draft.fields ?? [];
	for (const field of pool) {
		const entry = db.fieldRegistry.find((candidate) => candidate.id === field.id);
		if (!entry) {
			const ordered = orderedRegistry();
			const placement = suggestPlacement({ kind: field.kind, label: field.label }, ordered);
			ordered.splice(placement.index, 0, {
				id: field.id,
				kind: field.kind,
				label: field.label,
				...(field.help ? { help: field.help } : {}),
				required: field.required ? { apply: true } : {},
				collectAt: ['apply'],
				...(field.options ? { options: field.options } : {}),
				group: placement.group,
				position: placement.index
			});
			commitRegistryOrder(ordered);
			continue;
		}
		if (!entry.collectAt.includes('apply')) entry.collectAt = [...entry.collectAt, 'apply'];
		if (Boolean(entry.required.apply) !== field.required) {
			entry.required = { ...entry.required, apply: field.required };
		}
	}
	for (const entry of db.fieldRegistry) {
		if (entry.locked || entry.formScope || !entry.collectAt.includes('apply')) continue;
		if (!pool.some((field) => field.id === entry.id)) {
			entry.collectAt = entry.collectAt.filter((context) => context !== 'apply');
		}
	}
}

export const api = {
	/**
	 * The per-operator surface-visit rotation (Q41), reduced to the one read a
	 * surface makes at entry: when did I last look here before this visit. The
	 * sample seam serves the dataset's authored instant; the live row rotates
	 * on a human page entry only — agent and MCP reads never count as seen.
	 */
	visits: {
		async previous(surface: 'submissions'): Promise<string | null> {
			await latency();
			void surface;
			return visitHistory()[0] ?? null;
		}
	},
	workspace: {
		async summary(): Promise<WorkspaceSummary> {
			await latency();
			return refreshedSummary();
		},
		/**
		 * The most recently known summary, synchronously — evidence a screen may
		 * use to shape its loading state (e.g. whether a conditional banner
		 * deserves a placeholder). Null when nothing has been fetched yet.
		 */
		summarySnapshot(): WorkspaceSummary | null {
			return refreshedSummary();
		},
		/**
		 * The workspace's events as the sidebar switcher offers them — a
		 * serve-time projection, never a copied list.
		 */
		async events(): Promise<WorkspaceEventOption[]> {
			await latency();
			return workspaceEvents();
		},
		/**
		 * Creates an event and makes it the workspace's current one — the
		 * caller reloads after an ok outcome and arrives on the new event's
		 * overview. Expected refusals are values. The real operation replaces
		 * this with the event-creation command; the input mirrors the live
		 * first-run composition (name, timezone, dates) so the port swaps in
		 * without reshaping the dialog.
		 */
		async createEvent(input: {
			name: string;
			timezone: string;
			startDate: string;
			endDate: string;
		}): Promise<MutationOutcome> {
			await latency();
			const name = input.name.trim();
			if (!name) return { ok: false, reason: 'Give the event a name' };
			if (!input.startDate || !input.endDate) {
				return { ok: false, reason: 'Choose both event dates' };
			}
			if (input.endDate < input.startDate) {
				return { ok: false, reason: 'The end date cannot fall before the start date' };
			}
			if (!input.timezone.trim()) return { ok: false, reason: 'Choose a timezone' };
			const id = `evt-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
			persistCreatedEvent({
				id,
				name,
				timezone: input.timezone,
				startDate: input.startDate,
				endDate: input.endDate
			});
			if (typeof document !== 'undefined') setScenarioCookie(`created:${id}`);
			return { ok: true };
		},
		/**
		 * Selects which event the workspace serves. The active event's data is
		 * rebuilt from its source on the next load, so the caller reloads the
		 * app after an ok outcome — every surface re-scopes at once.
		 */
		async switchEvent(id: string): Promise<MutationOutcome> {
			await latency();
			const option = workspaceEvents().find((event) => event.id === id);
			if (!option) return { ok: false, reason: 'This event no longer exists' };
			if (!option.current) setScenarioCookie(option.scenarioKey);
			return { ok: true };
		}
	},

	/**
	 * The signed-in person, as the account menu sees them. Identity resolves
	 * from the viewer projection — never hardcoded — and the email-change flow
	 * models the dual-confirmation states the real ceremony will carry.
	 */
	account: {
		async current(): Promise<AccountInfo> {
			await latency();
			return { ...accountIdentity(), pendingEmailChange: pendingEmailChange && { ...pendingEmailChange } };
		},
		/**
		 * Starts an email change: confirmation goes to both mailboxes — the
		 * current address approves the change, the new one proves receipt — and
		 * nothing commits until both confirm. Expected refusals are values; the
		 * outcome never says whether an address belongs to someone else.
		 */
		async requestEmailChange(newEmail: string): Promise<MutationOutcome> {
			await latency();
			const address = newEmail.trim().toLowerCase();
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
				return { ok: false, reason: 'Enter a complete email address' };
			}
			if (address === accountIdentity().email.toLowerCase()) {
				return { ok: false, reason: 'This is already your address' };
			}
			pendingEmailChange = { newEmail: address, confirmedCurrent: false, confirmedNew: false };
			return { ok: true };
		},
		async resendEmailChange(): Promise<MutationOutcome> {
			await latency();
			if (!pendingEmailChange) return { ok: false, reason: 'No email change is in progress' };
			return { ok: true };
		},
		async cancelEmailChange(): Promise<MutationOutcome> {
			await latency();
			pendingEmailChange = null;
			return { ok: true };
		},
		/** Confirmed sign-out: the session ends server-side before the UI moves. */
		async signOut(): Promise<MutationOutcome> {
			await latency();
			if (typeof document !== 'undefined') setOperatorEntryAuthCookie('anonymous');
			return { ok: true };
		}
	},

	/**
	 * One namespace owns vocabulary reads and writes. Lists carry every entry,
	 * retired ones included, so a renderer can always resolve what a record
	 * points at; offering an entry for new use is the caller's filter.
	 */
	vocab: {
		async tracks(): Promise<Track[]> {
			await latency();
			return db.tracks.map(asTrack);
		},
		async formats(): Promise<Format[]> {
			await latency();
			return db.formats.map(asFormat);
		},
		async rooms(): Promise<Room[]> {
			await latency();
			return db.schedule.rooms.map(asRoom);
		},
		/** The public roster's groups, in the order they appear on the page. */
		async speakerCategories(): Promise<SpeakerCategory[]> {
			await latency();
			return db.speakerCategories.map(asSpeakerCategory);
		},
		async addSpeakerCategory(name: string): Promise<SpeakerCategory> {
			await latency();
			const seed: SpeakerCategorySeed = {
				id: `spkcat-${db.speakerCategories.length + 1}-${name.length}`,
				name,
				// Groups are told apart by name; the accent families are the product's
				// and are handed out in turn rather than chosen at creation.
				accent: (['lavender', 'sea', 'neutral'] as const)[db.speakerCategories.length % 3]
			};
			db.speakerCategories.push(seed);
			return asSpeakerCategory(seed);
		},
		async addTrack(name: string): Promise<Track> {
			await latency();
			const seed: TrackSeed = { id: `trk-${db.tracks.length + 1}-${name.length}`, name, accent: 'neutral' };
			db.tracks.push(seed);
			return asTrack(seed);
		},
		async addFormat(name: string): Promise<Format> {
			await latency();
			const seed: FormatSeed = { id: `fmt-${db.formats.length + 1}-${name.length}`, name };
			db.formats.push(seed);
			return asFormat(seed);
		},
		async addRoom(name: string, capacity: number): Promise<Room> {
			await latency();
			const seed: RoomSeed = { id: `room-${db.schedule.rooms.length + 1}-${name.length}`, name, capacity };
			db.schedule.rooms.push(seed);
			return asRoom(seed);
		},
		async removeTrack(id: string): Promise<MutationOutcome> {
			await latency();
			const seed = db.tracks.find((track) => track.id === id);
			if (!seed) return { ok: true };
			const reason = removalBlockReason(
				'track',
				trackUsage(id, usageSource()),
				seed.status ?? 'active',
				scopeRefCount('track', id, db.reviewers)
			);
			if (reason) return { ok: false, reason };
			db.tracks = db.tracks.filter((track) => track.id !== id);
			return { ok: true };
		},
		async removeFormat(id: string): Promise<MutationOutcome> {
			await latency();
			const seed = db.formats.find((format) => format.id === id);
			if (!seed) return { ok: true };
			const reason = removalBlockReason(
				'format',
				formatUsage(id, usageSource()),
				seed.status ?? 'active',
				scopeRefCount('format', id, db.reviewers)
			);
			if (reason) return { ok: false, reason };
			db.formats = db.formats.filter((format) => format.id !== id);
			return { ok: true };
		},
		async removeRoom(id: string): Promise<MutationOutcome> {
			await latency();
			const seed = db.schedule.rooms.find((room) => room.id === id);
			if (!seed) return { ok: true };
			const reason = removalBlockReason('room', roomUsage(id, usageSource()), seed.status ?? 'active');
			if (reason) return { ok: false, reason };
			db.schedule.rooms = db.schedule.rooms.filter((room) => room.id !== id);
			return { ok: true };
		},
		async retireTrack(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.tracks.find((track) => track.id === id), 'retired');
		},
		async restoreTrack(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.tracks.find((track) => track.id === id), 'active');
		},
		async retireFormat(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.formats.find((format) => format.id === id), 'retired');
		},
		async restoreFormat(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.formats.find((format) => format.id === id), 'active');
		},
		async retireRoom(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.schedule.rooms.find((room) => room.id === id), 'retired');
		},
		async restoreRoom(id: string): Promise<MutationOutcome> {
			await latency();
			return setStatus(db.schedule.rooms.find((room) => room.id === id), 'active');
		}
	},

	submissions: {
		list: (query: SubmissionQuery = {}) => submissionList.list(query),
		async get(id: string): Promise<Submission | null> {
			await latency();
			return db.submissions.find((submission) => submission.id === id) ?? null;
		},
		/**
		 * Direct entry from the submissions side (04 §3, widened by 22): the
		 * organizer keys a proposal in on the speakers' behalf. Disposition
		 * decides where it lands — the review inbox as an ordinary undecided
		 * candidate, or accepted at creation (the invited path), graduating
		 * through the same acceptance routing a decision uses. Attribution comes
		 * from the signed-in member, never from the caller's input.
		 */
		async addDirectEntry(input: DirectEntryInput): Promise<Submission> {
			await latency();
			const submission: Submission = {
				id: mintId('sub'),
				title: input.title,
				abstract: input.abstract ?? '',
				speakers: input.speakers.map((speaker) => ({ ...speaker })),
				trackId: input.trackId,
				formatId: input.formatId,
				submittedAt: new Date().toISOString(),
				source: 'direct_entry',
				enteredBy: accountIdentity().name,
				...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
				tray: 'inbox',
				decision: input.disposition === 'accepted' ? 'accepted' : 'undecided',
				...(input.disposition === 'accepted' ? { decidedAt: new Date().toISOString() } : {}),
				notified: false,
				signals: [],
				reviewCount: 0
			};
			// Newest first: the row the organizer just added is the row they look for.
			db.submissions.unshift(submission);
			db.submissionTrayTotals.inbox += 1;
			if (submission.decision === 'accepted') {
				graduateSubmission(submission);
				programChanged();
			}
			submissionsChanged();
			return { ...submission };
		},
		async setAside(ids: string[], byRun = 'Set aside by hand'): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray !== 'set-aside') {
					moveTrayCount(submission.tray, 'set-aside');
					submission.tray = 'set-aside';
					submission.setAsideBy = byRun;
				}
			}
		},
		async returnToInbox(ids: string[]): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray === 'set-aside') {
					moveTrayCount('set-aside', 'inbox');
					submission.tray = 'inbox';
					delete submission.setAsideBy;
				}
			}
		},
		async markSpam(ids: string[]): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray !== 'spam') {
					moveTrayCount(submission.tray, 'spam');
					submission.tray = 'spam';
				}
			}
		},
		async notSpam(ids: string[]): Promise<void> {
			await latency();
			for (const submission of db.submissions) {
				if (ids.includes(submission.id) && submission.tray === 'spam') {
					moveTrayCount('spam', 'inbox');
					submission.tray = 'inbox';
				}
			}
		}
	},

	decisions: {
		/**
		 * A decision is a status transition, and acceptance additionally lands
		 * somewhere visible: it graduates the submission into the program —
		 * attaching to its named collecting session or spawning into the
		 * unplaced pool — and seeds the engagement. Moving off `accepted`
		 * compensates that graduation instead of leaving an orphan behind.
		 */
		async decide(
			ids: string[],
			decision: Submission['decision'],
			trackIdsBySubmission: Readonly<Record<string, string>> = {}
		): Promise<void> {
			await latency();
			const activeTracks = db.tracks.filter((track) => track.status === 'active');
			const resolvedTracks: Record<string, string> = {};
			if (decision === 'accepted') {
				for (const submission of db.submissions.filter((row) => ids.includes(row.id) && !row.targetSessionId)) {
					const resolvedTrackId = trackIdsBySubmission[submission.id]
						|| submission.trackId
						|| (activeTracks.length === 1 ? activeTracks[0]!.id : '');
					if (resolvedTrackId === '' && activeTracks.length > 1) {
						throw new Error('Choose a track before accepting this submission');
					}
					resolvedTracks[submission.id] = resolvedTrackId;
				}
			}
			for (const submission of db.submissions) {
				if (!ids.includes(submission.id)) continue;
				if (decision === 'accepted' && !submission.targetSessionId) {
					submission.trackId = resolvedTracks[submission.id] ?? submission.trackId;
				}
				const was = submission.decision;
				submission.decision = decision;
				submission.notified = false;
				// The decision moment rides the head: it orders the decided groups
				// and lets un-notified copy state its age. Undeciding clears it —
				// an undecided row has no decision to date.
				if (decision === 'undecided') delete submission.decidedAt;
				else submission.decidedAt = new Date().toISOString();
				if (decision === 'accepted') graduateSubmission(submission);
				else if (was === 'accepted') ungraduateSubmission(submission);
			}
			programChanged();
			submissionsChanged();
		},
		async reviewNotification(ids: string[]): Promise<MessageReview> {
			await latency();
			const rows = db.submissions.filter((submission) => ids.includes(submission.id));
			const decisionWord: Record<string, string> = {
				accepted: 'Accepted',
				waitlisted: 'Waitlisted',
				declined: 'Declined'
			};
			return {
				templateLabel: 'decision-notice @ revision 2',
				audienceLabel: 'Selected decided submissions (current snapshot)',
				binding: 'current_snapshot',
				recipients: rows.flatMap((submission) =>
					submission.speakers.map((speaker) => ({
						name: speaker.name,
						email: speaker.email,
						state: 'included' as const,
						mergeSample: `${decisionWord[submission.decision] ?? submission.decision} — “${submission.title}”`
					}))
				),
				sender: 'AI Engineer <program@aie-demo.example>',
				replyModel: 'Replies go to the organizer inbox',
				irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
			};
		},
		async notify(ids: string[], subject: string): Promise<CommunicationMessage> {
			await latency();
			const decided = db.submissions.filter((submission) => ids.includes(submission.id));
			for (const submission of decided) submission.notified = true;
			submissionsChanged();
			const message = communicationEntry(subject, 'Decision notifications', ids.length, 'sent', {
				purpose: 'Decision notice',
				cause: `${ids.length} decided submission${ids.length === 1 ? '' : 's'} awaited their notice — sent from the Decisions page`,
				causeHref: '/app/decisions',
				actor: 'you'
			});
			appendThreadEntries(
				message,
				decided.flatMap((submission) => submission.speakers.map((speaker) => speaker.email))
			);
			return message;
		}
	},

	review: {
		async plans(): Promise<ReviewPlan[]> {
			await latency();
			return db.reviewPlans;
		},
		/**
		 * The newest round's standing, reduced to what the submissions inbox
		 * needs for its station groups. Open is stated by the plan's own
		 * deadline words here because the sample plan carries no explicit flag;
		 * the live projection reports a real one.
		 */
		async roundStatus(): Promise<ReviewRoundStatus | null> {
			await latency();
			const plan = db.reviewPlans.at(-1);
			if (!plan) return null;
			const due = plan.deadlineRelative.toLowerCase();
			// Sample-only inference from the plan's authored words; the live
			// projection computes the tone from the real deadline instant.
			const deadlineTone = due.includes('overdue')
				? ('danger' as const)
				: due.includes('today') || due.includes('tomorrow')
					? ('warning' as const)
					: ('calm' as const);
			return {
				open: !due.startsWith('closed'),
				name: plan.name,
				percentDone: plan.total === 0 ? 0 : Math.round((plan.done / plan.total) * 100),
				dueLabel: plan.deadlineRelative,
				deadlineTone,
				...(plan.reviewsPerSubmission !== undefined
					? { reviewsPerSubmission: plan.reviewsPerSubmission }
					: {})
			};
		},
		/**
		 * What opening the round will do, counted from current records. The
		 * hand-out rule is the v1 single path: every submission in the inbox
		 * goes to each active reviewer whose scope covers it — generalists
		 * carry everything, scope narrows workload, and step-back handles a
		 * conflict per submission after the fact.
		 */
		async roundSetup(): Promise<ReviewRoundSetup> {
			await latency();
			const pool = db.reviewers.filter((reviewer) => reviewer.status === 'active');
			const inbox = db.submissions.filter((submission) => submission.tray === 'inbox');
			const perReviewer = pool.map((reviewer) => ({
				id: reviewer.id,
				name: reviewer.name,
				assigned: inbox.filter((submission) => scopeMatches(reviewer.scope, submission)).length
			}));
			return {
				activeReviewers: pool.length,
				invitedReviewers: db.reviewers.filter((reviewer) => reviewer.status === 'invited').length,
				submissions: inbox.length,
				expectedReviews: perReviewer.reduce((sum, entry) => sum + entry.assigned, 0),
				perReviewer
			};
		},
		/**
		 * Opens round 1: freezes the hand-out counted by `roundSetup` into a
		 * plan and reflects it into the workspace summary. Scale and
		 * anti-anchoring take their defaults (1–5 anchored; peer content locked
		 * until own commit); only the deadline and the blinding are asked.
		 */
		async openRound(input: { deadlineIso: string; anonymized: boolean }): Promise<ReviewPlan> {
			await latency();
			const setup = {
				pool: db.reviewers.filter((reviewer) => reviewer.status === 'active'),
				inbox: db.submissions.filter((submission) => submission.tray === 'inbox')
			};
			const reviewers: ReviewerProgress[] = setup.pool.map((reviewer) => ({
				id: reviewer.id,
				name: reviewer.name,
				assigned: setup.inbox.filter((submission) => scopeMatches(reviewer.scope, submission)).length,
				done: 0,
				steppedBack: 0,
				awaitingReassignment: 0
			}));
			const total = reviewers.reduce((sum, entry) => sum + entry.assigned, 0);
			const plan: ReviewPlan = {
				id: mintId('plan'),
				name: 'Round 1 · all tracks',
				scaleMax: 5,
				deadlineRelative: `due ${relativeDays(input.deadlineIso)}`,
				anonymized: input.anonymized,
				antiAnchoring: true,
				done: 0,
				total,
				reviewers
			};
			// The summary must tell the same story; the prior slices are kept so
			// discarding the round puts every number back exactly.
			roundSummaryPrior.set(plan.id, structuredClone(db.summary));
			db.reviewPlans.push(plan);
			db.summary.navCounts.review = '0%';
			db.summary.attention = db.summary.attention.filter((item) => item.id !== 'no-review-plan');
			db.summary.stats = db.summary.stats.map((stat) =>
				stat.label === 'Review round' || stat.label === 'Review plan'
					? { label: 'Review round', value: 'Open', sub: `0 of ${total} reviews · ${plan.deadlineRelative}` }
					: stat
			);
			db.summary.pipeline = db.summary.pipeline.map((stage) =>
				stage.key === 'review'
					? {
							...stage,
							// The figure is said once: headline and sentence compose one
							// claim — "0" + "of 40 reviews are in · round 1 open".
							headline: '0',
							sub: `of ${total} reviews are in · round 1 open`,
							state: 'ok' as const,
							progress: { done: 0, required: total }
						}
					: stage
			);
			return plan;
		},
		/**
		 * The compensating write behind the open-round receipt. Refused once a
		 * review has been committed: at that point the round is history, not a
		 * draft to take back.
		 */
		async discardRound(planId: string): Promise<MutationOutcome> {
			await latency();
			const plan = db.reviewPlans.find((entry) => entry.id === planId);
			if (!plan) return { ok: false, reason: 'This round no longer exists' };
			if (plan.done > 0) {
				return { ok: false, reason: 'Reviews have already been committed in this round' };
			}
			db.reviewPlans = db.reviewPlans.filter((entry) => entry.id !== planId);
			const prior = roundSummaryPrior.get(planId);
			if (prior) {
				db.summary = prior;
				roundSummaryPrior.delete(planId);
			}
			return { ok: true };
		},
		async myQueue(): Promise<MyReviewItem[]> {
			await latency();
			return db.myQueue;
		},
		async saveReview(submissionId: string, score: number, comment: string): Promise<void> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (item && !item.committed) {
				item.myScore = score;
				item.myComment = comment;
			}
		},
		async commitReview(submissionId: string): Promise<MyReviewItem | null> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (item && item.myScore !== undefined && !item.committed) {
				item.committed = true;
				item.peerScores ??= [Math.max(1, item.myScore - 1), Math.min(5, item.myScore + 1)];
				const plan = activePlan();
				if (plan) plan.done += 1;
			}
			return item ?? null;
		},

		/** Where one submission's average sits inside its track's population. */
		async standing(submissionId: string): Promise<ScoreStanding | null> {
			await latency();
			return standingFor(submissionId);
		},

		/** The same claim for a whole screenful, on one round trip. */
		async standings(submissionIds: string[]): Promise<Record<string, ScoreStanding>> {
			await latency();
			const out: Record<string, ScoreStanding> = {};
			for (const submissionId of submissionIds) {
				const standing = standingFor(submissionId);
				if (standing) out[submissionId] = standing;
			}
			return out;
		},

		/**
		 * Every committed review on one submission, for review-read surfaces:
		 * scores, comments, and post-unlock amendment deltas, with reviewer
		 * identity as the plan-local label — never a name. The caller's own
		 * committed review is included and marked.
		 */
		async forSubmission(submissionId: string): Promise<SubmissionReview[]> {
			await latency();
			const submission = db.submissions.find((row) => row.id === submissionId);
			return submission ? reviewsFor(submission) : [];
		},

		/**
		 * Changes an already-committed review. What was committed before is kept
		 * as a revision rather than overwritten: once peer scores are visible,
		 * a changed score is only readable beside the one it replaced.
		 */
		async amend(submissionId: string, score: number, comment: string): Promise<MyReviewItem | null> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (!item || !item.committed) return null;
			item.revisions = [
				...(item.revisions ?? []),
				{ score: item.myScore ?? score, comment: item.myComment ?? '', at: 'just now', postUnlock: true }
			];
			item.myScore = score;
			item.myComment = comment;
			return item;
		},

		/** The compensating write behind an amendment receipt. */
		async revertAmend(submissionId: string): Promise<MyReviewItem | null> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (!item) return null;
			const revisions = item.revisions;
			if (!revisions || revisions.length === 0) return item;
			const previous = revisions[revisions.length - 1];
			item.revisions = revisions.slice(0, -1);
			if (item.revisions.length === 0) delete item.revisions;
			item.myScore = previous.score;
			item.myComment = previous.comment;
			return item;
		},

		/**
		 * My other committed reviews, for reading one score against the rest of
		 * my own scoring rather than against the crowd. The anchor is never in
		 * its own comparison, and an uncommitted review is not evidence yet.
		 */
		async comparables(submissionId: string, slice: 'track' | 'all'): Promise<ComparableCard[]> {
			await latency();
			const anchor = db.submissions.find((row) => row.id === submissionId);
			const cards: ComparableCard[] = [];
			for (const item of db.myQueue) {
				if (item.submissionId === submissionId || !item.committed) continue;
				const submission = db.submissions.find((row) => row.id === item.submissionId);
				if (!submission) continue;
				if (slice === 'track' && submission.trackId !== anchor?.trackId) continue;
				cards.push({ item, submission, standing: standingFor(submission.id) });
			}
			return cards.sort((a, b) => (b.item.myScore ?? 0) - (a.item.myScore ?? 0));
		},

		async accoladeDefs(): Promise<AccoladeDef[]> {
			await latency();
			return accoladeCatalog;
		},

		/**
		 * Pins one of my marks on a submission. A capped key refuses once it is
		 * spent and says which submissions are holding it, because "you already
		 * used all three" is only actionable if you can see where they went.
		 */
		async pinAccolade(submissionId: string, key: AccoladeKey): Promise<MutationOutcome> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (!item || !item.committed) {
				return {
					ok: false,
					reason: `Commit your review of “${submissionTitle(submissionId)}” before pinning an accolade to it`
				};
			}
			if (item.accolades?.includes(key)) return { ok: true };
			const def = accoladeCatalog.find((entry) => entry.key === key);
			if (def?.cap !== undefined) {
				const holders = db.myQueue.filter(
					(entry) => entry.submissionId !== submissionId && entry.accolades?.includes(key)
				);
				if (holders.length >= def.cap) {
					const titles = holders.map((holder) => submissionTitle(holder.submissionId));
					return { ok: false, reason: composeCapRefusal(def, titles) };
				}
			}
			item.accolades = [...(item.accolades ?? []), key];
			return { ok: true };
		},

		/**
		 * What one reviewer is asked to review: their own scope refs, never the
		 * roster around them. An empty list is the generalist default, which is
		 * everything — the absence of scope, not a scope that says "all".
		 */
		async myScope(reviewerId: string): Promise<ScopeRef[]> {
			await latency();
			const reviewer = db.reviewers.find((entry) => entry.id === reviewerId);
			return (reviewer?.scope ?? []).map((ref) => ({ ...ref }));
		},

		/**
		 * Steps back from one review over a conflict of interest.
		 *
		 * The review leaves this reviewer's queue and becomes work nobody holds:
		 * `steppedBack` and `awaitingReassignment` both rise, and `assigned`
		 * stays where it was, so the plan's denominator never moves when someone
		 * steps back. A committed review refuses — the score is already in the
		 * round, and withdrawing it is the chair's call, not a queue action.
		 */
		async stepBack(submissionId: string, reviewerId: string): Promise<MutationOutcome> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (!item) {
				return { ok: false, reason: `“${submissionTitle(submissionId)}” is no longer in your queue` };
			}
			if (item.committed) {
				return { ok: false, reason: composeStepBackRefusal(submissionTitle(submissionId)) };
			}
			db.myQueue = db.myQueue.filter((entry) => entry.submissionId !== submissionId);
			for (const plan of db.reviewPlans) {
				const row = plan.reviewers.find((entry) => entry.id === reviewerId);
				if (!row) continue;
				row.steppedBack += 1;
				row.awaitingReassignment += 1;
				break;
			}
			return { ok: true };
		},

		async unpinAccolade(submissionId: string, key: AccoladeKey): Promise<MutationOutcome> {
			await latency();
			const item = db.myQueue.find((entry) => entry.submissionId === submissionId);
			if (item?.accolades) {
				item.accolades = item.accolades.filter((entry) => entry !== key);
				if (item.accolades.length === 0) delete item.accolades;
			}
			return { ok: true };
		}
	},

	/**
	 * The reviewer roster. A reviewer is a workspace member holding the
	 * Speaker Reviewer preset (or another role that includes review), so this
	 * namespace composes with the Settings invite rather than minting a
	 * parallel invitation record. Scope is application assignment data: it
	 * narrows a reviewer's workload and never adjusts visibility policy or a
	 * plan's blind/peer gates.
	 */
	reviewers: {
		/**
		 * The roster with its coverage projection, all server-counted: load
		 * numbers are summed across every review plan, `generalists` counts
		 * active reviewers with no scope, and coverage carries one row per
		 * active track and format plus every collecting session.
		 */
		async list(): Promise<ReviewerRoster> {
			await latency();
			const reviewers = db.reviewers.map(asReviewer);
			return {
				reviewers,
				generalists: reviewers.filter(
					(reviewer) => reviewer.status === 'active' && isGeneralist(reviewer)
				).length,
				coverage: {
					kind: 'served',
					rows: coverageRows({
						tracks: db.tracks,
						formats: db.formats,
						sessions: db.schedule.sessions,
						submissions: db.submissions,
						reviewers: db.reviewers
					})
				}
			};
		},
		/**
		 * Invites reviewers by address — several at once, one outcome per
		 * line. An address that is not yet a member joins the members list as
		 * an invited Speaker Reviewer; an address that already is a member
		 * simply gains the reviewer record under the same id. One system: the
		 * reviewer id is the member id, and no second invitation is minted.
		 * `scope` is the optional initial scope applied to every admitted
		 * line; absent means generalist, the default.
		 */
		async invite(
			entries: { email: string; name?: string }[],
			scope: ScopeRef[] = []
		): Promise<ReviewerInviteLine[]> {
			await latency();
			const bad = unresolvedScopeRef(scope);
			if (bad) {
				const reason = `Scope names a ${bad.kind} that does not exist`;
				return entries.map((entry) => ({ email: entry.email, ok: false, reason }));
			}
			const lines: ReviewerInviteLine[] = [];
			for (const entry of entries) {
				const email = entry.email.trim();
				const key = email.toLowerCase();
				if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
					lines.push({ email: entry.email, ok: false, reason: 'Not a valid email address' });
					continue;
				}
				if (db.reviewers.some((reviewer) => reviewer.email.trim().toLowerCase() === key)) {
					lines.push({ email, ok: false, reason: 'Already on the reviewer roster' });
					continue;
				}
				const member = db.members.find((candidate) => candidate.email.trim().toLowerCase() === key);
				const name = entry.name?.trim() || member?.name || email.split('@')[0];
				// An existing member keeps their id and their standing; everyone
				// else enters through the ordinary invited-member reservation.
				const status: ReviewerStatus =
					member && (member.status ?? 'active') === 'active' ? 'active' : 'invited';
				let id: string;
				if (member) {
					id = member.id;
				} else {
					id = mintId('mem');
					db.members.push({ id, name, email, role: 'Speaker Reviewer', status: 'invited' });
				}
				const seed: ReviewerSeed = {
					id,
					name,
					email,
					status,
					scope: scope.map((ref) => ({ ...ref }))
				};
				db.reviewers.push(seed);
				lines.push({ email, ok: true, reviewer: asReviewer(seed) });
			}
			return lines;
		},
		/**
		 * Replaces one reviewer's scope. An empty set is the generalist
		 * default — reviews everything — so clearing scope is an ordinary
		 * write, not a removal. Every ref must resolve to a record that
		 * exists; refused otherwise.
		 */
		async setScope(id: string, scope: ScopeRef[]): Promise<MutationOutcome> {
			await latency();
			const reviewer = db.reviewers.find((entry) => entry.id === id);
			if (!reviewer) return { ok: false, reason: 'This reviewer is no longer on the roster' };
			const bad = unresolvedScopeRef(scope);
			if (bad) return { ok: false, reason: `Scope names a ${bad.kind} that does not exist` };
			reviewer.scope = scope.map((ref) => ({ ...ref }));
			return { ok: true };
		},
		/**
		 * Takes a reviewer off the roster. Their rows in each plan's roster
		 * stay — an uncovered review remains in the original reviewer's
		 * `assigned`, so plan denominators never move — and workspace
		 * membership is untouched: leaving the workspace is Settings'
		 * operation. An already-gone id is a quiet success.
		 */
		async remove(id: string): Promise<MutationOutcome> {
			await latency();
			const index = db.reviewers.findIndex((entry) => entry.id === id);
			const reviewer = db.reviewers[index];
			if (reviewer) removedReviewers.set(id, {
				seed: structuredClone(reviewer), index
			});
			db.reviewers = db.reviewers.filter((entry) => entry.id !== id);
			return { ok: true };
		},
		/**
		 * Forward restore from the retained sample tombstone. The caller supplies
		 * only identity; no browser before-image can recreate roster state.
		 */
		async restore(id: string): Promise<void> {
			await latency();
			if (db.reviewers.some((entry) => entry.id === id)) return;
			const retained = removedReviewers.get(id);
			if (!retained) return;
			db.reviewers.splice(
				Math.max(0, Math.min(db.reviewers.length, retained.index)),
				0,
				structuredClone(retained.seed)
			);
			removedReviewers.delete(id);
		}
	},

	speakers: {
		async list(): Promise<SpeakerRow[]> {
			await latency();
			return orderedRoster();
		},
		/**
		 * The roster as a public surface receives it: ordered, filtered to who may
		 * be shown, and stripped to publishable facts. Every public presentation —
		 * the standalone page, each embed of it, a single-speaker card — reads this
		 * one projection, so they cannot disagree about who is on the lineup.
		 */
		async publicRoster(): Promise<PublicSpeakerCard[]> {
			await latency();
			return publicRoster();
		},
		/**
		 * Moves one entry to an index in the public order and renumbers the rest.
		 * The index is the destination in the *whole* roster, so a caller showing
		 * a filtered view resolves the destination before calling.
		 */
		async reorder(id: string, toIndex: number): Promise<MutationOutcome> {
			await latency();
			const ordered = orderedRoster();
			if (!ordered.some((row) => row.id === id)) {
				return { ok: false, reason: 'This speaker is no longer on the roster' };
			}
			const next = movedOrder(
				ordered.map((row) => row.id),
				id,
				toIndex
			);
			next.forEach((rowId, index) => {
				const row = db.speakers.find((entry) => entry.id === rowId);
				if (row) row.position = index;
			});
			return { ok: true };
		},
		/** Files one person under a public group, or removes them from every group. */
		async setCategory(id: string, categoryId: string | null): Promise<MutationOutcome> {
			await latency();
			const row = db.speakers.find((entry) => entry.id === id);
			if (!row) return { ok: false, reason: 'This speaker is no longer on the roster' };
			if (categoryId && !db.speakerCategories.some((entry) => entry.id === categoryId)) {
				return { ok: false, reason: 'That group no longer exists' };
			}
			if (categoryId) row.categoryId = categoryId;
			else delete row.categoryId;
			return { ok: true };
		},
		/**
		 * Whether this person appears on the public lineup at all. Distinct from
		 * whether their content is approved: an unapproved public speaker still
		 * appears, as themselves, without a biography.
		 */
		async setVisibility(id: string, publiclyVisible: boolean): Promise<MutationOutcome> {
			await latency();
			const row = db.speakers.find((entry) => entry.id === id);
			if (!row) return { ok: false, reason: 'This speaker is no longer on the roster' };
			row.publiclyVisible = publiclyVisible;
			return { ok: true };
		},
		async get(id: string): Promise<SpeakerRow | null> {
			await latency();
			return db.speakers.find((speaker) => speaker.id === id) ?? null;
		},
		/**
		 * Who submitted, by the address on the submission. Null is the ordinary
		 * answer for most submitters: a surface that asks about an unknown address
		 * gets nothing to show, not an empty profile.
		 */
		async profile(email: string): Promise<SpeakerProfile | null> {
			await latency();
			return profileFor(email);
		},
		/**
		 * Records an out-of-product confirmation, attributed to the organizer.
		 * Refused when the engagement is not awaiting one, so a stale screen
		 * reads the refusal instead of a silent no-op claiming success.
		 */
		async recordConfirmation(id: string): Promise<MutationOutcome> {
			await latency();
			const speaker = db.speakers.find((entry) => entry.id === id);
			if (!speaker) return { ok: false, reason: 'This speaker is no longer on the roster' };
			if (speaker.state !== 'invited') {
				return { ok: false, reason: 'This engagement is no longer awaiting confirmation' };
			}
			speaker.state = 'confirmed';
			return { ok: true };
		},
		/** Accepts a recorded cancellation request; nothing is sent anywhere. */
		async acceptCancellation(id: string): Promise<MutationOutcome> {
			await latency();
			const speaker = db.speakers.find((entry) => entry.id === id);
			if (!speaker) return { ok: false, reason: 'This speaker is no longer on the roster' };
			if (speaker.state !== 'cancel_requested') {
				return { ok: false, reason: 'This engagement has no cancellation request to accept' };
			}
			speaker.state = 'cancelled';
			db.summary.attention = db.summary.attention.filter((item) => item.id !== 'cancel-request');
			return { ok: true };
		}
	},

	tasks: {
		async createDefinition(input: import('./tasks-page-port').CreateTaskDefinitionInput): Promise<MutationOutcome> {
			await latency();
			const id = `task-${globalThis.crypto.randomUUID()}`;
			const due = new Date(`${input.dueOn}T23:59:00Z`);
			const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
			db.taskDefs.push({
				id,
				name: input.name,
				kind: input.completionMode === 'file_upload' ? 'upload'
					: input.completionMode === 'acknowledge' ? 'confirm'
						: input.completionMode === 'external_action' ? 'link' : 'form',
				required: input.required,
				dueAbsolute: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
				dueRelative: days < 0 ? `${Math.abs(days)} days overdue` : `in ${days} days`
			});
			for (const speaker of db.speakers.filter((entry) => entry.state === 'confirmed')) {
				db.assignments.push({ taskId: id, speakerId: speaker.id, state: 'todo', overdue: days < 0 });
			}
			return { ok: true };
		},
		async defs(): Promise<TaskDef[]> {
			await latency();
			return db.taskDefs;
		},
		async assignments(): Promise<TaskAssignment[]> {
			await latency();
			return db.assignments;
		},
		async remind(speakerIds: string[], subject: string): Promise<CommunicationMessage> {
			await latency();
			const message = communicationEntry(subject, 'Task reminder', speakerIds.length, 'sent', {
				purpose: 'Task reminder',
				cause: `${speakerIds.length} speaker${speakerIds.length === 1 ? '' : 's'} held incomplete tasks — sent from the Tasks page`,
				causeHref: '/app/tasks',
				actor: 'you'
			});
			appendThreadEntries(
				message,
				speakerIds
					.map((id) => db.speakers.find((row) => row.id === id)?.email)
					.filter((email): email is string => Boolean(email))
			);
			return message;
		},
		async markWaived(taskId: string, speakerId: string): Promise<void> {
			await latency();
			const assignment = db.assignments.find((a) => a.taskId === taskId && a.speakerId === speakerId);
			if (assignment) {
				assignment.state = 'waived';
				assignment.overdue = false;
			}
		},
		/**
		 * Accepts what a speaker already delivered: `received` means the material
		 * is in and waiting on the organizer, so this is the step that closes it.
		 * Refused when the assignment is not in that state, so a stale screen
		 * cannot complete something twice.
		 */
		async acceptFulfillment(taskId: string, speakerId: string): Promise<MutationOutcome> {
			await latency();
			const assignment = db.assignments.find((a) => a.taskId === taskId && a.speakerId === speakerId);
			if (!assignment) return { ok: false, reason: 'This task is no longer assigned to this speaker' };
			if (assignment.state !== 'received') {
				return { ok: false, reason: 'This task is no longer waiting on your acceptance' };
			}
			assignment.state = assignment.overdue ? 'late-complete' : 'complete';
			assignment.overdue = false;
			return { ok: true };
		},
		/**
		 * The compensating write behind a task receipt: puts one assignment back
		 * to the exact mark it carried before the commit being undone.
		 */
		async restoreAssignment(
			taskId: string,
			speakerId: string,
			state: TaskAssignment['state'],
			overdue: boolean
		): Promise<void> {
			await latency();
			const assignment = db.assignments.find((a) => a.taskId === taskId && a.speakerId === speakerId);
			if (assignment) {
				assignment.state = state;
				assignment.overdue = overdue;
			}
		}
	},

	schedule: {
		/**
		 * Where an accepted submission went — the session it became or joined.
		 * Session-graduations this session are answered from their compensation
		 * record; pre-seeded acceptances fall back to the origin link, telling
		 * spawn from attach by whether the session is the submission alone.
		 */
		async originOf(submissionId: string): Promise<SubmissionOrigin | null> {
			await latency();
			const session = db.schedule.sessions.find((entry) =>
				(entry.originSubmissionIds ?? []).includes(submissionId)
			);
			if (!session) return null;
			const record = graduations.get(submissionId);
			const kind =
				record?.kind ??
				((session.originSubmissionIds ?? []).length === 1 ? 'spawn' : 'attach');
			return { sessionId: session.id, title: session.title, kind };
		},
		async state(): Promise<ScheduleState> {
			await latency();
			// Snapshots, not live rows: roster edits mutate a session in place,
			// and a read that handed out the same object identity would let a
			// consumer's fine-grained reactivity bail on "unchanged" state.
			return {
				...db.schedule,
				rooms: db.schedule.rooms.map(asRoom),
				sessions: db.schedule.sessions.map((session) => ({
					...session,
					speakers: [...session.speakers]
				}))
			};
		},
		async suggestSlots(sessionId: string): Promise<SlotSuggestion[]> {
			await latency();
			const suggestions: SlotSuggestion[] = [];
			const duration = sessionDuration(sessionId);
			const dayLength = db.schedule.slotsPerDay * db.schedule.slotMinutes;
			// A suggestion offers a room for new use, so retired rooms are not
			// proposed; sessions already sitting in one keep their slot.
			const offered = db.schedule.rooms.filter((room) => (room.status ?? 'active') === 'active');
			for (const day of db.schedule.days) {
				for (const room of offered) {
					for (let slot = 0; slot < db.schedule.slotsPerDay; slot += 1) {
						const startMin = slot * db.schedule.slotMinutes;
						if (startMin + duration > dayLength) continue;
						if (conflictsFor(sessionId, day.key, room.id, startMin).length === 0) {
							suggestions.push({ dayKey: day.key, roomId: room.id, startMin, note: 'Free slot' });
							if (suggestions.length >= 6) return suggestions;
							break;
						}
					}
				}
			}
			return suggestions;
		},
		async place(sessionId: string, dayKey: string, roomId: string, startMin: number): Promise<Placement> {
			await latency();
			db.schedule.placements = db.schedule.placements.filter((p) => p.sessionId !== sessionId);
			const placement: Placement = {
				sessionId,
				dayKey,
				roomId,
				startMin,
				conflicts: conflictsFor(sessionId, dayKey, roomId, startMin)
			};
			db.schedule.placements.push(placement);
			programChanged();
			return placement;
		},
		async unplace(sessionId: string): Promise<void> {
			await latency();
			db.schedule.placements = db.schedule.placements.filter((p) => p.sessionId !== sessionId);
			programChanged();
		},
		/**
		 * Direct creation — the editorial birth paths (16 §2): a fixed keynote
		 * entered as fact, a private sketch, or a collecting container opened
		 * before any submission exists. Speakers are deliberately not accepted
		 * here; attribution has one grammar (attach, direct entry, roster edit).
		 */
		async createSession(input: {
			title: string;
			trackId: string;
			formatId: string;
			durationMin: number;
			state: SessionState;
		}): Promise<SessionItem> {
			await latency();
			const session: SessionItem = {
				id: mintId('ses'),
				title: input.title,
				speakers: [],
				trackId: input.trackId,
				formatId: input.formatId,
				durationMin: input.durationMin,
				state: input.state
			};
			db.schedule.sessions = [...db.schedule.sessions, session];
			programChanged();
			return session;
		},
		async retargetSession(id: string, formatId: string, trackId: string): Promise<SessionItem> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === id);
			if (!session) throw new Error('This session no longer exists');
			const activeTracks = db.tracks.filter((track) => track.status === 'active');
			const resolvedTrackId = trackId || (session.state !== 'draft' && activeTracks.length === 1
				? activeTracks[0]!.id
				: '');
			if (session.state !== 'draft' && activeTracks.length > 1 && resolvedTrackId === '') {
				throw new Error('Choose a track before this session enters the program');
			}
			session.formatId = formatId;
			session.trackId = resolvedTrackId;
			programChanged();
			return session;
		},
		/**
		 * The compensation for a creation receipt: a session leaves cleanly only
		 * while nothing else references it — no slot held, no proposals aimed at
		 * it, nobody on its roster.
		 */
		async removeSession(id: string): Promise<MutationOutcome> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === id);
			if (!session) return { ok: false, reason: 'This session no longer exists' };
			if (placedSessionIds().has(id)) {
				return { ok: false, reason: 'It holds a slot on the grid — remove the placement first' };
			}
			const proposals = db.submissions.filter(
				(submission) =>
					submission.targetSessionId === id &&
					submission.decision === 'undecided' &&
					submission.tray !== 'spam'
			).length;
			if (proposals > 0) {
				return {
					ok: false,
					reason: `${proposals} open proposal${proposals === 1 ? '' : 's'} still target${proposals === 1 ? 's' : ''} it`
				};
			}
			if (session.speakers.length > 0) {
				return { ok: false, reason: 'People are attributed to it — remove them first' };
			}
			db.schedule.sessions = db.schedule.sessions.filter((entry) => entry.id !== id);
			programChanged();
			return { ok: true };
		},
		/**
		 * The lifecycle writer. Graduating a collecting session never decides
		 * its open proposals: they stay submissions awaiting decision, and a
		 * later accept against the closed target re-offers spawn (16 §4).
		 */
		async transitionSession(id: string, to: SessionState): Promise<MutationOutcome> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === id);
			if (!session) return { ok: false, reason: 'This session no longer exists' };
			session.state = to;
			programChanged();
			return { ok: true };
		},
		/**
		 * Open proposals per target session, counted over the whole table — the
		 * honest total a pool chip may claim, never a row-window filter.
		 */
		async proposalTargets(): Promise<Record<string, number>> {
			await latency();
			const counts: Record<string, number> = {};
			for (const submission of db.submissions) {
				if (!submission.targetSessionId) continue;
				if (submission.decision !== 'undecided' || submission.tray === 'spam') continue;
				counts[submission.targetSessionId] = (counts[submission.targetSessionId] ?? 0) + 1;
			}
			return counts;
		},
		/** Accepted submissions this session could still take on (assemble/attach). */
		async attachCandidates(sessionId: string): Promise<Submission[]> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === sessionId);
			if (!session) return [];
			const linked = new Set(session.originSubmissionIds ?? []);
			return db.submissions.filter(
				(submission) => submission.decision === 'accepted' && !linked.has(submission.id)
			);
		},
		/**
		 * Attach an already-accepted submission — the drawer-side mirror of
		 * acceptance routing: roster merge under append policy, provenance link,
		 * and a collecting session graduates in place.
		 */
		async attachSubmission(sessionId: string, submissionId: string): Promise<MutationOutcome> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === sessionId);
			if (!session) return { ok: false, reason: 'This session no longer exists' };
			const submission = db.submissions.find((entry) => entry.id === submissionId);
			if (!submission) return { ok: false, reason: 'This submission no longer exists' };
			if (submission.decision !== 'accepted') {
				return { ok: false, reason: 'Only accepted submissions join a roster — decide it first' };
			}
			if ((session.originSubmissionIds ?? []).includes(submissionId)) {
				return { ok: false, reason: 'This submission is already part of the session' };
			}
			mergeSpeakers(session, submission.speakers);
			session.originSubmissionIds = [...(session.originSubmissionIds ?? []), submissionId];
			if (session.state !== 'programmed') session.state = 'programmed';
			for (const speaker of submission.speakers) upsertRosterRow(speaker, session);
			programChanged();
			return { ok: true };
		},
		/**
		 * The compensation for an attach receipt: the origin link and the
		 * people that submission brought leave together. A person the session
		 * also holds through another origin stays — restore-to-before, never
		 * a wider deletion. The submission itself remains a durable record.
		 */
		async detachSubmission(sessionId: string, submissionId: string): Promise<MutationOutcome> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === sessionId);
			if (!session) return { ok: false, reason: 'This session no longer exists' };
			if (!(session.originSubmissionIds ?? []).includes(submissionId)) {
				return { ok: false, reason: 'This submission is not part of the session' };
			}
			const submission = db.submissions.find((entry) => entry.id === submissionId);
			session.originSubmissionIds = (session.originSubmissionIds ?? []).filter(
				(id) => id !== submissionId
			);
			const remaining = new Set(
				(session.originSubmissionIds ?? []).flatMap((id) => {
					const origin = db.submissions.find((entry) => entry.id === id);
					return origin ? origin.speakers.map((speaker) => speaker.email) : [];
				})
			);
			for (const speaker of submission?.speakers ?? []) {
				if (remaining.has(speaker.email)) continue;
				session.speakers = session.speakers.filter((entry) => entry.email !== speaker.email);
				dropSessionFromRosterRow(speaker.email, sessionId);
			}
			programChanged();
			return { ok: true };
		},
		/**
		 * How each origin reached this session — the provenance the speakers
		 * panel narrates per row ("via the accepted proposal", "direct entry").
		 */
		async sessionOrigins(
			sessionId: string
		): Promise<{ id: string; title: string; source: Submission['source']; speakerEmails: string[] }[]> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === sessionId);
			if (!session) return [];
			return (session.originSubmissionIds ?? []).flatMap((id) => {
				const submission = db.submissions.find((entry) => entry.id === id);
				return submission
					? [
							{
								id: submission.id,
								title: submission.title,
								source: submission.source,
								speakerEmails: submission.speakers.map((speaker) => speaker.email)
							}
						]
					: [];
			});
		},
		/**
		 * Direct entry (04 §3), whole and in one commit: the person, their
		 * accepted direct-entry submission, the engagement seeded `invited`,
		 * and the attribution — never a bare name written onto a session.
		 */
		async addDirectParticipant(
			sessionId: string,
			person: { name: string; email: string }
		): Promise<MutationOutcome> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === sessionId);
			if (!session) return { ok: false, reason: 'This session no longer exists' };
			if (session.speakers.some((speaker) => speaker.email === person.email)) {
				return { ok: false, reason: 'This person is already on the session' };
			}
			const submission: Submission = {
				id: mintId('sub'),
				title: session.title,
				abstract: '',
				speakers: [{ name: person.name, email: person.email }],
				trackId: session.trackId,
				formatId: session.formatId,
				submittedAt: new Date().toISOString(),
				source: 'direct_entry',
				enteredBy: accountIdentity().name,
				tray: 'inbox',
				decision: 'accepted',
				decidedAt: new Date().toISOString(),
				notified: false,
				signals: [],
				reviewCount: 0
			};
			db.submissions.push(submission);
			db.submissionTrayTotals.inbox += 1;
			mergeSpeakers(session, submission.speakers);
			session.originSubmissionIds = [...(session.originSubmissionIds ?? []), submission.id];
			upsertRosterRow({ name: person.name, email: person.email }, session);
			programChanged();
			submissionsChanged();
			return { ok: true };
		},
		/** Editorial roster addition: an already-engaged person joins a second session. */
		async addParticipantFromRoster(sessionId: string, speakerId: string): Promise<MutationOutcome> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === sessionId);
			if (!session) return { ok: false, reason: 'This session no longer exists' };
			const row = db.speakers.find((entry) => entry.id === speakerId);
			if (!row) return { ok: false, reason: 'This person is no longer on the roster' };
			if (session.speakers.some((speaker) => speaker.email === row.email)) {
				return { ok: false, reason: 'This person is already on the session' };
			}
			mergeSpeakers(session, [{ name: row.name, email: row.email }]);
			upsertRosterRow({ name: row.name, email: row.email }, session);
			programChanged();
			return { ok: true };
		},
		/** Editorial roster removal — post-acceptance edit, ordinary commit. */
		async removeParticipant(sessionId: string, email: string): Promise<MutationOutcome> {
			await latency();
			const session = db.schedule.sessions.find((entry) => entry.id === sessionId);
			if (!session) return { ok: false, reason: 'This session no longer exists' };
			if (!session.speakers.some((speaker) => speaker.email === email)) {
				return { ok: false, reason: 'This person is not on the session' };
			}
			session.speakers = session.speakers.filter((speaker) => speaker.email !== email);
			dropSessionFromRosterRow(email, sessionId);
			// An origin link exists to explain people on the roster. One that no
			// longer contributes anyone is provenance for nothing: it would keep
			// its submission out of the attach candidates and misattribute a
			// later re-add. The submission itself remains a durable record.
			const remaining = new Set(session.speakers.map((speaker) => speaker.email));
			session.originSubmissionIds = (session.originSubmissionIds ?? []).filter((id) => {
				const origin = db.submissions.find((entry) => entry.id === id);
				return origin ? origin.speakers.some((speaker) => remaining.has(speaker.email)) : false;
			});
			programChanged();
			return { ok: true };
		},
		async addBreak(input: {
			label: string;
			dayKey: string;
			roomId: string;
			startMin: number;
			durationMin: number;
		}): Promise<BreakBlock> {
			await latency();
			const brk: BreakBlock = { id: mintId('brk'), ...input };
			db.schedule.breaks.push(brk);
			recomputeAllConflicts();
			syncScheduleCounters();
			return brk;
		},
		async removeBreak(id: string): Promise<void> {
			await latency();
			db.schedule.breaks = db.schedule.breaks.filter((brk) => brk.id !== id);
			recomputeAllConflicts();
			syncScheduleCounters();
		},
		/**
		 * The same two-press ceremony the live release lane serves, so the
		 * design fixture and the product tell one story: a draft states what
		 * would go public — including which speaker names the commit copies
		 * into public state — and only the second press publishes it.
		 */
		async draftPublication() {
			await latency();
			const blocks = scheduleBlockCount();
			if (blocks > 0) {
				return {
					ok: false as const,
					reason: `${blocks} conflict${blocks === 1 ? '' : 's'} on the schedule`
				};
			}
			const placed = db.schedule.placements.length;
			const sessions = new Set(db.schedule.placements.map((placement) => placement.sessionId));
			const names = [...sessions]
				.flatMap((id) => db.schedule.sessions.find((session) => session.id === id)?.speakers ?? [])
				.map((speaker) => speaker.name)
				.filter((name, index, all) => all.indexOf(name) === index);
			return {
				releaseNumber: (db.schedule.published ? 1 : 0) + 1,
				sessions: sessions.size,
				occurrences: placed,
				declassifiedNames: names,
				lineupNames: db.speakers
					.filter((speaker) => speaker.publiclyVisible)
					.sort((left, right) => left.position - right.position)
					.map((speaker) => speaker.name),
				speakerGroups: db.speakerCategories
					.filter((category) => (category.status ?? 'active') === 'active')
					.map((category) => category.name)
				// No server draft behind the fixture, so no continuation to carry.
			};
		},
		async publishReviewed(): Promise<MutationOutcome> {
			await latency();
			const blocks = scheduleBlockCount();
			if (blocks > 0) {
				return { ok: false, reason: `${blocks} conflict${blocks === 1 ? '' : 's'} on the schedule` };
			}
			db.schedule.published = true;
			return { ok: true };
		}
	},

	communications: {
		async list(): Promise<CommunicationMessage[]> {
			await latency();
			return db.communications;
		},
		async readiness(): Promise<EmailReadiness> {
			await latency();
			return db.readiness;
		},
		/**
		 * The workspace-editable half of the sender presentation. The
		 * from-address is answered as read-only effective context and is absent
		 * from the update input: it is installation configuration.
		 */
		senderIdentity: {
			async read() {
				await latency();
				return senderIdentityStore.read();
			},
			async update(input: SampleSenderIdentityUpdate) {
				await latency();
				return senderIdentityStore.update(input);
			}
		},
		/**
		 * The attention queue is a derived, rebuildable projection over the
		 * current records — recomputed from state on every read, never a
		 * fire-once flag. Order: blocked work first, then work waiting on review.
		 */
		async attention(): Promise<CommunicationAttentionItem[]> {
			await latency();
			const items: CommunicationAttentionItem[] = [];
			for (const message of db.communications) {
				if (message.state === 'held') {
					items.push({
						id: `att-held-${message.id}`,
						severity: 'action',
						reason: `“${message.subject}” is held`,
						detail:
							message.heldReason ??
							'The send stays queued and releases once provider setup passes.',
						count: message.audienceCount,
						messageId: message.id,
						// Reviewing a held send retries it: it releases when setup
						// passes and re-holds with its reason when it still cannot.
						action: { label: 'Review & send', kind: 'review' }
					});
				}
				if (message.bouncedCount > 0) {
					items.push({
						id: `att-bounce-${message.id}`,
						severity: 'action',
						reason: `${message.bouncedCount} address${message.bouncedCount === 1 ? '' : 'es'} bounced in “${message.subject}”`,
						detail: 'Fix each address on the message, then resend to just those people.',
						count: message.bouncedCount,
						messageId: message.id,
						action: { label: 'See the addresses', kind: 'open-message' }
					});
				}
				if (message.state === 'draft') {
					items.push({
						id: `att-draft-${message.id}`,
						severity: 'soon',
						reason: `Draft awaiting your review — “${message.subject}”`,
						detail: `${message.audience} · nothing sends until you review it`,
						count: message.audienceCount,
						messageId: message.id,
						action: { label: 'Review & send', kind: 'review' }
					});
				}
			}
			if (db.readiness.outbound === 'action_required') {
				items.push({
					id: 'att-readiness-outbound',
					severity: 'action',
					reason: 'Outbound sending is not set up',
					detail: 'Nothing can leave until setup passes; queued sends are held, not dropped.',
					action: { label: 'Continue setup', kind: 'setup' }
				});
			}
			if (db.readiness.callbacks === 'action_required') {
				items.push({
					id: 'att-readiness-callbacks',
					severity: 'soon',
					reason: 'Delivery reports are not verified',
					detail: 'Mail still sends, but delivered and bounce counts stay blank until the callback URL is verified.',
					action: { label: 'Continue setup', kind: 'setup' }
				});
			}
			const rank: Record<CommunicationAttentionItem['severity'], number> = { action: 0, soon: 1 };
			return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
		},
		/** One person's organizer-visible thread; null when the person is unknown. */
		async thread(personId: string): Promise<CommunicationThread | null> {
			await latency();
			const person = db.speakers.find((row) => row.id === personId);
			if (!person) return null;
			return { personId, personName: person.name, entries: db.threads[personId] ?? [] };
		},
		/**
		 * Sendable audiences, resolved and counted from the current records —
		 * the API owns the list so the composer never hardcodes a roster count.
		 * A `personId` prepends that person as a one-recipient audience.
		 */
		async audiences(personId?: string): Promise<AudienceOption[]> {
			await latency();
			return audienceOptions(personId);
		},
		async send(id: string): Promise<MutationOutcome> {
			await latency();
			const message = db.communications.find((entry) => entry.id === id);
			if (!message || (message.state !== 'draft' && message.state !== 'held')) {
				return { ok: false, reason: 'This message is no longer a sendable draft' };
			}
			if (db.readiness.outbound !== 'ready') {
				message.state = 'held';
				message.heldReason = 'Outbound email is not ready — finish provider setup; the send stays queued and releases once setup passes.';
				return { ok: false, reason: message.heldReason };
			}
			message.state = 'sent';
			message.sentAt = 'Just now';
			delete message.heldReason;
			const included = message.review
				? message.review.recipients.filter((recipient) => recipient.state === 'included')
				: null;
			message.deliveredCount = included ? included.length : message.audienceCount;
			appendThreadEntries(message, included?.map((recipient) => recipient.email) ?? []);
			return { ok: true };
		},
		/**
		 * The bounce remedy: correct (or confirm) one recipient's address and
		 * resend their copy of this message. One person is the whole blast
		 * radius, so the deliberate step is the single labelled action; the real
		 * seam behind it is the fix-address + authorized-retry pair.
		 */
		async resendBounced(
			id: string,
			email: string,
			correctedEmail: string
		): Promise<MutationOutcome> {
			await latency();
			const message = db.communications.find((entry) => entry.id === id);
			const bounce = message?.bounces.find((entry) => entry.email === email);
			if (!message || !bounce) {
				return { ok: false, reason: 'This bounce is no longer on the message' };
			}
			const address = correctedEmail.trim();
			if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
				return { ok: false, reason: 'Enter a full email address' };
			}
			if (db.readiness.outbound !== 'ready') {
				return { ok: false, reason: 'Outbound email is not ready — finish provider setup; the resend stays available.' };
			}
			message.bounces = message.bounces.filter((entry) => entry !== bounce);
			message.bouncedCount = message.bounces.length;
			message.deliveredCount += 1;
			// Their copy went out again: the person's own thread records it. The
			// roster row still carries the old address, so match either.
			const threadEmail = [address, email].find((candidate) =>
				db.speakers.some((row) => row.email === candidate)
			);
			if (threadEmail) appendThreadEntries(message, [threadEmail]);
			return { ok: true };
		},
		async compose(input: {
			subject: string;
			audienceId: string;
			templateId?: string;
		}): Promise<CommunicationMessage> {
			await latency();
			const personId = input.audienceId.startsWith('person-')
				? input.audienceId.slice('person-'.length)
				: undefined;
			const options = audienceOptions(personId);
			const audience = options.find((option) => option.id === input.audienceId) ?? options[0];
			const template = input.templateId
				? db.templates.find((entry) => entry.id === input.templateId)
				: undefined;
			const recipients = audienceRecipients(audience, template, input.subject);
			const included = recipients.filter((recipient) => recipient.state === 'included').length;
			const review: MessageReview = {
				templateLabel: template
					? `${template.key} @ revision ${template.revision}`
					: 'No template — subject only',
				audienceLabel: `${audience.label} (current snapshot)`,
				binding: 'current_snapshot',
				recipients,
				sender: senderIdentity(),
				replyModel: 'Replies go to the organizer inbox',
				irreversibleNote: 'Email cannot be recalled after the provider accepts it.'
			};
			return communicationEntry(input.subject, audience.label, included, 'draft', {
				purpose: template ? template.name : 'One-off message',
				cause: template
					? `Composed by you from the “${template.name}” template`
					: 'Composed by you on the Communications page',
				actor: 'you',
				templateId: template?.id,
				review
			});
		}
	},

	/**
	 * Message and public-surface templates share one agent-assisted editing
	 * loop: classify an instruction, stream a draft, apply it as a new revision,
	 * revert to an earlier one. Every method accepts either kind of id; a draft
	 * is always returned for review — nothing an agent writes reaches the
	 * stored template except through `applyRevision`.
	 */
	templates: {
		async list(): Promise<{ messages: MessageTemplate[]; surfaces: SurfaceTemplate[] }> {
			await latency();
			return { messages: db.templates, surfaces: db.surfaces.map(servedSurface) };
		},
		async get(id: string): Promise<AnyTemplate | null> {
			await latency();
			const surface = db.surfaces.find((entry) => entry.id === id);
			if (surface) return servedSurface(surface);
			return db.templates.find((template) => template.id === id) ?? null;
		},
		/**
		 * The models an edit can be pinned to. The routing default (`auto`) is
		 * always first and is the recommended choice.
		 */
		async modelChoices(): Promise<ModelChoice[]> {
			await latency();
			return structuredClone(templateModelChoices);
		},
		/**
		 * Starter instructions for this template's kind — each one is wording
		 * `revise` visibly acts on. Empty for an unknown id.
		 */
		async suggestions(id: string): Promise<TemplateSuggestion[]> {
			await latency();
			const stored: AnyTemplate | undefined =
				db.templates.find((template) => template.id === id) ??
				db.surfaces.find((surface) => surface.id === id);
			return stored ? suggestionsFor(stored) : [];
		},
		/**
		 * How an instruction would be run, before anything is drafted. A pinned
		 * model (any `modelId` other than `auto`) bypasses routing: the label
		 * echoes the pick and the classification is attributed to the organizer.
		 */
		async classify(id: string, instruction: string, modelId?: string): Promise<EditClassification> {
			void id;
			await wait(300);
			return classifyInstruction(instruction, modelId);
		},
		/**
		 * Drafts a revision, reporting progress as it streams — identically for
		 * messages and surfaces. Resolves with the draft and a one-sentence note
		 * of what changed; the stored template is untouched until the draft is
		 * applied. A pinned model shifts pacing slightly (Opus drafts longer and
		 * slower); the transformation itself is model-independent.
		 */
		async revise(
			id: string,
			instruction: string,
			onProgress?: (p: ReviseProgress) => void,
			modelId?: string
		): Promise<{ draft: AnyTemplate; note: string }> {
			// A surface drafts over its served projection, so the draft's field
			// pool is the registry's current answer, not a stale stored copy.
			const surfaceStored = db.surfaces.find((surface) => surface.id === id);
			const stored: AnyTemplate | undefined =
				db.templates.find((template) => template.id === id) ??
				(surfaceStored ? servedSurface(surfaceStored) : undefined);
			if (!stored) throw new Error(`Unknown template: ${id}`);
			const classification = classifyInstruction(instruction, modelId);
			onProgress?.({ status: 'classifying', tokens: 0 });
			await wait(300);
			const pacing =
				(modelId && modelId !== 'auto' && modelPacing[modelId]) || autoPacing;
			const total = Math.round(
				(classification.scope === 'quick' ? 140 : 900) * pacing.tokenFactor
			);
			const step = classification.scope === 'quick' ? 14 : 31;
			let tokens = 0;
			while (tokens < total) {
				await wait(pacing.tickMs);
				tokens = Math.min(total, tokens + step);
				onProgress?.({ status: 'drafting', tokens });
			}
			const { draft, note } = isSurfaceTemplate(stored)
				? reviseSurfaceDraft(stored, instruction)
				: reviseDraft(stored, instruction);
			draft.revision = stored.revision + 1;
			draft.revisions = [
				...stored.revisions,
				{ number: draft.revision, at: 'Just now', by: 'agent', note }
			];
			onProgress?.({ status: 'done', tokens: total });
			return { draft, note };
		},
		/**
		 * Commits a reviewed draft as the template's next revision. Refused when
		 * the stored template moved on while the draft was under review, so a
		 * stale draft can never silently overwrite newer work.
		 */
		async applyRevision(id: string, draft: AnyTemplate): Promise<MutationOutcome> {
			await latency();
			if (isSurfaceTemplate(draft)) {
				const index = db.surfaces.findIndex((surface) => surface.id === id);
				if (index === -1) return { ok: false, reason: 'This template no longer exists' };
				const stored = db.surfaces[index];
				if (stored.revision !== draft.revision - 1) {
					return { ok: false, reason: 'This template changed while you were editing' };
				}
				snapshotSurface(stored);
				db.surfaces[index] = structuredClone(draft);
				// The draft's field work joins the registry; the next serve
				// projects it back into the form from there.
				syncDraftFields(draft);
				return { ok: true };
			}
			const index = db.templates.findIndex((template) => template.id === id);
			if (index === -1) return { ok: false, reason: 'This template no longer exists' };
			const stored = db.templates[index];
			if (stored.revision !== draft.revision - 1) {
				return { ok: false, reason: 'This template changed while you were editing' };
			}
			snapshotTemplate(stored);
			db.templates[index] = structuredClone(draft);
			return { ok: true };
		},
		/**
		 * Commits a single in-place edit as the template's next revision,
		 * attributed to the organizer with the edit's own note. `next` is the
		 * full document the client rebuilt from the copy on screen, at that
		 * copy's revision; refused when the stored template moved on since that
		 * copy was read, so a stale edit can never silently overwrite newer
		 * work.
		 */
		async commitInline(id: string, next: AnyTemplate, note: string): Promise<MutationOutcome> {
			await latency();
			if (isSurfaceTemplate(next)) {
				const index = db.surfaces.findIndex((surface) => surface.id === id);
				if (index === -1) return { ok: false, reason: 'This template no longer exists' };
				const stored = db.surfaces[index];
				if (stored.revision !== next.revision) {
					return { ok: false, reason: 'This template changed while you were editing' };
				}
				snapshotSurface(stored);
				const committed = structuredClone(next);
				committed.revision = stored.revision + 1;
				committed.revisions = [
					...stored.revisions,
					{ number: committed.revision, at: 'Just now', by: 'you', note }
				];
				db.surfaces[index] = committed;
				return { ok: true };
			}
			const index = db.templates.findIndex((template) => template.id === id);
			if (index === -1) return { ok: false, reason: 'This template no longer exists' };
			const stored = db.templates[index];
			if (stored.revision !== next.revision) {
				return { ok: false, reason: 'This template changed while you were editing' };
			}
			snapshotTemplate(stored);
			const committed = structuredClone(next);
			committed.revision = stored.revision + 1;
			committed.revisions = [
				...stored.revisions,
				{ number: committed.revision, at: 'Just now', by: 'you', note }
			];
			db.templates[index] = committed;
			return { ok: true };
		},
		/**
		 * Restores an earlier revision's content as a new revision on top —
		 * history moves forward, never rewrites. Refused when no stored copy of
		 * that revision's content exists to restore.
		 */
		async revertTo(id: string, revisionNumber: number): Promise<MutationOutcome> {
			await latency();
			const surface = db.surfaces.find((entry) => entry.id === id);
			if (surface) {
				const snapshot = surfaceSnapshots.get(id)?.get(revisionNumber);
				if (!snapshot) {
					return { ok: false, reason: `No stored copy of revision ${revisionNumber} to restore` };
				}
				// The revert itself is revertable: keep what is being replaced.
				snapshotSurface(surface);
				const restored = structuredClone(snapshot);
				surface.blocks = restored.blocks;
				if (restored.fields) surface.fields = restored.fields;
				else delete surface.fields;
				if (restored.submitLabel !== undefined) surface.submitLabel = restored.submitLabel;
				else delete surface.submitLabel;
				surface.revision += 1;
				surface.revisions = [
					...surface.revisions,
					{ number: surface.revision, at: 'Just now', by: 'you', note: `Reverted to revision ${revisionNumber}` }
				];
				return { ok: true };
			}
			const stored = db.templates.find((template) => template.id === id);
			if (!stored) return { ok: false, reason: 'This template no longer exists' };
			const snapshot = templateSnapshots.get(id)?.get(revisionNumber);
			if (!snapshot) {
				return { ok: false, reason: `No stored copy of revision ${revisionNumber} to restore` };
			}
			// The revert itself is revertable: keep what is being replaced.
			snapshotTemplate(stored);
			const restored = structuredClone(snapshot);
			stored.subject = restored.subject;
			stored.blocks = restored.blocks;
			stored.mergeFields = restored.mergeFields;
			stored.revision += 1;
			stored.revisions = [
				...stored.revisions,
				{ number: stored.revision, at: 'Just now', by: 'you', note: `Reverted to revision ${revisionNumber}` }
			];
			return { ok: true };
		}
	},

	/**
	 * The person-and-talk field registry: one list of everything the event
	 * collects, projected into contexts (apply/onboard/profile). Ordering is
	 * user-owned — the placement advisor speaks once, when a field first
	 * enters, and `move` is the only thing that reorders after that. The
	 * application-form surface's question pool is served derived from this
	 * registry (see `servedSurface`), so field mutations here change the form
	 * without any second write.
	 */
	fields: {
		/** Every registry field, in user-owned position order. */
		async list(): Promise<RegistryField[]> {
			await latency();
			return orderedRegistry();
		},
		/**
		 * Registers a new field. The deterministic advisor classifies it and
		 * picks where it enters the current order; the returned placement carries
		 * the index, group, and the one-sentence reason a surface can show.
		 */
		async add(input: {
			kind: FieldKind;
			label: string;
			help?: string;
			options?: string[];
			collectAt: FieldContext[];
			/** Contexts that require an answer; the rest collect it as optional. */
			requiredIn?: FieldContext[];
			/** Names the one form this question belongs to, for per-form extras. */
			formScope?: string;
		}): Promise<{ field: RegistryField; placement: PlacementSuggestion }> {
			await latency();
			const ordered = orderedRegistry();
			const placement = suggestPlacement({ kind: input.kind, label: input.label }, ordered);
			const required: Partial<Record<FieldContext, boolean>> = {};
			for (const context of input.requiredIn ?? []) required[context] = true;
			const field: RegistryField = {
				id: mintId('fld'),
				kind: input.kind,
				label: input.label,
				...(input.help ? { help: input.help } : {}),
				required,
				collectAt: [...input.collectAt],
				...(input.options ? { options: [...input.options] } : {}),
				group: placement.group,
				position: placement.index,
				...(input.formScope ? { formScope: input.formScope } : {})
			};
			ordered.splice(placement.index, 0, field);
			commitRegistryOrder(ordered);
			return { field, placement };
		},
		/**
		 * Edits a field's definition in place. The locked email field refuses a
		 * `collectAt` that drops the apply context — the funnel's one structural
		 * key stays on the application.
		 */
		async update(
			id: string,
			patch: Partial<Pick<RegistryField, 'label' | 'help' | 'options' | 'required' | 'collectAt'>>
		): Promise<MutationOutcome> {
			await latency();
			const field = db.fieldRegistry.find((entry) => entry.id === id);
			if (!field) return { ok: false, reason: 'This field no longer exists' };
			if (field.locked && patch.collectAt && !patch.collectAt.includes('apply')) {
				return { ok: false, reason: lockedFieldRefusal };
			}
			if (patch.label !== undefined) field.label = patch.label;
			if (patch.help !== undefined) field.help = patch.help;
			if (patch.options !== undefined) field.options = patch.options;
			if (patch.required !== undefined) field.required = patch.required;
			if (patch.collectAt !== undefined) field.collectAt = patch.collectAt;
			return { ok: true };
		},
		/** Deletes a field. The locked email field refuses; an already-gone id is a quiet success. */
		async remove(id: string): Promise<MutationOutcome> {
			await latency();
			const field = db.fieldRegistry.find((entry) => entry.id === id);
			if (!field) return { ok: true };
			if (field.locked) return { ok: false, reason: lockedFieldRefusal };
			commitRegistryOrder(orderedRegistry().filter((entry) => entry.id !== id));
			return { ok: true };
		},
		/** Reorders one field to `toIndex` in the list. This is the user owning the order; the advisor is never consulted again. */
		async move(id: string, toIndex: number): Promise<MutationOutcome> {
			await latency();
			const ordered = orderedRegistry();
			const from = ordered.findIndex((entry) => entry.id === id);
			if (from === -1) return { ok: false, reason: 'This field no longer exists' };
			const [field] = ordered.splice(from, 1);
			ordered.splice(Math.max(0, Math.min(ordered.length, toIndex)), 0, field);
			commitRegistryOrder(ordered);
			return { ok: true };
		},
		/**
		 * The compensating write behind a removal receipt: puts the exact field
		 * back at the index it held. A no-op when the id is present again.
		 */
		async restore(field: RegistryField, index: number): Promise<void> {
			await latency();
			if (db.fieldRegistry.some((entry) => entry.id === field.id)) return;
			const ordered = orderedRegistry();
			ordered.splice(Math.max(0, Math.min(ordered.length, index)), 0, structuredClone(field));
			commitRegistryOrder(ordered);
		}
	},

	theme: {
		async get(): Promise<EventTheme> {
			await latency();
			return db.theme;
		},
		async set(theme: EventTheme): Promise<void> {
			await latency();
			db.theme = { ...normalizeThemeRecipe(theme), markText: theme.markText.trim().slice(0, 3) };
		}
	},

	/**
	 * What this event can put on somebody else's website.
	 *
	 * An embed is a presentation of a published surface, never a second copy of
	 * one, so this catalogue is derived from the surfaces that exist rather than
	 * authored beside them: a surface the event does not have produces no target,
	 * and a form added on the Forms page produces one without anything here
	 * changing. The counts come from the same projections the surfaces render, so
	 * a target that would paste in empty says so before it is pasted.
	 */
	embeds: {
		async setAllowedOrigins(kind: SurfaceKind, origins: readonly string[]): Promise<MutationOutcome> {
			await latency();
			embedAllowedOrigins.set(kind, [...new Set(origins)].sort());
			return { ok: true };
		},
		async targets(): Promise<EmbedTarget[]> {
			await latency();
			const targets: EmbedTarget[] = [];

			const schedule = db.surfaces.find((surface) => surface.kind === 'schedule');
			if (schedule) {
				const programmed = db.schedule.placements.filter((placement) =>
					db.schedule.sessions.some(
						(session) => session.id === placement.sessionId && session.state === 'programmed'
					)
				).length;
				targets.push({
					key: schedule.id,
					surfaceId: schedule.id,
					kind: 'schedule',
					scope: { kind: 'all' },
					name: 'The programme',
					purpose: 'Every scheduled session, with times and rooms, grouped the way your schedule page groups them.',
					count: programmed,
					countNoun: 'session',
					acceptsSubmissions: false,
					allowedOrigins: [...(embedAllowedOrigins.get('schedule') ?? [])]
				});
			}

			const roster = db.surfaces.find((surface) => surface.kind === 'speaker-roster');
			if (roster) {
				const cards = publicRoster();
				targets.push({
					key: roster.id,
					surfaceId: roster.id,
					kind: 'speaker-roster',
					scope: { kind: 'all' },
					name: 'The whole lineup',
					purpose: 'Everyone on the public roster, in the order you set, grouped by your speaker groups.',
					count: cards.length,
					countNoun: 'speaker',
					acceptsSubmissions: false,
					allowedOrigins: [...(embedAllowedOrigins.get('speaker-roster') ?? [])]
				});
				// One target per group, because "our keynotes" is a page of its own on
				// most event sites, and a person who wants it should not have to learn
				// that a scope exists before they can have it.
				for (const category of db.speakerCategories) {
					const inGroup = cards.filter((card) => card.categoryId === category.id).length;
					targets.push({
						key: `${roster.id}:category:${category.id}`,
						surfaceId: roster.id,
						kind: 'speaker-roster',
						scope: { kind: 'category', categoryId: category.id },
						name: category.name,
						purpose: `Only the people filed under ${category.name}.`,
						count: inGroup,
						countNoun: 'speaker',
						acceptsSubmissions: false,
						allowedOrigins: [...(embedAllowedOrigins.get('speaker-roster') ?? [])]
					});
				}
			}

			const form = db.surfaces.find((surface) => surface.kind === 'application-form');
			if (form) {
				for (const seed of db.forms) {
					const served = asForm(seed);
					targets.push({
						key: `${form.id}:form:${served.id}`,
						surfaceId: form.id,
						kind: 'application-form',
						scope: { kind: 'form', formId: served.id },
						name: served.name,
						purpose:
							served.status === 'open'
								? 'The questions this call asks — as a page you can link to, or inside your own site.'
								: `Currently ${served.status}: visitors are told it is not taking applications.`,
						count: served.fieldCount,
						countNoun: 'question',
						acceptsSubmissions: true,
						allowedOrigins: [...(embedAllowedOrigins.get('application-form') ?? [])]
					});
				}
			}

			return targets;
		},
		/**
		 * One person's public card as its own embed. Derived from the roster
		 * projection rather than the roster row, so a speaker who is not published
		 * has no embeddable target at all — the answer is "publish them", not a
		 * snippet that renders nothing.
		 */
		async speakerTargets(): Promise<EmbedTarget[]> {
			await latency();
			const roster = db.surfaces.find((surface) => surface.kind === 'speaker-roster');
			if (!roster) return [];
			return publicRoster().map((card) => ({
				key: `${roster.id}:speaker:${card.id}`,
				surfaceId: roster.id,
				kind: 'speaker-roster' as const,
				scope: { kind: 'speaker' as const, speakerId: card.id },
				name: card.name,
				purpose: card.provisional
					? 'Their name and sessions. Their biography appears once their content is approved.'
					: (card.headline ?? 'Their biography, links, and sessions.'),
				count: card.sessions.length,
				countNoun: 'session',
				acceptsSubmissions: false,
				allowedOrigins: [...(embedAllowedOrigins.get('speaker-roster') ?? [])]
			}));
		}
	},

	/**
	 * Forms decide what is asked; the application surface decides how it looks.
	 * Each form composes the one shared field registry — include/exclude,
	 * per-form requiredness, and which vocabulary options its sourced choice
	 * fields offer — and the surface template renders whichever form is being
	 * previewed. Nothing here defines a field; that stays with `api.fields`.
	 */
	forms: {
		async list(): Promise<FormSummary[]> {
			await latency();
			return db.forms.map(asForm);
		},
		async get(id: string): Promise<FormSummary | null> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			return seed ? asForm(seed) : null;
		},
		/**
		 * Creates a form asking the standard application — the complete baseline,
		 * auto-arranged — so the starting point is the form the product is proud
		 * of and configuration is subtraction, not assembly from a blank page.
		 */
		async create(input: {
			name: string;
			target: FormTarget;
			closesAt?: string;
		}): Promise<FormSummary> {
			await latency();
			const seed: FormSeed = {
				id: mintId('form'),
				name: input.name,
				target: input.target,
				status: 'draft',
				...(input.closesAt ? { closesAt: input.closesAt } : {}),
				version: 1,
				submissionCount: 0
			};
			db.forms.push(seed);
			return asForm(seed);
		},
		/**
		 * Sets or clears the form's close date — the fixed-anchor close deadline.
		 * `null` removes it: the form stays open until closed by hand.
		 */
		async setClosing(id: string, closesAt: string | null): Promise<MutationOutcome> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return { ok: false, reason: 'This form no longer exists' };
			if (closesAt) seed.closesAt = closesAt;
			else delete seed.closesAt;
			return { ok: true };
		},
		/**
		 * The form's one lifecycle move, mirroring the canonical lifecycle
		 * operation: a draft or closed form opens, an open form closes. Version
		 * and publish coordination stay with the backend slice that owns them.
		 */
		async setStatus(id: string, status: 'open' | 'closed'): Promise<MutationOutcome> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return { ok: false, reason: 'This form no longer exists' };
			if (seed.status === status) return { ok: true };
			seed.status = status;
			return { ok: true };
		},
		/**
		 * The form's configuration rows: every question the apply context offers
		 * (this form's scoped extras included), each carrying the form's answer to
		 * asked-here, required-here, and — for vocabulary-sourced choice fields —
		 * which options are offered. Registry order; the checklist never re-sorts.
		 */
		async fields(id: string): Promise<FormFieldRow[] | null> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return null;
			const composition = formComposition(seed);
			const excluded = new Set(composition.excludedFieldIds);
			const vocab = serveVocab();
			return contextFields(db.fieldRegistry, 'apply', seed.id).map((field) => {
				const override = composition.requiredOverrides[field.id];
				const exposure = composition.optionExposure[field.id];
				const choices = field.optionSource
					? vocab[field.optionSource].filter((entry) => entry.status === 'active')
					: null;
				return {
					field: structuredClone(field),
					included: !excluded.has(field.id),
					required: override ?? field.required.apply === true,
					requiredOverridden: override !== undefined,
					...(choices
						? {
								options: choices.map((entry) => ({
									id: entry.id,
									name: entry.name,
									exposed: !exposure || exposure.includes(entry.id)
								}))
							}
						: {}),
					exposureAll: !exposure
				};
			});
		},
		/**
		 * Asks or drops one shared question on this form. Dropping is composition,
		 * never deletion — the field, its other contexts, and its answers stay.
		 * The locked email question refuses to leave any application form.
		 */
		async setIncluded(id: string, fieldId: string, included: boolean): Promise<MutationOutcome> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return { ok: false, reason: 'This form no longer exists' };
			const field = db.fieldRegistry.find((entry) => entry.id === fieldId);
			if (!field) return { ok: false, reason: 'This field no longer exists' };
			if (!included && field.locked) return { ok: false, reason: lockedFieldRefusal };
			const excluded = new Set(formComposition(seed).excludedFieldIds);
			if (included) excluded.delete(fieldId);
			else excluded.add(fieldId);
			seed.composition = { ...formComposition(seed), excludedFieldIds: [...excluded] };
			return { ok: true };
		},
		/**
		 * Overrides requiredness for this form only; `null` returns the question
		 * to the registry's apply default. The registry itself never moves here.
		 */
		async setRequired(
			id: string,
			fieldId: string,
			required: boolean | null
		): Promise<MutationOutcome> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return { ok: false, reason: 'This form no longer exists' };
			const composition = formComposition(seed);
			const overrides = { ...composition.requiredOverrides };
			if (required === null) delete overrides[fieldId];
			else overrides[fieldId] = required;
			seed.composition = { ...composition, requiredOverrides: overrides };
			return { ok: true };
		},
		/**
		 * Pins which vocabulary entries a sourced choice field offers on this
		 * form; `null` returns it to the live default (all current and future).
		 * An empty subset is refused — a choice question with nothing to choose
		 * is a broken form, and hiding the field is the intent that shape means.
		 */
		async setExposure(
			id: string,
			fieldId: string,
			optionIds: string[] | null
		): Promise<MutationOutcome> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return { ok: false, reason: 'This form no longer exists' };
			if (optionIds !== null && optionIds.length === 0) {
				return {
					ok: false,
					reason: 'A choice question needs at least one option — hide the question instead'
				};
			}
			const composition = formComposition(seed);
			const exposure = { ...composition.optionExposure };
			if (optionIds === null) delete exposure[fieldId];
			else exposure[fieldId] = [...optionIds];
			seed.composition = { ...composition, optionExposure: exposure };
			return { ok: true };
		},
		/**
		 * Applies one reviewed batch of composition changes — the configurator's
		 * Apply. Edits accumulate locally and commit here together, so a session
		 * of ticking is one act with one receipt. Holds the same invariants as
		 * the granular setters: the locked email question cannot be excluded and
		 * a sourced field cannot offer an empty pinned subset.
		 */
		async setComposition(id: string, composition: FormComposition): Promise<MutationOutcome> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return { ok: false, reason: 'This form no longer exists' };
			for (const fieldId of composition.excludedFieldIds) {
				const field = db.fieldRegistry.find((entry) => entry.id === fieldId);
				if (field?.locked) return { ok: false, reason: lockedFieldRefusal };
			}
			for (const ids of Object.values(composition.optionExposure)) {
				if (ids.length === 0) {
					return {
						ok: false,
						reason: 'A choice question needs at least one option — hide the question instead'
					};
				}
			}
			seed.composition = structuredClone(composition);
			return { ok: true };
		},
		/**
		 * Back to the standard application: clears every exclusion, requiredness
		 * override, and pinned option subset in one act. The compensating write
		 * behind its receipt is `restoreComposition` with the prior state.
		 */
		async reset(id: string): Promise<MutationOutcome> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return { ok: false, reason: 'This form no longer exists' };
			delete seed.composition;
			return { ok: true };
		},
		/** The compensating write behind a reset receipt: puts the exact prior composition back. */
		async restoreComposition(id: string, composition: FormComposition): Promise<void> {
			await latency();
			const seed = db.forms.find((form) => form.id === id);
			if (!seed) return;
			seed.composition = structuredClone(composition);
		}
	},

	settings: {
		async get(): Promise<EventSettings | null> {
			await latency();
			return db.settings;
		},
		async update(patch: Partial<EventSettings>): Promise<EventSettings | null> {
			await latency();
			if (db.settings) {
				Object.assign(db.settings, patch);
				if (db.settings.startDate && db.settings.endDate) {
					db.settings.dates = formatDateRange(db.settings.startDate, db.settings.endDate);
					if (db.summary.event) db.summary.event.dates = db.settings.dates;
				}
				if (db.summary.event) {
					db.summary.event.name = db.settings.name;
					db.summary.event.location = db.settings.location;
				}
			}
			return db.settings;
		},
		async members(): Promise<Member[]> {
			await latency();
			return db.members;
		},
		async invite(email: string, role: string): Promise<Member> {
			await latency();
			const member: Member = {
				id: `mem-${db.members.length + 1}-${email.length}`,
				name: email.split('@')[0],
				email,
				role,
				status: 'invited'
			};
			db.members.push(member);
			return member;
		},
		async changeRole(id: string, role: string): Promise<MutationOutcome> {
			await latency();
			const member = db.members.find((entry) => entry.id === id);
			if (!member) return { ok: false, reason: 'This member no longer exists' };
			if (member.role === 'Workspace Admin' && role !== 'Workspace Admin' && countActiveAdmins() <= 1) {
				return { ok: false, reason: 'The workspace needs at least one Workspace Admin' };
			}
			member.role = role;
			return { ok: true };
		},
		async removeMember(id: string): Promise<MutationOutcome> {
			await latency();
			const member = db.members.find((entry) => entry.id === id);
			if (!member) return { ok: true };
			if (member.role === 'Workspace Admin' && (member.status ?? 'active') === 'active' && countActiveAdmins() <= 1) {
				return { ok: false, reason: 'The workspace needs at least one Workspace Admin' };
			}
			db.members = db.members.filter((entry) => entry.id !== id);
			return { ok: true };
		}
	}
};

function countActiveAdmins(): number {
	return db.members.filter(
		(member) => member.role === 'Workspace Admin' && (member.status ?? 'active') === 'active'
	).length;
}
