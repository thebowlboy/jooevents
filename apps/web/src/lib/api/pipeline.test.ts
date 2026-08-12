import { describe, expect, test } from 'bun:test';
import type { PipelineStage } from './types';
import flight from './sample/flight';
import opening from './sample/opening';
import crunch from './sample/crunch';
import quiet from './sample/quiet';
import fresh from './sample/fresh';

const scenarios = [flight, opening, crunch, quiet];

function stage(pipeline: PipelineStage[], key: PipelineStage['key']): PipelineStage {
	const found = pipeline.find((entry) => entry.key === key);
	if (!found) throw new Error(`missing pipeline stage: ${key}`);
	return found;
}

describe('pipeline progress and pace', () => {
	test('every authored progress fraction is a coherent done/required pair', () => {
		for (const scenario of scenarios) {
			for (const entry of scenario.summary.pipeline) {
				if (!entry.progress) continue;
				const { done, required } = entry.progress;
				expect(done).toBeGreaterThanOrEqual(0);
				expect(required).toBeGreaterThan(0);
				expect(done).toBeLessThanOrEqual(required);
				expect(Number.isInteger(done)).toBe(true);
				expect(Number.isInteger(required)).toBe(true);
			}
		}
	});

	test('every pace claim names the deadline it is measured against', () => {
		for (const scenario of scenarios) {
			for (const entry of scenario.summary.pipeline) {
				if (!entry.paceTone) continue;
				expect(entry.deadlineLabel).toBeTruthy();
				expect(entry.deadlineIso).toBeTruthy();
			}
		}
	});

	test('opening review has no plan, so no progress and no pace — absence of measurement is not 0%', () => {
		const review = stage(opening.summary.pipeline, 'review');
		expect(review.progress).toBeUndefined();
		expect(review.paceTone).toBeUndefined();
	});

	test('crunch review is behind despite a fraction above 0.9 — pace answers the clock, not the meter', () => {
		const review = stage(crunch.summary.pipeline, 'review');
		expect(review.progress).toEqual({ done: 583, required: 600 });
		expect(review.progress!.done / review.progress!.required).toBeGreaterThan(0.9);
		expect(review.paceTone).toBe('behind');
	});

	test('quiet completion stays neutral: full meters carry at most an on-pace tone', () => {
		for (const entry of quiet.summary.pipeline) {
			if (!entry.progress) continue;
			if (entry.progress.done === entry.progress.required) {
				expect(entry.paceTone === undefined || entry.paceTone === 'on').toBe(true);
			}
		}
	});

	test('fresh has no event and therefore no pipeline', () => {
		expect(fresh.summary.event).toBeNull();
		expect(fresh.summary.pipeline).toEqual([]);
	});
});
