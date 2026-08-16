import {
	operationHttpIdempotencyKeySchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	REVIEWER_ROSTER_OPERATION_SCHEMA_REFS,
	reviewerRosterChangeDraftInputSchema,
	reviewerRosterDirectOperationResultSchema,
	reviewerRosterSnapshotReadInputSchema,
	reviewerRosterSnapshotReadResultSchema,
	type ReviewerRosterMutationResult,
	type ReviewerRosterSnapshotDto
} from '@jooevents/contracts/reviewer-roster';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { mapReviewerRosterSnapshot } from '../mappers/reviewer-roster';
import type {
	ReviewerRosterChangeRequest,
	ReviewerRosterCoreEffectResult,
	ReviewerRosterCoreOperation,
	ReviewerRosterCorePort,
	ReviewerRosterCoreReadResult,
	ReviewerRosterIdempotencyKey,
	ReviewerRosterSnapshotRequest
} from '../reviewer-roster-core-port';
import type { ReviewerRosterSnapshotView } from '../view-models/reviewer-roster';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

/**
 * Frozen browser expectations mirrored from the Reviewer Roster operation
 * package. They are local because the web application depends only on public
 * contracts.
 */
export const REVIEWER_ROSTER_LIVE_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({
		name: 'reviewer_roster.snapshot.read',
		version: 1,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: '/api/events/current/reviewer-roster'
	} as const),
	change: Object.freeze({
		name: 'reviewer_roster.change',
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/reviewer-roster/changes'
	} as const)
});

type BindingKey = keyof typeof REVIEWER_ROSTER_LIVE_OPERATIONS;
type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };

const EXPECTED_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({
		...REVIEWER_ROSTER_LIVE_OPERATIONS.snapshot,
		...REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.snapshotRead
	}),
	change: Object.freeze({
		...REVIEWER_ROSTER_LIVE_OPERATIONS.change,
		...REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.change
	})
} satisfies Readonly<Record<BindingKey, ExactExpectedOperation>>);

type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

export interface ReviewerRosterRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type ReviewerRosterRequester = (
	input: ReviewerRosterRequestInput
) => Promise<ApiResult<unknown>>;

type CanonicalReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string };

type CanonicalEffectResult<Data> =
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
	  };

function defaultRequester(input: ReviewerRosterRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function resolveExactBinding(
	manifest: unknown,
	expected: ExactExpectedOperation
): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	if (binding.kind === 'available' && binding.path !== expected.path) {
		return { kind: 'unavailable', reason: 'operation_contract_mismatch' };
	}
	return binding;
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze({
		snapshot: resolveExactBinding(manifest, EXPECTED_OPERATIONS.snapshot),
		change: resolveExactBinding(manifest, EXPECTED_OPERATIONS.change)
	});
}

function unavailable(
	operation: ReviewerRosterCoreOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
) {
	return { kind: 'unavailable' as const, operation, reason: binding.reason };
}

function invalidRequest() {
	return {
		kind: 'transport_error' as const,
		error: { code: 'invalid_request', retryable: false } satisfies SafeApiError
	};
}

function invalidContract() {
	return {
		kind: 'transport_error' as const,
		error: { code: 'invalid_contract', retryable: true } satisfies SafeApiError
	};
}

async function parsedResponse<Result>(input: {
	readonly request: ReviewerRosterRequester;
	readonly requestInput: ReviewerRosterRequestInput;
	readonly schema: z.ZodType<Result>;
}): Promise<
	| { readonly kind: 'parsed'; readonly result: Result }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
> {
	const response = await input.request(input.requestInput);
	if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
	const parsed = input.schema.safeParse(response.data);
	return parsed.success
		? { kind: 'parsed', result: parsed.data }
		: { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function receiptMatches(
	receipt: OperationReceiptRef,
	operation: { readonly name: string; readonly version: number }
): boolean {
	return receipt.operationName === operation.name && receipt.operationVersion === operation.version;
}

/**
 * Creates the honest live Reviewer Roster core port. It resolves every call
 * through the browser-safe operation manifest and never imports sample data or
 * backend code. Roster identity stays access-subject-keyed end to end.
 */
export function createReviewerRosterLivePort(input: {
	readonly manifest: unknown;
	readonly request?: ReviewerRosterRequester;
}): ReviewerRosterCorePort {
	const bindings = resolveBindings(input.manifest);
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async readSnapshot(
			rawInput: ReviewerRosterSnapshotRequest = {},
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewerRosterCoreReadResult<ReviewerRosterSnapshotView>> {
			const parsedInput = reviewerRosterSnapshotReadInputSchema.safeParse(rawInput);
			if (!parsedInput.success) return invalidRequest();
			const binding = bindings.snapshot;
			if (binding.kind === 'unavailable') return unavailable('snapshot', binding);
			const response = await parsedResponse<CanonicalReadResult<ReviewerRosterSnapshotDto>>({
				request,
				requestInput: {
					path: binding.path,
					method: 'GET',
					schema: reviewerRosterSnapshotReadResultSchema,
					...(options.signal ? { signal: options.signal } : {})
				},
				schema: reviewerRosterSnapshotReadResultSchema
			});
			if (response.kind === 'transport_error') return response;
			if (response.result.kind === 'outcome') return response.result;
			try {
				return { ...response.result, data: mapReviewerRosterSnapshot(response.result.data) };
			} catch {
				return invalidContract();
			}
		},

		async change(
			rawInput: ReviewerRosterChangeRequest,
			idempotencyKey: ReviewerRosterIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewerRosterCoreEffectResult<ReviewerRosterMutationResult>> {
			const parsedInput = reviewerRosterChangeDraftInputSchema.safeParse(rawInput);
			const parsedKey = operationHttpIdempotencyKeySchema.safeParse(idempotencyKey);
			if (!parsedInput.success || !parsedKey.success) return invalidRequest();
			const binding = bindings.change;
			if (binding.kind === 'unavailable') return unavailable('change', binding);
			const response = await parsedResponse<
				CanonicalEffectResult<ReviewerRosterMutationResult>
			>({
				request,
				requestInput: {
					path: binding.path,
					method: 'POST',
					schema: reviewerRosterDirectOperationResultSchema,
					body: parsedInput.data,
					idempotencyKey: parsedKey.data,
					...(options.signal ? { signal: options.signal } : {})
				},
				schema: reviewerRosterDirectOperationResultSchema
			});
			if (response.kind === 'transport_error') return response;
			const result = response.result;
			if (result.kind === 'outcome') {
				if (
					result.terminal
					&& !receiptMatches(result.receipt, REVIEWER_ROSTER_LIVE_OPERATIONS.change)
				) {
					return invalidContract();
				}
				return result;
			}
			if (!receiptMatches(result.receipt, REVIEWER_ROSTER_LIVE_OPERATIONS.change)
				|| result.data.action !== parsedInput.data.action
				|| result.data.reviewer.reviewerId !== parsedInput.data.reviewerId) {
				return invalidContract();
			}
			return result;
		}
	});
}
