import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	SESSION_OPERATION_SCHEMA_REFS,
	sessionDirectOperationResultSchema,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { createSessionCatalogLivePort } from './session-catalog-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const change: SafeOperationManifestEntry = {
	name: 'session.change', version: 1, lifecycle: { status: 'active' }, summary: 'Change a Session.',
	effect: 'commit', maxRisk: 'low', consequenceTags: [], inputSchema: SESSION_OPERATION_SCHEMA_REFS.direct.inputSchema,
	autonomy: { policy: { key: 'autonomy.session.change', version: 1 }, riskFloor: 'low',
		unattendedRiskCeiling: 'low', requiresSeparateApproval: false, supportedDispositions: ['proceed', 'block'],
		triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'block',
			approval_required: 'block', known_retryable_failure: 'block', ambiguous_external_effect: 'block',
			stale_plan: 'block', compensation_required: 'block', terminal_failure: 'block' } },
	idempotency: { required: true, keySource: { key: 'idempotency.operator-header', version: 1 },
		credentialVerifierProfile: { key: 'credential.session', version: 1 },
		requestHashProfile: { key: 'request-hash.session', version: 1 } },
	concurrency: { kind: 'registered', definition: { key: 'concurrency.session', version: 1 } }, outcomes: [],
	enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: 'POST',
		path: '/api/events/current/sessions', input: 'body',
		resultSchema: SESSION_OPERATION_SCHEMA_REFS.direct.resultSchema, browserResumption: { kind: 'none' } }]
};
const manifest = safeOperationManifestSchema.parse({
	schemaVersion: 1, registryDigestSha256: 'a'.repeat(64), operations: [change]
});

describe('Session direct live port', () => {
	test('removes a new Session with exactly one request and the supplied attempt key', async () => {
		const calls: unknown[] = [];
		const port = createSessionCatalogLivePort({ manifest, request: async (request) => {
			calls.push(request);
			return { kind: 'success', data: sessionDirectOperationResultSchema.parse({
				kind: 'success', data: { action: 'remove_new_session', catalogVersion: 4, session: null },
				receipt: { id: id(5), operationName: 'session.change', operationVersion: 1 }, correlationId: id(6)
			}) };
		} });
		const key = 'session-remove-attempt-00000001';
		expect(await port.applyChange({ action: 'remove_new_session', expectedCatalogVersion: 3,
			expectedCatalogDigestSha256: 'b'.repeat(64), sessionId: id(2), expectedSessionVersion: 1,
			expectedSessionDigestSha256: 'c'.repeat(64) } as never, key)).toMatchObject({
			kind: 'success', data: { action: 'remove_new_session', session: null }
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/events/current/sessions', idempotencyKey: key });
	});

	test('refuses a backward lifecycle request before transport', async () => {
		let called = false;
		const port = createSessionCatalogLivePort({ manifest, request: async () => {
			called = true; throw new Error('unexpected');
		} });
		expect(await port.applyChange({ action: 'transition', to: 'draft' } as never,
			'session-direct-attempt-0001')).toMatchObject({ kind: 'transport_error', error: { code: 'invalid_request' } });
		expect(called).toBe(false);
	});
});
