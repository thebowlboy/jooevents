import { describe, expect, test } from 'bun:test';
import type { AgentActionRunRepository, FrozenAgentActionPlan } from '@jooevents/application';
import { agentActionBatchViewSchema, type AgentActionApproval, type AgentActionBatchView } from '@jooevents/contracts';
import { createAgentActionRunsHttpAdapter } from './agent-action-runs';

const id = (suffix: number) => `019c1df8-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const digest = (value: string) => value.repeat(64);
const at = '2026-08-16T00:00:00.000Z';

function awaiting(): AgentActionBatchView {
	const bounds = { maximumActions: 1, expiresAt: '2026-08-16T01:00:00.000Z', allowedOperationIdentities: ['task.mutate@1'] };
	const frozenStep = {
		id: id(4), ordinal: 1, operationName: 'task.mutate', operationVersion: 1,
		contractDigestSha256: digest('a'), input: { action: 'assign' }, requestHashSha256: digest('b'),
		guards: [], subjects: [{ type: 'task', id: id(5) }], displayLabel: 'Assign a task',
		consequences: ['The task assignment may change.'], externalEffect: 'none' as const
	};
	return agentActionBatchViewSchema.parse({
		plan: {
			schemaVersion: 1, batchId: id(1),
			source: { surface: 'app_model', clientKey: 'assistant', proposingPrincipalId: 'model-profile.default' },
			scope: { workspaceId: id(2), eventId: id(3), subjects: [{ type: 'event', id: id(3) }] },
			intent: 'Assign the outstanding task.', registryDigestSha256: digest('c'), bounds,
			steps: [frozenStep], submittedAt: at
		},
		planDigestSha256: digest('d'), status: 'awaiting_approval', version: 1, currentOrdinal: 1,
		approval: null, pauseRequested: false, cancelRequested: false, safeStatusDetail: null,
		createdAt: at, updatedAt: at,
		steps: [{ ...frozenStep, status: 'pending', attemptCount: 0, lastSafeOutcome: null, terminalLogId: null, startedAt: null, completedAt: null }]
	});
}

function repository(view: AgentActionBatchView, approvals: AgentActionApproval[]): AgentActionRunRepository {
	const unused = () => { throw new Error('unused'); };
	return {
		submit: (_frozen: FrozenAgentActionPlan) => unused(),
		inspect: (batchId) => batchId === view.plan.batchId ? view : undefined,
		list: () => [view],
		approve: ({ approval }) => {
			approvals.push(approval);
			return { ...view, status: 'queued', version: 2, approval };
		},
		reject: unused, requestPause: unused, requestCancel: unused, resume: unused,
		acquireLease: unused, nextStep: unused, markStepRunning: unused, pauseStep: unused,
		settleSafeBoundary: unused, failBatch: unused
	};
}

describe('agent action human HTTP surface', () => {
	test('lists and approves through an authenticated same-origin human, with no submit or execute route', async () => {
		const view = awaiting();
		const approvals: AgentActionApproval[] = [];
		const app = createAgentActionRunsHttpAdapter({
			repository: repository(view, approvals),
			allowedOrigins: ['https://events.example.test'],
			authenticateEligibleHuman: async () => 'user.owner',
			now: () => '2026-08-16T00:01:00.000Z'
		});
		expect((await app.request('/api/agent-actions')).status).toBe(200);
		const approved = await app.request(`/api/agent-actions/${view.plan.batchId}/approve`, {
			method: 'POST',
			headers: { origin: 'https://events.example.test', 'content-type': 'application/json' },
			body: JSON.stringify({ batchId: view.plan.batchId, expectedVersion: 1, expectedPlanDigestSha256: view.planDigestSha256 })
		});
		expect(approved.status).toBe(200);
		expect(approvals).toHaveLength(1);
		expect(approvals[0]).toMatchObject({ approvedByPrincipalId: 'user.owner', planDigestSha256: view.planDigestSha256, approvedBounds: view.plan.bounds });
		expect((await app.request(`/api/agent-actions/${view.plan.batchId}/approve`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ batchId: view.plan.batchId, expectedVersion: 1, expectedPlanDigestSha256: view.planDigestSha256 })
		})).status).toBe(401);
		expect(approvals).toHaveLength(1);
		expect((await app.request('/api/agent-actions/submit', { method: 'POST' })).status).toBe(404);
		expect((await app.request('/api/agent-actions/execute', { method: 'POST' })).status).toBe(404);
	});

	test('rejects model-authored approval by withholding eligible-human authentication', async () => {
		const view = awaiting();
		const approvals: AgentActionApproval[] = [];
		const app = createAgentActionRunsHttpAdapter({
			repository: repository(view, approvals), allowedOrigins: ['https://events.example.test'],
			authenticateEligibleHuman: async () => undefined, now: () => at
		});
		const response = await app.request(`/api/agent-actions/${view.plan.batchId}/approve`, {
			method: 'POST', headers: { origin: 'https://events.example.test', 'content-type': 'application/json' },
			body: JSON.stringify({ batchId: view.plan.batchId, expectedVersion: 1, expectedPlanDigestSha256: view.planDigestSha256 })
		});
		expect(response.status).toBe(401);
		expect(approvals).toHaveLength(0);
	});
});
