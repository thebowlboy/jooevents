import type {
	operationHttpIdempotencyKeySchema,
	OperationReceiptRef,
	StructuredOutcome
} from '@jooevents/contracts';
import type {
	reviewerRosterChangeDraftInputSchema,
	reviewerRosterSnapshotReadInputSchema,
	ReviewerRosterMutationResult
} from '@jooevents/contracts/reviewer-roster';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type {
	ReviewerRosterSnapshotView,
	ReviewerRosterView
} from './view-models/reviewer-roster';

export type ReviewerRosterSnapshotRequest = z.input<typeof reviewerRosterSnapshotReadInputSchema>;
export type ReviewerRosterChangeRequest = z.input<
	typeof reviewerRosterChangeDraftInputSchema
>;
export type ReviewerRosterMutationView = ReviewerRosterView<ReviewerRosterMutationResult>;
export type ReviewerRosterIdempotencyKey = z.input<typeof operationHttpIdempotencyKeySchema>;

export type ReviewerRosterCoreOperation = 'snapshot' | 'change';

export type ReviewerRosterCoreUnavailableResult = {
	readonly kind: 'unavailable';
	readonly operation: ReviewerRosterCoreOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type ReviewerRosterCoreReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| ReviewerRosterCoreUnavailableResult;

export type ReviewerRosterCoreEffectResult<Data> =
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
	| ReviewerRosterCoreUnavailableResult;

export type ReviewerRosterCoreSource =
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
 * Source-neutral boundary over the Reviewer Roster capabilities the backend
 * currently owns: the joined roster/authority snapshot and direct changes.
 *
 * Roster entries are keyed by access subject (membership or reservation) —
 * never by email address. There are deliberately no invite, load-sum,
 * or coverage methods here: those tuned-screen capabilities are mounted only
 * after their own canonical owners exist, and a live Roster source never fills
 * them with sample behavior or inferred facts.
 */
export interface ReviewerRosterCorePort {
	readonly source: ReviewerRosterCoreSource;

	readSnapshot(
		input?: ReviewerRosterSnapshotRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewerRosterCoreReadResult<ReviewerRosterSnapshotView>>;
	change(
		input: ReviewerRosterChangeRequest,
		idempotencyKey: ReviewerRosterIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<ReviewerRosterCoreEffectResult<ReviewerRosterMutationView>>;
}
