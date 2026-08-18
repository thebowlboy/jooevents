import {
	SPEAKER_PROFILE_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	speakerProfileApproveInputSchema,
	speakerProfileApproveResultSchema,
	speakerProfileReadInputSchema,
	speakerProfileReadResultSchema,
	speakerProfileUpdateInputSchema,
	speakerProfileUpdateResultSchema,
	type OperationReceiptRef,
	type SpeakerProfileApproveInput,
	type SpeakerProfileUpdateInput,
	type SpeakerProfileViewDto,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const SPEAKER_PROFILE_LIVE_OPERATIONS = Object.freeze({
	read: { name: 'speaker.profile.read', version: 1 },
	update: { name: 'speaker.profile.update', version: 1 },
	approve: { name: 'speaker.profile.approve', version: 1 }
} as const);

const EXPECTED = Object.freeze({
	read: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.read,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.read
	},
	update: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.update,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.update
	},
	approve: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.approve,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.approve
	}
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

type Operation = keyof typeof EXPECTED;
type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: Operation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};
export type SpeakerProfileLiveReadResult =
	| { readonly kind: 'success'; readonly data: SpeakerProfileViewDto; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type SpeakerProfileLiveMutationResult =
	| { readonly kind: 'success'; readonly data: SpeakerProfileViewDto; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface SpeakerProfilesLiveClient {
	read(personId: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileLiveReadResult>;
	update(input: SpeakerProfileUpdateInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileLiveMutationResult>;
	approve(input: SpeakerProfileApproveInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileLiveMutationResult>;
}

export interface SpeakerProfileLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

const invalidRequest = (): SpeakerProfileLiveMutationResult => ({
	kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
});
const invalidContract = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({
	kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
});

export function createSpeakerProfilesLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: (input: SpeakerProfileLiveRequestInput) => Promise<ApiResult<unknown>>;
}): SpeakerProfilesLiveClient {
	const request = input.request ?? ((value: SpeakerProfileLiveRequestInput) => requestJson(value));
	const read = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED.read });
	const update = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED.update });
	const approve = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED.approve });

	async function mutate(
		operation: 'update' | 'approve',
		raw: SpeakerProfileUpdateInput | SpeakerProfileApproveInput,
		idempotencyKey: string,
		options: { readonly signal?: AbortSignal }
	): Promise<SpeakerProfileLiveMutationResult> {
		const expected = EXPECTED[operation];
		const binding = operation === 'update' ? update : approve;
		const body = (operation === 'update'
			? speakerProfileUpdateInputSchema
			: speakerProfileApproveInputSchema).safeParse(raw);
		if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) {
			return invalidRequest();
		}
		if (binding.kind === 'unavailable') return { kind: 'unavailable', operation, reason: binding.reason };
		const schema = operation === 'update'
			? speakerProfileUpdateResultSchema : speakerProfileApproveResultSchema;
		const response = await request({
			path: binding.path, method: 'POST', schema, body: body.data, idempotencyKey,
			...(options.signal ? { signal: options.signal } : {})
		});
		if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
		const parsed = schema.safeParse(response.data);
		if (!parsed.success) return invalidContract();
		if (parsed.data.kind === 'outcome') {
			return {
				kind: 'outcome', outcome: parsed.data.outcome, terminal: parsed.data.terminal,
				correlationId: parsed.data.correlationId,
				...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {})
			};
		}
		if (parsed.data.receipt.operationName !== expected.name) return invalidContract();
		return {
			kind: 'success', data: parsed.data.data, receipt: parsed.data.receipt,
			correlationId: parsed.data.correlationId
		};
	}

	return Object.freeze({
		async read(personId: string, options: { readonly signal?: AbortSignal } = {}) {
			const businessInput = speakerProfileReadInputSchema.safeParse({ personId });
			if (!businessInput.success) return invalidContract();
			if (read.kind === 'unavailable') return { kind: 'unavailable' as const, operation: 'read' as const, reason: read.reason };
			const query = new URLSearchParams(businessInput.data);
			const response = await request({
				path: `${read.path}?${query.toString()}`, method: 'GET', schema: speakerProfileReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = speakerProfileReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success' as const, data: parsed.data.data, correlationId: parsed.data.correlationId }
				: { kind: 'outcome' as const, outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		update: (
			value: SpeakerProfileUpdateInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => mutate('update', value, key, options),
		approve: (
			value: SpeakerProfileApproveInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) => mutate('approve', value, key, options)
	});
}
