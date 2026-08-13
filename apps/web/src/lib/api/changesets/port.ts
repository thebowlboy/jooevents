import type {
	ChangesetDiffData,
	ChangesetRevisionSelector,
	OperationReceiptRef,
	StructuredOutcome
} from '@jooevents/contracts';
import type { SafeApiError } from '../client';
import type { OperatorHttpBindingUnavailableReason } from '../operations/operator-http-binding';

export type ChangesetReviewRisk = 'low' | 'normal' | 'consequential';
export type ChangesetReviewStatus = 'draft' | 'proposed' | 'committed' | 'discarded';
export type ChangesetReviewBadgeTone = 'neutral' | 'info' | 'warning' | 'success';
export type ChangesetSafeDiff = ChangesetDiffData['operations'][number]['safeDiff'];

export interface ChangesetReviewStatusView {
	readonly value: ChangesetReviewStatus;
	readonly label: 'Draft' | 'Proposed' | 'Committed' | 'Discarded';
	readonly tone: ChangesetReviewBadgeTone;
}

export interface ChangesetReviewRiskView {
	readonly value: ChangesetReviewRisk;
	readonly label: 'Low risk' | 'Normal risk' | 'Consequential';
	readonly tone: ChangesetReviewBadgeTone;
}

export interface ChangesetReviewOperationView {
	readonly key: string;
	readonly kind: string;
	readonly kindLabel: string;
	readonly version: number;
	readonly risk: ChangesetReviewRiskView;
	readonly dependencyGroup: string;
	readonly safeDiff: ChangesetSafeDiff;
	readonly safeDiffText: string;
	readonly consequences: readonly string[];
	readonly consequenceLabels: readonly string[];
}

export interface ChangesetReviewGroupView {
	readonly key: string;
	readonly label: string;
	readonly risk: ChangesetReviewRiskView;
	readonly operations: readonly ChangesetReviewOperationView[];
	readonly consequences: readonly string[];
	readonly consequenceLabels: readonly string[];
}

export interface ChangesetDiffView {
	readonly selector: ChangesetRevisionSelector;
	readonly headVersion: number;
	readonly status: ChangesetReviewStatusView;
	readonly revisionNumber: number;
	readonly risk: ChangesetReviewRiskView;
	readonly approval: {
		readonly requirement: 'none' | 'distinct_current_human';
		readonly label: 'No separate approval required' | 'Separate approval required';
	};
	readonly operationCount: number;
	readonly groups: readonly ChangesetReviewGroupView[];
}

export interface ChangesetCommitView {
	readonly changesetId: string;
	readonly expectedHeadVersion: number;
	readonly committedHeadVersion: number;
	readonly revisionId: string;
	readonly revisionDigest: string;
}

export type ChangesetReviewOperation = 'diff' | 'propose' | 'commit';

export type ChangesetReviewResult<Data> =
	| {
			readonly kind: 'success';
			readonly data: Data;
			readonly correlationId?: string;
			readonly receipt?: OperationReceiptRef;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal?: boolean;
			readonly correlationId: string;
			readonly receipt?: OperationReceiptRef;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| {
			readonly kind: 'unavailable';
			readonly operation: ChangesetReviewOperation;
			readonly reason: OperatorHttpBindingUnavailableReason;
	  };

export interface ChangesetReviewEffectInput extends ChangesetRevisionSelector {
	readonly expectedHeadVersion: number;
}

/**
 * Browser-owned review boundary. A live or sample composition may implement this
 * port, but a component never changes source after a failed call.
 */
export interface ChangesetReviewPort {
	readonly source: { readonly kind: 'live' } | { readonly kind: 'sample'; readonly label: 'Sample data' };
	readDiff(
		selector: ChangesetRevisionSelector,
		options?: { readonly signal?: AbortSignal }
	): Promise<ChangesetReviewResult<ChangesetDiffView>>;
	propose(
		input: ChangesetReviewEffectInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<ChangesetReviewResult<ChangesetDiffView>>;
	commit(
		input: ChangesetReviewEffectInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<ChangesetReviewResult<ChangesetCommitView>>;
}
