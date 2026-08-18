import { describe, expect, test } from 'bun:test';
import type { Placement, ScheduleState, SessionItem } from '$lib/api/types';
import {
	AIM_STEP_MIN,
	ANCHOR_CAPTURE_MIN,
	bestOpening,
	columnSegments,
	defaultStart,
	landsOnOrigin,
	neighborsAt,
	preflight,
	quickPicks,
	snapStart
} from './placement-engine';

/**
 * One 480-minute day (09:00–17:00 shape), two rooms. Room A holds a keynote at
 * 0–60 and lunch at 180–240; room B holds a talk at 90–120 whose speaker is
 * shared with the session under placement.
 */
function fixture(): { schedule: ScheduleState; session: SessionItem } {
	const session: SessionItem = {
		id: 'ses-place',
		title: 'Placing this',
		speakers: [{ name: 'Ada', email: 'ada@fixture.test' }],
		trackId: 'trk',
		formatId: 'fmt',
		durationMin: 30,
		state: 'programmed'
	};
	const keynote: SessionItem = {
		id: 'ses-keynote',
		title: 'Keynote',
		speakers: [{ name: 'Grace', email: 'grace@fixture.test' }],
		trackId: 'trk',
		formatId: 'fmt',
		durationMin: 60,
		state: 'programmed'
	};
	const adaTalk: SessionItem = {
		id: 'ses-ada',
		title: 'Ada elsewhere',
		speakers: [{ name: 'Ada', email: 'ada@fixture.test' }],
		trackId: 'trk',
		formatId: 'fmt',
		durationMin: 30,
		state: 'programmed'
	};
	const usage = { submissions: 0, sessions: 0, placements: 0 };
	const schedule: ScheduleState = {
		days: [
			{ key: 'day-1', label: 'Day 1' },
			{ key: 'day-2', label: 'Day 2' }
		],
		rooms: [
			{ id: 'room-a', name: 'Room A', capacity: 100, status: 'active', usage },
			{ id: 'room-b', name: 'Room B', capacity: 40, status: 'active', usage }
		],
		dayStart: '09:00',
		slotMinutes: 30,
		slotsPerDay: 16,
		sessions: [session, keynote, adaTalk],
		placements: [
			{ sessionId: 'ses-keynote', dayKey: 'day-1', roomId: 'room-a', startMin: 0, conflicts: [] },
			{ sessionId: 'ses-ada', dayKey: 'day-1', roomId: 'room-b', startMin: 90, conflicts: [] }
		],
		breaks: [
			{ id: 'brk-1', label: 'Lunch', dayKey: 'day-1', roomId: 'room-a', startMin: 180, durationMin: 60 }
		],
		published: false
	};
	return { schedule, session };
}

describe('columnSegments', () => {
	test('partitions around occupants and marks speaker-busy time with its reason', () => {
		const { schedule, session } = fixture();
		const segments = columnSegments(schedule, session, 'day-1', 'room-a');

		// 0–60 keynote (card, not a segment), 60–90 open, 90–120 blocked by
		// Ada's other talk, 120–180 open, 180–240 lunch (card), 240–480 open.
		expect(segments).toEqual([
			{ kind: 'open', startMin: 60, endMin: 90, prevLabel: 'Keynote', nextLabel: undefined },
			{
				kind: 'blocked',
				startMin: 90,
				endMin: 120,
				reason: 'Ada is speaking in Room B then'
			},
			{ kind: 'open', startMin: 120, endMin: 180, prevLabel: undefined, nextLabel: 'Lunch' },
			{ kind: 'open', startMin: 240, endMin: 480, prevLabel: 'Lunch', nextLabel: undefined }
		]);
	});

	test('a gap too short for the session stays visible as blocked, with the arithmetic', () => {
		const { schedule, session } = fixture();
		const long = { ...session, durationMin: 45 };
		const segments = columnSegments(schedule, long, 'day-1', 'room-a');
		expect(segments[0]).toEqual({
			kind: 'blocked',
			startMin: 60,
			endMin: 90,
			reason: 'Only 30 min free here — this session needs 45'
		});
	});

	test('an empty day is one opening spanning it', () => {
		const { schedule, session } = fixture();
		expect(columnSegments(schedule, session, 'day-2', 'room-a')).toEqual([
			{ kind: 'open', startMin: 0, endMin: 480, prevLabel: undefined, nextLabel: undefined }
		]);
	});

	test('the session being moved does not block itself', () => {
		const { schedule, session } = fixture();
		schedule.placements.push({
			sessionId: session.id,
			dayKey: 'day-1',
			roomId: 'room-a',
			startMin: 240,
			conflicts: []
		});
		const segments = columnSegments(schedule, session, 'day-1', 'room-a');
		expect(segments.at(-1)).toMatchObject({ kind: 'open', startMin: 240, endMin: 480 });
	});
});

describe('snapStart', () => {
	const { schedule, session } = fixture();
	const opening = columnSegments(schedule, session, 'day-1', 'room-a')[3]; // 240–480 after Lunch
	const slot = schedule.slotMinutes;

	test('the tail of an opening clamps flush before the next occupant (the resistance)', () => {
		const tail = columnSegments(schedule, session, 'day-1', 'room-a')[2]; // 120–180 before Lunch
		// Anywhere in the last stretch means "right before, touching".
		for (const raw of [151, 160, 170, 179, 500]) {
			const snapped = snapStart(tail, session, slot, raw);
			expect(snapped.startMin).toBe(150);
			expect(snapped.note).toBe('Right before “Lunch”');
			expect(snapped.flush).toBe('end');
		}
	});

	test('the head clamps flush after the previous occupant', () => {
		const snapped = snapStart(opening, session, slot, 200);
		expect(snapped.startMin).toBe(240);
		expect(snapped.note).toBe('Right after “Lunch”');
		expect(snapped.flush).toBe('start');
	});

	test('an exact-fit gap is flush against both bounds at once', () => {
		const fit = columnSegments(schedule, session, 'day-1', 'room-a')[0]; // 60–90, exactly 30 min
		const snapped = snapStart(fit, session, slot, 75);
		expect(snapped.startMin).toBe(60);
		expect(snapped.flush).toBe('both');
	});

	test('anchors capture within the radius; free aim rounds to the floor', () => {
		// 243 is within capture of the flush anchor at 240.
		expect(snapStart(opening, session, slot, 240 + ANCHOR_CAPTURE_MIN).startMin).toBe(240);
		// 262 is beyond every anchor: rounds to the 15-minute floor.
		const free = snapStart(opening, session, slot, 262);
		expect(free.startMin).toBe(Math.round(262 / AIM_STEP_MIN) * AIM_STEP_MIN);
		expect(free.note).toBeNull();
		// 274 captures the slot boundary at 270, silently: no flush note, no edge.
		const slotSnap = snapStart(opening, session, slot, 274);
		expect(slotSnap).toEqual({ startMin: 270, note: null, flush: null });
	});

	test('defaultStart proposes flush after whatever precedes the opening', () => {
		expect(defaultStart(opening, session.durationMin)).toEqual({
			startMin: 240,
			note: 'Right after “Lunch”',
			flush: 'start'
		});
		// The same proposal on an exact-fit opening touches both bounds.
		const fit = columnSegments(schedule, session, 'day-1', 'room-a')[0];
		expect(defaultStart(fit, session.durationMin).flush).toBe('both');
	});
});

describe('neighborsAt', () => {
	test('names both neighbours around a start, with the flush start each implies', () => {
		const { schedule, session } = fixture();
		// Start 60 in room A sits between the keynote (0–60) and lunch (180–240).
		expect(neighborsAt(schedule, session, 'day-1', 'room-a', 60)).toEqual({
			prev: { label: 'Keynote', startMin: 60 },
			next: { label: 'Lunch', startMin: 150 }
		});
	});

	test('a start typed into an occupant offers "right before" that occupant — the recovery', () => {
		const { schedule, session } = fixture();
		// 170 runs into lunch (180–240); the way out is flush before lunch, 150.
		expect(neighborsAt(schedule, session, 'day-1', 'room-a', 170).next).toEqual({
			label: 'Lunch',
			startMin: 150
		});
	});

	test('an empty column has no neighbours; a lone occupant clamps into the day', () => {
		const { schedule, session } = fixture();
		expect(neighborsAt(schedule, session, 'day-2', 'room-a', 120)).toEqual({});
		// Room B holds only Ada's talk (90–120): before it from an earlier start.
		expect(neighborsAt(schedule, session, 'day-1', 'room-b', 30)).toEqual({
			next: { label: 'Ada elsewhere', startMin: 60 }
		});
	});
});

describe('preflight (client mirror)', () => {
	test('same-room overlap and a speaker in two rooms both block, with reasons', () => {
		const { schedule, session } = fixture();
		expect(preflight(schedule, session, 'day-1', 'room-a', 30)).toEqual([
			{ severity: 'block', reason: 'Overlaps “Keynote” in Room A' }
		]);
		expect(preflight(schedule, session, 'day-1', 'room-a', 100)).toEqual([
			{ severity: 'block', reason: 'Ada is scheduled in another room at the same time' }
		]);
	});

	test('running into a break warns without blocking; a clear slot is clean', () => {
		const { schedule, session } = fixture();
		expect(preflight(schedule, session, 'day-1', 'room-a', 170)).toEqual([
			{ severity: 'warn', reason: 'Runs into “Lunch” in Room A' }
		]);
		expect(preflight(schedule, session, 'day-1', 'room-a', 240)).toEqual([]);
	});

	test('spilling past the end of the day blocks', () => {
		const { schedule, session } = fixture();
		expect(preflight(schedule, session, 'day-1', 'room-a', 470)).toEqual([
			{ severity: 'block', reason: 'Falls outside the day' }
		]);
	});
});

describe('quickPicks', () => {
	test('an exact packed opening ranks first and explains the fit', () => {
		const { schedule, session } = fixture();
		const picks = quickPicks(schedule, session);
		expect(picks[0]).toEqual({
			dayKey: 'day-1',
			roomId: 'room-a',
			startMin: 60,
			note: 'Fits exactly after “Keynote”'
		});
		expect(picks).toHaveLength(3);
		// Every pick is genuinely placeable.
		for (const pick of picks) {
			const conflicts = preflight(schedule, session, pick.dayKey, pick.roomId, pick.startMin);
			expect(conflicts.filter((c) => c.severity === 'block')).toHaveLength(0);
		}
	});

	test('retired rooms are not offered', () => {
		const { schedule, session } = fixture();
		schedule.rooms[1].status = 'retired';
		expect(quickPicks(schedule, session, 10).some((pick) => pick.roomId === 'room-b')).toBe(false);
	});

	test('exact fit outranks a larger packed gap without pretending capacity predicts demand', () => {
		const { schedule, session } = fixture();
		const exactBoundary: SessionItem = {
			id: 'ses-boundary',
			title: 'Boundary',
			speakers: [],
			trackId: 'trk',
			formatId: 'fmt',
			durationMin: 30,
			state: 'programmed'
		};
		schedule.sessions.push(exactBoundary);
		schedule.placements.push({
			sessionId: exactBoundary.id,
			dayKey: 'day-2',
			roomId: 'room-b',
			startMin: 45,
			conflicts: []
		});
		session.durationMin = 45;
		// Capacity is context only: the smaller room still wins because its
		// opening is the exact schedule fit and no audience estimate exists.
		schedule.rooms[0].capacity = 1_000;
		schedule.rooms[1].capacity = 10;

		expect(bestOpening(schedule, session)).toEqual({
			dayKey: 'day-2',
			roomId: 'room-b',
			startMin: 0,
			note: 'Fits exactly before “Boundary”'
		});
	});

	test('returns no recommendation when no safe opening can hold the duration', () => {
		const { schedule, session } = fixture();
		session.durationMin = 481;
		expect(bestOpening(schedule, session)).toBeNull();
	});

	test('live speaker conflicts follow canonical person identity, not matching email alone', () => {
		const { schedule, session } = fixture();
		session.speakers = [{ personId: 'person-ada', name: 'Ada', email: 'shared@fixture.test' }];
		const other = schedule.sessions.find((entry) => entry.id === 'ses-ada');
		if (!other) throw new Error('fixture session missing');
		other.speakers = [{ personId: 'person-other', name: 'Other', email: 'shared@fixture.test' }];

		const pick = bestOpening(schedule, session);
		expect(pick).not.toBeNull();
		// Different canonical people may share an address without manufacturing
		// a double-booking. Room occupancy still applies normally.
		expect(columnSegments(schedule, session, 'day-1', 'room-a')).not.toContainEqual(
			expect.objectContaining({ kind: 'blocked', reason: expect.stringContaining('speaking') })
		);
	});
});

describe('landsOnOrigin', () => {
	const origin: Placement = {
		sessionId: 'ses-1',
		dayKey: 'day-1',
		roomId: 'room-a',
		startMin: 90,
		conflicts: []
	};

	test('the origin slot is recognised, so a move back onto it has nothing to confirm', () => {
		expect(landsOnOrigin(origin, 'day-1', 'room-a', 90)).toBe(true);
	});

	test('one aim step away is a real move, not a near-miss to be swallowed', () => {
		expect(landsOnOrigin(origin, 'day-1', 'room-a', 90 + AIM_STEP_MIN)).toBe(false);
		expect(landsOnOrigin(origin, 'day-1', 'room-a', 89)).toBe(false);
	});

	test('same time in another room, or another day, is a move', () => {
		expect(landsOnOrigin(origin, 'day-1', 'room-b', 90)).toBe(false);
		expect(landsOnOrigin(origin, 'day-2', 'room-a', 90)).toBe(false);
	});

	test('a session from the pool has no origin to land on', () => {
		expect(landsOnOrigin(null, 'day-1', 'room-a', 90)).toBe(false);
	});
});
