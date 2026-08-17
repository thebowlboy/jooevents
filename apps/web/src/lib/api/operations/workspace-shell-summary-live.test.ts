import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	workspaceShellSummaryReadResultSchema,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	createWorkspaceShellSummaryLivePort,
	WORKSPACE_SHELL_SUMMARY_READ_OPERATION,
	type WorkspaceShellSummaryRequester
} from './workspace-shell-summary-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const correlationId = id(9);
const EXPECTED_PATH = '/api/workspace/shell-summary';

function operation(overrides: Partial<SafeOperationManifestEntry> = {}): SafeOperationManifestEntry {
	return {
		...WORKSPACE_SHELL_SUMMARY_READ_OPERATION,
		lifecycle: { status: 'active' },
		summary: WORKSPACE_SHELL_SUMMARY_READ_OPERATION.name,
		effect: 'read',
		maxRisk: 'low',
		consequenceTags: [],
		autonomy: {
			policy: { key: `autonomy.${WORKSPACE_SHELL_SUMMARY_READ_OPERATION.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'normal',
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		inputSchema: WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.inputSchema,
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: 'GET', path: EXPECTED_PATH,
			input: 'query', resultSchema: WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	} as SafeOperationManifestEntry;
}

function manifest(overrides: Partial<SafeOperationManifestEntry> = {}) {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1, registryDigestSha256: 'f'.repeat(64), operations: [operation(overrides)]
	});
}

const projection = {
	schemaVersion: 1 as const,
	workspace: { id: id(50), name: 'JooEvents' },
	event: {
		id: id(1), name: 'JooCon 2027', timezone: 'Europe/Helsinki',
		startDate: '2027-05-04', endDate: '2027-05-06'
	}
};

describe('workspace shell summary live client', () => {
	test('reads the nameplate with one exact GET and no idempotency key', async () => {
		const calls: unknown[] = [];
		const request: WorkspaceShellSummaryRequester = async (input) => {
			calls.push(input);
			return {
				kind: 'success',
				data: workspaceShellSummaryReadResultSchema.parse({
					kind: 'success', correlationId, data: projection
				})
			};
		};
		const port = createWorkspaceShellSummaryLivePort({ manifest: manifest(), request });
		expect(await port.read()).toMatchObject({
			kind: 'success', correlationId, data: { event: { name: 'JooCon 2027' } }
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ path: EXPECTED_PATH, method: 'GET' });
		expect(calls[0]).not.toHaveProperty('idempotencyKey');
	});

	test('carries a served null event rather than inventing one', async () => {
		const request: WorkspaceShellSummaryRequester = async () => ({
			kind: 'success',
			data: workspaceShellSummaryReadResultSchema.parse({
				kind: 'success', correlationId, data: { ...projection, event: null }
			})
		});
		const result = await createWorkspaceShellSummaryLivePort({ manifest: manifest(), request }).read();
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.event).toBeNull();
		expect(result.data.workspace.name).toBe('JooEvents');
	});

	test('fails closed on an absent binding, a drifted path, and a malformed body', async () => {
		let called = false;
		const request: WorkspaceShellSummaryRequester = async () => {
			called = true;
			return { kind: 'success', data: { kind: 'success' } as never };
		};

		// Nothing mounted: the refusal is named, and no request leaves.
		expect(await createWorkspaceShellSummaryLivePort({ manifest: {}, request }).read())
			.toEqual({ kind: 'unavailable', reason: 'invalid_operation_manifest' });
		expect(called).toBe(false);

		// The same operation served somewhere else is not the same operation.
		expect(await createWorkspaceShellSummaryLivePort({
			manifest: manifest({
				enabledBindings: [{
					surface: 'operator_http', protocol: 'http', method: 'GET',
					path: '/api/workspace/shell-summary-drift', input: 'query',
					resultSchema: WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.resultSchema,
					browserResumption: { kind: 'none' }
				}]
			}),
			request
		}).read()).toEqual({ kind: 'unavailable', reason: 'operation_contract_mismatch' });
		expect(called).toBe(false);

		// A body that is not the contract is a transport fault, never a nameplate.
		expect(await createWorkspaceShellSummaryLivePort({ manifest: manifest(), request }).read())
			.toEqual({ kind: 'transport_error', error: { code: 'invalid_contract', retryable: true } });
		expect(called).toBe(true);
	});

	test('passes a canonical refusal through as an outcome', async () => {
		const request: WorkspaceShellSummaryRequester = async () => ({
			kind: 'success',
			data: workspaceShellSummaryReadResultSchema.parse({
				kind: 'outcome',
				correlationId,
				outcome: {
					kind: 'workspace.access_denied', class: 'access_denied', retryable: false, subjects: [],
					detail: { key: 'detail.workspace.access_denied', version: 1 }, detailSchemaVersion: 1
				}
			})
		});
		expect(await createWorkspaceShellSummaryLivePort({ manifest: manifest(), request }).read())
			.toMatchObject({ kind: 'outcome', outcome: { class: 'access_denied' } });
	});
});
