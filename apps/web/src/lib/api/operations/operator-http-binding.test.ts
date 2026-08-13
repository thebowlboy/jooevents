import { describe, expect, test } from 'bun:test';
import type { SafeOperationManifest } from '@jooevents/contracts';
import { resolveOperatorHttpBinding } from './operator-http-binding';

const digest = 'a'.repeat(64);
const schema = (key: string) => ({ key, version: 1, digestSha256: digest });
const expected = Object.freeze({
	name: 'catalog.read',
	version: 1,
	effect: 'read' as const,
	method: 'GET' as const,
	input: 'query' as const,
	idempotencyRequired: false,
	inputSchema: schema('schema.catalog.read-input'),
	resultSchema: schema('schema.catalog.read-result')
});

function operation(overrides: Record<string, unknown> = {}) {
	return {
		name: expected.name,
		version: expected.version,
		lifecycle: { status: 'active' },
		summary: 'Read a catalog.',
		effect: expected.effect,
		maxRisk: 'low',
		autonomy: {
			policy: { key: 'autonomy.catalog_read', version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'low',
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'renewed_approval', 'block'],
			triggerDispositions: {
				authority_lost: 'block',
				unattended_bounds_exceeded: 'renewed_approval',
				approval_required: 'renewed_approval',
				known_retryable_failure: 'block',
				ambiguous_external_effect: 'block',
				stale_plan: 'block',
				compensation_required: 'block',
				terminal_failure: 'block'
			}
		},
		consequenceTags: [],
		inputSchema: expected.inputSchema,
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: 'GET',
			path: '/api/catalog',
			input: 'query',
			resultSchema: expected.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(operations: unknown[]): SafeOperationManifest {
	return {
		schemaVersion: 1,
		registryDigestSha256: digest,
		operations
	} as SafeOperationManifest;
}

describe('operator HTTP binding resolver', () => {
	test('returns the one exact active binding', () => {
		expect(resolveOperatorHttpBinding({ manifest: manifest([operation()]), expected })).toEqual({
			kind: 'available',
			path: '/api/catalog'
		});
	});

	test('fails closed for malformed, missing, ambiguous, inactive, or changed operations', () => {
		expect(resolveOperatorHttpBinding({ manifest: {}, expected })).toEqual({
			kind: 'unavailable', reason: 'invalid_operation_manifest'
		});
		expect(resolveOperatorHttpBinding({ manifest: manifest([]), expected })).toEqual({
			kind: 'unavailable', reason: 'operation_not_registered'
		});
		expect(resolveOperatorHttpBinding({
			manifest: manifest([operation(), operation()]), expected
		})).toEqual({ kind: 'unavailable', reason: 'operation_registration_ambiguous' });
		expect(resolveOperatorHttpBinding({
			manifest: manifest([operation({ lifecycle: { status: 'replay_only' } })]), expected
		})).toEqual({ kind: 'unavailable', reason: 'operation_not_active' });
		expect(resolveOperatorHttpBinding({
			manifest: manifest([operation({ effect: 'draft' })]), expected
		})).toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
		for (const inputSchema of [
			{ ...expected.inputSchema, key: 'schema.catalog.changed-input' },
			{ ...expected.inputSchema, version: 2 },
			{ ...expected.inputSchema, digestSha256: 'b'.repeat(64) }
		]) {
			expect(resolveOperatorHttpBinding({
				manifest: manifest([operation({ inputSchema })]), expected
			})).toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
		}
	});

	test('never guesses among or adapts incompatible operator bindings', () => {
		expect(resolveOperatorHttpBinding({
			manifest: manifest([operation({ enabledBindings: [] })]), expected
		})).toEqual({ kind: 'unavailable', reason: 'operator_http_binding_not_registered' });
		const binding = operation().enabledBindings[0]!;
		expect(resolveOperatorHttpBinding({
			manifest: manifest([operation({ enabledBindings: [binding, binding] })]), expected
		})).toEqual({ kind: 'unavailable', reason: 'operator_http_binding_ambiguous' });
		expect(resolveOperatorHttpBinding({
			manifest: manifest([operation({
				enabledBindings: [{ ...binding, method: 'POST', input: 'body' }]
			})]), expected
		})).toEqual({ kind: 'unavailable', reason: 'operator_http_binding_unsupported' });
		for (const resultSchema of [
			{ ...expected.resultSchema, key: 'schema.catalog.changed-result' },
			{ ...expected.resultSchema, version: 2 },
			{ ...expected.resultSchema, digestSha256: 'b'.repeat(64) }
		]) {
			expect(resolveOperatorHttpBinding({
				manifest: manifest([operation({
					enabledBindings: [{ ...binding, resultSchema }]
				})]), expected
			})).toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
		}
	});
});
