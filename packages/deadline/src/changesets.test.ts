import { describe, expect, test } from 'bun:test';
import type {
  DeadlineCatalogSnapshotDto,
  DeadlineEventTimeBasisDto,
  DeadlineMutationPlanDto,
  DeadlineMutationPlanningInput,
  DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import {
  planChangesetOperationSynchronous,
  type ChangesetPlanningSnapshot
} from '@jooevents/changesets';
import {
  applyDeadlinePlanToCatalog,
  createDeadlineChangesetBundle,
  createEmptyDeadlineCatalog,
  deadlineChangesetReadPort,
  deadlineChangesetTransactionPort,
  deadlineChangesetValidationPort,
  deadlinePlanningAttributionReadPort,
  type DeadlineChangesetPlan
} from '.';

const scope: DeadlineScopeDto = {
  workspaceId: '01890f47-9abc-7def-8123-456789abcdef',
  eventId: '01890f47-9abc-7def-8123-456789abcdea'
};
const deadlineId = '01890f47-9abc-7def-8123-456789abcdeb';
const userId = '01890f47-9abc-7def-8123-456789abcdec';

class Store {
  catalog: DeadlineCatalogSnapshotDto = createEmptyDeadlineCatalog(scope);
  basis: DeadlineEventTimeBasisDto = { timezone: 'Asia/Singapore', eventVersion: 2 };

  readDeadlineCatalog(requestScope: DeadlineScopeDto) {
    return sameScope(requestScope) ? this.catalog : undefined;
  }

  readDeadline(requestScope: DeadlineScopeDto, requestedId: string) {
    return sameScope(requestScope)
      ? this.catalog.deadlines.find((deadline) => deadline.id === requestedId)
      : undefined;
  }

  readDeadlineEventTimeBasis(requestScope: DeadlineScopeDto) {
    return sameScope(requestScope) ? this.basis : undefined;
  }

  applyDeadlinePlan(plan: DeadlineMutationPlanDto) {
    const applied = applyDeadlinePlanToCatalog({
      plan,
      catalog: this.catalog,
      ...(plan.eventTimeBasis ? { eventTimeBasis: this.basis } : {})
    });
    this.catalog = applied.catalog;
    return applied.result;
  }
}

function sameScope(request: DeadlineScopeDto): boolean {
  return request.workspaceId === scope.workspaceId && request.eventId === scope.eventId;
}

function snapshot(store: Store): ChangesetPlanningSnapshot {
  return Object.freeze({
    getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
      if (key === deadlinePlanningAttributionReadPort) {
        return {
          readDeadlinePlanningAttribution: () => ({
            userId,
            at: '2026-08-13T03:00:00.000Z'
          })
        } as Port;
      }
      expect(key).toBe(deadlineChangesetReadPort);
      return store as unknown as Port;
    }
  });
}

function createInput(): DeadlineMutationPlanningInput {
  return {
    action: 'create', scope, deadlineId, displayDate: '2026-08-31',
    attributedByUserId: userId, attributedAt: '2026-08-13T02:00:00.000Z'
  };
}

describe('Deadline generic changeset definition', () => {
  test('plans, validates, applies with exact evidence, and derives/applies compensation', async () => {
    const store = new Store();
    const bundle = createDeadlineChangesetBundle();
    const frozen = planChangesetOperationSynchronous({
      registry: bundle.registry,
      kind: 'deadline.cfp_close.mutate',
      version: 1,
      authorInput: createInput(),
      dependencyGroup: 'deadline',
      snapshot: snapshot(store)
    });
    expect(frozen.riskTier).toBe('low');
    expect(frozen.aggregateRefs).toEqual([{
      id: `event:${scope.eventId}`, version: 2
    }]);
    expect(frozen.guardRefs).toEqual([{
      id: `deadline_catalog:${scope.eventId}`,
      version: 1,
      digest: store.catalog.digestSha256
    }]);
    const plan = frozen.plan as unknown as DeadlineChangesetPlan;
    const validated = await bundle.definition.validateWithin(plan, {
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        expect(key).toBe(deadlineChangesetValidationPort);
        return store as unknown as Port;
      }
    });
    expect(validated.kind).toBe('ready');
    if (validated.kind !== 'ready') throw new TypeError('expected_deadline_ready');
    const applied = await bundle.definition.applyWithin(validated.validated, {
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        expect(key).toBe(deadlineChangesetTransactionPort);
        return store as unknown as Port;
      }
    });
    expect(applied.facts).toMatchObject([{
      kind: 'deadline_changed', version: 1,
      payload: { action: 'create', deadlineId, status: 'active' }
    }]);
    expect(applied.effects).toEqual([]);

    const compensation = await bundle.definition.deriveCompensation(plan, snapshot(store));
    expect(compensation).toMatchObject({
      kind: 'exact', authorInput: { action: 'compensate' }
    });
    if (compensation.kind !== 'exact') throw new TypeError('expected_exact_compensation');
    const correction = planChangesetOperationSynchronous({
      registry: bundle.registry,
      kind: 'deadline.cfp_close.mutate',
      version: 1,
      authorInput: compensation.authorInput,
      dependencyGroup: 'deadline',
      snapshot: snapshot(store)
    });
    const correctionPlan = correction.plan as unknown as DeadlineChangesetPlan;
    expect(correctionPlan.mutation).toMatchObject({
      input: { action: 'clear', deadlineId },
      before: { status: 'active', version: 1 },
      after: { status: 'cleared', version: 2 }
    });
    const correctionValidated = await bundle.definition.validateWithin(correctionPlan, {
      getPort: <Port>() => store as unknown as Port
    });
    if (correctionValidated.kind !== 'ready') throw new TypeError('expected_correction_ready');
    await bundle.definition.applyWithin(correctionValidated.validated, {
      getPort: <Port>() => store as unknown as Port
    });
    expect(store.catalog.deadlines[0]).toMatchObject({ status: 'cleared', version: 2 });
    expect(await bundle.definition.deriveCompensation(correctionPlan, snapshot(store)))
      .toEqual({ kind: 'blocked', reasonKey: 'deadline.nested_compensation' });
  });

  test('returns a structured stale outcome before apply after Event drift', async () => {
    const store = new Store();
    const bundle = createDeadlineChangesetBundle();
    const frozen = planChangesetOperationSynchronous({
      registry: bundle.registry,
      kind: 'deadline.cfp_close.mutate', version: 1,
      authorInput: createInput(), dependencyGroup: 'deadline', snapshot: snapshot(store)
    });
    store.basis = { timezone: 'Asia/Singapore', eventVersion: 3 };
    expect(await bundle.definition.validateWithin(
      frozen.plan as unknown as DeadlineChangesetPlan,
      {
      getPort: <Port>() => store as unknown as Port
      }
    )).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'stale_revision', kind: 'deadline.canonical_changed',
        detail: { code: 'event_time_changed', action: 'create', deadlineId }
      }
    });
    expect(store.catalog.deadlines).toEqual([]);
  });
});
