import { describe, expect, test } from 'bun:test';
import { columnLabel, columnLabels, shouldLabelCell } from './record-table';

describe('record labels', () => {
	test('a column name is collapsed to the word the record shows', () => {
		expect(columnLabel('  Review\n  avg  ')).toBe('Review avg');
		expect(columnLabels(['Submission', ' Decision ', ''])).toEqual([
			'Submission',
			'Decision',
			''
		]);
	});

	// A header that exists only to hold a control or a visually-hidden name
	// labels nothing, and "DETAILS: ⌄" beside a chevron is noise.
	test('a wordless column labels nothing', () => {
		expect(
			shouldLabelCell({ classes: ['col-expand'], colSpan: 1, hasOwnLabel: false, label: '' })
		).toBe(false);
	});

	test('an ordinary scan-key cell takes its column name', () => {
		expect(
			shouldLabelCell({ classes: ['ui-table__number'], colSpan: 1, hasOwnLabel: false, label: 'Reviews' })
		).toBe(true);
	});

	test('structural cells are placed, not stacked', () => {
		for (const role of [
			'ui-pick-cell',
			'ui-cell--rail',
			'ui-cell--lead',
			'ui-cell--state',
			'ui-cell--trail',
			'ui-cell--detail'
		]) {
			expect(
				shouldLabelCell({ classes: [role], colSpan: 1, hasOwnLabel: false, label: 'Decision' })
			).toBe(false);
		}
	});

	test('a spanning cell is its own block', () => {
		expect(
			shouldLabelCell({ classes: [], colSpan: 6, hasOwnLabel: false, label: 'Submission' })
		).toBe(false);
	});

	test("a page's own label is never overwritten", () => {
		expect(
			shouldLabelCell({ classes: [], colSpan: 1, hasOwnLabel: true, label: 'Review average' })
		).toBe(false);
	});
});
