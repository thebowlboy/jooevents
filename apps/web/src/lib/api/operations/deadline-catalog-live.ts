import {
	DEADLINE_OPERATION_SCHEMA_REFS,
	deadlineListReadResultSchema,
	type DeadlineCatalogSnapshotDto
} from '@jooevents/contracts/deadlines';
import type { StructuredOutcome } from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	resolveOperatorHttpBinding,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

const DEADLINE_CATALOG_OPERATION = Object.freeze({
	name: 'deadline.catalog.read',
	version: 1,
	effect: 'read' as const,
	method: 'GET' as const,
	input: 'query' as const,
	idempotencyRequired: false,
	...DEADLINE_OPERATION_SCHEMA_REFS.catalogRead
});

export type DeadlineCatalogLiveReadResult =
	| { readonly kind: 'success'; readonly data: DeadlineCatalogSnapshotDto; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: OperatorHttpBindingUnavailableReason };

export interface DeadlineCatalogLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

export type DeadlineCatalogLiveRequester = (
	input: DeadlineCatalogLiveRequestInput
) => Promise<ApiResult<unknown>>;

export interface DeadlineCatalogLivePort {
	read(options?: { readonly signal?: AbortSignal }): Promise<DeadlineCatalogLiveReadResult>;
}

/** Current-event Deadline catalog over its registered, permission-checked read. */
export function createDeadlineCatalogLivePort(input: {
	readonly manifest: unknown;
	readonly request?: DeadlineCatalogLiveRequester;
}): DeadlineCatalogLivePort {
	const request = input.request ?? ((value: DeadlineCatalogLiveRequestInput) => requestJson(value));
	const binding = resolveOperatorHttpBinding({
		manifest: input.manifest,
		expected: DEADLINE_CATALOG_OPERATION
	});
	return Object.freeze({
		async read(options: { readonly signal?: AbortSignal } = {}) {
			if (binding.kind === 'unavailable') {
				return { kind: 'unavailable' as const, reason: binding.reason };
			}
			const response = await request({
				path: binding.path,
				method: 'GET',
				schema: deadlineListReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = deadlineListReadResultSchema.safeParse(response.data);
			if (!parsed.success) {
				return {
					kind: 'transport_error' as const,
					error: { code: 'invalid_contract', retryable: true }
				};
			}
			return parsed.data.kind === 'success'
				? { kind: 'success' as const, data: parsed.data.data, correlationId: parsed.data.correlationId }
				: { kind: 'outcome' as const, outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		}
	});
}
