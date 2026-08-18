import { describe, expect, test } from 'bun:test';
import {
	ENGAGEMENT_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	type EngagementHeadDto,
	type OperationEffect,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import type { ExpectedOperatorHttpOperation } from './operator-http-binding';
import {
	createEngagementsLiveClient,
	ENGAGEMENTS_LIVE_OPERATIONS,
	type EngagementsLiveRequester
} from './engagements-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const scope = { workspaceId: id(1), eventId: id(2) };
const engagementId = id(3);
const sessionId = id(4);
const personId = id(5);
const submissionId = id(6);
const correlationId = id(7);
const path = '/api/events/current/engagements';
const historyPath = '/api/events/current/speakers/person-history';
const expected: ExpectedOperatorHttpOperation = {
	...ENGAGEMENTS_LIVE_OPERATIONS.change,
	effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true,
	...ENGAGEMENT_OPERATION_SCHEMA_REFS.change
};

function manifestEntry(): SafeOperationManifestEntry {
	const effect = expected.effect as OperationEffect;
	return {
		name: expected.name, version: 1, lifecycle: { status: 'active' },
		summary: 'Change an engagement.', effect, maxRisk: 'consequential',
		autonomy: {
			policy: { key: 'autonomy.engagement.change', version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'normal', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block',
				approval_required: 'block', known_retryable_failure: 'block',
				ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		}, consequenceTags: [], inputSchema: expected.inputSchema,
		idempotency: {
			required: true, keySource: { key: 'idempotency.operator_header', version: 1 },
			credentialVerifierProfile: { key: 'credential.idempotency', version: 1 },
			requestHashProfile: { key: 'request_hash.engagement.change', version: 1 }
		},
		concurrency: { kind: 'registered', definition: { key: 'concurrency.engagement.change', version: 1 } },
		outcomes: [], enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: 'POST', path,
			input: 'body', resultSchema: expected.resultSchema, browserResumption: { kind: 'none' }
		}]
	};
}
const manifest = safeOperationManifestSchema.parse({
	schemaVersion: 1, registryDigestSha256: 'f'.repeat(64), operations: [manifestEntry()]
});
const historyManifest = safeOperationManifestSchema.parse({
	schemaVersion: 1,
	registryDigestSha256: 'e'.repeat(64),
	operations: [{
		name: ENGAGEMENTS_LIVE_OPERATIONS.personHistoryRead.name,
		version: 1,
		lifecycle: { status: 'active' },
		summary: 'Read person history.',
		effect: 'read', maxRisk: 'low',
		autonomy: {
			policy: { key: 'autonomy.speaker.person-history.read', version: 1 },
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
		inputSchema: ENGAGEMENT_OPERATION_SCHEMA_REFS.personHistoryRead.inputSchema,
		idempotency: { required: false }, concurrency: { kind: 'read_snapshot' }, outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: 'GET', path: historyPath,
			input: 'query', resultSchema: ENGAGEMENT_OPERATION_SCHEMA_REFS.personHistoryRead.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	}]
});
const before: EngagementHeadDto = {
	schemaVersion: 1, id: engagementId, scope, sessionId, personId, submissionId,
	seededByDecision: { version: 1, digestSha256: 'a'.repeat(64) }, state: 'invited',
	invitedAt: '2026-08-13T10:00:00.000Z', respondBy: null, confirmation: null,
	cancellationRequest: null, cancelledAt: null,
	source: { kind: 'submission', id: submissionId, version: 1 }, version: 1
};
const input = {
	action: 'record_confirmation' as const, engagementId, expectedEngagementVersion: 1,
	attribution: 'organizer_recorded' as const
};

describe('engagement direct live client', () => {
	test('uses one POST and exactly one idempotency key', async () => {
		const calls: Parameters<EngagementsLiveRequester>[0][] = [];
		const request: EngagementsLiveRequester = async (call) => {
			calls.push(call);
			return { kind: 'success', data: {
				kind: 'success', data: {
					action: 'record_confirmation',
					engagement: { ...before, state: 'confirmed', version: 2, confirmation: {
						attribution: 'organizer_recorded', personId, recordedByUserId: id(8),
						confirmedAt: '2026-08-13T11:00:00.000Z'
					} }
				}, receipt: { id: id(9), operationName: ENGAGEMENTS_LIVE_OPERATIONS.change.name, operationVersion: 1 },
				correlationId
			} };
		};
		const client = createEngagementsLiveClient({ manifest, request });
		expect(await client.respond(input, 'engagement-K9x4P2m7Q1v8')).toMatchObject({
			kind: 'success', data: { action: 'record_confirmation', engagement: { state: 'confirmed' } }
		});
		expect(calls).toEqual([expect.objectContaining({
			path, method: 'POST', body: input, idempotencyKey: 'engagement-K9x4P2m7Q1v8'
		})]);
	});

	test('exports only engagement response and person-level lineup operations', () => {
		expect(Object.keys(ENGAGEMENTS_LIVE_OPERATIONS)).toEqual([
			'read', 'change', 'lineupRead', 'personHistoryRead', 'lineupChange'
		]);
	});

	test('follows every exact person-history page', async () => {
		const calls: string[] = [];
		const request: EngagementsLiveRequester = async ({ path: requested }) => {
			calls.push(requested);
			const second = requested.includes('beforeId=');
			return { kind: 'success', data: {
				kind: 'success', correlationId,
				data: {
					schemaVersion: 1,
					entries: second ? [{
						id: `portal:${id(12)}`, occurredAt: '2026-08-17T09:00:00.000Z',
						actor: 'person', summary: 'Confirmed the invitation'
					}] : Array.from({ length: 100 }, (_, index) => ({
						id: `task:00000000-0000-4000-8000-${(200 + index).toString(16).padStart(12, '0')}`,
						occurredAt: new Date(Date.parse('2026-08-18T09:00:00.000Z') - index * 1_000).toISOString(),
						actor: 'organizer', summary: 'Changed a speaker task'
					})),
					next: second ? null : {
						occurredAt: new Date(Date.parse('2026-08-18T09:00:00.000Z') - 99_000).toISOString(),
						id: `task:00000000-0000-4000-8000-${(299).toString(16).padStart(12, '0')}`
					}
				}
			} };
		};
		const result = await createEngagementsLiveClient({ manifest: historyManifest, request })
			.readPersonHistory(personId);
		expect(result).toMatchObject({ kind: 'success' });
		expect(result.kind === 'success' ? result.data : []).toHaveLength(101);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain(`personId=${encodeURIComponent(personId)}`);
	});
});
