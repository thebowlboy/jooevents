import { describe, expect, test } from 'bun:test';
import { changeAirtableConnectionState, syncAirtableNow, type AirtableConnectionControlRepository } from './connection-control';

describe('Airtable connection controls', () => {
  test('sync now records durable work before publishing a latency wake', async () => {
    const trace: string[] = [];
    const repository: AirtableConnectionControlRepository = {
      async read() { return { state: 'active', version: 3 }; },
      async transition() { return true; },
      async scheduleReconciliation() { trace.push('durable'); }
    };
    await syncAirtableNow({
      connectionId: 'connection', nowMs: 100, wakeId: 'manual:1', repository,
      publisher: { async publish() { trace.push('wake'); } }
    });
    expect(trace).toEqual(['durable', 'wake']);
  });

  test('pause and disconnect fence on the current connection version', async () => {
    let state: 'active' | 'paused' | 'disconnecting' = 'active';
    let version = 2;
    const repository: AirtableConnectionControlRepository = {
      async read() { return { state, version }; },
      async transition(input) { state = input.to as typeof state; version += 1; return true; },
      async scheduleReconciliation() {}
    };
    expect(await changeAirtableConnectionState({
      connectionId: 'connection', expectedVersion: 2, next: 'paused', nowMs: 1, repository
    })).toEqual({ kind: 'accepted', state: 'paused' });
    expect(await changeAirtableConnectionState({
      connectionId: 'connection', expectedVersion: 2, next: 'disconnecting', nowMs: 2, repository
    })).toEqual({ kind: 'refused', code: 'stale_connection' });
  });
});
