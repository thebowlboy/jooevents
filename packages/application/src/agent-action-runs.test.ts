import { describe, expect, test } from 'bun:test';
import type { AgentActionPlan, AgentActionStep } from '@jooevents/contracts';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  freezeAgentActionPlan,
  type AgentActionEligibilityCatalog,
  type AgentActionEligibleOperation
} from './agent-action-runs';

const uuid = (suffix: number): string =>
  `019c1df8-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const contractDigest = 'a'.repeat(64);

function operation(overrides: Partial<AgentActionEligibleOperation> = {}): AgentActionEligibleOperation {
  return {
    operationName: 'task.assign',
    operationVersion: 1,
    contractDigestSha256: contractDigest,
    batchable: true,
    externalEffect: 'none',
    validateInput(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('input_invalid');
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some((key) => !['taskId', 'assigneeId', 'classifiedPayloadRef'].includes(key))) {
        throw new TypeError('classified_or_unknown_input_forbidden');
      }
      if (typeof record.taskId !== 'string' || typeof record.assigneeId !== 'string') throw new TypeError('input_invalid');
      if ('classifiedPayloadRef' in record && typeof record.classifiedPayloadRef !== 'string') throw new TypeError('classified_ref_invalid');
      return value;
    },
    hashRequest: canonicalJsonSha256,
    displayLabel: () => 'Assign task',
    consequences: () => ['The organizer becomes responsible for this task.'],
    ...overrides
  };
}

function catalog(entry = operation()): AgentActionEligibilityCatalog {
  return { resolve: (name, version) => name === entry.operationName && version === entry.operationVersion ? entry : undefined };
}

function plan(input: AgentActionStep['input'] = { taskId: uuid(4), assigneeId: uuid(5) }): AgentActionPlan {
  const stepInput = input;
  return {
    schemaVersion: 1,
    batchId: uuid(1),
    source: { surface: 'app_model', clientKey: 'assistant.plan', proposingPrincipalId: 'model-profile.default' },
    scope: { workspaceId: uuid(2), eventId: uuid(3), subjects: [{ type: 'event', id: uuid(3) }] },
    intent: 'Assign the current task to the selected organizer.',
    registryDigestSha256: 'b'.repeat(64),
    bounds: { maximumActions: 1, expiresAt: '2026-08-16T01:00:00.000Z', allowedOperationIdentities: ['task.assign@1'] },
    steps: [{
      id: uuid(6), ordinal: 1, operationName: 'task.assign', operationVersion: 1,
      contractDigestSha256: contractDigest, input: stepInput,
      requestHashSha256: canonicalJsonSha256(stepInput), guards: [{ kind: 'task_open', taskId: uuid(4) }],
      subjects: [{ type: 'task', id: uuid(4) }], displayLabel: 'Assign task',
      consequences: ['The organizer becomes responsible for this task.'], externalEffect: 'none'
    }],
    submittedAt: '2026-08-16T00:00:00.000Z'
  };
}

describe('agent action executable envelope', () => {
  test('freezes the complete canonical plan and rejects changed contracts or requests', () => {
    const frozen = freezeAgentActionPlan(plan(), catalog());
    expect(frozen.planDigestSha256).toBe(canonicalJsonSha256(frozen.plan));
    expect(JSON.parse(frozen.canonicalPlanJson)).toEqual(frozen.plan);
    expect(() => freezeAgentActionPlan(plan(), catalog(operation({ contractDigestSha256: 'c'.repeat(64) }))))
      .toThrow('agent_action_contract_changed');
    const changed = plan();
    changed.steps[0] = { ...changed.steps[0]!, requestHashSha256: 'd'.repeat(64) };
    expect(() => freezeAgentActionPlan(changed, catalog())).toThrow('agent_action_request_hash_changed');
    expect(() => freezeAgentActionPlan(plan(), catalog(operation({ batchable: false }))))
      .toThrow('agent_action_operation_ineligible');
  });

  test('stores only an owning classified reference and rejects classified bytes', () => {
    const safe = plan({ taskId: uuid(4), assigneeId: uuid(5), classifiedPayloadRef: 'classified-payload:019c1df8' });
    const frozen = freezeAgentActionPlan(safe, catalog());
    expect(frozen.canonicalPlanJson).toContain('classified-payload:019c1df8');
    expect(frozen.canonicalPlanJson).not.toContain('speaker@example.test');
    const unsafe = plan({ taskId: uuid(4), assigneeId: uuid(5), classifiedPayload: 'speaker@example.test' });
    expect(() => freezeAgentActionPlan(unsafe, catalog())).toThrow('classified_or_unknown_input_forbidden');
  });
});
