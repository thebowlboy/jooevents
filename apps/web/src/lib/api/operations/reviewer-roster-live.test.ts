import { describe, expect, test } from 'bun:test';
import { safeOperationManifestSchema, type OperationEffect, type SafeOperationManifestEntry } from '@jooevents/contracts';
import { REVIEWER_ROSTER_OPERATION_SCHEMA_REFS, reviewerRosterDirectOperationResultSchema,
	reviewerRosterSnapshotReadResultSchema } from '@jooevents/contracts/reviewer-roster';
import { createReviewerRosterLivePort, REVIEWER_ROSTER_LIVE_OPERATIONS,
	type ReviewerRosterRequester } from './reviewer-roster-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(90); const scope = { workspaceId: id(80), eventId: id(81) };
const refs = Object.freeze({ snapshot: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.snapshotRead,
	change: REVIEWER_ROSTER_OPERATION_SCHEMA_REFS.change });
type Key = keyof typeof REVIEWER_ROSTER_LIVE_OPERATIONS;
function entry(key: Key): SafeOperationManifestEntry {
	const op = REVIEWER_ROSTER_LIVE_OPERATIONS[key]; const schemas = refs[key]; const effect: OperationEffect = op.effect;
	return { name: op.name, version: 1, lifecycle: { status: 'active' }, summary: op.name, effect,
		maxRisk: effect === 'read' ? 'low' : 'normal', consequenceTags: [], inputSchema: schemas.inputSchema,
		autonomy: { policy: { key: `autonomy.${op.name}`, version: 1 }, riskFloor: 'low', unattendedRiskCeiling: 'normal',
			requiresSeparateApproval: false, supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block' } },
		idempotency: op.idempotencyRequired ? { required: true, keySource: { key: 'idempotency.roster', version: 1 },
			credentialVerifierProfile: { key: 'credential.roster', version: 1 },
			requestHashProfile: { key: 'request-hash.roster', version: 1 } } : { required: false },
		concurrency: effect === 'read' ? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.roster', version: 1 } }, outcomes: [],
		enabledBindings: [{ surface: 'operator_http', protocol: 'http', method: op.method, path: op.path,
			input: op.input, resultSchema: schemas.resultSchema, browserResumption: { kind: 'none' } }]
	};
}
function manifest() { return safeOperationManifestSchema.parse({ schemaVersion: 1, registryDigestSha256: 'f'.repeat(64),
	operations: [entry('snapshot'), entry('change')] }); }
const subject = { kind: 'workspace_membership' as const, id: id(11), version: 1 };
function direct(action: 'register' | 'set_scope' | 'revoke' | 'restore') {
	const revoked = action === 'revoke';
	return reviewerRosterDirectOperationResultSchema.parse({ kind: 'success', correlationId,
		receipt: { id: id(40), operationName: 'reviewer_roster.change', operationVersion: 1 },
		data: { schemaVersion: 1, action, rosterVersion: 4, rosterDigestSha256: 'b'.repeat(64),
			reviewer: { schemaVersion: 1, scope, reviewerId: id(10), version: 2, accessSubject: subject,
				reviews: [], addedByUserId: id(12), addedAt: '2027-03-01T00:00:00.000Z',
				state: revoked ? 'revoked' : 'included',
				...(revoked ? { revokedByUserId: id(12), revokedAt: '2027-03-02T00:00:00.000Z' } : {}) } } });
}

describe('Reviewer Roster direct live port', () => {
	test('uses one exact call and unchanged key for every roster arm', async () => {
		const calls: { path: string; idempotencyKey?: string; body?: unknown }[] = [];
		const requester: ReviewerRosterRequester = async (input) => { calls.push(input);
			if (typeof input.body !== 'object' || input.body === null || !('action' in input.body)) throw new Error('action_missing');
			const action = input.body.action;
			if (action !== 'register' && action !== 'set_scope' && action !== 'revoke' && action !== 'restore') throw new Error('action_invalid');
			return { kind: 'success', data: direct(action) }; };
		const port = createReviewerRosterLivePort({ manifest: manifest(), request: requester });
		const guard = { expectedRosterVersion: 3, expectedRosterDigestSha256: 'a'.repeat(64) };
		await port.change({ action: 'register', reviewerId: id(10), accessSubject: subject, reviews: [], ...guard }, 'roster-register-key');
		await port.change({ action: 'set_scope', reviewerId: id(10), expectedReviewerVersion: 1, reviews: [], ...guard }, 'roster-scope-key');
		await port.change({ action: 'revoke', reviewerId: id(10), expectedReviewerVersion: 1, ...guard }, 'roster-revoke-key');
		await port.change({ action: 'restore', reviewerId: id(10), expectedReviewerVersion: 2, ...guard }, 'roster-restore-key');
		expect(calls).toHaveLength(4);
		expect(calls.map((call) => ({ path: call.path, key: call.idempotencyKey }))).toEqual([
			{ path: '/api/events/current/reviewer-roster/changes', key: 'roster-register-key' },
			{ path: '/api/events/current/reviewer-roster/changes', key: 'roster-scope-key' },
			{ path: '/api/events/current/reviewer-roster/changes', key: 'roster-revoke-key' },
			{ path: '/api/events/current/reviewer-roster/changes', key: 'roster-restore-key' }
		]);
	});

	test('reads the roster and fails malformed or mismatched direct results closed', async () => {
		const snapshot = reviewerRosterSnapshotReadResultSchema.parse({ kind: 'success', correlationId,
			data: { schemaVersion: 1, scope, version: 1, digestSha256: 'a'.repeat(64), rosterVersion: 1,
				rosterDigestSha256: 'b'.repeat(64), authorityVersion: 1, authorityDigestSha256: 'c'.repeat(64), reviewers: [] } });
		const read = createReviewerRosterLivePort({ manifest: manifest(), request: async () => ({ kind: 'success', data: snapshot }) });
		expect(await read.readSnapshot()).toMatchObject({ kind: 'success', data: { reviewers: [] } });
		const malformed = structuredClone(direct('restore')); Reflect.deleteProperty(malformed, 'receipt');
		const bad = createReviewerRosterLivePort({ manifest: manifest(), request: async () => ({ kind: 'success', data: malformed }) });
		const guard = { action: 'restore' as const, reviewerId: id(10), expectedReviewerVersion: 2,
			expectedRosterVersion: 3, expectedRosterDigestSha256: 'a'.repeat(64) };
		expect(await bad.change(guard, 'roster-restore-key')).toEqual({ kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true } });
		const mismatch = createReviewerRosterLivePort({ manifest: manifest(), request: async () => ({ kind: 'success', data: direct('revoke') }) });
		expect(await mismatch.change(guard, 'roster-restore-key')).toEqual({ kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true } });
	});
});
