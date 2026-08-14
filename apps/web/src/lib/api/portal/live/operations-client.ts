import {
	PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS,
	portalEngagementRespondInputSchema,
	portalEngagementRespondResultSchema,
	portalSnapshotReadResultSchema,
	type OperationReceiptRef,
	type PortalEngagementDto,
	type PortalEngagementRespondInput,
	type PortalSnapshotDto,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../../client';
import {
	resolveParticipantHttpBinding,
	type ExpectedParticipantHttpOperation,
	type ParticipantHttpBindingUnavailableReason
} from './participant-http-binding';

/**
 * Live client for the two served participant-lane operations: the portal
 * snapshot read (`portal.snapshot.read@1`) and the engagement response act
 * (`portal.engagement.respond@1`). Paths come only from the browser-safe
 * manifest's `participant_http` bindings — never guessed — and every answer
 * is validated against the published contract before it is believed.
 *
 * The respond input is parsed against the strict wire schema before the
 * request leaves, so an attribution, person, version, or actor claim is
 * structurally unrepresentable on this client exactly as it is on the wire:
 * the server derives `self` versus `co_speaker` from the authenticated
 * participant alone. Pure live: no sample state is ever consulted.
 */

export const PORTAL_LIVE_OPERATIONS = Object.freeze({
	snapshot: Object.freeze({ name: 'portal.snapshot.read', version: 1 } as const),
	respond: Object.freeze({ name: 'portal.engagement.respond', version: 1 } as const)
});

const EXPECTED_OPERATIONS = Object.freeze({
	snapshot: {
		...PORTAL_LIVE_OPERATIONS.snapshot,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead
	},
	respond: {
		...PORTAL_LIVE_OPERATIONS.respond,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.engagementRespond
	}
} as const satisfies Readonly<Record<string, ExpectedParticipantHttpOperation>>);

export type PortalLiveOperation = keyof typeof EXPECTED_OPERATIONS;

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: PortalLiveOperation;
	readonly reason: ParticipantHttpBindingUnavailableReason;
};

export type PortalLiveReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export type PortalLiveRespondResult =
	| {
			readonly kind: 'success';
			readonly data: PortalEngagementDto;
			readonly receipt: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly terminal: boolean;
			readonly receipt?: OperationReceiptRef;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface PortalLiveRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type PortalLiveRequester = (input: PortalLiveRequestInput) => Promise<ApiResult<unknown>>;

export interface PortalOperationsLiveClient {
	readSnapshot(
		options?: { readonly signal?: AbortSignal }
	): Promise<PortalLiveReadResult<PortalSnapshotDto>>;
	respondToEngagement(
		input: PortalEngagementRespondInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<PortalLiveRespondResult>;
}

function invalidRequest(): { kind: 'transport_error'; error: SafeApiError } {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): { kind: 'transport_error'; error: SafeApiError } {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

export function createPortalOperationsLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: PortalLiveRequester;
}): PortalOperationsLiveClient {
	const request = input.request
		?? ((requestInput: PortalLiveRequestInput) => requestJson(requestInput));
	const bindings = Object.freeze({
		snapshot: resolveParticipantHttpBinding({
			manifest: input.manifest,
			expected: EXPECTED_OPERATIONS.snapshot
		}),
		respond: resolveParticipantHttpBinding({
			manifest: input.manifest,
			expected: EXPECTED_OPERATIONS.respond
		})
	});

	return Object.freeze({
		async readSnapshot(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<PortalLiveReadResult<PortalSnapshotDto>> {
			if (bindings.snapshot.kind === 'unavailable') {
				return { kind: 'unavailable', operation: 'snapshot', reason: bindings.snapshot.reason };
			}
			const response = await request({
				path: bindings.snapshot.path,
				method: 'GET',
				schema: portalSnapshotReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = portalSnapshotReadResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				return {
					kind: 'outcome',
					outcome: parsed.data.outcome,
					correlationId: parsed.data.correlationId
				};
			}
			return {
				kind: 'success',
				data: parsed.data.data,
				correlationId: parsed.data.correlationId
			};
		},

		async respondToEngagement(
			rawInput: PortalEngagementRespondInput,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<PortalLiveRespondResult> {
			// Strict-parsing here refuses any smuggled claim before it can travel.
			const parsedInput = portalEngagementRespondInputSchema.safeParse(rawInput);
			if (!parsedInput.success) return invalidRequest();
			if (bindings.respond.kind === 'unavailable') {
				return { kind: 'unavailable', operation: 'respond', reason: bindings.respond.reason };
			}
			const response = await request({
				path: bindings.respond.path,
				method: 'POST',
				schema: portalEngagementRespondResultSchema,
				body: parsedInput.data,
				idempotencyKey,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (response.kind === 'error') return { kind: 'transport_error', error: response.error };
			const parsed = portalEngagementRespondResultSchema.safeParse(response.data);
			if (!parsed.success) return invalidContract();
			if (parsed.data.kind === 'outcome') {
				if (parsed.data.terminal) {
					if (
						parsed.data.receipt.operationName !== PORTAL_LIVE_OPERATIONS.respond.name
						|| parsed.data.receipt.operationVersion !== PORTAL_LIVE_OPERATIONS.respond.version
					) {
						return invalidContract();
					}
					return {
						kind: 'outcome',
						outcome: parsed.data.outcome,
						terminal: true,
						receipt: parsed.data.receipt,
						correlationId: parsed.data.correlationId
					};
				}
				return {
					kind: 'outcome',
					outcome: parsed.data.outcome,
					terminal: false,
					correlationId: parsed.data.correlationId
				};
			}
			// The refreshed projection must answer for exactly the engagement this
			// call named, under this operation's own receipt — a swapped record
			// never reads as this response succeeding.
			if (
				parsed.data.receipt.operationName !== PORTAL_LIVE_OPERATIONS.respond.name
				|| parsed.data.receipt.operationVersion !== PORTAL_LIVE_OPERATIONS.respond.version
				|| parsed.data.data.id !== parsedInput.data.engagementId
			) {
				return invalidContract();
			}
			return {
				kind: 'success',
				data: parsed.data.data,
				receipt: parsed.data.receipt,
				correlationId: parsed.data.correlationId
			};
		}
	});
}
