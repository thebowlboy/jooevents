import { describe, expect, test } from 'bun:test';
import {
	EVENT_SETTINGS_OPERATION_SCHEMA_REFS,
	currentEventSettingsReadResultSchema,
	eventSettingsUpdateOperationResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	createEventSettingsLiveClient,
	EVENT_SETTINGS_CURRENT_READ_OPERATION,
	EVENT_SETTINGS_UPDATE_OPERATION,
	type EventSettingsRequester
} from './event-settings-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const eventId = id(1);
const correlationId = id(900);
const digest = (seed: string) => seed.repeat(64);
const updateInput = Object.freeze({
	expectedEventId: eventId,
	expectedEventSetVersion: 3,
	expectedEventVersion: 4,
	name: 'JooEvents Assembly Live',
	timezone: 'Asia/Singapore',
	startDate: '2027-03-18',
	endDate: '2027-03-21',
	location: 'Suntec Convention Centre',
	venueNote: 'Registration opens on Level 2.',
	dayStart: '08:30',
	dayEnd: '17:30',
	slotMinutes: 30 as const
});
const after = Object.freeze({
	schemaVersion: 1 as const,
	eventId,
	eventSetVersion: 3,
	eventVersion: 5,
	name: updateInput.name,
	timezone: updateInput.timezone,
	startDate: updateInput.startDate,
	endDate: updateInput.endDate,
	location: updateInput.location,
	venueNote: updateInput.venueNote,
	dayStart: updateInput.dayStart,
	dayEnd: updateInput.dayEnd,
	slotMinutes: updateInput.slotMinutes,
	profileContentReview: false
});

const expected = {
	read: {
		...EVENT_SETTINGS_CURRENT_READ_OPERATION,
		effect: 'read' as const, method: 'GET' as const, input: 'query' as const,
		idempotencyRequired: false,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.currentRead,
		path: '/api/events/current/settings'
	},
	update: {
		...EVENT_SETTINGS_UPDATE_OPERATION,
		effect: 'commit' as const, method: 'POST' as const, input: 'body' as const,
		idempotencyRequired: true,
		...EVENT_SETTINGS_OPERATION_SCHEMA_REFS.update,
		path: '/api/events/current/settings'
	}
} as const;

function operation(key: keyof typeof expected): SafeOperationManifestEntry {
	const item = expected[key];
	const effect = item.effect as OperationEffect;
	return {
		name: item.name,
		version: item.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${item.name}.`,
		effect,
		maxRisk: 'low',
		autonomy: {
			policy: { key: `autonomy.${item.name}`, version: 1 },
			riskFloor: 'low', unattendedRiskCeiling: 'low', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block',
				approval_required: 'block', known_retryable_failure: 'block',
				ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		consequenceTags: [],
		inputSchema: item.inputSchema,
		idempotency: item.idempotencyRequired ? {
			required: true,
			keySource: { key: 'idempotency.operator_header', version: 1 },
			credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
			requestHashProfile: { key: 'request_hash.event_settings', version: 1 }
		} : { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.event_settings', version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: item.method,
			path: item.path, input: item.input, resultSchema: item.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest(keys: readonly (keyof typeof expected)[] = ['read', 'update']) {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys.map(operation)
	});
}

describe('pure-live Event Settings operation client', () => {
	test('uses one mutation call, preserves the action key, then verifies the joined read', async () => {
		const calls: Array<{ readonly path: string; readonly method: string; readonly idempotencyKey?: string }> = [];
		let reads = 0;
		const requester: EventSettingsRequester = async (request) => {
			calls.push(request);
			if (request.method === 'POST') {
				return { kind: 'success', data: eventSettingsUpdateOperationResultSchema.parse({
					kind: 'success',
					data: { schemaVersion: 1, action: 'update', eventId, eventSetVersion: 3, eventVersion: 5 },
					receipt: { id: id(2), operationName: 'event.settings.update', operationVersion: 1 },
					correlationId
				}) };
			}
			reads += 1;
			return { kind: 'success', data: currentEventSettingsReadResultSchema.parse({
				kind: 'success', data: after, correlationId: id(901 + reads)
			}) };
		};
		const client = createEventSettingsLiveClient({ manifest: manifest(), request: requester });
		const result = await client.update(updateInput, 'event-settings-save-01');
		expect(result).toMatchObject({
			kind: 'success',
			data: { settings: { eventId, eventVersion: 5, name: updateInput.name } },
			receipt: { operationName: 'event.settings.update', operationVersion: 1 }
		});
		expect(calls).toEqual([
			expect.objectContaining({
				path: '/api/events/current/settings', method: 'POST',
				idempotencyKey: 'event-settings-save-01'
			}),
			expect.objectContaining({ path: '/api/events/current/settings', method: 'GET' })
		]);
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	test('fails closed when update binding is absent', async () => {
		const client = createEventSettingsLiveClient({ manifest: manifest(['read']) });
		expect(await client.update(updateInput, 'event-settings-save-02')).toEqual({
			kind: 'unavailable', operation: 'update', reason: 'operation_not_registered'
		});
	});

	test('rejects an invalid action key before transport', async () => {
		let called = false;
		const client = createEventSettingsLiveClient({
			manifest: manifest(),
			request: async () => { called = true; throw new Error('unexpected'); }
		});
		expect(await client.update(updateInput, '')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(called).toBe(false);
	});
});
