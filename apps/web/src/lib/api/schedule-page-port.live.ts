import type { SessionParticipantRefDto, StructuredOutcome } from '@jooevents/contracts';
import type { CalendarNoticesLiveClient } from './operations/calendar-notices-live';
import type { ReleaseWorkspacePort } from './release-workspace-adapter';
import type { SafeApiError } from './client';
import type {
	ProgramFormatView,
	ProgramRoomView,
	ProgramTrackView
} from './view-models/program-vocabulary';
import type { SchedulePlacementOccurrenceView } from './view-models/schedule-placement';
import type { ScheduleBreakHeadView } from './view-models/schedule-placement';
import type { SessionHeadView } from './view-models/session';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { ScheduleAttachCandidate, SchedulePagePort } from './schedule-page-port';
import type {
	SchedulePlacementApplyResult,
	SchedulePlacementCorePort,
	SchedulePlacementReadResult
} from './schedule-placement-port';
import type {
	SessionCatalogCorePort,
	SessionCatalogReadResult,
	SessionChangeApplyResult
} from './session-catalog-port';
import type { SessionSubmissionRoutePort } from './operations/session-submission-route-live';
import type {
	EventSettings,
	BreakBlock,
	Format,
	MutationOutcome,
	Placement,
	Room,
	ScheduleDayInfo,
	ScheduleState,
	SessionItem,
	SpeakerRow,
	Track
} from './types';

export interface ScheduleAttributionSubmission {
	readonly id: string;
	readonly title: string;
	readonly primaryParticipantName: string;
	readonly source: 'cfp' | 'direct_entry' | 'import';
	readonly decision: 'accepted' | 'waitlisted' | 'declined' | 'withdrawn' | null;
	readonly origin: Readonly<{
		readonly sessionId: string;
		readonly kind: 'spawned' | 'attached';
	}> | null;
}

export type ScheduleAttributionReadResult =
	| { readonly kind: 'success'; readonly data: readonly ScheduleAttributionSubmission[] }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: string };

/** Whole-population accepted-submission routing facts used by the speaker drawer. */
export interface ScheduleAttributionSource {
	readonly source:
		| { readonly kind: 'live' }
		| { readonly kind: 'sample'; readonly label: string };
	read(): Promise<ScheduleAttributionReadResult>;
}

/**
 * The tuned page capabilities this deliberately partial live mount cannot
 * truthfully serve yet, each refused with its own name so a failure states
 * exactly which owner has not joined.
 */
export type SchedulePageLiveUnmountedCapability =
	| 'schedule_unplace'
	| 'session_remove'
	| 'session_attach'
	| 'session_detach'
	| 'session_participants';

/**
 * Read result grammar for {@link ScheduleProposalCountsSource}, mirroring the
 * core-port reads so a composed source forwards canonical failures instead of
 * inventing throw semantics of its own. `unavailable.reason` is a stable code
 * naming which owner has not joined.
 */
export type ScheduleProposalCountsReadResult =
	| { readonly kind: 'success'; readonly data: Readonly<Record<string, number>> }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Open-proposal totals per target session id — the number the tuned page
 * prints on every collecting row.
 *
 * This input is required because the page's contract leaves no honest gap to
 * stand in for it: the page reads an absent key as the positive fact
 * "no proposals yet", states that number as an API-counted total, and sizes
 * its commit receipts by it. An empty record is therefore always the claim
 * "zero open proposals target every session" — never "unknown" — so a source
 * may serve only totals counted by the canonical owner over the whole
 * submission population (undecided, still-recoverable submissions per target
 * session), never a row-window count and never a placeholder.
 */
export interface ScheduleProposalCountsSource {
	/** Live-counted totals only; a sample-backed source must not reach this mount. */
	readonly source:
		| { readonly kind: 'live' }
		| { readonly kind: 'sample'; readonly label: string };
	readOpenProposalCounts(): Promise<ScheduleProposalCountsReadResult>;
}

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** Safe, reviewed-copy failure at the tuned Schedule boundary. */
export class SchedulePageLiveError extends Error {
	readonly code: string;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'SchedulePageLiveError';
		this.code = failure.code;
	}
}

const UNMOUNTED_COPY: Readonly<Record<SchedulePageLiveUnmountedCapability, string>> = Object.freeze({
	schedule_unplace:
		'Removing a session from the schedule is not available in this live workspace yet.',
	session_remove: 'Removing a session is not available in this live workspace yet.',
	session_attach: 'Attaching submissions is not available in this live workspace yet.',
	session_detach: 'Detaching submissions is not available in this live workspace yet.',
	session_participants: 'Session participants are not available in this live workspace yet.'
});

function unmounted(capability: SchedulePageLiveUnmountedCapability): SchedulePageLiveError {
	return new SchedulePageLiveError({ code: capability, reason: UNMOUNTED_COPY[capability] });
}

function refusal(capability: SchedulePageLiveUnmountedCapability): MutationOutcome {
	return { ok: false, reason: UNMOUNTED_COPY[capability] };
}

function outcomeCopy(outcome: StructuredOutcome, subject: string): string {
	if (outcome.class === 'access_denied') {
		return `You no longer have permission to change ${subject}.`;
	}
	if (outcome.class === 'stale_revision' || outcome.class === 'conflict') {
		return `The ${subject} changed while you were working. Reload and try again.`;
	}
	return `This ${subject} change could not be applied.`;
}

function readFailure(
	result: Exclude<
		SessionCatalogReadResult
		| SchedulePlacementReadResult
		| ScheduleProposalCountsReadResult
		| ScheduleAttributionReadResult,
		{ readonly kind: 'success' }
	>,
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: `The ${subject} is not available in this live workspace.` };
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} could not be reached. Try again.`
				: `This ${subject} request is not valid.`
		};
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, subject) };
}

function applyFailure(
	result: Exclude<
		SessionChangeApplyResult | SchedulePlacementApplyResult,
		{ readonly kind: 'success' }
	>,
	subject: string
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: `This ${subject} change is not available in this live workspace.`
		};
	}
	if (result.kind === 'transport_error') {
		return {
			code: result.error.code,
			reason: result.error.retryable
				? `The ${subject} change could not reach JooEvents. Try again.`
				: `This ${subject} change is not valid.`
		};
	}
	return { code: result.outcome.kind, reason: outcomeCopy(result.outcome, subject) };
}

/**
 * Projection of one placement occurrence onto the board. The day key is the
 * occurrence's own UTC calendar date (the canonical basis; re-keying stored
 * occurrences stays deferred), while `startMin` counts from the served
 * geometry's day start on the *event's own* clock — because `dayStart` and
 * `dayEnd` are event-local wall-clock settings and the canonical instant is
 * UTC. While no grid is derived the geometry serves the UTC zone and a
 * midnight day start, so the pair still reads straight off the canonical
 * instant string. Never the browser's locale or zone: the zone is the one the
 * server sent with the event.
 */
function occurrencePlacement(
	occurrence: SchedulePlacementOccurrenceView,
	dayStartMin = 0,
	timeZone = 'UTC'
): Placement {
	const clock = eventLocalClock(occurrence.startAtUtc, timeZone);
	return {
		sessionId: occurrence.sessionId,
		dayKey: occurrence.startAtUtc.slice(0, 10),
		roomId: occurrence.roomId,
		startMin: (clock?.minutes ?? utcMinutes(occurrence.startAtUtc)) - dayStartMin,
		conflicts: []
	};
}

function utcMinutes(instant: string): number {
	return Number(instant.slice(11, 13)) * 60 + Number(instant.slice(14, 16));
}

// ---------------------------------------------------------------------------
// The event's own clock. Canonical occurrence instants are UTC; the Event
// Settings day window (`dayStart`/`dayEnd`) is event-local wall clock, beside
// the event's IANA `timezone`. Reading one against the other is what these
// helpers exist to prevent. The zone is always the served one and the locale
// is pinned, so nothing here depends on the browser's calendar.

const EVENT_CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function eventClockFormatter(timeZone: string): Intl.DateTimeFormat | null {
	const cached = EVENT_CLOCK_FORMATTERS.get(timeZone);
	if (cached !== undefined) return cached;
	let formatter: Intl.DateTimeFormat | null = null;
	try {
		formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		});
	} catch {
		// An unrecognized zone is not a reason to invent geometry; the caller
		// falls back to the canonical UTC basis it already served.
		formatter = null;
	}
	EVENT_CLOCK_FORMATTERS.set(timeZone, formatter);
	return formatter;
}

/** The zone the derivation will actually use — the served one, or UTC. */
function resolveEventTimeZone(timezone: string | undefined | null): string {
	return typeof timezone === 'string' && eventClockFormatter(timezone) ? timezone : 'UTC';
}

interface EventLocalClock {
	/** The event-local calendar date the instant falls on (`yyyy-mm-dd`). */
	readonly dayKey: string;
	/** Minutes from event-local midnight. */
	readonly minutes: number;
}

/** Reads a canonical UTC instant on the event's own wall clock. */
function eventLocalClock(instant: string, timeZone: string): EventLocalClock | null {
	const epoch = Date.parse(instant);
	if (!Number.isFinite(epoch)) return null;
	const formatter = eventClockFormatter(timeZone);
	if (!formatter) return null;
	const parts = formatter.formatToParts(new Date(epoch));
	const read = (type: string): string | undefined =>
		parts.find((part) => part.type === type)?.value;
	const year = read('year');
	const month = read('month');
	const day = read('day');
	const hour = read('hour');
	const minute = read('minute');
	if (!year || !month || !day || !hour || !minute) return null;
	// Some ICU builds still render event-local midnight as hour 24 under h23.
	const minutes = (Number(hour) % 24) * 60 + Number(minute);
	return Number.isFinite(minutes) ? { dayKey: `${year}-${month}-${day}`, minutes } : null;
}

/**
 * Mints the canonical UTC instant naming a wall-clock time on the event's own
 * calendar — the inverse of {@link eventLocalClock}, and the write side of the
 * board's basis. Two passes settle the zone offset (the second covers a slot
 * that lands on the far side of a DST transition), and the result is verified
 * by reading it back: a wall clock that does not exist in the zone (the spring
 * gap) mints nothing rather than a silently shifted instant.
 */
function mintEventLocalInstant(
	dayKey: string,
	minutes: number,
	timeZone: string
): string | null {
	const midnight = parseUtcDate(dayKey);
	if (midnight === null || !Number.isInteger(minutes) || minutes < 0 || minutes >= 1_440) {
		return null;
	}
	const wall = midnight + minutes * 60_000;
	let candidate = wall;
	for (let pass = 0; pass < 2; pass += 1) {
		const clock = eventLocalClock(new Date(candidate).toISOString(), timeZone);
		if (!clock) return null;
		const observed = parseUtcDate(clock.dayKey);
		if (observed === null) return null;
		const next = wall - (observed + clock.minutes * 60_000 - candidate);
		if (next === candidate) break;
		candidate = next;
	}
	const settled = eventLocalClock(new Date(candidate).toISOString(), timeZone);
	return settled && settled.dayKey === dayKey && settled.minutes === minutes
		? new Date(candidate).toISOString()
		: null;
}

// ---------------------------------------------------------------------------
// Day geometry, derived from canonical Event Settings (recorded Wave-2
// defaults): the board's day list is the event's own date strings and the day
// window is the served dayStart/dayEnd/slotMinutes trio. Nothing here reads
// the browser locale or timezone.

/** The one settings read the geometry derivation performs. */
export interface ScheduleGeometrySettingsSource {
	get(): Promise<EventSettings | null>;
}

export interface DerivedScheduleGeometry {
	/**
	 * True only when the served trio is complete and coherent, the event's
	 * date range derives a bounded day list, and every placement-derived UTC
	 * day key (and its time window) lands inside it. Exactly then the tuned
	 * board may draw its calendar; any other state is the honest no-grid
	 * state, never a partial or guessed grid.
	 */
	readonly localCalendarReady: boolean;
	readonly days: readonly ScheduleDayInfo[];
	readonly dayStart: string;
	readonly dayStartMin: number;
	readonly slotMinutes: number;
	readonly slotsPerDay: number;
	/**
	 * The event's own IANA zone, in which `dayStart`/`dayEnd` are read and in
	 * which the board's slots are minted back to canonical instants. `UTC`
	 * whenever no grid is derived or the served zone is unrecognized.
	 */
	readonly timeZone: string;
}

const NO_GRID_GEOMETRY: DerivedScheduleGeometry = Object.freeze({
	localCalendarReady: false,
	days: Object.freeze([]),
	// Inert tuned defaults for a board that draws nothing: placements stay
	// UTC-midnight based so "placed" remains a true, round-trippable claim,
	// and `slotMinutes` keeps the direct-entry duration suggestion plausible
	// without stating anything about event geometry.
	dayStart: '00:00',
	dayStartMin: 0,
	slotMinutes: 30,
	slotsPerDay: 0,
	timeZone: 'UTC'
});

/**
 * Defensive fence, not product semantics: the recorded geometry default
 * derives one column per event date, and a pathological range (a mistyped
 * year) would otherwise ask the board for thousands of columns. Beyond this
 * bound the derivation serves the honest no-grid state.
 */
const GEOMETRY_MAX_DAYS = 62;

const UTC_WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const UTC_MONTHS = Object.freeze([
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]);

function parseUtcDate(value: string | undefined | null): number | null {
	if (typeof value !== 'string') return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
}

function parseDayClock(value: string | undefined | null): number | null {
	if (typeof value !== 'string') return null;
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) return null;
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
}

/** Deterministic UTC day label ("Tue Oct 13") — the sample boards' shape, no locale. */
function dayLabel(epochMs: number): string {
	const date = new Date(epochMs);
	return `${UTC_WEEKDAYS[date.getUTCDay()]} ${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/**
 * Derives the board's day geometry from the served Event Settings and checks
 * it against the canonical placements (recorded Wave-2 geometry defaults).
 *
 * The grid gate, exactly: settings exist; `startDate`/`endDate` are real UTC
 * dates in order and span at most {@link GEOMETRY_MAX_DAYS} days; the
 * `dayStart`/`dayEnd`/`slotMinutes` trio is fully non-null and coherent
 * (`dayEnd` after `dayStart`, slots divide the window exactly); and every
 * occurrence's UTC day key lands inside the derived day list with its whole
 * `[start, end]` inside the day window. Any mismatch — a placement on a date
 * outside the event, or at a time the window cannot draw — serves the
 * no-grid state rather than a grid that hides a real placement. Event-local
 * re-keying stays an explicitly deferred basis migration; day keys remain
 * canonical UTC dates.
 */
export function deriveScheduleGeometry(input: {
	readonly settings: EventSettings | null;
	readonly occurrences: readonly Pick<SchedulePlacementOccurrenceView, 'startAtUtc' | 'endAtUtc'>[];
}): DerivedScheduleGeometry {
	const settings = input.settings;
	if (!settings) return NO_GRID_GEOMETRY;
	const startEpoch = parseUtcDate(settings.startDate);
	const endEpoch = parseUtcDate(settings.endDate);
	const dayStartMin = parseDayClock(settings.dayStart);
	const dayEndMin = parseDayClock(settings.dayEnd);
	const slotMinutes = settings.slotMinutes ?? null;
	if (
		startEpoch === null
		|| endEpoch === null
		|| endEpoch < startEpoch
		|| dayStartMin === null
		|| dayEndMin === null
		|| slotMinutes === null
		|| dayEndMin <= dayStartMin
		|| !Number.isInteger(slotMinutes)
		|| slotMinutes <= 0
		|| (dayEndMin - dayStartMin) % slotMinutes !== 0
	) {
		return NO_GRID_GEOMETRY;
	}
	const dayCount = Math.round((endEpoch - startEpoch) / 86_400_000) + 1;
	if (dayCount > GEOMETRY_MAX_DAYS) return NO_GRID_GEOMETRY;
	const days: ScheduleDayInfo[] = [];
	const keys = new Set<string>();
	for (let index = 0; index < dayCount; index += 1) {
		const epoch = startEpoch + index * 86_400_000;
		const key = new Date(epoch).toISOString().slice(0, 10);
		keys.add(key);
		days.push({ key, label: dayLabel(epoch) });
	}
	// The day window is event-local wall clock, so every occurrence is read on
	// the event's own clock before it is checked against that window — a
	// UTC-versus-wall-clock comparison would refuse the grid for every event
	// outside UTC (a 09:30 Berlin session is 07:30Z, "before" a 09:00 window).
	// Day keys stay the canonical UTC date, so an occurrence whose event-local
	// date differs from its UTC date is still a mismatch: that is the deferred
	// re-keying, and it renders the honest no-grid state rather than a shifted
	// column.
	const timeZone = resolveEventTimeZone(settings.timezone);
	for (const occurrence of input.occurrences) {
		const key = occurrence.startAtUtc.slice(0, 10);
		const start = eventLocalClock(occurrence.startAtUtc, timeZone);
		const end = eventLocalClock(occurrence.endAtUtc, timeZone);
		if (
			!start
			|| !end
			|| !keys.has(key)
			|| occurrence.endAtUtc.slice(0, 10) !== key
			|| start.dayKey !== key
			|| end.dayKey !== key
			|| start.minutes < dayStartMin
			|| end.minutes > dayEndMin
		) {
			return NO_GRID_GEOMETRY;
		}
	}
	return Object.freeze({
		localCalendarReady: true,
		days: Object.freeze(days),
		dayStart: settings.dayStart as string,
		dayStartMin,
		slotMinutes,
		slotsPerDay: (dayEndMin - dayStartMin) / slotMinutes,
		timeZone
	});
}

function addMinutes(instant: string, minutes: number): string {
	return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

/**
 * Canonical Session identity only: every row comes from the Session catalog
 * head, never from an occurrence, a form label, or a submission title. Roster
 * participants are resolved through the joined engagement/person projection;
 * the canonical Person id stays on every live row. `originSubmissionIds`
 * stays absent because provenance is read from the Decision owner, not copied
 * into the Session head.
 */
function sessionItem(
	head: SessionHeadView,
	peopleById: ReadonlyMap<string, SpeakerRow>
): SessionItem {
	const speakers = head.roster.participants.map((participant) => {
		const person = peopleById.get(participant.personId);
		if (!person || person.name.trim() === '' || person.email.trim() === '') {
			throw new SchedulePageLiveError({
				code: 'session_participant_projection_unavailable',
				reason: 'A person on this Session cannot be resolved from the current speaker roster.'
			});
		}
		return {
			personId: participant.personId,
			name: person.name,
			email: person.email,
			role: participant.role,
			position: participant.position
		};
	});
	return {
		id: head.id,
		title: head.title,
		speakers,
		trackId: head.programTarget.track?.id ?? '',
		formatId: head.programTarget.format.id,
		durationMin: head.plannedDurationMinutes,
		state: head.lifecycle
	};
}

function liveBreak(head: ScheduleBreakHeadView): BreakBlock {
	return {
		id: head.id,
		label: head.label,
		dayKey: head.dayKey,
		roomId: head.roomId,
		startMin: head.startMin,
		durationMin: head.endMin - head.startMin
	};
}

/**
 * Forward-only lifecycle order. A target below the current canonical head is
 * not a refusable request — no operation exists that could ever satisfy it.
 */
const SESSION_LIFECYCLE_ORDER: Readonly<Record<SessionItem['state'], number>> = Object.freeze({
	draft: 0,
	collecting: 1,
	programmed: 2
});

function liveRoom(room: ProgramRoomView): Room {
	return {
		id: room.id,
		name: room.name,
		capacity: room.capacity,
		status: room.status,
		usage: { ...room.usage }
	};
}

function liveTrack(track: ProgramTrackView): Track {
	return {
		id: track.id,
		name: track.name,
		accent: track.accent,
		status: track.status,
		usage: { ...track.usage }
	};
}

function liveFormat(format: ProgramFormatView): Format {
	return {
		id: format.id,
		name: format.name,
		status: format.status,
		usage: { ...format.usage }
	};
}

/**
 * The whole canonical UTC span the placement snapshot read accepts, so the
 * board and `place` see every occurrence and the current schedule version.
 */
const FULL_PLACEMENT_RANGE = Object.freeze({
	startAt: '1970-01-01T00:00:00.000Z',
	endAt: '9999-12-31T23:59:59.999Z',
	limit: 2_000
});

function defaultIdempotencyKey(): string {
	return `je.schedule.page.action.${globalThis.crypto.randomUUID()}`;
}

/**
 * Live tuned Schedule page port over the deliberately partial canonical mount:
 * the Session catalog (read, create, target repair, and forward-only
 * transition through draft -> propose -> commit), canonical placement occurrences, the live
 * Program Vocabulary, and a required open-proposal totals source — the page
 * prints those totals as positive per-session facts, so no live mount may run
 * without a canonical counter behind them. Everything else surfaces its typed
 * refusal or its typed absence — never sample fallback, fabricated zeros, or
 * silent no-ops.
 *
 * Forward-only consequence the composition owner must carry: the tuned page
 * records an "Add to program" receipt whose undo asks the session back into
 * its prior state, and live sessions never move backward, so that recorded
 * compensator can never be satisfied by this mount. `transitionSession`
 * rejects such never-satisfiable targets with a typed error instead of
 * resolving a refusal — the page's undo path discards resolved outcomes, and
 * a resolved refusal would let the receipt present an unchanged session as
 * successfully undone.
 *
 * Day geometry derives from canonical Event Settings through the composed
 * settings source ({@link deriveScheduleGeometry}): the grid renders only
 * while the served `dayStart`/`dayEnd`/`slotMinutes` trio is complete and
 * every placement-derived UTC day key lands inside the event's own date
 * range. Any mismatch or an absent trio serves the honest no-grid state, the
 * UTC-only time basis stays intact, and no local calendar is ever derived
 * from the browser locale.
 */
export function createLiveSchedulePagePort(input: {
	readonly placements: SchedulePlacementCorePort;
	readonly sessions: SessionCatalogCorePort;
	readonly vocabulary: ProgramVocabularySettingsPort;
	readonly proposals: ScheduleProposalCountsSource;
	readonly attribution: ScheduleAttributionSource;
	readonly attributionMutations: SessionSubmissionRoutePort;
	readonly settings: ScheduleGeometrySettingsSource;
	readonly publication: Pick<ReleaseWorkspacePort, 'overview' | 'draftSchedulePublication' | 'publishSchedule'>;
	readonly speakers: SchedulePagePort['speakers'];
	readonly templates: SchedulePagePort['templates'];
	readonly calendar?: CalendarNoticesLiveClient;
	readonly newIdempotencyKey?: () => string;
}): SchedulePagePort {
	if (
		input.placements.source.kind !== 'live'
		|| input.sessions.source.kind !== 'live'
		|| input.vocabulary.source.kind !== 'live'
		|| input.proposals.source.kind !== 'live'
		|| input.attribution.source.kind !== 'live'
		|| input.attributionMutations.source.kind !== 'live'
	) {
		throw new TypeError('live_schedule_source_required');
	}
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;

	/**
	 * The geometry the board's slots are expressed in — pinned by the newest
	 * `state()` this port served. `place` receives `startMin` relative to that
	 * served day window, so the canonical instant is minted under exactly this
	 * basis: re-deriving from a fresh settings read at write time silently
	 * re-timed a drop whenever the trio changed (or a concurrent out-of-window
	 * occurrence collapsed the derivation to the midnight basis) between render
	 * and commit. A board that never received a ready grid cannot have handed
	 * out a slot, so `place` refuses typed instead of guessing a basis.
	 */
	let servedGeometry: DerivedScheduleGeometry | null = null;
	/** Includes removed heads returned by this port so receipts can restore exact ids. */
	const knownBreakHeads = new Map<string, ScheduleBreakHeadView>();
	/** Exact route plans retained only for the receipt's immediate guarded restore. */
	const attachRecoveries = new Map<string,
		| { readonly kind: 'attach'; readonly plan: import('@jooevents/contracts').SessionSubmissionAttachPlanDto }
		| { readonly kind: 'move'; readonly plan: import('@jooevents/contracts').SessionSubmissionMovePlanDto }
	>();
	const attachRecoveryKey = (sessionId: string, submissionId: string) => `${sessionId}:${submissionId}`;
	const participantRecoveries = new Map<string, Readonly<{
		participant: SessionParticipantRefDto;
		expectedSession: SessionHeadView;
	}>>();
	const participantRecoveryKey = (sessionId: string, personId: string) => `${sessionId}:${personId}`;
	const roleRecoveries = new Map<string, Readonly<{
		role: SessionParticipantRefDto['role'];
		expectedSession: SessionHeadView;
	}>>();
	const orderRecoveries = new Map<string, Readonly<{
		personIds: readonly string[];
		expectedSession: SessionHeadView;
	}>>();

	async function readCatalog() {
		const result = await input.sessions.readCatalog();
		if (result.kind !== 'success') {
			throw new SchedulePageLiveError(readFailure(result, 'session catalog'));
		}
		return result.data;
	}

	async function readPlacements() {
		const result = await input.placements.readPlacements(FULL_PLACEMENT_RANGE);
		if (result.kind !== 'success') {
			throw new SchedulePageLiveError(readFailure(result, 'schedule'));
		}
		for (const head of result.data.breaks ?? []) knownBreakHeads.set(head.id, head);
		return result.data;
	}

	async function readPeopleById(): Promise<ReadonlyMap<string, SpeakerRow>> {
		const peopleById = new Map<string, SpeakerRow>();
		for (const person of await input.speakers.list()) {
			if (person.personId === undefined) continue;
			if (peopleById.has(person.personId)) {
				throw new SchedulePageLiveError({
					code: 'session_participant_projection_ambiguous',
					reason: 'The current speaker roster contains more than one row for the same person.'
				});
			}
			peopleById.set(person.personId, person);
		}
		return peopleById;
	}

	async function readAttribution(): Promise<readonly ScheduleAttributionSubmission[]> {
		const result = await input.attribution.read();
		if (result.kind !== 'success') {
			throw new SchedulePageLiveError(readFailure(result, 'session attribution'));
		}
		return result.data;
	}

	return Object.freeze({
		workspace: Object.freeze({
			/** No live workspace summary is composed here; null is "not read yet". */
			scheduleAttentionExpectedSnapshot(): boolean | null {
				return null;
			}
		}),
		...(input.calendar ? { calendar: Object.freeze({
			async listNotices() {
				const result = await input.calendar!.list();
				if (result.kind !== 'success') {
					throw new SchedulePageLiveError({
						code: result.kind === 'outcome' ? result.outcome.kind : result.kind,
						reason: 'Pending calendar updates could not be loaded.'
					});
				}
				return result.data;
			},
			async setNoticeHold(generationId, expectedVersion, held) {
				const result = await input.calendar!.control({
					action: 'set_hold', generationId, expectedVersion, held
				});
				if (result.kind !== 'success') throw new SchedulePageLiveError({
					code: result.kind === 'outcome' ? result.outcome.kind : result.kind,
					reason: 'The calendar hold could not be changed. Reload and try again.'
				});
			},
			async releaseNotice(generationId, expectedVersion) {
				const result = await input.calendar!.control({
					action: 'release_now', generationId, expectedVersion
				});
				if (result.kind !== 'success') throw new SchedulePageLiveError({
					code: result.kind === 'outcome' ? result.outcome.kind : result.kind,
					reason: 'The calendar updates could not be released. Reload and try again.'
				});
			}
		}) } : {}),
		schedule: Object.freeze({
			async state(): Promise<ScheduleState> {
				const [catalog, placements, rooms, settings, publication, peopleById] = await Promise.all([
					readCatalog(),
					readPlacements(),
					input.vocabulary.rooms(),
					input.settings.get(),
					input.publication.overview(),
					readPeopleById()
				]);
				// Geometry is a served derivation, never a guess: the grid draws
				// exactly when the settings trio and every placement reconcile
				// (`deriveScheduleGeometry`); otherwise the day list stays empty
				// and the page's own boardReady gate renders the no-grid state.
				const geometry = deriveScheduleGeometry({
					settings,
					occurrences: placements.occurrences
				});
				servedGeometry = geometry;
				return {
					days: [...geometry.days],
					rooms: rooms.map(liveRoom),
					dayStart: geometry.dayStart,
					slotMinutes: geometry.slotMinutes,
					slotsPerDay: geometry.slotsPerDay,
					sessions: catalog.sessions.map((head) => sessionItem(head, peopleById)),
					placements: placements.occurrences.map((occurrence) =>
						occurrencePlacement(occurrence, geometry.dayStartMin, geometry.timeZone)
					),
					breaks: (placements.breaks ?? []).map(liveBreak),
					published: publication.currentProgramRelease !== null
						&& publication.surfaceHeads.some((head) => head.kind === 'schedule')
				};
			},
			/**
			 * Honest totals only: the page renders an absent key as the positive
			 * fact "no proposals yet", so this read never substitutes an empty
			 * record for a source it does not have. Anything but a counted result
			 * rejects with the typed error, exactly like the state reads it loads
			 * beside — an unavailable counter is a failed load, never a zero.
			 */
			async proposalTargets(): Promise<Record<string, number>> {
				const result = await input.proposals.readOpenProposalCounts();
				if (result.kind !== 'success') {
					throw new SchedulePageLiveError(readFailure(result, 'proposal count'));
				}
				return { ...result.data };
			},
			async place(
				sessionId: string,
				dayKey: string,
				roomId: string,
				startMin: number
			): Promise<Placement> {
				// A slot that names no real day key refuses before any request; the
				// exact instant is minted under the pinned served geometry, which
				// restores the day-window offset the board handed the slot in.
				if (parseUtcDate(dayKey) === null || !Number.isInteger(startMin) || startMin < 0) {
					throw new SchedulePageLiveError({
						code: 'invalid_slot',
						reason: 'This slot does not name a canonical UTC day and time.'
					});
				}
				// The board hands slots back in the same geometry `state()` served
				// them in — minutes from the derived day start — so the mint uses
				// that pinned basis, never a fresh write-time re-derivation that a
				// concurrent settings change (or an out-of-window occurrence
				// collapsing the derivation) would silently re-time.
				const geometry = servedGeometry;
				if (geometry === null || !geometry.localCalendarReady) {
					throw new SchedulePageLiveError({
						code: 'schedule_geometry_unready',
						reason: 'The schedule day grid is not being served right now. Reload the schedule and try again.'
					});
				}
				if (
					!geometry.days.some((day) => day.key === dayKey)
					|| startMin >= geometry.slotsPerDay * geometry.slotMinutes
				) {
					// A slot outside the pinned grid means the board that offered it
					// rendered an older basis than the one this port now serves.
					throw new SchedulePageLiveError({
						code: 'schedule_geometry_stale',
						reason: 'The schedule day grid changed while you were working. Reload and try again.'
					});
				}
				const catalog = await readCatalog();
				const head = catalog.sessions.find((session) => session.id === sessionId);
				if (!head) {
					throw new SchedulePageLiveError({
						code: 'session_missing',
						reason: 'This session no longer exists. Reload and try again.'
					});
				}
				const snapshot = await readPlacements();
				// The board's slots are event-local wall clock — the basis `state()`
				// served — so the canonical instant is minted in the pinned zone. A
				// wall clock the zone skips (the spring-forward gap) mints nothing
				// rather than an hour the organizer did not choose.
				const startAt = mintEventLocalInstant(
					dayKey,
					geometry.dayStartMin + startMin,
					geometry.timeZone
				);
				if (startAt === null) {
					throw new SchedulePageLiveError({
						code: 'invalid_slot',
						reason: 'This slot does not name a real time on the event’s calendar.'
					});
				}
				const existing = snapshot.occurrences.filter(
					(occurrence) => occurrence.sessionId === sessionId
				);
				if (existing.length > 1) {
					throw new SchedulePageLiveError({
						code: 'invalid_contract',
						reason: 'This session holds more than one slot; the board cannot move it safely.'
					});
				}
				const endAt = addMinutes(startAt, head.plannedDurationMinutes);
				const current = existing[0];
				const applied = await input.placements.applyChange(
					current
						? {
								action: 'move',
								expectedScheduleVersion: snapshot.scheduleVersion,
								occurrenceId: current.id,
								expectedOccurrenceVersion: current.version,
								roomId,
								startAt,
								endAt
							}
						: {
								action: 'place',
								expectedScheduleVersion: snapshot.scheduleVersion,
								sessionId,
								roomId,
								startAt,
								endAt
							},
					newIdempotencyKey()
				);
				if (applied.kind !== 'success') {
					throw new SchedulePageLiveError(applyFailure(applied, 'placement'));
				}
				if (!('occurrence' in applied.data) || applied.data.occurrence === null) {
					throw new SchedulePageLiveError({
						code: 'invalid_contract', reason: 'The placement result was incomplete.'
					});
				}
				return occurrencePlacement(
					applied.data.occurrence,
					geometry.dayStartMin,
					geometry.timeZone
				);
			},
			async unplace(sessionId: string): Promise<void> {
				const snapshot = await readPlacements();
				const current = snapshot.occurrences.find((entry) => entry.sessionId === sessionId);
				if (!current) return;
				const applied = await input.placements.applyChange({
					action: 'unplace', expectedScheduleVersion: snapshot.scheduleVersion,
					occurrenceId: current.id, expectedOccurrenceVersion: current.version
				} as never, newIdempotencyKey());
				if (applied.kind !== 'success') throw new SchedulePageLiveError(applyFailure(applied, 'placement'));
			},
			async addBreak(create): Promise<BreakBlock[]> {
				const geometry = servedGeometry;
				if (geometry === null || !geometry.localCalendarReady
					|| !geometry.days.some((day) => day.key === create.dayKey)
					|| !Number.isInteger(create.startMin)
					|| !Number.isInteger(create.durationMin)
					|| create.startMin < 0
					|| create.durationMin <= 0
					|| create.startMin + create.durationMin > geometry.slotsPerDay * geometry.slotMinutes) {
					throw new SchedulePageLiveError({
						code: 'invalid_break_geometry',
						reason: 'This break no longer fits the served schedule day. Reload and try again.'
					});
				}
				const snapshot = await readPlacements();
				const applied = await input.placements.applyChange({
					action: 'break_add',
					expectedScheduleVersion: snapshot.scheduleVersion,
					label: create.label.trim(),
					dayKey: create.dayKey,
					roomIds: create.roomIds,
					startMin: create.startMin,
					endMin: create.startMin + create.durationMin
				}, newIdempotencyKey());
				if (applied.kind !== 'success') {
					throw new SchedulePageLiveError(applyFailure(applied, 'schedule break'));
				}
				if (applied.data.action !== 'break_add') {
					throw new SchedulePageLiveError({ code: 'invalid_contract', reason: 'The break result was incomplete.' });
				}
				for (const head of applied.data.breaks) knownBreakHeads.set(head.id, head);
				return applied.data.breaks.map(liveBreak);
			},
			async removeBreaks(ids): Promise<void> {
				const snapshot = await readPlacements();
				const selected = ids.map((id) => snapshot.breaks.find((head) => head.id === id));
				if (selected.some((head) => head === undefined)) {
					throw new SchedulePageLiveError({
						code: 'break_missing', reason: 'A selected break changed while you were working. Reload and try again.'
					});
				}
				const applied = await input.placements.applyChange({
					action: 'break_remove',
					expectedScheduleVersion: snapshot.scheduleVersion,
					breaks: selected.map((head) => ({ id: head!.id, expectedVersion: head!.version }))
				}, newIdempotencyKey());
				if (applied.kind !== 'success') {
					throw new SchedulePageLiveError(applyFailure(applied, 'schedule break'));
				}
				if (applied.data.action !== 'break_remove') {
					throw new SchedulePageLiveError({ code: 'invalid_contract', reason: 'The break result was incomplete.' });
				}
				for (const head of applied.data.breaks) knownBreakHeads.set(head.id, head);
			},
			async restoreBreaks(ids): Promise<BreakBlock[]> {
				const snapshot = await readPlacements();
				const selected = ids.map((id) => knownBreakHeads.get(id));
				if (selected.some((head) => head?.status !== 'removed')) {
					throw new SchedulePageLiveError({
						code: 'break_missing', reason: 'This break can no longer be restored. Reload and try again.'
					});
				}
				const applied = await input.placements.applyChange({
					action: 'break_restore',
					expectedScheduleVersion: snapshot.scheduleVersion,
					breaks: selected.map((head) => ({ id: head!.id, expectedVersion: head!.version }))
				}, newIdempotencyKey());
				if (applied.kind !== 'success') {
					throw new SchedulePageLiveError(applyFailure(applied, 'schedule break'));
				}
				if (applied.data.action !== 'break_restore') {
					throw new SchedulePageLiveError({ code: 'invalid_contract', reason: 'The break result was incomplete.' });
				}
				for (const head of applied.data.breaks) knownBreakHeads.set(head.id, head);
				return applied.data.breaks.map(liveBreak);
			},
			/**
			 * The reviewed lane, exactly as the Release owner serves it: one
			 * draft request produces the safe diff a person reads, and the
			 * second press publishes that same revision. The adapter fences the
			 * release chain, so a schedule published elsewhere in the meantime
			 * refuses rather than overwriting.
			 */
			draftPublication() {
				return input.publication.draftSchedulePublication();
			},
			publishReviewed(review) {
				return input.publication.publishSchedule(review);
			},
			async createSession(create: {
				title: string;
				trackId: string;
				formatId: string;
				durationMin: number;
				state: SessionItem['state'];
			}): Promise<SessionItem> {
				const catalog = await readCatalog();
				const applied = await input.sessions.applyChange(
					{
						action: 'create',
						expectedCatalogVersion: catalog.version,
						expectedCatalogDigestSha256: catalog.digestSha256,
						title: create.title,
						plannedDurationMinutes: create.durationMin,
						lifecycle: create.state,
						formatId: create.formatId,
						// Empty is truthful only for a private draft or a track-free
						// event; the canonical planner enforces that lifecycle boundary.
						trackId: create.trackId === '' ? null : create.trackId
					},
					newIdempotencyKey()
				);
				if (applied.kind !== 'success') {
					throw new SchedulePageLiveError(applyFailure(applied, 'session'));
				}
				if (applied.data.session === null) {
					throw new SchedulePageLiveError({
						code: 'invalid_contract', reason: 'The session result was incomplete.'
					});
				}
				return sessionItem(applied.data.session, await readPeopleById());
			},
			async retargetSession(
				id: string,
				formatId: string,
				trackId: string
			): Promise<SessionItem> {
				const catalogResult = await input.sessions.readCatalog();
				if (catalogResult.kind !== 'success') {
					throw new SchedulePageLiveError(readFailure(catalogResult, 'session catalog'));
				}
				const head = catalogResult.data.sessions.find((session) => session.id === id);
				if (!head) {
					throw new SchedulePageLiveError({
						code: 'session_missing',
						reason: 'This session no longer exists. Reload and try again.'
					});
				}
				const applied = await input.sessions.applyChange(
					{
						action: 'retarget',
						expectedCatalogVersion: catalogResult.data.version,
						expectedCatalogDigestSha256: catalogResult.data.digestSha256,
						sessionId: id,
						expectedSessionVersion: head.version,
						expectedSessionDigestSha256: head.digestSha256,
						formatId,
						trackId: trackId === '' ? null : trackId
					},
					newIdempotencyKey()
				);
				if (applied.kind !== 'success') {
					throw new SchedulePageLiveError(applyFailure(applied, 'session'));
				}
				if (applied.data.session === null) throw new TypeError('session_retarget_result_missing');
				return sessionItem(applied.data.session, await readPeopleById());
			},
			async removeSession(id: string): Promise<MutationOutcome> {
				const catalog = await readCatalog();
				const head = catalog.sessions.find((session) => session.id === id);
				if (!head) return { ok: false, reason: 'This session no longer exists.' };
				const applied = await input.sessions.applyChange({
					action: 'remove_new_session', expectedCatalogVersion: catalog.version,
					expectedCatalogDigestSha256: catalog.digestSha256, sessionId: id,
					expectedSessionVersion: 1, expectedSessionDigestSha256: head.digestSha256
				} as never, newIdempotencyKey());
				return applied.kind === 'success' ? { ok: true } : { ok: false, reason: applyFailure(applied, 'session').reason };
			},
			/**
			 * Resolved `{ ok: false }` is reserved for refusals of a satisfiable
			 * request (a stale head, lost access, a transient read failure) — the
			 * page displays those. A target the forward-only domain can never
			 * satisfy rejects on the error channel instead: the page's recorded
			 * undo awaits this call without reading the outcome, and a resolved
			 * refusal there would retire the receipt as undone while the session
			 * stayed exactly where it was.
			 */
			async transitionSession(
				id: string,
				to: SessionItem['state']
			): Promise<MutationOutcome> {
				if (to === 'draft') {
					// No transition to draft exists at all; rejected before any request.
					throw new SchedulePageLiveError({
						code: 'session_transition_backward',
						reason: 'Sessions move forward only — a session cannot return to draft.'
					});
				}
				const catalogResult = await input.sessions.readCatalog();
				if (catalogResult.kind !== 'success') {
					return { ok: false, reason: readFailure(catalogResult, 'session catalog').reason };
				}
				const head = catalogResult.data.sessions.find((session) => session.id === id);
				if (!head) {
					return { ok: false, reason: 'This session no longer exists. Reload and try again.' };
				}
				if (SESSION_LIFECYCLE_ORDER[to] < SESSION_LIFECYCLE_ORDER[head.lifecycle]) {
					// Backward from the current canonical head — never satisfiable.
					throw new SchedulePageLiveError({
						code: 'session_transition_backward',
						reason: 'Sessions move forward only — this session cannot return to an earlier stage.'
					});
				}
				const applied = await input.sessions.applyChange(
					{
						action: 'transition',
						expectedCatalogVersion: catalogResult.data.version,
						expectedCatalogDigestSha256: catalogResult.data.digestSha256,
						sessionId: id,
						expectedSessionVersion: head.version,
						expectedSessionDigestSha256: head.digestSha256,
						to
					},
					newIdempotencyKey()
				);
				return applied.kind === 'success'
					? { ok: true }
					: { ok: false, reason: applyFailure(applied, 'session').reason };
			},
			async sessionOrigins(sessionId: string): Promise<
				{
					id: string;
					title: string;
					source: 'cfp' | 'direct_entry' | 'import';
					speakerEmails: string[];
				}[]
			> {
				const [catalog, attribution, peopleById] = await Promise.all([
					readCatalog(), readAttribution(), readPeopleById()
				]);
				const session = catalog.sessions.find((head) => head.id === sessionId);
				if (!session) return [];
				return attribution
					.filter((row) => row.origin?.sessionId === sessionId)
					.map((row) => ({
						id: row.id,
						title: row.title,
						source: row.source,
						speakerEmails: session.roster.participants
							.filter((participant) =>
								participant.source.kind === 'submission'
								&& participant.source.id === row.id
							)
							.map((participant) => peopleById.get(participant.personId)?.email)
							.filter((email): email is string => email !== undefined)
					}));
			},
			async attachCandidates(sessionId): Promise<ScheduleAttachCandidate[]> {
				const [attribution, catalog] = await Promise.all([readAttribution(), readCatalog()]);
				const sessionTitles = new Map(catalog.sessions.map((session) => [session.id, session.title]));
				return attribution
					.filter((row) => row.decision === 'accepted' && row.origin?.sessionId !== sessionId)
					.map((row) => ({
						id: row.id,
						title: row.title,
						speakers: [{ name: row.primaryParticipantName }],
						...(row.origin ? { moveFrom: {
							sessionId: row.origin.sessionId,
							sessionTitle: sessionTitles.get(row.origin.sessionId) ?? 'another session'
						} } : {})
					}));
			},
			async attachSubmission(sessionId: string, submissionId: string): Promise<MutationOutcome> {
				const [catalog, attribution] = await Promise.all([readCatalog(), readAttribution()]);
				const session = catalog.sessions.find((head) => head.id === sessionId);
				if (!session) return { ok: false, reason: 'This session no longer exists.' };
				const route = attribution.find((row) => row.id === submissionId);
				if (!route || route.decision !== 'accepted') {
					return { ok: false, reason: 'This accepted talk is no longer available.' };
				}
				if (route.origin) {
					const source = catalog.sessions.find((head) => head.id === route.origin!.sessionId);
					if (!source) return { ok: false, reason: 'The talk’s current session no longer exists.' };
					const applied = await input.attributionMutations.apply({
						action: 'move',
						expectedCatalogVersion: catalog.version,
						expectedCatalogDigestSha256: catalog.digestSha256,
						submissionId,
						sourceSessionId: source.id,
						expectedSourceSessionVersion: source.version,
						expectedSourceSessionDigestSha256: source.digestSha256,
						targetSessionId: session.id,
						expectedTargetSessionVersion: session.version,
						expectedTargetSessionDigestSha256: session.digestSha256
					}, newIdempotencyKey());
					if (applied.kind !== 'success' || applied.data.action !== 'move') {
						return applied.kind === 'success'
							? { ok: false, reason: 'The submission move result was incomplete.' }
							: { ok: false, reason: applyFailure(applied as never, 'submission move').reason };
					}
					attachRecoveries.set(attachRecoveryKey(sessionId, submissionId), {
						kind: 'move', plan: applied.data.recovery
					});
					return { ok: true };
				}
				const applied = await input.attributionMutations.apply({
					action: 'attach_unlinked',
					expectedCatalogVersion: catalog.version,
					expectedCatalogDigestSha256: catalog.digestSha256,
					expectedSessionVersion: session.version,
					expectedSessionDigestSha256: session.digestSha256,
					targetSessionId: sessionId,
					submissionId
				}, newIdempotencyKey());
				if (applied.kind !== 'success') {
					return { ok: false, reason: applyFailure(applied as never, 'submission route').reason };
				}
				if (applied.data.action !== 'attach_unlinked') {
					return { ok: false, reason: 'The submission route result was incomplete.' };
				}
				attachRecoveries.set(
					attachRecoveryKey(sessionId, submissionId),
					{ kind: 'attach', plan: applied.data.recovery }
				);
				return { ok: true };
			},
			async detachSubmission(sessionId: string, submissionId: string): Promise<MutationOutcome> {
				const key = attachRecoveryKey(sessionId, submissionId);
				const recovery = attachRecoveries.get(key);
				if (!recovery) {
					return { ok: false, reason: 'This attach receipt is no longer current.' };
				}
				const catalog = await readCatalog();
				if (recovery.kind === 'move') {
					const source = catalog.sessions.find((head) =>
						head.id === recovery.plan.sourceSession.after.id);
					const target = catalog.sessions.find((head) =>
						head.id === recovery.plan.targetSession.after.id);
					if (!source || !target) return { ok: false, reason: 'One of the moved talk’s sessions no longer exists.' };
					const applied = await input.attributionMutations.apply({
						action: 'restore_move',
						expectedCatalogVersion: catalog.version,
						expectedCatalogDigestSha256: catalog.digestSha256,
						expectedSourceSessionVersion: source.version,
						expectedSourceSessionDigestSha256: source.digestSha256,
						expectedTargetSessionVersion: target.version,
						expectedTargetSessionDigestSha256: target.digestSha256,
						original: recovery.plan
					}, newIdempotencyKey());
					if (applied.kind !== 'success' || applied.data.action !== 'restore_move') {
						return applied.kind === 'success'
							? { ok: false, reason: 'The move restore result was incomplete.' }
							: { ok: false, reason: applyFailure(applied as never, 'submission move').reason };
					}
					attachRecoveries.delete(key);
					return { ok: true };
				}
				const session = catalog.sessions.find((head) => head.id === sessionId);
				if (!session) return { ok: false, reason: 'This session no longer exists.' };
				const applied = await input.attributionMutations.apply({
					action: 'restore_route',
					expectedCatalogVersion: catalog.version,
					expectedCatalogDigestSha256: catalog.digestSha256,
					expectedSessionVersion: session.version,
					expectedSessionDigestSha256: session.digestSha256,
					original: recovery.plan
				}, newIdempotencyKey());
				if (applied.kind !== 'success') {
					return { ok: false, reason: applyFailure(applied as never, 'submission route').reason };
				}
				attachRecoveries.delete(key);
				return { ok: true };
			},
			async addDirectParticipant(): Promise<MutationOutcome> {
				return refusal('session_participants');
			},
			async addParticipantFromRoster(sessionId: string, speakerId: string): Promise<MutationOutcome> {
				const candidates = (await input.speakers.list()).filter((row) => row.id === speakerId);
				if (candidates.length !== 1 || candidates[0]!.personId === undefined) {
					return refusal('session_participants');
				}
				const personId = candidates[0]!.personId;
				const key = participantRecoveryKey(sessionId, personId);
				const recovery = participantRecoveries.get(key);
				const catalog = await readCatalog();
				const session = catalog.sessions.find((head) => head.id === sessionId);
				if (!session) return { ok: false, reason: 'This session no longer exists.' };
				if (!recovery) {
					const applied = await input.sessions.applyChange({
						action: 'roster_add_existing',
						expectedCatalogVersion: catalog.version,
						expectedCatalogDigestSha256: catalog.digestSha256,
						sessionId,
						expectedSessionVersion: session.version,
						expectedSessionDigestSha256: session.digestSha256,
						expectedRosterVersion: session.roster.version,
						personId,
						role: 'speaker',
						publiclyVisible: true
					}, newIdempotencyKey());
					if (applied.kind !== 'success' || applied.data.action !== 'roster_add_existing') {
						return applied.kind === 'success'
							? { ok: false, reason: 'The participant addition result was incomplete.' }
							: { ok: false, reason: applyFailure(applied, 'session participant').reason };
					}
					return { ok: true };
				}
				if (session.version !== recovery.expectedSession.version
					|| session.digestSha256 !== recovery.expectedSession.digestSha256) {
					return { ok: false, reason: 'This removal receipt is no longer current.' };
				}
				const applied = await input.sessions.applyChange({
					action: 'roster_restore',
					expectedCatalogVersion: catalog.version,
					expectedCatalogDigestSha256: catalog.digestSha256,
					sessionId,
					expectedSessionVersion: session.version,
					expectedSessionDigestSha256: session.digestSha256,
					expectedRosterVersion: session.roster.version,
					participant: recovery.participant
				}, newIdempotencyKey());
				if (applied.kind !== 'success' || applied.data.action !== 'roster_restore') {
					return applied.kind === 'success'
						? { ok: false, reason: 'The participant restore result was incomplete.' }
						: { ok: false, reason: applyFailure(applied, 'session participant').reason };
				}
				participantRecoveries.delete(key);
				return { ok: true };
			},
			async removeParticipant(sessionId: string, email: string): Promise<MutationOutcome> {
				const catalog = await readCatalog();
				const session = catalog.sessions.find((head) => head.id === sessionId);
				if (!session) return { ok: false, reason: 'This session no longer exists.' };
				const matches = (await input.speakers.list())
					.filter((row) => row.email === email && row.personId !== undefined);
				const personIds = [...new Set(matches.map((row) => row.personId!))];
				if (personIds.length !== 1) {
					return { ok: false, reason: 'This participant identity is no longer unambiguous.' };
				}
				const participant = session.roster.participants.find((row) => row.personId === personIds[0]);
				if (!participant) return { ok: false, reason: 'This person is no longer on the session.' };
				const applied = await input.sessions.applyChange({
					action: 'roster_remove',
					expectedCatalogVersion: catalog.version,
					expectedCatalogDigestSha256: catalog.digestSha256,
					sessionId,
					expectedSessionVersion: session.version,
					expectedSessionDigestSha256: session.digestSha256,
					expectedRosterVersion: session.roster.version,
					expectedParticipant: participant
				}, newIdempotencyKey());
				if (applied.kind !== 'success' || applied.data.action !== 'roster_remove'
					|| applied.data.session === null) {
					return applied.kind === 'success'
						? { ok: false, reason: 'The participant removal result was incomplete.' }
						: { ok: false, reason: applyFailure(applied, 'session participant').reason };
				}
				participantRecoveries.set(participantRecoveryKey(sessionId, participant.personId), {
					participant,
					expectedSession: applied.data.session
				});
				return { ok: true };
			},
			async changeParticipantRole(sessionId, email, role): Promise<MutationOutcome> {
				const catalog = await readCatalog();
				const session = catalog.sessions.find((head) => head.id === sessionId);
				if (!session) return { ok: false, reason: 'This session no longer exists.' };
				const matches = (await input.speakers.list())
					.filter((row) => row.email === email && row.personId !== undefined);
				const personIds = [...new Set(matches.map((row) => row.personId!))];
				if (personIds.length !== 1) {
					return { ok: false, reason: 'This participant identity is no longer unambiguous.' };
				}
				const participant = session.roster.participants.find((row) => row.personId === personIds[0]);
				if (!participant) return { ok: false, reason: 'This person is no longer on the session.' };
				const key = participantRecoveryKey(sessionId, participant.personId);
				const recovery = roleRecoveries.get(key);
				if (recovery?.role === role && (
					session.version !== recovery.expectedSession.version
					|| session.digestSha256 !== recovery.expectedSession.digestSha256
				)) return { ok: false, reason: 'This role receipt is no longer current.' };
				const applied = await input.sessions.applyChange({
					action: 'roster_role', expectedCatalogVersion: catalog.version,
					expectedCatalogDigestSha256: catalog.digestSha256, sessionId,
					expectedSessionVersion: session.version,
					expectedSessionDigestSha256: session.digestSha256,
					expectedRosterVersion: session.roster.version,
					expectedParticipant: participant, role
				}, newIdempotencyKey());
				if (applied.kind !== 'success' || applied.data.action !== 'roster_role'
					|| applied.data.session === null) {
					return applied.kind === 'success'
						? { ok: false, reason: 'The participant role result was incomplete.' }
						: { ok: false, reason: applyFailure(applied, 'session participant').reason };
				}
				if (recovery?.role === role) roleRecoveries.delete(key);
				else roleRecoveries.set(key, { role: participant.role, expectedSession: applied.data.session });
				return { ok: true };
			},
			async reorderParticipants(sessionId, emails): Promise<MutationOutcome> {
				const catalog = await readCatalog();
				const session = catalog.sessions.find((head) => head.id === sessionId);
				if (!session) return { ok: false, reason: 'This session no longer exists.' };
				const rows = await input.speakers.list();
				const byEmail = new Map<string, Set<string>>();
				for (const row of rows) {
					if (row.personId === undefined) continue;
					const personIds = byEmail.get(row.email) ?? new Set<string>();
					personIds.add(row.personId);
					byEmail.set(row.email, personIds);
				}
				const matches = emails.map((email) => [...(byEmail.get(email) ?? [])]);
				if (matches.some((personIds) => personIds.length !== 1)) {
					return { ok: false, reason: 'A participant identity is no longer unambiguous.' };
				}
				const exactPersonIds = matches.map((personIds) => personIds[0]!);
				const recovery = orderRecoveries.get(sessionId);
				if (recovery && recovery.personIds.join(':') === exactPersonIds.join(':') && (
					session.version !== recovery.expectedSession.version
					|| session.digestSha256 !== recovery.expectedSession.digestSha256
				)) return { ok: false, reason: 'This order receipt is no longer current.' };
				const applied = await input.sessions.applyChange({
					action: 'roster_reorder', expectedCatalogVersion: catalog.version,
					expectedCatalogDigestSha256: catalog.digestSha256, sessionId,
					expectedSessionVersion: session.version,
					expectedSessionDigestSha256: session.digestSha256,
					expectedRosterVersion: session.roster.version, personIds: exactPersonIds
				}, newIdempotencyKey());
				if (applied.kind !== 'success' || applied.data.action !== 'roster_reorder'
					|| applied.data.session === null) {
					return applied.kind === 'success'
						? { ok: false, reason: 'The participant order result was incomplete.' }
						: { ok: false, reason: applyFailure(applied, 'session participant order').reason };
				}
				if (recovery && recovery.personIds.join(':') === exactPersonIds.join(':')) {
					orderRecoveries.delete(sessionId);
				} else {
					orderRecoveries.set(sessionId, {
						personIds: session.roster.participants.map((participant) => participant.personId),
						expectedSession: applied.data.session
					});
				}
				return { ok: true };
			}
		}),
		vocab: Object.freeze({
			tracks: async () => (await input.vocabulary.tracks()).map(liveTrack),
			formats: async () => (await input.vocabulary.formats()).map(liveFormat),
			async addRoom(name: string, capacity: number): Promise<Room> {
				// The tuned page sends 0 for "capacity not set"; canonical capacity
				// is null in that case and never zero.
				return liveRoom(await input.vocabulary.addRoom(name, capacity === 0 ? null : capacity));
			},
			async removeRoom(id: string): Promise<MutationOutcome> {
				const outcome = await input.vocabulary.removeRoom(id);
				return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
			},
			addTrack: async (name: string) => liveTrack(await input.vocabulary.addTrack(name)),
			addFormat: async (name: string) => liveFormat(await input.vocabulary.addFormat(name))
		}),
		// These are joined owners, not local projections. Schedule consumes the
		// same roster and surface-template catalogs as Speakers and Templates so
		// a live empty list means genuinely empty rather than "not mounted".
		speakers: input.speakers,
		templates: input.templates
	} satisfies SchedulePagePort);
}
