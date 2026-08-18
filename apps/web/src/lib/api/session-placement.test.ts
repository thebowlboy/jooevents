import { describe, expect, test } from 'bun:test';
import { sessionPlacementDisplay, type PlacementDisplaySource } from './session-placement';

/**
 * Turning grid geometry into the words a reader sees, and the seams where the
 * schedule cannot say — each of which answers with nothing rather than a
 * half-fact.
 */

function schedule(overrides: Partial<PlacementDisplaySource> = {}): PlacementDisplaySource {
	return {
		days: [
			{ key: 'day-1', label: 'Tue Oct 13' },
			{ key: 'day-2', label: 'Wed Oct 14' }
		],
		rooms: [
			{ id: 'room-main', name: 'Main Stage' },
			{ id: 'room-2a', name: 'Room 2A' }
		],
		dayStart: '09:00',
		sessions: [{ id: 'ses-1', durationMin: 60 }],
		placements: [{ sessionId: 'ses-1', dayKey: 'day-1', roomId: 'room-main', startMin: 90 }],
		...overrides
	};
}

describe('a placed session states where and when', () => {
	test('the clock is the event’s own: the day start is added back before it is spelled', () => {
		// 09:00 day start + 90 minutes in, running 60 minutes.
		expect(sessionPlacementDisplay(schedule(), 'ses-1')).toEqual({
			day: 'Tue Oct 13',
			time: '10:30–11:30',
			room: 'Main Stage'
		});
	});

	test('a sitting that crosses noon keeps a two-digit clock', () => {
		const state = schedule({
			placements: [{ sessionId: 'ses-1', dayKey: 'day-1', roomId: 'room-2a', startMin: 165 }]
		});
		expect(sessionPlacementDisplay(state, 'ses-1')?.time).toBe('11:45–12:45');
	});

	test('an unplaced session says nothing at all', () => {
		expect(sessionPlacementDisplay(schedule({ placements: [] }), 'ses-1')).toBeUndefined();
	});

	// A placement can outlive the day or room it names. It is still real, but it
	// no longer points at a place anyone can walk to, and the raw key is a
	// machine id wearing a label's clothes.
	test('a placement whose day or room no longer resolves says nothing rather than printing a key', () => {
		const goneDay = schedule({ days: [{ key: 'day-2', label: 'Wed Oct 14' }] });
		expect(sessionPlacementDisplay(goneDay, 'ses-1')).toBeUndefined();

		const goneRoom = schedule({ rooms: [{ id: 'room-2a', name: 'Room 2A' }] });
		expect(sessionPlacementDisplay(goneRoom, 'ses-1')).toBeUndefined();
	});

	// Without the session record the sitting has no length, so a range would be
	// invented rather than read.
	test('a placement with no session record says nothing', () => {
		expect(sessionPlacementDisplay(schedule({ sessions: [] }), 'ses-1')).toBeUndefined();
	});
});

/**
 * The sample profile joins placement at read time rather than storing it on the
 * roster row, so the grid stays the single authority and an interactive place
 * or unplace is truthful on the very next read.
 */
describe('the speaker profile a peek reads', () => {
	type Api = typeof import('./workspace').api;

	let instance = 0;
	async function freshApi(): Promise<Api> {
		const loaded = (await import(`./workspace?peek-placement=${(instance += 1)}`)) as { api: Api };
		return loaded.api;
	}

	// Maya holds ses-2, placed 90 minutes into day one on the Main Stage — the
	// cancellation scenario the line exists for.
	const MAYA = 'maya@nordicweb.dev';

	test('a placed session carries its day, clock range and room', async () => {
		const api = await freshApi();
		const profile = await api.speakers.profile(MAYA);
		const session = profile?.sessions?.find((entry) => entry.id === 'ses-2');
		expect(session?.placement).toEqual({
			day: 'Tue Oct 13',
			time: '10:30–11:00',
			room: 'Main Stage'
		});
	});

	test('unplacing the session takes the line away on the next read', async () => {
		const api = await freshApi();
		await api.schedule.unplace('ses-2');
		const profile = await api.speakers.profile(MAYA);
		const session = profile?.sessions?.find((entry) => entry.id === 'ses-2');
		expect(session).toBeDefined();
		// The session itself is untouched — only the claim about where it sits.
		expect(session?.title).toBe('Context Caching Without Tears');
		expect(session?.placement).toBeUndefined();
	});

	test('placing it again states the new sitting, not the old one', async () => {
		const api = await freshApi();
		await api.schedule.place('ses-2', 'day-2', 'room-2a', 0);
		const profile = await api.speakers.profile(MAYA);
		const session = profile?.sessions?.find((entry) => entry.id === 'ses-2');
		expect(session?.placement).toEqual({
			day: 'Wed Oct 14',
			time: '09:00–09:30',
			room: 'Breakout Stage A'
		});
	});
});
