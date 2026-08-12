import {
	programVocabularySnapshotReadResultSchema,
	safeOperationManifestSchema,
	type ProgramVocabularySnapshotReadResult,
	type StructuredOutcome
} from '@jooevents/contracts';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { mapProgramVocabularySnapshot } from '../mappers/program-vocabulary';
import type { ProgramVocabularySnapshotView } from '../view-models/program-vocabulary';

export const PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION = Object.freeze({
	name: 'program_vocabulary.snapshot.read',
	version: 1
} as const);

export type ProgramVocabularyUnavailableReason =
	| 'invalid_operation_manifest'
	| 'operation_not_registered'
	| 'operation_registration_ambiguous'
	| 'operation_not_active'
	| 'operation_contract_mismatch'
	| 'operator_http_binding_not_registered'
	| 'operator_http_binding_ambiguous'
	| 'operator_http_binding_unsupported';

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

export interface ProgramVocabularyLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<ProgramVocabularyLiveReadResult>;
}

interface ProgramVocabularyRequestInput {
	readonly path: string;
	readonly schema: typeof programVocabularySnapshotReadResultSchema;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

type ProgramVocabularyRequester = (
	input: ProgramVocabularyRequestInput
) => Promise<ApiResult<ProgramVocabularySnapshotReadResult>>;

type BindingResolution =
	| { readonly kind: 'available'; readonly path: string }
	| { readonly kind: 'unavailable'; readonly reason: ProgramVocabularyUnavailableReason };

function resolveBinding(manifest: unknown): BindingResolution {
	const parsed = safeOperationManifestSchema.safeParse(manifest);
	if (!parsed.success) return { kind: 'unavailable', reason: 'invalid_operation_manifest' };

	const operations = parsed.data.operations.filter(
		(operation) =>
			operation.name === PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION.name &&
			operation.version === PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION.version
	);
	if (operations.length === 0) {
		return { kind: 'unavailable', reason: 'operation_not_registered' };
	}
	if (operations.length !== 1) {
		return { kind: 'unavailable', reason: 'operation_registration_ambiguous' };
	}

	const operation = operations[0];
	if (!operation) return { kind: 'unavailable', reason: 'operation_not_registered' };
	if (operation.lifecycle.status !== 'active') {
		return { kind: 'unavailable', reason: 'operation_not_active' };
	}
	if (operation.effect !== 'read' || operation.idempotency.required) {
		return { kind: 'unavailable', reason: 'operation_contract_mismatch' };
	}

	const bindings = operation.enabledBindings.filter(
		(binding) => binding.surface === 'operator_http'
	);
	if (bindings.length === 0) {
		return { kind: 'unavailable', reason: 'operator_http_binding_not_registered' };
	}
	if (bindings.length !== 1) {
		return { kind: 'unavailable', reason: 'operator_http_binding_ambiguous' };
	}

	const binding = bindings[0];
	if (!binding) return { kind: 'unavailable', reason: 'operator_http_binding_not_registered' };
	if (
		binding.method !== 'GET' ||
		binding.input !== 'query' ||
		binding.browserResumption.kind !== 'none'
	) {
		return { kind: 'unavailable', reason: 'operator_http_binding_unsupported' };
	}
	return { kind: 'available', path: binding.path };
}

function defaultRequester(
	input: ProgramVocabularyRequestInput
): Promise<ApiResult<ProgramVocabularySnapshotReadResult>> {
	return requestJson(input);
}

export function createProgramVocabularyLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: ProgramVocabularyRequester;
}): ProgramVocabularyLiveClient {
	const binding = resolveBinding(input.manifest);
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		async read(options: { readonly signal?: AbortSignal } = {}) {
			if (binding.kind === 'unavailable') return binding;

			const transport = await request({
				path: binding.path,
				method: 'GET',
				schema: programVocabularySnapshotReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') {
				return { kind: 'transport_error', error: transport.error } as const;
			}

			const result = transport.data;
			switch (result.kind) {
				case 'success':
					return {
						kind: 'success',
						data: mapProgramVocabularySnapshot(result.data),
						correlationId: result.correlationId
					} as const;
				case 'outcome':
					return {
						kind: 'outcome',
						outcome: result.outcome,
						correlationId: result.correlationId
					} as const;
			}
		}
	});
}
