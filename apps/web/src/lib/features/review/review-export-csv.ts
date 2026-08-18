import type { ReviewResultRow } from '$lib/api/review-page-port';
import { sortReviewResults } from './review-results';

export const REVIEW_STATUS_CSV_FILENAME = 'review-status.csv';

const HEADER = [
	'submission_id',
	'title',
	'status',
	'committed_reviews',
	'aggregate',
	'scale_max',
	'standing_band',
	'standing_phrase',
	'overall'
] as const;

/**
 * Authorized review-status CSV. Only fields the organizer results read already
 * served: identity of the submission, review status, aggregate, and the one
 * safe overall criterion. Reviewer identity never enters the file.
 */
export function reviewStatusCsv(rows: readonly ReviewResultRow[]): string {
	const lines = [HEADER.join(',')];
	for (const row of sortReviewResults(rows)) {
		const overall = row.criteria.find((criterion) => criterion.key === 'overall');
		lines.push(
			[
				csvField(row.submissionId),
				csvField(row.title),
				csvField(row.status),
				csvField(String(row.reviews)),
				csvField(row.standing ? formatScore(row.standing.value) : ''),
				csvField(row.standing ? String(row.standing.scaleMax) : ''),
				csvField(row.standing?.band ?? ''),
				csvField(row.standing?.phrase ?? ''),
				csvField(overall ? formatScore(overall.value) : '')
			].join(',')
		);
	}
	return `${lines.join('\n')}\n`;
}

function formatScore(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function csvField(value: string): string {
	if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
	return value;
}
