import { describe, expect, test } from 'bun:test';
import type { ScoreStanding } from '$lib/api/types';
import { assembleReviewResults, compareReviewResults, reviewResultRow } from './review-results';

function standing(input: Partial<ScoreStanding> & Pick<ScoreStanding, 'value' | 'n' | 'band'>): ScoreStanding {
	return {
		scaleMax: 5,
		reviews: 3,
		median: input.value,
		phrase: input.band === 'few' ? 'Only 5 scored so far — too few to rank' : 'Higher than 80% of 40 scored',
		slice: { label: 'Track' },
		points: [],
		...input
	};
}

describe('review results', () => {
	test('sorts by aggregate then deterministic tie-breakers', () => {
		const high = reviewResultRow({ submissionId: 'sub-b', title: 'Beta' }, standing({ value: 4.6, n: 40, band: 'top' }));
		const tiedLater = reviewResultRow(
			{ submissionId: 'sub-d', title: 'Delta' },
			standing({ value: 4.1, n: 40, band: 'upper', reviews: 2 })
		);
		const tiedEarlier = reviewResultRow(
			{ submissionId: 'sub-c', title: 'Alpha' },
			standing({ value: 4.1, n: 40, band: 'upper', reviews: 2 })
		);
		const unscored = reviewResultRow({ submissionId: 'sub-a', title: 'Early draft' }, null);

		expect(
			[unscored, tiedLater, high, tiedEarlier].sort(compareReviewResults).map((row) => row.submissionId)
		).toEqual(['sub-b', 'sub-c', 'sub-d', 'sub-a']);
	});

	test('sparse cohorts keep the numeral and refuse a rank claim', () => {
		const row = reviewResultRow(
			{ submissionId: 'sub-1', title: 'Only five so far' },
			standing({ value: 4.9, n: 5, band: 'few', reviews: 2, phrase: 'Only 5 scored so far — too few to rank' })
		);
		expect(row.standing?.value).toBe(4.9);
		expect(row.standing?.band).toBe('few');
		expect(row.standing?.phrase).toContain('too few to rank');
		expect(row.criteria).toEqual([{ key: 'overall', label: 'Overall', value: 4.9 }]);
	});

	test('assembles authorized rows without inventing an aggregate', () => {
		const rows = assembleReviewResults(
			[
				{ submissionId: 'sub-2', title: 'Still open', reviews: 1 },
				{ submissionId: 'sub-1', title: 'Scored talk' }
			],
			{ 'sub-1': standing({ value: 3.2, n: 20, band: 'mid' }) }
		);
		expect(rows.map((row) => ({ id: row.submissionId, status: row.status, reviews: row.reviews }))).toEqual([
			{ id: 'sub-1', status: 'scored', reviews: 3 },
			{ id: 'sub-2', status: 'in_review', reviews: 1 }
		]);
		expect(rows[1]?.standing).toBeNull();
		expect(rows[1]?.criteria).toEqual([]);
	});
});
