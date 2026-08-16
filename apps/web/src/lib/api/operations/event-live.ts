import {
	EVENT_OPERATION_SCHEMA_REFS,
	currentEventReadResultSchema,
	eventCreateInputSchema,
	eventCreateOperationResultSchema,
	operationHttpIdempotencyKeySchema,
	type CurrentEventReadResult,
	type EventCreateInput,
	type EventCreateOperationResult,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { mapCurrentEvent, mapEvent } from '../mappers/event';
import type { CurrentEventView, EventView } from '../view-models/event';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const EVENT_CURRENT_READ_OPERATION = Object.freeze({
	name: 'event.current.read', version: 1
} as const);
export const EVENT_CREATE_OPERATION = Object.freeze({
	name: 'event.create', version: 1
} as const);

const EXPECTED_PATHS = Object.freeze({
	read: '/api/events/current',
	create: '/api/events'
} as const);

type ExactExpectedOperation = ExpectedOperatorHttpOperation & { readonly path: string };

export type EventLiveUnavailableReason = OperatorHttpBindingUnavailableReason;
export type EventLiveReadResult =
	| { readonly kind: 'success'; readonly data: CurrentEventView; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: EventLiveUnavailableReason };
export type EventLiveCreateResult =
	| { readonly kind: 'success'; readonly data: { readonly eventSetVersion: number; readonly event: EventView };
		readonly receipt: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly terminal: boolean;
		readonly receipt?: OperationReceiptRef; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| { readonly kind: 'unavailable'; readonly reason: EventLiveUnavailableReason };

export interface EventLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<EventLiveReadResult>;
	create(input: EventCreateInput, options: {
		readonly idempotencyKey: string; readonly signal?: AbortSignal
	}): Promise<EventLiveCreateResult>;
}

interface EventReadRequestInput {
	readonly path: string; readonly schema: typeof currentEventReadResultSchema;
	readonly method: 'GET'; readonly signal?: AbortSignal;
}
interface EventCreateRequestInput {
	readonly path: string; readonly schema: typeof eventCreateOperationResultSchema;
	readonly method: 'POST'; readonly body: EventCreateInput;
	readonly idempotencyKey: string; readonly signal?: AbortSignal;
}
export interface EventLiveRequester {
	read(input: EventReadRequestInput): Promise<ApiResult<CurrentEventReadResult>>;
	create(input: EventCreateRequestInput): Promise<ApiResult<EventCreateOperationResult>>;
}
const defaultRequester: EventLiveRequester = Object.freeze({
	read: (input: EventReadRequestInput) => requestJson<CurrentEventReadResult>(input),
	create: (input: EventCreateRequestInput) => requestJson<EventCreateOperationResult>(input)
});

function exactBinding(manifest: unknown, expected: ExactExpectedOperation): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' }
		: binding;
}
function invalidRequest(): EventLiveCreateResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}
function invalidContract(): EventLiveCreateResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}
function receiptMatches(receipt: OperationReceiptRef | undefined): receipt is OperationReceiptRef {
	return receipt?.operationName === EVENT_CREATE_OPERATION.name
		&& receipt.operationVersion === EVENT_CREATE_OPERATION.version;
}

export function createEventLiveClient(input: {
	readonly manifest: unknown; readonly request?: EventLiveRequester;
}): EventLiveClient {
	const readBinding = exactBinding(input.manifest, {
		...EVENT_CURRENT_READ_OPERATION, effect: 'read', method: 'GET', input: 'query',
		idempotencyRequired: false, path: EXPECTED_PATHS.read, ...EVENT_OPERATION_SCHEMA_REFS.currentRead
	});
	const createBinding = exactBinding(input.manifest, {
		...EVENT_CREATE_OPERATION, effect: 'commit', method: 'POST', input: 'body',
		idempotencyRequired: true, path: EXPECTED_PATHS.create, ...EVENT_OPERATION_SCHEMA_REFS.create
	});
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		async read(options: { readonly signal?: AbortSignal } = {}): Promise<EventLiveReadResult> {
			if (readBinding.kind === 'unavailable') return readBinding;
			const transport = await request.read({ path: readBinding.path, method: 'GET',
				schema: currentEventReadResultSchema, ...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = currentEventReadResultSchema.safeParse(transport.data);
			if (!parsed.success) return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
			return parsed.data.kind === 'success'
				? { kind: 'success', data: mapCurrentEvent(parsed.data.data), correlationId: parsed.data.correlationId }
				: { kind: 'outcome', outcome: parsed.data.outcome, correlationId: parsed.data.correlationId };
		},
		async create(businessInput: EventCreateInput, options: {
			readonly idempotencyKey: string; readonly signal?: AbortSignal
		}): Promise<EventLiveCreateResult> {
			const parsedInput = eventCreateInputSchema.safeParse(businessInput);
			if (!parsedInput.success || !operationHttpIdempotencyKeySchema.safeParse(options.idempotencyKey).success) {
				return invalidRequest();
			}
			if (createBinding.kind === 'unavailable') return createBinding;
			options.signal?.throwIfAborted();
			const transport = await request.create({ path: createBinding.path, method: 'POST',
				schema: eventCreateOperationResultSchema, body: parsedInput.data,
				idempotencyKey: options.idempotencyKey,
				...(options.signal ? { signal: options.signal } : {}) });
			if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
			const parsed = eventCreateOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const result = parsed.data;
			if (result.kind === 'outcome') {
				if ((result.terminal && !receiptMatches(result.receipt))
					|| (!result.terminal && 'receipt' in result)) return invalidContract();
				return { kind: 'outcome', outcome: result.outcome, terminal: result.terminal,
					...('receipt' in result ? { receipt: result.receipt } : {}), correlationId: result.correlationId };
			}
			if (!receiptMatches(result.receipt)) return invalidContract();
			return { kind: 'success', data: Object.freeze({ eventSetVersion: result.data.eventSetVersion,
				event: mapEvent(result.data.event) }), receipt: result.receipt, correlationId: result.correlationId };
		}
	});
}
