import {
	operationHttpIdempotencyKeySchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	REVIEW_OPERATION_SCHEMA_REFS,
	reviewChangeDraftDataSchema,
	reviewChangeDraftOperationResultSchema,
	reviewDraftSaveInputSchema,
	reviewDraftSaveOperationResultSchema,
	reviewEvaluationChangeDraftInputSchema,
	reviewRoundChangeDraftInputSchema,
	reviewRoundSetupReadResultSchema,
	reviewSnapshotReadInputSchema,
	reviewSnapshotReadResultSchema,
	reviewStepBackChangeDraftInputSchema,
	type ReviewDraftSaveResult,
	type ReviewRoundSetupProjection,
	type ReviewSnapshot
} from '@jooevents/contracts/reviews';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapReviewChangeDraft,
	mapReviewDraftSave,
	mapReviewRoundSetup,
	mapReviewSnapshot,
	reviewOpenRoundAtomicJoinRequirement
} from '../mappers/review';
import type {
	ReviewCoreEffectResult,
	ReviewCoreOperation,
	ReviewCorePort,
	ReviewCoreReadResult,
	ReviewEvaluationChangeDraftRequest,
	ReviewEvaluationDraftSaveRequest,
	ReviewIdempotencyKey,
	ReviewRoundChangeDraftRequest,
	ReviewSnapshotRequest,
	ReviewStepBackDraftRequest
} from '../review-core-port';
import type {
	ReviewChangeDraftView,
	ReviewDraftSaveView,
	ReviewRoundSetupView,
	ReviewSnapshotView
} from '../view-models/review';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

type ReviewChangeDraftData = z.infer<typeof reviewChangeDraftDataSchema>;

/**
 * Frozen browser expectations mirrored from the Review operation package.
 * They are local because the web application depends only on public contracts.
 */
export const REVIEW_LIVE_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({
		name: 'review.snapshot.read',
		version: 1,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: '/api/events/current/review/snapshot'
	} as const),
	round_setup: Object.freeze({
		name: 'review.round.setup.read',
		version: 1,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: '/api/events/current/review/round-setup'
	} as const),
	round_change_draft: Object.freeze({
		name: 'review.round.change.draft',
		version: 1,
		effect: 'draft',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/round-drafts'
	} as const),
	step_back_draft: Object.freeze({
		name: 'review.assignment.step-back.draft',
		version: 1,
		effect: 'draft',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/step-back-drafts'
	} as const),
	evaluation_change_draft: Object.freeze({
		name: 'review.evaluation.change.draft',
		version: 1,
		effect: 'draft',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/evaluation-drafts'
	} as const),
	evaluation_draft_save: Object.freeze({
		name: 'review.evaluation.draft.save',
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/evaluation-draft'
	} as const)
});

type BindingKey = keyof typeof REVIEW_LIVE_OPERATIONS;
type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };

const EXPECTED_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.snapshot,
		...REVIEW_OPERATION_SCHEMA_REFS.snapshotRead
	}),
	round_setup: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.round_setup,
		...REVIEW_OPERATION_SCHEMA_REFS.roundSetupRead
	}),
	round_change_draft: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.round_change_draft,
		...REVIEW_OPERATION_SCHEMA_REFS.roundChangeDraft
	}),
	step_back_draft: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.step_back_draft,
		...REVIEW_OPERATION_SCHEMA_REFS.stepBackDraft
	}),
	evaluation_change_draft: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.evaluation_change_draft,
		...REVIEW_OPERATION_SCHEMA_REFS.evaluationChangeDraft
	}),
	evaluation_draft_save: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.evaluation_draft_save,
		...REVIEW_OPERATION_SCHEMA_REFS.draftSave
	})
} satisfies Readonly<Record<BindingKey, ExactExpectedOperation>>);

type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

export interface ReviewRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type ReviewRequester = (input: ReviewRequestInput) => Promise<ApiResult<unknown>>;

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

function defaultRequester(input: ReviewRequestInput): Promise<ApiResult<unknown>> {
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
	operation: ReviewCoreOperation,
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
	readonly request: ReviewRequester;
	readonly requestInput: ReviewRequestInput;
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

function outcomeIsValid(outcome: StructuredOutcome, allowOpenRoundJoin: boolean): boolean {
	if (outcome.kind !== 'review.open_round_atomic_join_required') return true;
	return allowOpenRoundJoin && reviewOpenRoundAtomicJoinRequirement(outcome) !== undefined;
}

function mapReadResult<Data, View>(
	result: CanonicalReadResult<Data>,
	map: (data: Data) => View
): ReviewCoreReadResult<View> {
	if (result.kind === 'outcome') return result;
	try {
		return { ...result, data: map(result.data) };
	} catch {
		return invalidContract();
	}
}

function mapEffectResult<Data, View>(input: {
	readonly result: CanonicalEffectResult<Data>;
	readonly operation: { readonly name: string; readonly version: number };
	readonly map: (data: Data) => View;
	readonly allowOpenRoundJoin?: boolean;
}): ReviewCoreEffectResult<View> {
	const result = input.result;
	if (result.kind === 'outcome') {
		if (!outcomeIsValid(result.outcome, input.allowOpenRoundJoin === true)) {
			return invalidContract();
		}
		if (result.terminal && !receiptMatches(result.receipt, input.operation)) {
			return invalidContract();
		}
		return result;
	}
	if (!receiptMatches(result.receipt, input.operation)) return invalidContract();
	try {
		return { ...result, data: input.map(result.data) };
	} catch {
		return invalidContract();
	}
}

function snapshotQuery(input: z.output<typeof reviewSnapshotReadInputSchema>): string {
	const query = new URLSearchParams();
	for (const submissionId of input.standingSubmissionIds) {
		query.append('standingSubmissionIds', submissionId);
	}
	if (input.standingSlice !== 'track') query.set('standingSlice', input.standingSlice);
	return query.size === 0 ? '' : `?${query.toString()}`;
}

/**
 * Creates the honest live Review core port. It resolves every call through the
 * browser-safe operation manifest and never imports sample data or backend code.
 */
export function createReviewLivePort(input: {
	readonly manifest: unknown;
	readonly request?: ReviewRequester;
}): ReviewCorePort {
	const bindings = resolveBindings(input.manifest);
	const request = input.request ?? defaultRequester;

	async function effect<Input, Data, View>(options: {
		readonly operation: Extract<ReviewCoreOperation,
			'round_change_draft' | 'step_back_draft' | 'evaluation_change_draft' | 'evaluation_draft_save'>;
		readonly rawInput: Input;
		readonly inputSchema: z.ZodType;
		readonly idempotencyKey: ReviewIdempotencyKey;
		readonly resultSchema: z.ZodType<CanonicalEffectResult<Data>>;
		readonly map: (data: Data) => View;
		readonly signal?: AbortSignal;
		readonly allowOpenRoundJoin?: boolean;
	}): Promise<ReviewCoreEffectResult<View>> {
		const parsedInput = options.inputSchema.safeParse(options.rawInput);
		const parsedKey = operationHttpIdempotencyKeySchema.safeParse(options.idempotencyKey);
		if (!parsedInput.success || !parsedKey.success) return invalidRequest();
		const binding = bindings[options.operation];
		if (binding.kind === 'unavailable') return unavailable(options.operation, binding);
		const response = await parsedResponse({
			request,
			requestInput: {
				path: binding.path,
				method: 'POST',
				schema: options.resultSchema,
				body: parsedInput.data,
				idempotencyKey: parsedKey.data,
				...(options.signal ? { signal: options.signal } : {})
			},
			schema: options.resultSchema
		});
		if (response.kind === 'transport_error') return response;
		return mapEffectResult({
			result: response.result,
			operation: REVIEW_LIVE_OPERATIONS[options.operation],
			map: options.map,
			...(options.allowOpenRoundJoin ? { allowOpenRoundJoin: true } : {})
		});
	}

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		async readSnapshot(
			rawInput: ReviewSnapshotRequest = {},
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreReadResult<ReviewSnapshotView>> {
			const parsedInput = reviewSnapshotReadInputSchema.safeParse(rawInput);
			if (!parsedInput.success) return invalidRequest();
			const binding = bindings.snapshot;
			if (binding.kind === 'unavailable') return unavailable('snapshot', binding);
			const response = await parsedResponse<CanonicalReadResult<ReviewSnapshot>>({
				request,
				requestInput: {
					path: `${binding.path}${snapshotQuery(parsedInput.data)}`,
					method: 'GET',
					schema: reviewSnapshotReadResultSchema,
					...(options.signal ? { signal: options.signal } : {})
				},
				schema: reviewSnapshotReadResultSchema
			});
			if (response.kind === 'transport_error') return response;
			return mapReadResult(response.result, mapReviewSnapshot);
		},

		async readRoundSetup(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreReadResult<ReviewRoundSetupView>> {
			const binding = bindings.round_setup;
			if (binding.kind === 'unavailable') return unavailable('round_setup', binding);
			const response = await parsedResponse<CanonicalReadResult<ReviewRoundSetupProjection>>({
				request,
				requestInput: {
					path: binding.path,
					method: 'GET',
					schema: reviewRoundSetupReadResultSchema,
					...(options.signal ? { signal: options.signal } : {})
				},
				schema: reviewRoundSetupReadResultSchema
			});
			if (response.kind === 'transport_error') return response;
			return mapReadResult(response.result, mapReviewRoundSetup);
		},

		draftRoundChange(
			rawInput: ReviewRoundChangeDraftRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewChangeDraftView>> {
			return effect<ReviewRoundChangeDraftRequest, ReviewChangeDraftData, ReviewChangeDraftView>({
				operation: 'round_change_draft',
				rawInput,
				inputSchema: reviewRoundChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewChangeDraftOperationResultSchema,
				map: mapReviewChangeDraft,
				allowOpenRoundJoin: true,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		draftStepBack(
			rawInput: ReviewStepBackDraftRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewChangeDraftView>> {
			return effect<ReviewStepBackDraftRequest, ReviewChangeDraftData, ReviewChangeDraftView>({
				operation: 'step_back_draft',
				rawInput,
				inputSchema: reviewStepBackChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewChangeDraftOperationResultSchema,
				map: mapReviewChangeDraft,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		draftEvaluationChange(
			rawInput: ReviewEvaluationChangeDraftRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewChangeDraftView>> {
			return effect<
				ReviewEvaluationChangeDraftRequest,
				ReviewChangeDraftData,
				ReviewChangeDraftView
			>({
				operation: 'evaluation_change_draft',
				rawInput,
				inputSchema: reviewEvaluationChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewChangeDraftOperationResultSchema,
				map: mapReviewChangeDraft,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		saveEvaluationDraft(
			rawInput: ReviewEvaluationDraftSaveRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewDraftSaveView>> {
			return effect<ReviewEvaluationDraftSaveRequest, ReviewDraftSaveResult, ReviewDraftSaveView>({
				operation: 'evaluation_draft_save',
				rawInput,
				inputSchema: reviewDraftSaveInputSchema,
				idempotencyKey,
				resultSchema: reviewDraftSaveOperationResultSchema,
				map: mapReviewDraftSave,
				...(options.signal ? { signal: options.signal } : {})
			});
		}
	});
}
