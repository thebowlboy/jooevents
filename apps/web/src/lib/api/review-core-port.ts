import type {
	operationHttpIdempotencyKeySchema,
	OperationReceiptRef,
	StructuredOutcome
} from '@jooevents/contracts';
import type {
	reviewDraftSaveInputSchema,
	reviewAccoladeChangeDraftInputSchema,
	reviewEvaluationChangeDraftInputSchema,
	reviewRoundChangeDraftInputSchema,
	reviewSnapshotReadInputSchema,
	reviewStepBackChangeDraftInputSchema,
	reviewVacancyChangeDraftInputSchema,
	ReviewMutationResult,
	ReviewAccoladeChangeResult
} from '@jooevents/contracts/reviews';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type {
	ReviewDraftSaveView,
	ReviewRoundSetupView,
	ReviewSnapshotView,
	ReviewView
} from './view-models/review';

export type ReviewSnapshotRequest = z.input<typeof reviewSnapshotReadInputSchema>;
export type ReviewRoundChangeRequest = z.input<typeof reviewRoundChangeDraftInputSchema>;
export type ReviewStepBackRequest = z.input<typeof reviewStepBackChangeDraftInputSchema>;
export type ReviewVacancyChangeRequest = z.input<typeof reviewVacancyChangeDraftInputSchema>;
export type ReviewEvaluationChangeRequest = z.input<
	typeof reviewEvaluationChangeDraftInputSchema
>;
export type ReviewAccoladeChangeRequest = z.input<typeof reviewAccoladeChangeDraftInputSchema>;
export type ReviewMutationView = ReviewView<ReviewMutationResult>;
export type ReviewEvaluationDraftSaveRequest = z.input<typeof reviewDraftSaveInputSchema>;
export type ReviewIdempotencyKey = z.input<typeof operationHttpIdempotencyKeySchema>;

export type ReviewCoreOperation =
	| 'snapshot'
	| 'round_setup'
	| 'round_change'
	| 'step_back'
	| 'vacancy_change'
	| 'evaluation_change'
	| 'accolade_change'
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
 * Only canonical Review operations belong here. Profile and reminder capabilities
 * remain outside this boundary; evaluation and accolade commits are mounted because
 * they now resolve registered operations rather than sample behavior or inferred facts.
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
	changeRound(
		input: ReviewRoundChangeRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewMutationView>>;
	stepBack(
		input: ReviewStepBackRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewMutationView>>;
	changeVacancy?(
		input: ReviewVacancyChangeRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewMutationView>>;
	changeEvaluation(
		input: ReviewEvaluationChangeRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewMutationView>>;
	changeAccolade(
		input: ReviewAccoladeChangeRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewAccoladeChangeResult>>;
	saveEvaluationDraft(
		input: ReviewEvaluationDraftSaveRequest,
		idempotencyKey: ReviewIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewCoreEffectResult<ReviewDraftSaveView>>;
}
