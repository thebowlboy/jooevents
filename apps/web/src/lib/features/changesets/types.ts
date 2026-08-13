import type {
	ChangesetCommitView,
	ChangesetReviewOperationView,
	ChangesetReviewEffectInput,
	ChangesetReviewPort
} from '$lib/api/changesets/port';
import type { ChangesetRevisionSelector, OperationReceiptRef } from '@jooevents/contracts';
import type { Snippet } from 'svelte';

export type ChangesetReviewEffectAction = 'propose' | 'commit';

export type ChangesetReviewIdempotencyKeyFactory = (input: {
	readonly action: ChangesetReviewEffectAction;
	readonly request: ChangesetReviewEffectInput;
}) => string;

export interface ChangesetReviewProps {
	readonly port: ChangesetReviewPort;
	readonly selector: ChangesetRevisionSelector;
	readonly title?: string;
	readonly idempotencyKeyFactory?: ChangesetReviewIdempotencyKeyFactory;
	/** Domain-owned before/after rendering; the complete structured fallback remains available beside it. */
	readonly operationDetail?: Snippet<[ChangesetReviewOperationView]>;
	readonly onCommitted?: (input: {
		readonly commit: ChangesetCommitView;
		readonly receipt?: OperationReceiptRef;
		readonly correlationId?: string;
	}) => void;
}
