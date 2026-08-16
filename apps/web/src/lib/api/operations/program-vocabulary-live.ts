import {
	PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	programVocabularyCreateDraftRequestSchema,
	programVocabularyDeleteDraftRequestSchema,
	programVocabularyDirectOperationResultSchema,
	programVocabularyEditDraftRequestSchema,
	programVocabularyMergeDraftRequestSchema,
	programVocabularyMergePublishInputSchema,
	programVocabularyMergePublishOperationResultSchema,
	programVocabularyMergeReviewOperationResultSchema,
	programVocabularyRestoreDraftRequestSchema,
	programVocabularyRetireDraftRequestSchema,
	programVocabularySnapshotReadResultSchema,
	type OperationReceiptRef,
	type ProgramVocabularyCreateDraftRequest,
	type ProgramVocabularyDeleteDraftRequest,
	type ProgramVocabularyDirectData,
	type ProgramVocabularyDirectOperationResult,
	type ProgramVocabularyEditDraftRequest,
	type ProgramVocabularyMergeDraftRequest,
	type ProgramVocabularyMergePublishInput,
	type ProgramVocabularyMergeReviewData,
	type ProgramVocabularyRestoreDraftRequest,
	type ProgramVocabularyRetireDraftRequest,
	type ProgramVocabularySnapshotReadResult,
	type StructuredOutcome
} from '@jooevents/contracts';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import type { EventProgramMergeDraftRequest } from '../event-program/port';
import { mapProgramVocabularySnapshot } from '../mappers/program-vocabulary';
import type { ProgramVocabularySnapshotView } from '../view-models/program-vocabulary';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION = Object.freeze({
	name: 'program_vocabulary.snapshot.read', version: 1
} as const);
export const PROGRAM_VOCABULARY_DIRECT_OPERATIONS = Object.freeze({
	create: Object.freeze({ name: 'program_vocabulary.create', version: 1 }),
	edit: Object.freeze({ name: 'program_vocabulary.edit', version: 1 }),
	retire: Object.freeze({ name: 'program_vocabulary.retire', version: 1 }),
	restore: Object.freeze({ name: 'program_vocabulary.restore', version: 1 }),
	delete: Object.freeze({ name: 'program_vocabulary.delete', version: 1 })
} as const);
export const PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION = Object.freeze({
	name: 'program_vocabulary.merge.draft', version: 1
} as const);
export const PROGRAM_VOCABULARY_MERGE_PUBLISH_OPERATION = Object.freeze({
	name: 'program_vocabulary.merge', version: 1
} as const);

type DirectAction = keyof typeof PROGRAM_VOCABULARY_DIRECT_OPERATIONS;
type ProgramVocabularyMergeReviewOperationResult = ReturnType<typeof programVocabularyMergeReviewOperationResultSchema.parse>;
type ProgramVocabularyMergePublishOperationResult = ReturnType<typeof programVocabularyMergePublishOperationResultSchema.parse>;
type DirectInput =
	| ProgramVocabularyCreateDraftRequest | ProgramVocabularyEditDraftRequest
	| ProgramVocabularyRetireDraftRequest | ProgramVocabularyRestoreDraftRequest
	| ProgramVocabularyDeleteDraftRequest;
type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };
const PATHS = Object.freeze({
	read: '/api/events/current/program-vocabulary',
	create: '/api/events/current/program-vocabulary/create',
	edit: '/api/events/current/program-vocabulary/edit',
	retire: '/api/events/current/program-vocabulary/retire',
	restore: '/api/events/current/program-vocabulary/restore',
	delete: '/api/events/current/program-vocabulary/delete',
	mergeDraft: '/api/events/current/program-vocabulary/merge/draft',
	mergePublish: '/api/events/current/program-vocabulary/merge'
} as const);
const DIRECT_SCHEMAS = Object.freeze({
	create: programVocabularyCreateDraftRequestSchema,
	edit: programVocabularyEditDraftRequestSchema,
	retire: programVocabularyRetireDraftRequestSchema,
	restore: programVocabularyRestoreDraftRequestSchema,
	delete: programVocabularyDeleteDraftRequestSchema
});

export type ProgramVocabularyUnavailableReason = OperatorHttpBindingUnavailableReason;
export type ProgramVocabularyLiveReadResult =
	| { readonly kind: 'success'; readonly data: ProgramVocabularySnapshotView; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: ProgramVocabularyUnavailableReason };
export type ProgramVocabularyLiveDirectResult =
	| { readonly kind: 'success'; readonly data: ProgramVocabularyDirectData;
		readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean;
		readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: ProgramVocabularyUnavailableReason };
export type ProgramVocabularyLiveMergeDraftResult =
	| { readonly kind: 'success'; readonly data: ProgramVocabularyMergeReviewData;
		readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean;
		readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: ProgramVocabularyUnavailableReason };
export type ProgramVocabularyLiveMergePublishResult = ProgramVocabularyLiveDirectResult;

type EffectOptions = { readonly idempotencyKey: string; readonly signal?: AbortSignal };
export interface ProgramVocabularyLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<ProgramVocabularyLiveReadResult>;
	create(input: ProgramVocabularyCreateDraftRequest, options: EffectOptions): Promise<ProgramVocabularyLiveDirectResult>;
	edit(input: ProgramVocabularyEditDraftRequest, options: EffectOptions): Promise<ProgramVocabularyLiveDirectResult>;
	retire(input: ProgramVocabularyRetireDraftRequest, options: EffectOptions): Promise<ProgramVocabularyLiveDirectResult>;
	restore(input: ProgramVocabularyRestoreDraftRequest, options: EffectOptions): Promise<ProgramVocabularyLiveDirectResult>;
	delete(input: ProgramVocabularyDeleteDraftRequest, options: EffectOptions): Promise<ProgramVocabularyLiveDirectResult>;
	draftMerge(request: EventProgramMergeDraftRequest, options: EffectOptions): Promise<ProgramVocabularyLiveMergeDraftResult>;
	publishMerge(input: ProgramVocabularyMergePublishInput, options: EffectOptions): Promise<ProgramVocabularyLiveMergePublishResult>;
}

interface ReadRequest { readonly path: string; readonly schema: typeof programVocabularySnapshotReadResultSchema;
	readonly method: 'GET'; readonly signal?: AbortSignal }
interface DirectRequest { readonly path: string; readonly schema: typeof programVocabularyDirectOperationResultSchema;
	readonly method: 'POST'; readonly body: DirectInput; readonly idempotencyKey: string; readonly signal?: AbortSignal }
interface MergeDraftRequest { readonly path: string; readonly schema: typeof programVocabularyMergeReviewOperationResultSchema;
	readonly method: 'POST'; readonly body: ProgramVocabularyMergeDraftRequest;
	readonly idempotencyKey: string; readonly signal?: AbortSignal }
interface MergePublishRequest { readonly path: string; readonly schema: typeof programVocabularyMergePublishOperationResultSchema;
	readonly method: 'POST'; readonly body: ProgramVocabularyMergePublishInput;
	readonly idempotencyKey: string; readonly signal?: AbortSignal }
export interface ProgramVocabularyLiveRequester {
	read(input: ReadRequest): Promise<ApiResult<ProgramVocabularySnapshotReadResult>>;
	direct(input: DirectRequest): Promise<ApiResult<ProgramVocabularyDirectOperationResult>>;
	draftMerge(input: MergeDraftRequest): Promise<ApiResult<ProgramVocabularyMergeReviewOperationResult>>;
	publishMerge(input: MergePublishRequest): Promise<ApiResult<ProgramVocabularyMergePublishOperationResult>>;
}
const defaultRequester: ProgramVocabularyLiveRequester = Object.freeze({
	read: (input: ReadRequest) => requestJson<ProgramVocabularySnapshotReadResult>(input),
	direct: (input: DirectRequest) => requestJson<ProgramVocabularyDirectOperationResult>(input),
	draftMerge: (input: MergeDraftRequest) => requestJson<ProgramVocabularyMergeReviewOperationResult>(input),
	publishMerge: (input: MergePublishRequest) => requestJson<ProgramVocabularyMergePublishOperationResult>(input)
});
function exactBinding(manifest: unknown, expected: ExactExpectedOperation): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' } : binding;
}
function invalidRequest(): ProgramVocabularyLiveDirectResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}
function invalidContract(): ProgramVocabularyLiveDirectResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}
function invalidMergeRequest(): ProgramVocabularyLiveMergeDraftResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}
function invalidMergeContract(): ProgramVocabularyLiveMergeDraftResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}
function parseDirectInput(action: DirectAction, rawInput: DirectInput): DirectInput | undefined {
	switch (action) {
		case 'create': {
			const parsed = DIRECT_SCHEMAS.create.safeParse(rawInput);
			return parsed.success ? parsed.data : undefined;
		}
		case 'edit': {
			const parsed = DIRECT_SCHEMAS.edit.safeParse(rawInput);
			return parsed.success ? parsed.data : undefined;
		}
		case 'retire': {
			const parsed = DIRECT_SCHEMAS.retire.safeParse(rawInput);
			return parsed.success ? parsed.data : undefined;
		}
		case 'restore': {
			const parsed = DIRECT_SCHEMAS.restore.safeParse(rawInput);
			return parsed.success ? parsed.data : undefined;
		}
		case 'delete': {
			const parsed = DIRECT_SCHEMAS.delete.safeParse(rawInput);
			return parsed.success ? parsed.data : undefined;
		}
	}
}
function receiptMatches(receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }): receipt is OperationReceiptRef {
	return receipt?.operationName === operation.name && receipt.operationVersion === operation.version;
}

export function createProgramVocabularyLiveClient(input: {
	readonly manifest: unknown; readonly request?: ProgramVocabularyLiveRequester;
}): ProgramVocabularyLiveClient {
	const readBinding = exactBinding(input.manifest, { ...PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		path: PATHS.read, ...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead });
	function resolveDirect(action: DirectAction): OperatorHttpBindingResolution {
		return exactBinding(input.manifest, {
			...PROGRAM_VOCABULARY_DIRECT_OPERATIONS[action], effect: 'commit', method: 'POST', input: 'body',
			idempotencyRequired: true, path: PATHS[action], ...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct[action]
		});
	}
	const directBindings: Record<DirectAction, OperatorHttpBindingResolution> = {
		create: resolveDirect('create'),
		edit: resolveDirect('edit'),
		retire: resolveDirect('retire'),
		restore: resolveDirect('restore'),
		delete: resolveDirect('delete')
	};
	const mergeDraftBinding = exactBinding(input.manifest, { ...PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
		effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
		path: PATHS.mergeDraft, ...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergeReviewDraft });
	const mergePublishBinding = exactBinding(input.manifest, { ...PROGRAM_VOCABULARY_MERGE_PUBLISH_OPERATION,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		path: PATHS.mergePublish, ...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergePublish });
	const requester = input.request ?? defaultRequester;

	async function direct(action: DirectAction, rawInput: DirectInput, options: EffectOptions): Promise<ProgramVocabularyLiveDirectResult> {
		const parsedInput = parseDirectInput(action, rawInput);
		if (!parsedInput || !operationHttpIdempotencyKeySchema.safeParse(options.idempotencyKey).success) return invalidRequest();
		const binding = directBindings[action];
		if (binding.kind === 'unavailable') return binding;
		options.signal?.throwIfAborted();
		const transport = await requester.direct({ path: binding.path, method: 'POST', schema: programVocabularyDirectOperationResultSchema,
			body: parsedInput, idempotencyKey: options.idempotencyKey,
			...(options.signal ? { signal: options.signal } : {}) });
		if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
		const parsed = programVocabularyDirectOperationResultSchema.safeParse(transport.data);
		if (!parsed.success) return invalidContract();
		const result = parsed.data;
		if (result.kind === 'outcome') {
			if ((result.terminal && !receiptMatches(result.receipt, PROGRAM_VOCABULARY_DIRECT_OPERATIONS[action]))
				|| (!result.terminal && 'receipt' in result)) return invalidContract();
			return { kind: 'outcome', outcome: result.outcome, terminal: result.terminal,
				...('receipt' in result ? { receipt: result.receipt } : {}), correlationId: result.correlationId };
		}
		if (!receiptMatches(result.receipt, PROGRAM_VOCABULARY_DIRECT_OPERATIONS[action]) || result.data.action !== action) return invalidContract();
		return { kind: 'success', data: result.data, receipt: result.receipt, correlationId: result.correlationId };
	}

	return Object.freeze({
		async read(options: { readonly signal?: AbortSignal } = {}) {
			if (readBinding.kind === 'unavailable') return readBinding;
			const transport = await requester.read({ path: readBinding.path, method: 'GET', schema: programVocabularySnapshotReadResultSchema,
				...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error' as const, error: transport.error };
			const parsed = programVocabularySnapshotReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return { kind: 'transport_error' as const, error: { code: 'invalid_contract', retryable: true } };
			return parsed.data.kind === 'success'
				? { kind: 'success' as const, data: mapProgramVocabularySnapshot(parsed.data.data), correlationId: parsed.data.correlationId }
				: { kind: 'outcome' as const, outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		create: (value, options) => direct('create', value, options),
		edit: (value, options) => direct('edit', value, options),
		retire: (value, options) => direct('retire', value, options),
		restore: (value, options) => direct('restore', value, options),
		delete: (value, options) => direct('delete', value, options),
		async draftMerge(request: EventProgramMergeDraftRequest, options: EffectOptions): Promise<ProgramVocabularyLiveMergeDraftResult> {
			const parsedInput = programVocabularyMergeDraftRequestSchema.safeParse(request.input);
			if (!parsedInput.success || request.action !== 'merge'
				|| !operationHttpIdempotencyKeySchema.safeParse(options.idempotencyKey).success) {
				return invalidMergeRequest();
			}
			if (mergeDraftBinding.kind === 'unavailable') return mergeDraftBinding;
			options.signal?.throwIfAborted();
			const transport = await requester.draftMerge({ path: mergeDraftBinding.path, method: 'POST',
				schema: programVocabularyMergeReviewOperationResultSchema, body: parsedInput.data,
				idempotencyKey: options.idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = programVocabularyMergeReviewOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidMergeContract();
			const result = parsed.data;
			if (result.kind === 'outcome') {
				if ((result.terminal && !receiptMatches(result.receipt, PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION))
					|| (!result.terminal && 'receipt' in result)) return invalidMergeContract();
				return { kind: 'outcome' as const, outcome: result.outcome, terminal: result.terminal,
					...('receipt' in result ? { receipt: result.receipt } : {}), correlationId: result.correlationId };
			}
			if (!receiptMatches(result.receipt, PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION) || result.data.action !== 'merge') return invalidMergeContract();
			return { kind: 'success' as const, data: result.data, receipt: result.receipt,
				correlationId: result.correlationId };
		},
		async publishMerge(rawInput: ProgramVocabularyMergePublishInput, options: EffectOptions): Promise<ProgramVocabularyLiveMergePublishResult> {
			const parsedInput = programVocabularyMergePublishInputSchema.safeParse(rawInput);
			if (!parsedInput.success || !operationHttpIdempotencyKeySchema.safeParse(options.idempotencyKey).success) {
				return invalidRequest();
			}
			if (mergePublishBinding.kind === 'unavailable') return mergePublishBinding;
			options.signal?.throwIfAborted();
			const transport = await requester.publishMerge({ path: mergePublishBinding.path, method: 'POST',
				schema: programVocabularyMergePublishOperationResultSchema, body: parsedInput.data,
				idempotencyKey: options.idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = programVocabularyMergePublishOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const result = parsed.data;
			if (result.kind === 'outcome') {
				if ((result.terminal && !receiptMatches(result.receipt, PROGRAM_VOCABULARY_MERGE_PUBLISH_OPERATION))
					|| (!result.terminal && 'receipt' in result)) return invalidContract();
				return { kind: 'outcome', outcome: result.outcome, terminal: result.terminal,
					...('receipt' in result ? { receipt: result.receipt } : {}), correlationId: result.correlationId };
			}
			if (!receiptMatches(result.receipt, PROGRAM_VOCABULARY_MERGE_PUBLISH_OPERATION)
				|| result.data.action !== 'merge') return invalidContract();
			return { kind: 'success', data: result.data, receipt: result.receipt, correlationId: result.correlationId };
		}
	} satisfies ProgramVocabularyLiveClient);
}
