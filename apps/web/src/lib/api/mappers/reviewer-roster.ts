import type { ReviewerRosterSnapshotDto } from '@jooevents/contracts/reviewer-roster';
import type {
	ReviewerRosterSnapshotView,
	ReviewerRosterView
} from '../view-models/reviewer-roster';

function freezeJson(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

/**
 * Severs mutable wire aliases without translating canonical absence into a UI guess.
 * Contract additions are kept by value and by type instead of being silently dropped.
 */
function immutableCopy<Value>(value: Value): ReviewerRosterView<Value> {
	const copy = structuredClone(value);
	freezeJson(copy);
	return copy as ReviewerRosterView<Value>;
}

export function mapReviewerRosterSnapshot(
	value: ReviewerRosterSnapshotDto
): ReviewerRosterSnapshotView {
	return immutableCopy(value);
}
