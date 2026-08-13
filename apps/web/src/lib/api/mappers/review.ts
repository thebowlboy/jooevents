import type { StructuredOutcome } from '@jooevents/contracts';
import {
	reviewRoundOpenAtomicJoinRequirementSchema,
	type ReviewDraftSaveResult,
	type ReviewRoundSetupProjection,
	type ReviewSnapshot
} from '@jooevents/contracts/reviews';
import type { z } from 'zod';
import type { reviewChangeDraftDataSchema } from '@jooevents/contracts/reviews';
import type {
	ReviewChangeDraftView,
	ReviewDraftSaveView,
	ReviewOpenRoundAtomicJoinRequirementView,
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

/**
 * Narrows the one open-round blocker whose detail is part of the browser contract.
 * All other structured outcomes remain opaque envelopes for feature-safe copy.
 */
export function reviewOpenRoundAtomicJoinRequirement(
	outcome: StructuredOutcome
): ReviewOpenRoundAtomicJoinRequirementView | undefined {
	if (
		outcome.class !== 'conflict' ||
		outcome.kind !== 'review.open_round_atomic_join_required' ||
		outcome.retryable ||
		outcome.detailSchemaVersion !== 1
	) {
		return undefined;
	}
	const parsed = reviewRoundOpenAtomicJoinRequirementSchema.safeParse(outcome.detail);
	return parsed.success ? immutableCopy(parsed.data) : undefined;
}
