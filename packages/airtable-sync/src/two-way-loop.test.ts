import { describe, expect, test } from 'bun:test';
import {
  FakeAirtableProvider,
  type AirtableFieldId
} from '@jooevents/airtable';
import {
  applyControlledAirtableInbound,
  processOneControlledAirtableSettle,
  type AirtableControlledOperationPort,
  type AirtableInboundBoundaryPort
} from './inbound-control';
import {
  evaluateAirtableShadowRecord,
  type AirtableShadowEvaluation,
  type AirtableShadowSettleClaim
} from './inbound-shadow';
import { writeAirtableProjectionBatch } from './outbound';

describe('joined Airtable two-way loop', () => {
  test('a stable allowed edit applies once, projects back, and its webhook echo is inert', async () => {
    const provider = new FakeAirtableProvider();
    const workspaceId = provider.seedWorkspace({ id: 'wsp00000000000001', name: 'Events' });
    const created = await provider.data.createBase({
      workspaceId,
      name: 'JooEvents',
      tables: [{
        name: 'Tasks',
        fields: [
          { name: 'Task', type: 'singleLineText' },
          { name: 'Status', type: 'singleLineText' },
          { name: 'JooEvents ID', type: 'singleLineText' }
        ]
      }]
    });
    if (created.kind === 'failure') throw new Error(created.failure.code);
    const table = created.value.tables[0]!;
    const field = (name: string): AirtableFieldId => table.fields.find((candidate) =>
      candidate.name === name
    )!.id;
    const taskFieldId = field('Task');
    const statusFieldId = field('Status');
    const stableIdFieldId = field('JooEvents ID');
    const recordId = provider.seedRecord({
      baseId: created.value.id,
      tableId: table.id,
      fields: {
        [taskFieldId]: 'Confirm slides',
        [statusFieldId]: 'Open',
        [stableIdFieldId]: 'assignment-1'
      }
    });
    const edited = await provider.data.patchRecords({
      baseId: created.value.id,
      tableId: table.id,
      records: [{ recordId, fields: { [statusFieldId]: 'Complete' } }]
    });
    if (edited.kind === 'failure') throw new Error(edited.failure.code);

    const claim: AirtableShadowSettleClaim = {
      settleId: 'settle-1',
      connectionId: 'connection-1',
      mappingRevision: 1,
      providerTableId: table.id,
      providerRecordId: recordId,
      transactionNumber: 2,
      changeKind: 'updated',
      workerId: 'worker-1',
      leaseVersion: 1
    };
    const mappings = [{
      fieldKey: 'task.status',
      fieldId: statusFieldId,
      mode: 'editable_in_airtable' as const,
      dataClassification: 'ordinary' as const
    }];
    let localStatus = 'Open';
    let localVersion = 4;
    let domainWrites = 0;
    let firstEvaluation: AirtableShadowEvaluation | undefined;
    const operations: AirtableControlledOperationPort = {
      async setTaskAssignmentStatus(input) {
        expect(input).toMatchObject({
          assignmentId: 'assignment-1',
          expectedVersion: 4,
          status: 'complete'
        });
        domainWrites += 1;
        localStatus = 'Complete';
        localVersion += 1;
        return { kind: 'applied', operationReceiptId: 'receipt-1' };
      },
      async setEngagementCancellationRequest() {
        throw new Error('unexpected cancellation operation');
      },
      async requestRecordDeletionReview() {
        throw new Error('unexpected deletion operation');
      }
    };
    const boundary: AirtableInboundBoundaryPort = {
      async conflict() { throw new Error('unexpected conflict'); },
      async observation(input) {
        expect(input).toMatchObject({
          kind: 'applied',
          before: 'Open',
          after: 'Complete',
          operationReceiptId: 'receipt-1'
        });
      },
      async restoreCanonical() { throw new Error('unexpected restore'); }
    };
    expect(await processOneControlledAirtableSettle({
      connectionId: claim.connectionId,
      workerId: claim.workerId,
      nowMs: 10_000,
      provider: provider.data,
      operations,
      boundary,
      repository: {
        async claimNext() { return claim; },
        async resolveContext() {
          return {
            baseId: created.value.id,
            recordLinkId: 'link-1',
            mappings,
            baseline: { 'task.status': 'Open' },
            local: { 'task.status': localStatus },
            subject: {
              kind: 'task_assignment' as const,
              id: 'assignment-1',
              expectedVersion: localVersion
            }
          };
        },
        async complete(input) {
          if (input.outcome.kind === 'observed') firstEvaluation = input.outcome.evaluation;
          return true;
        }
      }
    })).toEqual({ kind: 'settled', settleId: 'settle-1' });
    expect(domainWrites).toBe(1);
    expect(firstEvaluation?.wouldApplyInbound).toBe(true);

    const outbound = await writeAirtableProjectionBatch({
      provider: provider.data,
      nowMs: 11_000,
      entries: [{
        claim: {
          workId: 'work-1',
          connectionId: claim.connectionId,
          mappingRevision: 1,
          areaKey: 'tasks',
          subjectKind: 'task_assignment',
          subjectId: 'assignment-1',
          requestedProjectionVersion: localVersion,
          workerId: 'worker-2',
          leaseVersion: 1
        },
        projection: {
          projectionVersion: localVersion,
          fingerprint: `assignment-${localVersion}`,
          fields: { 'task.status': localStatus }
        },
        target: {
          mappingRevision: 1,
          baseId: created.value.id,
          tableId: table.id,
          stableIdFieldId,
          fieldIds: { 'task.status': statusFieldId },
          providerRecordId: recordId
        }
      }]
    });
    expect(outbound[0]).toMatchObject({ kind: 'applied', providerRecordId: recordId });
    const reread = await provider.data.getRecord({
      baseId: created.value.id,
      tableId: table.id,
      recordId
    });
    if (reread.kind === 'failure') throw new Error(reread.failure.code);
    const echo = evaluateAirtableShadowRecord({
      mappings,
      baseline: { 'task.status': 'Open' },
      local: { 'task.status': localStatus },
      remote: reread.value.fields,
      lastOutbound: { 'task.status': localStatus }
    });
    expect(echo.fields).toEqual([expect.objectContaining({ disposition: 'echo' })]);

    expect(await applyControlledAirtableInbound({
      claim: { ...claim, transactionNumber: 3 },
      recordLinkId: 'link-1',
      subject: { kind: 'task_assignment', id: 'assignment-1', expectedVersion: localVersion },
      evaluation: echo,
      operations,
      boundary
    })).toEqual({ kind: 'settled', applied: 0, requests: 0, conflicts: 0 });
    expect(domainWrites).toBe(1);
  });
});
