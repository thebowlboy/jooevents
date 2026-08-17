import { describe, expect, test } from 'bun:test';
import { FakeAirtableProvider } from '@jooevents/airtable';
import {
  airtableReconciliationCadence,
  assessAirtableRecordInventory,
  deriveAirtableSyncHealth,
  scanOneAirtableReconciliationPage,
  type AirtableReconciliationClaim
} from './reconciliation';

describe('Airtable reconciliation and health', () => {
  test('scans one bounded provider page into durable inventory before assessment', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const created = await provider.data.createBase({
      workspaceId,
      name: 'JooEvents',
      tables: [{ name: 'Tasks', fields: [
        { name: 'Task', type: 'singleLineText' },
        { name: 'JooEvents ID', type: 'singleLineText' }
      ] }]
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const table = created.value.tables[0]!;
    const stableIdFieldId = table.fields.find((field) => field.name === 'JooEvents ID')!.id;
    const taskFieldId = table.fields.find((field) => field.name === 'Task')!.id;
    await provider.data.patchRecords({
      baseId: created.value.id,
      tableId: table.id,
      mergeOnFieldId: stableIdFieldId,
      records: [{ fields: { [stableIdFieldId]: 'task-1', [taskFieldId]: 'Headshot' } }]
    });
    const claim: AirtableReconciliationClaim = {
      runId: 'run-1', connectionId: 'connection-1', mappingRevision: 1,
      areaKey: 'tasks', baseId: created.value.id, tableId: table.id,
      stableIdFieldId, comparedFieldIds: [taskFieldId],
      workerId: 'worker-1', leaseVersion: 1
    };
    const committed: unknown[] = [];
    expect(await scanOneAirtableReconciliationPage({
      connectionId: claim.connectionId,
      workerId: claim.workerId,
      nowMs: 1_000,
      repository: {
        async claimNext() { return claim; },
        async commitProviderPage(input) {
          committed.push(input);
          return 'ready_to_assess';
        },
        async fail() { return true; }
      },
      provider: provider.data,
      pageSize: 10
    })).toEqual({ kind: 'ready_to_assess', runId: 'run-1', records: 1 });
    expect(committed).toEqual([expect.objectContaining({
      records: [expect.objectContaining({
        subjectKey: 'task-1', providerFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })]
    })]);
  });

  test('finds missing, duplicates, changed record identities, and orphans by stable id', () => {
    expect(assessAirtableRecordInventory({
      links: [
        { recordLinkId: 'l1', subjectKey: 'a', providerRecordId: 'r1', baseline: {} },
        { recordLinkId: 'l2', subjectKey: 'b', providerRecordId: 'r2', baseline: {} },
        { recordLinkId: 'l3', subjectKey: 'c', providerRecordId: 'r3', baseline: {} }
      ],
      providerRecords: [
        { providerRecordId: 'r4', subjectKey: 'a', fields: {} },
        { providerRecordId: 'r5', subjectKey: 'b', fields: {} },
        { providerRecordId: 'r6', subjectKey: 'b', fields: {} },
        { providerRecordId: 'r7', subjectKey: 'z', fields: {} }
      ]
    }).map((finding) => finding.kind)).toEqual([
      'record_id_changed', 'duplicate', 'missing', 'orphan'
    ]);
  });

  test('multi-day outage becomes delayed and a repaired inventory returns current without duplicates', () => {
    expect(deriveAirtableSyncHealth({
      state: 'active', nowMs: 3 * 86_400_000, lastInboundAtMs: 1_000,
      dueWork: 4, conflicts: 0, requests: 0, schemaDrift: 0, deadLetters: 0
    })).toEqual({ state: 'delayed', attentionCount: 4, nextAction: 'wait' });
    expect(assessAirtableRecordInventory({
      links: [{ recordLinkId: 'l1', subjectKey: 'a', providerRecordId: 'r1', baseline: {} }],
      providerRecords: [{ providerRecordId: 'r1', subjectKey: 'a', fields: {} }]
    })).toEqual([]);
    expect(deriveAirtableSyncHealth({
      state: 'active', nowMs: 3 * 86_400_000, lastInboundAtMs: 3 * 86_400_000,
      dueWork: 0, conflicts: 0, requests: 0, schemaDrift: 0, deadLetters: 0
    }).state).toBe('current');
  });

  test('cadence repairs missing wakes and renews before webhook expiry', () => {
    expect(airtableReconciliationCadence({ nowMs: 100_000_000, webhookExpiresAtMs: 100_000_100 }))
      .toEqual({ lightweightDue: true, fullDue: true, renewalDue: true });
  });
});
