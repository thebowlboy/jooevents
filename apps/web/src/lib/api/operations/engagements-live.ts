import {
	ENGAGEMENT_OPERATION_SCHEMA_REFS,
	engagementAuthorInputSchema,
	engagementChangeOperationResultSchema,
	engagementSnapshotReadResultSchema,
	operationHttpIdempotencyKeySchema,
	type EngagementAuthorInput,
	type EngagementChangeData,
	type EngagementSnapshotDto,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { resolveOperatorHttpBinding, type ExpectedOperatorHttpOperation, type OperatorHttpBindingUnavailableReason } from './operator-http-binding';

export const ENGAGEMENTS_LIVE_OPERATIONS = Object.freeze({
	read: { name: 'engagement.snapshot.read', version: 1 },
	change: { name: 'engagement.change', version: 1 }
} as const);
const EXPECTED_OPERATIONS = Object.freeze({
	read: { ...ENGAGEMENTS_LIVE_OPERATIONS.read, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...ENGAGEMENT_OPERATION_SCHEMA_REFS.snapshotRead },
	change: { ...ENGAGEMENTS_LIVE_OPERATIONS.change, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...ENGAGEMENT_OPERATION_SCHEMA_REFS.change }
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);
export type EngagementsLiveOperation = keyof typeof EXPECTED_OPERATIONS;
type Unavailable = { readonly kind: 'unavailable'; readonly operation: EngagementsLiveOperation; readonly reason: OperatorHttpBindingUnavailableReason };
export type EngagementsLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type EngagementsCommittedResponse = EngagementChangeData;
export type EngagementsLiveRespondResult =
	| { readonly kind: 'success'; readonly data: EngagementsCommittedResponse; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export interface EngagementsLiveRequestInput { readonly path: string; readonly schema: z.ZodType; readonly method: 'GET' | 'POST'; readonly body?: unknown; readonly idempotencyKey?: string; readonly signal?: AbortSignal }
export type EngagementsLiveRequester = (input: EngagementsLiveRequestInput) => Promise<ApiResult<unknown>>;
export interface EngagementsLiveClient {
	readSnapshot(options?: { readonly signal?: AbortSignal }): Promise<EngagementsLiveReadResult<EngagementSnapshotDto>>;
	respond(input: EngagementAuthorInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<EngagementsLiveRespondResult>;
}
const invalidRequest = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });

export function createEngagementsLiveClient(input: { readonly manifest: unknown; readonly request?: EngagementsLiveRequester }): EngagementsLiveClient {
	const request = input.request ?? ((value: EngagementsLiveRequestInput) => requestJson(value));
	const read = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.read });
	const change = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.change });
	return Object.freeze({
		async readSnapshot(options: { readonly signal?: AbortSignal } = {}): Promise<EngagementsLiveReadResult<EngagementSnapshotDto>> {
			if (read.kind === 'unavailable') return { kind: 'unavailable', operation: 'read', reason: read.reason };
			const response = await request({ path: read.path, method: 'GET', schema: engagementSnapshotReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = engagementSnapshotReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success', data: parsed.data.data, correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async respond(raw: EngagementAuthorInput, idempotencyKey: string, options: { readonly signal?: AbortSignal } = {}): Promise<EngagementsLiveRespondResult> {
			const body = engagementAuthorInputSchema.safeParse(raw);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) return invalidRequest();
			if (change.kind === 'unavailable') return { kind: 'unavailable', operation: 'change', reason: change.reason };
			const response = await request({ path: change.path, method: 'POST', schema: engagementChangeOperationResultSchema, body: body.data, idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = engagementChangeOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, terminal: parsed.data.terminal, correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {}) };
			if (parsed.data.receipt.operationName !== ENGAGEMENTS_LIVE_OPERATIONS.change.name || parsed.data.data.action !== body.data.action) return invalidContract();
			return { kind: 'success', data: parsed.data.data, receipt: parsed.data.receipt, correlationId: parsed.data.correlationId };
		}
	});
}
