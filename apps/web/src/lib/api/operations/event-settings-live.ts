import {
	EVENT_SETTINGS_OPERATION_SCHEMA_REFS,
	currentEventSettingsReadResultSchema,
	eventSettingsUpdateInputSchema,
	eventSettingsUpdateOperationResultSchema,
	operationHttpIdempotencyKeySchema,
	type CurrentEventSettingsReadResult,
	type EventSettingsUpdateInput,
	type EventSettingsUpdateOperationResult,
	type OperationReceiptRef,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import { requestJson, type ApiResult, type SafeApiError } from '../client';
import { mapEventSettings } from '../mappers/event-settings';
import type { EventSettingsView } from '../view-models/event-settings';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution,
	type OperatorHttpBindingUnavailableReason
} from './operator-http-binding';

export const EVENT_SETTINGS_CURRENT_READ_OPERATION = Object.freeze({
	name: 'event.settings.current.read', version: 1
} as const);

export const EVENT_SETTINGS_UPDATE_OPERATION = Object.freeze({
	name: 'event.settings.update', version: 1
} as const);

const EXPECTED_OPERATIONS = Object.freeze({
	read: {
		...EVENT_SETTINGS_CURRENT_READ_OPERATION,
		effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.currentRead
	},
	update: {
		...EVENT_SETTINGS_UPDATE_OPERATION,
		effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.update
	}
} as const satisfies Readonly<Record<'read' | 'update', ExpectedOperatorHttpOperation>>);

export type EventSettingsLiveOperation = 'read' | 'update';

type Unavailable = {
	readonly kind: 'unavailable';
	readonly operation: EventSettingsLiveOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type EventSettingsLiveReadResult =
	| { readonly kind: 'success'; readonly data: EventSettingsView; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| Unavailable;

export interface EventSettingsCommittedUpdate {
	readonly settings: EventSettingsView;
}

export type EventSettingsLiveUpdateResult =
	| {
			readonly kind: 'success';
			readonly data: EventSettingsCommittedUpdate;
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

export interface EventSettingsLiveClient {
	read(options?: { readonly signal?: AbortSignal }): Promise<EventSettingsLiveReadResult>;
	update(
		input: EventSettingsUpdateInput,
		idempotencyKey: string,
		options?: { readonly signal?: AbortSignal }
	): Promise<EventSettingsLiveUpdateResult>;
}

export interface EventSettingsRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
	readonly signal?: AbortSignal;
}

export type EventSettingsRequester = (
	input: EventSettingsRequestInput
) => Promise<ApiResult<unknown>>;

type Bindings = Readonly<Record<keyof typeof EXPECTED_OPERATIONS, OperatorHttpBindingResolution>>;

function defaultRequester(input: EventSettingsRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest(): EventSettingsLiveUpdateResult {
	return { kind: 'transport_error', error: { code: 'invalid_request', retryable: false } };
}

function invalidContract(): EventSettingsLiveUpdateResult {
	return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze(Object.fromEntries(
		Object.entries(EXPECTED_OPERATIONS).map(([key, expected]) => [
			key,
			resolveOperatorHttpBinding({ manifest, expected })
		])
	) as unknown as Bindings);
}

function unavailable(
	operation: EventSettingsLiveOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
): Unavailable {
	return { kind: 'unavailable', operation, reason: binding.reason };
}

function receiptMatches(receipt: OperationReceiptRef | undefined): receipt is OperationReceiptRef {
	return receipt?.operationName === EVENT_SETTINGS_UPDATE_OPERATION.name
		&& receipt.operationVersion === EVENT_SETTINGS_UPDATE_OPERATION.version;
}

function sameUpdateResult(
	result: Extract<EventSettingsUpdateOperationResult, { readonly kind: 'success' }>,
	request: EventSettingsUpdateInput,
	settings: EventSettingsView
): boolean {
	return result.data.action === 'update'
		&& result.data.eventId === request.expectedEventId
		&& result.data.eventSetVersion === request.expectedEventSetVersion
		&& result.data.eventVersion === request.expectedEventVersion + 1
		&& settings.eventId === result.data.eventId
		&& settings.eventSetVersion === result.data.eventSetVersion
		&& settings.eventVersion === result.data.eventVersion
		&& settings.name === request.name
		&& settings.timezone === request.timezone
		&& settings.startDate === request.startDate
		&& settings.endDate === request.endDate
		&& settings.location === request.location
		&& settings.venueNote === request.venueNote
		&& settings.dayStart === request.dayStart
		&& settings.dayEnd === request.dayEnd
		&& settings.slotMinutes === request.slotMinutes;
}

export function createEventSettingsLiveClient(input: {
	readonly manifest: unknown;
	readonly request?: EventSettingsRequester;
}): EventSettingsLiveClient {
	const bindings = resolveBindings(input.manifest);
	const request = input.request ?? defaultRequester;

	async function read(
		options: { readonly signal?: AbortSignal } = {}
	): Promise<EventSettingsLiveReadResult> {
		if (bindings.read.kind === 'unavailable') return unavailable('read', bindings.read);
		const transport = await request({
			path: bindings.read.path,
			method: 'GET',
			schema: currentEventSettingsReadResultSchema,
			...(options.signal ? { signal: options.signal } : {})
		});
		if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
		const parsed = currentEventSettingsReadResultSchema.safeParse(transport.data);
		if (!parsed.success) {
			return { kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } };
		}
		const result: CurrentEventSettingsReadResult = parsed.data;
		return result.kind === 'success'
			? { kind: 'success', data: mapEventSettings(result.data), correlationId: result.correlationId }
			: { kind: 'outcome', outcome: result.outcome, correlationId: result.correlationId };
	}

	return Object.freeze({
		read,
		async update(
			rawRequest: EventSettingsUpdateInput,
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		): Promise<EventSettingsLiveUpdateResult> {
			const parsedRequest = eventSettingsUpdateInputSchema.safeParse(rawRequest);
			if (!parsedRequest.success
				|| !operationHttpIdempotencyKeySchema.safeParse(idempotencyKey).success) {
				return invalidRequest();
			}
			if (bindings.update.kind === 'unavailable') return unavailable('update', bindings.update);
			const transport = await request({
				path: bindings.update.path,
				method: 'POST',
				schema: eventSettingsUpdateOperationResultSchema,
				body: parsedRequest.data,
				idempotencyKey,
				...(options.signal ? { signal: options.signal } : {})
			});
			if (transport.kind === 'error') {
				return { kind: 'transport_error', error: transport.error };
			}
			const parsed = eventSettingsUpdateOperationResultSchema.safeParse(transport.data);
			if (!parsed.success) return invalidContract();
			const result = parsed.data;
			if (result.kind === 'outcome') {
				const receipt = 'receipt' in result ? result.receipt : undefined;
				if ((result.terminal && !receiptMatches(receipt))
					|| (!result.terminal && receipt !== undefined)) return invalidContract();
				return {
					kind: 'outcome', outcome: result.outcome, terminal: result.terminal,
					...(receipt ? { receipt } : {}), correlationId: result.correlationId
				};
			}
			if (!receiptMatches(result.receipt)) return invalidContract();
			const current = await read(options);
			if (current.kind !== 'success'
				|| !sameUpdateResult(result, parsedRequest.data, current.data)) return invalidContract();
			return {
				kind: 'success',
				data: Object.freeze({ settings: current.data }),
				receipt: result.receipt,
				correlationId: result.correlationId
			};
		}
	});
}
