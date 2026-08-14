import { describe, expect, test } from 'bun:test';
import {
	committedChangesetOperationResultSchema,
	ENGAGEMENT_OPERATION_SCHEMA_REFS,
	engagementChangeDraftOperationResultSchema,
	engagementSnapshotReadResultSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	type EngagementHeadDto,
	type OperationEffect,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { CHANGESET_REVIEW_OPERATIONS } from '../changesets/live';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createEngagementsLiveClient,
	ENGAGEMENTS_LIVE_OPERATIONS,
	type EngagementsLiveRequester
} from './engagements-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });
const sessionId = id(10);
const personId = id(20);
const submissionId = id(30);
const engagementId = id(40);
const changesetId = id(50);
const revisionId = id(51);
const revisionDigest = digest('f');

function invitedHead(): EngagementHeadDto {
	return {
		schemaVersion: 1,
		id: engagementId,
		scope,
		sessionId,
		personId,
		submissionId,
		seededByDecision: { version: 1, digestSha256: digest('a') },
		state: 'invited',
		invitedAt: '2026-08-13T10:00:00.000Z',
		respondBy: null,
		confirmation: null,
		cancellationRequest: null,
		cancelledAt: null,
		source: { kind: 'submission', id: submissionId, version: 1 },
		version: 1
	};
}

function confirmedHead(): EngagementHeadDto {
	return {
		...invitedHead(),
		state: 'confirmed',
		confirmation: {
			attribution: 'organizer_recorded',
			personId,
			recordedByUserId: id(90),
			confirmedAt: '2026-08-13T11:00:00.000Z'
		},
		version: 2
	};
}

const approvalPolicy = Object.freeze({
	reference: { key: 'policy.engagement.change.none', version: 1 },
	definitionDigestSha256: digest('b'),
	requirement: 'none' as const
});

function safeDiff(before: EngagementHeadDto = invitedHead()) {
	return { action: 'record_confirmation', before, after: confirmedHead() };
}

function draftData(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		action: 'record_confirmation',
		changesetId,
		headVersion: 1,
		status: 'draft',
		revision: { id: revisionId, number: 1, digestSha256: revisionDigest },
		riskTier: 'consequential',
		approvalPolicy,
		safeDiff: safeDiff(),
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
		riskTier: 'consequential',
		approvalPolicy,
		operations: [{
			kind: 'engagement.respond',
			version: 1,
			riskTier: 'consequential',
			dependencyGroup: 'engagement',
			safeDiff: safeDiff(),
			consequences: ['engagement_changed']
		}],
		...overrides
	};
}

const receipt = (value: number, operationName: string) => ({
	id: id(value), operationName, operationVersion: 1
});

type OperationKey = 'read' | 'draft' | 'propose' | 'commit';

const pathByOperation: Readonly<Record<OperationKey, string>> = Object.freeze({
	read: '/api/events/current/engagements',
	draft: '/api/events/current/engagements/drafts',
	propose: '/api/changesets/proposals',
	commit: '/api/changesets/commits'
});

function expected(key: OperationKey): ExpectedOperatorHttpOperation {
	if (key === 'read') {
		return {
			...ENGAGEMENTS_LIVE_OPERATIONS.read,
			effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false,
			...ENGAGEMENT_OPERATION_SCHEMA_REFS.snapshotRead
		};
	}
	if (key === 'draft') {
		return {
			...ENGAGEMENTS_LIVE_OPERATIONS.draft,
			effect: 'draft', method: 'POST', input: 'body', idempotencyRequired: true,
			...ENGAGEMENT_OPERATION_SCHEMA_REFS.changeDraft
		};
	}
	return CHANGESET_REVIEW_OPERATIONS[key];
}

function manifestEntry(key: OperationKey): SafeOperationManifestEntry {
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
					requestHashProfile: { key: 'request-hash.engagement', version: 1 }
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
		}]
	};
}

function manifest(input: { readonly omit?: readonly OperationKey[] } = {}): SafeOperationManifest {
	const keys: readonly OperationKey[] = ['read', 'draft', 'propose', 'commit'];
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys
			.filter((key) => !input.omit?.includes(key))
			.map((key) => manifestEntry(key))
	});
}

function validPayloads(overrides: Partial<Record<OperationKey, unknown>> = {}) {
	return {
		[pathByOperation.read]: overrides.read ?? engagementSnapshotReadResultSchema.parse({
			kind: 'success',
			data: { schemaVersion: 1, scope, engagements: [invitedHead()] },
			correlationId
		}),
		[pathByOperation.draft]: overrides.draft ?? engagementChangeDraftOperationResultSchema.parse({
			kind: 'success',
			data: draftData(),
			receipt: receipt(100, ENGAGEMENTS_LIVE_OPERATIONS.draft.name),
			correlationId
		}),
		[pathByOperation.propose]: overrides.propose ?? proposedChangesetOperationResultSchema.parse({
			kind: 'success',
			data: { schemaVersion: 1, action: 'propose', diff: proposedDiff() },
			receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
			correlationId
		}),
		[pathByOperation.commit]: overrides.commit ?? committedChangesetOperationResultSchema.parse({
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
): EngagementsLiveRequester {
	return async (input) => {
		calls.push(input);
		return { kind: 'success', data: payloads[input.path] };
	};
}

const respondInput = Object.freeze({
	action: 'record_confirmation' as const,
	engagementId,
	expectedEngagementVersion: 1,
	attribution: 'organizer_recorded' as const
});

describe('pure-live engagement operation client', () => {
	test('reads the engagement snapshot through the exact manifest binding', async () => {
		const calls: RecordedRequest[] = [];
		const client = createEngagementsLiveClient({
			manifest: manifest(),
			request: requesterFor(validPayloads(), calls)
		});

		const read = await client.readSnapshot();
		expect(read).toMatchObject({
			kind: 'success',
			data: { engagements: [{ id: engagementId, state: 'invited' }] },
			correlationId
		});
		expect(calls.map((call) => call.path)).toEqual([pathByOperation.read]);
	});

	test('carries one response act through exact draft, propose, and commit', async () => {
		const calls: RecordedRequest[] = [];
		const client = createEngagementsLiveClient({
			manifest: manifest(),
			request: requesterFor(validPayloads(), calls)
		});

		const result = await client.respond(respondInput, 'respond-1');
		expect(result).toMatchObject({
			kind: 'success',
			data: {
				changesetId,
				revisionId,
				revisionDigest,
				committedHeadVersion: 3,
				safeDiff: { action: 'record_confirmation' }
			},
			receipt: { operationName: CHANGESET_REVIEW_OPERATIONS.commit.name },
			correlationId
		});

		expect(calls.map((call) => call.path)).toEqual([
			pathByOperation.draft,
			pathByOperation.propose,
			pathByOperation.commit
		]);
		// One workflow anchor, one derived key per stage — never the raw key.
		const anchors = calls.map((call) => call.idempotencyKey?.split('.').at(-1));
		expect(new Set(anchors).size).toBe(1);
		expect(calls[0]?.idempotencyKey).toStartWith('je.engagement.respond.draft.');
		expect(calls[1]?.idempotencyKey).toStartWith('je.engagement.respond.propose.');
		expect(calls[2]?.idempotencyKey).toStartWith('je.engagement.respond.commit.');
		expect(calls[1]?.body).toMatchObject({ changesetId, expectedHeadVersion: 1 });
		expect(calls[2]?.body).toMatchObject({ changesetId, expectedHeadVersion: 2 });
	});

	test('refuses a draft that answers about a different engagement', async () => {
		const otherBefore = { ...invitedHead(), id: id(41) };
		const client = createEngagementsLiveClient({
			manifest: manifest(),
			request: requesterFor(validPayloads({
				draft: engagementChangeDraftOperationResultSchema.parse({
					kind: 'success',
					data: draftData({
						safeDiff: {
							action: 'record_confirmation',
							before: otherBefore,
							after: { ...confirmedHead(), id: id(41) }
						}
					}),
					receipt: receipt(100, ENGAGEMENTS_LIVE_OPERATIONS.draft.name),
					correlationId
				})
			}), [])
		});

		expect(await client.respond(respondInput, 'respond-2')).toEqual({
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('passes a terminal draft refusal through with its receipt', async () => {
		const client = createEngagementsLiveClient({
			manifest: manifest(),
			request: requesterFor(validPayloads({
				draft: engagementChangeDraftOperationResultSchema.parse({
					kind: 'outcome',
					outcome: {
						class: 'stale_revision',
						kind: 'engagement.changed',
						retryable: false,
						subjects: [],
						detail: { code: 'stale_engagement', engagementId },
						detailSchemaVersion: 1
					},
					terminal: true,
					receipt: receipt(100, ENGAGEMENTS_LIVE_OPERATIONS.draft.name),
					correlationId
				})
			}), [])
		});

		expect(await client.respond(respondInput, 'respond-3')).toMatchObject({
			kind: 'outcome',
			outcome: { kind: 'engagement.changed' },
			terminal: true,
			receipt: { operationName: ENGAGEMENTS_LIVE_OPERATIONS.draft.name }
		});
	});

	test('states which stage is unavailable when the manifest lacks it', async () => {
		const client = createEngagementsLiveClient({
			manifest: manifest({ omit: ['draft'] }),
			request: requesterFor(validPayloads(), [])
		});
		expect(await client.respond(respondInput, 'respond-4')).toEqual({
			kind: 'unavailable',
			operation: 'draft',
			reason: 'operation_not_registered'
		});
	});
});
