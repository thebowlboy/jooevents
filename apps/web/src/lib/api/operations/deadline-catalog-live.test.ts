import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	DEADLINE_OPERATION_SCHEMA_REFS,
	deadlineListReadResultSchema
} from '@jooevents/contracts/deadlines';
import {
	createDeadlineCatalogLivePort,
	type DeadlineCatalogLiveRequester
} from './deadline-catalog-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function operation(
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	return {
		name: 'deadline.catalog.read', version: 1, summary: 'Read deadlines.',
		lifecycle: { status: 'active' }, effect: 'read', maxRisk: 'low',
		autonomy: {
			policy: { key: 'autonomy.deadline.catalog.read', version: 1 },
			riskFloor: 'low', unattendedRiskCeiling: 'low', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block',
				approval_required: 'block', known_retryable_failure: 'block',
				ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		consequenceTags: [], inputSchema: DEADLINE_OPERATION_SCHEMA_REFS.catalogRead.inputSchema,
		idempotency: { required: false }, concurrency: { kind: 'read_snapshot' }, outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: 'GET',
			path: '/api/deadlines', input: 'query',
			resultSchema: DEADLINE_OPERATION_SCHEMA_REFS.catalogRead.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(entry = operation()) {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1, registryDigestSha256: 'f'.repeat(64), operations: [entry]
	});
}

const snapshot = deadlineListReadResultSchema.parse({
	kind: 'success', correlationId: id(1), data: {
		schemaVersion: 1,
		scope: { workspaceId: id(2), eventId: id(3) },
		version: 1, digestSha256: 'a'.repeat(64), deadlines: []
	}
});

describe('live deadline catalog operation port', () => {
	test('reads the registered canonical catalog without caller-authored scope', async () => {
		const calls: unknown[] = [];
		const request: DeadlineCatalogLiveRequester = async (input) => {
			calls.push(input);
			return { kind: 'success', data: snapshot };
		};
		expect(await createDeadlineCatalogLivePort({ manifest: manifest(), request }).read())
			.toEqual(snapshot);
		expect(calls).toEqual([{
			path: '/api/deadlines', method: 'GET', schema: expect.anything()
		}]);
	});

	test('refuses manifest drift before transport', async () => {
		let calls = 0;
		const result = await createDeadlineCatalogLivePort({
			manifest: manifest(operation({
				inputSchema: {
					...DEADLINE_OPERATION_SCHEMA_REFS.catalogRead.inputSchema,
					digestSha256: '0'.repeat(64)
				}
			})),
			request: async () => {
				calls += 1;
				return { kind: 'error', error: { code: 'unexpected', retryable: false } };
			}
		}).read();
		expect(result).toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
		expect(calls).toBe(0);
	});
});
