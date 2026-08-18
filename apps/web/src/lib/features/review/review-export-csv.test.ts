import { describe, expect, test } from 'bun:test';
import type { ReviewResultRow } from '$lib/api/review-page-port';
import { reviewStatusCsv } from './review-export-csv';

const scored: ReviewResultRow = {
	submissionId: 'sub-2',
	title: 'Talk, with a comma',
	status: 'scored',
	reviews: 3,
	standing: {
		value: 4.5,
		scaleMax: 5,
		reviews: 3,
		n: 20,
		median: 3.8,
		band: 'upper',
		phrase: 'Higher than 80% of 20 scored',
		slice: { label: 'Track' },
		points: []
	},
	criteria: [{ key: 'overall', label: 'Overall', value: 4.5 }]
};

const sparse: ReviewResultRow = {
	submissionId: 'sub-1',
	title: 'Early one',
	status: 'scored',
	reviews: 1,
	standing: {
		value: 4.9,
		scaleMax: 5,
		reviews: 1,
		n: 4,
		median: 4,
		band: 'few',
		phrase: 'Only 4 scored so far — too few to rank',
		slice: { label: 'Track' },
		points: []
	},
	criteria: [{ key: 'overall', label: 'Overall', value: 4.9 }]
};

const open: ReviewResultRow = {
	submissionId: 'sub-3',
	title: 'Still open',
	status: 'unscored',
	reviews: 0,
	standing: null,
	criteria: []
};

describe('review status CSV', () => {
	test('is deterministic and quotes only authorized fields', () => {
		const first = reviewStatusCsv([open, sparse, scored]);
		const second = reviewStatusCsv([scored, open, sparse]);
		expect(first).toBe(second);
		expect(first).toBe(
			[
				'submission_id,title,status,committed_reviews,aggregate,scale_max,standing_band,standing_phrase,overall',
				'sub-1,Early one,scored,1,4.9,5,few,Only 4 scored so far — too few to rank,4.9',
				'sub-2,"Talk, with a comma",scored,3,4.5,5,upper,Higher than 80% of 20 scored,4.5',
				'sub-3,Still open,unscored,0,,,,,',
				''
			].join('\n')
		);
		expect(first).not.toContain('reviewer');
		expect(first).not.toContain('@');
	});
});
