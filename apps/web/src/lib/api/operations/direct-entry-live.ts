import {
	operationHttpIdempotencyKeySchema,
	SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS,
	submissionDirectEntryInputSchema,
	submissionDirectEntryOperationResultSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type SubmissionDirectEntryResultDto
} from '@jooevents/contracts';
import {
	FIELD_REGISTRY_OPERATION_SCHEMA_REFS,
	fieldRegistrySnapshotReadResultSchema
} from '@jooevents/contracts/field-registry';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const DIRECT_ENTRY_LIVE_OPERATIONS = Object.freeze({
	create: { name: 'submission.direct_entry.create', version: 1 },
	registry: { name: 'field_registry.snapshot.read', version: 1 }
} as const);
const EXPECTED_OPERATIONS = Object.freeze({
	create: {
		...DIRECT_ENTRY_LIVE_OPERATIONS.create,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...SUBMISSION_DIRECT_ENTRY_OPERATION_SCHEMA_REFS.create
	},
	registry: {
		...DIRECT_ENTRY_LIVE_OPERATIONS.registry,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);
export type DirectEntryLiveOperation = keyof typeof EXPECTED_OPERATIONS;
type Unavailable = { readonly kind: 'unavailable'; readonly operation: DirectEntryLiveOperation; readonly reason: OperatorHttpBindingUnavailableReason };
export interface DirectEntryFieldIdentity { readonly id: string; readonly kind: string; readonly mapsTo: string | null }
export type DirectEntryLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type DirectEntryCommittedCreate = SubmissionDirectEntryResultDto;
export type DirectEntryLiveCreateResult =
	| { readonly kind: 'success'; readonly data: DirectEntryCommittedCreate; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export interface DirectEntryLiveRequestInput {
	readonly path: string; readonly schema: z.ZodType; readonly method: 'GET' | 'POST';
	readonly body?: unknown; readonly idempotencyKey?: string; readonly signal?: AbortSignal;
}
export type DirectEntryLiveRequester = (input: DirectEntryLiveRequestInput) => Promise<ApiResult<unknown>>;
export type DirectEntryWireInput = z.input<typeof submissionDirectEntryInputSchema>;
export interface DirectEntryLiveClient {
	readFieldIdentities(options?: { readonly signal?: AbortSignal }): Promise<DirectEntryLiveReadResult<{ readonly version: number; readonly fields: readonly DirectEntryFieldIdentity[] }>>;
	create(input: DirectEntryWireInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<DirectEntryLiveCreateResult>;
}
const invalidRequest = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });

export function createDirectEntryLiveClient(input: { readonly manifest: unknown; readonly request?: DirectEntryLiveRequester }): DirectEntryLiveClient {
	const request = input.request ?? ((value: DirectEntryLiveRequestInput) => requestJson(value));
	const create = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.create });
	const registry = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.registry });
	return Object.freeze({
		async readFieldIdentities(options: { readonly signal?: AbortSignal } = {}): Promise<DirectEntryLiveReadResult<{ readonly version: number; readonly fields: readonly DirectEntryFieldIdentity[] }>> {
			if (registry.kind === 'unavailable') return { kind: 'unavailable', operation: 'registry', reason: registry.reason };
			const response = await request({ path: registry.path, method: 'GET', schema: fieldRegistrySnapshotReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = fieldRegistrySnapshotReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
			return { kind: 'success', data: Object.freeze({
				version: parsed.data.data.version,
				fields: Object.freeze(parsed.data.data.fields.map((field) => Object.freeze({ id: field.id, kind: field.kind, mapsTo: field.mapsTo })))
			}), correlationId: parsed.data.correlationId };
		},
		async create(raw: DirectEntryWireInput, idempotencyKey: string, options: { readonly signal?: AbortSignal } = {}): Promise<DirectEntryLiveCreateResult> {
			const body = submissionDirectEntryInputSchema.safeParse(raw);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) return invalidRequest();
			if (create.kind === 'unavailable') return { kind: 'unavailable', operation: 'create', reason: create.reason };
			const response = await request({ path: create.path, method: 'POST', schema: submissionDirectEntryOperationResultSchema, body: body.data, idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionDirectEntryOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, terminal: parsed.data.terminal, correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {}) };
			if (parsed.data.receipt.operationName !== DIRECT_ENTRY_LIVE_OPERATIONS.create.name || parsed.data.data.action !== 'create') return invalidContract();
			return { kind: 'success', data: parsed.data.data, receipt: parsed.data.receipt, correlationId: parsed.data.correlationId };
		}
	});
}
