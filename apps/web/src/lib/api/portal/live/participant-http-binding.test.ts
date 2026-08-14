import { describe, expect, test } from 'bun:test';
import {
	PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	resolveParticipantHttpBinding,
	type ExpectedParticipantHttpOperation
} from './participant-http-binding';

const digest = (seed: string) => seed.repeat(64);

const EXPECTED_SNAPSHOT: ExpectedParticipantHttpOperation = {
	name: 'portal.snapshot.read',
	version: 1,
	effect: 'read',
	method: 'GET',
	input: 'query',
	idempotencyRequired: false,
	...PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.snapshotRead
};

const EXPECTED_RESPOND: ExpectedParticipantHttpOperation = {
	name: 'portal.engagement.respond',
	version: 1,
	effect: 'commit',
	method: 'POST',
	input: 'body',
	idempotencyRequired: true,
	...PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS.engagementRespond
};

const PATHS = Object.freeze({
	snapshot: '/api/portal/snapshot',
	respond: '/api/portal/engagements/respond'
});

function autonomy(name: string) {
	return {
		policy: { key: `autonomy.${name}`, version: 1 },
		riskFloor: 'low' as const,
		unattendedRiskCeiling: 'low' as const,
		requiresSeparateApproval: false,
		supportedDispositions: ['proceed' as const, 'block' as const],
		triggerDispositions: {
			authority_lost: 'block' as const,
			unattended_bounds_exceeded: 'block' as const,
			approval_required: 'block' as const,
			known_retryable_failure: 'block' as const,
			ambiguous_external_effect: 'block' as const,
			stale_plan: 'block' as const,
			compensation_required: 'block' as const,
			terminal_failure: 'block' as const
		}
	};
}

function manifestEntry(
	expected: ExpectedParticipantHttpOperation,
	path: string,
	overrides: {
		readonly lifecycle?: SafeOperationManifestEntry['lifecycle'];
		readonly bindings?: SafeOperationManifestEntry['enabledBindings'];
		readonly idempotencyRequired?: boolean;
	} = {}
): SafeOperationManifestEntry {
	const idempotencyRequired = overrides.idempotencyRequired ?? expected.idempotencyRequired;
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: overrides.lifecycle ?? { status: 'active' },
		summary: `Execute ${expected.name}.`,
		effect: expected.effect,
		maxRisk: expected.effect === 'commit' ? 'normal' : 'low',
		autonomy: autonomy(expected.name),
		consequenceTags: [],
		inputSchema: expected.inputSchema,
		idempotency: idempotencyRequired
			? {
					required: true,
					keySource: { key: 'idempotency.participant-header', version: 1 },
					credentialVerifierProfile: { key: 'credential.participant-session', version: 1 },
					requestHashProfile: { key: 'request-hash.portal.engagement.respond', version: 1 }
				}
			: { required: false },
		concurrency: expected.effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${expected.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: overrides.bindings ?? [
			{
				surface: 'participant_http',
				protocol: 'http',
				method: expected.method,
				path,
				input: expected.input,
				resultSchema: expected.resultSchema,
				browserResumption: { kind: 'none' }
			}
		]
	};
}

function manifest(entries: readonly SafeOperationManifestEntry[]): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: entries
	});
}

describe('resolveParticipantHttpBinding', () => {
	test('resolves the exact registered participant path for both served operations', () => {
		const composed = manifest([
			manifestEntry(EXPECTED_SNAPSHOT, PATHS.snapshot),
			manifestEntry(EXPECTED_RESPOND, PATHS.respond)
		]);
		expect(resolveParticipantHttpBinding({ manifest: composed, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'available', path: PATHS.snapshot });
		expect(resolveParticipantHttpBinding({ manifest: composed, expected: EXPECTED_RESPOND }))
			.toEqual({ kind: 'available', path: PATHS.respond });
	});

	test('refuses a manifest that does not parse', () => {
		expect(resolveParticipantHttpBinding({ manifest: { nonsense: true }, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'invalid_operation_manifest' });
	});

	test('refuses when the operation is not registered', () => {
		const composed = manifest([manifestEntry(EXPECTED_RESPOND, PATHS.respond)]);
		expect(resolveParticipantHttpBinding({ manifest: composed, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'operation_not_registered' });
	});

	test('refuses an ambiguous registration rather than choosing one', () => {
		const composed = manifest([
			manifestEntry(EXPECTED_SNAPSHOT, PATHS.snapshot),
			manifestEntry(EXPECTED_SNAPSHOT, '/api/portal/snapshot-duplicate')
		]);
		expect(resolveParticipantHttpBinding({ manifest: composed, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'operation_registration_ambiguous' });
	});

	test('refuses an operation that is not active', () => {
		const composed = manifest([
			manifestEntry(EXPECTED_SNAPSHOT, PATHS.snapshot, {
				lifecycle: { status: 'replay_only' }
			})
		]);
		expect(resolveParticipantHttpBinding({ manifest: composed, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'operation_not_active' });
	});

	test('refuses a contract drift in effect, idempotency, or input schema', () => {
		const wrongIdempotency = manifest([
			manifestEntry(EXPECTED_RESPOND, PATHS.respond, { idempotencyRequired: false })
		]);
		expect(resolveParticipantHttpBinding({ manifest: wrongIdempotency, expected: EXPECTED_RESPOND }))
			.toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });

		const wrongInputSchema = manifest([
			manifestEntry(
				{ ...EXPECTED_SNAPSHOT, inputSchema: EXPECTED_RESPOND.inputSchema },
				PATHS.snapshot
			)
		]);
		expect(resolveParticipantHttpBinding({ manifest: wrongInputSchema, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
	});

	test('an operator binding of the same operation never satisfies the participant lane', () => {
		const operatorOnly = manifest([
			manifestEntry(EXPECTED_SNAPSHOT, PATHS.snapshot, {
				bindings: [
					{
						surface: 'operator_http',
						protocol: 'http',
						method: 'GET',
						path: '/api/operator/portal-snapshot',
						input: 'query',
						resultSchema: EXPECTED_SNAPSHOT.resultSchema,
						browserResumption: { kind: 'none' }
					}
				]
			})
		]);
		expect(resolveParticipantHttpBinding({ manifest: operatorOnly, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'participant_http_binding_not_registered' });
	});

	test('refuses ambiguous participant bindings rather than choosing one', () => {
		const composed = manifest([
			manifestEntry(EXPECTED_SNAPSHOT, PATHS.snapshot, {
				bindings: [
					{
						surface: 'participant_http',
						protocol: 'http',
						method: 'GET',
						path: PATHS.snapshot,
						input: 'query',
						resultSchema: EXPECTED_SNAPSHOT.resultSchema,
						browserResumption: { kind: 'none' }
					},
					{
						surface: 'participant_http',
						protocol: 'http',
						method: 'GET',
						path: '/api/portal/snapshot-second',
						input: 'query',
						resultSchema: EXPECTED_SNAPSHOT.resultSchema,
						browserResumption: { kind: 'none' }
					}
				]
			})
		]);
		expect(resolveParticipantHttpBinding({ manifest: composed, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'participant_http_binding_ambiguous' });
	});

	test('refuses a binding whose method, resumption, or result schema drifts', () => {
		const wrongMethod = manifest([
			manifestEntry(EXPECTED_SNAPSHOT, PATHS.snapshot, {
				bindings: [
					{
						surface: 'participant_http',
						protocol: 'http',
						method: 'POST',
						path: PATHS.snapshot,
						input: 'query',
						resultSchema: EXPECTED_SNAPSHOT.resultSchema,
						browserResumption: { kind: 'none' }
					}
				]
			})
		]);
		expect(resolveParticipantHttpBinding({ manifest: wrongMethod, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'participant_http_binding_unsupported' });

		const wrongResult = manifest([
			manifestEntry(EXPECTED_SNAPSHOT, PATHS.snapshot, {
				bindings: [
					{
						surface: 'participant_http',
						protocol: 'http',
						method: 'GET',
						path: PATHS.snapshot,
						input: 'query',
						resultSchema: EXPECTED_RESPOND.resultSchema,
						browserResumption: { kind: 'none' }
					}
				]
			})
		]);
		expect(resolveParticipantHttpBinding({ manifest: wrongResult, expected: EXPECTED_SNAPSHOT }))
			.toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
	});
});
