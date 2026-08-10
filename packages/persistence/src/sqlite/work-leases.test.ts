import { afterEach, expect, test } from 'bun:test';
import { openSQLite, type OpenSQLiteResult } from './database';
import { claimDueWork, finishLeasedWork } from './work-leases';

const opened: OpenSQLiteResult[] = [];
afterEach(() => { while (opened.length) opened.pop()?.sqlite.close(); });

test('expired durable-work leases are reclaimed conditionally', () => {
  const db = openSQLite(':memory:');
  opened.push(db);
  const old = Date.parse('2026-08-09T07:00:00.000Z');
  db.sqlite.query(`insert into outbox_events
    (id, type, version, payload_json, aggregate_type, aggregate_id, idempotency_key, status, attempts, next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at)
    values ('outbox_ada', 'membership.approved', 1, '{}', 'membership', 'membership_ada', 'approved:ada', 'running', 1, ?, 'dead-worker', ?, ?, ?)`)
    .run(old, old, old, old);
  const claimed = claimDueWork({ sqlite: db.sqlite, table: 'outbox_events', owner: 'worker-2', now: '2026-08-09T08:00:00.000Z', leaseSeconds: 30, limit: 10 });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({ id: 'outbox_ada', attempts: 2, leaseOwner: 'worker-2' });
  expect(finishLeasedWork({ sqlite: db.sqlite, table: 'outbox_events', id: 'outbox_ada', owner: 'dead-worker', outcome: 'succeeded', now: '2026-08-09T08:00:01.000Z' })).toBe(false);
  expect(finishLeasedWork({ sqlite: db.sqlite, table: 'outbox_events', id: 'outbox_ada', owner: 'worker-2', outcome: 'succeeded', now: '2026-08-09T08:00:01.000Z' })).toBe(true);
});
