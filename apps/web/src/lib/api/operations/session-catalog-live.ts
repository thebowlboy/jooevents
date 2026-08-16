import { operationHttpIdempotencyKeySchema, type OperationReceiptRef } from '@jooevents/contracts';
import {
	SESSION_OPERATION_SCHEMA_REFS,
	sessionCatalogReadResultSchema,
	sessionDirectInputSchema,
	sessionDirectOperationResultSchema
} from '@jooevents/contracts/sessions';
import type { z } from 'zod';
import { requestJson, type ApiResult } from '../client';
import { mapSessionCatalog, mapSessionChangeResult } from '../mappers/session';
import type {
	SessionCatalogCoreOperation,
	SessionCatalogCorePort,
	SessionCatalogReadResult,
	SessionChangeApplyResult
} from '../session-catalog-port';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SESSION_CATALOG_LIVE_OPERATIONS = Object.freeze({
	catalog: Object.freeze({ name: 'session.catalog.read', version: 1, effect: 'read', method: 'GET',
		input: 'query', idempotencyRequired: false, path: '/api/events/current/sessions' } as const),
	change: Object.freeze({ name: 'session.change', version: 1, effect: 'commit', method: 'POST',
		input: 'body', idempotencyRequired: true, path: '/api/events/current/sessions' } as const)
});
type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };
const EXPECTED = Object.freeze({
	catalog: Object.freeze({ ...SESSION_CATALOG_LIVE_OPERATIONS.catalog, ...SESSION_OPERATION_SCHEMA_REFS.catalogRead }),
	change: Object.freeze({ ...SESSION_CATALOG_LIVE_OPERATIONS.change, ...SESSION_OPERATION_SCHEMA_REFS.direct })
} satisfies Readonly<Record<'catalog' | 'change', ExactExpectedOperation>>);

export interface SessionCatalogRequestInput {
	readonly path: string; readonly schema: z.ZodType; readonly method: 'GET' | 'POST';
	readonly body?: unknown; readonly idempotencyKey?: string; readonly signal?: AbortSignal;
}
export type SessionCatalogRequester = (input: SessionCatalogRequestInput) => Promise<ApiResult<unknown>>;
const defaultRequester: SessionCatalogRequester = (input) => requestJson(input);
function resolveExactBinding(manifest: unknown, expected: ExactExpectedOperation): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' } : binding;
}
function unavailable(operation: SessionCatalogCoreOperation, reason: OperatorHttpBindingUnavailableReason) {
	return { kind: 'unavailable' as const, operation, reason };
}
const invalidRequest = (): SessionChangeApplyResult =>
	({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = (): SessionChangeApplyResult =>
	({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
const invalidReadContract = (): SessionCatalogReadResult =>
	({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
function receiptMatches(receipt: OperationReceiptRef | undefined): receipt is OperationReceiptRef {
	return receipt?.operationName === SESSION_CATALOG_LIVE_OPERATIONS.change.name
		&& receipt.operationVersion === SESSION_CATALOG_LIVE_OPERATIONS.change.version;
}

export function createSessionCatalogLivePort(input: {
	readonly manifest: unknown; readonly request?: SessionCatalogRequester;
}): SessionCatalogCorePort {
	const catalogBinding = resolveExactBinding(input.manifest, EXPECTED.catalog);
	const changeBinding = resolveExactBinding(input.manifest, EXPECTED.change);
	const request = input.request ?? defaultRequester;
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		async readCatalog(options = {}) {
			if (catalogBinding.kind === 'unavailable') return unavailable('catalog', catalogBinding.reason);
			const response = await request({ path: catalogBinding.path, method: 'GET',
				schema: sessionCatalogReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = sessionCatalogReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidReadContract();
			if (parsed.data.kind === 'outcome') return parsed.data;
			try { return { kind: 'success' as const, data: mapSessionCatalog(parsed.data.data),
				correlationId: parsed.data.correlationId }; } catch { return invalidReadContract(); }
		},
		async applyChange(rawInput, rawAttemptKey, options = {}) {
			const author = sessionDirectInputSchema.safeParse(rawInput);
			if (!author.success || !operationHttpIdempotencyKeySchema.safeParse(rawAttemptKey).success) return invalidRequest();
			if (changeBinding.kind === 'unavailable') return unavailable('change', changeBinding.reason);
			const response = await request({ path: changeBinding.path, method: 'POST',
				schema: sessionDirectOperationResultSchema, body: author.data, idempotencyKey: rawAttemptKey,
				...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = sessionDirectOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return parsed.data;
			if (!receiptMatches(parsed.data.receipt) || parsed.data.data.action !== author.data.action) return invalidContract();
			return { kind: 'success' as const, data: mapSessionChangeResult(parsed.data.data), receipt: parsed.data.receipt,
				correlationId: parsed.data.correlationId };
		}
	} satisfies SessionCatalogCorePort);
}
