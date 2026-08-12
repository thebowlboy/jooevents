import { describe, expect, test } from 'bun:test';
import {
	PENDING_GATEWAY_ACTION_LIMITS,
	gatewayActionKeySchema,
	gatewayPrincipalPartitionKeySchema,
	gatewayScopeKeySchema,
	gatewaySourceKeySchema,
	parseGatewayActionKey,
	parseGatewayCompletionReference,
	parseGatewayDisclosureEpoch,
	parseGatewayPrincipalPartitionKey,
	parseGatewayScopeKey,
	parseGatewayServerReference,
	parseGatewaySourceKey,
	parseGatewayStageIdempotencyKey,
	parsePendingGatewayActionRecord,
	pendingGatewayActionRecordBytes,
	pendingGatewayActionRecordSchema,
	pendingGatewayActionStorageKey,
	type PendingGatewayActionIdentity,
	type PendingGatewayActionRecord
} from './pending-gateway-action';

const identity = {
	sourceKey: parseGatewaySourceKey('gws_0123456789abcdef'),
	scopeKey: parseGatewayScopeKey('gsc_0123456789abcdef'),
	principalPartitionKey: parseGatewayPrincipalPartitionKey('gpp_0123456789abcdef'),
	actionKey: parseGatewayActionKey('gac_0123456789abcdef')
} as const satisfies PendingGatewayActionIdentity;

function fixture(overrides: Record<string, unknown> = {}): PendingGatewayActionRecord {
	return parsePendingGatewayActionRecord({
		schemaVersion: 1,
		identity,
		disclosureEpoch: parseGatewayDisclosureEpoch('gde_0123456789abcdef'),
		choreography: { key: 'program_vocabulary.create', version: 1 },
		createdAt: '2026-08-11T00:00:00.000Z',
		updatedAt: '2026-08-11T00:00:00.000Z',
		expiresAt: '2026-08-12T00:00:00.000Z',
		retainUntil: '2026-08-15T00:00:00.000Z',
		revision: 1,
		state: { kind: 'active' },
		currentStep: {
			stepKey: 'draft',
			operation: { name: 'program_vocabulary.create.draft', version: 1 },
			idempotencyKey: parseGatewayStageIdempotencyKey('gik_0123456789abcdef'),
			request: {
				kind: 'safe_inline',
				classificationPolicy: { key: 'browser_safe.program_vocabulary', version: 1 },
				inputSchema: {
					key: 'schema.program_vocabulary.create.input',
					version: 1,
					digestSha256: 'a'.repeat(64)
				},
				maximumCanonicalBytes: 256,
				value: { expectedSetVersion: 4, name: 'Workshop' }
			}
		},
		completedSteps: [],
		...overrides
	});
}

describe('PendingGatewayAction record', () => {
	test('is strict, versioned, bounded, immutable, and carries no cached next-action decision', () => {
		const record = fixture();
		expect(record.schemaVersion).toBe(1);
		expect(record.revision).toBe(1);
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.currentStep)).toBe(true);
		expect(Object.isFrozen(record.currentStep.request)).toBe(true);
		expect(pendingGatewayActionRecordBytes(record)).toBeLessThanOrEqual(
			PENDING_GATEWAY_ACTION_LIMITS.maximumRecordBytes
		);
		expect('nextAction' in record).toBe(false);
		expect('authority' in record).toBe(false);
		expect('approval' in record).toBe(false);

		expect(pendingGatewayActionRecordSchema.safeParse({ ...record, extra: true }).success).toBe(
			false
		);
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				currentStep: { ...record.currentStep, actor: 'caller-supplied' }
			}).success
		).toBe(false);
		expect(
			pendingGatewayActionRecordSchema.safeParse({ ...record, schemaVersion: 2 }).success
		).toBe(false);
	});

	test('uses runtime-separated opaque brands rather than substitutable authority-shaped strings', () => {
		const source = 'gws_0123456789abcdef';
		const scope = 'gsc_0123456789abcdef';
		const action = 'gac_0123456789abcdef';
		const principal = 'gpp_0123456789abcdef';
		expect(gatewaySourceKeySchema.safeParse(source).success).toBe(true);
		expect(gatewaySourceKeySchema.safeParse(scope).success).toBe(false);
		expect(gatewayScopeKeySchema.safeParse(source).success).toBe(false);
		expect(gatewayActionKeySchema.safeParse(principal).success).toBe(false);
		expect(gatewayPrincipalPartitionKeySchema.safeParse(action).success).toBe(false);
		expect(gatewayPrincipalPartitionKeySchema.safeParse('user_123').success).toBe(false);
	});

	test('the durable key changes with source, scope, principal partition, or action', () => {
		const base = pendingGatewayActionStorageKey(identity);
		const variants = [
			{ ...identity, sourceKey: parseGatewaySourceKey('gws_fedcba9876543210') },
			{ ...identity, scopeKey: parseGatewayScopeKey('gsc_fedcba9876543210') },
			{
				...identity,
				principalPartitionKey: parseGatewayPrincipalPartitionKey('gpp_fedcba9876543210')
			},
			{ ...identity, actionKey: parseGatewayActionKey('gac_fedcba9876543210') }
		];
		expect(new Set(variants.map(pendingGatewayActionStorageKey)).size).toBe(4);
		for (const variant of variants) expect(pendingGatewayActionStorageKey(variant)).not.toBe(base);
	});

	test('accepts only registered bounded safe-inline input or a bounded opaque server reference', () => {
		const record = fixture();
		const request = record.currentStep.request;
		if (request.kind !== 'safe_inline') throw new TypeError('expected_safe_inline');

		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				currentStep: {
					...record.currentStep,
					request: { ...request, maximumCanonicalBytes: 4 }
				}
			}).success
		).toBe(false);
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				currentStep: {
					...record.currentStep,
					request: {
						...request,
						maximumCanonicalBytes: PENDING_GATEWAY_ACTION_LIMITS.maximumInlineBytes + 1
					}
				}
			}).success
		).toBe(false);
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				currentStep: {
					...record.currentStep,
					request: { kind: 'safe_inline', maximumCanonicalBytes: 256, value: {} }
				}
			}).success
		).toBe(false);

		const serverReference = parseGatewayServerReference('gsr_0123456789abcdef');
		const serverRecord = fixture({
			currentStep: {
				...record.currentStep,
				request: {
					kind: 'server_ref',
					referenceSchema: {
						key: 'schema.pending_action.server_reference',
						version: 1,
						digestSha256: 'b'.repeat(64)
					},
					requestCodec: { key: 'codec.pending_action.request', version: 1 },
					maximumReferenceBytes: 128,
					reference: serverReference
				}
			}
		});
		expect(serverRecord.currentStep.request).toMatchObject({
			kind: 'server_ref',
			reference: serverReference
		});
		if (serverRecord.currentStep.request.kind !== 'server_ref') {
			throw new TypeError('expected_server_ref');
		}
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...serverRecord,
				currentStep: {
					...serverRecord.currentStep,
					request: { ...serverRecord.currentStep.request, maximumReferenceBytes: 4 }
				}
			}).success
		).toBe(false);
	});

	test('enforces lifetime, retention, step uniqueness, and state timestamp invariants', () => {
		const record = fixture();
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				expiresAt: '2026-10-01T00:00:00.000Z'
			}).success
		).toBe(false);
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				retainUntil: '2026-08-25T00:00:00.000Z'
			}).success
		).toBe(false);
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				completedSteps: [
					{
						stepKey: record.currentStep.stepKey,
						operation: record.currentStep.operation,
						completionReference: parseGatewayCompletionReference('gcr_0123456789abcdef')
					}
				]
			}).success
		).toBe(false);
		expect(
			pendingGatewayActionRecordSchema.safeParse({
				...record,
				state: { kind: 'completed', completedAt: '2026-08-11T00:00:01.000Z' }
			}).success
		).toBe(false);
		const completed = pendingGatewayActionRecordSchema.safeParse({
			...record,
			updatedAt: '2026-08-11T00:00:01.000Z',
			state: { kind: 'completed', completedAt: '2026-08-11T00:00:01.000Z' },
			completedSteps: [
				{
					stepKey: record.currentStep.stepKey,
					operation: record.currentStep.operation,
					completionReference: parseGatewayCompletionReference('gcr_0123456789abcdef')
				}
			]
		});
		expect(completed.success).toBe(true);
	});
});
