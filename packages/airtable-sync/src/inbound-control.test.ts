import { describe, expect, test } from 'bun:test';
import type { AirtableFieldId, AirtableRecordId, AirtableTableId } from '@jooevents/airtable';
import {
  applyControlledAirtableInbound,
  type AirtableControlledOperationPort,
  type AirtableInboundBoundaryPort
} from './inbound-control';
import type { AirtableShadowEvaluation, AirtableShadowSettleClaim } from './inbound-shadow';

const claim: AirtableShadowSettleClaim = {
  settleId: 'settle-1', connectionId: 'connection-1', mappingRevision: 2,
  providerTableId: 'tbl00000000000001' as AirtableTableId,
  providerRecordId: 'rec00000000000001' as AirtableRecordId,
  transactionNumber: 19, changeKind: 'updated', workerId: 'worker-1', leaseVersion: 1
};

function evaluation(fields: Array<Partial<AirtableShadowEvaluation['fields'][number]> & {
  fieldKey: string; disposition: AirtableShadowEvaluation['fields'][number]['disposition'];
}>): AirtableShadowEvaluation {
  const complete = fields.map((field, index) => ({
    fieldId: `fld0000000000000${index + 1}` as AirtableFieldId,
    mode: field.fieldKey.startsWith('task.') ? 'editable_in_airtable' as const : 'request_from_airtable' as const,
    dataClassification: 'ordinary' as const,
    base: null, local: null, remote: null, ...field
  }));
  return {
    fields: complete, hasConflict: complete.some((field) => field.disposition === 'conflict'),
    needsOutbound: false,
    wouldApplyInbound: complete.some((field) => field.disposition === 'apply_inbound'),
    wouldCreateRequest: complete.some((field) => field.disposition === 'create_request')
  };
}

function harness() {
  const calls: string[] = [];
  const operations: AirtableControlledOperationPort = {
    async setTaskAssignmentStatus(input) {
      calls.push(`task:${input.status}:${input.idempotencyKey}`);
      return { kind: 'applied', operationReceiptId: 'receipt-task' };
    },
    async setEngagementCancellationRequest(input) {
      calls.push(`cancellation:${input.requested}:${input.note ?? ''}:${input.idempotencyKey}`);
      return { kind: 'applied', operationReceiptId: 'receipt-request' };
    },
    async requestRecordDeletionReview() {
      calls.push('deletion');
      return { kind: 'applied', operationReceiptId: 'receipt-delete' };
    }
  };
  const boundary: AirtableInboundBoundaryPort = {
    async conflict(input) { calls.push(`conflict:${input.fieldKey}`); },
    async observation(input) { calls.push(`observation:${input.kind}:${input.fieldKey}`); },
    async restoreCanonical(input) { calls.push(`restore:${input.reason}`); }
  };
  return { calls, operations, boundary };
}

describe('controlled Airtable inbound allowlist', () => {
  test('applies only the exact task status operation and uses a stable transaction identity', async () => {
    const target = harness();
    const result = await applyControlledAirtableInbound({
      claim, recordLinkId: 'link-1',
      subject: { kind: 'task_assignment', id: 'assignment-1', expectedVersion: 4 },
      evaluation: evaluation([{
        fieldKey: 'task.status', disposition: 'apply_inbound',
        base: 'Open', local: 'Open', remote: 'Complete'
      }]),
      operations: target.operations, boundary: target.boundary
    });
    expect(result).toEqual({ kind: 'settled', applied: 1, requests: 0, conflicts: 0 });
    expect(target.calls).toEqual([
      'task:complete:connection-1:2:tbl00000000000001:rec00000000000001:19:1:task.assignment-status@1',
      'observation:applied:task.status'
    ]);
  });

  test('creates and withdraws a cancellation request without changing effective status', async () => {
    const create = harness();
    const created = await applyControlledAirtableInbound({
      claim, recordLinkId: 'link-2',
      subject: { kind: 'engagement', id: 'engagement-1', expectedVersion: 7 },
      evaluation: evaluation([
        { fieldKey: 'speaker.requested_status', disposition: 'create_request', remote: 'Cancelled' },
        { fieldKey: 'speaker.cancellation_note', disposition: 'create_request', remote: 'Travel changed' }
      ]),
      operations: create.operations, boundary: create.boundary
    });
    expect(created).toEqual({ kind: 'settled', applied: 0, requests: 1, conflicts: 0 });
    expect(create.calls[0]).toContain('cancellation:true:Travel changed:');

    const undo = harness();
    await applyControlledAirtableInbound({
      claim: { ...claim, transactionNumber: 20 }, recordLinkId: 'link-2',
      subject: { kind: 'engagement', id: 'engagement-1', expectedVersion: 8 },
      evaluation: evaluation([{
        fieldKey: 'speaker.requested_status', disposition: 'create_request',
        base: 'Cancelled', local: 'Cancelled', remote: null
      }]),
      operations: undo.operations, boundary: undo.boundary
    });
    expect(undo.calls[0]).toContain('cancellation:false::');
  });

  test('an undo before settle is inert, a conflict blocks writes, and deletion becomes review plus restore', async () => {
    const undone = harness();
    await applyControlledAirtableInbound({
      claim, recordLinkId: 'link-1', subject: { kind: 'task_assignment', id: 'a', expectedVersion: 1 },
      evaluation: evaluation([{ fieldKey: 'task.status', disposition: 'unchanged', remote: 'Open', local: 'Open', base: 'Open' }]),
      operations: undone.operations, boundary: undone.boundary
    });
    expect(undone.calls).toEqual([]);

    const conflict = harness();
    await applyControlledAirtableInbound({
      claim, recordLinkId: 'link-1', subject: { kind: 'task_assignment', id: 'a', expectedVersion: 2 },
      evaluation: evaluation([{ fieldKey: 'task.status', disposition: 'conflict', base: 'Open', local: 'Complete', remote: 'Open' }]),
      operations: conflict.operations, boundary: conflict.boundary
    });
    expect(conflict.calls).toEqual(['conflict:task.status']);

    const deletion = harness();
    await applyControlledAirtableInbound({
      claim: { ...claim, changeKind: 'destroyed' }, recordLinkId: 'link-1',
      subject: { kind: 'task_assignment', id: 'a', expectedVersion: 2 },
      evaluation: evaluation([]), operations: deletion.operations, boundary: deletion.boundary
    });
    expect(deletion.calls).toEqual(['deletion', 'restore:record_deleted']);
  });
});
