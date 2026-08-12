import { describe, expect, test } from 'bun:test';
import {
	programVocabularySnapshotReadResultSchema,
	safeOperationManifestSchema,
	type SafeOperationManifest,
	type SafeOperationManifestEntry,
	type SafePublicOperationBinding
} from '@jooevents/contracts';
import {
	createProgramVocabularyLiveClient,
	PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION,
	type ProgramVocabularyLiveClient,
	type ProgramVocabularyUnavailableReason
} from './program-vocabulary-live';

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const scope = {
	workspaceId: '550e8400-e29b-41d4-a716-446655440000',
	eventId: '018f7d5a-4b3c-7abc-8def-0123456789ab'
} as const;

function schemaRef(key: string, seed: string) {
	return { key, version: 1, digestSha256: seed.repeat(64) } as const;
}

const resultSchema = schemaRef('schema.program_vocabulary.snapshot_read.result', 'b');
const operatorBinding = {
	surface: 'operator_http',
	protocol: 'http',
	method: 'GET',
	path: '/api/operations/program-vocabulary',
	input: 'query',
	resultSchema,
	browserResumption: { kind: 'none' }
} as const satisfies SafePublicOperationBinding;

function operation(
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	return {
		name: PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION.name,
		version: PROGRAM_VOCABULARY_SNAPSHOT_READ_OPERATION.version,
		lifecycle: { status: 'active' },
		summary: 'Read the current event Program Vocabulary snapshot.',
		effect: 'read',
		maxRisk: 'low',
		autonomy: {
			policy: { key: 'autonomy.program_vocabulary.snapshot_read', version: 1 },
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
		consequenceTags: ['disclosure'],
		inputSchema: schemaRef('schema.program_vocabulary.snapshot_read.input', 'a'),
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [operatorBinding],
		...overrides
	};
}

function manifest(operations: readonly SafeOperationManifestEntry[] = [operation()]): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: 'f'.repeat(64),
		operations
	});
}

const successResult = programVocabularySnapshotReadResultSchema.parse({
	kind: 'success',
	correlationId,
	data: {
		schemaVersion: 1,
		scope,
		setVersion: 4,
		rooms: [
			{
				kind: 'room',
				id: '018f7d5a-4b3c-7abc-8def-0123456789b0',
				name: 'Flexible room',
				status: 'active',
				version: 2,
				capacity: null,
				usage: { current: 2, historicalPins: 5 },
				deleteEligibility: { kind: 'blocked', currentReferences: 2, historicalPins: 5 }
			}
		],
		tracks: [],
		formats: []
	}
});

function noAuthorityInputSurface(_client: ProgramVocabularyLiveClient): void {
	type Options = NonNullable<Parameters<ProgramVocabularyLiveClient['read']>[0]>;
	type Forbidden = Extract<keyof Options, 'actor' | 'scope' | 'authority' | 'approval' | 'role'>;
	const forbidden: readonly Forbidden[] = [];
	expect(forbidden).toEqual([]);
}

describe('pure-live Program Vocabulary operation client', () => {
	test('uses the registry binding relative path and maps canonical success without business authority input', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const abort = new AbortController();
		const client = createProgramVocabularyLiveClient({
			manifest: manifest(),
			request: async (input) => {
				calls.push(input as unknown as Record<string, unknown>);
				return { kind: 'success', data: successResult };
			}
		});
		noAuthorityInputSurface(client);

		const result = await client.read({ signal: abort.signal });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			path: operatorBinding.path,
			method: 'GET',
			schema: programVocabularySnapshotReadResultSchema,
			signal: abort.signal
		});
		expect(Object.keys(calls[0] ?? {}).sort()).toEqual(['method', 'path', 'schema', 'signal']);
		expect(result).toEqual({
			kind: 'success',
			correlationId,
			data: {
				schemaVersion: 1,
				scope,
				setVersion: 4,
				rooms: [
					{
						kind: 'room',
						id: successResult.kind === 'success' ? successResult.data.rooms[0]?.id : '',
						name: 'Flexible room',
						status: 'active',
						version: 2,
						capacity: null,
						usage: { currentReferences: 2, historicalPins: 5 },
						deleteAvailability: {
							kind: 'unavailable',
							currentReferences: 2,
							historicalPins: 5
						}
					}
				],
				tracks: [],
				formats: []
			}
		});
	});

	test('keeps a structured outcome distinct from transport failure and success', async () => {
		const outcomeResult = programVocabularySnapshotReadResultSchema.parse({
			kind: 'outcome',
			correlationId,
			outcome: {
				class: 'access_denied',
				kind: 'program_vocabulary.not_authorized',
				retryable: false,
				subjects: [{ type: 'event', id: scope.eventId }],
				detail: { reason: 'current_authority_required' },
				detailSchemaVersion: 1
			}
		});
		const client = createProgramVocabularyLiveClient({
			manifest: manifest(),
			request: async () => ({ kind: 'success', data: outcomeResult })
		});
		if (outcomeResult.kind !== 'outcome') throw new TypeError('expected_outcome');

		expect(await client.read()).toEqual({
			kind: 'outcome',
			outcome: outcomeResult.outcome,
			correlationId
		});
	});

	test('keeps safe transport failure separate and does not manufacture canonical data', async () => {
		const error = { code: 'network_unavailable', retryable: true } as const;
		const client = createProgramVocabularyLiveClient({
			manifest: manifest(),
			request: async () => ({ kind: 'error', error })
		});

		expect(await client.read()).toEqual({ kind: 'transport_error', error });
	});

	test('fails closed for every unavailable manifest/binding class without requesting', async () => {
		const externalBinding = {
			surface: 'external_mcp',
			protocol: 'tool',
			toolName: 'program_vocabulary_snapshot_read',
			resultSchema
		} as const satisfies SafePublicOperationBinding;
		const unsupportedBinding = {
			...operatorBinding,
			method: 'POST',
			input: 'body'
		} as const satisfies SafePublicOperationBinding;
		const cases: readonly [unknown, ProgramVocabularyUnavailableReason][] = [
			[{}, 'invalid_operation_manifest'],
			[manifest([]), 'operation_not_registered'],
			[manifest([operation(), operation()]), 'operation_registration_ambiguous'],
			[manifest([operation({ lifecycle: { status: 'replay_only' } })]), 'operation_not_active'],
			[manifest([operation({ effect: 'draft' })]), 'operation_contract_mismatch'],
			[manifest([operation({ enabledBindings: [externalBinding] })]), 'operator_http_binding_not_registered'],
			[
				manifest([operation({ enabledBindings: [operatorBinding, operatorBinding] })]),
				'operator_http_binding_ambiguous'
			],
			[
				manifest([operation({ enabledBindings: [unsupportedBinding] })]),
				'operator_http_binding_unsupported'
			]
		];

		for (const [candidate, reason] of cases) {
			let requested = false;
			const client = createProgramVocabularyLiveClient({
				manifest: candidate,
				request: async () => {
					requested = true;
					return { kind: 'success', data: successResult };
				}
			});
			expect(await client.read()).toEqual({ kind: 'unavailable', reason });
			expect(requested).toBe(false);
		}
	});
});
