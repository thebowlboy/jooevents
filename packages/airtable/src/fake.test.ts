import { describe, expect, test } from 'bun:test';
import {
  FakeAirtableProvider,
  parseAirtableBaseId,
  parseAirtableFieldId,
  parseAirtableTableId
} from './index';

async function provision(provider: FakeAirtableProvider) {
  const workspaceId = provider.seedWorkspace({
    id: 'wsp00000000000001',
    name: 'Events',
    plan: 'team'
  });
  const created = await provider.data.createBase({
    workspaceId,
    name: 'JooEvents · Riverside',
    tables: [{
      name: 'Tasks',
      fields: [
        { name: 'Task', type: 'singleLineText' },
        { name: 'JooEvents ID', type: 'singleLineText' },
        { name: 'Status', type: 'singleSelect' }
      ]
    }]
  });
  if (created.kind === 'failure') throw new Error(created.failure.code);
  const table = created.value.tables[0]!;
  return {
    baseId: created.value.id,
    tableId: table.id,
    titleFieldId: table.fields[0]!.id,
    stableIdFieldId: table.fields[1]!.id,
    statusFieldId: table.fields[2]!.id
  };
}

describe('deterministic Airtable fake', () => {
  test('provisions schema, upserts in ten-record batches, and pages by stable IDs', async () => {
    const provider = new FakeAirtableProvider();
    const ids = await provision(provider);
    const write = await provider.data.patchRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      mergeOnFieldId: ids.stableIdFieldId,
      records: Array.from({ length: 10 }, (_, index) => ({
        fields: {
          [ids.titleFieldId]: `Task ${index}`,
          [ids.stableIdFieldId]: `task-${index}`,
          [ids.statusFieldId]: 'Open'
        }
      }))
    });
    expect(write.kind).toBe('success');
    if (write.kind === 'success') {
      expect(write.value.records.every((record) => record.kind === 'created')).toBe(true);
    }
    const first = await provider.data.listRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      fieldIds: [ids.stableIdFieldId],
      pageSize: 4
    });
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(first.value.records).toHaveLength(4);
    expect(first.value.offset).toBe('4');
    const second = await provider.data.listRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      fieldIds: [ids.stableIdFieldId],
      pageSize: 100,
      ...(first.value.offset ? { offset: first.value.offset } : {})
    });
    expect(second.kind).toBe('success');
    if (second.kind === 'success') expect(second.value.records).toHaveLength(6);

    const upsert = await provider.data.patchRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      mergeOnFieldId: ids.stableIdFieldId,
      records: [{
        fields: {
          [ids.stableIdFieldId]: 'task-0',
          [ids.statusFieldId]: 'Done'
        }
      }]
    });
    expect(upsert.kind).toBe('success');
    if (upsert.kind === 'success') expect(upsert.value.records[0]?.kind).toBe('updated');
  });

  test('models partial batches and acceptance unknown without duplicate creation', async () => {
    const provider = new FakeAirtableProvider();
    const ids = await provision(provider);
    provider.enqueueFault({
      operation: 'patchRecords',
      kind: 'partial',
      failedRequestIndexes: [1],
      code: 'temporary_unavailable'
    });
    const partial = await provider.data.patchRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      mergeOnFieldId: ids.stableIdFieldId,
      records: [
        { fields: { [ids.stableIdFieldId]: 'task-a', [ids.titleFieldId]: 'A' } },
        { fields: { [ids.stableIdFieldId]: 'task-b', [ids.titleFieldId]: 'B' } }
      ]
    });
    expect(partial.kind).toBe('success');
    if (partial.kind === 'success') {
      expect(partial.value.records.map((record) => record.kind)).toEqual(['created', 'failed']);
    }

    provider.enqueueFault({ operation: 'patchRecords', kind: 'timeout_after_accept' });
    const unknown = await provider.data.patchRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      mergeOnFieldId: ids.stableIdFieldId,
      records: [{ fields: { [ids.stableIdFieldId]: 'task-c', [ids.titleFieldId]: 'C' } }]
    });
    expect(unknown).toMatchObject({
      kind: 'failure',
      failure: { code: 'acceptance_unknown', retry: 'reconcile_first' }
    });
    const found = await provider.data.findRecordsByField({
      baseId: ids.baseId,
      tableId: ids.tableId,
      fieldId: ids.stableIdFieldId,
      value: 'task-c',
      limit: 2
    });
    expect(found.kind).toBe('success');
    if (found.kind === 'success') expect(found.value).toHaveLength(1);
  });

  test('models coalesced, duplicated, and reordered webhook wakes with ordered payloads', async () => {
    const provider = new FakeAirtableProvider();
    const ids = await provision(provider);
    const hook = await provider.webhooks.createWebhook({
      baseId: ids.baseId,
      notificationUrl: 'https://example.test/webhooks/airtable/opaque',
      tableIds: [ids.tableId],
      watchedFieldIds: [ids.statusFieldId],
      includePreviousValues: true
    });
    if (hook.kind === 'failure') throw new Error(hook.failure.code);

    provider.setNotificationMode('coalesce');
    for (const [stableId, status] of [['task-a', 'Open'], ['task-b', 'Done']] as const) {
      await provider.data.patchRecords({
        baseId: ids.baseId,
        tableId: ids.tableId,
        mergeOnFieldId: ids.stableIdFieldId,
        records: [{
          fields: {
            [ids.stableIdFieldId]: stableId,
            [ids.statusFieldId]: status
          }
        }]
      });
    }
    expect(provider.drainNotifications()).toHaveLength(1);

    provider.setNotificationMode('duplicate');
    await provider.data.patchRecords({
      baseId: ids.baseId,
      tableId: ids.tableId,
      mergeOnFieldId: ids.stableIdFieldId,
      records: [{
        fields: {
          [ids.stableIdFieldId]: 'task-c',
          [ids.statusFieldId]: 'Open'
        }
      }]
    });
    expect(provider.drainNotifications({ reverse: true })).toHaveLength(2);

    const payloads = await provider.webhooks.listWebhookPayloads({
      baseId: ids.baseId,
      webhookId: hook.value.webhookId
    });
    expect(payloads.kind).toBe('success');
    if (payloads.kind === 'success') {
      expect(payloads.value.payloads.map((payload) => payload.transactionNumber)).toEqual([1, 2, 3]);
      expect(String(payloads.value.cursor)).toBe('4');
    }
  });

  test('models grant revocation, rate-limit failure, and stable-ID schema drift', async () => {
    const provider = new FakeAirtableProvider();
    const ids = await provision(provider);
    provider.enqueueFault({
      operation: 'getBaseSchema',
      kind: 'failure',
      code: 'rate_limited',
      retry: 'after_delay',
      retryAfterMs: 30_000
    });
    expect(await provider.data.getBaseSchema({ baseId: ids.baseId })).toMatchObject({
      kind: 'failure',
      failure: { code: 'rate_limited', retryAfterMs: 30_000 }
    });

    const replacement = provider.replaceFieldForSchemaDrift({
      baseId: parseAirtableBaseId(ids.baseId),
      tableId: parseAirtableTableId(ids.tableId),
      fieldId: parseAirtableFieldId(ids.statusFieldId),
      name: 'Status'
    });
    expect(replacement).not.toBe(ids.statusFieldId);
    const schema = await provider.data.getBaseSchema({ baseId: ids.baseId });
    expect(schema.kind).toBe('success');
    if (schema.kind === 'success') {
      expect(schema.value.tables[0]?.fields.some((field) => field.id === ids.statusFieldId)).toBe(false);
      expect(schema.value.tables[0]?.fields.some((field) => field.id === replacement)).toBe(true);
    }

    provider.revokeGrant();
    expect(await provider.data.getBaseSchema({ baseId: ids.baseId })).toMatchObject({
      kind: 'failure',
      failure: { code: 'grant_revoked', retry: 'reconnect' }
    });
  });
});
