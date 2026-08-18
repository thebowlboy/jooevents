import {
	SPEAKER_PROFILE_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	speakerProfileApproveInputSchema,
	speakerProfileApproveResultSchema,
	speakerProfileDirectoryReadInputSchema,
	speakerProfileDirectoryReadResultSchema,
	speakerProfileReviewPolicyUpdateInputSchema,
	speakerProfileReviewPolicyUpdateResultSchema,
	speakerProfileReviewQueueReadInputSchema,
	speakerProfileReviewQueueReadResultSchema,
	speakerProfileReadInputSchema,
	speakerProfileReadResultSchema,
	speakerProfileUpdateInputSchema,
	speakerProfileUpdateResultSchema,
	type OperationReceiptRef,
	type SpeakerProfileApproveInput,
	type SpeakerProfileDirectoryDto,
	type SpeakerProfileReviewPolicyDto,
	type SpeakerProfileReviewPolicyUpdateInput,
	type SpeakerProfileReviewQueueDto,
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
	directoryRead: { name: 'speaker.profile.directory.read', version: 1 },
	reviewQueueRead: { name: 'speaker.profile.review_queue.read', version: 1 },
	update: { name: 'speaker.profile.update', version: 1 },
	approve: { name: 'speaker.profile.approve', version: 1 },
	reviewPolicyUpdate: { name: 'speaker.profile.review_policy.update', version: 1 }
} as const);

const EXPECTED = Object.freeze({
	read: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.read,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.read
	},
	directoryRead: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.directoryRead,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.directoryRead
	},
	reviewQueueRead: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.reviewQueueRead,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewQueueRead
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
	},
	reviewPolicyUpdate: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.reviewPolicyUpdate,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewPolicyUpdate
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
export type SpeakerProfileReviewQueueLiveReadResult =
	| { readonly kind: 'success'; readonly data: SpeakerProfileReviewQueueDto; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type SpeakerProfileDirectoryLiveReadResult =
	| { readonly kind: 'success'; readonly data: SpeakerProfileDirectoryDto; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type SpeakerProfileLiveMutationResult =
	| { readonly kind: 'success'; readonly data: SpeakerProfileViewDto; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;
export type SpeakerProfileReviewPolicyLiveMutationResult =
	| { readonly kind: 'success'; readonly data: SpeakerProfileReviewPolicyDto; readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean; readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface SpeakerProfilesLiveClient {
	read(personId: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileLiveReadResult>;
	readDirectory(options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileDirectoryLiveReadResult>;
	readReviewQueue(options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileReviewQueueLiveReadResult>;
	update(input: SpeakerProfileUpdateInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileLiveMutationResult>;
	approve(input: SpeakerProfileApproveInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileLiveMutationResult>;
	updateReviewPolicy(input: SpeakerProfileReviewPolicyUpdateInput, idempotencyKey: string, options?: { readonly signal?: AbortSignal }): Promise<SpeakerProfileReviewPolicyLiveMutationResult>;
}

export interface SpeakerProfileLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

const invalidRequest = (): { readonly kind: 'transport_error'; readonly error: SafeApiError } => ({
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
	const directoryRead = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: EXPECTED.directoryRead
	});
	const reviewQueueRead = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: EXPECTED.reviewQueueRead
	});
	const update = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED.update });
	const approve = resolveOperatorHttpBinding({ manifest: input.manifest, expected: EXPECTED.approve });
	const reviewPolicyUpdate = resolveOperatorHttpBinding({
		manifest: input.manifest, expected: EXPECTED.reviewPolicyUpdate
	});

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
		async readReviewQueue(options: { readonly signal?: AbortSignal } = {}) {
			const businessInput = speakerProfileReviewQueueReadInputSchema.parse({});
			if (reviewQueueRead.kind === 'unavailable') {
				return {
					kind: 'unavailable' as const,
					operation: 'reviewQueueRead' as const,
					reason: reviewQueueRead.reason
				};
			}
			const response = await request({
				path: reviewQueueRead.path,
				method: 'GET',
				schema: speakerProfileReviewQueueReadResultSchema,
				...(Object.keys(businessInput).length === 0 ? {} : { body: businessInput }),
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') {
				return { kind: 'transport_error' as const, error: response.error };
			}
			const parsed = speakerProfileReviewQueueReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? { kind: 'success' as const, data: parsed.data.data, correlationId: parsed.data.correlationId }
				: { kind: 'outcome' as const, outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async readDirectory(options: { readonly signal?: AbortSignal } = {}) {
			const businessInput = speakerProfileDirectoryReadInputSchema.parse({});
			if (directoryRead.kind === 'unavailable') {
				return { kind: 'unavailable' as const, operation: 'directoryRead' as const, reason: directoryRead.reason };
			}
			const response = await request({
				path: directoryRead.path, method: 'GET', schema: speakerProfileDirectoryReadResultSchema,
				...(Object.keys(businessInput).length === 0 ? {} : { body: businessInput }),
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = speakerProfileDirectoryReadResultSchema.safeParse(response.data);
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
		) => mutate('approve', value, key, options),
		async updateReviewPolicy(
			value: SpeakerProfileReviewPolicyUpdateInput,
			key: string,
			options: { readonly signal?: AbortSignal } = {}
		) {
			const body = speakerProfileReviewPolicyUpdateInputSchema.safeParse(value);
			if (!body.success || !operationHttpIdempotencyKeySchema.safeParse(key).success) {
				return invalidRequest();
			}
			if (reviewPolicyUpdate.kind === 'unavailable') {
				return {
					kind: 'unavailable' as const,
					operation: 'reviewPolicyUpdate' as const,
					reason: reviewPolicyUpdate.reason
				};
			}
			const response = await request({
				path: reviewPolicyUpdate.path,
				method: 'POST',
				schema: speakerProfileReviewPolicyUpdateResultSchema,
				body: body.data,
				idempotencyKey: key,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error' as const, error: response.error };
			const parsed = speakerProfileReviewPolicyUpdateResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				return {
					kind: 'outcome' as const,
					outcome: parsed.data.outcome,
					terminal: parsed.data.terminal,
					correlationId: parsed.data.correlationId,
					...('receipt' in parsed.data ? { receipt: parsed.data.receipt } : {})
				};
			}
			if (parsed.data.receipt.operationName !== EXPECTED.reviewPolicyUpdate.name) {
				return invalidContract();
			}
			return {
				kind: 'success' as const,
				data: parsed.data.data,
				receipt: parsed.data.receipt,
				correlationId: parsed.data.correlationId
			};
		}
	});
}
