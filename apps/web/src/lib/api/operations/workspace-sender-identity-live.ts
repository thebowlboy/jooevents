import {
	WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS,
	operationHttpIdempotencyKeySchema,
	workspaceSenderIdentityReadResultSchema,
	workspaceSenderIdentityUpdateInputSchema,
	workspaceSenderIdentityUpdateResultSchema,
	type OperationReceiptRef,
	type StructuredOutcome,
	type WorkspaceSenderIdentityDto,
	type WorkspaceSenderIdentityUpdateInput
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

/**
 * The browser client for the workspace sender-identity pair.
 *
 * The read is the same operation MCP agents consume; the update is operator
 * lane only. Neither shape carries a from-address: that stays per-installation
 * configuration so outbound mail keeps its SPF/DKIM alignment.
 */

export const WORKSPACE_SENDER_IDENTITY_READ_OPERATION = Object.freeze({
	name: 'communication.sender_identity.read',
	version: 1
} as const);

export const WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION = Object.freeze({
	name: 'communication.sender_identity.update',
	version: 1
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	read: {
		...WORKSPACE_SENDER_IDENTITY_READ_OPERATION,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		...WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.read
	},
	update: {
		...WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION,
		effect: 'commit',
		method: 'POST',
		input: 'body',
		idempotencyRequired: true,
		...WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS.update
	}
} as const satisfies Readonly<Record<'read' | 'update', ExpectedOperatorHttpOperation>>);

export type WorkspaceSenderIdentityLiveOperation = 'read' | 'update';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: WorkspaceSenderIdentityLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type WorkspaceSenderIdentityLiveReadResult =
	| {
			readonly kind: 'success';
			readonly data: WorkspaceSenderIdentityDto;
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'outcome';
			readonly outcome: StructuredOutcome;
			readonly correlationId: string;
	  }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export type WorkspaceSenderIdentityLiveUpdateResult =
	| {
			readonly kind: 'success';
			readonly data: WorkspaceSenderIdentityDto;
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

export interface WorkspaceSenderIdentityLiveClient {
	read(options?: {
		readonly signal?: AbortSignal;
	}): Promise<WorkspaceSenderIdentityLiveReadResult>;
	update(
		input: WorkspaceSenderIdentityUpdateInput,
		options?: { readonly signal?: AbortSignal }
	): Promise<WorkspaceSenderIdentityLiveUpdateResult>;
}

export interface WorkspaceSenderIdentityRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type WorkspaceSenderIdentityRequester = (
	input: WorkspaceSenderIdentityRequestInput
) => Promise<ApiResult<unknown>>;

type Bindings = Readonly<Record<'read' | 'update', OperatorHttpBindingResolution>>;

function defaultRequester(
	input: WorkspaceSenderIdentityRequestInput
): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest(): { readonly kind: 'transport_error'; readonly error: SafeApiError } {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): { readonly kind: 'transport_error'; readonly error: SafeApiError } {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function unavailable(
	operation: WorkspaceSenderIdentityLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): Unavailable {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function receiptMatches(
	receipt: OperationReceiptRef | undefined,
	operation: { readonly name: string; readonly version: number }
): receipt is OperationReceiptRef {
	return (
		receipt?.operationName === operation.name && receipt.operationVersion === operation.version
	);
}

/**
 * A fresh key per save attempt, matching every other command in the product.
 *
 * Deriving the key from the request bytes instead looks tidier and is wrong in
 * two ways. It makes a later save carrying the same values a REPLAY of the
 * earlier one, so the server answers with the old receipt and the surface shows
 * a sender that another operator has since replaced — the optimistic-concurrency
 * refusal that should have fired is swallowed by the idempotency layer. And it
 * needs `crypto.subtle`, which is undefined on a plain-HTTP origin, so the save
 * throws where the product is actually reachable over a tailnet.
 *
 * Retrying THE SAME attempt must reuse its key; that belongs to the caller
 * holding the attempt, not to a hash of what it happens to contain.
 */
function newSenderIdentityAttemptKey(): string {
	return `je.sender-identity.update.${globalThis.crypto.randomUUID()}`;
}

export function createWorkspaceSenderIdentityLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: WorkspaceSenderIdentityRequester;
}): WorkspaceSenderIdentityLiveClient {
	const bindings: Bindings = Object.freeze({
		read: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: EXPECTED_OPERATIONS.read
		}),
		update: resolveOperatorHttpBinding({
			manifest: input.manifest,
			expected: EXPECTED_OPERATIONS.update
		})
	});
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		async read(
			options: { readonly signal?: AbortSignal } = {}
		): Promise<WorkspaceSenderIdentityLiveReadResult> {
			if (bindings.read.kind === 'unavailable') return unavailable('read', bindings.read);
			const transport = await request({
				path: bindings.read.path,
				method: 'GET',
				schema: workspaceSenderIdentityReadResultSchema,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = workspaceSenderIdentityReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			return parsed.data.kind === 'success'
				? {
						kind: 'success',
						data: parsed.data.data,
						correlationId: parsed.data.correlationId
					}
				: {
						kind: 'outcome',
						outcome: parsed.data.outcome,
						correlationId: parsed.data.correlationId
					};
		},

		async update(
			raw: WorkspaceSenderIdentityUpdateInput,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<WorkspaceSenderIdentityLiveUpdateResult> {
			const parsedInput = workspaceSenderIdentityUpdateInputSchema.safeParse(raw);
			if (!parsedInput.success) return invalidRequest();
			if (bindings.update.kind === 'unavailable') return unavailable('update', bindings.update);
			const idempotencyKey = newSenderIdentityAttemptKey();
			if (!operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) {
				return invalidRequest();
			}
			options.signal?.throwIfAborted();

			const transport = await request({
				path: bindings.update.path,
				method: 'POST',
				schema: workspaceSenderIdentityUpdateResultSchema,
				body: parsedInput.data,
				idempotencyKey,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = workspaceSenderIdentityUpdateResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const result = parsed.data;
			if (result.kind === 'success') {
				if (!receiptMatches(result.receipt, WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION)) {
					return invalidContract();
				}
				return {
					kind: 'success',
					data: result.data,
					receipt: result.receipt,
					correlationId: result.correlationId
				};
			}
			const receipt = 'receipt' in result ? result.receipt : undefined;
			if (result.terminal && !receiptMatches(receipt, WORKSPACE_SENDER_IDENTITY_UPDATE_OPERATION)) {
				return invalidContract();
			}
			return {
				kind: 'outcome',
				outcome: result.outcome,
				terminal: result.terminal,
				...(receipt ? { receipt } : {}),
				correlationId: result.correlationId
			};
		}
	} satisfies WorkspaceSenderIdentityLiveClient);
}
