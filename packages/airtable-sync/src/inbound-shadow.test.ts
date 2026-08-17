import { describe, expect, test } from 'bun:test';
import {
  parseAirtableBaseId,
  parseAirtableCursor,
  parseAirtableFieldId,
  parseAirtableRecordId,
  parseAirtableTableId,
  parseAirtableWebhookId,
  type AirtableWebhookPayload,
  type AirtableWebhookPort
} from '@jooevents/airtable';
import {
  processAirtableWebhookCursor,
  evaluateAirtableShadowRecord,
  processOneAirtableShadowSettle,
  type AirtableInboundCursorRepository,
  type AirtableInboundCursorState
} from './inbound-shadow';

const baseId = parseAirtableBaseId('app00000000000001');
const webhookId = parseAirtableWebhookId('ach00000000000001');
const tableId = parseAirtableTableId('tbl00000000000001');
const recordId = parseAirtableRecordId('rec00000000000001');
const fieldA = parseAirtableFieldId('fld00000000000001');
const fieldB = parseAirtableFieldId('fld00000000000002');

function payload(transactionNumber: number, fields: readonly string[]): AirtableWebhookPayload {
  return {
    transactionNumber,
    timestamp: `2026-08-17T00:00:${String(transactionNumber).padStart(2, '0')}.000Z`,
    source: 'client',
    changes: [{
      tableId,
      recordId,
      changedFieldIds: fields.map(parseAirtableFieldId),
      kind: 'updated'
    }]
  };
}

function harness(lastTransactionNumber = 0, cursor?: string) {
  let state: AirtableInboundCursorState = {
    connectionId: 'connection-1', mappingRevision: 1, baseId, webhookId, lastTransactionNumber,
    ...(cursor ? { cursor: parseAirtableCursor(cursor) } : {})
  };
  const commits: Parameters<AirtableInboundCursorRepository['commitPage']>[0][] = [];
  const repository: AirtableInboundCursorRepository = {
    async read() { return state; },
    async commitPage(input) {
      if (input.state.cursor !== state.cursor
        || input.state.lastTransactionNumber !== state.lastTransactionNumber) return false;
      commits.push(input);
      state = {
        ...state,
        cursor: input.nextCursor,
        lastTransactionNumber: input.nextTransactionNumber
      };
      return true;
    }
  };
  return { repository, commits, state: () => state };
}

function webhooks(pages: readonly {
  cursor: string;
  mightHaveMore: boolean;
  payloads: readonly AirtableWebhookPayload[];
}[]): AirtableWebhookPort {
  let index = 0;
  return {
    async createWebhook() { throw new Error('unused'); },
    async refreshWebhook() { throw new Error('unused'); },
    async deleteWebhook() { throw new Error('unused'); },
    async listWebhookPayloads() {
      const page = pages[index++];
      if (!page) throw new Error('unexpected page');
      return { kind: 'success', value: {
        cursor: parseAirtableCursor(page.cursor),
        mightHaveMore: page.mightHaveMore,
        payloads: page.payloads
      } };
    }
  };
}

describe('Airtable webhook cursor and settle scheduling', () => {
  test('orders transactions, reduces duplicate fragments, and commits each page with settle work', async () => {
    const trial = harness();
    expect(await processAirtableWebhookCursor({
      connectionId: 'connection-1', repository: trial.repository,
      webhooks: webhooks([{
        cursor: '3', mightHaveMore: false,
        payloads: [payload(2, [fieldB]), payload(1, [fieldA]), payload(2, [fieldA])]
      }]),
      nowMs: 10_000
    })).toEqual({ kind: 'processed', pages: 1, candidates: 1 });
    expect(trial.state()).toMatchObject({ cursor: '3', lastTransactionNumber: 2 });
    expect(trial.commits[0]?.candidates).toEqual([expect.objectContaining({
      transactionNumber: 2,
      changedFieldIds: [fieldA, fieldB]
    })]);
    expect(trial.commits[0]?.settleNotBeforeMs).toBe(13_000);
  });

  test('ignores replayed transactions and accepts a spurious empty ping as cursor progress', async () => {
    const trial = harness(2, '3');
    expect(await processAirtableWebhookCursor({
      connectionId: 'connection-1', repository: trial.repository,
      webhooks: webhooks([{
        cursor: '4', mightHaveMore: false, payloads: [payload(2, [fieldA])]
      }]),
      nowMs: 10_000
    })).toEqual({ kind: 'processed', pages: 1, candidates: 0 });
    expect(trial.commits[0]?.candidates).toEqual([]);
    expect(trial.state()).toMatchObject({ cursor: '4', lastTransactionNumber: 2 });
  });

  test('fences past a transaction gap for full retention recovery', async () => {
    const gap = harness(2, '3');
    expect(await processAirtableWebhookCursor({
      connectionId: 'connection-1', repository: gap.repository,
      webhooks: webhooks([{
        cursor: '5', mightHaveMore: false, payloads: [payload(4, [fieldA])]
      }]), nowMs: 10_000
    })).toEqual({ kind: 'retention_recovery_required' });
    const internalGap = harness(2, '3');
    expect(await processAirtableWebhookCursor({
      connectionId: 'connection-1', repository: internalGap.repository,
      webhooks: webhooks([{
        cursor: '6', mightHaveMore: false,
        payloads: [payload(3, [fieldA]), payload(5, [fieldB])]
      }]), nowMs: 10_000
    })).toEqual({ kind: 'retention_recovery_required' });
    expect(gap.commits).toHaveLength(1);
    expect(gap.commits[0]).toMatchObject({
      nextCursor: '5', nextTransactionNumber: 4, candidates: []
    });
    expect(internalGap.commits[0]).toMatchObject({
      nextCursor: '6', nextTransactionNumber: 5, candidates: []
    });

    const contended = harness(0);
    const repository: AirtableInboundCursorRepository = {
      ...contended.repository,
      async commitPage() { return false; }
    };
    expect(await processAirtableWebhookCursor({
      connectionId: 'connection-1', repository,
      webhooks: webhooks([{
        cursor: '1', mightHaveMore: false, payloads: [payload(1, [fieldA])]
      }]), nowMs: 10_000
    })).toEqual({ kind: 'contended' });
  });
});

describe('Airtable settled shadow comparison', () => {
  const mappings = [
    { fieldKey: 'task', fieldId: fieldA, mode: 'view_in_airtable', dataClassification: 'ordinary' },
    { fieldKey: 'status', fieldId: fieldB, mode: 'editable_in_airtable', dataClassification: 'ordinary' }
  ] as const;

  test('an edit undone before settle is unchanged and an Airtable-owned edit remains shadow-only', () => {
    const undone = evaluateAirtableShadowRecord({
      mappings,
      baseline: { task: 'Confirm slides', status: 'Open' },
      local: { task: 'Confirm slides', status: 'Open' },
      remote: { [fieldA]: 'Confirm slides', [fieldB]: 'Open' }
    });
    expect(undone.fields.map((field) => field.disposition)).toEqual(['unchanged', 'unchanged']);
    expect(undone.wouldApplyInbound).toBe(false);

    const changed = evaluateAirtableShadowRecord({
      mappings,
      baseline: { task: 'Confirm slides', status: 'Open' },
      local: { task: 'Confirm slides', status: 'Open' },
      remote: { [fieldA]: 'Confirm slides', [fieldB]: 'Done' }
    });
    expect(changed.fields.find((field) => field.fieldKey === 'status')?.disposition)
      .toBe('apply_inbound');
    expect(changed.wouldApplyInbound).toBe(true);
  });

  test('the settle processor re-reads once and can only complete an observation', async () => {
    const provider = new (await import('@jooevents/airtable')).FakeAirtableProvider();
    const workspace = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const created = await provider.data.createBase({
      workspaceId: workspace,
      name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [
        { name: 'Task', type: 'singleLineText' },
        { name: 'Status', type: 'singleLineText' }
      ] }]
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const table = created.value.tables[0]!;
    const remoteFieldA = table.fields[0]!.id;
    const remoteFieldB = table.fields[1]!.id;
    const remoteRecord = provider.seedRecord({
      baseId: created.value.id,
      tableId: table.id,
      fields: { [remoteFieldA]: 'Confirm slides', [remoteFieldB]: 'Done' }
    });
    const claim = {
      settleId: 'settle-1',
      connectionId: 'connection-1',
      mappingRevision: 1,
      providerTableId: table.id,
      providerRecordId: remoteRecord,
      transactionNumber: 2,
      changeKind: 'updated' as const,
      workerId: 'worker-1',
      leaseVersion: 1
    };
    let completed: unknown;
    expect(await processOneAirtableShadowSettle({
      connectionId: 'connection-1', workerId: 'worker-1', nowMs: 10_000,
      provider: provider.data,
      repository: {
        async claimNext() { return claim; },
        async resolveContext() {
          return {
            baseId: created.value.id,
            recordLinkId: 'link-1',
            mappings: [
              { ...mappings[0], fieldId: remoteFieldA },
              { ...mappings[1], fieldId: remoteFieldB }
            ],
            baseline: { task: 'Confirm slides', status: 'Open' },
            local: { task: 'Confirm slides', status: 'Open' }
          };
        },
        async complete(input) { completed = input.outcome; return true; }
      }
    })).toEqual({ kind: 'observed', settleId: 'settle-1' });
    expect(completed).toMatchObject({
      kind: 'observed', evaluation: { wouldApplyInbound: true }
    });
  });
});
