import { describe, expect, test } from 'bun:test';
import {
	programVocabularyDraftOperationResultSchema,
	PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
	programVocabularySnapshotReadResultSchema,
	safeOperationManifestSchema,
	type SafeOperationManifest,
	type SafeOperationManifestEntry,
	type SafePublicOperationBinding
} from '@jooevents/contracts';
import {
	createProgramVocabularyLiveClient,
	PROGRAM_VOCABULARY_DRAFT_OPERATIONS,
	PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
	type ProgramVocabularyDraftRequest,
	type ProgramVocabularyLiveClient,
	type ProgramVocabularyLiveRequester
} from './program-vocabulary-live';

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '018f7d5a-4b3c-7abc-8def-0123456789ab';
const firstId = '018f7d5a-4b3c-7abc-8def-0123456789b0';
const secondId = '018f7d5a-4b3c-7abc-8def-0123456789b1';

function binding(input: {
	method: 'GET' | 'POST';
	path: string;
	requestInput: 'query' | 'body';
	resultSchema: SafePublicOperationBinding['resultSchema'];
}): SafePublicOperationBinding {
	return {
		surface: 'operator_http',
		protocol: 'http',
		method: input.method,
		path: input.path,
		input: input.requestInput,
		resultSchema: input.resultSchema,
		browserResumption: { kind: 'none' }
	};
}

function operation(input: {
	identity: { readonly name: string; readonly version: number };
	effect: 'read' | 'draft';
	binding: SafePublicOperationBinding;
	schemas: typeof PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead;
	overrides?: Partial<SafeOperationManifestEntry>;
}): SafeOperationManifestEntry {
	return {
		name: input.identity.name,
		version: input.identity.version,
		lifecycle: { status: 'active' },
		summary: 'Program Vocabulary operation.',
		effect: input.effect,
		maxRisk: 'low',
		autonomy: {
			policy: { key: `autonomy.${input.identity.name}`, version: 1 },
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
		inputSchema: input.schemas.inputSchema,
		idempotency:
			input.effect === 'read'
				? { required: false }
				: {
						required: true,
						keySource: { key: 'idempotency.operator_header', version: 1 },
						credentialVerifierProfile: { key: 'idempotency.operator', version: 1 },
						requestHashProfile: { key: 'request_hash.program_vocabulary', version: 1 }
					},
		concurrency:
			input.effect === 'read'
				? { kind: 'read_snapshot' }
				: { kind: 'registered', definition: { key: 'concurrency.program_vocabulary', version: 1 } },
		outcomes: [],
		enabledBindings: [input.binding],
		...input.overrides
	};
}

const readBinding = binding({
	method: 'GET', path: '/api/events/current/program-vocabulary', requestInput: 'query',
	resultSchema: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema
});
const readPath = '/api/events/current/program-vocabulary';

const draftPaths = {
	create: '/api/events/current/program-vocabulary/drafts/create',
	edit: '/api/events/current/program-vocabulary/drafts/edit',
	retire: '/api/events/current/program-vocabulary/drafts/retire',
	restore: '/api/events/current/program-vocabulary/drafts/restore',
	delete: '/api/events/current/program-vocabulary/drafts/delete',
	merge: '/api/events/current/program-vocabulary/drafts/merge'
} as const;

function defaultOperations(): SafeOperationManifestEntry[] {
	return [
		operation({
			identity: PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
			effect: 'read',
			binding: readBinding,
			schemas: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead
		}),
		...Object.entries(PROGRAM_VOCABULARY_DRAFT_OPERATIONS).map(([action, identity]) =>
			operation({
				identity,
				effect: 'draft',
				binding: binding({
					method: 'POST',
					path: draftPaths[action as keyof typeof draftPaths],
					requestInput: 'body',
					resultSchema: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts[
						action as keyof typeof draftPaths
					].resultSchema
				}),
				schemas: PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts[
					action as keyof typeof draftPaths
				]
			})
		)
	];
}

function manifest(operations: readonly SafeOperationManifestEntry[] = defaultOperations()): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: 'f'.repeat(64),
		operations
	});
}

const readSuccess = programVocabularySnapshotReadResultSchema.parse({
	kind: 'success',
	correlationId,
	data: {
		schemaVersion: 1,
		scope: { workspaceId, eventId },
		setVersion: 4,
		rooms: [{
			kind: 'room', id: firstId, name: 'Flexible room', status: 'active', version: 2,
			capacity: null,
			usage: { current: 2, historicalPins: 5 },
			deleteEligibility: { kind: 'blocked', currentReferences: 2, historicalPins: 5 }
		}],
		tracks: [],
		formats: []
	}
});

const draftOutcome = programVocabularyDraftOperationResultSchema.parse({
	kind: 'outcome',
	terminal: false,
	correlationId,
	outcome: {
		class: 'stale_revision',
		kind: 'program_vocabulary.set_changed',
		retryable: false,
		subjects: [],
		detail: null,
		detailSchemaVersion: 1
	}
});
if (draftOutcome.kind !== 'outcome') throw new TypeError('expected_draft_outcome_fixture');

const createSuccess = programVocabularyDraftOperationResultSchema.parse({
	kind: 'success',
	correlationId,
	receipt: {
		id: secondId,
		operationName: PROGRAM_VOCABULARY_DRAFT_OPERATIONS.create.name,
		operationVersion: 1
	},
	data: {
		schemaVersion: 1,
		action: 'create',
		changesetId: firstId,
		headVersion: 1,
		status: 'draft',
		revision: { id: secondId, number: 1, digestSha256: 'c'.repeat(64) },
		riskTier: 'low',
		approvalPolicy: {
			reference: { key: 'approval.program_vocabulary.default', version: 1 },
			definitionDigestSha256: 'd'.repeat(64),
			requirement: 'none'
		},
		safeDiff: {
			action: 'create',
			before: null,
			after: {
				kind: 'room', id: firstId, name: 'Flexible room', status: 'active',
				version: 1, capacity: null
			}
		}
	}
});

const requests: readonly ProgramVocabularyDraftRequest[] = [
	{ action: 'create', input: { kind: 'room', expectedSetVersion: 4, name: 'Workshop room', capacity: 80 } },
	{ action: 'edit', input: {
		kind: 'room', id: firstId, expectedSetVersion: 4, expectedItemVersion: 2,
		changes: { name: 'Flexible room', capacity: 120 }
	} },
	{ action: 'retire', input: { kind: 'room', id: firstId, expectedSetVersion: 4, expectedItemVersion: 2 } },
	{ action: 'restore', input: { kind: 'room', id: firstId, expectedSetVersion: 4, expectedItemVersion: 2 } },
	{ action: 'delete', input: { kind: 'room', id: firstId, expectedSetVersion: 4, expectedItemVersion: 2 } },
	{ action: 'merge', input: {
		kind: 'room', sourceId: firstId, targetId: secondId, expectedSetVersion: 4,
		expectedSourceVersion: 2, expectedTargetVersion: 1
	} }
];

function requester(input: {
	read?: ProgramVocabularyLiveRequester['read'];
	draft?: ProgramVocabularyLiveRequester['draft'];
} = {}): ProgramVocabularyLiveRequester {
	return {
		read: input.read ?? (async () => ({ kind: 'success', data: readSuccess })),
		draft: input.draft ?? (async () => ({ kind: 'success', data: draftOutcome }))
	};
}

function noAuthorityInputSurface(_client: ProgramVocabularyLiveClient): void {
	type ReadOptions = NonNullable<Parameters<ProgramVocabularyLiveClient['read']>[0]>;
	type DraftBusinessInput = ProgramVocabularyDraftRequest['input'];
	type Forbidden = Extract<
		keyof ReadOptions | keyof DraftBusinessInput,
		'actor' | 'scope' | 'authority' | 'approval' | 'role' | 'workspaceId' | 'eventId'
	>;
	const forbidden: readonly Forbidden[] = [];
	expect(forbidden).toEqual([]);
}

describe('pure-live Program Vocabulary operation client', () => {
	test('maps the canonical snapshot through the exact manifest path without authority input', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const abort = new AbortController();
		const client = createProgramVocabularyLiveClient({
			manifest: manifest(),
			request: requester({ read: async (input) => {
				calls.push(input as unknown as Record<string, unknown>);
				return { kind: 'success', data: readSuccess };
			} })
		});
		noAuthorityInputSurface(client);

		expect(await client.read({ signal: abort.signal })).toMatchObject({
			kind: 'success',
			correlationId,
			data: {
				setVersion: 4,
				rooms: [{
					name: 'Flexible room',
					usage: { currentReferences: 2, historicalPins: 5 },
					deleteAvailability: { kind: 'unavailable', currentReferences: 2, historicalPins: 5 }
				}]
			}
		});
		expect(calls[0]).toMatchObject({
			path: readPath, method: 'GET', schema: programVocabularySnapshotReadResultSchema,
			signal: abort.signal
		});
	});

	test('resolves all six draft operations independently and sends idempotency as metadata only', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const client = createProgramVocabularyLiveClient({
			manifest: manifest(),
			request: requester({ draft: async (input) => {
				calls.push(input as unknown as Record<string, unknown>);
				return { kind: 'success', data: draftOutcome };
			} })
		});

		for (const [index, request] of requests.entries()) {
			const idempotencyKey = `program-vocabulary-${request.action}-${index}`;
			expect(await client.draft(request, { idempotencyKey })).toEqual({
				kind: 'outcome',
				outcome: draftOutcome.outcome,
				terminal: false,
				correlationId
			});
			const call = calls[index];
			expect(call).toMatchObject({
				path: draftPaths[request.action],
				method: 'POST',
				body: request.input,
				idempotencyKey
			});
			expect((call?.body as Record<string, unknown>).idempotencyKey).toBeUndefined();
			expect((call?.body as Record<string, unknown>).scope).toBeUndefined();
		}
	});

	test('maps a successful draft to an inert changeset projection, not effective state', async () => {
		const client = createProgramVocabularyLiveClient({
			manifest: manifest(),
			request: requester({ draft: async () => ({ kind: 'success', data: createSuccess }) })
		});
		const result = await client.draft(requests[0]!, { idempotencyKey: 'draft-create-success' });
		expect(result).toMatchObject({
			kind: 'success',
			data: {
				changesetId: firstId,
				status: 'draft',
				change: { action: 'create', before: null, after: { name: 'Flexible room' } }
			},
			receipt: { operationName: PROGRAM_VOCABULARY_DRAFT_OPERATIONS.create.name },
			correlationId
		});
		if (result.kind !== 'success') throw new TypeError('expected_success');
		expect('setVersion' in result.data).toBe(false);
	});

	test('keeps safe transport errors separate and fails a missing draft capability closed', async () => {
		const transportClient = createProgramVocabularyLiveClient({
			manifest: manifest(),
			request: requester({ read: async () => ({
				kind: 'error', error: { code: 'network_unavailable', retryable: true }
			}) })
		});
		expect(await transportClient.read()).toEqual({
			kind: 'transport_error', error: { code: 'network_unavailable', retryable: true }
		});

		let requested = false;
		const missingClient = createProgramVocabularyLiveClient({
			manifest: manifest(defaultOperations().filter(
				(candidate) => candidate.name !== PROGRAM_VOCABULARY_DRAFT_OPERATIONS.delete.name
			)),
			request: requester({ draft: async () => {
				requested = true;
				return { kind: 'success', data: draftOutcome };
			} })
		});
		expect(await missingClient.draft(requests[4]!, { idempotencyKey: 'missing-delete' })).toEqual({
			kind: 'unavailable', reason: 'operation_not_registered'
		});
		expect(requested).toBe(false);
	});

	test('fails a drifted draft schema ref closed before dispatch', async () => {
		const operations = defaultOperations();
		const createIndex = operations.findIndex(
			(candidate) => candidate.name === PROGRAM_VOCABULARY_DRAFT_OPERATIONS.create.name
		);
		if (createIndex < 0) throw new TypeError('create_operation_fixture_missing');
		const create = operations[createIndex]!;
		operations[createIndex] = {
			...create,
			inputSchema: {
				...create.inputSchema,
				key: 'schema.program_vocabulary.changed-create-draft.input'
			}
		};
		let requested = false;
		const client = createProgramVocabularyLiveClient({
			manifest: manifest(operations),
			request: requester({ draft: async () => {
				requested = true;
				return { kind: 'success', data: draftOutcome };
			} })
		});

		expect(await client.draft(requests[0]!, { idempotencyKey: 'drifted-create' })).toEqual({
			kind: 'unavailable', reason: 'operation_contract_mismatch'
		});
		expect(requested).toBe(false);
	});
});
