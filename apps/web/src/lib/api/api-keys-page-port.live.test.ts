import { describe, expect, test } from 'bun:test';
import {
	API_KEY_OPERATION_SCHEMA_REFS,
	apiKeyCreateOperationResultSchema,
	apiKeyListOperationResultSchema,
	apiKeySecretDeliveryResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { createLiveApiKeysPagePort, type ApiKeysPageRequester } from './api-keys-page-port.live';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const digest = 'a'.repeat(64);
const operations = {
	list: { name: 'workspace.api_key.list', effect: 'read', method: 'GET', path: '/api/workspace/api-keys', refs: API_KEY_OPERATION_SCHEMA_REFS.list },
	create: { name: 'workspace.api_key.create', effect: 'commit', method: 'POST', path: '/api/workspace/api-keys/create', refs: API_KEY_OPERATION_SCHEMA_REFS.create },
	rotate: { name: 'workspace.api_key.rotate', effect: 'commit', method: 'POST', path: '/api/workspace/api-keys/rotate', refs: API_KEY_OPERATION_SCHEMA_REFS.rotate },
	revoke: { name: 'workspace.api_key.revoke', effect: 'commit', method: 'POST', path: '/api/workspace/api-keys/revoke', refs: API_KEY_OPERATION_SCHEMA_REFS.revoke }
} as const;

function entry(item: (typeof operations)[keyof typeof operations]): SafeOperationManifestEntry {
	const effect = item.effect as OperationEffect;
	return {
		name: item.name, version: 1, lifecycle: { status: 'active' }, summary: item.name,
		effect, maxRisk: 'consequential', consequenceTags: [],
		autonomy: {
			policy: { key: `autonomy.${item.name}`, version: 1 }, riskFloor: 'consequential',
			unattendedRiskCeiling: 'consequential', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		inputSchema: item.refs.inputSchema,
		idempotency: effect === 'read' ? { required: false } : {
			required: true, keySource: { key: 'idempotency.operator', version: 1 },
			credentialVerifierProfile: { key: 'credential.operator', version: 1 },
			requestHashProfile: { key: 'request.api-key', version: 1 }
		},
		concurrency: effect === 'read' ? { kind: 'read_snapshot' } : {
			kind: 'registered', definition: { key: 'concurrency.api-key', version: 1 }
		},
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: item.method,
			path: item.path, input: effect === 'read' ? 'query' : 'body',
			resultSchema: item.refs.resultSchema, browserResumption: { kind: 'none' }
		}]
	};
}

const key = {
	id: id(1), ownerUserId: id(2), ownerDisplayName: 'Owner', name: 'Assistant',
	tokenHint: 'jooak1_Vk8j', reads: true, proposesChanges: true,
	permissionIds: ['event.read'], eventIds: [], createdAt: '2026-08-17T00:00:00.000Z',
	expiresAt: '2026-11-15T00:00:00.000Z', lastUsedAt: null, standing: 'active' as const,
	revokedAt: null, revokeReason: null, version: 1
};
const profiles = [
	{ key: 'full' as const, label: 'Full', description: 'Full.', proposesChanges: true, permissionIds: 'everything-held' as const },
	{ key: 'assistant' as const, label: 'Assistant', description: 'Assistant.', proposesChanges: true, permissionIds: ['event.read'] },
	{ key: 'dashboard' as const, label: 'Dashboard', description: 'Dashboard.', proposesChanges: false, permissionIds: ['event.read'] },
	{ key: 'schedule' as const, label: 'Schedule', description: 'Schedule.', proposesChanges: false, permissionIds: ['event.read'] }
];

describe('live API key settings port', () => {
	test('discovers bindings, hydrates metadata, commits create, then consumes the secret once', async () => {
		const manifest = safeOperationManifestSchema.parse({
			schemaVersion: 1, registryDigestSha256: digest,
			operations: Object.values(operations).map(entry)
		});
		const calls: string[] = [];
		const createBodies: unknown[] = [];
		const request: ApiKeysPageRequester = async (input) => {
			calls.push(input.path);
			if (input.path === operations.create.path) createBodies.push(input.body);
			if (input.path === operations.list.path) return { kind: 'success', data: apiKeyListOperationResultSchema.parse({
				kind: 'success', data: {
					schemaVersion: 1, timezone: 'Asia/Singapore', keys: [key], profiles,
					permissions: [{ id: 'event.read', group: 'event', groupLabel: 'Event', label: 'Read event', description: 'Read event basics.', risk: 'routine', held: true }],
					events: [{ id: id(3), name: 'Summit' }],
					expiry: { defaultDays: 90, maxDays: 365, rotationGraceHours: 168 }
				}, correlationId: id(90)
			}) };
			if (input.path === operations.create.path) return { kind: 'success', data: apiKeyCreateOperationResultSchema.parse({
				kind: 'success', data: { key, secretHandle: id(4) },
				receipt: { id: id(5), operationName: operations.create.name, operationVersion: 1 },
				correlationId: id(91)
			}) };
			if (input.path.endsWith(id(4))) return { kind: 'success', data: apiKeySecretDeliveryResultSchema.parse({
				kind: 'delivered', secret: `jooak1_${'A'.repeat(43)}`
			}) };
			throw new Error(`unexpected request ${input.path}`);
		};
		const port = createLiveApiKeysPagePort({ manifest, request });
		expect(await port.list()).toEqual([expect.objectContaining({ id: key.id, tokenHint: key.tokenHint })]);
		expect(port.timezone).toBe('Asia/Singapore');
		expect(port.catalog[0]).toMatchObject({ key: 'event', permissions: [{ id: 'event.read', held: true }] });
		expect(port.expiry.rotationGraceDays).toBe(7);
		expect(await port.create({
			name: 'Assistant', proposesChanges: true, permissionIds: ['event.read'],
			eventIds: [], expiresInDays: null
		})).toMatchObject({ kind: 'created', secret: `jooak1_${'A'.repeat(43)}` });
		expect(createBodies).toEqual([expect.objectContaining({ expiresInDays: null })]);
		expect(calls).toEqual([
			operations.list.path, operations.create.path, `/api/workspace/api-key-secrets/${id(4)}`
		]);
	});
});
