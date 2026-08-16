import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
	schedulePlacementOperationResultSchema,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { createSchedulePlacementLivePort } from './schedule-placement-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const mutation: SafeOperationManifestEntry = {
	name: 'schedule.placement', version: 1, lifecycle: { status: 'active' }, summary: 'Change a placement.',
	effect: 'commit', maxRisk: 'low', consequenceTags: [], inputSchema: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placement.inputSchema,
	autonomy: { policy: { key: 'autonomy.schedule.placement', version: 1 }, riskFloor: 'low',
		unattendedRiskCeiling: 'low', requiresSeparateApproval: false, supportedDispositions: ['proceed', 'block'],
		triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'block',
			approval_required: 'block', known_retryable_failure: 'block', ambiguous_external_effect: 'block',
			stale_plan: 'block', compensation_required: 'block', terminal_failure: 'block' } },
	idempotency: { required: true, keySource: { key: 'idempotency.operator-header', version: 1 },
		credentialVerifierProfile: { key: 'credential.schedule', version: 1 },
		requestHashProfile: { key: 'request-hash.schedule', version: 1 } },
	concurrency: { kind: 'registered', definition: { key: 'concurrency.schedule', version: 1 } }, outcomes: [],
	enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: 'POST',
		path: '/api/events/current/schedule/placements', input: 'body',
		resultSchema: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placement.resultSchema,
		browserResumption: { kind: 'none' } }]
};
const manifest = safeOperationManifestSchema.parse({
	schemaVersion: 1, registryDigestSha256: 'd'.repeat(64), operations: [mutation]
});

describe('Schedule Placement direct live port', () => {
	test('unplaces with exactly one request and the supplied attempt key', async () => {
		const calls: unknown[] = [];
		const port = createSchedulePlacementLivePort({ manifest, request: async (request) => {
			calls.push(request);
			return { kind: 'success', data: schedulePlacementOperationResultSchema.parse({
				kind: 'success', data: { action: 'unplace', scheduleVersion: 8, occurrence: null },
				receipt: { id: id(4), operationName: 'schedule.placement', operationVersion: 1 }, correlationId: id(5)
			}) };
		} });
		const key = 'schedule-unplace-attempt-00000001';
		expect(await port.placeOrMove({ action: 'unplace', expectedScheduleVersion: 7,
			occurrenceId: id(2), expectedOccurrenceVersion: 3 } as never, key)).toMatchObject({
			kind: 'success', data: { action: 'unplace', occurrence: null }
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/events/current/schedule/placements', idempotencyKey: key });
	});

	test('rejects an invalid direct request before transport', async () => {
		let called = false;
		const port = createSchedulePlacementLivePort({ manifest, request: async () => {
			called = true; throw new Error('unexpected');
		} });
		expect(await port.placeOrMove({ action: 'unplace' } as never, '')).toMatchObject({
			kind: 'transport_error', error: { code: 'invalid_request' }
		});
		expect(called).toBe(false);
	});
});
