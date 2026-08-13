import { describe, expect, test } from 'bun:test';
import opening from './opening';
import flight from './flight';
import quiet from './quiet';
import crunch from './crunch';

const aieScenarios = [opening, flight, quiet, crunch];

describe('AI Engineer demo scenarios', () => {
	// The event switcher made the workspace hold two real events (decision:
	// implementation/account-menu-and-event-switcher.md §4): three scenarios
	// are NYC moments, `opening` is London just-opened, and each scenario is
	// internally coherent about which event it belongs to.
	test('three moments share the NYC event; opening is the distinct London event', () => {
		for (const scenario of [flight, quiet, crunch]) {
			expect(scenario.summary.event).toMatchObject({
				id: 'evt_aie-nyc-2026',
				name: 'AI Engineer NYC 2026',
				dates: 'Oct 12–14, 2026',
				location: 'New York City',
				timezone: 'America/New_York'
			});
			expect(scenario.settings).toMatchObject({
				name: 'AI Engineer NYC 2026',
				startDate: '2026-10-12',
				endDate: '2026-10-14'
			});
		}
		expect(opening.summary.event).toMatchObject({
			id: 'evt_aie-london-2027',
			name: 'AI Engineer London 2027',
			dates: 'Mar 3–4, 2027',
			location: 'London',
			timezone: 'Europe/London'
		});
		expect(opening.settings).toMatchObject({
			name: 'AI Engineer London 2027',
			startDate: '2027-03-03',
			endDate: '2027-03-04'
		});
		// Two events, not an accidental third: the switcher projects one entry
		// per distinct id.
		const ids = new Set(aieScenarios.map((scenario) => scenario.summary.event?.id));
		expect(ids).toEqual(new Set(['evt_aie-nyc-2026', 'evt_aie-london-2027']));
	});

	test('the archived fiction does not leak into the active dataset', () => {
		const activeDataset = JSON.stringify(aieScenarios);
		expect(activeDataset).not.toContain('Aurora Dev Summit');
		expect(activeDataset).not.toContain('evt_aurora');
		expect(activeDataset).not.toContain('Europe/Helsinki');
	});

	test('submission and schedule references resolve inside each scenario', () => {
		for (const scenario of aieScenarios) {
			const trackIds = new Set(scenario.tracks.map(({ id }) => id));
			const formatIds = new Set(scenario.formats.map(({ id }) => id));
			const roomIds = new Set(scenario.schedule.rooms.map(({ id }) => id));
			const dayKeys = new Set(scenario.schedule.days.map(({ key }) => key));
			const sessionIds = new Set(scenario.schedule.sessions.map(({ id }) => id));

			for (const submission of scenario.submissions) {
				expect(trackIds.has(submission.trackId)).toBe(true);
				expect(formatIds.has(submission.formatId)).toBe(true);
			}

			for (const session of scenario.schedule.sessions) {
				expect(trackIds.has(session.trackId)).toBe(true);
				expect(formatIds.has(session.formatId)).toBe(true);
			}

			for (const placement of scenario.schedule.placements) {
				expect(sessionIds.has(placement.sessionId)).toBe(true);
				expect(roomIds.has(placement.roomId)).toBe(true);
				expect(dayKeys.has(placement.dayKey)).toBe(true);
			}

			for (const brk of scenario.schedule.breaks) {
				expect(roomIds.has(brk.roomId)).toBe(true);
				expect(dayKeys.has(brk.dayKey)).toBe(true);
			}
		}
	});
});
