import { afterEach, describe, expect, test } from 'bun:test';
import { planEventCreation } from '@jooevents/event';
import { parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import { createFoundationEphemeralSQLiteRuntime } from './foundation-ephemeral-sqlite-runtime';
import { SQLiteEventSpineRepository } from './event-spine';
import { createSQLiteWorkspaceShellSummaryProjection } from './workspace-shell-summary';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa111');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa211');
const runtimes: ReturnType<typeof createFoundationEphemeralSQLiteRuntime>[] = [];

function fixture() {
  const runtime = createFoundationEphemeralSQLiteRuntime();
  runtimes.push(runtime);
  runtime.sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Summit Operations', 'active', 1, 1, 1)
  `).run(workspaceId);
  runtime.sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Ada Lovelace', 1, 1, 1)
  `).run(userId);
  const events = new SQLiteEventSpineRepository(runtime.sqlite);
  runtime.sqlite.transaction(() => events.bootstrapWorkspaceEventSet(workspaceId)).immediate();
  return { runtime, events, projection: createSQLiteWorkspaceShellSummaryProjection(runtime.sqlite) };
}

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()!.close();
});

describe('SQLite workspace shell summary projection', () => {
  test('reads the active workspace and an honest no-event state', () => {
    const { projection } = fixture();
    expect(projection.readSummary(workspaceId)).toEqual({
      schemaVersion: 1,
      workspace: { id: workspaceId, name: 'Summit Operations' },
      event: null
    });
  });

  test('reads only the fast current-event identity fields', () => {
    const { runtime, events, projection } = fixture();
    const plan = planEventCreation({
      eventSet: events.requireEventSet(workspaceId),
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'Joo Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-01-03',
        endDate: '2027-01-04'
      },
      server: {
        workspaceId,
        eventId,
        createdByUserId: userId,
        createdAt: '2026-08-16T08:30:00.000Z'
      }
    });
    runtime.sqlite.transaction(() => events.commitEventCreatePlan(plan)).immediate();
    expect(projection.readSummary(workspaceId)).toEqual({
      schemaVersion: 1,
      workspace: { id: workspaceId, name: 'Summit Operations' },
      event: {
        id: eventId,
        name: 'Joo Summit',
        timezone: 'Asia/Singapore',
        startDate: '2027-01-03',
        endDate: '2027-01-04'
      }
    });
  });
});
