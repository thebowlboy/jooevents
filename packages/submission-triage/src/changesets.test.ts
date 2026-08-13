import { describe, expect, test } from 'bun:test';
import type { SubmissionArrivalFactDto, SubmissionTriageAttribution } from '@jooevents/contracts/submission-triage';
import type { ChangesetPlanningSnapshot } from '@jooevents/changesets';
import {
  createSubmissionTriageChangesetBundle,
  createSubmissionTriageState,
  planSubmissionTriageTransition,
  submissionTriageChangesetReadPort,
  type SubmissionTriageEntry,
  type SubmissionTriageStateSnapshot
} from '.';

const id = (suffix: number): string =>
  `01890f47-9abc-7def-8123-${suffix.toString(16).padStart(12, '0')}`;
const scope = { workspaceId: id(1), eventId: id(2) };
const at = '2026-08-13T01:00:00.000Z';
const later = '2026-08-13T02:00:00.000Z';
const originalAttribution: SubmissionTriageAttribution = {
  kind: 'manual', principalKey: `workspace_user:${id(9)}`,
  invocationId: id(10), surface: 'operator_http'
};
const transitionAttribution: SubmissionTriageAttribution = {
  kind: 'manual', principalKey: `workspace_user:${id(11)}`,
  invocationId: id(12), surface: 'operator_http'
};

function arrival(submissionId: string, classification: 'on_time' | 'late'): SubmissionArrivalFactDto {
  return {
    schemaVersion: 1, id: id(Number.parseInt(submissionId.slice(-2), 16) + 100), scope,
    submissionId, formId: id(20), formVersionId: id(21), source: 'public_form',
    submittedAt: at, classification,
    closeEvidence: classification === 'late' ? {
      closeAt: '2026-08-12T23:00:00.000Z',
      policy: {
        reference: { key: 'submission.accepting-window', version: 1 },
        definitionDigestSha256: 'a'.repeat(64)
      }
    } : null,
    recordedAt: at
  };
}

function initialState(): SubmissionTriageStateSnapshot {
  const entries: SubmissionTriageEntry[] = [
    {
      arrival: arrival(id(30), 'late'),
      head: {
        schemaVersion: 1, scope, submissionId: id(30), version: 3,
        state: 'set_aside', setAsideAttribution: originalAttribution, updatedAt: at
      }
    },
    {
      arrival: arrival(id(31), 'on_time'),
      head: {
        schemaVersion: 1, scope, submissionId: id(31), version: 1,
        state: 'inbox', setAsideAttribution: null, updatedAt: at
      }
    }
  ];
  return createSubmissionTriageState({ scope, version: 5, entries });
}

function afterPlan(state: SubmissionTriageStateSnapshot, plan: ReturnType<typeof planSubmissionTriageTransition>) {
  const after = new Map(plan.transitions.map((transition) => [transition.submissionId, transition.after]));
  return createSubmissionTriageState({
    scope, version: plan.queryGuard.after.version,
    entries: state.entries.map((entry) => ({
      arrival: entry.arrival,
      head: after.get(entry.head.submissionId) ?? entry.head
    }))
  });
}

function snapshot(state: SubmissionTriageStateSnapshot): ChangesetPlanningSnapshot {
  return {
    getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
      expect(key).toBe(submissionTriageChangesetReadPort);
      return { readTriageState: () => state } as unknown as Port;
    }
  };
}

describe('submission triage compensation', () => {
  test('restores exact prior state and attribution without changing the immutable late fact', async () => {
    const before = initialState();
    const plan = planSubmissionTriageTransition({
      state: before, action: 'return_to_inbox', submissionIds: [id(30)],
      expectedHeads: [{ submissionId: id(30), version: 3 }],
      expectedQueryGuard: before.queryGuard,
      attribution: transitionAttribution, changedAt: later
    });
    const current = afterPlan(before, plan);
    const definition = createSubmissionTriageChangesetBundle().registry.get(
      'submission.triage.transition', 1
    )!;
    const compensation = await definition.deriveCompensation(plan, snapshot(current));
    expect(compensation).toMatchObject({
      kind: 'exact',
      authorInput: {
        action: 'restore_exact',
        targets: [{
          submissionId: id(30), expectedCurrentVersion: 4,
          state: 'set_aside', setAsideAttribution: originalAttribution
        }]
      }
    });
    expect(current.entries[0]!.arrival.classification).toBe('late');
  });

  test('is honest about a later change: partial for the unchanged subset and blocked for none', async () => {
    const before = initialState();
    const plan = planSubmissionTriageTransition({
      state: before, action: 'discard_recoverable', submissionIds: [id(30), id(31)],
      expectedHeads: [
        { submissionId: id(30), version: 3 }, { submissionId: id(31), version: 1 }
      ],
      expectedQueryGuard: before.queryGuard,
      attribution: transitionAttribution, changedAt: later
    });
    const applied = afterPlan(before, plan);
    const changedEntries = applied.entries.map((entry, index) => index === 1 ? {
      ...entry,
      head: { ...entry.head, version: entry.head.version + 1, updatedAt: '2026-08-13T03:00:00.000Z' }
    } : entry);
    const partialState = createSubmissionTriageState({
      scope, version: applied.queryGuard.version + 1, entries: changedEntries
    });
    const definition = createSubmissionTriageChangesetBundle().registry.get(
      'submission.triage.transition', 1
    )!;
    const partial = await definition.deriveCompensation(plan, snapshot(partialState));
    expect(partial).toMatchObject({
      kind: 'partial', conflicts: ['submission_triage.later_change'],
      authorInput: { targets: [{ submissionId: id(30) }] }
    });

    const allChanged = createSubmissionTriageState({
      scope, version: partialState.queryGuard.version + 1,
      entries: changedEntries.map((entry) => ({
        ...entry,
        head: { ...entry.head, version: entry.head.version + 1, updatedAt: '2026-08-13T04:00:00.000Z' }
      }))
    });
    expect(await definition.deriveCompensation(plan, snapshot(allChanged))).toEqual({
      kind: 'blocked', reasonKey: 'submission_triage.later_change'
    });
  });
});
