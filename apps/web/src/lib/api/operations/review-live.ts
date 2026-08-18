import {
	operationHttpIdempotencyKeySchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	REVIEW_OPERATION_SCHEMA_REFS,
	reviewDirectOperationResultSchema,
	reviewAccoladeChangeDraftInputSchema,
	reviewAccoladeChangeOperationResultSchema,
	reviewDraftSaveInputSchema,
	reviewDraftSaveOperationResultSchema,
	reviewEvaluationChangeDraftInputSchema,
	reviewRoundChangeDraftInputSchema,
	reviewRoundSetupReadResultSchema,
	reviewSnapshotReadInputSchema,
	reviewSnapshotReadResultSchema,
	reviewStepBackChangeDraftInputSchema,
	reviewVacancyChangeDraftInputSchema,
	type ReviewDraftSaveResult,
	type ReviewAccoladeChangeResult,
	type ReviewMutationResult,
	type ReviewRoundSetupProjection,
	type ReviewSnapshot
} from '@jooevents/contracts/reviews';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapReviewDraftSave,
	mapReviewRoundSetup,
	mapReviewSnapshot
} from '../mappers/review';
import type {
	ReviewCoreEffectResult,
	ReviewCoreOperation,
	ReviewCorePort,
	ReviewCoreReadResult,
	ReviewAccoladeChangeRequest,
	ReviewEvaluationChangeRequest,
	ReviewEvaluationDraftSaveRequest,
	ReviewIdempotencyKey,
	ReviewRoundChangeRequest,
	ReviewSnapshotRequest,
	ReviewStepBackRequest,
	ReviewVacancyChangeRequest
} from '../review-core-port';
import type {
	ReviewDraftSaveView,
	ReviewRoundSetupView,
	ReviewSnapshotView
} from '../view-models/review';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

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
	round_change: Object.freeze({
		name: 'review.round.change',
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/rounds'
	} as const),
	step_back: Object.freeze({
		name: 'review.assignment.step_back',
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/assignments/step-back'
	} as const),
	vacancy_change: Object.freeze({
		name: 'review.assignment.vacancy.change',
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/assignments/vacancy'
	} as const),
	evaluation_change: Object.freeze({
		name: 'review.evaluation.change',
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/evaluations'
	} as const),
	accolade_change: Object.freeze({
		name: 'review.accolade.change',
		version: 1,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		path: '/api/events/current/review/accolades'
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
	round_change: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.round_change,
		...REVIEW_OPERATION_SCHEMA_REFS.roundChange
	}),
	step_back: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.step_back,
		...REVIEW_OPERATION_SCHEMA_REFS.stepBack
	}),
	vacancy_change: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.vacancy_change,
		...REVIEW_OPERATION_SCHEMA_REFS.vacancyChange
	}),
	evaluation_change: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.evaluation_change,
		...REVIEW_OPERATION_SCHEMA_REFS.evaluationChange
	}),
	accolade_change: Object.freeze({
		...REVIEW_LIVE_OPERATIONS.accolade_change,
		...REVIEW_OPERATION_SCHEMA_REFS.accoladeChange
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
	return Object.freeze({
		snapshot: resolveExactBinding(manifest, EXPECTED_OPERATIONS.snapshot),
		round_setup: resolveExactBinding(manifest, EXPECTED_OPERATIONS.round_setup),
		round_change: resolveExactBinding(manifest, EXPECTED_OPERATIONS.round_change),
		step_back: resolveExactBinding(manifest, EXPECTED_OPERATIONS.step_back),
		vacancy_change: resolveExactBinding(manifest, EXPECTED_OPERATIONS.vacancy_change),
		evaluation_change: resolveExactBinding(manifest, EXPECTED_OPERATIONS.evaluation_change),
		accolade_change: resolveExactBinding(manifest, EXPECTED_OPERATIONS.accolade_change),
		evaluation_draft_save: resolveExactBinding(manifest, EXPECTED_OPERATIONS.evaluation_draft_save)
	});
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
}): ReviewCoreEffectResult<View> {
	const result = input.result;
	if (result.kind === 'outcome') {
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
			'round_change' | 'step_back' | 'vacancy_change' | 'evaluation_change' | 'accolade_change' | 'evaluation_draft_save'>;
		readonly rawInput: Input;
		readonly inputSchema: z.ZodType;
		readonly idempotencyKey: ReviewIdempotencyKey;
		readonly resultSchema: z.ZodType<CanonicalEffectResult<Data>>;
		readonly map: (data: Data) => View;
		readonly expectedAction?: string;
		readonly signal?: AbortSignal;
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
		if (response.result.kind === 'success' && options.expectedAction !== undefined) {
			const data = response.result.data;
			if (typeof data !== 'object' || data === null || !('action' in data)
				|| data.action !== options.expectedAction) return invalidContract();
		}
		return mapEffectResult({
			result: response.result,
			operation: REVIEW_LIVE_OPERATIONS[options.operation],
			map: options.map
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

		changeRound(
			rawInput: ReviewRoundChangeRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewMutationResult>> {
			return effect<ReviewRoundChangeRequest, ReviewMutationResult, ReviewMutationResult>({
				operation: 'round_change',
				rawInput,
				inputSchema: reviewRoundChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewDirectOperationResultSchema,
				expectedAction: rawInput.action,
				map: (data) => data,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		stepBack(
			rawInput: ReviewStepBackRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewMutationResult>> {
			return effect<ReviewStepBackRequest, ReviewMutationResult, ReviewMutationResult>({
				operation: 'step_back',
				rawInput,
				inputSchema: reviewStepBackChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewDirectOperationResultSchema,
				expectedAction: rawInput.action,
				map: (data) => data,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		changeVacancy(
			rawInput: ReviewVacancyChangeRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewMutationResult>> {
			return effect<ReviewVacancyChangeRequest, ReviewMutationResult, ReviewMutationResult>({
				operation: 'vacancy_change',
				rawInput,
				inputSchema: reviewVacancyChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewDirectOperationResultSchema,
				expectedAction: rawInput.action,
				map: (data) => data,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		changeEvaluation(
			rawInput: ReviewEvaluationChangeRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewMutationResult>> {
			return effect<
				ReviewEvaluationChangeRequest,
				ReviewMutationResult,
				ReviewMutationResult
			>({
				operation: 'evaluation_change',
				rawInput,
				inputSchema: reviewEvaluationChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewDirectOperationResultSchema,
				expectedAction: rawInput.action,
				map: (data) => data,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		changeAccolade(
			rawInput: ReviewAccoladeChangeRequest,
			idempotencyKey: ReviewIdempotencyKey,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ReviewCoreEffectResult<ReviewAccoladeChangeResult>> {
			return effect<
				ReviewAccoladeChangeRequest,
				ReviewAccoladeChangeResult,
				ReviewAccoladeChangeResult
			>({
				operation: 'accolade_change',
				rawInput,
				inputSchema: reviewAccoladeChangeDraftInputSchema,
				idempotencyKey,
				resultSchema: reviewAccoladeChangeOperationResultSchema,
				expectedAction: rawInput.action,
				map: (data) => data,
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
