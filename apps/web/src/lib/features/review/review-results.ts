import type { ScoreStanding } from '$lib/api/types';
import type { ReviewResultRow } from '$lib/api/review-page-port';

export interface ReviewResultCandidate {
	readonly submissionId: string;
	readonly title: string;
	readonly trackId?: string;
	readonly reviews?: number;
}

/**
 * One organizer result row from authorized standing plus the candidate the
 * same read already named. Absence of a standing is "not scored yet", never a
 * fabricated zero or a rank.
 */
export function reviewResultRow(
	candidate: ReviewResultCandidate,
	standing: ScoreStanding | null | undefined
): ReviewResultRow {
	const scored = standing ?? null;
	const reviews = scored?.reviews ?? candidate.reviews ?? 0;
	return {
		submissionId: candidate.submissionId,
		title: candidate.title,
		...(candidate.trackId === undefined ? {} : { trackId: candidate.trackId }),
		status: scored ? 'scored' : reviews > 0 ? 'in_review' : 'unscored',
		reviews,
		standing: scored,
		criteria: scored
			? [{ key: 'overall', label: 'Overall', value: scored.value }]
			: []
	};
}

/**
 * Highest aggregate first. Unscored rows follow every scored one. Ties break
 * by committed-review count, then title, then id — never by a standing color
 * or a rank a sparse cohort cannot support.
 */
export function compareReviewResults(left: ReviewResultRow, right: ReviewResultRow): number {
	const leftScore = left.standing?.value;
	const rightScore = right.standing?.value;
	if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore) {
		return rightScore - leftScore;
	}
	if (leftScore !== undefined && rightScore === undefined) return -1;
	if (leftScore === undefined && rightScore !== undefined) return 1;
	if (left.reviews !== right.reviews) return right.reviews - left.reviews;
	const title = left.title.localeCompare(right.title, 'en');
	if (title !== 0) return title;
	return left.submissionId.localeCompare(right.submissionId, 'en');
}

export function sortReviewResults(rows: readonly ReviewResultRow[]): ReviewResultRow[] {
	return [...rows].sort(compareReviewResults);
}

export function assembleReviewResults(
	candidates: readonly ReviewResultCandidate[],
	standings: Readonly<Record<string, ScoreStanding>>
): ReviewResultRow[] {
	return sortReviewResults(
		candidates.map((candidate) => reviewResultRow(candidate, standings[candidate.submissionId]))
	);
}
