import type {
	ReviewerRosterMemberProjectionDto,
	ReviewerRosterSnapshotDto
} from '@jooevents/contracts/reviewer-roster';

/**
 * Browser-owned, immutable copies of Reviewer Roster projections.
 *
 * The canonical names stay intact on purpose. Roster members are keyed by
 * access subject (membership or reservation) with an optional disclosed
 * `displayName`; there is deliberately no email field, and a display adapter
 * must not replace canonical absence with made-up labels or empty values.
 */
type ReviewerRosterScalar = string | number | boolean | bigint | symbol | null | undefined;

export type ReviewerRosterView<Value> =
	Value extends ReviewerRosterScalar
		? Value
		: Value extends (...args: never[]) => unknown
		? Value
		: Value extends readonly (infer Item)[]
			? readonly ReviewerRosterView<Item>[]
			: Value extends object
				? { readonly [Key in keyof Value]: ReviewerRosterView<Value[Key]> }
				: Value;

export type ReviewerRosterSnapshotView = ReviewerRosterView<ReviewerRosterSnapshotDto>;
export type ReviewerRosterMemberView = ReviewerRosterView<ReviewerRosterMemberProjectionDto>;
