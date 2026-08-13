import {
	EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS,
	emailProviderConfigurationReadInputSchema,
	emailProviderConfigurationReadOperationResultSchema,
	emailProviderReadinessGetInputSchema,
	emailProviderReadinessReadOperationResultSchema,
	type StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import type {
	CommunicationProviderReadOperation,
	CommunicationProviderReadResult,
	CommunicationsProviderReadPort
} from '../communications-provider-read-port';
import { requestJson, type ApiResult } from '../client';
import {
	mapEmailProviderConnection,
	mapEmailProviderReadiness
} from '../mappers/communications-provider-read';
import {
	resolveOperatorHttpBinding,
	type ExpectedOperatorHttpOperation,
	type OperatorHttpBindingResolution
} from './operator-http-binding';

type ExactProviderReadOperation = ExpectedOperatorHttpOperation & { readonly path: string };

/** Frozen browser expectations for the two mounted, read-only B3 operations. */
export const COMMUNICATIONS_PROVIDER_READ_OPERATIONS = Object.freeze({
	getConnection: Object.freeze({
		name: 'communication.provider_connection.read',
		version: 1,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: '/api/communications/provider-connection',
		...EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getConnection
	}),
	getReadiness: Object.freeze({
		name: 'communication.email_readiness.read',
		version: 1,
		effect: 'read',
		method: 'GET',
		input: 'query',
		idempotencyRequired: false,
		path: '/api/communications/email-readiness',
		...EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getReadiness
	})
} as const satisfies Readonly<Record<string, ExactProviderReadOperation>>);

type BindingKey = keyof typeof COMMUNICATIONS_PROVIDER_READ_OPERATIONS;
type Bindings = Readonly<Record<BindingKey, OperatorHttpBindingResolution>>;

export interface CommunicationsProviderReadRequestInput {
	readonly path: string;
	readonly schema: z.ZodType;
	readonly method: 'GET';
	readonly signal?: AbortSignal;
}

export type CommunicationsProviderReadRequester = (
	input: CommunicationsProviderReadRequestInput
) => Promise<ApiResult<unknown>>;

type ReadWireResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string };

function defaultRequester(input: CommunicationsProviderReadRequestInput): Promise<ApiResult<unknown>> {
	return requestJson(input);
}

function invalidRequest() {
	return { kind: 'transport_error' as const, error: { code: 'invalid_request', retryable: false } };
}

function invalidContract() {
	return { kind: 'transport_error' as const, error: { code: 'invalid_contract', retryable: true } };
}

function exactBinding(
	manifest: unknown,
	expected: ExactProviderReadOperation
): OperatorHttpBindingResolution {
	const binding = resolveOperatorHttpBinding({ manifest, expected });
	return binding.kind === 'available' && binding.path !== expected.path
		? { kind: 'unavailable', reason: 'operation_contract_mismatch' }
		: binding;
}

function resolveBindings(manifest: unknown): Bindings {
	return Object.freeze(Object.fromEntries(
		Object.entries(COMMUNICATIONS_PROVIDER_READ_OPERATIONS).map(([key, expected]) => [
			key,
			exactBinding(manifest, expected)
		])
	) as unknown as Bindings);
}

function unavailable(
	operation: CommunicationProviderReadOperation,
	binding: Extract<OperatorHttpBindingResolution, { readonly kind: 'unavailable' }>
) {
	return { kind: 'unavailable' as const, operation, reason: binding.reason };
}

function queryPath(path: string, input: object): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		if (typeof value !== 'string') throw new TypeError(`Unsupported provider query value for ${key}.`);
		query.append(key, value);
	}
	return query.size === 0 ? path : `${path}?${query.toString()}`;
}

async function requestRead<WireData, ViewData>(input: {
	readonly binding: OperatorHttpBindingResolution;
	readonly operation: CommunicationProviderReadOperation;
	readonly query: object;
	readonly request: CommunicationsProviderReadRequester;
	readonly resultSchema: z.ZodType;
	readonly map: (value: WireData) => ViewData;
	readonly guard: (value: WireData) => boolean;
	readonly signal?: AbortSignal;
}): Promise<CommunicationProviderReadResult<ViewData>> {
	if (input.binding.kind === 'unavailable') return unavailable(input.operation, input.binding);
	let path: string;
	try {
		path = queryPath(input.binding.path, input.query);
	} catch {
		return invalidRequest();
	}
	const transport = await input.request({
		path,
		method: 'GET',
		schema: input.resultSchema,
		...(input.signal ? { signal: input.signal } : {})
	});
	if (transport.kind === 'error') return { kind: 'transport_error', error: transport.error };
	const parsed = input.resultSchema.safeParse(transport.data);
	if (!parsed.success) return invalidContract();
	const result = parsed.data as ReadWireResult<WireData>;
	if (result.kind === 'outcome') return result;
	if (!input.guard(result.data)) return invalidContract();
	try {
		return { kind: 'success', data: input.map(result.data), correlationId: result.correlationId };
	} catch {
		return invalidContract();
	}
}

/** Creates the pure-live B3 browser client without configuring or invoking a provider. */
export function createCommunicationsProviderReadLivePort(input: {
	readonly manifest: unknown;
	readonly request?: CommunicationsProviderReadRequester;
}): CommunicationsProviderReadPort {
	const bindings = resolveBindings(input.manifest);
	const request = input.request ?? defaultRequester;

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		getConnection(raw, options = {}) {
			const parsed = emailProviderConfigurationReadInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getConnection,
				operation: 'communication.provider_connection.read',
				query: parsed.data,
				request,
				resultSchema: emailProviderConfigurationReadOperationResultSchema,
				map: mapEmailProviderConnection,
				guard: (connection) => connection.connectionId === parsed.data.connectionId
					&& connection.candidateRevisions.every((revision) =>
						revision.callbacks.state === 'not_supported'
						&& revision.inbound.state === 'not_enabled'),
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		getReadiness(raw = {}, options = {}) {
			const parsed = emailProviderReadinessGetInputSchema.safeParse(raw);
			if (!parsed.success) return Promise.resolve(invalidRequest());
			return requestRead({
				binding: bindings.getReadiness,
				operation: 'communication.email_readiness.read',
				query: parsed.data,
				request,
				resultSchema: emailProviderReadinessReadOperationResultSchema,
				map: mapEmailProviderReadiness,
				guard: (readiness) => readiness.callbacks.state === 'not_supported'
					&& readiness.inbound.state === 'not_enabled',
				...(options.signal ? { signal: options.signal } : {})
			});
		}
	} satisfies CommunicationsProviderReadPort);
}
