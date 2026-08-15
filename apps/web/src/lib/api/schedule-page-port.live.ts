import type { StructuredOutcome } from '@jooevents/contracts';
import type { ReleaseWorkspacePort } from './release-workspace-adapter';
import type { SafeApiError } from './client';
import type {
	ProgramFormatView,
	ProgramRoomView,
	ProgramTrackView
} from './view-models/program-vocabulary';
import type { SchedulePlacementOccurrenceView } from './view-models/schedule-placement';
import type { SessionHeadView } from './view-models/session';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { SchedulePagePort } from './schedule-page-port';
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
import type {
	EventSettings,
	Format,
	MutationOutcome,
	Placement,
	Room,
	ScheduleDayInfo,
	ScheduleState,
	SessionItem,
	Track
} from './types';

/**
 * The tuned page capabilities this deliberately partial live mount cannot
 * truthfully serve yet, each refused with its own name so a failure states
 * exactly which owner has not joined.
 */
export type SchedulePageLiveUnmountedCapability =
	| 'schedule_unplace'
	| 'schedule_breaks'
	| 'schedule_publish'
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
	schedule_breaks: 'Breaks are not available in this live workspace yet.',
	schedule_publish: 'Publishing the schedule is not available in this live workspace yet.',
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
		SessionCatalogReadResult | SchedulePlacementReadResult | ScheduleProposalCountsReadResult,
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
 * participants are typed person references without a name/address projection
 * owner, so the tuned `speakers` list stays empty rather than inventing
 * people; `originSubmissionIds` stays absent because the canonical head
 * carries no submission provenance.
 */
function sessionItem(head: SessionHeadView): SessionItem {
	return {
		id: head.id,
		title: head.title,
		speakers: [],
		trackId: head.programTarget.track?.id ?? '',
		formatId: head.programTarget.format.id,
		durationMin: head.plannedDurationMinutes,
		state: head.lifecycle
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
	readonly settings: ScheduleGeometrySettingsSource;
	readonly publication: Pick<ReleaseWorkspacePort, 'overview'>;
	readonly newIdempotencyKey?: () => string;
}): SchedulePagePort {
	if (
		input.placements.source.kind !== 'live'
		|| input.sessions.source.kind !== 'live'
		|| input.vocabulary.source.kind !== 'live'
		|| input.proposals.source.kind !== 'live'
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
		return result.data;
	}

	return Object.freeze({
		workspace: Object.freeze({
			/** No live workspace summary is composed here; null is "not read yet". */
			scheduleAttentionExpectedSnapshot(): boolean | null {
				return null;
			}
		}),
		schedule: Object.freeze({
			async state(): Promise<ScheduleState> {
				const [catalog, placements, rooms, settings, publication] = await Promise.all([
					readCatalog(),
					readPlacements(),
					input.vocabulary.rooms(),
					input.settings.get(),
					input.publication.overview()
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
					sessions: catalog.sessions.map(sessionItem),
					placements: placements.occurrences.map((occurrence) =>
						occurrencePlacement(occurrence, geometry.dayStartMin, geometry.timeZone)
					),
					// No canonical break owner exists, so none can exist to report.
					breaks: [],
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
				const applied = await input.placements.placeOrMove(
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
				return occurrencePlacement(
					applied.data.occurrence,
					geometry.dayStartMin,
					geometry.timeZone
				);
			},
			async unplace(): Promise<void> {
				// Unplace is internal compensation in the placement contract; it is
				// not a web operation, so the capability refuses instead of no-oping.
				throw unmounted('schedule_unplace');
			},
			async addBreak(): Promise<never> {
				throw unmounted('schedule_breaks');
			},
			async removeBreak(): Promise<never> {
				throw unmounted('schedule_breaks');
			},
			async publish(): Promise<{ ok: true } | { ok: false; reason: string }> {
				return { ok: false, reason: UNMOUNTED_COPY.schedule_publish };
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
				return sessionItem(applied.data.session);
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
				return sessionItem(applied.data.session);
			},
			async removeSession(): Promise<MutationOutcome> {
				return refusal('session_remove');
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
			/**
			 * The canonical Session head carries no submission provenance at all,
			 * so no session can have origins yet; the empty list is the true state,
			 * which the page reads as "purely editorial".
			 */
			async sessionOrigins(): Promise<
				{
					id: string;
					title: string;
					source: 'cfp' | 'direct_entry' | 'import';
					speakerEmails: string[];
				}[]
			> {
				return [];
			},
			async attachCandidates(): Promise<never> {
				// Submissions exist canonically, but no attach owner is mounted; an
				// empty list would falsely claim "nothing to attach", so refuse.
				throw unmounted('session_attach');
			},
			async attachSubmission(): Promise<MutationOutcome> {
				return refusal('session_attach');
			},
			async detachSubmission(): Promise<MutationOutcome> {
				return refusal('session_detach');
			},
			async addDirectParticipant(): Promise<MutationOutcome> {
				return refusal('session_participants');
			},
			async addParticipantFromRoster(): Promise<MutationOutcome> {
				return refusal('session_participants');
			},
			async removeParticipant(): Promise<MutationOutcome> {
				return refusal('session_participants');
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
		speakers: Object.freeze({
			/** No speaker-roster owner is mounted; nothing exists to list. */
			async list() {
				return [];
			},
			/** Null is the port's own typed absence for an unknown profile. */
			async profile() {
				return null;
			}
		}),
		templates: Object.freeze({
			/** No public-surface template owner is mounted; no surfaces exist. */
			async list() {
				return { surfaces: [] };
			}
		})
	} satisfies SchedulePagePort);
}
