import { describe, expect, test } from 'bun:test';
import type { Placement, Room, ScheduleState } from '$lib/api/types';
import {
	boardBlankCopy,
	boardReadiness,
	placementAvailability,
	placementBlockedCopy
} from './board-readiness';

function room(id: string, status: Room['status'] = 'active'): Room {
	return { id, name: id, capacity: 100, status, usage: { submissions: 0, sessions: 0, placements: 0 } };
}

function placement(sessionId: string): Placement {
	return { sessionId, dayKey: '2027-09-15', roomId: 'r1', startMin: 30, conflicts: [] };
}

function scheduleOf(input: Partial<ScheduleState>): ScheduleState {
	return {
		days: [],
		rooms: [],
		dayStart: '09:00',
		slotMinutes: 30,
		slotsPerDay: 16,
		sessions: [],
		placements: [],
		breaks: [],
		published: false,
		...input
	};
}

const DAYS = [{ key: '2027-09-15', label: 'Wed Sep 15' }];

describe('boardReadiness', () => {
	test('a grid with both supplies is ready and names nothing missing', () => {
		expect(boardReadiness(scheduleOf({ days: DAYS, rooms: [room('r1')] }))).toEqual({
			ready: true,
			missing: [],
			strandedPlacements: 0
		});
	});

	test('a never-loaded schedule is missing both, and claims no stranded placements', () => {
		expect(boardReadiness(null)).toEqual({ ready: false, missing: ['days', 'rooms'], strandedPlacements: 0 });
	});

	test('days first: a room has nowhere to appear without one', () => {
		expect(boardReadiness(scheduleOf({})).missing).toEqual(['days', 'rooms']);
	});

	test('rooms without days is a missing day list, not an empty schedule', () => {
		const readiness = boardReadiness(scheduleOf({ rooms: [room('r1')] }));
		expect(readiness).toEqual({ ready: false, missing: ['days'], strandedPlacements: 0 });
	});

	test('days without rooms is a missing room, and nothing is stranded', () => {
		expect(boardReadiness(scheduleOf({ days: DAYS }))).toEqual({
			ready: false,
			missing: ['rooms'],
			strandedPlacements: 0
		});
	});

	/*
	 * The shipped defect, as data: the serving layer refused to derive a grid
	 * and served an empty day list, while the placements it had read came back
	 * intact. "Nothing is scheduled yet" was a false claim about this state.
	 */
	test('placements served without a day list are stranded, not absent', () => {
		const readiness = boardReadiness(
			scheduleOf({
				rooms: [room('r1'), room('r2'), room('r3')],
				placements: [placement('s1'), placement('s2'), placement('s3')]
			})
		);
		expect(readiness).toEqual({ ready: false, missing: ['days'], strandedPlacements: 3 });
	});

	test('a drawable grid never reports stranded placements', () => {
		expect(
			boardReadiness(
				scheduleOf({ days: DAYS, rooms: [room('r1')], placements: [placement('s1')] })
			).strandedPlacements
		).toBe(0);
	});
});

describe('boardBlankCopy', () => {
	test('both supplies missing names both and opens both doors', () => {
		const copy = boardBlankCopy(boardReadiness(scheduleOf({})));
		expect(copy.title).toBe('The board has no grid yet');
		expect(copy.missing).toContain('days');
		expect(copy.missing).toContain('room');
		expect(copy.offerRoomForm).toBe(true);
		expect(copy.offerEventDates).toBe(true);
		expect(copy.stranded).toBe('');
	});

	test('missing rooms alone offers the room form and never mentions dates', () => {
		const copy = boardBlankCopy(boardReadiness(scheduleOf({ days: DAYS })));
		expect(copy.title).toBe('The board has no rooms yet');
		expect(copy.offerRoomForm).toBe(true);
		expect(copy.offerEventDates).toBe(false);
		expect(copy.missing).not.toContain('date');
	});

	test('missing days alone points at the dates and does not offer a room', () => {
		const copy = boardBlankCopy(boardReadiness(scheduleOf({ rooms: [room('r1')] })));
		expect(copy.title).toBe('The board has no days yet');
		expect(copy.offerRoomForm).toBe(false);
		expect(copy.offerEventDates).toBe(true);
	});

	test('stranded placements are counted in words, and pluralise', () => {
		const three = boardBlankCopy(
			boardReadiness(
				scheduleOf({
					rooms: [room('r1')],
					placements: [placement('s1'), placement('s2'), placement('s3')]
				})
			)
		);
		expect(three.stranded).toBe(
			'3 sessions are already placed, but the grid cannot be drawn from the current dates and day window.'
		);
		const one = boardBlankCopy(
			boardReadiness(scheduleOf({ rooms: [room('r1')], placements: [placement('s1')] }))
		);
		expect(one.stranded).toStartWith('1 session is already placed');
	});

	test('a ready board says so rather than throwing', () => {
		const copy = boardBlankCopy(boardReadiness(scheduleOf({ days: DAYS, rooms: [room('r1')] })));
		expect(copy.offerRoomForm).toBe(false);
		expect(copy.offerEventDates).toBe(false);
		expect(copy.stranded).toBe('');
	});
});

describe('placementAvailability', () => {
	test('a drawable grid with an active room accepts placements', () => {
		expect(placementAvailability(scheduleOf({ days: DAYS, rooms: [room('r1')] }))).toEqual({
			kind: 'available'
		});
		expect(placementBlockedCopy({ kind: 'available' })).toBe('');
	});

	test('no grid blocks placement and carries what is missing', () => {
		const availability = placementAvailability(scheduleOf({ rooms: [room('r1')] }));
		expect(availability).toEqual({ kind: 'no-grid', missing: ['days'] });
		expect(placementBlockedCopy(availability)).toContain('no days');
	});

	test('a grid whose rooms are all retired offers no opening, and says so', () => {
		const availability = placementAvailability(
			scheduleOf({ days: DAYS, rooms: [room('r1', 'retired')] })
		);
		expect(availability).toEqual({ kind: 'no-active-rooms' });
		expect(placementBlockedCopy(availability)).toContain('every room is retired');
	});

	test('each blocked reason names its own missing supply', () => {
		expect(placementBlockedCopy({ kind: 'no-grid', missing: ['days', 'rooms'] })).toContain(
			'no days and no rooms'
		);
		expect(placementBlockedCopy({ kind: 'no-grid', missing: ['rooms'] })).toContain('no rooms');
	});
});
