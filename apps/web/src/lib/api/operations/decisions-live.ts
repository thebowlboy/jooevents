import {
	DECISION_OPERATION_SCHEMA_REFS,
	decisionAuthorInputSchema,
	decisionDecideOperationResultSchema,
	decisionStateReadInputSchema,
	decisionStateReadResultSchema,
	operationHttpIdempotencyKeySchema,
	type DecisionAuthorInput,
	type DecisionDecideData,
	type DecisionStateSnapshotDto,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { resolveOperatorHttpBinding, type ExpectedOperatorHttpOperation, type OperatorHttpBindingUnavailableReason } from './operator-http-binding';

export const DECISIONS_LIVE_OPERATIONS = Object.freeze({
	read: { name: 'decision.state.read', version: 1 },
	decide: { name: 'decision.decide', version: 1 }
} as const);
const EXPECTED_OPERATIONS = Object.freeze({
	read: { ...DECISIONS_LIVE_OPERATIONS.read, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...DECISION_OPERATION_SCHEMA_REFS.stateRead },
	decide: { ...DECISIONS_LIVE_OPERATIONS.decide, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...DECISION_OPERATION_SCHEMA_REFS.decide }
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);
export type DecisionsLiveOperation = keyof typeof EXPECTED_OPERATIONS;
type Unavailable = { readonly kind: 'unavailable'; readonly operation: DecisionsLiveOperation; readonly reason: OperatorHttpBindingUnavailableReason };
export type DecisionsLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type DecisionsCommittedDecide = DecisionDecideData;
export type DecisionsLiveDecideResult =
	| { readonly kind: 'success'; readonly data: DecisionsCommittedDecide; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export interface DecisionsLiveRequestInput { readonly path: string; readonly schema: z.ZodType; readonly method: 'GET' | 'POST'; readonly body?: unknown; readonly idempotencyKey?: string; readonly signal?: AbortSignal }
export type DecisionsLiveRequester = (input: DecisionsLiveRequestInput) => Promise<ApiResult<unknown>>;
export interface DecisionsLiveClient {
	readState(submissionIds: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<DecisionsLiveReadResult<DecisionStateSnapshotDto>>;
	decide(input: DecisionAuthorInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<DecisionsLiveDecideResult>;
}
const invalidRequest = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });

export function createDecisionsLiveClient(input: { readonly manifest: unknown; readonly request?: DecisionsLiveRequester }): DecisionsLiveClient {
	const request = input.request ?? ((value: DecisionsLiveRequestInput) => requestJson(value));
	const read = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.read });
	const decide = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.decide });
	return Object.freeze({
		async readState(submissionIds: readonly string[], options: { readonly signal?: AbortSignal } = {}): Promise<DecisionsLiveReadResult<DecisionStateSnapshotDto>> {
			const parsedInput = decisionStateReadInputSchema.safeParse({ submissionIds: [...submissionIds] });
			if (!parsedInput.success) return invalidRequest();
			if (read.kind === 'unavailable') return { kind: 'unavailable', operation: 'read', reason: read.reason };
			const query = new URLSearchParams();
			for (const submissionId of parsedInput.data.submissionIds) query.append('submissionIds', submissionId);
			const response = await request({ path: `${read.path}?${query.toString()}`, method: 'GET', schema: decisionStateReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = decisionStateReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success', data: parsed.data.data, correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async decide(raw: DecisionAuthorInput, idempotencyKey: string, options: { readonly signal?: AbortSignal } = {}): Promise<DecisionsLiveDecideResult> {
			const body = decisionAuthorInputSchema.safeParse(raw);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) return invalidRequest();
			if (decide.kind === 'unavailable') return { kind: 'unavailable', operation: 'decide', reason: decide.reason };
			const response = await request({ path: decide.path, method: 'POST', schema: decisionDecideOperationResultSchema, body: body.data, idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = decisionDecideOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, terminal: parsed.data.terminal, correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {}) };
			if (parsed.data.receipt.operationName !== DECISIONS_LIVE_OPERATIONS.decide.name || parsed.data.data.action !== 'decide') return invalidContract();
			return { kind: 'success', data: parsed.data.data, receipt: parsed.data.receipt, correlationId: parsed.data.correlationId };
		}
	});
}
