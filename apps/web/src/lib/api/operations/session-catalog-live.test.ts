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
	SESSION_OPERATION_SCHEMA_REFS,
	sessionCatalogReadResultSchema,
	sessionDraftOperationResultSchema,
	type SessionHeadDto
} from '@jooevents/contracts/sessions';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createSessionCatalogLivePort,
	SESSION_CATALOG_LIVE_OPERATIONS,
	type SessionCatalogRequester
} from './session-catalog-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });
const changesetId = id(30);
const revisionId = id(31);
const revisionDigest = digest('f');

function head(value: number, overrides: Partial<SessionHeadDto> = {}): SessionHeadDto {
	return {
		schemaVersion: 1,
		scope,
		id: id(value),
		title: 'Opening keynote',
		plannedDurationMinutes: 45,
		lifecycle: 'programmed',
		programTarget: {
			setVersion: 3,
			setDigestSha256: digest('b'),
			format: { kind: 'format', id: id(10), name: 'Talk', status: 'active', version: 1 },
			track: { kind: 'track', id: id(11), name: 'Product', accent: 'sea', status: 'active', version: 1 }
		},
		roster: { version: 1, digestSha256: digest('c'), participants: [] },
		version: 1,
		digestSha256: digest('d'),
		createdByUserId: id(90),
		createdAt: '2026-08-01T09:00:00.000Z',
		updatedByUserId: id(90),
		updatedAt: '2026-08-01T09:00:00.000Z',
		...overrides
	};
}

function catalogData() {
	return {
		schemaVersion: 1,
		scope,
		version: 7,
		digestSha256: digest('e'),
		sessions: [head(20), head(21, { id: id(21), lifecycle: 'collecting', plannedDurationMinutes: 30 })]
	};
}

const createRequest = Object.freeze({
	action: 'create' as const,
	expectedCatalogVersion: 7,
	expectedCatalogDigestSha256: digest('e'),
	title: 'New session',
	plannedDurationMinutes: 30,
	lifecycle: 'collecting' as const,
	formatId: id(10),
	trackId: id(11)
});

const createdHead = head(40, {
	id: id(40),
	title: 'New session',
	plannedDurationMinutes: 30,
	lifecycle: 'collecting'
});

const approvalPolicy = Object.freeze({
	reference: { key: 'policy.session.change.bounded', version: 1 },
	definitionDigestSha256: digest('a'),
	requirement: 'none' as const
});

function createSafeDiff() {
	return { action: 'create', before: null, after: createdHead };
}

function draftData(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		action: 'create',
		changesetId,
		headVersion: 1,
		status: 'draft',
		revision: { id: revisionId, number: 1, digestSha256: revisionDigest },
		riskTier: 'normal',
		approvalPolicy,
		safeDiff: createSafeDiff(),
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
			kind: 'session.mutate',
			version: 1,
			riskTier: 'normal',
			dependencyGroup: 'session',
			safeDiff: createSafeDiff(),
			consequences: ['session_changed']
		}],
		...overrides
	};
}

const receipt = (value: number, operationName: string) => ({
	id: id(value), operationName, operationVersion: 1
});

type OperationKey = 'catalog' | 'draft' | 'propose' | 'commit';

const pathByOperation: Readonly<Record<OperationKey, string>> = Object.freeze({
	catalog: SESSION_CATALOG_LIVE_OPERATIONS.catalog.path,
	draft: SESSION_CATALOG_LIVE_OPERATIONS.draft.path,
	propose: '/api/changesets/proposals',
	commit: '/api/changesets/commits'
});

function expected(key: OperationKey): ExpectedOperatorHttpOperation {
	if (key === 'catalog') {
		return {
			...SESSION_CATALOG_LIVE_OPERATIONS.catalog,
			...SESSION_OPERATION_SCHEMA_REFS.catalogRead
		};
	}
	if (key === 'draft') {
		return {
			...SESSION_CATALOG_LIVE_OPERATIONS.draft,
			...SESSION_OPERATION_SCHEMA_REFS.draft
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
					credentialVerifierProfile: { key: 'credential.session', version: 1 },
					requestHashProfile: { key: 'request-hash.session', version: 1 }
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
	const keys: readonly OperationKey[] = ['catalog', 'draft', 'propose', 'commit'];
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
		[pathByOperation.catalog]: sessionCatalogReadResultSchema.parse({
			kind: 'success',
			data: catalogData(),
			correlationId
		}),
		[pathByOperation.draft]: sessionDraftOperationResultSchema.parse({
			kind: 'success',
			data: draftData(),
			receipt: receipt(100, SESSION_CATALOG_LIVE_OPERATIONS.draft.name),
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

interface RecordedRequest {
	readonly path: string;
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

function requesterFor(
	payloads: Readonly<Record<string, unknown>>,
	calls: RecordedRequest[]
): SessionCatalogRequester {
	return async (input) => {
		calls.push(input);
		return { kind: 'success', data: payloads[input.path] };
	};
}

describe('pure-live Session catalog operation port', () => {
	test('reads the canonical catalog and applies create through exact draft, propose, and commit', async () => {
		const calls: RecordedRequest[] = [];
		const port = createSessionCatalogLivePort({
			manifest: manifest(),
			request: requesterFor(validPayloads(), calls)
		});

		expect(port.source).toEqual({ kind: 'live' });
		expect(await port.readCatalog()).toMatchObject({
			kind: 'success',
			data: {
				version: 7,
				digestSha256: digest('e'),
				sessions: [{ id: id(20) }, { id: id(21), lifecycle: 'collecting' }]
			},
			correlationId
		});

		const applied = await port.applyChange(createRequest, 'session-create-1');
		expect(applied).toMatchObject({
			kind: 'success',
			data: {
				action: 'create',
				selector: { changesetId, revisionId, revisionDigest },
				changesetHead: { proposedVersion: 2, committedVersion: 3 },
				session: { id: id(40), title: 'New session', lifecycle: 'collecting' }
			},
			receipt: { operationName: CHANGESET_REVIEW_OPERATIONS.commit.name }
		});
		if (applied.kind !== 'success') throw new TypeError('Expected a committed change.');
		expect(Object.isFrozen(applied.data.session)).toBe(true);

		expect(calls.map((call) => call.path)).toEqual([
			pathByOperation.catalog,
			pathByOperation.draft,
			pathByOperation.propose,
			pathByOperation.commit
		]);
		const stageKeys = calls.slice(1).map((call) => call.idempotencyKey);
		expect(stageKeys).toEqual([
			expect.stringMatching(/^je\.session\.change\.draft\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.session\.change\.propose\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.session\.change\.commit\.[a-f0-9]{64}$/)
		]);
		expect(new Set(stageKeys.map((key) => key?.split('.').at(-1))).size).toBe(1);
		expect(calls[1]?.body).toEqual(createRequest);
		expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('session-create-1');
	});

	test('refuses a backwards transition at the executable schema before any request', async () => {
		let requests = 0;
		const port = createSessionCatalogLivePort({
			manifest: manifest(),
			request: async () => {
				requests += 1;
				return { kind: 'error', error: { code: 'unexpected', retryable: false } };
			}
		});
		expect(await port.applyChange({
			action: 'transition',
			expectedCatalogVersion: 7,
			expectedCatalogDigestSha256: digest('e'),
			sessionId: id(21),
			expectedSessionVersion: 1,
			expectedSessionDigestSha256: digest('d'),
			to: 'draft'
		} as never, 'session-backwards')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_request', retryable: false }
		});
		expect(requests).toBe(0);
	});

	test('fails closed before requests when exact paths, schemas, or lifecycle operations are absent', async () => {
		let requests = 0;
		const request: SessionCatalogRequester = async () => {
			requests += 1;
			return { kind: 'error', error: { code: 'unexpected', retryable: false } };
		};
		const catalogOperation = expected('catalog');
		const wrongPath = manifestEntry('catalog', {
			enabledBindings: [{
				surface: 'operator_http',
				protocol: 'http',
				method: 'GET',
				path: '/api/events/current/sessions-v2',
				input: 'query',
				resultSchema: catalogOperation.resultSchema,
				browserResumption: { kind: 'none' }
			}]
		});
		const pathPort = createSessionCatalogLivePort({
			manifest: manifest({ replace: { catalog: wrongPath } }), request
		});
		expect(await pathPort.readCatalog()).toEqual({
			kind: 'unavailable', operation: 'catalog', reason: 'operation_contract_mismatch'
		});

		const draftOperation = expected('draft');
		const wrongSchema = manifestEntry('draft', {
			inputSchema: { ...draftOperation.inputSchema, digestSha256: digest('9') }
		});
		const schemaPort = createSessionCatalogLivePort({
			manifest: manifest({ replace: { draft: wrongSchema } }), request
		});
		expect(await schemaPort.applyChange(createRequest, 'session-wrong-schema')).toEqual({
			kind: 'unavailable', operation: 'draft', reason: 'operation_contract_mismatch'
		});

		const noCommit = createSessionCatalogLivePort({
			manifest: manifest({ omit: ['commit'] }), request
		});
		expect(await noCommit.applyChange(createRequest, 'session-missing-commit')).toEqual({
			kind: 'unavailable', operation: 'commit', reason: 'operation_not_registered'
		});
		expect(requests).toBe(0);
	});

	test('preserves a structured stale-session refusal without trying later lifecycle stages', async () => {
		const calls: RecordedRequest[] = [];
		const refusal = sessionDraftOperationResultSchema.parse({
			kind: 'outcome',
			outcome: {
				class: 'stale_revision',
				kind: 'session.changed',
				retryable: false,
				subjects: [{ type: 'session', id: id(21) }],
				detail: { code: 'stale_catalog', action: 'create', sessionId: id(40) },
				detailSchemaVersion: 1
			},
			terminal: false,
			correlationId
		});
		const port = createSessionCatalogLivePort({
			manifest: manifest(),
			request: requesterFor({ [pathByOperation.draft]: refusal }, calls)
		});

		if (refusal.kind !== 'outcome') throw new TypeError('Expected an outcome fixture.');
		expect(await port.applyChange(createRequest, 'session-stale')).toEqual(refusal);
		expect(calls).toHaveLength(1);
	});

	test('validates the draft receipt and the reviewed Session diff identity before commit', async () => {
		const wrongReceipt = createSessionCatalogLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.draft]: sessionDraftOperationResultSchema.parse({
					kind: 'success',
					data: draftData(),
					receipt: receipt(100, 'session.some-other-draft'),
					correlationId
				})
			}, [])
		});
		expect(await wrongReceipt.applyChange(createRequest, 'wrong-draft-receipt')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});

		const mismatchedDraft = createSessionCatalogLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.draft]: sessionDraftOperationResultSchema.parse({
					kind: 'success',
					data: draftData({
						safeDiff: {
							action: 'create',
							before: null,
							after: { ...createdHead, title: 'A different talk' }
						}
					}),
					receipt: receipt(100, SESSION_CATALOG_LIVE_OPERATIONS.draft.name),
					correlationId
				})
			}, [])
		});
		expect(await mismatchedDraft.applyChange(createRequest, 'wrong-draft-title')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});

		const wrongProposedDiff = createSessionCatalogLivePort({
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
								kind: 'schedule.placement.mutate',
								dependencyGroup: 'schedule_placement'
							}]
						})
					},
					receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
					correlationId
				})
			}, [])
		});
		expect(await wrongProposedDiff.applyChange(createRequest, 'wrong-proposed-diff')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('applies a forward transition and validates the before image against the request guards', async () => {
		const before = head(21, { id: id(21), lifecycle: 'collecting', plannedDurationMinutes: 30 });
		const after = { ...before, lifecycle: 'programmed' as const, version: 2 };
		const transitionRequest = {
			action: 'transition' as const,
			expectedCatalogVersion: 7,
			expectedCatalogDigestSha256: digest('e'),
			sessionId: id(21),
			expectedSessionVersion: 1,
			expectedSessionDigestSha256: digest('d'),
			to: 'programmed' as const
		};
		const transitionDiff = { action: 'transition', before, after };
		const calls: RecordedRequest[] = [];
		const port = createSessionCatalogLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.draft]: sessionDraftOperationResultSchema.parse({
					kind: 'success',
					data: draftData({ action: 'transition', safeDiff: transitionDiff }),
					receipt: receipt(100, SESSION_CATALOG_LIVE_OPERATIONS.draft.name),
					correlationId
				}),
				[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
					kind: 'success',
					data: {
						schemaVersion: 1,
						action: 'propose',
						diff: proposedDiff({
							operations: [{ ...proposedDiff().operations[0], safeDiff: transitionDiff }]
						})
					},
					receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
					correlationId
				})
			}, calls)
		});

		expect(await port.applyChange(transitionRequest, 'session-transition-1')).toMatchObject({
			kind: 'success',
			data: {
				action: 'transition',
				session: { id: id(21), lifecycle: 'programmed', version: 2 }
			}
		});
		expect(calls[0]?.body).toEqual(transitionRequest);

		// A draft whose before image does not match the request guards is refused.
		const mismatched = createSessionCatalogLivePort({
			manifest: manifest(),
			request: requesterFor({
				...validPayloads(),
				[pathByOperation.draft]: sessionDraftOperationResultSchema.parse({
					kind: 'success',
					data: draftData({
						action: 'transition',
						safeDiff: {
							action: 'transition',
							before: { ...before, version: 4, digestSha256: digest('9') },
							after: { ...after, version: 5 }
						}
					}),
					receipt: receipt(100, SESSION_CATALOG_LIVE_OPERATIONS.draft.name),
					correlationId
				})
			}, [])
		});
		expect(await mismatched.applyChange(transitionRequest, 'wrong-before-image')).toEqual({
			kind: 'transport_error', error: { code: 'invalid_contract', retryable: true }
		});
	});
});
