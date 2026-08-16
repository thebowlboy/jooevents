import { operationHttpIdempotencyKeySchema, type OperationReceiptRef } from '@jooevents/contracts';
import {
	SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
	schedulePlacementAuthorInputSchema,
	schedulePlacementOperationResultSchema,
	schedulePlacementReadInputSchema,
	schedulePlacementReadResultSchema,
	type SchedulePlacementSnapshotDto
} from '@jooevents/contracts/schedule-placement';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { mapSchedulePlacementResult, mapSchedulePlacementSnapshot } from '../mappers/schedule-placement';
import type {
	SchedulePlacementApplyResult,
	SchedulePlacementCoreOperation,
	SchedulePlacementCorePort,
	SchedulePlacementReadResult
} from '../schedule-placement-port';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SCHEDULE_PLACEMENT_LIVE_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({ name: 'schedule.placement.snapshot.read', version: 1, effect: 'read',
		method: 'GET', input: 'query', idempotencyRequired: false,
		path: '/api/events/current/schedule/placements' } as const),
	mutation: Object.freeze({ name: 'schedule.placement', version: 1, effect: 'commit', method: 'POST',
		input: 'body', idempotencyRequired: true, path: '/api/events/current/schedule/placements' } as const)
});
type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };
const EXPECTED = Object.freeze({
	snapshot: Object.freeze({ ...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.snapshot,
		...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead }),
	mutation: Object.freeze({ ...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.mutation,
		...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placement })
} satisfies Readonly<Record<'snapshot' | 'mutation', ExactExpectedOperation>>);
export interface SchedulePlacementRequestInput {
	readonly path: string; readonly schema: z.ZodType; readonly method: 'GET' | 'POST';
	readonly body?: unknown; readonly idempotencyKey?: string; readonly signal?: AbortSignal;
}
export type SchedulePlacementRequester = (input: SchedulePlacementRequestInput) => Promise<ApiResult<unknown>>;
const defaultRequester: SchedulePlacementRequester = (input) => requestJson(input);
function resolveExactBinding(manifest: unknown, expected: ExactExpectedOperation): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' } : binding;
}
function unavailable(operation: SchedulePlacementCoreOperation, reason: OperatorHttpBindingUnavailableReason) {
	return { kind: 'unavailable' as const, operation, reason };
}
const invalidRequest = (): SchedulePlacementApplyResult =>
	({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = (): SchedulePlacementApplyResult =>
	({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
const invalidReadContract = (): SchedulePlacementReadResult =>
	({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
function receiptMatches(receipt: OperationReceiptRef | undefined): receipt is OperationReceiptRef {
	return receipt?.operationName === SCHEDULE_PLACEMENT_LIVE_OPERATIONS.mutation.name
		&& receipt.operationVersion === SCHEDULE_PLACEMENT_LIVE_OPERATIONS.mutation.version;
}
function snapshotMatchesRange(snapshot: SchedulePlacementSnapshotDto,
	range: z.output<typeof schedulePlacementReadInputSchema>): boolean {
	return snapshot.occurrences.length <= range.limit && snapshot.occurrences.every((occurrence) =>
		occurrence.startAt < range.endAt && range.startAt < occurrence.endAt);
}

export function createSchedulePlacementLivePort(input: {
	readonly manifest: unknown; readonly request?: SchedulePlacementRequester;
}): SchedulePlacementCorePort {
	const snapshotBinding = resolveExactBinding(input.manifest, EXPECTED.snapshot);
	const mutationBinding = resolveExactBinding(input.manifest, EXPECTED.mutation);
	const request = input.request ?? defaultRequester;
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		async readPlacements(rawRange, options = {}) {
			const range = schedulePlacementReadInputSchema.safeParse(rawRange);
			if (!range.success) return { kind: 'transport_error' as const,
				error: { code: 'invalid_request', retryable: false } satisfies SafeApiError };
			if (snapshotBinding.kind === 'unavailable') return unavailable('snapshot', snapshotBinding.reason);
			const query = new URLSearchParams({ startAt: range.data.startAt, endAt: range.data.endAt,
				limit: String(range.data.limit) });
			const response = await request({ path: `${snapshotBinding.path}?${query.toString()}`, method: 'GET',
				schema: schedulePlacementReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = schedulePlacementReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidReadContract();
			if (parsed.data.kind === 'outcome') return parsed.data;
			if (!snapshotMatchesRange(parsed.data.data, range.data)) return invalidReadContract();
			try { return { kind: 'success' as const, data: mapSchedulePlacementSnapshot(parsed.data.data),
				correlationId: parsed.data.correlationId }; } catch { return invalidReadContract(); }
		},
		async placeOrMove(rawInput, rawAttemptKey, options = {}) {
			const author = schedulePlacementAuthorInputSchema.safeParse(rawInput);
			if (!author.success || !operationHttpIdempotencyKeySchema.safeParse(rawAttemptKey).success) return invalidRequest();
			if (mutationBinding.kind === 'unavailable') return unavailable('mutation', mutationBinding.reason);
			const response = await request({ path: mutationBinding.path, method: 'POST',
				schema: schedulePlacementOperationResultSchema, body: author.data, idempotencyKey: rawAttemptKey,
				...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = schedulePlacementOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return parsed.data;
			if (!receiptMatches(parsed.data.receipt) || parsed.data.data.action !== author.data.action) return invalidContract();
			return { kind: 'success' as const, data: mapSchedulePlacementResult(parsed.data.data), receipt: parsed.data.receipt,
				correlationId: parsed.data.correlationId };
		}
	} satisfies SchedulePlacementCorePort);
}
