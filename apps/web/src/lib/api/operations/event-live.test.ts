import { describe, expect, test } from 'bun:test';
import {
	EVENT_OPERATION_SCHEMA_REFS,
	committedChangesetOperationResultSchema,
	currentEventReadResultSchema,
	eventCreateDraftOperationResultSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	type EventCreateDraftOperationResult,
	type EventCreateSafeDiff,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import {
	createEventLiveClient,
	EVENT_CREATE_DRAFT_OPERATION,
	EVENT_CURRENT_READ_OPERATION,
	type EventLiveClient,
	type EventLiveRequester,
	type EventLiveUnavailableReason
} from './event-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);
const eventId = id(1);
const changesetId = id(2);
const revisionId = id(3);
const revisionDigest = digest('a');

const eventInput = Object.freeze({
	expectedEventSetVersion: 1,
	name: 'JooEvents Assembly',
	timezone: 'Asia/Singapore',
	startDate: '2027-03-18',
	endDate: '2027-03-20'
});

const safeDiff = Object.freeze({
	action: 'create' as const,
	before: null,
	after: Object.freeze({
		id: eventId,
		name: eventInput.name,
		timezone: eventInput.timezone,
		startDate: eventInput.startDate,
		endDate: eventInput.endDate,
		version: 1
	}),
	currentSelection: Object.freeze({ before: null, after: eventId }),
	eventSetVersion: Object.freeze({ before: 1, after: 2 })
});

const readSuccess = currentEventReadResultSchema.parse({
	kind: 'success',
	correlationId,
	data: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 }
});

function draftSuccess(overrides: Partial<EventCreateSafeDiff> = {}): EventCreateDraftOperationResult {
	return eventCreateDraftOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(4),
			operationName: EVENT_CREATE_DRAFT_OPERATION.name,
			operationVersion: EVENT_CREATE_DRAFT_OPERATION.version
		},
		data: {
			action: 'create',
			changesetId,
			headVersion: 1,
			revision: { id: revisionId, number: 1, digestSha256: revisionDigest },
			safeDiff: { ...safeDiff, ...overrides }
		}
	});
}

function changesetDiff(overrides: Record<string, unknown> = {}) {
	return {
		changesetId,
		headVersion: 2,
		status: 'proposed' as const,
		revisionId,
		revisionNumber: 1,
		revisionDigest,
		riskTier: 'normal' as const,
		approvalPolicy: {
			reference: { key: 'approval.event_creation', version: 1 },
			definitionDigestSha256: digest('b'),
			requirement: 'none' as const
		},
		operations: [{
			kind: 'event.creation',
			version: 1,
			riskTier: 'normal' as const,
			dependencyGroup: 'event_creation',
			safeDiff,
			consequences: ['event_selection_changed']
		}],
		...overrides
	};
}

function proposeSuccess(overrides: Record<string, unknown> = {}) {
	return proposedChangesetOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(5),
			operationName: CHANGESET_REVIEW_OPERATIONS.propose.name,
			operationVersion: CHANGESET_REVIEW_OPERATIONS.propose.version
		},
		data: {
			schemaVersion: 1,
			action: 'propose',
			diff: changesetDiff(overrides)
		}
	});
}

function commitSuccess(overrides: Record<string, unknown> = {}) {
	return committedChangesetOperationResultSchema.parse({
		kind: 'success',
		correlationId,
		receipt: {
			id: id(6),
			operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
			operationVersion: CHANGESET_REVIEW_OPERATIONS.commit.version
		},
		data: {
			schemaVersion: 1,
			action: 'commit',
			changesetId,
			expectedHeadVersion: 2,
			committedHeadVersion: 3,
			revisionId,
			revisionDigest,
			...overrides
		}
	});
}

const EXPECTED_OPERATIONS = Object.freeze({
	read: Object.freeze({
		...EVENT_CURRENT_READ_OPERATION,
		effect: 'read' as const,
		method: 'GET' as const,
		input: 'query' as const,
		idempotencyRequired: false,
		...EVENT_OPERATION_SCHEMA_REFS.currentRead,
		path: '/api/events/current'
	}),
	draft: Object.freeze({
		...EVENT_CREATE_DRAFT_OPERATION,
		effect: 'draft' as const,
		method: 'POST' as const,
		input: 'body' as const,
		idempotencyRequired: true,
		...EVENT_OPERATION_SCHEMA_REFS.createDraft,
		path: '/api/events/drafts/create'
	}),
	propose: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.propose,
		path: '/api/changesets/proposals'
	}),
	commit: Object.freeze({
		...CHANGESET_REVIEW_OPERATIONS.commit,
		path: '/api/changesets/commits'
	})
});

type OperationKey = keyof typeof EXPECTED_OPERATIONS;

function operation(
	key: OperationKey,
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	const expected = EXPECTED_OPERATIONS[key];
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
					requestHashProfile: { key: `request_hash.${expected.name}`, version: 1 }
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
			path: expected.path,
			input: expected.input,
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(
	keys: readonly OperationKey[] = ['read', 'draft', 'propose', 'commit'],
	overrides: Partial<Record<OperationKey, Partial<SafeOperationManifestEntry>>> = {}
): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys.map((key) => operation(key, overrides[key]))
	});
}

interface RecordedCall {
	readonly path: string;
	readonly method: 'GET' | 'POST';
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

function requester(
	calls: RecordedCall[],
	overrides: {
		readonly read?: EventLiveRequester['read'];
		readonly draft?: EventLiveRequester['draft'];
		readonly changesetPayloads?: Readonly<Record<string, unknown>>;
	} = {}
): EventLiveRequester {
	const changesetPayloads = overrides.changesetPayloads ?? {
		[EXPECTED_OPERATIONS.propose.path]: proposeSuccess(),
		[EXPECTED_OPERATIONS.commit.path]: commitSuccess()
	};
	return {
		read: overrides.read ?? (async (input) => {
			calls.push(input);
			return { kind: 'success', data: readSuccess };
		}),
		draft: overrides.draft ?? (async (input) => {
			calls.push(input);
			return { kind: 'success', data: draftSuccess() };
		}),
		changeset: async (input) => {
			calls.push(input as RecordedCall);
			return { kind: 'success', data: changesetPayloads[input.path] };
		}
	};
}

function noAuthorityInputSurface(_client: EventLiveClient): void {
	type ReadOptions = NonNullable<Parameters<EventLiveClient['read']>[0]>;
	type CreateInput = Parameters<EventLiveClient['create']>[0];
	type Forbidden = Extract<
		keyof ReadOptions | keyof CreateInput,
		'actor' | 'scope' | 'authority' | 'approval' | 'role' | 'eventId'
	>;
	const forbidden: readonly Forbidden[] = [];
	expect(forbidden).toEqual([]);
}

describe('pure-live Event operation client', () => {
	test('composes draft, propose, and commit behind the unchanged create result', async () => {
		const calls: RecordedCall[] = [];
		const client = createEventLiveClient({ manifest: manifest(), request: requester(calls) });
		noAuthorityInputSurface(client);

		expect(await client.read()).toEqual({
			kind: 'success',
			data: { kind: 'no_event', eventSetVersion: 1 },
			correlationId
		});
		const first = await client.create(eventInput, { idempotencyKey: 'event-create-1' });
		const replay = await client.create(eventInput, { idempotencyKey: 'event-create-1' });
		expect(first).toEqual({
			kind: 'success',
			data: {
				eventSetVersion: 2,
				event: safeDiff.after
			},
			receipt: {
				id: id(6),
				operationName: CHANGESET_REVIEW_OPERATIONS.commit.name,
				operationVersion: CHANGESET_REVIEW_OPERATIONS.commit.version
			},
			correlationId
		});
		expect(replay).toEqual(first);

		expect(calls.map((call) => call.path)).toEqual([
			EXPECTED_OPERATIONS.read.path,
			EXPECTED_OPERATIONS.draft.path,
			EXPECTED_OPERATIONS.propose.path,
			EXPECTED_OPERATIONS.commit.path,
			EXPECTED_OPERATIONS.draft.path,
			EXPECTED_OPERATIONS.propose.path,
			EXPECTED_OPERATIONS.commit.path
		]);
		const firstKeys = calls.slice(1, 4).map((call) => call.idempotencyKey);
		const replayKeys = calls.slice(4, 7).map((call) => call.idempotencyKey);
		expect(replayKeys).toEqual(firstKeys);
		expect(new Set(firstKeys).size).toBe(3);
		expect(firstKeys).toEqual([
			expect.stringMatching(/^je\.event-create\.draft\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.event-create\.propose\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.event-create\.commit\.[a-f0-9]{64}$/)
		]);
		expect(calls[1]?.body).toEqual({
			name: eventInput.name,
			timezone: eventInput.timezone,
			startDate: eventInput.startDate,
			endDate: eventInput.endDate
		});
		expect(calls[2]?.body).toEqual({
			changesetId,
			revisionId,
			revisionDigest,
			expectedHeadVersion: 1
		});
		expect(calls[3]?.body).toEqual({
			changesetId,
			revisionId,
			revisionDigest,
			expectedHeadVersion: 2
		});
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('event-create-1');
		expect(calls.some((call) => call.path === '/api/events')).toBe(false);
	});

	test('preserves draft and commit outcomes and transport failures as separate branches', async () => {
		const draftOutcome = eventCreateDraftOperationResultSchema.parse({
			kind: 'outcome',
			terminal: false,
			correlationId,
			outcome: {
				class: 'stale_revision',
				kind: 'event.creation_changed',
				retryable: false,
				subjects: [],
				detail: null,
				detailSchemaVersion: 1
			}
		});
		if (draftOutcome.kind !== 'outcome') throw new TypeError('expected_draft_outcome');
		const draftCalls: RecordedCall[] = [];
		const draftClient = createEventLiveClient({
			manifest: manifest(),
			request: requester(draftCalls, {
				read: async () => ({
					kind: 'error',
					error: { code: 'network_unavailable', retryable: true }
				}),
				draft: async (input) => {
					draftCalls.push(input);
					return { kind: 'success', data: draftOutcome };
				}
			})
		});
		expect(await draftClient.read()).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
		expect(await draftClient.create(eventInput, { idempotencyKey: 'draft-outcome' }))
			.toEqual({
				kind: 'outcome',
				outcome: draftOutcome.outcome,
				terminal: false,
				correlationId
			});
		expect(draftCalls).toHaveLength(1);

		const commitOutcome = committedChangesetOperationResultSchema.parse({
			kind: 'outcome',
			terminal: false,
			correlationId,
			outcome: {
				class: 'stale_revision',
				kind: 'changeset.lifecycle_refused',
				retryable: false,
				subjects: [],
				detail: null,
				detailSchemaVersion: 1
			}
		});
		if (commitOutcome.kind !== 'outcome') throw new TypeError('expected_commit_outcome');
		const commitCalls: RecordedCall[] = [];
		const commitClient = createEventLiveClient({
			manifest: manifest(),
			request: requester(commitCalls, {
				changesetPayloads: {
					[EXPECTED_OPERATIONS.propose.path]: proposeSuccess(),
					[EXPECTED_OPERATIONS.commit.path]: commitOutcome
				}
			})
		});
		expect(await commitClient.create(eventInput, { idempotencyKey: 'commit-outcome' }))
			.toEqual({
				kind: 'outcome',
				outcome: commitOutcome.outcome,
				terminal: false,
				correlationId
			});
	});

	test('preflights every mutation binding and never expects legacy event.create', async () => {
		for (const [candidate, reason] of [
			[{}, 'invalid_operation_manifest'],
			[manifest(['read', 'draft', 'commit']), 'operation_not_registered'],
			[manifest(['read', 'propose', 'commit']), 'operation_not_registered']
		] as const satisfies readonly [unknown, EventLiveUnavailableReason][]) {
			let requested = false;
			const client = createEventLiveClient({
				manifest: candidate,
				request: {
					read: async () => {
						requested = true;
						return { kind: 'success', data: readSuccess };
					},
					draft: async () => {
						requested = true;
						return { kind: 'success', data: draftSuccess() };
					},
					changeset: async () => {
						requested = true;
						return { kind: 'success', data: proposeSuccess() };
					}
				}
			});
			expect(await client.create(eventInput, { idempotencyKey: 'closed' }))
				.toEqual({ kind: 'unavailable', reason });
			expect(requested).toBe(false);
		}
	});

	test('fails the whole workflow closed when any exact manifest schema identity drifts', async () => {
		const cases = [
			manifest(undefined, {
				draft: {
					inputSchema: {
						...EVENT_OPERATION_SCHEMA_REFS.createDraft.inputSchema,
						digestSha256: digest('0')
					}
				}
			}),
			manifest(undefined, {
				propose: {
					inputSchema: {
						...CHANGESET_REVIEW_OPERATIONS.propose.inputSchema,
						digestSha256: digest('1')
					}
				}
			}),
			manifest(undefined, {
				commit: {
					enabledBindings: [{
						...operation('commit').enabledBindings[0]!,
						resultSchema: {
							...CHANGESET_REVIEW_OPERATIONS.commit.resultSchema,
							version: 2
						}
					}]
				}
			})
		];
		for (const candidate of cases) {
			const calls: RecordedCall[] = [];
			const client = createEventLiveClient({ manifest: candidate, request: requester(calls) });
			expect(await client.create(eventInput, { idempotencyKey: 'schema-closed' }))
				.toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
			expect(calls).toHaveLength(0);
		}
	});

	test('rejects selector, event diff, and commit-receipt cross-binding drift', async () => {
		const mismatchCases: readonly {
			readonly draft?: EventLiveRequester['draft'];
			readonly changesetPayloads?: Readonly<Record<string, unknown>>;
			readonly expectedCalls: number;
		}[] = [
			{
				draft: async () => ({
					kind: 'success',
					data: draftSuccess({
						eventSetVersion: { before: 2, after: 3 }
					})
				}),
				expectedCalls: 1
			},
			{
				changesetPayloads: {
					[EXPECTED_OPERATIONS.propose.path]: proposeSuccess({
						operations: [{
							...changesetDiff().operations[0],
							safeDiff: {
								...safeDiff,
								after: { ...safeDiff.after, name: 'A different event' }
							}
						}]
					}),
					[EXPECTED_OPERATIONS.commit.path]: commitSuccess()
				},
				expectedCalls: 2
			},
			{
				changesetPayloads: {
					[EXPECTED_OPERATIONS.propose.path]: proposeSuccess(),
					[EXPECTED_OPERATIONS.commit.path]: commitSuccess({ revisionId: id(99) })
				},
				expectedCalls: 3
			},
			{
				changesetPayloads: {
					[EXPECTED_OPERATIONS.propose.path]: proposeSuccess(),
					[EXPECTED_OPERATIONS.commit.path]: {
						...commitSuccess(),
						receipt: {
							id: id(6),
							operationName: 'changeset.propose',
							operationVersion: 1
						}
					}
				},
				expectedCalls: 3
			}
		];
		for (const mismatch of mismatchCases) {
			const calls: RecordedCall[] = [];
			const base = requester(calls, {
				...(mismatch.changesetPayloads
					? { changesetPayloads: mismatch.changesetPayloads }
					: {})
			});
			const request: EventLiveRequester = mismatch.draft
				? {
						...base,
						draft: async (input) => {
							calls.push(input);
							return mismatch.draft!(input);
						}
					}
				: base;
			const client = createEventLiveClient({ manifest: manifest(), request });
			expect(await client.create(eventInput, { idempotencyKey: 'cross-bound' }))
				.toEqual({
					kind: 'transport_error',
					error: { code: 'invalid_contract', retryable: true }
				});
			expect(calls).toHaveLength(mismatch.expectedCalls);
		}
	});
});
