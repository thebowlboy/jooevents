import { describe, expect, test } from 'bun:test';
import {
  AIRTABLE_SYNC_REGISTERED_JOB,
  CloudflareAirtableWakePublisher,
  consumeCloudflareAirtableWakeBatch,
  publishScheduledAirtableDiscovery,
  runBunAirtableDueLoopOnce
} from './wake-adapters';

function message(id: string, body: unknown, attempts = 1) {
  const actions: unknown[] = [];
  return {
    value: {
      id, body, attempts,
      ack: () => actions.push('ack'),
      retry: (options?: unknown) => actions.push({ retry: options })
    },
    actions
  };
}

describe('Airtable wake adapters', () => {
  test('Cloudflare consumer explicitly acknowledges success and invalid disposable wakes', async () => {
    const valid = message('message-1', {
      schemaVersion: 1,
      connectionId: 'connection-1',
      reason: 'outbound_projection',
      wakeId: 'wake-1'
    });
    const invalid = message('message-2', { fullDomainRow: { email: 'private@example.test' } });
    const invoked: unknown[] = [];
    await consumeCloudflareAirtableWakeBatch({
      batch: { messages: [valid.value, invalid.value] },
      invoker: {
        async run(input) {
          invoked.push(input);
          return { kind: 'completed' };
        }
      }
    });
    expect(valid.actions).toEqual(['ack']);
    expect(invalid.actions).toEqual(['ack']);
    expect(invoked).toEqual([expect.objectContaining({ job: AIRTABLE_SYNC_REGISTERED_JOB })]);
  });

  test('Cloudflare consumer retries only the failed message with bounded delay', async () => {
    const retry = message('message-1', {
      schemaVersion: 1,
      connectionId: 'connection-1',
      reason: 'outbound_projection',
      wakeId: 'wake-1'
    }, 2);
    const success = message('message-2', {
      schemaVersion: 1,
      connectionId: 'connection-2',
      reason: 'outbound_projection',
      wakeId: 'wake-2'
    });
    await consumeCloudflareAirtableWakeBatch({
      batch: { messages: [retry.value, success.value] },
      invoker: {
        async run({ wake }) {
          return wake.connectionId === 'connection-1'
            ? { kind: 'retry', retryAfterMs: 45_000 }
            : { kind: 'idle' };
        }
      }
    });
    expect(retry.actions).toEqual([{ retry: { delaySeconds: 45 } }]);
    expect(success.actions).toEqual(['ack']);
  });

  test('scheduled Queue and Bun cadence discover the same durable connections', async () => {
    const due = ['connection-1', 'connection-2'];
    const queued: unknown[] = [];
    const invoked: unknown[] = [];
    const discovery = { async listDue() { return due; } };
    expect(await publishScheduledAirtableDiscovery({
      scheduledTime: 1_000,
      discovery,
      publisher: { async publish(wake) { queued.push(wake); } }
    })).toBe(2);
    expect(await runBunAirtableDueLoopOnce({
      nowMs: 1_000,
      discovery,
      invoker: { async run(input) { invoked.push(input); return { kind: 'completed' }; } }
    })).toBe(2);
    expect(queued).toHaveLength(2);
    expect(invoked).toHaveLength(2);
    expect(JSON.stringify(queued)).not.toContain('email');
  });

  test('publisher sends JSON through the queue binding and awaits completion', async () => {
    const sends: unknown[] = [];
    const publisher = new CloudflareAirtableWakePublisher({
      async send(body, options) { sends.push({ body, options }); return {}; }
    });
    await publisher.publish({
      schemaVersion: 1,
      connectionId: 'connection-1',
      reason: 'scheduled_discovery',
      wakeId: 'wake-1'
    });
    expect(sends).toEqual([expect.objectContaining({ options: { contentType: 'json' } })]);
  });
});
