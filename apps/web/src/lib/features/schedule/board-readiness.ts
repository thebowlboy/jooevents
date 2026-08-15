/**
 * Why the board cannot be drawn, and why nothing can be placed on it.
 *
 * The grid draws from two independent supplies: the event's **days** (derived
 * by the serving layer from the event dates and the day window) and the
 * event's **rooms**. The page's gate was `rooms.length > 0 && days.length > 0`
 * and its blank state said one sentence — "Nothing is scheduled yet" — for
 * every way that gate can fail. That sentence was wrong in the case that
 * actually shipped: a board with three rooms, three days and three committed
 * placements whose geometry the serving layer refused, where "nothing is
 * scheduled" was false and the offered way in (add a room) fixed nothing.
 *
 * So the blank state is derived, not written: which supply is missing decides
 * what the page says and which door it opens, and a schedule that already
 * holds placements it cannot draw says *that* instead of claiming emptiness.
 *
 * Pure projections over the state the page already has. Nothing here reads a
 * clock, a locale, or the DOM.
 */

import type { ScheduleState } from '$lib/api/types';

/** A supply the grid needs before it can draw a single column. */
export type BoardSupply = 'days' | 'rooms';

export interface BoardReadiness {
	/** The page's gate: both supplies present. */
	ready: boolean;
	/** What is missing, days first — a room has nowhere to appear without one. */
	missing: BoardSupply[];
	/**
	 * Placements the schedule holds that the current geometry cannot draw.
	 *
	 * Non-zero only when the day list is empty while placements exist, which is
	 * exactly the state the serving layer serves when it refuses to derive a
	 * grid. "Nothing is scheduled yet" is a false claim about this schedule;
	 * the count is what makes the blank state honest.
	 */
	strandedPlacements: number;
}

export function boardReadiness(schedule: ScheduleState | null): BoardReadiness {
	const days = schedule?.days.length ?? 0;
	const rooms = schedule?.rooms.length ?? 0;
	const missing: BoardSupply[] = [];
	if (days === 0) missing.push('days');
	if (rooms === 0) missing.push('rooms');
	return {
		ready: days > 0 && rooms > 0,
		missing,
		strandedPlacements: days === 0 ? (schedule?.placements.length ?? 0) : 0
	};
}

export interface BoardBlankCopy {
	/** What is true right now, in the reader's terms. */
	title: string;
	/** Which supply is missing and where it comes from. */
	missing: string;
	/**
	 * The honest correction to "nothing is scheduled" when the schedule holds
	 * placements the geometry refuses. Empty where there are none.
	 */
	stranded: string;
	/** The room form is the way in — rooms are what is missing. */
	offerRoomForm: boolean;
	/** The event's dates and day window are what is missing; Settings owns them. */
	offerEventDates: boolean;
}

/**
 * The blank board's words. One sentence per fact, and no sentence that the
 * state does not support: a page with days but no rooms is never told about
 * dates, and a page whose placements are stranded is never told it is empty.
 */
export function boardBlankCopy(readiness: BoardReadiness): BoardBlankCopy {
	const noDays = readiness.missing.includes('days');
	const noRooms = readiness.missing.includes('rooms');
	const stranded =
		readiness.strandedPlacements > 0
			? `${readiness.strandedPlacements} ${
					readiness.strandedPlacements === 1 ? 'session is' : 'sessions are'
				} already placed, but the grid cannot be drawn from the current dates and day window.`
			: '';

	if (noDays && noRooms) {
		return {
			title: 'The board has no grid yet',
			missing:
				'It needs two things: days, from the event’s dates and day window, and at least one room.',
			stranded,
			offerRoomForm: true,
			offerEventDates: true
		};
	}
	if (noDays) {
		return {
			title: 'The board has no days yet',
			missing:
				'One column per event date, between the day’s start and end. The event’s dates and day window set them.',
			stranded,
			offerRoomForm: false,
			offerEventDates: true
		};
	}
	if (noRooms) {
		return {
			title: 'The board has no rooms yet',
			missing: 'The days are ready. A room gives them their first column.',
			stranded,
			offerRoomForm: true,
			offerEventDates: false
		};
	}
	// Not reachable through the page's gate; stated rather than thrown so a
	// future caller gets words instead of an exception.
	return {
		title: 'The board is ready',
		missing: '',
		stranded: '',
		offerRoomForm: false,
		offerEventDates: false
	};
}

/**
 * Whether the board can accept a placement at all, and why not when it cannot.
 *
 * This is the predicate the "Place…" control was missing. It rendered from the
 * row alone — unplaced, not a draft — so on a board with no grid every row
 * offered a control that opened a mode with nothing in it: no openings, no
 * ghost, no visible change. A control that cannot do its job is worse than an
 * absent one, because pressing it teaches nothing.
 */
export type PlacementAvailability =
	| { kind: 'available' }
	| { kind: 'no-grid'; missing: BoardSupply[] }
	| { kind: 'no-active-rooms' };

export function placementAvailability(schedule: ScheduleState | null): PlacementAvailability {
	const readiness = boardReadiness(schedule);
	if (!readiness.ready) return { kind: 'no-grid', missing: readiness.missing };
	const active = (schedule?.rooms ?? []).filter((room) => room.status === 'active').length;
	if (active === 0) return { kind: 'no-active-rooms' };
	return { kind: 'available' };
}

/**
 * Why the pool is offering no placement, said where the rows are. Empty string
 * while placement is available, so the caller renders nothing at all.
 */
export function placementBlockedCopy(availability: PlacementAvailability): string {
	if (availability.kind === 'available') return '';
	if (availability.kind === 'no-active-rooms') {
		return 'Nothing can be placed: every room is retired. Reopen a room to place sessions again.';
	}
	const noDays = availability.missing.includes('days');
	const noRooms = availability.missing.includes('rooms');
	if (noDays && noRooms) {
		return 'Nothing can be placed yet: the board has no days and no rooms. Build the grid above first.';
	}
	if (noDays) {
		return 'Nothing can be placed yet: the board has no days. The event’s dates and day window set them.';
	}
	return 'Nothing can be placed yet: the board has no rooms. Add one above and these sessions become placeable.';
}
