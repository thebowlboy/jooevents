import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS
} from '@jooevents/contracts/submission-triage';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createSubmissionTriageLiveClient,
	SUBMISSION_TRIAGE_OPERATIONS,
	type SubmissionTriageRequester
} from './submission-triage-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const workspaceId = id(1);
const eventId = id(2);
const submissionId = id(3);
const correlationId = id(4);
const path = '/api/events/current/submissions/triage';
const expected: ExpectedOperatorHttpOperation = {
	...SUBMISSION_TRIAGE_OPERATIONS.transition,
	effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
	...SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.transition
};

function entry(): SafeOperationManifestEntry {
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name, version: expected.version, lifecycle: { status: 'active' },
		summary: 'Change submission triage.', effect, maxRisk: 'consequential',
		autonomy: {
			policy: { key: 'autonomy.submission.triage', version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'normal', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block',
				approval_required: 'block', known_retryable_failure: 'block',
				ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		consequenceTags: [], inputSchema: expected.inputSchema,
		idempotency: {
			required: true, keySource: { key: 'idempotency.operator_header', version: 1 },
			credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
			requestHashProfile: { key: 'request_hash.submission_triage', version: 1 }
		},
		concurrency: { kind: 'registered', definition: { key: 'concurrency.submission.triage', version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: 'POST', path,
			input: 'body', resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

const manifest = safeOperationManifestSchema.parse({
	schemaVersion: 1, registryDigestSha256: 'f'.repeat(64), operations: [entry()]
});
const queryGuard = {
	schemaVersion: 1 as const, scope: { workspaceId, eventId }, version: 7,
	digestSha256: 'a'.repeat(64)
};
const input = {
	action: 'set_aside' as const,
	submissionIds: [submissionId],
	expectedHeads: [{ submissionId, version: 1 }],
	expectedQueryGuard: { version: queryGuard.version, digestSha256: queryGuard.digestSha256 }
};

describe('submission triage direct live client', () => {
	test('uses one POST and forwards exactly one high-entropy idempotency key', async () => {
		const calls: Parameters<SubmissionTriageRequester>[0][] = [];
		const request: SubmissionTriageRequester = async (call) => {
			calls.push(call);
			return { kind: 'success', data: {
				kind: 'success',
				data: { schemaVersion: 1, action: 'set_aside', queryGuard, submissionIds: [submissionId] },
				receipt: { id: id(5), operationName: SUBMISSION_TRIAGE_OPERATIONS.transition.name, operationVersion: 1 },
				correlationId
			} };
		};
		const client = createSubmissionTriageLiveClient({ manifest, request });
		expect(await client.apply(input, 'triage-2SZ8K4mJ9vQ1xP7c')).toMatchObject({
			kind: 'success', data: { action: 'set_aside', submissionIds: [submissionId] }
		});
		expect(calls).toEqual([expect.objectContaining({
			path, method: 'POST', body: input, idempotencyKey: 'triage-2SZ8K4mJ9vQ1xP7c'
		})]);
	});

	test('never exposes predecessor compensation or restore-exact operations', () => {
		expect(Object.keys(SUBMISSION_TRIAGE_OPERATIONS)).toEqual(['list', 'read', 'transition']);
	});
});
