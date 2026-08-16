import {
	operationHttpIdempotencyKeySchema,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS,
	submissionTriageListInputSchema,
	submissionTriageListOperationResultSchema,
	submissionTriageReadInputSchema,
	submissionTriageReadOperationResultSchema,
	submissionTriageTransitionInputSchema,
	submissionTriageTransitionOperationResultSchema,
	type SubmissionTriageTransitionData,
	type SubmissionTriageTransitionInput
} from '@jooevents/contracts/submission-triage';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	mapSubmissionTriageList,
	mapSubmissionTriageRead,
	type SubmissionTriagePageView,
	type SubmissionTriageRowView
} from '../mappers/submission-triage';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SUBMISSION_TRIAGE_OPERATIONS = Object.freeze({
	list: { name: 'submission.triage.list', version: 1 },
	read: { name: 'submission.triage.read', version: 1 },
	transition: { name: 'submission.triage.transition', version: 1 }
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	list: {
		...SUBMISSION_TRIAGE_OPERATIONS.list,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.list
	},
	read: {
		...SUBMISSION_TRIAGE_OPERATIONS.read,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.read
	},
	transition: {
		...SUBMISSION_TRIAGE_OPERATIONS.transition,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.transition
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

export type SubmissionTriageLiveOperation = keyof typeof EXPECTED_OPERATIONS;
type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: SubmissionTriageLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};
export type SubmissionTriageLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type SubmissionTriageLiveApplyResult =
	| { readonly kind: 'success'; readonly data: SubmissionTriageTransitionData; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface SubmissionTriageLiveClient {
	list(input: z.input<typeof submissionTriageListInputSchema>, options?: { readonly signal?: AbortSignal }): Promise<SubmissionTriageLiveReadResult<SubmissionTriagePageView>>;
	read(submissionId: string, options?: { readonly signal?: AbortSignal }): Promise<SubmissionTriageLiveReadResult<SubmissionTriageRowView>>;
	apply(input: SubmissionTriageTransitionInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<SubmissionTriageLiveApplyResult>;
}
export interface SubmissionTriageRequestInput {
	readonly path: string; readonly method: 'GET' | 'POST'; readonly schema: z.ZodType;
	readonly query?: unknown; readonly body?: unknown; readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}
export type SubmissionTriageRequester = (input: SubmissionTriageRequestInput) => Promise<ApiResult<unknown>>;
const invalidRequest = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
const invalidContract = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });

export function createSubmissionTriageLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: SubmissionTriageRequester;
}): SubmissionTriageLiveClient {
	const request = input.request ?? ((value: SubmissionTriageRequestInput) => {
		const { query, ...requestInput } = value;
		const search = query === undefined
			? ''
			: new URLSearchParams(Object.entries(query as Record<string, unknown>)
				.filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
				.toString();
		return requestJson({
			...requestInput,
			path: search.length === 0 ? value.path : `${value.path}?${search}`
		});
	});
	const bindings = {
		list: resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.list }),
		read: resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.read }),
		transition: resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED_OPERATIONS.transition })
	} as const;
	return Object.freeze({
		async list(raw: z.input<typeof submissionTriageListInputSchema>, options: { readonly signal?: AbortSignal } = {}): Promise<SubmissionTriageLiveReadResult<SubmissionTriagePageView>> {
			const query = submissionTriageListInputSchema.safeParse(raw);
			if (!query.success) return invalidRequest();
			if (bindings.list.kind === 'unavailable') return { kind: 'unavailable', operation: 'list', reason: bindings.list.reason };
			const response = await request({ path: bindings.list.path, method: 'GET', schema: submissionTriageListOperationResultSchema, query: query.data, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionTriageListOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success', data: mapSubmissionTriageList(parsed.data.data), correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async read(submissionId: string, options: { readonly signal?: AbortSignal } = {}): Promise<SubmissionTriageLiveReadResult<SubmissionTriageRowView>> {
			const query = submissionTriageReadInputSchema.safeParse({ submissionId });
			if (!query.success) return invalidRequest();
			if (bindings.read.kind === 'unavailable') return { kind: 'unavailable', operation: 'read', reason: bindings.read.reason };
			const response = await request({ path: bindings.read.path, method: 'GET', schema: submissionTriageReadOperationResultSchema, query: query.data, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionTriageReadOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success', data: mapSubmissionTriageRead(parsed.data.data), correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async apply(raw: SubmissionTriageTransitionInput, idempotencyKey: string, options: { readonly signal?: AbortSignal } = {}): Promise<SubmissionTriageLiveApplyResult> {
			const body = submissionTriageTransitionInputSchema.safeParse(raw);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) return invalidRequest();
			if (bindings.transition.kind === 'unavailable') return { kind: 'unavailable', operation: 'transition', reason: bindings.transition.reason };
			const response = await request({ path: bindings.transition.path, method: 'POST', schema: submissionTriageTransitionOperationResultSchema, body: body.data, idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = submissionTriageTransitionOperationResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') return { kind: 'outcome', outcome: parsed.data.outcome, terminal: parsed.data.terminal, correlationId: parsed.data.correlationId, ...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {}) };
			if (parsed.data.receipt.operationName !== SUBMISSION_TRIAGE_OPERATIONS.transition.name || parsed.data.data.action !== body.data.action) return invalidContract();
			return { kind: 'success', data: parsed.data.data, receipt: parsed.data.receipt, correlationId: parsed.data.correlationId };
		}
	});
}
