import type {
	operationHttpIdempotencyKeySchema,
	OperationReceiptRef,
	StructuredOutcome
} from '@jooevents/contracts';
import type {
	reviewDraftSaveInputSchema,
	reviewEvaluationChangeDraftInputSchema,
	reviewRoundChangeDraftInputSchema,
	reviewSnapshotReadInputSchema,
	reviewStepBackChangeDraftInputSchema
} from '@jooevents/contracts/reviews';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type {
	ReviewChangeDraftView,
	ReviewDraftSaveView,
	ReviewRoundSetupView,
	ReviewSnapshotView
} from './view-models/review';

export type ReviewSnapshotRequest = z.input<typeof reviewSnapshotReadInputSchema>;
export type ReviewRoundChangeDraftRequest = z.input<typeof reviewRoundChangeDraftInputSchema>;
export type ReviewStepBackDraftRequest = z.input<typeof reviewStepBackChangeDraftInputSchema>;
export type ReviewEvaluationChangeDraftRequest = z.input<
	typeof reviewEvaluationChangeDraftInputSchema
>;
export type ReviewEvaluationDraftSaveRequest = z.input<typeof reviewDraftSaveInputSchema>;
export type ReviewIdempotencyKey = z.input<typeof operationHttpIdempotencyKeySchema>;

export type ReviewCoreOperation =
	| 'snapshot'
	| 'round_setup'
	| 'round_change_draft'
	| 'step_back_draft'
	| 'evaluation_change_draft'
	| 'evaluation_draft_save';

export type ReviewCoreUnavailableResult = {
	readonly kind: 'unavailable';
	readonly operation: ReviewCoreOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type ReviewCoreReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| ReviewCoreUnavailableResult;

export type ReviewCoreEffectResult<Data> =
	| {
			readonly kind: 'success';
			readonly data: Data;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: true;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: false;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| ReviewCoreUnavailableResult;

export type ReviewCoreSource =
	| { readonly kind: 'live' }
	| {
			readonly kind: 'sample';
			readonly label: 'Sample data';
			readonly scenario: {
				readonly key: string;
				readonly name: string;
				readonly description: string;
			};
	  };

/**
 * Source-neutral boundary over the Review capabilities the backend currently owns.
 *
 * There are deliberately no profile, reminder, accolade, comparison, or direct
 * commit methods here. Those tuned-screen capabilities are mounted only after their
 * own canonical operations exist; a live Review source never fills them with sample
 * behavior or inferred facts.
 */
export interface ReviewCorePort {
	readonly source: ReviewCoreSource;

	readSnapshot(
		input?: ReviewSnapshotRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreReadResult<ReviewSnapshotView>>;
	readRoundSetup(
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreReadResult<ReviewRoundSetupView>>;
	draftRoundChange(
		input: ReviewRoundChangeDraftRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewChangeDraftView>>;
	draftStepBack(
		input: ReviewStepBackDraftRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewChangeDraftView>>;
	draftEvaluationChange(
		input: ReviewEvaluationChangeDraftRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewChangeDraftView>>;
	saveEvaluationDraft(
		input: ReviewEvaluationDraftSaveRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewDraftSaveView>>;
}
