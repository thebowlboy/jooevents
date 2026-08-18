import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS,
	workspaceOverviewProjectionSchema,
	workspaceOverviewReadResultSchema
} from '@jooevents/contracts/workspace-overview';
import {
	createWorkspaceOverviewLivePort,
	WORKSPACE_OVERVIEW_READ_OPERATION,
	type WorkspaceOverviewRequester
} from './workspace-overview-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function operation(
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	return {
		...WORKSPACE_OVERVIEW_READ_OPERATION,
		lifecycle: { status: 'active' },
		summary: 'Read workspace overview.',
		effect: 'read',
		maxRisk: 'low',
		autonomy: {
			policy: { key: 'autonomy.workspace.overview.read', version: 1 },
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
		inputSchema: WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.inputSchema,
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: 'GET',
			path: '/api/workspace/overview',
			input: 'query',
			resultSchema: WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.resultSchema,
			browserResumption: { kind: 'none' }
		}],
		...overrides
	};
}

function manifest(entry = operation()) {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: 'f'.repeat(64),
		operations: [entry]
	});
}

const projection = workspaceOverviewProjectionSchema.parse({
	schemaVersion: 1,
	event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
	areas: [
		{ area: 'overview', status: 'available', capabilities: ['workspace.overview.read'] },
		{ area: 'submissions', status: 'locked', reason: 'event_required' },
		{ area: 'review', status: 'unavailable', reason: 'not_implemented' },
		{ area: 'decisions', status: 'unavailable', reason: 'not_implemented' },
		{ area: 'speakers', status: 'unavailable', reason: 'not_implemented' },
		{ area: 'reviewers', status: 'unavailable', reason: 'not_implemented' },
		{ area: 'tasks', status: 'unavailable', reason: 'not_implemented' },
		{ area: 'schedule', status: 'unavailable', reason: 'not_composed' },
		{ area: 'messages', status: 'unavailable', reason: 'not_composed' },
		{ area: 'templates', status: 'unavailable', reason: 'not_implemented' },
		{ area: 'forms', status: 'locked', reason: 'event_required' },
		{ area: 'embeds', status: 'locked', reason: 'event_required' },
		{ area: 'settings', status: 'partial', availableCapabilities: ['event.current.read'], unavailableCapabilities: ['workspace.settings.manage'] }
	],
	metrics: {
		forms: { kind: 'unavailable', reason: 'event_required' },
		submissions: { kind: 'unavailable', reason: 'event_required' },
		programVocabulary: { kind: 'unavailable', reason: 'event_required' },
		operations: { kind: 'unavailable', reason: 'event_required' },
		triage: { kind: 'unavailable', reason: 'event_required' },
		reviews: { kind: 'unavailable', reason: 'event_required' },
		reviewers: { kind: 'unavailable', reason: 'event_required' },
		decisions: { kind: 'unavailable', reason: 'event_required' },
		engagements: { kind: 'unavailable', reason: 'event_required' },
		sessions: { kind: 'unavailable', reason: 'event_required' },
		communications: { kind: 'unavailable', reason: 'event_required' },
		templates: { kind: 'unavailable', reason: 'event_required' }
	},
	history: { total: 0, truncated: false, threads: [] }
});

describe('live workspace overview operation port', () => {
	test('reads the exact manifest-resolved canonical projection without caller scope', async () => {
		const calls: unknown[] = [];
		const request: WorkspaceOverviewRequester = async (input) => {
			calls.push(input);
			return {
				kind: 'success',
				data: { kind: 'success', data: projection, correlationId: id(1) }
			};
		};
		const result = await createWorkspaceOverviewLivePort({ manifest: manifest(), request }).read();
		expect(result).toEqual({ kind: 'success', data: projection, correlationId: id(1) });
		expect(calls).toEqual([{
			path: '/api/workspace/overview',
			method: 'GET',
			schema: expect.anything()
		}]);
	});

	test('refuses schema drift before transport', async () => {
		let calls = 0;
		const result = await createWorkspaceOverviewLivePort({
			manifest: manifest(operation({
				inputSchema: {
					...WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.inputSchema,
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

	test('keeps structured outcomes and safe transport failures distinct', async () => {
		const outcome = workspaceOverviewReadResultSchema.parse({
			kind: 'outcome',
			outcome: {
				class: 'access_denied',
				kind: 'authority.revoked',
				retryable: false,
				subjects: [],
				detail: null,
				detailSchemaVersion: 1
			},
			correlationId: id(2)
		});
		const outcomePort = createWorkspaceOverviewLivePort({
			manifest: manifest(),
			request: async () => ({ kind: 'success', data: outcome })
		});
		expect(await outcomePort.read()).toEqual(outcome);

		const failurePort = createWorkspaceOverviewLivePort({
			manifest: manifest(),
			request: async () => ({
				kind: 'error', error: { code: 'network_unavailable', retryable: true }
			})
		});
		expect(await failurePort.read()).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
	});
});
