import { afterEach, describe, expect, test } from 'bun:test';
import { planEventCreation } from '@jooevents/event';
import { parseEventId, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import {
  workspaceOverviewAreaCatalogSchema,
  type WorkspaceOverviewAreaCatalog
} from '@jooevents/contracts/workspace-overview';
import { createFoundationEphemeralSQLiteRuntime } from './foundation-ephemeral-sqlite-runtime';
import { SQLiteEventSpineRepository } from './event-spine';
import { createSQLiteWorkspaceOverviewProjection } from './workspace-overview';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa111');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa211');
const createdAt = '2026-08-12T08:30:00.000Z';
const createdAtMs = Date.parse(createdAt);
const openRuntimes: ReturnType<typeof createFoundationEphemeralSQLiteRuntime>[] = [];
const areaCatalog: WorkspaceOverviewAreaCatalog = workspaceOverviewAreaCatalogSchema.parse([
  { area: 'overview', status: 'available', capabilities: ['workspace.overview.read'] },
  { area: 'submissions', status: 'available', capabilities: ['submission.list'] },
  { area: 'review', status: 'unavailable', reason: 'not_implemented' },
  { area: 'decisions', status: 'unavailable', reason: 'not_implemented' },
  { area: 'speakers', status: 'unavailable', reason: 'not_implemented' },
  { area: 'reviewers', status: 'unavailable', reason: 'not_implemented' },
  { area: 'tasks', status: 'unavailable', reason: 'not_implemented' },
  { area: 'schedule', status: 'unavailable', reason: 'not_composed' },
  { area: 'messages', status: 'unavailable', reason: 'not_composed' },
  { area: 'templates', status: 'unavailable', reason: 'not_implemented' },
  { area: 'forms', status: 'available', capabilities: ['form.list'] },
  { area: 'embeds', status: 'unavailable', reason: 'not_implemented' },
  { area: 'settings', status: 'available', capabilities: ['event.current.read'] }
]);

function openRuntime() {
  const runtime = createFoundationEphemeralSQLiteRuntime();
  openRuntimes.push(runtime);
  runtime.sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', 1, 1, 1)
  `).run(workspaceId, 'Overview test workspace');
  runtime.sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, 1, 1, 1)
  `).run(userId, 'Overview owner');
  const events = new SQLiteEventSpineRepository(runtime.sqlite);
  runtime.sqlite.transaction(() => events.bootstrapWorkspaceEventSet(workspaceId)).immediate();
  return { runtime, events };
}

function createEvent(events: SQLiteEventSpineRepository) {
  const plan = planEventCreation({
    eventSet: events.requireEventSet(workspaceId),
    authorInput: { expectedEventSetVersion: 1, name: 'Overview Summit', timezone: 'Asia/Singapore',
      startDate: '2026-11-04', endDate: '2026-11-06' },
    server: { workspaceId, eventId, createdByUserId: userId, createdAt }
  });
  events.commitEventCreatePlan(plan);
}

function projection(sqlite: ReturnType<typeof openRuntime>['runtime']['sqlite']) {
  return createSQLiteWorkspaceOverviewProjection({ sqlite, areaCatalog });
}

function insertOperation(sqlite: ReturnType<typeof openRuntime>['runtime']['sqlite'], input: {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly at: number;
}) {
  const result = JSON.stringify({
    kind: 'success', data: {},
    receipt: { id: input.id, operationName: input.name, operationVersion: 1 },
    correlationId: '019c1df7-86b5-769b-bba4-5f7097bfa901'
  });
  sqlite.query(`
    INSERT INTO operation_log (
      id, operation_name, operation_version, registry_digest_sha256, surface,
      actor_json, authority_principal_key, workspace_id, event_id, subjects_json,
      summary, occurred_at_ms, correlation_id, scope_partition_key,
      idempotency_verifier_profile_key, idempotency_verifier_profile_version,
      idempotency_key_verifier, request_hash, result_json, action_batch_id, action_step_id
    ) VALUES (?, ?, 1, ?, 'operator_http', ?, ?, ?, ?, ?, ?, ?,
      '019c1df7-86b5-769b-bba4-5f7097bfa901', ?, 'idempotency.operator-header', 1,
      ?, ?, ?, NULL, NULL)
  `).run(
    input.id, input.name, 'a'.repeat(64), JSON.stringify({ kind: 'workspace_user', userId }),
    `workspace_user:${userId}`, workspaceId, eventId,
    JSON.stringify([{ kind: 'workspace', id: workspaceId }, { kind: 'event', id: eventId }]),
    input.summary, input.at, 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), result
  );
}

afterEach(() => { while (openRuntimes.length > 0) openRuntimes.pop()?.close(); });

describe('SQLite workspace overview projection', () => {
  test('represents no-Event state with explicit locks and unavailable metrics', () => {
    const { runtime } = openRuntime();
    const overview = projection(runtime.sqlite).readOverview(workspaceId);
    expect(overview.event).toEqual({ schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 });
    expect(overview.areas.find((area) => area.area === 'submissions'))
      .toEqual({ area: 'submissions', status: 'locked', reason: 'event_required' });
    for (const metric of Object.values(overview.metrics)) {
      expect(metric).toEqual({ kind: 'unavailable', reason: 'event_required' });
    }
    expect(overview.history).toEqual({ total: 0, truncated: false, threads: [] });
  });

  test('measures durable domain counts and operation-log changes only', () => {
    const { runtime, events } = openRuntime();
    runtime.sqlite.transaction(() => createEvent(events)).immediate();
    insertOperation(runtime.sqlite, {
      id: '019c1df7-86b5-769b-bba4-5f7097bfa493', name: 'event.settings.update',
      summary: 'Updated event settings', at: createdAtMs
    });
    const overview = projection(runtime.sqlite).readOverview(workspaceId);
    expect(overview.event).toMatchObject({ kind: 'current_event', event: { id: eventId } });
    expect(overview.metrics.forms).toEqual({ kind: 'exact', total: 0, draft: 0, open: 0, closed: 0 });
    expect(overview.metrics.operations).toEqual({ kind: 'exact', total: 1 });
  });

  test('projects one safe operation-log item per history row without actor identity', () => {
    const { runtime, events } = openRuntime();
    runtime.sqlite.transaction(() => createEvent(events)).immediate();
    const fieldId = '019c1df7-86b5-769b-bba4-5f7097bfa503';
    const triageId = '019c1df7-86b5-769b-bba4-5f7097bfa513';
    insertOperation(runtime.sqlite, {
      id: fieldId, name: 'field_registry.add', summary: 'Added a speaker field', at: createdAtMs
    });
    insertOperation(runtime.sqlite, {
      id: triageId, name: 'submission.triage.transition', summary: 'Set submissions aside',
      at: createdAtMs + 1000
    });
    const history = projection(runtime.sqlite).readOverview(workspaceId).history;
    expect(history.threads.map((item) => ({ id: item.id, domain: item.domain }))).toEqual([
      { id: `operation:${triageId}`, domain: 'submission_triage' },
      { id: `operation:${fieldId}`, domain: 'field_registry' }
    ]);
    expect(JSON.stringify(history)).not.toContain(userId);
  });
});
