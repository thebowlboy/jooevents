import type { Reviewer } from '$lib/api/types';

/**
 * Reviews this person still holds. Unresolved step-backs stay in `assigned`
 * but are nobody's to finish, so they do not count as outstanding work.
 */
export function outstandingReviews(
	row: Pick<Reviewer, 'assigned' | 'done' | 'awaitingReassignment'>
): number {
	return Math.max(0, row.assigned - row.awaitingReassignment - row.done);
}

export interface ReminderBatchEntry {
	readonly reviewer: Reviewer;
	/** Present when this person is not in the send. The send review names it. */
	readonly reason?: string;
}

export interface ReminderBatch {
	readonly roster: readonly ReminderBatchEntry[];
	readonly included: readonly ReminderBatchEntry[];
	readonly excluded: readonly ReminderBatchEntry[];
}

/**
 * Who a reviewed reminder batch would actually mail. Selection is not
 * permission to write: invited, finished, and no-address rows stay visible
 * with their reason instead of disappearing from a "sent" count.
 */
export function reviewReminderBatch(selected: readonly Reviewer[]): ReminderBatch {
	const roster = selected.map((reviewer) => ({
		reviewer,
		...(exclusionReason(reviewer) === undefined ? {} : { reason: exclusionReason(reviewer) })
	}));
	return {
		roster,
		included: roster.filter((entry) => entry.reason === undefined),
		excluded: roster.filter((entry) => entry.reason !== undefined)
	};
}

function exclusionReason(reviewer: Reviewer): string | undefined {
	if (reviewer.status === 'invited') return 'This person has not arrived yet';
	if (outstandingReviews(reviewer) === 0) return 'No reviews are still open';
	if (!reviewer.email) return 'No email on file';
	return undefined;
}
