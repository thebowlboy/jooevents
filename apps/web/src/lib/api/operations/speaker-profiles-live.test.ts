import { describe, expect, test } from 'bun:test';
import {
	SPEAKER_PROFILE_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	speakerProfileReviewPolicyUpdateResultSchema,
	speakerProfileReviewQueueReadResultSchema,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	createSpeakerProfilesLiveClient,
	SPEAKER_PROFILE_LIVE_OPERATIONS,
	type SpeakerProfileLiveRequestInput
} from './speaker-profiles-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const workspaceId = id(1);
const eventId = id(2);
const correlationId = id(3);
const policy = {
	schemaVersion: 1 as const,
	workspaceId,
	eventId,
	eventVersion: 7,
	reviewRequired: false
};

const expected = {
	queue: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.reviewQueueRead,
		effect: 'read' as const,
		method: 'GET' as const,
		input: 'query' as const,
		idempotencyRequired: false,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewQueueRead,
		path: '/api/events/current/speakers/profile-review'
	},
	policy: {
		...SPEAKER_PROFILE_LIVE_OPERATIONS.reviewPolicyUpdate,
		effect: 'commit' as const,
		method: 'POST' as const,
		input: 'body' as const,
		idempotencyRequired: true,
		...SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.reviewPolicyUpdate,
		path: '/api/events/current/speakers/profile-review-policy'
	}
} as const;

function operation(key: keyof typeof expected): SafeOperationManifestEntry {
	const item = expected[key];
	const effect = item.effect as OperationEffect;
	return {
		name: item.name,
		version: item.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${item.name}.`,
		effect,
		maxRisk: 'low',
		autonomy: {
			policy: { key: `autonomy.${item.name}`, version: 1 },
			riskFloor: 'low', unattendedRiskCeiling: 'low', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block',
				approval_required: 'block', known_retryable_failure: 'block',
				ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		consequenceTags: [],
		inputSchema: item.inputSchema,
		idempotency: item.idempotencyRequired ? {
			required: true,
			keySource: { key: 'idempotency.operator_header', version: 1 },
			credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
			requestHashProfile: { key: 'request_hash.speaker_profile', version: 1 }
		} : { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: 'concurrency.speaker_profile', version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: item.method,
			path: item.path, input: item.input, resultSchema: item.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

const manifest = safeOperationManifestSchema.parse({
	schemaVersion: 1,
	registryDigestSha256: 'f'.repeat(64),
	operations: [operation('queue'), operation('policy')]
});

describe('speaker-profile policy live client', () => {
	test('reads the event queue and commits the exact guarded policy update', async () => {
		const calls: SpeakerProfileLiveRequestInput[] = [];
		const client = createSpeakerProfilesLiveClient({
			manifest,
			request: async (request) => {
				calls.push(request);
				if (request.method === 'GET') {
					return { kind: 'success', data: speakerProfileReviewQueueReadResultSchema.parse({
						kind: 'success', data: { schemaVersion: 1, policy, profiles: [] }, correlationId
					}) };
				}
				return { kind: 'success', data: speakerProfileReviewPolicyUpdateResultSchema.parse({
					kind: 'success',
					data: { ...policy, eventVersion: 8, reviewRequired: true },
					receipt: {
						id: id(4), operationName: SPEAKER_PROFILE_LIVE_OPERATIONS.reviewPolicyUpdate.name,
						operationVersion: 1
					},
					correlationId
				}) };
			}
		});

		expect(await client.readReviewQueue()).toMatchObject({
			kind: 'success', data: { policy: { reviewRequired: false } }
		});
		expect(await client.updateReviewPolicy(
			{ expectedEventVersion: 7, reviewRequired: true },
			'speaker-profile-policy-01'
		)).toMatchObject({
			kind: 'success', data: { eventVersion: 8, reviewRequired: true }
		});
		expect(calls).toEqual([
			expect.objectContaining({
				path: expected.queue.path, method: 'GET'
			}),
			expect.objectContaining({
				path: expected.policy.path, method: 'POST',
				body: { expectedEventVersion: 7, reviewRequired: true },
				idempotencyKey: 'speaker-profile-policy-01'
			})
		]);
	});
});
