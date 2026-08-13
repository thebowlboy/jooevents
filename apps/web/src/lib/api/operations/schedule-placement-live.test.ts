import { describe, expect, test } from 'bun:test';
import {
	committedChangesetOperationResultSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
	schedulePlacementDraftOperationResultSchema,
	schedulePlacementReadResultSchema
} from '@jooevents/contracts/schedule-placement';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createSchedulePlacementLivePort,
	SCHEDULE_PLACEMENT_LIVE_OPERATIONS,
	type SchedulePlacementRequester
} from './schedule-placement-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });
const roomId = id(3);
const sessionId = id(4);
const occurrenceId = id(5);
const changesetId = id(6);
const revisionId = id(7);
const revisionDigest = digest('a');

const placeRequest = Object.freeze({
	action: 'place' as const,
	expectedScheduleVersion: 4,
	sessionId,
	roomId,
	startAt: '2026-09-01T09:00:00.000Z',
	endAt: '2026-09-01T09:45:00.000Z'
});

const occurrence = Object.freeze({
	id: occurrenceId,
	sessionId,
	roomId,
	startAt: placeRequest.startAt,
	endAt: placeRequest.endAt,
	version: 1
});

const moveRequest = Object.freeze({
	action: 'move' as const,
	expectedScheduleVersion: 4,
	occurrenceId,
	expectedOccurrenceVersion: 2,
	roomId,
	startAt: '2026-09-01T10:00:00.000Z',
	endAt: '2026-09-01T10:45:00.000Z'
});

function placementPlan() {
	return {
		input: {
			...placeRequest,
			scope,
			occurrenceId
		},
		before: null,
		after: occurrence,
		scheduleVersion: { before: 4, after: 5 },
		roomQueryGuard: {
			id: `schedule_room_query:${scope.eventId}:${roomId}`,
			version: 4,
			digestSha256: digest('b')
		}
	};
}

function movePlan() {
	return {
		input: { ...moveRequest, scope },
		before: { ...occurrence, version: 2 },
		after: {
			...occurrence,
			startAt: moveRequest.startAt,
			endAt: moveRequest.endAt,
			version: 3
		},
		scheduleVersion: { before: 4, after: 5 },
		roomQueryGuard: {
			id: `schedule_room_query:${scope.eventId}:${roomId}`,
			version: 4,
			digestSha256: digest('d')
		}
	};
}

const approvalPolicy = Object.freeze({
	reference: { key: 'policy.schedule.placement.bounded', version: 1 },
	definitionDigestSha256: digest('c'),
	requirement: 'none' as const
});

function draftData(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		action: 'place',
		changesetId,
		headVersion: 1,
		status: 'draft',
		revision: { id: revisionId, number: 1, digestSha256: revisionDigest },
		riskTier: 'normal',
		approvalPolicy,
		safeDiff: placementPlan(),
		...overrides
	};
}

function proposedDiff(overrides: Record<string, unknown> = {}) {
	return {
		changesetId,
		headVersion: 2,
		status: 'proposed',
		revisionId,
		revisionNumber: 1,
		revisionDigest,
		riskTier: 'normal',
		approvalPolicy,
		operations: [{
			kind: 'schedule.placement.mutate',
			version: 1,
			riskTier: 'normal',
			dependencyGroup: 'schedule_placement',
			safeDiff: placementPlan(),
			consequences: ['schedule_occurrence_changed']
		}],
		...overrides
	};
}

function moveDraftData() {
	return {
		...draftData(),
		action: 'move',
		safeDiff: movePlan()
	};
}

function moveProposedDiff() {
	return {
		...proposedDiff(),
		operations: [{
			...proposedDiff().operations[0],
			safeDiff: movePlan()
		}]
	};
}

const receipt = (value: number, operationName: string) => ({
	id: id(value), operationName, operationVersion: 1
});

type OperationKey = 'snapshot' | 'draft' | 'propose' | 'commit';

const pathByOperation: Readonly<Record<OperationKey, string>> = Object.freeze({
	snapshot: SCHEDULE_PLACEMENT_LIVE_OPERATIONS.snapshot.path,
	draft: SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.path,
	propose: '/api/changesets/proposals',
	commit: '/api/changesets/commits'
});

function expected(key: OperationKey): ExpectedOperatorHttpOperation {
	if (key === 'snapshot') {
		return {
			...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.snapshot,
			...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead
		};
	}
	if (key === 'draft') {
		return {
			...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft,
			...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placementDraft
		};
	}
	return CHANGESET_REVIEW_OPERATIONS[key];
}

function manifestEntry(
	key: OperationKey,
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	const operation = expected(key);
	const effect = operation.effect as OperationEffect;
	return {
		name: operation.name,
		version: operation.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${operation.name}.`,
		effect,
		maxRisk: effect === 'commit' ? 'normal' : 'low',
		autonomy: {
			policy: { key: `autonomy.${operation.name}`, version: 1 },
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
		inputSchema: operation.inputSchema,
		idempotency: operation.idempotencyRequired
			? {
					required: true,
					keySource: { key: 'idempotency.operator-header', version: 1 },
					credentialVerifierProfile: { key: 'credential.schedule', version: 1 },
					requestHashProfile: { key: 'request-hash.schedule', version: 1 }
			  }
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${operation.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: operation.method,
			path: pathByOperation[key],
			input: operation.input,
			resultSchema: operation.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(input: {
	readonly omit?: readonly OperationKey[];
	readonly replace?: Partial<Record<OperationKey, SafeOperationManifestEntry>>;
} = {}): SafeOperationManifest {
	const keys: readonly OperationKey[] = ['snapshot', 'draft', 'propose', 'commit'];
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys
			.filter((key) => !input.omit?.includes(key))
			.map((key) => input.replace?.[key] ?? manifestEntry(key))
	});
}

function validPayloads() {
	return {
		[pathByOperation.draft]: schedulePlacementDraftOperationResultSchema.parse({
			kind: 'success',
			data: draftData(),
			receipt: receipt(100, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.name),
			correlationId
		}),
		[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
			kind: 'success',
			data: { schemaVersion: 1, action: 'propose', diff: proposedDiff() },
			receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
			correlationId
		}),
		[pathByOperation.commit]: committedChangesetOperationResultSchema.parse({
			kind: 'success',
			data: {
				schemaVersion: 1,
				action: 'commit',
				changesetId,
				expectedHeadVersion: 2,
				committedHeadVersion: 3,
				revisionId,
				revisionDigest
			},
			receipt: receipt(102, CHANGESET_REVIEW_OPERATIONS.commit.name),
			correlationId
		})
	};
}

function requesterFor(
	payloads: Readonly<Record<string, unknown>>,
	calls: SchedulePlacementRequestInput[]
): SchedulePlacementRequester {
	return async (input) => {
		calls.push(input);
		return { kind: 'success', data: payloads[input.path] };
	};
}

interface SchedulePlacementRequestInput {
	readonly path: string;
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

describe('pure-live Schedule placement operation port', () => {
	test('reads a canonical UTC range and applies place through exact draft, propose, and commit', async () => {
		const range = {
			startAt: '2026-09-01T00:00:00.000Z',
			endAt: '2026-09-02T00:00:00.000Z',
			limit: 20
		};
		const readPath = `${pathByOperation.snapshot}?${new URLSearchParams({
			startAt: range.startAt,
			endAt: range.endAt,
			limit: String(range.limit)
		}).toString()}`;
		const calls: SchedulePlacementRequestInput[] = [];
		const payloads = {
			...validPayloads(),
			[readPath]: schedulePlacementReadResultSchema.parse({
				kind: 'success',
				data: { schemaVersion: 1, scope, scheduleVersion: 4, occurrences: [occurrence] },
				correlationId
			})
		};
		const port = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor(payloads, calls)
		});

		expect(port.source).toEqual({ kind: 'live' });
		expect(await port.readPlacements(range)).toMatchObject({
			kind: 'success',
			data: {
				scheduleVersion: 4,
				timeBasis: { kind: 'utc_instants_only', eventTimezone: null },
				occurrences: [{ startAtUtc: occurrence.startAt, endAtUtc: occurrence.endAt }]
			}
		});
		expect(await port.placeOrMove(placeRequest, 'schedule-place-1')).toMatchObject({
			kind: 'success',
			data: {
				action: 'place',
				scheduleVersion: 5,
				changesetHead: { proposedVersion: 2, committedVersion: 3 },
				occurrence: { id: occurrenceId, startAtUtc: placeRequest.startAt }
			},
			receipt: { operationName: CHANGESET_REVIEW_OPERATIONS.commit.name }
		});

		expect(calls.map((call) => call.path)).toEqual([
			readPath,
			pathByOperation.draft,
			pathByOperation.propose,
			pathByOperation.commit
		]);
		const stageKeys = calls.slice(1).map((call) => call.idempotencyKey);
		expect(stageKeys).toEqual([
			expect.stringMatching(/^je\.schedule\.placement\.draft\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.schedule\.placement\.propose\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.schedule\.placement\.commit\.[a-f0-9]{64}$/)
		]);
		expect(new Set(stageKeys.map((key) => key?.split('.').at(-1))).size).toBe(1);
		expect(calls[1]?.body).toEqual(placeRequest);
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('schedule-place-1');
		expect(JSON.stringify(calls[1]?.body)).not.toContain('workspaceId');
	});

	test('applies a move without accepting a browser-supplied Session identity', async () => {
		const calls: SchedulePlacementRequestInput[] = [];
		const port = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.draft]: schedulePlacementDraftOperationResultSchema.parse({
					kind: 'success',
					data: moveDraftData(),
					receipt: receipt(100, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.name),
					correlationId
				}),
				[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
					kind: 'success',
					data: { schemaVersion: 1, action: 'propose', diff: moveProposedDiff() },
					receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
					correlationId
				})
			}, calls)
		});

		expect(await port.placeOrMove(moveRequest, 'schedule-move-1')).toMatchObject({
			kind: 'success',
			data: {
				action: 'move',
				occurrence: {
					id: occurrenceId,
					sessionId,
					startAtUtc: moveRequest.startAt,
					version: 3
				}
			}
		});
		expect(calls[0]?.body).toEqual(moveRequest);
		expect(JSON.stringify(calls[0]?.body)).not.toContain('sessionId');
	});

	test('fails closed before requests when exact paths, schemas, or lifecycle operations are absent', async () => {
		let requests = 0;
		const request: SchedulePlacementRequester = async () => {
			requests += 1;
			return { kind: 'error', error: { code: 'unexpected', retryable: false } };
		};
		const snapshotOperation = expected('snapshot');
		const wrongPath = manifestEntry('snapshot', {
			enabledBindings: [{
				surface: 'operator_http',
				protocol: 'http',
				method: 'GET',
				path: '/api/events/current/schedule/placements-v2',
				input: 'query',
				resultSchema: snapshotOperation.resultSchema,
				browserResumption: { kind: 'none' }
			}]
		});
		const pathPort = createSchedulePlacementLivePort({
			manifest: manifest({ replace: { snapshot: wrongPath } }), request
		});
		expect(await pathPort.readPlacements({
			startAt: '2026-09-01T00:00:00.000Z',
			endAt: '2026-09-02T00:00:00.000Z',
			limit: 20
		})).toEqual({
			kind: 'unavailable', operation: 'snapshot', reason: 'operation_contract_mismatch'
		});

		const wrongSchema = manifestEntry('snapshot', {
			inputSchema: {
				...snapshotOperation.inputSchema,
				digestSha256: digest('e')
			}
		});
		const schemaPort = createSchedulePlacementLivePort({
			manifest: manifest({ replace: { snapshot: wrongSchema } }), request
		});
		expect(await schemaPort.readPlacements({
			startAt: '2026-09-01T00:00:00.000Z',
			endAt: '2026-09-02T00:00:00.000Z',
			limit: 20
		})).toEqual({
			kind: 'unavailable', operation: 'snapshot', reason: 'operation_contract_mismatch'
		});

		const proposeOperation = expected('propose');
		const wrongProposePath = manifestEntry('propose', {
			enabledBindings: [{
				surface: 'operator_http',
				protocol: 'http',
				method: 'POST',
				path: '/api/changesets/proposals-v2',
				input: 'body',
				resultSchema: proposeOperation.resultSchema,
				browserResumption: { kind: 'none' }
			}]
		});
		const lifecyclePathPort = createSchedulePlacementLivePort({
			manifest: manifest({ replace: { propose: wrongProposePath } }), request
		});
		expect(await lifecyclePathPort.placeOrMove(
			placeRequest,
			'schedule-place-wrong-propose-path'
		)).toEqual({
			kind: 'unavailable', operation: 'propose', reason: 'operation_contract_mismatch'
		});

		const noCommit = createSchedulePlacementLivePort({
			manifest: manifest({ omit: ['commit'] }), request
		});
		expect(await noCommit.placeOrMove(placeRequest, 'schedule-place-missing')).toEqual({
			kind: 'unavailable', operation: 'commit', reason: 'operation_not_registered'
		});
		expect(requests).toBe(0);
	});

	test('preserves a structured room-overlap refusal without trying later lifecycle stages', async () => {
		const calls: SchedulePlacementRequestInput[] = [];
		const refusal = schedulePlacementDraftOperationResultSchema.parse({
			kind: 'outcome',
			outcome: {
				class: 'conflict',
				kind: 'schedule_room_overlap',
				retryable: false,
				subjects: [{ type: 'schedule_occurrence', id: occurrenceId }],
				detail: {
					severity: 'block',
					roomId,
					requested: { startAt: placeRequest.startAt, endAt: placeRequest.endAt },
					conflicts: [{
						occurrenceId: id(50),
						startAt: placeRequest.startAt,
						endAt: placeRequest.endAt
					}]
				},
				detailSchemaVersion: 1
			},
			terminal: false,
			correlationId
		});
		const port = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({ [pathByOperation.draft]: refusal }, calls)
		});

		if (refusal.kind !== 'outcome') throw new TypeError('Expected an outcome fixture.');
		expect(await port.placeOrMove(placeRequest, 'schedule-overlap')).toEqual(refusal);
		expect(calls).toHaveLength(1);
	});

	test('rejects invalid requests and a server snapshot that exceeds the requested UTC range', async () => {
		const calls: SchedulePlacementRequestInput[] = [];
		const range = {
			startAt: '2026-09-01T00:00:00.000Z',
			endAt: '2026-09-02T00:00:00.000Z',
			limit: 1
		};
		const readPath = `${pathByOperation.snapshot}?${new URLSearchParams({
			startAt: range.startAt, endAt: range.endAt, limit: '1'
		}).toString()}`;
		const outside = { ...occurrence,
			startAt: '2026-09-03T09:00:00.000Z', endAt: '2026-09-03T09:45:00.000Z' };
		const port = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				[readPath]: schedulePlacementReadResultSchema.parse({
					kind: 'success',
					data: { schemaVersion: 1, scope, scheduleVersion: 4, occurrences: [outside] },
					correlationId
				})
			}, calls)
		});

		expect(await port.readPlacements(range)).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
		expect(await port.readPlacements({ ...range, limit: '1' } as never)).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(await port.placeOrMove(placeRequest, '')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(calls).toHaveLength(1);
	});

	test('validates draft receipts and reviewed Schedule diff identity before commit', async () => {
		const wrongReceiptPayloads = {
			...validPayloads(),
			[pathByOperation.draft]: schedulePlacementDraftOperationResultSchema.parse({
				kind: 'success',
				data: draftData(),
				receipt: receipt(100, 'schedule.some-other-draft'),
				correlationId
			})
		};
		const wrongReceipt = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor(wrongReceiptPayloads, [])
		});
		expect(await wrongReceipt.placeOrMove(placeRequest, 'wrong-draft-receipt')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});

		const originalPlan = placementPlan();
		const changedPlan = {
			...originalPlan,
			after: {
				...originalPlan.after,
				startAt: '2026-09-01T10:00:00.000Z',
				endAt: '2026-09-01T10:45:00.000Z'
			},
			input: {
				...originalPlan.input,
				startAt: '2026-09-01T10:00:00.000Z',
				endAt: '2026-09-01T10:45:00.000Z'
			}
		};
		const mismatchedDraft = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.draft]: schedulePlacementDraftOperationResultSchema.parse({
					kind: 'success',
					data: draftData({ safeDiff: changedPlan }),
					receipt: receipt(100, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.name),
					correlationId
				})
			}, [])
		});
		expect(await mismatchedDraft.placeOrMove(placeRequest, 'wrong-draft-plan')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});

		const inputMismatchPlan = placementPlan();
		const mismatchedInput = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.draft]: schedulePlacementDraftOperationResultSchema.parse({
					kind: 'success',
					data: draftData({
						safeDiff: {
							...inputMismatchPlan,
							input: { ...inputMismatchPlan.input, roomId: id(55) }
						}
					}),
					receipt: receipt(100, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.name),
					correlationId
				})
			}, [])
		});
		expect(await mismatchedInput.placeOrMove(placeRequest, 'wrong-draft-input')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});

		const wrongDiff = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
					kind: 'success',
					data: {
						schemaVersion: 1,
						action: 'propose',
						diff: proposedDiff({
							operations: [{
								...proposedDiff().operations[0],
								kind: 'schedule.break.mutate'
							}]
						})
					},
					receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
					correlationId
				})
			}, [])
		});
		expect(await wrongDiff.placeOrMove(placeRequest, 'wrong-proposed-diff')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('validates proposed and committed head advances plus the final commit receipt', async () => {
		const wrongHead = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
					kind: 'success',
					data: { schemaVersion: 1, action: 'propose', diff: proposedDiff({ headVersion: 3 }) },
					receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
					correlationId
				})
			}, [])
		});
		expect(await wrongHead.placeOrMove(placeRequest, 'wrong-proposed-head')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});

		const wrongCommitHead = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.commit]: committedChangesetOperationResultSchema.parse({
					kind: 'success',
					data: {
						schemaVersion: 1,
						action: 'commit',
						changesetId,
						expectedHeadVersion: 3,
						committedHeadVersion: 4,
						revisionId,
						revisionDigest
					},
					receipt: receipt(102, CHANGESET_REVIEW_OPERATIONS.commit.name),
					correlationId
				})
			}, [])
		});
		expect(await wrongCommitHead.placeOrMove(placeRequest, 'wrong-commit-head')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});

		const wrongCommitReceipt = createSchedulePlacementLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.commit]: committedChangesetOperationResultSchema.parse({
					kind: 'success',
					data: {
						schemaVersion: 1,
						action: 'commit',
						changesetId,
						expectedHeadVersion: 2,
						committedHeadVersion: 3,
						revisionId,
						revisionDigest
					},
					receipt: receipt(102, 'changeset.some-other-commit'),
					correlationId
				})
			}, [])
		});
		expect(await wrongCommitReceipt.placeOrMove(placeRequest, 'wrong-commit-receipt')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
	});
});
