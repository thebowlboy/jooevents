import { describe, expect, test } from 'bun:test';
import {
  buildReliabilityRegistry,
  resolveReliabilityDefinition
} from '@jooevents/reliability';
import {
  airtableSyncRegisteredJobSchemas,
  createAirtableSyncJobDefinition
} from './registered-job';

describe('Airtable registered connection job', () => {
  test('seals one exact anchor-inspection job accepted by the reliability registry', async () => {
    const definition = await createAirtableSyncJobDefinition();
    const registry = await buildReliabilityRegistry([definition]);
    expect(definition).toMatchObject({
      kind: 'job',
      key: 'airtable.sync.connection',
      version: 1,
      targetOperation: {
        kind: 'operation', key: 'airtable.sync-connection-execute', version: 1
      },
      externalRetryPolicy: 'anchor_inspection_only',
      leaseDurationMs: 30_000,
      timeoutMs: 25_000
    });
    expect(resolveReliabilityDefinition(registry, {
      kind: 'job', key: definition.key, version: definition.version
    })).toEqual(definition);
  });

  test('keeps retry results and opaque wake payloads closed', () => {
    expect(airtableSyncRegisteredJobSchemas.input.safeParse({
      schemaVersion: 1,
      connectionId: 'connection-1',
      reason: 'outbound_projection',
      wakeId: 'wake-1',
      targetOperation: 'attacker.operation'
    }).success).toBe(false);
    expect(airtableSyncRegisteredJobSchemas.result.safeParse({
      kind: 'retry', retryAfterMs: 1_000
    }).success).toBe(true);
    expect(airtableSyncRegisteredJobSchemas.result.safeParse({ kind: 'retry' }).success).toBe(false);
  });
});
