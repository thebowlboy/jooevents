import { describe, expect, test } from 'bun:test';
import opening from './opening';
import flight from './flight';
import quiet from './quiet';
import crunch from './crunch';

const aieScenarios = [opening, flight, quiet, crunch];
const trayKeys = ['inbox', 'set-aside', 'late', 'discarded'] as const;

function navNumber(value: string | { value: string }): number {
	return Number(typeof value === 'string' ? value : value.value);
}

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

	test('direct demo counts resolve to the same fixture rows as their destinations', () => {
		for (const scenario of aieScenarios) {
			// The badge counts what the area still has to work through, so a
			// discarded row — kept, recoverable, and nobody's task — is out of it.
			// The Overview's arrival total reads the same population, which is why
			// the two agree on screen instead of differing by the discard tray.
			expect(navNumber(scenario.summary.navCounts.submissions!)).toBe(
				scenario.submissions.filter((submission) => submission.tray !== 'discarded').length
			);
			expect(navNumber(scenario.summary.navCounts.speakers!)).toBe(scenario.speakers.length);

			for (const tray of trayKeys) {
				expect(scenario.submissionTrayTotals[tray]).toBe(
					scenario.submissions.filter((submission) => submission.tray === tray).length
				);
			}

			const lateTray = scenario.summary.trays.find((tray) => tray.kind === 'late');
			const discardedTray = scenario.summary.trays.find((tray) => tray.kind === 'discarded');
			expect(lateTray?.count).toBe(scenario.submissionTrayTotals.late);
			expect(discardedTray?.count).toBe(scenario.submissionTrayTotals.discarded);

			const cfp = scenario.forms.find((form) => form.id === 'form-cfp');
			if (cfp) {
				expect(cfp.submissionCount).toBe(
					scenario.submissions.filter((submission) => submission.source === 'cfp').length
				);
			}

			if (scenario.summary.navCounts.tasks) {
				expect(navNumber(scenario.summary.navCounts.tasks)).toBe(
				scenario.assignments.filter((assignment) => assignment.overdue).length
				);
			}
			if (scenario.summary.navCounts.schedule) {
				expect(navNumber(scenario.summary.navCounts.schedule)).toBe(
					scenario.schedule.placements.filter((placement) =>
						placement.conflicts.some((conflict) => conflict.severity === 'block')
					).length
				);
			}

			const unnotified = scenario.summary.attention.find((item) => item.id === 'unnotified');
			if (unnotified) {
				const count = Number(unnotified.title.match(/^\d+/)?.[0]);
				expect(count).toBe(
					scenario.submissions.filter(
						(submission) => submission.decision !== 'undecided' && !submission.notified
					).length
				);
			}
		}
	});
});
