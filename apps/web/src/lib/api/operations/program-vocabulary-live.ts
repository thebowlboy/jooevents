import {
	programVocabularyDraftOperationResultSchema,
	PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
	programVocabularySnapshotReadResultSchema,
	type OperationReceiptRef,
	type ProgramVocabularyDraftOperationResult,
	type ProgramVocabularySnapshotReadResult,
	type StructuredOutcome
} from '@jooevents/contracts';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import type { EventProgramDraftRequest } from '../event-program/port';
import {
	mapProgramVocabularyDraft,
	mapProgramVocabularySnapshot
} from '../mappers/program-vocabulary';
import type {
	ProgramVocabularyDraftView,
	ProgramVocabularySnapshotView
} from '../view-models/program-vocabulary';
import {
	resolveOperatorHttpBinding,
	type OperatorHttpBindingUnavailableReason,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

export const PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION = Object.freeze({
	name: 'program_vocabulary.snapshot.read',
	version: 1
} as const);

export const PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION = Object.freeze({
	name: 'program_vocabulary.create.draft',
	version: 1
} as const);
export const PROGRAM_VOCABULARY_EDIT_DRAFT_OPERATION = Object.freeze({
	name: 'program_vocabulary.edit.draft',
	version: 1
} as const);
export const PROGRAM_VOCABULARY_RETIRE_DRAFT_OPERATION = Object.freeze({
	name: 'program_vocabulary.retire.draft',
	version: 1
} as const);
export const PROGRAM_VOCABULARY_RESTORE_DRAFT_OPERATION = Object.freeze({
	name: 'program_vocabulary.restore.draft',
	version: 1
} as const);
export const PROGRAM_VOCABULARY_DELETE_DRAFT_OPERATION = Object.freeze({
	name: 'program_vocabulary.delete.draft',
	version: 1
} as const);
export const PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION = Object.freeze({
	name: 'program_vocabulary.merge.draft',
	version: 1
} as const);

export const PROGRAM_VOCABULARY_DRAFT_OPERATIONS = Object.freeze({
	create: PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
	edit: PROGRAM_VOCABULARY_EDIT_DRAFT_OPERATION,
	retire: PROGRAM_VOCABULARY_RETIRE_DRAFT_OPERATION,
	restore: PROGRAM_VOCABULARY_RESTORE_DRAFT_OPERATION,
	delete: PROGRAM_VOCABULARY_DELETE_DRAFT_OPERATION,
	merge: PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION
});

export type ProgramVocabularyDraftRequest = EventProgramDraftRequest;

type ProgramVocabularyDraftAction = ProgramVocabularyDraftRequest['action'];
type ProgramVocabularyDraftBusinessInput = ProgramVocabularyDraftRequest['input'];

export type ProgramVocabularyUnavailableReason = OperatorHttpBindingUnavailableReason;

export type ProgramVocabularyLiveReadResult =
	| {
			readonly kind: 'success';
			readonly data: ProgramVocabularySnapshotView;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: ProgramVocabularyUnavailableReason };

export type ProgramVocabularyLiveDraftResult =
	| {
			readonly kind: 'success';
			readonly data: ProgramVocabularyDraftView;
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
	| { readonly kind: 'unavailable'; readonly reason: ProgramVocabularyUnavailableReason };

export interface ProgramVocabularyLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<ProgramVocabularyLiveReadResult>;
	draft(
		request: ProgramVocabularyDraftRequest,
		options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
	): Promise<ProgramVocabularyLiveDraftResult>;
}

interface ProgramVocabularyReadRequestInput {
	readonly path: string;
	readonly schema: typeof programVocabularySnapshotReadResultSchema;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

interface ProgramVocabularyDraftRequestInput {
	readonly path: string;
	readonly schema: typeof programVocabularyDraftOperationResultSchema;
	readonly method: 'POST';
	readonly body: ProgramVocabularyDraftBusinessInput;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface ProgramVocabularyLiveRequester {
	read(input: ProgramVocabularyReadRequestInput): Promise<ApiResult<ProgramVocabularySnapshotReadResult>>;
	draft(input: ProgramVocabularyDraftRequestInput): Promise<ApiResult<ProgramVocabularyDraftOperationResult>>;
}

const defaultRequester: ProgramVocabularyLiveRequester = Object.freeze({
	read: (requestInput: ProgramVocabularyReadRequestInput) =>
		requestJson<ProgramVocabularySnapshotReadResult>(requestInput),
	draft: (requestInput: ProgramVocabularyDraftRequestInput) =>
		requestJson<ProgramVocabularyDraftOperationResult>(requestInput)
});

export function createProgramVocabularyLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: ProgramVocabularyLiveRequester;
}): ProgramVocabularyLiveClient {
	const readBinding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: {
			...PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
			effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
			...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead
		}
	});
	const draftBindings: Record<ProgramVocabularyDraftAction, OperatorHttpBindingResolution> = {
		create: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: { ...PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
				effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
				...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.create }
		}),
		edit: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: { ...PROGRAM_VOCABULARY_EDIT_DRAFT_OPERATION,
				effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
				...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.edit }
		}),
		retire: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: { ...PROGRAM_VOCABULARY_RETIRE_DRAFT_OPERATION,
				effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
				...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.retire }
		}),
		restore: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: { ...PROGRAM_VOCABULARY_RESTORE_DRAFT_OPERATION,
				effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
				...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.restore }
		}),
		delete: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: { ...PROGRAM_VOCABULARY_DELETE_DRAFT_OPERATION,
				effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
				...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.delete }
		}),
		merge: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: { ...PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
				effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
				...PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.merge }
		})
	};
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		async read(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<ProgramVocabularyLiveReadResult> {
			if (readBinding.kind === 'unavailable') return readBinding;
			const transport = await request.read({
				path: readBinding.path,
				method: 'GET',
				schema: programVocabularySnapshotReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') {
				return { kind: 'transport_error', error: transport.error };
			}

			const result = transport.data;
			return result.kind === 'success'
				? {
						kind: 'success',
						data: mapProgramVocabularySnapshot(result.data),
						correlationId: result.correlationId
					}
				: { kind: 'outcome', outcome: result.outcome, correlationId: result.correlationId };
		},

		async draft(
			draftRequest: ProgramVocabularyDraftRequest,
			options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }
		): Promise<ProgramVocabularyLiveDraftResult> {
			const binding = draftBindings[draftRequest.action];
			if (binding.kind === 'unavailable') return binding;
			const transport = await request.draft({
				path: binding.path,
				method: 'POST',
				schema: programVocabularyDraftOperationResultSchema,
				body: draftRequest.input,
				idempotencyKey: options.idempotencyKey,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') {
				return { kind: 'transport_error', error: transport.error };
			}

			const result = transport.data;
			if (result.kind === 'success') {
				return {
					kind: 'success',
					data: mapProgramVocabularyDraft(result.data),
					receipt: result.receipt,
					correlationId: result.correlationId
				};
			}
			return {
				kind: 'outcome',
				outcome: result.outcome,
				terminal: result.terminal,
				...('receipt' in result ? { receipt: result.receipt } : {}),
				correlationId: result.correlationId
			};
		}
	});
}
