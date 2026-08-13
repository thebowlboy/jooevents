import type {
	ReviewDraftSaveResult,
	ReviewRoundSetupProjection,
	ReviewSnapshot
} from '@jooevents/contracts/reviews';
import type { z } from 'zod';
import type { reviewChangeDraftDataSchema } from '@jooevents/contracts/reviews';
import type {
	ReviewChangeDraftView,
	ReviewDraftSaveView,
	ReviewRoundSetupView,
	ReviewSnapshotView,
	ReviewView
} from '../view-models/review';

type ReviewChangeDraftData = z.infer<typeof reviewChangeDraftDataSchema>;

function freezeJson(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

/**
 * Severs mutable wire aliases without translating canonical absence into a UI guess.
 * Contract additions are kept by value and by type instead of being silently dropped.
 */
function immutableCopy<Value>(value: Value): ReviewView<Value> {
	const copy = structuredClone(value);
	freezeJson(copy);
	return copy as ReviewView<Value>;
}

export function mapReviewSnapshot(value: ReviewSnapshot): ReviewSnapshotView {
	return immutableCopy(value);
}

export function mapReviewRoundSetup(
	value: ReviewRoundSetupProjection
): ReviewRoundSetupView {
	return immutableCopy(value);
}

export function mapReviewChangeDraft(
	value: ReviewChangeDraftData
): ReviewChangeDraftView {
	return immutableCopy(value);
}

export function mapReviewDraftSave(value: ReviewDraftSaveResult): ReviewDraftSaveView {
	return immutableCopy(value);
}
