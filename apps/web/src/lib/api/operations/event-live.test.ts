import { describe, expect, test } from 'bun:test';
import {
	EVENT_OPERATION_SCHEMA_REFS,
	currentEventReadResultSchema,
	eventCreateOperationResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { createEventLiveClient, EVENT_CREATE_OPERATION, EVENT_CURRENT_READ_OPERATION,
	type EventLiveRequester } from './event-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(9);
const eventInput = Object.freeze({ expectedEventSetVersion: 1, name: 'JooEvents Assembly',
	timezone: 'Asia/Singapore', startDate: '2027-03-18', endDate: '2027-03-20' });
const expected = Object.freeze({
	read: Object.freeze({ ...EVENT_CURRENT_READ_OPERATION, effect: 'read' as const, method: 'GET' as const,
		input: 'query' as const, idempotencyRequired: false, path: '/api/events/current',
		...EVENT_OPERATION_SCHEMA_REFS.currentRead }),
	create: Object.freeze({ ...EVENT_CREATE_OPERATION, effect: 'commit' as const, method: 'POST' as const,
		input: 'body' as const, idempotencyRequired: true, path: '/api/events',
		...EVENT_OPERATION_SCHEMA_REFS.create })
});
type Key = keyof typeof expected;
function operation(key: Key, overrides: Partial<SafeOperationManifestEntry> = {}): SafeOperationManifestEntry {
	const item = expected[key];
	const effect: OperationEffect = item.effect;
	return {
		name: item.name, version: item.version, lifecycle: { status: 'active' }, summary: item.name,
		effect, maxRisk: effect === 'read' ? 'low' : 'normal', consequenceTags: [],
		autonomy: { policy: { key: `autonomy.${item.name}`, version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'normal', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block' } },
		inputSchema: item.inputSchema,
		idempotency: item.idempotencyRequired ? { required: true,
			keySource: { key: 'idempotency.operator', version: 1 },
			credentialVerifierProfile: { key: 'credential.operator', version: 1 },
			requestHashProfile: { key: 'request-hash.event', version: 1 } } : { required: false },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.event', version: 1 } }, outcomes: [],
		enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: item.method,
			path: item.path, input: item.input, resultSchema: item.resultSchema,
			browserResumption: { kind: 'none' } }], ...overrides
	};
}
function manifest(createOverride: Partial<SafeOperationManifestEntry> = {}) {
	return safeOperationManifestSchema.parse({ schemaVersion: 1, registryDigestSha256: 'f'.repeat(64),
		operations: [operation('read'), operation('create', createOverride)] });
}
const result = eventCreateOperationResultSchema.parse({ kind: 'success', correlationId,
	receipt: { id: id(3), operationName: 'event.create', operationVersion: 1 },
	data: { eventSetVersion: 2, event: { id: id(1), name: eventInput.name,
		timezone: eventInput.timezone, startDate: eventInput.startDate, endDate: eventInput.endDate, version: 1 } } });

describe('Event direct live client', () => {
	test('reads and creates with one exact request and the unchanged caller key', async () => {
		const calls: unknown[] = [];
		const requester: EventLiveRequester = {
			read: async (input) => { calls.push(input); return { kind: 'success', data: currentEventReadResultSchema.parse({
				kind: 'success', correlationId, data: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 } }) }; },
			create: async (input) => { calls.push(input); return { kind: 'success', data: result }; }
		};
		const client = createEventLiveClient({ manifest: manifest(), request: requester });
		expect(await client.read()).toMatchObject({ kind: 'success', data: { kind: 'no_event' } });
		calls.length = 0;
		const key = 'event-create-attempt-00000001';
		const first = await client.create(eventInput, { idempotencyKey: key });
		expect(first).toMatchObject({ kind: 'success', data: { eventSetVersion: 2 },
			receipt: { operationName: 'event.create' } });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/events', body: eventInput, idempotencyKey: key });
	});

	test('fails closed for unavailable, malformed, mismatched receipt, and invalid input', async () => {
		let called = false;
		const malformedResult = structuredClone(result);
		Reflect.deleteProperty(malformedResult, 'receipt');
		const request: EventLiveRequester = { read: async () => { called = true; throw new Error('unexpected'); },
			create: async () => { called = true; return { kind: 'success', data: malformedResult }; } };
		expect(await createEventLiveClient({ manifest: {}, request }).create(eventInput,
			{ idempotencyKey: 'event-create-attempt-00000001' })).toEqual({
			kind: 'unavailable', reason: 'invalid_operation_manifest' });
		expect(called).toBe(false);
		const client = createEventLiveClient({ manifest: manifest(), request });
		expect(await client.create(eventInput, { idempotencyKey: 'event-create-attempt-00000001' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
		expect(await client.create({ ...eventInput, endDate: '2027-03-01' },
			{ idempotencyKey: 'event-create-attempt-00000002' })).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false } });
		const wrong = createEventLiveClient({ manifest: manifest(), request: { ...request,
			create: async () => ({ kind: 'success', data: { ...result,
				receipt: { id: id(4), operationName: 'event.create.draft', operationVersion: 1 } } }) } });
		expect(await wrong.create(eventInput, { idempotencyKey: 'event-create-attempt-00000003' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
	});

	test('rejects exact-binding path or schema drift before transport', async () => {
		let called = false;
		const client = createEventLiveClient({ manifest: manifest({ enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: 'POST', path: '/api/events/create-drift',
			input: 'body', resultSchema: EVENT_OPERATION_SCHEMA_REFS.create.resultSchema,
			browserResumption: { kind: 'none' } }] }), request: { read: async () => { called = true; throw new Error('unexpected'); },
			create: async () => { called = true; throw new Error('unexpected'); } } });
		expect(await client.create(eventInput, { idempotencyKey: 'event-create-attempt-00000004' }))
			.toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
		expect(called).toBe(false);
	});
});
