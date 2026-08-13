import type { Placement, PlacementConflict, ScheduleState, SessionItem } from '$lib/api/types';

/**
 * The aim model for manual placement, UI-free. This is the declared client
 * mirror of the authoritative placement check: it gives millisecond feedback on
 * hover and aim, and the commit's server check can still return an outcome it
 * missed, rendered through the same structured-outcome path.
 *
 * The model in one sentence: the pointer names a start time inside an opening,
 * clamped so the session can never run into a neighbour (the clamp is the
 * "resistance" — the whole tail of an opening means "flush before the next
 * occupant"), captured by flush/slot anchors when close, and otherwise rounded
 * to the aim floor. Precision finer than the floor is typed, never aimed.
 */

/** Free-aim rounding: the pointer is never asked to be finer than this. */
export const AIM_STEP_MIN = 15;

/** How close (in minutes) the aim must be for an anchor to capture the ghost. */
export const ANCHOR_CAPTURE_MIN = 5;

/**
 * One vertical span of a room-day column that is not covered by a card. Open
 * segments accept the session in hand; blocked segments stay visible and carry
 * the structured reason a drop there would be refused, stated before any
 * attempt.
 */
export interface ColumnSegment {
	kind: 'open' | 'blocked';
	startMin: number;
	endMin: number;
	/** Blocked only: why the session cannot land here. */
	reason?: string;
	/** Open only: what sits immediately before/after, for snap notes. */
	prevLabel?: string;
	nextLabel?: string;
}

export interface SnapResult {
	startMin: number;
	/**
	 * The flush phrase ("Right before “Lunch”") — rendered only where the grid
	 * is absent (quick picks, the confirm dialog). On the grid the same fact is
	 * shown spatially via {@link SnapResult.flush}; the ghost never says in
	 * words what its own edge already shows.
	 */
	note: string | null;
	/**
	 * Which bound of the opening holds the ghost, when one does: the ghost
	 * marks that touching edge instead of captioning it. `both` is the
	 * exact-fit gap. Null for slot-boundary capture and free aim.
	 */
	flush: 'start' | 'end' | 'both' | null;
}

export interface QuickPick {
	dayKey: string;
	roomId: string;
	startMin: number;
	note: string;
}

interface Occupant {
	startMin: number;
	endMin: number;
	label: string;
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
	aStart < bEnd && bStart < aEnd;

export function dayLengthMin(schedule: ScheduleState): number {
	return schedule.slotsPerDay * schedule.slotMinutes;
}

function roomName(schedule: ScheduleState, roomId: string): string {
	return schedule.rooms.find((room) => room.id === roomId)?.name ?? 'another room';
}

/** Everything sitting in one room-day column, except the session being placed. */
function occupantsOf(
	schedule: ScheduleState,
	session: SessionItem,
	dayKey: string,
	roomId: string
): Occupant[] {
	const found: Occupant[] = [];
	for (const placement of schedule.placements) {
		if (placement.sessionId === session.id) continue;
		if (placement.dayKey !== dayKey || placement.roomId !== roomId) continue;
		const other = schedule.sessions.find((s) => s.id === placement.sessionId);
		if (!other) continue;
		found.push({
			startMin: placement.startMin,
			endMin: placement.startMin + other.durationMin,
			label: other.title
		});
	}
	for (const brk of schedule.breaks) {
		if (brk.dayKey !== dayKey || brk.roomId !== roomId) continue;
		found.push({ startMin: brk.startMin, endMin: brk.startMin + brk.durationMin, label: brk.label });
	}
	return found.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Times this session's own speakers are on stage somewhere else that day —
 * invalid in every room, each interval carrying its reason.
 */
function speakerBusy(
	schedule: ScheduleState,
	session: SessionItem,
	dayKey: string
): { startMin: number; endMin: number; reason: string }[] {
	const busy: { startMin: number; endMin: number; reason: string }[] = [];
	for (const placement of schedule.placements) {
		if (placement.sessionId === session.id || placement.dayKey !== dayKey) continue;
		const other = schedule.sessions.find((s) => s.id === placement.sessionId);
		if (!other) continue;
		// Email-keyed: the band belongs to a person, not to a spelling of them.
		const shared = session.speakers.find((speaker) =>
			other.speakers.some((entry) => entry.email === speaker.email)
		);
		if (!shared) continue;
		busy.push({
			startMin: placement.startMin,
			endMin: placement.startMin + other.durationMin,
			reason: `${shared.name} is speaking in ${roomName(schedule, placement.roomId)} then`
		});
	}
	return busy.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Partitions the card-free space of one room-day column into open segments
 * (the session fits) and blocked segments (it does not, with the reason).
 * Card-occupied space is not returned: the cards themselves are its rendering.
 */
export function columnSegments(
	schedule: ScheduleState,
	session: SessionItem,
	dayKey: string,
	roomId: string
): ColumnSegment[] {
	const length = dayLengthMin(schedule);
	const occupants = occupantsOf(schedule, session, dayKey, roomId);
	const busy = speakerBusy(schedule, session, dayKey);
	const segments: ColumnSegment[] = [];

	// Free intervals between occupants, with their neighbours' labels.
	let cursor = 0;
	let prevLabel: string | undefined;
	const free: { startMin: number; endMin: number; prevLabel?: string; nextLabel?: string }[] = [];
	for (const occupant of occupants) {
		if (occupant.startMin > cursor) {
			free.push({ startMin: cursor, endMin: occupant.startMin, prevLabel, nextLabel: occupant.label });
		}
		cursor = Math.max(cursor, occupant.endMin);
		prevLabel = occupant.label;
	}
	if (cursor < length) free.push({ startMin: cursor, endMin: length, prevLabel });

	// Split each free interval around speaker-busy time, then classify by fit.
	for (const gap of free) {
		let at = gap.startMin;
		const cuts = busy.filter((b) => overlaps(gap.startMin, gap.endMin, b.startMin, b.endMin));
		for (const cut of cuts) {
			if (cut.startMin > at) {
				pushFit(segments, session, at, cut.startMin, at === gap.startMin ? gap.prevLabel : undefined, undefined);
			}
			segments.push({
				kind: 'blocked',
				startMin: Math.max(at, cut.startMin),
				endMin: Math.min(gap.endMin, cut.endMin),
				reason: cut.reason
			});
			at = Math.max(at, Math.min(gap.endMin, cut.endMin));
		}
		if (at < gap.endMin) {
			pushFit(
				segments,
				session,
				at,
				gap.endMin,
				at === gap.startMin ? gap.prevLabel : undefined,
				gap.nextLabel
			);
		}
	}
	return segments;
}

function pushFit(
	segments: ColumnSegment[],
	session: SessionItem,
	startMin: number,
	endMin: number,
	prevLabel: string | undefined,
	nextLabel: string | undefined
): void {
	if (endMin - startMin >= session.durationMin) {
		segments.push({ kind: 'open', startMin, endMin, prevLabel, nextLabel });
	} else {
		segments.push({
			kind: 'blocked',
			startMin,
			endMin,
			reason: `Only ${endMin - startMin} min free here — this session needs ${session.durationMin}`
		});
	}
}

/**
 * Maps a raw aimed minute inside an open segment to the start the ghost takes.
 * Clamping is the resistance; anchors capture within {@link ANCHOR_CAPTURE_MIN};
 * free aim rounds to {@link AIM_STEP_MIN}.
 */
export function snapStart(
	segment: ColumnSegment,
	session: SessionItem,
	slotMinutes: number,
	rawMin: number
): SnapResult {
	const low = segment.startMin;
	const high = segment.endMin - session.durationMin;
	const clamped = Math.min(high, Math.max(low, rawMin));
	// An exact-fit gap is flush against both bounds at once.
	const exactFit = low === high;

	const anchors: { min: number; note: string | null; flush: SnapResult['flush'] }[] = [
		{
			min: low,
			note: segment.prevLabel ? `Right after “${segment.prevLabel}”` : null,
			flush: exactFit ? 'both' : 'start'
		},
		{
			min: high,
			note: segment.nextLabel ? `Right before “${segment.nextLabel}”` : null,
			flush: exactFit ? 'both' : 'end'
		}
	];
	for (let slot = Math.ceil(low / slotMinutes) * slotMinutes; slot <= high; slot += slotMinutes) {
		anchors.push({ min: slot, note: null, flush: null });
	}

	// Nearest anchor wins inside the capture radius; the flush anchors are
	// listed first, so an exact tie prefers "touching a neighbour" over a bare
	// slot line.
	let best: (typeof anchors)[number] | null = null;
	for (const anchor of anchors) {
		const distance = Math.abs(anchor.min - clamped);
		if (distance > ANCHOR_CAPTURE_MIN) continue;
		if (!best || distance < Math.abs(best.min - clamped)) best = anchor;
	}
	if (best) return { startMin: best.min, note: best.note, flush: best.flush };

	const rounded = Math.min(high, Math.max(low, Math.round(clamped / AIM_STEP_MIN) * AIM_STEP_MIN));
	return { startMin: rounded, note: null, flush: null };
}

/** The keyboard/touch proposal for an opening: flush after whatever precedes it. */
/**
 * Whether a proposed placement is the one the session already has.
 *
 * A move's origin is excluded from its own openings, so the slot a session is
 * sitting in offers itself back as somewhere to drop it. Landing there changes
 * nothing: there is no diff to show, nothing to commit, and no decision to ask
 * for.
 *
 * Exact minutes, deliberately. A start one aim step away is a real move, and a
 * tolerance here would silently discard it — the failure this guards against is
 * a pointless dialog, not a near-miss.
 */
export function landsOnOrigin(
	origin: Placement | null,
	dayKey: string,
	roomId: string,
	startMin: number
): boolean {
	return (
		origin !== null &&
		origin.dayKey === dayKey &&
		origin.roomId === roomId &&
		origin.startMin === startMin
	);
}

export function defaultStart(segment: ColumnSegment, durationMin?: number): SnapResult {
	return {
		startMin: segment.startMin,
		note: segment.prevLabel ? `Right after “${segment.prevLabel}”` : null,
		flush: durationMin !== undefined && segment.endMin - segment.startMin === durationMin ? 'both' : 'start'
	};
}

export interface NeighborAnchors {
	/** The occupant ending at or before the candidate start, and the flush start after it. */
	prev?: { label: string; startMin: number };
	/** The occupant not entirely before the start, and the flush start before it. */
	next?: { label: string; startMin: number };
}

/**
 * The occupants adjacent to a candidate start in one room-day column, each with
 * the flush start it implies for the session. The confirm dialog renders these
 * as relative-to-neighbour setters — the third precision register beside nudges
 * and typed time — and, on a viewport where the dialog covers the whole grid,
 * they are also the only view of what sits nearby.
 *
 * `next` is the first occupant *not entirely before* the start rather than the
 * first starting after it, so a start typed into an occupant's own span (the
 * break-overlap warning case) offers "Right before" that occupant — the exact
 * recovery the person wants — instead of a slot beyond it.
 */
export function neighborsAt(
	schedule: ScheduleState,
	session: SessionItem,
	dayKey: string,
	roomId: string,
	startMin: number
): NeighborAnchors {
	const occupants = occupantsOf(schedule, session, dayKey, roomId);
	const high = Math.max(0, dayLengthMin(schedule) - session.durationMin);
	const clamp = (min: number) => Math.min(high, Math.max(0, min));
	const prev = [...occupants].reverse().find((occupant) => occupant.endMin <= startMin);
	const next = occupants.find((occupant) => occupant.endMin > startMin);
	return {
		...(prev ? { prev: { label: prev.label, startMin: clamp(prev.endMin) } } : {}),
		...(next
			? { next: { label: next.label, startMin: clamp(next.startMin - session.durationMin) } }
			: {})
	};
}

/**
 * The client mirror of the authoritative conflict check: same-room overlap and
 * a speaker in two rooms block; running into a break warns. The server remains
 * the truth at commit.
 */
export function preflight(
	schedule: ScheduleState,
	session: SessionItem,
	dayKey: string,
	roomId: string,
	startMin: number
): PlacementConflict[] {
	const found: PlacementConflict[] = [];
	const endMin = startMin + session.durationMin;
	for (const placement of schedule.placements) {
		if (placement.sessionId === session.id || placement.dayKey !== dayKey) continue;
		const other = schedule.sessions.find((s) => s.id === placement.sessionId);
		if (!other) continue;
		if (!overlaps(startMin, endMin, placement.startMin, placement.startMin + other.durationMin)) {
			continue;
		}
		if (placement.roomId === roomId) {
			found.push({
				severity: 'block',
				reason: `Overlaps “${other.title}” in ${roomName(schedule, roomId)}`
			});
		} else {
			const shared = session.speakers.find((speaker) =>
				other.speakers.some((entry) => entry.email === speaker.email)
			);
			if (shared) {
				found.push({
					severity: 'block',
					reason: `${shared.name} is scheduled in another room at the same time`
				});
			}
		}
	}
	for (const brk of schedule.breaks) {
		if (brk.dayKey !== dayKey || brk.roomId !== roomId) continue;
		if (!overlaps(startMin, endMin, brk.startMin, brk.startMin + brk.durationMin)) continue;
		found.push({
			severity: 'warn',
			reason: `Runs into “${brk.label}” in ${roomName(schedule, roomId)}`
		});
	}
	if (startMin < 0 || endMin > dayLengthMin(schedule)) {
		found.push({ severity: 'block', reason: 'Falls outside the day' });
	}
	return found;
}

/**
 * The ranked shortlist for the placement bar. Packing first: a start flush
 * after an existing occupant beats an isolated one, then earlier day, earlier
 * time, room order.
 */
export function quickPicks(
	schedule: ScheduleState,
	session: SessionItem,
	limit = 3
): QuickPick[] {
	const candidates: (QuickPick & { packed: boolean; dayIndex: number; roomIndex: number })[] = [];
	schedule.days.forEach((day, dayIndex) => {
		schedule.rooms.forEach((room, roomIndex) => {
			if ((room.status ?? 'active') !== 'active') return;
			for (const segment of columnSegments(schedule, session, day.key, room.id)) {
				if (segment.kind !== 'open') continue;
				candidates.push({
					dayKey: day.key,
					roomId: room.id,
					startMin: segment.startMin,
					note: segment.prevLabel
						? `Right after “${segment.prevLabel}”`
						: segment.startMin === 0
							? 'Opens the day'
							: 'Free from here',
					packed: segment.prevLabel !== undefined,
					dayIndex,
					roomIndex
				});
			}
		});
	});
	candidates.sort(
		(a, b) =>
			Number(b.packed) - Number(a.packed) ||
			a.dayIndex - b.dayIndex ||
			a.startMin - b.startMin ||
			a.roomIndex - b.roomIndex
	);
	return candidates.slice(0, limit).map(({ dayKey, roomId, startMin, note }) => ({
		dayKey,
		roomId,
		startMin,
		note
	}));
}
