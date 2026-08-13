import { describe, expect, test } from 'bun:test';
import {
	FIELD_REGISTRY_OPERATION_SCHEMA_REFS,
	committedChangesetOperationResultSchema,
	fieldRegistryDraftOperationResultSchema,
	fieldRegistrySnapshotReadResultSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	type FieldRegistryDraftRequest,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createFieldRegistryLiveClient,
	FIELD_REGISTRY_DRAFT_OPERATIONS,
	FIELD_REGISTRY_SNAPSHOT_READ_OPERATION,
	type FieldRegistryRequester
} from './field-registry-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const fieldId = id(3);
const changesetId = id(4);
const revisionId = id(5);
const correlationId = id(900);

const paths = Object.freeze({
	snapshot: '/api/events/current/field-registry',
	add: '/api/events/current/field-registry/drafts/add',
	edit: '/api/events/current/field-registry/drafts/edit',
	move: '/api/events/current/field-registry/drafts/move',
	remove: '/api/events/current/field-registry/drafts/remove',
	restore: '/api/events/current/field-registry/drafts/restore',
	propose: '/api/changesets/proposals',
	commit: '/api/changesets/commits'
} as const);

const approvalPolicy = Object.freeze({
	reference: { key: 'approval.field_registry.bounded', version: 1 },
	definitionDigestSha256: digest('b'),
	requirement: 'none' as const
});

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
	placement: {
		index: 0,
		group: 'identity' as const,
		reasonKey: 'field_registry.placement.first'
	}
});

function expectedOperations(): Readonly<Record<string, ExpectedOperatorHttpOperation>> {
	return {
		snapshot: {
			...FIELD_REGISTRY_SNAPSHOT_READ_OPERATION,
			effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
			...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.snapshotRead
		},
		...Object.fromEntries(Object.entries(FIELD_REGISTRY_DRAFT_OPERATIONS).map(([action, identity]) => [
			action,
			{
				...identity,
				effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
				...FIELD_REGISTRY_OPERATION_SCHEMA_REFS.drafts[
					action as keyof typeof FIELD_REGISTRY_DRAFT_OPERATIONS
				]
			}
		])),
		propose: CHANGESET_REVIEW_OPERATIONS.propose,
		commit: CHANGESET_REVIEW_OPERATIONS.commit
	};
}

function manifestEntry(
	key: keyof typeof paths,
	expected: ExpectedOperatorHttpOperation
): SafeOperationManifestEntry {
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${expected.name}.`,
		effect,
		maxRisk: effect === 'commit' ? 'consequential' : effect === 'read' ? 'low' : 'normal',
		autonomy: {
			policy: { key: `autonomy.${expected.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'normal',
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
		inputSchema: expected.inputSchema,
		idempotency: expected.idempotencyRequired
			? {
					required: true,
					keySource: { key: 'idempotency.operator_header', version: 1 },
					credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
					requestHashProfile: { key: 'request_hash.field_registry', version: 1 }
				}
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${expected.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: expected.method,
			path: paths[key],
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest(omit: readonly string[] = []): SafeOperationManifest {
	const expected = expectedOperations();
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: Object.entries(expected)
			.filter(([key]) => !omit.includes(key))
			.map(([key, operation]) => manifestEntry(key as keyof typeof paths, operation))
	});
}

function draftSuccess(requirement: 'none' | 'distinct_current_human' = 'none') {
	return fieldRegistryDraftOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(901),
			operationName: FIELD_REGISTRY_DRAFT_OPERATIONS.add.name,
			operationVersion: 1
		},
		data: {
			schemaVersion: 1,
			action: 'add',
			changesetId,
			headVersion: 1,
			status: 'draft',
			revision: { id: revisionId, number: 1, digestSha256: digest('a') },
			riskTier: 'low',
			approvalPolicy: { ...approvalPolicy, requirement },
			safeDiff: addDiff
		}
	});
}

function proposedSuccess(safeDiff: unknown = addDiff) {
	return proposedChangesetOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(902),
			operationName: CHANGESET_REVIEW_OPERATIONS.propose.name,
			operationVersion: 1
		},
		data: {
			schemaVersion: 1,
			action: 'propose',
			diff: {
				changesetId,
				headVersion: 2,
				status: 'proposed',
				revisionId,
				revisionNumber: 1,
				revisionDigest: digest('a'),
				riskTier: 'low',
				approvalPolicy,
				operations: [{
					kind: 'field_registry.mutate',
					version: 1,
					riskTier: 'low',
					dependencyGroup: 'field_registry',
					safeDiff,
					consequences: ['field_registry_changed']
				}]
			}
		}
	});
}

const committedSuccess = committedChangesetOperationResultSchema.parse({
	kind: 'success',
	correlationId,
	receipt: {
		id: id(903),
		operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
		operationVersion: 1
	},
	data: {
		schemaVersion: 1,
		action: 'commit',
		changesetId,
		expectedHeadVersion: 2,
		committedHeadVersion: 3,
		revisionId,
		revisionDigest: digest('a')
	}
});

function requester(
	payloads: Readonly<Record<string, unknown>>,
	calls: FieldRegistryRequestInput[] = []
): FieldRegistryRequester {
	return async (request) => {
		calls.push(request);
		const payload = payloads[request.path];
		if (payload === undefined) {
			return { kind: 'error', error: { code: 'unexpected_request', retryable: false } };
		}
		return { kind: 'success', data: payload };
	};
}

type FieldRegistryRequestInput = Parameters<FieldRegistryRequester>[0];

describe('pure-live Field Registry operation client', () => {
	test('reads and commits one exact add draft through manifest-resolved draft, propose, and commit', async () => {
		const calls: FieldRegistryRequestInput[] = [];
		const read = fieldRegistrySnapshotReadResultSchema.parse({
			kind: 'success',
			correlationId,
			data: {
				schemaVersion: 1,
				scope: { workspaceId, eventId },
				version: 1,
				registryDigestSha256: digest('c'),
				fields: []
			}
		});
		const client = createFieldRegistryLiveClient({
			manifest: manifest(),
			request: requester({
				[paths.snapshot]: read,
				[paths.add]: draftSuccess(),
				[paths.propose]: proposedSuccess(),
				[paths.commit]: committedSuccess
			}, calls)
		});

		expect(await client.read()).toMatchObject({
			kind: 'success', data: { workspaceId, eventId, version: 1, fields: [] }
		});
		expect(await client.apply(addRequest, 'field-add-workflow')).toMatchObject({
			kind: 'success',
			data: {
				action: 'add',
				changesetId,
				committedHeadVersion: 3,
				safeDiff: addDiff
			},
			receipt: { operationName: CHANGESET_REVIEW_OPERATIONS.commit.name }
		});

		expect(calls.map((call) => call.path)).toEqual([
			paths.snapshot, paths.add, paths.propose, paths.commit
		]);
		const effectCalls = calls.slice(1);
		expect(effectCalls.map((call) => call.idempotencyKey?.split('.').at(-2)))
			.toEqual(['draft', 'propose', 'commit']);
		expect(new Set(effectCalls.map((call) => call.idempotencyKey)).size).toBe(3);
		expect(JSON.stringify(effectCalls.map((call) => call.body))).not.toContain('field-add-workflow');
		expect(effectCalls[0]?.body).toEqual(addRequest.request);
		expect((effectCalls[0]?.body as Record<string, unknown>).scope).toBeUndefined();
	});

	test('resolves all five draft endpoints and preserves a structured nonterminal refusal', async () => {
		const cases: readonly FieldRegistryDraftRequest[] = [
			addRequest,
			{ action: 'edit', request: {
				fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1,
				changes: { label: 'Employer' }
			} },
			{ action: 'move', request: {
				fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1, toIndex: 0
			} },
			{ action: 'remove', request: {
				fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1
			} },
			{ action: 'restore', request: {
				fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 1, toIndex: 0
			} }
		];
		for (const draftRequest of cases) {
			const calls: FieldRegistryRequestInput[] = [];
			const refusal = fieldRegistryDraftOperationResultSchema.parse({
				kind: 'outcome',
				terminal: false,
				correlationId,
				outcome: {
					class: 'stale_revision',
					kind: 'field_registry.changed',
					retryable: false,
					subjects: [],
					detail: { code: 'stale_registry', action: draftRequest.action, fieldId },
					detailSchemaVersion: 1
				}
			});
			const client = createFieldRegistryLiveClient({
				manifest: manifest(),
				request: requester({ [paths[draftRequest.action]]: refusal }, calls)
			});
			expect(await client.apply(draftRequest, `field-${draftRequest.action}`)).toMatchObject({
				kind: 'outcome',
				terminal: false,
				outcome: { class: 'stale_revision', kind: 'field_registry.changed' }
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]?.path).toBe(paths[draftRequest.action]);
			expect(calls[0]?.body).toEqual(draftRequest.request);
		}
	});

	test('fails closed before drafting when generic commit is absent', async () => {
		let requests = 0;
		const client = createFieldRegistryLiveClient({
			manifest: manifest(['commit']),
			request: async () => {
				requests += 1;
				return { kind: 'error', error: { code: 'unexpected', retryable: false } };
			}
		});
		expect(await client.apply(addRequest, 'missing-commit')).toEqual({
			kind: 'unavailable', operation: 'commit', reason: 'operation_not_registered'
		});
		expect(requests).toBe(0);
	});

	test('returns the compact prepared selector without committing when policy requires another human', async () => {
		const calls: FieldRegistryRequestInput[] = [];
		const client = createFieldRegistryLiveClient({
			manifest: manifest(),
			request: requester({ [paths.add]: draftSuccess('distinct_current_human') }, calls)
		});
		expect(await client.apply(addRequest, 'separate-approval')).toMatchObject({
			kind: 'confirmation_required',
			data: {
				action: 'add', changesetId, revisionId,
				requirement: 'distinct_current_human', safeDiff: addDiff
			}
		});
		expect(calls.map((call) => call.path)).toEqual([paths.add]);
	});

	test('refuses a proposed operation whose exact safe diff no longer matches the draft', async () => {
		const calls: FieldRegistryRequestInput[] = [];
		const client = createFieldRegistryLiveClient({
			manifest: manifest(),
			request: requester({
				[paths.add]: draftSuccess(),
				[paths.propose]: proposedSuccess({ ...addDiff, registryVersionAfter: 3 }),
				[paths.commit]: committedSuccess
			}, calls)
		});
		expect(await client.apply(addRequest, 'tampered-proposal')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
		expect(calls.map((call) => call.path)).toEqual([paths.add, paths.propose]);
	});
});
