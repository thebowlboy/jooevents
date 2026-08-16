import type {
	ReviewDraftSaveResult,
	ReviewPlanProjection,
	ReviewQueueItemProjection,
	ReviewRoundSetupProjection,
	ReviewSnapshot,
	ReviewStanding
} from '@jooevents/contracts/reviews';

/**
 * Browser-owned, immutable copies of Review projections.
 *
 * The canonical names stay intact on purpose. In particular, optional identity,
 * queue, peer-score, draft, and revision fields describe disclosure or lifecycle
 * truth; a display adapter must not replace their absence with made-up labels or
 * empty values.
 */
type ReviewScalar = string | number | boolean | bigint | symbol | null | undefined;

export type ReviewView<Value> =
	Value extends ReviewScalar
		? Value
		: Value extends (...args: never[]) => unknown
		? Value
		: Value extends readonly (infer Item)[]
			? readonly ReviewView<Item>[]
			: Value extends object
				? { readonly [Key in keyof Value]: ReviewView<Value[Key]> }
				: Value;

export type ReviewSnapshotView = ReviewView<ReviewSnapshot>;
export type ReviewPlanView = ReviewView<ReviewPlanProjection>;
export type ReviewQueueItemView = ReviewView<ReviewQueueItemProjection>;
export type ReviewStandingView = ReviewView<ReviewStanding>;
export type ReviewRoundSetupView = ReviewView<ReviewRoundSetupProjection>;

export type ReviewDraftSaveView = ReviewView<ReviewDraftSaveResult>;
