import { describe, expect, test } from 'bun:test';
import {
	PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	type PortalSnapshotDto
} from '@jooevents/contracts';
import type { ApiResult } from '../../client';
import {
	createDeferredPortalOperationsClient,
	type PortalManifestLoadResult
} from './deferred-operations-client';
import type { PortalLiveRequestInput } from './operations-client';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const correlationId = id(900);

function snapshotDto(): PortalSnapshotDto {
	return {
		schemaVersion: 1,
		participant: { id: id(20), displayName: 'Maya Kern', email: 'maya@example.test' },
		event: {
			id: id(2),
			name: 'JooConf 2026',
			timezone: 'Europe/Helsinki',
			cfpClosesAt: '2026-09-01T12:00:00.000Z',
			closePolicy: 'soft'
		},
		submissions: [],
		engagements: [],
		tasks: [],
		files: [],
		resources: [],
		profile: { fields: [] }
	};
}

function snapshotManifest(): unknown {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: 'f'.repeat(64),
		operations: [
			{
				name: 'portal.snapshot.read',
				version: 1,
				lifecycle: { status: 'active' },
				summary: 'Read the portal snapshot.',
				effect: 'read',
				maxRisk: 'low',
				autonomy: {
					policy: { key: 'autonomy.portal.snapshot.read', version: 1 },
					riskFloor: 'low',
					unattendedRiskCeiling: 'low',
					requiresSeparateApproval: false,
					supportedDispositions: ['proceed', 'block'],
					triggerDispositions: {
						authority_lost: 'block',
						unattended_bounds_exceeded: 'block',
						approval_required: 'block',
						known_retryable_failure: 'block',
						ambiguous_external_effect: 'block',
						stale_plan: 'block',
						compensation_required: 'block',
						terminal_failure: 'block'
					}
				},
				consequenceTags: [],
				inputSchema: PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
				idempotency: { required: false },
				concurrency: { kind: 'read_snapshot' },
				outcomes: [],
				enabledBindings: [
					{
						surface: 'participant_http',
						protocol: 'http',
						method: 'GET',
						path: '/api/portal/snapshot',
						input: 'query',
						resultSchema: PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
						browserResumption: { kind: 'none' }
					}
				]
			}
		]
	});
}

describe('deferred portal operations client', () => {
	test('loads the manifest once and shares it across calls', async () => {
		let loads = 0;
		const requests: PortalLiveRequestInput[] = [];
		const client = createDeferredPortalOperationsClient({
			loadManifest: async (): Promise<PortalManifestLoadResult> => {
				loads += 1;
				return { kind: 'success', manifest: snapshotManifest() };
			},
			request: async (input): Promise<ApiResult<unknown>> => {
				requests.push(input);
				return {
					kind: 'success',
					data: { kind: 'success', data: snapshotDto(), correlationId }
				};
			}
		});
		const [first, second] = await Promise.all([client.readSnapshot(), client.readSnapshot()]);
		expect(first.kind).toBe('success');
		expect(second.kind).toBe('success');
		expect(loads).toBe(1);
		expect(requests).toHaveLength(2);
		expect(requests[0]!.path).toBe('/api/portal/snapshot');
	});

	test('a failed manifest read answers as that call’s transport error and retries next call', async () => {
		const results: PortalManifestLoadResult[] = [
			{ kind: 'transport_error', error: { code: 'network_unavailable', retryable: true } },
			{ kind: 'success', manifest: snapshotManifest() }
		];
		let loads = 0;
		const client = createDeferredPortalOperationsClient({
			loadManifest: async () => {
				const next = results[loads];
				loads += 1;
				return next!;
			},
			request: async () => ({
				kind: 'success',
				data: { kind: 'success', data: snapshotDto(), correlationId }
			})
		});
		expect(await client.readSnapshot()).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
		expect((await client.readSnapshot()).kind).toBe('success');
		expect(loads).toBe(2);
	});

	test('a rejected loader never escapes as an uncaught failure', async () => {
		let loads = 0;
		const client = createDeferredPortalOperationsClient({
			loadManifest: async () => {
				loads += 1;
				throw new Error('loader exploded');
			},
			request: async () => ({
				kind: 'success',
				data: { kind: 'success', data: snapshotDto(), correlationId }
			})
		});
		expect(await client.readSnapshot()).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
		expect(loads).toBe(1);
	});

	test('respond over an unloadable manifest stays a typed transport error, never an act', async () => {
		const client = createDeferredPortalOperationsClient({
			loadManifest: async () => ({
				kind: 'transport_error',
				error: { code: 'request_timeout', retryable: true }
			})
		});
		expect(
			await client.respondToEngagement(
				{ engagementId: id(40), response: 'confirm' },
				'je.portal.respond.key'
			)
		).toEqual({
			kind: 'transport_error',
			error: { code: 'request_timeout', retryable: true }
		});
	});
});
