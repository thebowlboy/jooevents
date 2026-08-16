import { describe, expect, test } from 'bun:test';
import {
	PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
	programVocabularyDirectOperationResultSchema,
	programVocabularyMergePublishOperationResultSchema,
	programVocabularyMergeReviewOperationResultSchema,
	programVocabularySnapshotReadResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { createProgramVocabularyLiveClient, PROGRAM_VOCABULARY_DIRECT_OPERATIONS,
	PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION, PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
	PROGRAM_VOCABULARY_MERGE_PUBLISH_OPERATION,
	type ProgramVocabularyLiveClient, type ProgramVocabularyLiveRequester } from './program-vocabulary-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(90);
const itemId = id(1);
const targetId = id(2);
const directActions = ['create', 'edit', 'retire', 'restore', 'delete'] as const;
const paths = Object.freeze({ create: '/api/events/current/program-vocabulary/create',
	edit: '/api/events/current/program-vocabulary/edit', retire: '/api/events/current/program-vocabulary/retire',
	restore: '/api/events/current/program-vocabulary/restore', delete: '/api/events/current/program-vocabulary/delete' });

function operation(input: { readonly name: string; readonly version: number; readonly effect: OperationEffect;
	readonly method: 'GET' | 'POST'; readonly path: string; readonly input: 'query' | 'body';
	readonly schemas: typeof PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead }): SafeOperationManifestEntry {
	return { name: input.name, version: input.version, lifecycle: { status: 'active' }, summary: input.name,
		effect: input.effect, maxRisk: input.effect === 'read' ? 'low' : 'normal', consequenceTags: [],
		autonomy: { policy: { key: `autonomy.${input.name}`, version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'normal', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block' } },
		inputSchema: input.schemas.inputSchema,
		idempotency: input.effect === 'read' ? { required: false } : { required: true,
			keySource: { key: 'idempotency.operator', version: 1 },
			credentialVerifierProfile: { key: 'credential.operator', version: 1 },
			requestHashProfile: { key: 'request-hash.program', version: 1 } },
		concurrency: input.effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.program', version: 1 } }, outcomes: [],
		enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: input.method,
			path: input.path, input: input.input, resultSchema: input.schemas.resultSchema,
			browserResumption: { kind: 'none' } }]
	};
}
function manifest() {
	const operations = [operation({ ...PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION, effect: 'read', method: 'GET',
		path: '/api/events/current/program-vocabulary', input: 'query', schemas: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead })];
	for (const action of directActions) operations.push(operation({ ...PROGRAM_VOCABULARY_DIRECT_OPERATIONS[action],
		effect: 'commit', method: 'POST', path: paths[action], input: 'body',
		schemas: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.direct[action] }));
	operations.push(operation({ ...PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION, effect: 'draft', method: 'POST',
		path: '/api/events/current/program-vocabulary/merge/draft', input: 'body',
		schemas: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergeReviewDraft }));
	operations.push(operation({ ...PROGRAM_VOCABULARY_MERGE_PUBLISH_OPERATION, effect: 'commit', method: 'POST',
		path: '/api/events/current/program-vocabulary/merge', input: 'body',
		schemas: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.mergePublish }));
	return safeOperationManifestSchema.parse({ schemaVersion: 1, registryDigestSha256: 'f'.repeat(64), operations });
}
const readResult = programVocabularySnapshotReadResultSchema.parse({ kind: 'success', correlationId,
	data: { schemaVersion: 1, scope: { workspaceId: id(80), eventId: id(81) }, setVersion: 4,
		rooms: [], tracks: [], formats: [] } });
const requests = Object.freeze({
	create: { kind: 'room' as const, expectedSetVersion: 4, name: 'Workshop room', capacity: 80 },
	edit: { kind: 'room' as const, id: itemId, expectedSetVersion: 4, expectedItemVersion: 2,
		changes: { name: 'Flexible room', capacity: 120 } },
	retire: { kind: 'room' as const, id: itemId, expectedSetVersion: 4, expectedItemVersion: 2 },
	restore: { kind: 'room' as const, id: itemId, expectedSetVersion: 4, expectedItemVersion: 2 },
	delete: { kind: 'room' as const, id: itemId, expectedSetVersion: 4, expectedItemVersion: 2 }
});
function result(action: typeof directActions[number]) {
	return programVocabularyDirectOperationResultSchema.parse({ kind: 'success', correlationId,
		receipt: { id: id(30), operationName: `program_vocabulary.${action}`, operationVersion: 1 },
		data: { action, kind: 'room', affectedIds: [itemId], setVersion: 5, liveRepoints: 0 } });
}
function requester(calls: unknown[]): ProgramVocabularyLiveRequester {
	return { read: async (input) => { calls.push(input); return { kind: 'success', data: readResult }; },
		direct: async (input) => { calls.push(input); const action = directActions.find((value) => input.path === paths[value]);
			if (!action) throw new TypeError('unexpected_direct_path');
			return { kind: 'success', data: result(action) }; },
		draftMerge: async (input) => { calls.push(input); return { kind: 'success', data:
			programVocabularyMergeReviewOperationResultSchema.parse({ kind: 'outcome', terminal: false, correlationId,
				outcome: { class: 'stale_revision', kind: 'program_vocabulary.set_changed', retryable: false,
					subjects: [], detail: null, detailSchemaVersion: 1 } }) }; },
		publishMerge: async (input) => { calls.push(input); return { kind: 'success', data:
			programVocabularyMergePublishOperationResultSchema.parse({ kind: 'success', correlationId,
				receipt: { id: id(32), operationName: 'program_vocabulary.merge', operationVersion: 1 },
				data: { action: 'merge', kind: 'room', affectedIds: [itemId, targetId], setVersion: 5,
					liveRepoints: 2 } }) }; }
	};
}
async function invoke(client: ProgramVocabularyLiveClient, action: typeof directActions[number], key: string) {
	switch (action) {
		case 'create': return client.create(requests.create, { idempotencyKey: key });
		case 'edit': return client.edit(requests.edit, { idempotencyKey: key });
		case 'retire': return client.retire(requests.retire, { idempotencyKey: key });
		case 'restore': return client.restore(requests.restore, { idempotencyKey: key });
		case 'delete': return client.delete(requests.delete, { idempotencyKey: key });
	}
}

describe('Program Vocabulary split live client', () => {
	test('uses each exact direct binding once with one unchanged caller key', async () => {
		const calls: unknown[] = [];
		const client = createProgramVocabularyLiveClient({ manifest: manifest(), request: requester(calls) });
		for (const action of directActions) {
			calls.length = 0;
			const key = `program-vocabulary-${action}-attempt`;
			expect(await invoke(client, action, key)).toMatchObject({ kind: 'success',
				data: { action, setVersion: 5 }, receipt: { operationName: `program_vocabulary.${action}` } });
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ method: 'POST', path: paths[action], body: requests[action], idempotencyKey: key });
		}
	});

	test('uses separate exact merge review and publish calls with unchanged keys', async () => {
		const calls: unknown[] = [];
		const client = createProgramVocabularyLiveClient({ manifest: manifest(), request: requester(calls) });
		const key = 'program-vocabulary-merge-draft-attempt';
		expect(await client.draftMerge({ action: 'merge', input: { kind: 'room', sourceId: itemId,
			targetId, expectedSetVersion: 4, expectedSourceVersion: 2, expectedTargetVersion: 1 } },
			{ idempotencyKey: key })).toMatchObject({ kind: 'outcome', terminal: false });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/events/current/program-vocabulary/merge/draft',
			idempotencyKey: key });
		calls.length = 0;
		const publishKey = 'program-vocabulary-merge-publish-attempt';
		expect(await client.publishMerge({ draftId: id(40), revisionId: id(41),
			revisionDigestSha256: 'a'.repeat(64) }, { idempotencyKey: publishKey }))
			.toMatchObject({ kind: 'success', data: { action: 'merge' },
				receipt: { operationName: 'program_vocabulary.merge' } });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/events/current/program-vocabulary/merge',
			idempotencyKey: publishKey });
	});

	test('fails closed for unavailable, malformed direct result, and wrong receipt', async () => {
		let called = false;
		const noManifest = createProgramVocabularyLiveClient({ manifest: {}, request: {
			read: async () => { called = true; throw new Error('unexpected'); },
			direct: async () => { called = true; throw new Error('unexpected'); },
			draftMerge: async () => { called = true; throw new Error('unexpected'); },
			publishMerge: async () => { called = true; throw new Error('unexpected'); } } });
		expect(await noManifest.create(requests.create, { idempotencyKey: 'program-create-attempt' }))
			.toEqual({ kind: 'unavailable', reason: 'invalid_operation_manifest' });
		expect(called).toBe(false);
		const malformedResult = structuredClone(result('create'));
		Reflect.deleteProperty(malformedResult, 'receipt');
		const malformed = createProgramVocabularyLiveClient({ manifest: manifest(), request: {
			...requester([]), direct: async () => ({ kind: 'success', data: malformedResult }) } });
		expect(await malformed.create(requests.create, { idempotencyKey: 'program-create-attempt' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
		const wrong = createProgramVocabularyLiveClient({ manifest: manifest(), request: {
			...requester([]), direct: async () => ({ kind: 'success', data: { ...result('create'),
				receipt: { id: id(31), operationName: 'program_vocabulary.create.draft', operationVersion: 1 } } }) } });
		expect(await wrong.create(requests.create, { idempotencyKey: 'program-create-attempt' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
	});

	test('fails closed for mismatched merge publish results', async () => {
		const client = createProgramVocabularyLiveClient({ manifest: manifest(), request: {
			...requester([]),
			publishMerge: async () => ({ kind: 'success', data:
				programVocabularyMergePublishOperationResultSchema.parse({ kind: 'success', correlationId,
					receipt: { id: id(33), operationName: 'program_vocabulary.merge.draft', operationVersion: 1 },
					data: { action: 'merge', kind: 'room', affectedIds: [itemId, targetId], setVersion: 5,
						liveRepoints: 2 } }) })
		} });
		expect(await client.publishMerge({ draftId: id(40), revisionId: id(41),
			revisionDigestSha256: 'a'.repeat(64) }, { idempotencyKey: 'program-merge-publish-attempt' }))
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
	});
});
