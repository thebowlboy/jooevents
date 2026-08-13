import {
	operationHttpIdempotencyKeySchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	REVIEWER_ROSTER_OPERATION_SCHEMA_REFS,
	reviewerRosterChangeDraftInputSchema,
	reviewerRosterChangeDraftOperationResultSchema,
	reviewerRosterSnapshotReadInputSchema,
	reviewerRosterSnapshotReadResultSchema,
	type ReviewerRosterChangeDraftData,
	type ReviewerRosterSnapshotDto
} from '@jooevents/contracts/reviewer-roster';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapReviewerRosterChangeDraft,
	mapReviewerRosterSnapshot
} from '../mappers/reviewer-roster';
import type {
	ReviewerRosterChangeDraftRequest,
	ReviewerRosterCoreEffectResult,
	ReviewerRosterCoreOperation,
	ReviewerRosterCorePort,
	ReviewerRosterCoreReadResult,
	ReviewerRosterIdempotencyKey,
	ReviewerRosterSnapshotRequest
} from '../reviewer-roster-core-port';
import type {
	ReviewerRosterChangeDraftView,
	ReviewerRosterSnapshotView
} from '../view-models/reviewer-roster';
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
	change_draft: Object.freeze({
		name: 'reviewer_roster.change.draft',
		version: 1,
		effect: 'draft',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/reviewer-roster/drafts'
	} as const)
});

type BindingKey = keyof typeof REVIEWER_ROSTER_LIVE_OPERATIONS;
type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };

const EXPECTED_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({
		...REVIEWER_ROSTER_LIVE_OPERATIONS.snapshot,
		...REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.snapshotRead
	}),
	change_draft: Object.freeze({
		...REVIEWER_ROSTER_LIVE_OPERATIONS.change_draft,
		...REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.changeDraft
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
	return Object.freeze(Object.fromEntries(
		Object.entries(EXPECTED_OPERATIONS).map(([key, expected]) => [
			key,
			resolveExactBinding(manifest, expected)
		])
	) as unknown as Bindings);
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

		async draftChange(
			rawInput: ReviewerRosterChangeDraftRequest,
			idempotencyKey: ReviewerRosterIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewerRosterCoreEffectResult<ReviewerRosterChangeDraftView>> {
			const parsedInput = reviewerRosterChangeDraftInputSchema.safeParse(rawInput);
			const parsedKey = operationHttpIdempotencyKeySchema.safeParse(idempotencyKey);
			if (!parsedInput.success || !parsedKey.success) return invalidRequest();
			const binding = bindings.change_draft;
			if (binding.kind === 'unavailable') return unavailable('change_draft', binding);
			const response = await parsedResponse<
				CanonicalEffectResult<ReviewerRosterChangeDraftData>
			>({
				request,
				requestInput: {
					path: binding.path,
					method: 'POST',
					schema: reviewerRosterChangeDraftOperationResultSchema,
					body: parsedInput.data,
					idempotencyKey: parsedKey.data,
					...(options.signal ? { signal: options.signal } : {})
				},
				schema: reviewerRosterChangeDraftOperationResultSchema
			});
			if (response.kind === 'transport_error') return response;
			const result = response.result;
			if (result.kind === 'outcome') {
				if (
					result.terminal
					&& !receiptMatches(result.receipt, REVIEWER_ROSTER_LIVE_OPERATIONS.change_draft)
				) {
					return invalidContract();
				}
				return result;
			}
			if (!receiptMatches(result.receipt, REVIEWER_ROSTER_LIVE_OPERATIONS.change_draft)) {
				return invalidContract();
			}
			try {
				return { ...result, data: mapReviewerRosterChangeDraft(result.data) };
			} catch {
				return invalidContract();
			}
		}
	});
}
