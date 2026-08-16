import type { AgentActionBatchView, AgentActionStepStatus } from '@jooevents/contracts';
import type { AgentActionCommandResult, AgentActionsPagePort } from './agent-actions-page-port';

const digest = (character: string) => character.repeat(64);
const id = (suffix: number) => `019c1df8-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const submittedAt = '2026-08-16T00:00:00.000Z';

function step(ordinal: number, status: AgentActionStepStatus, label: string) {
	return {
		id: id(100 + ordinal), ordinal, operationName: 'task.mutate', operationVersion: 1,
		contractDigestSha256: digest('a'), input: { action: 'assign', taskId: id(200 + ordinal) },
		requestHashSha256: digest(String(ordinal)), guards: [{ kind: 'task_current' }],
		subjects: [{ type: 'task', id: id(200 + ordinal) }], displayLabel: label,
		consequences: ['The current speaker task assignment may change.'], externalEffect: 'none' as const,
		status, attemptCount: status === 'pending' ? 0 : 1, lastSafeOutcome: null,
		terminalLogId: status === 'succeeded' ? id(300 + ordinal) : null,
		startedAt: status === 'pending' ? null : '2026-08-16T00:02:00.000Z',
		completedAt: status === 'succeeded' ? '2026-08-16T00:02:01.000Z' : null
	};
}

function sampleBatch(): AgentActionBatchView {
	const batchId = id(1);
	const steps = [
		step(1, 'succeeded', 'Assign the speaker brief'),
		step(2, 'succeeded', 'Set the slide deadline'),
		step(3, 'needs_attention', 'Assign the accessibility review'),
		step(4, 'pending', 'Create the recording release task'),
		step(5, 'pending', 'Assign the final schedule check')
	];
	const bounds = {
		maximumActions: 5,
		expiresAt: '2026-08-17T00:00:00.000Z',
		allowedOperationIdentities: ['task.mutate@1']
	};
	return {
		plan: {
			schemaVersion: 1, batchId,
			source: { surface: 'app_model', clientKey: 'organizer-assistant', runId: 'run-sample-1', proposingPrincipalId: 'model-profile.default' },
			scope: { workspaceId: id(2), eventId: id(3), subjects: [{ type: 'event', id: id(3) }] },
			intent: 'Prepare the remaining speaker logistics tasks for the program team.',
			registryDigestSha256: digest('b'), bounds,
			steps: steps.map(({ status: _status, attemptCount: _attempts, lastSafeOutcome: _outcome, terminalLogId: _log, startedAt: _started, completedAt: _completed, ...frozen }) => frozen),
			submittedAt
		},
		planDigestSha256: digest('c'), status: 'paused', version: 7, currentOrdinal: 3,
		approval: {
			approvedByPrincipalId: 'user.sample-owner', planDigestSha256: digest('c'),
			approvedAt: '2026-08-16T00:01:00.000Z', approvalExpiresAt: '2026-08-16T23:00:00.000Z',
			approvalPolicy: { key: 'agent-action.eligible-human', version: 1 }, approvedBounds: bounds
		},
		pauseRequested: false, cancelRequested: false,
		safeStatusDetail: { reason: 'task_current_guard_changed' }, createdAt: submittedAt,
		updatedAt: '2026-08-16T00:02:02.000Z', steps
	};
}

export function createSampleAgentActionsPagePort(): AgentActionsPagePort {
	let batches = [sampleBatch()];
	function update(input: { batchId: string; expectedVersion: number }, status: AgentActionBatchView['status']): AgentActionCommandResult {
		const current = batches.find((batch) => batch.plan.batchId === input.batchId);
		if (!current || current.version !== input.expectedVersion) return { kind: 'refused', message: 'This action run changed. Refresh and try again.' };
		const next: AgentActionBatchView = {
			...current, status, version: current.version + 1,
			cancelRequested: status === 'cancelled', pauseRequested: false,
			updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
			steps: status === 'cancelled'
				? current.steps.map((entry) => ['pending', 'needs_attention', 'waiting_external'].includes(entry.status) ? { ...entry, status: 'cancelled' as const } : entry)
				: current.steps
		};
		batches = batches.map((batch) => batch.plan.batchId === input.batchId ? next : batch);
		return { kind: 'success', data: next };
	}
	const port: AgentActionsPagePort = {
		source: Object.freeze({ kind: 'sample' as const }),
		async list() { return batches; },
		async inspect(batchId) { return batches.find((batch) => batch.plan.batchId === batchId); },
		async approve(input) {
			const current = batches.find((batch) => batch.plan.batchId === input.batchId);
		if (current?.planDigestSha256 !== input.expectedPlanDigestSha256) return { kind: 'refused' as const, message: 'This plan changed. Review the current plan before approving.' };
			return update(input, 'queued');
		},
		pause: (input) => Promise.resolve(update(input, 'paused')),
		resume: (input) => Promise.resolve(update(input, 'queued')),
		cancel: (input) => Promise.resolve(update(input, 'cancelled'))
	};
	return Object.freeze(port);
}
