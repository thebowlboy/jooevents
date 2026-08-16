import { describe, expect, test } from 'bun:test';
import {
	TASK_OPERATION_SCHEMA_REFS,
	safeOperationManifestSchema,
	taskMutationOperationResultSchema,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import { createTasksLiveClient } from './tasks-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const mutation: SafeOperationManifestEntry = {
	name: 'task.mutation', version: 1, lifecycle: { status: 'active' }, summary: 'Mutate a task.',
	effect: 'commit', maxRisk: 'low', consequenceTags: [], inputSchema: TASK_OPERATION_SCHEMA_REFS.mutation.inputSchema,
	autonomy: {
		policy: { key: 'autonomy.task.mutation', version: 1 }, riskFloor: 'low', unattendedRiskCeiling: 'low',
		requiresSeparateApproval: false, supportedDispositions: ['proceed', 'block'],
		triggerDispositions: {
			authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
			known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
			compensation_required: 'block', terminal_failure: 'block'
		}
	},
	idempotency: {
		required: true, keySource: { key: 'idempotency.operator-header', version: 1 },
		credentialVerifierProfile: { key: 'credential.task', version: 1 },
		requestHashProfile: { key: 'request-hash.task', version: 1 }
	},
	concurrency: { kind: 'registered', definition: { key: 'concurrency.task', version: 1 } },
	outcomes: [], enabledBindings: [{
		surface: 'operator_http', protocol: 'http', method: 'POST', path: '/api/events/current/tasks',
		input: 'body', resultSchema: TASK_OPERATION_SCHEMA_REFS.mutation.resultSchema,
		browserResumption: { kind: 'none' }
	}]
};

describe('Task direct live client', () => {
	test('uses one direct request and preserves the high-entropy attempt key', async () => {
		const calls: unknown[] = [];
		const client = createTasksLiveClient({
			manifest: safeOperationManifestSchema.parse({ schemaVersion: 1, registryDigestSha256: 'a'.repeat(64), operations: [mutation] }),
			request: async (request) => {
				calls.push(request);
				return { kind: 'success', data: taskMutationOperationResultSchema.parse({
					kind: 'success', data: { schemaVersion: 1, action: 'restore_assignment', assignment: {
						schemaVersion: 1, scope: { workspaceId: id(1), eventId: id(2) }, id: id(3),
						taskDefinitionId: id(4), taskDefinitionRevisionId: id(5), engagementId: id(6), personId: id(7),
						state: 'pending', deadline: { kind: 'task_due', reference: {
							id: id(8), version: 1, digestSha256: 'b'.repeat(64), effectiveAt: '2027-01-01T00:00:00.000Z',
							displayDate: '2027-01-01', gracePolicy: 'soft'
						} }, deadlineOverride: null, completionEvidence: null,
						assignedAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T01:00:00.000Z', version: 3
					} }, receipt: { id: id(9), operationName: 'task.mutation', operationVersion: 1 }, correlationId: id(10)
				}) };
			}
		});
		const key = 'task-restore-attempt-00000001';
		expect(await client.mutate({ action: 'restore_assignment', assignmentId: id(3), expectedVersion: 2 }, key)).toMatchObject({ kind: 'success', data: { action: 'restore_assignment' } });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/events/current/tasks', idempotencyKey: key });
	});
});
