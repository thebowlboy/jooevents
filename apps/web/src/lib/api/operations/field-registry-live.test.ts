import { describe, expect, test } from 'bun:test';
import {
	FIELD_REGISTRY_OPERATION_SCHEMA_REFS,
	fieldRegistryDirectOperationResultSchema,
	fieldRegistrySnapshotReadResultSchema,
	safeOperationManifestSchema,
	type FieldRegistryDraftRequest,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createFieldRegistryLiveClient,
	FIELD_REGISTRY_DIRECT_OPERATIONS,
	FIELD_REGISTRY_SNAPSHOT_READ_OPERATION,
	type FieldRegistryRequester,
	type FieldRegistryRequestInput
} from './field-registry-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const fieldId = id(3);
const correlationId = id(900);
const paths = Object.freeze({
	snapshot: '/api/events/current/field-registry',
	add: '/api/events/current/field-registry/add',
	edit: '/api/events/current/field-registry/edit',
	move: '/api/events/current/field-registry/move',
	remove: '/api/events/current/field-registry/remove',
	restore: '/api/events/current/field-registry/restore'
} as const);
const contexts = Object.freeze({
	apply: { visible: true, required: false },
	onboard: { visible: false, required: false },
	profile: { visible: true, required: false }
});
const addedField = Object.freeze({
	id: fieldId,
	key: 'custom.company_00000000',
	version: 1,
	kind: 'text' as const,
	label: 'Company',
	help: 'Where you work.',
	answerOwner: 'person' as const,
	mapsTo: null,
	purpose: { kind: 'ordinary' as const },
	scope: { kind: 'shared' as const },
	group: 'identity' as const,
	position: 0,
	contexts,
	options: { kind: 'none' as const },
	constraints: { removal: 'allowed' as const, applyVisibility: 'editable' as const },
	fileUpload: 'not_applicable' as const
});
const addRequest = Object.freeze({
	action: 'add' as const,
	request: {
		expectedRegistryVersion: 1,
		field: {
			kind: 'text' as const,
			label: 'Company',
			help: 'Where you work.',
			answerOwner: 'person' as const,
			scope: { kind: 'shared' as const },
			contexts,
			options: { kind: 'none' as const }
		}
	}
} satisfies FieldRegistryDraftRequest);
const addDiff = Object.freeze({
	action: 'add' as const,
	registryVersionBefore: 1,
	registryVersionAfter: 2,
	before: null,
	after: addedField,
	placement: { index: 0, group: 'identity' as const, reasonKey: 'field_registry.placement.first' }
});

function expectedOperations(): Readonly<Record<keyof typeof paths, ExpectedOperatorHttpOperation>> {
	return {
		snapshot: { ...FIELD_REGISTRY_SNAPSHOT_READ_OPERATION, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead },
		...Object.fromEntries(Object.entries(FIELD_REGISTRY_DIRECT_OPERATIONS).map(([action, identity]) => [
			action,
			{ ...identity, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.direct[action as keyof typeof FIELD_REGISTRY_DIRECT_OPERATIONS] }
		]))
	} as Readonly<Record<keyof typeof paths, ExpectedOperatorHttpOperation>>;
}
function manifestEntry(key: keyof typeof paths, expected: ExpectedOperatorHttpOperation): SafeOperationManifestEntry {
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${expected.name}.`,
		effect,
		maxRisk: 'low',
		autonomy: {
			policy: { key: `autonomy.${expected.name}`, version: 1 },
			riskFloor: 'low', unattendedRiskCeiling: 'low', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: { authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block', known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block', compensation_required: 'block', terminal_failure: 'block' }
		},
		consequenceTags: [],
		inputSchema: expected.inputSchema,
		idempotency: expected.idempotencyRequired ? { required: true, keySource: { key: 'idempotency.operator_header', version: 1 }, credentialVerifierProfile: { key: 'credential.idempotency', version: 1 }, requestHashProfile: { key: 'request_hash.field_registry', version: 1 } } : { required: false },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' } : { kind: 'registered', definition: { key: `concurrency.${expected.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: expected.method, path: paths[key], input: expected.input, resultSchema: expected.resultSchema, browserResumption: { kind: 'none' } }]
	};
}
function manifest(omit: readonly string[] = []): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: Object.entries(expectedOperations()).filter(([key]) => !omit.includes(key)).map(([key, operation]) => manifestEntry(key as keyof typeof paths, operation))
	});
}
function directSuccess() {
	const parsed = fieldRegistryDirectOperationResultSchema.parse({
		kind: 'success', correlationId,
		receipt: { id: id(901), operationName: FIELD_REGISTRY_DIRECT_OPERATIONS.add.name, operationVersion: 1 },
		data: { action: 'add', mutation: { schemaVersion: 1, action: 'add', fieldId, registryVersion: 2, fieldVersion: 1, position: 0 }, safeDiff: addDiff }
	});
	if (parsed.kind !== 'success') throw new TypeError('success_fixture_invalid');
	return parsed;
}
function requester(payloads: Readonly<Record<string, unknown>>, calls: FieldRegistryRequestInput[] = []): FieldRegistryRequester {
	return async (request) => {
		calls.push(request);
		const payload = payloads[request.path];
		return payload === undefined ? { kind: 'error', error: { code: 'unexpected_request', retryable: false } } : { kind: 'success', data: payload };
	};
}

describe('pure-live Field Registry operation client', () => {
	test('reads and commits one exact add request with the caller key unchanged', async () => {
		const calls: FieldRegistryRequestInput[] = [];
		const read = fieldRegistrySnapshotReadResultSchema.parse({ kind: 'success', correlationId, data: { schemaVersion: 1, scope: { workspaceId, eventId }, version: 1, registryDigestSha256: digest('c'), fields: [] } });
		const client = createFieldRegistryLiveClient({ manifest: manifest(), request: requester({ [paths.snapshot]: read, [paths.add]: directSuccess() }, calls) });
		expect(await client.read()).toMatchObject({ kind: 'success', data: { workspaceId, eventId, version: 1, fields: [] } });
		expect(await client.apply(addRequest, 'field-add-1')).toMatchObject({ kind: 'success', data: { action: 'add', mutation: { registryVersion: 2 }, safeDiff: addDiff }, receipt: { operationName: 'field_registry.add' } });
		expect(calls.map((call) => call.path)).toEqual([paths.snapshot, paths.add]);
		expect(calls[1]?.idempotencyKey).toBe('field-add-1');
		expect(calls[1]?.body).toEqual(addRequest.request);
	});

	test('resolves every direct action to one request and preserves nonterminal refusals', async () => {
		const cases: readonly FieldRegistryDraftRequest[] = [
			addRequest,
			{ action: 'edit', request: { fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1, changes: { label: 'Employer' } } },
			{ action: 'move', request: { fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1, toIndex: 0 } },
			{ action: 'remove', request: { fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1 } },
			{ action: 'restore', request: { fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1, toIndex: 0 } }
		];
		for (const request of cases) {
			const calls: FieldRegistryRequestInput[] = [];
			const refusal = fieldRegistryDirectOperationResultSchema.parse({ kind: 'outcome', terminal: false, correlationId, outcome: { class: 'stale_revision', kind: 'field_registry.changed', retryable: false, subjects: [], detail: { code: 'stale_registry', action: request.action, fieldId }, detailSchemaVersion: 1 } });
			const client = createFieldRegistryLiveClient({ manifest: manifest(), request: requester({ [paths[request.action]]: refusal }, calls) });
			expect(await client.apply(request, `field-${request.action}`)).toMatchObject({ kind: 'outcome', terminal: false, outcome: { kind: 'field_registry.changed' } });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.path).toBe(paths[request.action]);
			expect(calls[0]?.idempotencyKey).toBe(`field-${request.action}`);
		}
	});

	test('fails closed before transport when the exact direct binding is absent', async () => {
		let requests = 0;
		const client = createFieldRegistryLiveClient({ manifest: manifest(['add']), request: async () => { requests += 1; return { kind: 'error', error: { code: 'unexpected', retryable: false } }; } });
		expect(await client.apply(addRequest, 'missing-add')).toEqual({ kind: 'unavailable', operation: 'add', reason: 'operation_not_registered' });
		expect(requests).toBe(0);
	});

	test('fails closed on action, receipt, or diff correlation mismatch', async () => {
		for (const payload of [
			{ ...directSuccess(), receipt: { ...directSuccess().receipt, operationName: 'field_registry.edit' } },
			{ ...directSuccess(), data: { ...directSuccess().data, action: 'edit', mutation: { ...directSuccess().data.mutation, action: 'edit' }, safeDiff: { ...addDiff, action: 'edit' } } },
			{ ...directSuccess(), data: { ...directSuccess().data, safeDiff: { ...addDiff, registryVersionAfter: 3 } } }
		]) {
			const client = createFieldRegistryLiveClient({ manifest: manifest(), request: requester({ [paths.add]: payload }) });
			expect(await client.apply(addRequest, 'bad-contract')).toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
		}
	});
});
