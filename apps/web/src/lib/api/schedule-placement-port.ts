import type {
	operationHttpIdempotencyKeySchema,
	OperationReceiptRef,
	StructuredOutcome
} from '@jooevents/contracts';
import type {
	schedulePlacementInputSchema,
	schedulePlacementReadInputSchema
} from '@jooevents/contracts/schedule-placement';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type {
	SchedulePlacementCommittedView,
	SchedulePlacementSnapshotView
} from './view-models/schedule-placement';

export type SchedulePlacementReadRange = z.input<typeof schedulePlacementReadInputSchema>;
export type SchedulePlacementMutationRequest = z.input<typeof schedulePlacementInputSchema>;
export type SchedulePlacementIdempotencyKey = z.input<typeof operationHttpIdempotencyKeySchema>;

export type SchedulePlacementCoreOperation = 'snapshot' | 'draft' | 'propose' | 'commit';

export type SchedulePlacementUnavailableResult = {
	readonly kind: 'unavailable';
	readonly operation: SchedulePlacementCoreOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type SchedulePlacementReadResult =
	| {
			readonly kind: 'success';
			readonly data: SchedulePlacementSnapshotView;
			readonly correlationId: string;
	  }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| SchedulePlacementUnavailableResult;

export type SchedulePlacementApplyResult =
	| {
			readonly kind: 'success';
			readonly data: SchedulePlacementCommittedView;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: boolean;
			readonly receipt?: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| SchedulePlacementUnavailableResult;

export type SchedulePlacementCoreSource =
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
 * Source-neutral boundary over canonical placement occurrences only.
 *
 * It deliberately excludes Sessions, breaks, conflicts involving people, public
 * releases, templates, and event-local calendar geometry. Those owners must join
 * before this can implement the tuned SchedulePagePort.
 */
export interface SchedulePlacementCorePort {
	readonly source: SchedulePlacementCoreSource;

	readPlacements(
		range: SchedulePlacementReadRange,
		options?: { readonly signal?: AbortSignal }
	): Promise<SchedulePlacementReadResult>;

	placeOrMove(
		request: SchedulePlacementMutationRequest,
		idempotencyKey: SchedulePlacementIdempotencyKey,
		options?: { readonly signal?: AbortSignal }
	): Promise<SchedulePlacementApplyResult>;
}
