import { describe, expect, test } from 'bun:test';
import type { ScheduleState, SessionItem, Submission } from '$lib/api/types';
import {
	groupOf,
	programGrouping,
	proposalCounts,
	roundupCounts,
	traysOf
} from './program-roundup';

const session = (over: Partial<SessionItem>): SessionItem => ({
	id: 'ses-x',
	title: 'A session',
	speakers: [{ name: 'Ada', email: 'ada@example.test' }],
	trackId: 'trk-1',
	formatId: 'fmt-talk',
	durationMin: 30,
	state: 'programmed',
	...over
});

const schedule = (sessions: SessionItem[], placedIds: string[]): ScheduleState => ({
	days: [{ key: 'd1', label: 'Wed' }],
	rooms: [],
	dayStart: '09:00',
	slotMinutes: 30,
	slotsPerDay: 16,
	sessions,
	placements: placedIds.map((sessionId) => ({
		sessionId,
		dayKey: 'd1',
		roomId: 'room-1',
		startMin: 0,
		conflicts: []
	})),
	breaks: [],
	published: false
});

const proposal = (over: Partial<Submission>): Submission => ({
	id: 'sub-x',
	title: 'A proposal',
	abstract: '',
	speakers: [{ name: 'Grace', email: 'grace@example.test' }],
	trackId: 'trk-1',
	formatId: 'fmt-talk',
	submittedAt: '2026-08-01T09:00:00Z',
	source: 'cfp',
	tray: 'inbox',
	decision: 'undecided',
	notified: false,
	signals: [],
	reviewCount: 0,
	...over
});

describe('traysOf', () => {
	test('a placed, peopled, programmed session carries no tray', () => {
		expect(traysOf(session({}), true)).toEqual([]);
	});

	test('unplaced and needs-speakers are independent marks on one session', () => {
		expect(traysOf(session({ speakers: [] }), false)).toEqual(['unplaced', 'needs-speakers']);
	});

	test('a placed collecting session is a held slot awaiting decisions', () => {
		expect(traysOf(session({ state: 'collecting', speakers: [] }), true)).toEqual([
			'undecided-in-place'
		]);
	});

	test('an unplaced collecting session is ordinary pool membership, not a tray', () => {
		expect(traysOf(session({ state: 'collecting', speakers: [] }), false)).toEqual([]);
	});

	test('drafts never escalate to a tray', () => {
		expect(traysOf(session({ state: 'draft', speakers: [] }), false)).toEqual([]);
	});

	test('an operational session without a track enters the repair tray only when the event uses tracks', () => {
		expect(traysOf(session({ trackId: '' }), true, false)).toEqual([]);
		expect(traysOf(session({ trackId: '' }), true, true)).toEqual(['needs-track']);
		expect(traysOf(session({ state: 'draft', trackId: '' }), false, true)).toEqual([]);
	});
});

describe('groupOf', () => {
	test('finished-and-placed sessions leave the panel entirely', () => {
		expect(groupOf(session({}), true)).toBeNull();
	});

	test('unplaced outranks the roster gap so a row renders once', () => {
		expect(groupOf(session({ speakers: [] }), false)).toBe('unplaced');
	});

	test('a placed programmed session with an empty roster waits under needs-speakers', () => {
		expect(groupOf(session({ speakers: [] }), true)).toBe('needs-speakers');
	});

	test('collecting splits by placement', () => {
		expect(groupOf(session({ state: 'collecting' }), false)).toBe('collecting');
		expect(groupOf(session({ state: 'collecting' }), true)).toBe('undecided-in-place');
	});

	test('track repair outranks placement and roster gaps', () => {
		expect(groupOf(session({ trackId: '', speakers: [] }), false, true)).toBe('needs-track');
	});
});

describe('proposalCounts', () => {
	test('counts only live, undecided, targeted proposals', () => {
		const counts = proposalCounts([
			proposal({ id: 'sub-1', targetSessionId: 'ses-1' }),
			proposal({ id: 'sub-2', targetSessionId: 'ses-1' }),
			proposal({ id: 'sub-3', targetSessionId: 'ses-1', decision: 'accepted' }),
			proposal({ id: 'sub-4', targetSessionId: 'ses-1', tray: 'discarded' }),
			proposal({ id: 'sub-5' })
		]);
		expect(counts.get('ses-1')).toBe(2);
	});
});

describe('roundupCounts and programGrouping', () => {
	const sessions = [
		session({ id: 'ses-done' }),
		session({ id: 'ses-unplaced' }),
		session({ id: 'ses-empty', speakers: [] }),
		session({ id: 'ses-placed-empty', speakers: [] }),
		session({ id: 'ses-held', state: 'collecting', speakers: [] }),
		session({ id: 'ses-open', state: 'collecting', speakers: [] }),
		session({ id: 'ses-sketch', state: 'draft', speakers: [] })
	];
	const state = schedule(sessions, ['ses-done', 'ses-placed-empty', 'ses-held']);

	test('each count is its own row set', () => {
		expect(roundupCounts(state)).toEqual({
			'needs-track': 0,
			unplaced: 2,
			'needs-speakers': 2,
			'undecided-in-place': 1
		});
	});

	test('the partition renders every unfinished session exactly once', () => {
		const grouping = programGrouping(
			state,
			proposalCounts([proposal({ id: 'sub-1', targetSessionId: 'ses-held' })])
		);
		const flat = grouping.order.flatMap((group) =>
			(grouping.groups.get(group) ?? []).map((row) => row.session.id)
		);
		expect(flat.sort()).toEqual(
			['ses-unplaced', 'ses-empty', 'ses-placed-empty', 'ses-held', 'ses-open', 'ses-sketch'].sort()
		);
		expect(grouping.total).toBe(6);
		const held = grouping.groups.get('undecided-in-place') ?? [];
		expect(held[0]?.proposalCount).toBe(1);
		const unplacedEmpty = (grouping.groups.get('unplaced') ?? []).find(
			(row) => row.session.id === 'ses-empty'
		);
		expect(unplacedEmpty?.trays).toEqual(['unplaced', 'needs-speakers']);
	});
});
