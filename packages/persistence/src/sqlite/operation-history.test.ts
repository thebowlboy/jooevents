import { afterEach, describe, expect, test } from 'bun:test';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { createFoundationEphemeralSQLiteRuntime } from './foundation-ephemeral-sqlite-runtime';
import { createSQLiteOperationHistoryReader } from './operation-history';

const workspaceId = parseWorkspaceId('019c42ab-0000-7000-8000-000000000001');
const eventId = parseEventId('019c42ab-0000-7000-8000-000000000002');
const otherEventId = parseEventId('019c42ab-0000-7000-8000-000000000003');
const userId = '019c42ab-0000-7000-8000-000000000004';
const correlationId = '019c42ab-0000-7000-8000-000000000005';
const runtimes: ReturnType<typeof createFoundationEphemeralSQLiteRuntime>[] = [];

function openRuntime() {
  const runtime = createFoundationEphemeralSQLiteRuntime();
  runtimes.push(runtime);
  return runtime;
}

function insertOperation(
  runtime: ReturnType<typeof openRuntime>,
  input: { readonly id: string; readonly eventId?: string; readonly summary: string; readonly at: number }
) {
  const result = JSON.stringify({
    kind: 'success', data: {},
    receipt: { id: input.id, operationName: 'task.mutation', operationVersion: 1 },
    correlationId
  });
  runtime.sqlite.query(`
    INSERT INTO operation_log (
      id, operation_name, operation_version, registry_digest_sha256, surface,
      actor_json, authority_principal_key, workspace_id, event_id, subjects_json,
      summary, occurred_at_ms, correlation_id, scope_partition_key,
      idempotency_verifier_profile_key, idempotency_verifier_profile_version,
      idempotency_key_verifier, request_hash, result_json, action_batch_id, action_step_id
    ) VALUES (?, 'task.mutation', 1, ?, 'operator_http', ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'idempotency.operator-header', 1, ?, ?, ?, NULL, NULL)
  `).run(
    input.id,
    'a'.repeat(64),
    JSON.stringify({ kind: 'workspace_user', userId }),
    `workspace_user:${userId}`,
    workspaceId,
    input.eventId ?? null,
    JSON.stringify([
      { kind: 'workspace', id: workspaceId },
      ...(input.eventId ? [{ kind: 'event', id: input.eventId }] : [])
    ]),
    input.summary,
    input.at,
    correlationId,
    'b'.repeat(64),
    input.id.replaceAll('-', '').padEnd(64, 'c').slice(0, 64),
    'd'.repeat(64),
    result
  );
}

afterEach(() => { while (runtimes.length > 0) runtimes.pop()?.close(); });

describe('SQLite operation history reader', () => {
  test('lists exact safe rows newest-first in workspace and event scopes', () => {
    const runtime = openRuntime();
    insertOperation(runtime, {
      id: '019c42ab-0000-7000-8000-000000000011', eventId,
      summary: 'Created a deadline', at: 1_000
    });
    insertOperation(runtime, {
      id: '019c42ab-0000-7000-8000-000000000012', eventId: otherEventId,
      summary: 'Placed a session on the schedule', at: 3_000
    });
    insertOperation(runtime, {
      id: '019c42ab-0000-7000-8000-000000000013',
      summary: 'Invited a teammate', at: 2_000
    });
    const reader = createSQLiteOperationHistoryReader(runtime.sqlite);

    const workspace = reader.list({ workspaceId }, { view: 'workspace', limit: 2 });
    expect(workspace.entries.map((entry) => entry.summary)).toEqual([
      'Placed a session on the schedule', 'Invited a teammate'
    ]);
    expect(workspace.next?.occurredAt).toBe('1970-01-01T00:00:02.000Z');
    expect(String(workspace.next?.id)).toBe('019c42ab-0000-7000-8000-000000000013');
    expect(workspace.entries[1]?.actor.kind).toBe('workspace_user');
    expect(workspace.entries[1]?.actor.kind === 'workspace_user'
      ? String(workspace.entries[1].actor.userId) : undefined).toBe(userId);

    const currentEvent = reader.list(
      { workspaceId, eventId },
      { view: 'event', limit: 50 }
    );
    expect(currentEvent.entries).toHaveLength(1);
    expect(currentEvent.entries[0]).toMatchObject({
      summary: 'Created a deadline',
      scope: { workspaceId, eventId },
      subjects: [{ kind: 'workspace', id: workspaceId }, { kind: 'event', id: eventId }]
    });

    const remaining = reader.list({ workspaceId }, {
      view: 'workspace', limit: 50,
      beforeOccurredAt: workspace.next?.occurredAt,
      beforeId: workspace.next?.id
    });
    expect(remaining.entries.map((entry) => entry.summary)).toEqual(['Created a deadline']);
  });
});
