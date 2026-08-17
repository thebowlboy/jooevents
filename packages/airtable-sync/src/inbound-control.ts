import { canonicalJsonText, type CanonicalJson } from '@jooevents/kernel';
import type { AirtableShadowEvaluation, AirtableShadowSettleClaim } from './inbound-shadow';
import { evaluateAirtableShadowRecord, type AirtableShadowSettleRepository } from './inbound-shadow';
import type { AirtableDataPort } from '@jooevents/airtable';
import {
  AIRTABLE_INBOUND_OPERATION_KEYS,
  AIRTABLE_REQUEST_CONTRACT_KEYS
} from './inbound-policy';
import {
  airtableControlledInboundFeatureContextSchema,
  type AirtableControlledInboundFeatureContext
} from './operation-contribution';

export interface AirtableInboundSubject {
  readonly kind: 'task_assignment' | 'engagement';
  readonly id: string;
  readonly expectedVersion: number;
}

export type AirtableInboundOperationResult =
  | { readonly kind: 'applied'; readonly operationReceiptId?: string; readonly boundaryRecorded?: boolean }
  | { readonly kind: 'already_current'; readonly operationReceiptId?: string }
  | { readonly kind: 'retry'; readonly code: string; readonly retryAfterMs: number }
  | { readonly kind: 'refused'; readonly code: string };

/**
 * Narrow application-operation port. Implementations bind these methods to the
 * named registered operations; there is deliberately no generic operation name,
 * action, transform, or payload supplied by Airtable.
 */
export interface AirtableControlledOperationPort {
  setTaskAssignmentStatus(input: Readonly<{
    assignmentId: string;
    expectedVersion: number;
    status: 'complete' | 'open';
    idempotencyKey: string;
    featureContext?: AirtableControlledInboundFeatureContext;
  }>): Promise<AirtableInboundOperationResult>;
  setEngagementCancellationRequest(input: Readonly<{
    engagementId: string;
    expectedVersion: number;
    requested: boolean;
    note?: string;
    idempotencyKey: string;
    featureContext?: AirtableControlledInboundFeatureContext;
  }>): Promise<AirtableInboundOperationResult>;
  requestRecordDeletionReview(input: Readonly<{
    subject: AirtableInboundSubject;
    idempotencyKey: string;
  }>): Promise<AirtableInboundOperationResult>;
}

export interface AirtableInboundBoundaryPort {
  conflict(input: Readonly<{
    claim: AirtableShadowSettleClaim;
    recordLinkId: string;
    fieldKey: string;
    base: CanonicalJson;
    local: CanonicalJson;
    remote: CanonicalJson;
    classification: 'ordinary' | 'personal' | 'sensitive' | 'classified';
  }>): Promise<void>;
  observation(input: Readonly<{
    claim: AirtableShadowSettleClaim;
    recordLinkId: string;
    fieldKey: string;
    kind: 'applied' | 'request' | 'refused_restored';
    before: CanonicalJson;
    after: CanonicalJson;
    operationReceiptId?: string;
    classification: 'ordinary' | 'personal' | 'sensitive' | 'classified';
  }>): Promise<void>;
  restoreCanonical(input: Readonly<{
    claim: AirtableShadowSettleClaim;
    recordLinkId: string;
    reason: 'protected_edit' | 'invalid_value' | 'record_deleted';
  }>): Promise<void>;
}

export type ControlledInboundResult =
  | { readonly kind: 'settled'; readonly applied: number; readonly requests: number; readonly conflicts: number }
  | { readonly kind: 'retry'; readonly code: string; readonly retryAfterMs: number }
  | { readonly kind: 'attention'; readonly code: string };

function textValue(value: CanonicalJson): string | undefined {
  if (value === null) return undefined;
  return typeof value === 'string' ? value.normalize('NFC').trim() : undefined;
}

function changed(finding: AirtableShadowEvaluation['fields'][number]): boolean {
  return finding.disposition === 'apply_inbound' || finding.disposition === 'create_request';
}

function operationFailure(result: AirtableInboundOperationResult): ControlledInboundResult | undefined {
  if (result.kind === 'retry') return result;
  if (result.kind === 'refused') return { kind: 'attention', code: result.code };
  return undefined;
}

function receiptId(result: AirtableInboundOperationResult): string | undefined {
  return result.kind === 'applied' || result.kind === 'already_current'
    ? result.operationReceiptId
    : undefined;
}

function controlledFeatureContext(input: Readonly<{
  claim: AirtableShadowSettleClaim;
  recordLinkId: string;
  observations: readonly Readonly<{
    fieldKey: string;
    kind: 'applied' | 'request';
    classification: 'ordinary' | 'personal' | 'sensitive';
    before: CanonicalJson;
    after: CanonicalJson;
  }>[];
}>): AirtableControlledInboundFeatureContext {
  return airtableControlledInboundFeatureContextSchema.parse({
    schemaVersion: 1,
    kind: 'airtable_controlled_inbound',
    observations: input.observations.map((observation) => ({
      connectionId: input.claim.connectionId,
      recordLinkId: input.recordLinkId,
      ...observation,
      ...(input.claim.providerActor?.id ? { providerActorId: input.claim.providerActor.id } : {}),
      ...(input.claim.providerActor?.email ? { providerActorEmail: input.claim.providerActor.email } : {}),
      ...(input.claim.providerActor?.displayName
        ? { providerActorDisplayName: input.claim.providerActor.displayName }
        : {}),
      observedAtMs: input.claim.observedAtMs ?? 0
    }))
  });
}

/** Applies one already re-read, three-way-evaluated record through the finite S4 ceiling. */
export async function applyControlledAirtableInbound(input: Readonly<{
  claim: AirtableShadowSettleClaim;
  recordLinkId: string;
  subject: AirtableInboundSubject;
  evaluation: AirtableShadowEvaluation;
  operations: AirtableControlledOperationPort;
  boundary: AirtableInboundBoundaryPort;
}>): Promise<ControlledInboundResult> {
  let applied = 0;
  let requests = 0;
  let conflicts = 0;
  const stableKey = `${input.claim.connectionId}:${input.claim.mappingRevision}:${input.claim.providerTableId}:${input.claim.providerRecordId}:${input.claim.transactionNumber}:${input.claim.settleRevision ?? 1}`;

  for (const field of input.evaluation.fields) {
    if (field.disposition === 'conflict') {
      await input.boundary.conflict({
        claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: field.fieldKey,
        base: field.base, local: field.local, remote: field.remote
        , classification: field.dataClassification
      });
      conflicts += 1;
    } else if (field.disposition === 'restore' || field.disposition === 'forbidden') {
      await input.boundary.observation({
        claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: field.fieldKey,
        kind: 'refused_restored', before: field.remote, after: field.local
        , classification: field.dataClassification
      });
      await input.boundary.restoreCanonical({
        claim: input.claim, recordLinkId: input.recordLinkId, reason: 'protected_edit'
      });
    }
  }
  if (conflicts > 0) return { kind: 'settled', applied, requests, conflicts };

  if (input.claim.changeKind === 'destroyed') {
    const result = await input.operations.requestRecordDeletionReview({
      subject: input.subject, idempotencyKey: `${stableKey}:deletion`
    });
    const failure = operationFailure(result);
    if (failure) return failure;
    await input.boundary.restoreCanonical({
      claim: input.claim, recordLinkId: input.recordLinkId, reason: 'record_deleted'
    });
    return { kind: 'settled', applied, requests: requests + 1, conflicts };
  }

  const taskStatus = input.evaluation.fields.find((field) =>
    field.fieldKey === 'task.status' && changed(field)
  );
  if (taskStatus) {
    if (input.subject.kind !== 'task_assignment') return { kind: 'attention', code: 'task_subject_mismatch' };
    const value = textValue(taskStatus.remote)?.toLocaleLowerCase('en-US');
    const status = value === 'complete' ? 'complete' : value === 'open' ? 'open' : undefined;
    if (!status) {
      await input.boundary.observation({
        claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: taskStatus.fieldKey,
        kind: 'refused_restored', before: taskStatus.remote, after: taskStatus.local
        , classification: taskStatus.dataClassification
      });
      await input.boundary.restoreCanonical({
        claim: input.claim, recordLinkId: input.recordLinkId, reason: 'invalid_value'
      });
    } else {
      const result = await input.operations.setTaskAssignmentStatus({
        assignmentId: input.subject.id, expectedVersion: input.subject.expectedVersion,
        status, idempotencyKey: `${stableKey}:${AIRTABLE_INBOUND_OPERATION_KEYS.taskAssignmentStatus}`,
        featureContext: controlledFeatureContext({
          claim: input.claim,
          recordLinkId: input.recordLinkId,
          observations: [{
            fieldKey: taskStatus.fieldKey,
            kind: 'applied',
            classification: taskStatus.dataClassification as 'ordinary' | 'personal' | 'sensitive',
            before: taskStatus.local,
            after: taskStatus.remote
          }]
        })
      });
      const failure = operationFailure(result);
      if (failure) return failure;
      const operationReceiptId = receiptId(result);
      if (result.kind !== 'applied' || !result.boundaryRecorded) {
        await input.boundary.observation({
          claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: taskStatus.fieldKey,
          kind: 'applied', before: taskStatus.local, after: taskStatus.remote,
          classification: taskStatus.dataClassification,
          ...(operationReceiptId ? { operationReceiptId } : {})
        });
      }
      if (result.kind === 'applied') applied += 1;
    }
  }

  const requestFields = input.evaluation.fields.filter((field) =>
    (field.fieldKey === 'speaker.requested_status' || field.fieldKey === 'speaker.cancellation_note')
    && changed(field)
  );
  if (requestFields.length > 0) {
    if (input.subject.kind !== 'engagement') return { kind: 'attention', code: 'engagement_subject_mismatch' };
    const statusField = input.evaluation.fields.find((field) => field.fieldKey === 'speaker.requested_status');
    const noteField = input.evaluation.fields.find((field) => field.fieldKey === 'speaker.cancellation_note');
    const statusText = statusField ? textValue(statusField.remote)?.toLocaleLowerCase('en-US') : undefined;
    if (statusText !== undefined && statusText !== 'cancelled') {
      await input.boundary.restoreCanonical({
        claim: input.claim, recordLinkId: input.recordLinkId, reason: 'invalid_value'
      });
      return { kind: 'attention', code: 'cancellation_request_value_invalid' };
    }
    const note = noteField ? textValue(noteField.remote) : undefined;
    if (note && note.length > 500) return { kind: 'attention', code: 'cancellation_note_too_long' };
    const result = await input.operations.setEngagementCancellationRequest({
      engagementId: input.subject.id, expectedVersion: input.subject.expectedVersion,
      requested: statusText === 'cancelled', ...(note ? { note } : {}),
      idempotencyKey: `${stableKey}:${AIRTABLE_REQUEST_CONTRACT_KEYS.engagementCancellation}`,
      featureContext: controlledFeatureContext({
        claim: input.claim,
        recordLinkId: input.recordLinkId,
        observations: requestFields.map((field) => ({
          fieldKey: field.fieldKey,
          kind: 'request' as const,
          classification: field.dataClassification as 'ordinary' | 'personal' | 'sensitive',
          before: field.local,
          after: field.remote
        }))
      })
    });
    const failure = operationFailure(result);
    if (failure) return failure;
    const operationReceiptId = receiptId(result);
    if (result.kind !== 'applied' || !result.boundaryRecorded) {
      for (const field of requestFields) {
        await input.boundary.observation({
          claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: field.fieldKey,
          kind: 'request', before: field.local, after: field.remote,
          classification: field.dataClassification,
          ...(operationReceiptId ? { operationReceiptId } : {})
        });
      }
    }
    if (result.kind === 'applied') requests += 1;
  }

  // Prove no unrecognized mapped field can accidentally select a mutation.
  for (const field of input.evaluation.fields) {
    if (changed(field) && field !== taskStatus && !requestFields.includes(field)) {
      await input.boundary.restoreCanonical({
        claim: input.claim, recordLinkId: input.recordLinkId, reason: 'protected_edit'
      });
      if (canonicalJsonText(field.remote) !== canonicalJsonText(field.local)) {
        await input.boundary.observation({
          claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: field.fieldKey,
          kind: 'refused_restored', before: field.remote, after: field.local
          , classification: field.dataClassification
        });
      }
    }
  }
  return { kind: 'settled', applied, requests, conflicts };
}

export type ControlledSettleResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'settled' | 'retry_scheduled' | 'attention' | 'lost_fence'; readonly settleId: string };

async function applyProtectedSubjectlessRecord(input: Readonly<{
  claim: AirtableShadowSettleClaim;
  recordLinkId: string;
  evaluation: AirtableShadowEvaluation;
  boundary: AirtableInboundBoundaryPort;
}>): Promise<ControlledInboundResult> {
  let conflicts = 0;
  if (input.claim.changeKind === 'destroyed') {
    await input.boundary.observation({
      claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: 'record.deleted',
      kind: 'request', before: Object.freeze({ deleted: false }),
      after: Object.freeze({ deleted: true }), classification: 'ordinary'
    });
    await input.boundary.restoreCanonical({
      claim: input.claim, recordLinkId: input.recordLinkId, reason: 'record_deleted'
    });
    return { kind: 'settled', applied: 0, requests: 1, conflicts: 0 };
  }
  for (const field of input.evaluation.fields) {
    if (field.disposition === 'apply_inbound' || field.disposition === 'create_request') {
      return { kind: 'attention', code: 'controlled_subject_missing' };
    }
    if (field.disposition === 'conflict') {
      await input.boundary.conflict({
        claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: field.fieldKey,
        base: field.base, local: field.local, remote: field.remote,
        classification: field.dataClassification
      });
      conflicts += 1;
    } else if (field.disposition === 'restore' || field.disposition === 'forbidden') {
      await input.boundary.observation({
        claim: input.claim, recordLinkId: input.recordLinkId, fieldKey: field.fieldKey,
        kind: 'refused_restored', before: field.remote, after: field.local,
        classification: field.dataClassification
      });
      await input.boundary.restoreCanonical({
        claim: input.claim, recordLinkId: input.recordLinkId, reason: 'protected_edit'
      });
    }
  }
  return { kind: 'settled', applied: 0, requests: 0, conflicts };
}

/** Durable settle runner used after the S4 allowlist is explicitly enabled. */
export async function processOneControlledAirtableSettle(input: Readonly<{
  connectionId: string;
  workerId: string;
  nowMs: number;
  repository: AirtableShadowSettleRepository;
  provider: AirtableDataPort;
  operations?: AirtableControlledOperationPort;
  operationsForClaim?(claim: AirtableShadowSettleClaim): AirtableControlledOperationPort;
  boundary: AirtableInboundBoundaryPort;
}>): Promise<ControlledSettleResult> {
  const claim = await input.repository.claimNext({
    connectionId: input.connectionId, workerId: input.workerId, nowMs: input.nowMs
  });
  if (!claim) return { kind: 'idle' };
  const operations = input.operationsForClaim?.(claim) ?? input.operations;
  if (!operations || (input.operations !== undefined && input.operationsForClaim !== undefined)) {
    throw new TypeError('airtable_controlled_operations_binding_invalid');
  }
  const context = await input.repository.resolveContext(claim);
  if (!context) {
    const completed = await input.repository.complete({
      claim, outcome: { kind: 'attention', code: 'controlled_context_missing' }, nowMs: input.nowMs
    });
    return { kind: completed ? 'attention' : 'lost_fence', settleId: claim.settleId };
  }
  const reread = await input.provider.getRecord({
    baseId: context.baseId, tableId: claim.providerTableId, recordId: claim.providerRecordId
  });
  if (reread.kind === 'failure' && !(claim.changeKind === 'destroyed' && reread.failure.code === 'not_found')) {
    const outcome = reread.failure.retry === 'after_delay'
      ? { kind: 'retry' as const, code: reread.failure.code, notBeforeMs: input.nowMs + Math.max(1_000, Math.min(reread.failure.retryAfterMs ?? 30_000, 86_400_000)) }
      : { kind: 'attention' as const, code: reread.failure.code };
    const completed = await input.repository.complete({ claim, outcome, nowMs: input.nowMs });
    return {
      kind: completed ? (outcome.kind === 'retry' ? 'retry_scheduled' : 'attention') : 'lost_fence',
      settleId: claim.settleId
    };
  }
  const evaluation = evaluateAirtableShadowRecord({
    mappings: context.mappings, baseline: context.baseline, local: context.local,
    remote: reread.kind === 'success' ? reread.value.fields : Object.freeze({}),
    ...(context.lastOutbound ? { lastOutbound: context.lastOutbound } : {})
  });
  const controlled = context.subject
    ? await applyControlledAirtableInbound({
        claim, recordLinkId: context.recordLinkId, subject: context.subject,
        evaluation, operations, boundary: input.boundary
      })
    : await applyProtectedSubjectlessRecord({
        claim, recordLinkId: context.recordLinkId, evaluation, boundary: input.boundary
      });
  const outcome = controlled.kind === 'retry'
    ? { kind: 'retry' as const, code: controlled.code, notBeforeMs: input.nowMs + controlled.retryAfterMs }
    : controlled.kind === 'attention'
      ? { kind: 'attention' as const, code: controlled.code }
      : { kind: 'observed' as const, evaluation };
  const completed = await input.repository.complete({ claim, outcome, nowMs: input.nowMs });
  return {
    kind: completed
      ? outcome.kind === 'retry' ? 'retry_scheduled' : outcome.kind === 'attention' ? 'attention' : 'settled'
      : 'lost_fence',
    settleId: claim.settleId
  };
}
