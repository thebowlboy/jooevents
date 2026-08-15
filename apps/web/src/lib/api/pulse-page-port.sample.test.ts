import { describe, expect, test } from 'bun:test';
import { scenarios } from './sample/registry';
import type { WorkspaceSummary } from './types';
import { samplePulseSummary } from './sample/pulse';
import { createSamplePulsePagePort } from './pulse-page-port.sample';

const NOW = Date.now();

function summaryOf(key: string): WorkspaceSummary {
	const dataset = scenarios.find((scenario) => scenario.key === key);
	if (!dataset) throw new Error(`unknown_scenario:${key}`);
	return { ...dataset.summary, arrivals: null };
}

describe('sample Pulse stories stay coherent with their scenarios', () => {
	for (const key of ['flight', 'opening', 'crunch', 'quiet']) {
		test(`${key}: series, breakdown, and track fill tell one story`, () => {
			const data = samplePulseSummary({ scenarioKey: key, summary: summaryOf(key), now: NOW });
			expect(data.event).not.toBeNull();
			expect(data.series.map((series) => series.key)).toEqual([
				'proposals',
				'reviews',
				'decisions'
			]);

			for (const series of data.series) {
				if (series.absence !== undefined) {
					// Absence of measurement is never rendered as a zero chart.
					expect(series.weeks).toHaveLength(0);
					expect(series.windowCount).toBe(0);
					continue;
				}
				expect(series.weeks).toHaveLength(12);
				const counts = series.weeks.map((week) => week.count);
				for (const count of counts) expect(count).toBeGreaterThanOrEqual(0);
				// Weeks are the last twelve; older activity may live in `total` only.
				expect(counts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(series.total);
				// The recency window is the last two buckets, and never more than the total.
				expect(series.windowCount).toBe(counts.slice(-2).reduce((sum, count) => sum + count, 0));
				expect(series.windowCount).toBeLessThanOrEqual(series.total);
				// Oldest first, each start a real instant strictly after the previous.
				const starts = series.weeks.map((week) => Date.parse(week.startsAt));
				for (const start of starts) expect(Number.isFinite(start)).toBe(true);
				for (let index = 1; index < starts.length; index += 1) {
					expect(starts[index]!).toBeGreaterThan(starts[index - 1]!);
				}
			}

			const proposals = data.series.find((series) => series.key === 'proposals')!;
			const decisions = data.series.find((series) => series.key === 'decisions')!;

			// The hero's figures restate the same totals the detail panels carry,
			// and its funnel is one nested, monotone story in one unit.
			const figure = (label: string) =>
				data.hero.figures.find((entry) => entry.label === label)?.value;
			expect(figure('Proposals')).toBe(String(proposals.total));
			const acceptedCount =
				data.breakdown.rows.find((row) => row.state === 'accepted')?.count ?? 0;
			if (decisions.absence === undefined) {
				expect(figure('Decided')).toBe(String(decisions.total));
				expect(figure('Accepted')).toBe(String(acceptedCount));
			} else {
				expect(figure('Decided')).toBeUndefined();
				expect(figure('Accepted')).toBeUndefined();
			}
			const funnel = data.hero.funnel;
			if (proposals.absence === undefined) {
				if (!funnel) throw new Error('expected_funnel');
				expect(funnel).toHaveLength(12);
				const lastWeek = funnel[funnel.length - 1]!;
				expect(lastWeek.received).toBe(proposals.total);
				if (decisions.absence === undefined) {
					expect(lastWeek.decided).toBe(decisions.total);
					expect(lastWeek.accepted).toBe(acceptedCount);
				}
				let previous: (typeof funnel)[number] | null = null;
				for (const week of funnel) {
					expect(week.received).toBeGreaterThanOrEqual(week.decided ?? 0);
					expect(week.decided ?? 0).toBeGreaterThanOrEqual(week.accepted ?? 0);
					if (previous) {
						expect(week.received).toBeGreaterThanOrEqual(previous.received);
						expect(week.decided ?? 0).toBeGreaterThanOrEqual(previous.decided ?? 0);
						expect(week.accepted ?? 0).toBeGreaterThanOrEqual(previous.accepted ?? 0);
					}
					previous = week;
				}
			}
			// The breakdown speaks for the same population the proposals total counts.
			expect(data.breakdown.total).toBe(proposals.total);
			if (data.breakdown.absence === undefined) {
				const rowSum = data.breakdown.rows.reduce((sum, row) => sum + row.count, 0);
				expect(rowSum).toBe(data.breakdown.total);
				for (const row of data.breakdown.rows) expect(row.count).toBeGreaterThan(0);
			} else {
				expect(data.breakdown.rows).toHaveLength(0);
			}

			if (data.tracks.rows.length > 0) {
				expect(data.tracks.absence).toBeUndefined();
				const trackProposals = data.tracks.rows.reduce((sum, row) => sum + row.proposals, 0);
				expect(trackProposals).toBe(proposals.total);
				const accepted = data.breakdown.rows.find((row) => row.state === 'accepted')?.count ?? 0;
				const trackAccepted = data.tracks.rows.reduce((sum, row) => sum + row.accepted, 0);
				expect(trackAccepted).toBe(accepted);
				// The speaker ratio bars speak for the roster the line beneath counts.
				const rosterBySenario: Record<string, number> = { flight: 9, crunch: 12, quiet: 10 };
				const trackSpeakers = data.tracks.rows.reduce((sum, row) => sum + row.speakers, 0);
				expect(trackSpeakers).toBe(rosterBySenario[key]!);
				for (const row of data.tracks.rows) expect(row.speakers).toBeGreaterThanOrEqual(0);
			}
		});
	}

	test('a workspace with no event serves an explicit nothing', () => {
		const data = samplePulseSummary({ scenarioKey: 'fresh', summary: summaryOf('fresh'), now: NOW });
		expect(data.event).toBeNull();
		expect(data.hero.figures).toHaveLength(0);
		expect(data.series).toHaveLength(0);
		expect(data.breakdown.rows).toHaveLength(0);
		expect(data.tracks.rows).toHaveLength(0);
	});

	test('an unknown scenario (a just-created event) reads as before-anything, not as invented data', () => {
		const data = samplePulseSummary({
			scenarioKey: 'created:evt-x',
			summary: summaryOf('flight'),
			now: NOW
		});
		for (const series of data.series) expect(series.absence).toBeDefined();
		expect(data.hero.absence).toBeDefined();
		expect(data.breakdown.absence).toBeDefined();
		expect(data.tracks.absence).toBeDefined();
	});
});

describe('sample Pulse page port', () => {
	test('snapshot and read serve the same projection over the workspace summary', async () => {
		const summary = summaryOf('flight');
		const port = createSamplePulsePagePort({
			scenario: { key: 'flight', name: 'Mid-flight', description: '' },
			api: {
				workspace: {
					async summary() {
						return summary;
					},
					summarySnapshot() {
						return summary;
					}
				}
			}
		});
		const snapshot = port.snapshot();
		if (!snapshot) throw new Error('expected_sample_snapshot');
		expect(snapshot.event).toEqual(summary.event);
		const read = await port.read();
		if (read.kind !== 'success') throw new Error('expected_success');
		expect(read.data.series.map((series) => series.total)).toEqual(
			snapshot.series.map((series) => series.total)
		);
	});
});
