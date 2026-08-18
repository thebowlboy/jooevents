import { describe, expect, test } from 'bun:test';
import type { Reviewer } from '$lib/api/types';
import { outstandingReviews, reviewReminderBatch } from './reminder-batch';

function reviewer(input: Partial<Reviewer> & Pick<Reviewer, 'id' | 'name'>): Reviewer {
	return {
		status: 'active',
		scope: [],
		assigned: 0,
		done: 0,
		steppedBack: 0,
		awaitingReassignment: 0,
		...input
	};
}

describe('review reminder batch', () => {
	test('selects an arbitrary subset and names every exclusion', () => {
		const sofia = reviewer({
			id: 'mem-2',
			name: 'Sofia Berg',
			email: 'sofia@example.test',
			assigned: 10,
			done: 3
		});
		const jonas = reviewer({
			id: 'mem-3',
			name: 'Jonas Weber',
			email: 'jonas@example.test',
			assigned: 10,
			done: 10
		});
		const elif = reviewer({
			id: 'mem-7',
			name: 'Elif Aydın',
			assigned: 8,
			done: 2
		});
		const priya = reviewer({
			id: 'mem-9',
			name: 'Priya Shah',
			email: 'priya@example.test',
			status: 'invited'
		});
		const batch = reviewReminderBatch([sofia, jonas, elif, priya]);

		expect(batch.included.map((entry) => entry.reviewer.id)).toEqual(['mem-2']);
		expect(batch.excluded.map((entry) => ({ id: entry.reviewer.id, reason: entry.reason }))).toEqual([
			{ id: 'mem-3', reason: 'No reviews are still open' },
			{ id: 'mem-7', reason: 'No email on file' },
			{ id: 'mem-9', reason: 'This person has not arrived yet' }
		]);
	});

	test('does not treat an unresolved step-back as outstanding work', () => {
		const row = reviewer({
			id: 'mem-3',
			name: 'Jonas Weber',
			email: 'jonas@example.test',
			assigned: 2,
			done: 1,
			steppedBack: 1,
			awaitingReassignment: 1
		});
		expect(outstandingReviews(row)).toBe(0);
		expect(reviewReminderBatch([row]).excluded[0]?.reason).toBe('No reviews are still open');
	});
});
