import { describe, expect, test } from 'bun:test';
import type {
  DeadlineCatalogSnapshotDto,
  DeadlineEventTimeBasisDto,
  DeadlineMutationPlanDto,
  DeadlineScopeDto
} from '@jooevents/contracts/deadlines';
import {
  applyDeadlinePlanToCatalog,
  createEmptyDeadlineCatalog,
  DeadlineBoundaryResolutionError,
  DeadlinePlanningError,
  deadlineReferencePin,
  planDeadlineMutation,
  resolveDeadlineCalendarBoundary,
  resolveCurrentDeadlineFrom,
  validateDeadlineMutationPlan
} from '.';

const ids = {
  workspace: '01890f47-9abc-7def-8123-456789abcdef',
  event: '01890f47-9abc-7def-8123-456789abcdea',
  deadline: '01890f47-9abc-7def-8123-456789abcdeb',
  user: '01890f47-9abc-7def-8123-456789abcdec'
} as const;
const scope: DeadlineScopeDto = { workspaceId: ids.workspace, eventId: ids.event };
const at = '2026-08-13T02:00:00.000Z';

function basis(overrides: Partial<DeadlineEventTimeBasisDto> = {}): DeadlineEventTimeBasisDto {
  return { timezone: 'America/New_York', eventVersion: 3, ...overrides };
}

function createPlan(
  catalog: DeadlineCatalogSnapshotDto = createEmptyDeadlineCatalog(scope),
  displayDate = '2026-03-08'
): DeadlineMutationPlanDto {
  return planDeadlineMutation({
    catalog,
    eventTimeBasis: basis(),
    planningInput: {
      action: 'create', scope, deadlineId: ids.deadline, displayDate,
      attributedByUserId: ids.user, attributedAt: at
    }
  });
}

describe('Deadline event-local boundary', () => {
  test('uses the first instant of the next local date across DST, never host timezone', () => {
    expect(resolveDeadlineCalendarBoundary({
      displayDate: '2026-03-07', eventTimeBasis: basis()
    }).effectiveAt).toBe('2026-03-08T05:00:00.000Z');
    expect(resolveDeadlineCalendarBoundary({
      displayDate: '2026-03-08', eventTimeBasis: basis()
    }).effectiveAt).toBe('2026-03-09T04:00:00.000Z');
    expect(resolveDeadlineCalendarBoundary({
      displayDate: '2026-08-31',
      eventTimeBasis: basis({ timezone: 'Asia/Singapore' })
    }).effectiveAt).toBe('2026-08-31T16:00:00.000Z');
  });

  test('refuses a nonexistent event-local midnight instead of choosing a fallback', () => {
    try {
      resolveDeadlineCalendarBoundary({
        displayDate: '2011-12-29',
        eventTimeBasis: basis({ timezone: 'Pacific/Apia' })
      });
      throw new Error('expected nonexistent boundary refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DeadlineBoundaryResolutionError);
      expect((error as DeadlineBoundaryResolutionError).code).toBe('boundary_nonexistent');
    }
  });
});

describe('Deadline exact plans', () => {
  test('creates an exact digest/versioned head, applies once, and resolves active-only', () => {
    const empty = createEmptyDeadlineCatalog(scope);
    const plan = createPlan(empty);
    expect(plan.after.version).toBe(1);
    expect(plan.after.status).toBe('active');
    expect(plan.catalog.beforeVersion).toBe(1);
    expect(plan.catalog.afterVersion).toBe(2);
    expect(plan.after.digestSha256).toHaveLength(64);

    const applied = applyDeadlinePlanToCatalog({ plan, catalog: empty, eventTimeBasis: basis() });
    const repository = {
      readDeadlineCatalog: () => applied.catalog,
      readDeadline: (_scope: DeadlineScopeDto, id: string) =>
        id === ids.deadline ? applied.catalog.deadlines[0] : undefined
    };
    expect(resolveCurrentDeadlineFrom(repository, scope, { deadlineId: ids.deadline }))
      .toEqual(deadlineReferencePin(plan.after));
    expect(() => createPlan(applied.catalog)).toThrow('deadline_exists');
  });

  test('rejects event drift and stale replay before mutation', () => {
    const empty = createEmptyDeadlineCatalog(scope);
    const plan = createPlan(empty);
    expect(validateDeadlineMutationPlan({
      plan, catalog: empty, eventTimeBasis: basis({ eventVersion: 4 })
    })).toBe('event_time_changed');
    const applied = applyDeadlinePlanToCatalog({ plan, catalog: empty, eventTimeBasis: basis() });
    expect(validateDeadlineMutationPlan({
      plan, catalog: applied.catalog, eventTimeBasis: basis()
    })).toBe('stale_catalog');
  });

  test('updates, rejects semantic no-op, then clears without deleting identity', () => {
    const created = createPlan();
    const afterCreate = applyDeadlinePlanToCatalog({
      plan: created, catalog: createEmptyDeadlineCatalog(scope), eventTimeBasis: basis()
    }).catalog;
    expect(() => planDeadlineMutation({
      catalog: afterCreate,
      eventTimeBasis: basis(),
      planningInput: {
        action: 'update', scope, deadlineId: ids.deadline, expectedVersion: 1,
        displayDate: '2026-03-08', attributedByUserId: ids.user, attributedAt: at
      }
    })).toThrow('deadline_unchanged');

    const update = planDeadlineMutation({
      catalog: afterCreate,
      eventTimeBasis: basis(),
      planningInput: {
        action: 'update', scope, deadlineId: ids.deadline, expectedVersion: 1,
        displayDate: '2026-03-09', attributedByUserId: ids.user,
        attributedAt: '2026-08-13T02:05:00.000Z'
      }
    });
    const afterUpdate = applyDeadlinePlanToCatalog({
      plan: update, catalog: afterCreate, eventTimeBasis: basis()
    }).catalog;
    const clear = planDeadlineMutation({
      catalog: afterUpdate,
      planningInput: {
        action: 'clear', scope, deadlineId: ids.deadline, expectedVersion: 2,
        attributedByUserId: ids.user, attributedAt: '2026-08-13T02:10:00.000Z'
      }
    });
    const afterClear = applyDeadlinePlanToCatalog({ plan: clear, catalog: afterUpdate }).catalog;
    expect(afterClear.deadlines).toHaveLength(1);
    expect(afterClear.deadlines[0]).toMatchObject({ id: ids.deadline, version: 3, status: 'cleared' });
    expect(deadlineReferencePin(afterClear.deadlines[0]!)).toBeUndefined();
  });

  test('uses typed domain errors', () => {
    try {
      createPlan(createEmptyDeadlineCatalog({ ...scope, eventId: ids.deadline }));
      throw new Error('expected scope refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DeadlinePlanningError);
      expect((error as DeadlinePlanningError).code).toBe('wrong_scope');
    }
  });
});

