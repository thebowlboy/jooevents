import { AUTONOMY_DISPOSITIONS, type EffectfulOperationResult } from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import {
  isExactSealedDeniedEffectAuditOutcome,
  isSealedDeniedEffectAuditAttempt,
  isSealedInvocationContext,
  type DeniedEffectAuditAttempt,
  type InvocationContext
} from './invocation-context';
import type {
  ContextDeniedOperationAuditRecord,
  IdempotencyConflictOperationAuditRecord,
  NonterminalProgressOperationAuditRecord,
  NonterminalProgressReason,
  OperationAuditRecord,
  OperationAuditResultSummary,
  OperationAuditScope,
  OperationAuditRecordProfileRegistration,
  OperationAuditTargetRegistration,
  OrdinaryEffectOperationDefinition,
  TerminalNewOperationAuditRecord,
  TerminalReplayOperationAuditRecord
} from './types';

const sealedOperationAuditRecords = new WeakSet<object>();

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function auditTarget(reference: OrdinaryEffectOperationDefinition['audit']['target']) {
  if (!reference || typeof reference.key !== 'string' || reference.key.length === 0
    || !Number.isSafeInteger(reference.version) || reference.version <= 0) {
    throw new TypeError('invalid_operation_audit_target');
  }
  return Object.freeze({ key: reference.key, version: reference.version });
}

function boundedSortedReferences(values: readonly string[], label: string): readonly string[] {
  const normalized = [...new Set(values)].sort();
  if (normalized.length > 100 || normalized.some((value) => value.length === 0 || value.length > 256)) {
    throw new TypeError(`invalid_operation_audit_${label}`);
  }
  return Object.freeze(normalized);
}

function resultSummary(result: EffectfulOperationResult): OperationAuditResultSummary {
  return result.kind === 'success'
    ? Object.freeze({ kind: 'success', terminal: true })
    : Object.freeze({
        kind: 'outcome',
        outcomeClass: result.outcome.class,
        outcomeKind: result.outcome.kind,
        retryable: result.outcome.retryable,
        terminal: result.terminal
      });
}

function assertDeclaredOutcome(
  definition: OrdinaryEffectOperationDefinition,
  result: EffectfulOperationResult
): void {
  if (result.kind !== 'outcome') return;
  const declaration = definition.outcomes.find((candidate) => (
    candidate.class === result.outcome.class && candidate.kind === result.outcome.kind
  ));
  if (!declaration
    || declaration.retryable !== result.outcome.retryable
    || declaration.detailSchema.version !== result.outcome.detailSchemaVersion) {
    throw new TypeError('invalid_operation_audit_undeclared_outcome');
  }
}

function exactTerminalResult(input: {
  readonly result: EffectfulOperationResult;
  readonly receiptId: string;
  readonly definition: OrdinaryEffectOperationDefinition;
}): void {
  if ((input.result.kind === 'outcome' && input.result.terminal !== true)
    || input.result.receipt.id !== input.receiptId
    || input.result.receipt.operationName !== input.definition.name
    || input.result.receipt.operationVersion !== input.definition.version) {
    throw new TypeError('invalid_operation_audit_terminal_result');
  }
}

function exactIdempotencyConflictResult(result: EffectfulOperationResult): void {
  if (result.kind !== 'outcome'
    || result.terminal !== false
    || result.outcome.class !== 'idempotency_conflict'
    || result.outcome.kind !== 'operation.request_changed'
    || result.outcome.retryable !== false
    || result.outcome.subjects.length !== 0
    || result.outcome.detail !== null) {
    throw new TypeError('invalid_operation_audit_idempotency_conflict_result');
  }
}

function exactContextDeniedResult(result: EffectfulOperationResult): void {
  if (result.kind !== 'outcome'
    || result.terminal !== false
    || result.outcome.class !== 'access_denied') {
    throw new TypeError('invalid_operation_audit_context_denied_result');
  }
}

function exactReason(
  reason: NonterminalProgressReason,
  result: EffectfulOperationResult
): NonterminalProgressReason {
  if (result.kind !== 'outcome' || result.terminal !== false
    || !reason || typeof reason !== 'object' || Array.isArray(reason)) {
    throw new TypeError('invalid_nonterminal_progress_result');
  }
  const candidate = reason as unknown as Record<string, unknown>;
  if (candidate.kind === 'autonomy_intervention') {
    if (Object.keys(candidate).sort().join(',') !== 'autonomyDisposition,kind'
      || typeof candidate.autonomyDisposition !== 'string'
      || candidate.autonomyDisposition === 'proceed'
      || !AUTONOMY_DISPOSITIONS.includes(candidate.autonomyDisposition as never)
      || result.outcome.class !== 'policy_violation'
      || result.outcome.kind !== `autonomy.${candidate.autonomyDisposition}`) {
      throw new TypeError('invalid_nonterminal_progress_reason');
    }
    return Object.freeze({
      kind: 'autonomy_intervention',
      autonomyDisposition: candidate.autonomyDisposition
    }) as NonterminalProgressReason;
  }
  if (candidate.kind === 'same_request_contended') {
    if (Object.keys(candidate).length !== 1
      || result.outcome.class !== 'conflict'
      || result.outcome.kind !== 'operation.in_progress'
      || result.outcome.retryable !== true) {
      throw new TypeError('invalid_nonterminal_progress_reason');
    }
    return Object.freeze({ kind: 'same_request_contended' });
  }
  if (candidate.kind === 'phase_nonterminal' && Object.keys(candidate).length === 1) {
    return Object.freeze({ kind: 'phase_nonterminal' });
  }
  throw new TypeError('invalid_nonterminal_progress_reason');
}

function operationMetadata(
  definition: OrdinaryEffectOperationDefinition,
  target: OperationAuditTargetRegistration,
  recordProfile: OperationAuditRecordProfileRegistration,
  operation: DeniedEffectAuditAttempt['operation']
) {
  if (definition.name !== operation.name
    || definition.version !== operation.version
    || definition.effect !== operation.effect) {
    throw new TypeError('operation_audit_definition_mismatch');
  }
  if (definition.audit.target.key !== target.reference.key
    || definition.audit.target.version !== target.reference.version
    || target.kind !== 'operation_audit_record') {
    throw new TypeError('operation_audit_target_mismatch');
  }
  if (target.recordProfile.key !== recordProfile.reference.key
    || target.recordProfile.version !== recordProfile.reference.version
    || recordProfile.kind !== 'canonical_json') {
    throw new TypeError('operation_audit_record_profile_mismatch');
  }
  return {
    operation: { ...operation },
    maxRisk: definition.maxRisk,
    autonomyPolicy: { ...definition.autonomyPolicy },
    consequenceTags: Object.freeze([...new Set(definition.consequenceTags)].sort()),
    auditTarget: auditTarget(target.reference),
    auditRecordProfile: auditTarget(recordProfile.reference)
  } as const;
}

function auditScope(scope: InvocationContext['scope'] | DeniedEffectAuditAttempt['scope']): OperationAuditScope {
  return deepFreeze({
    workspaceId: scope.workspaceId,
    ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
    subjects: scope.subjects.map((subject) => ({ ...subject }))
  });
}

function seal<RecordType extends OperationAuditRecord>(
  record: RecordType,
  profile: OperationAuditRecordProfileRegistration
): RecordType {
  if (new TextEncoder().encode(canonicalJsonText(record)).byteLength > profile.maximumBytes) {
    throw new TypeError('operation_audit_record_too_large');
  }
  const sealed = deepFreeze(record);
  sealedOperationAuditRecords.add(sealed);
  return sealed;
}

function authorizedBase(input: {
  readonly context: InvocationContext;
  readonly definition: OrdinaryEffectOperationDefinition;
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly auditRecordProfile: OperationAuditRecordProfileRegistration;
  readonly result: EffectfulOperationResult;
}) {
  const { context } = input;
  if (!isSealedInvocationContext(context) || context.operation.effect === 'read') {
    throw new TypeError('unsealed_operation_audit_context');
  }
  assertDeclaredOutcome(input.definition, input.result);
  const operation: DeniedEffectAuditAttempt['operation'] = {
    name: context.operation.name,
    version: context.operation.version,
    effect: context.operation.effect
  };
  return {
    eventId: context.invocationId,
    ...operationMetadata(input.definition, input.auditTarget, input.auditRecordProfile, operation),
    surface: context.surface,
    accessLane: context.authority.lane,
    correlationId: context.correlationId,
    recordedAt: context.receivedAt,
    client: { ...context.client },
    provenance: { ...context.provenance },
    scope: auditScope(context.scope),
    scopeResolutionEvidenceIds: boundedSortedReferences(
      context.scope.resolutionEvidenceIds,
      'scope_resolution_evidence'
    ),
    resultSummary: resultSummary(input.result),
    actor: { ...context.actor },
    authorityPrincipalKey: context.authorityPrincipalKey,
    authorityEvidenceIds: boundedSortedReferences(context.authority.evidenceIds, 'authority_evidence'),
    authorityCitationIds: boundedSortedReferences(
      context.authority.authorityCitationIds,
      'authority_citations'
    )
  } as const;
}

export function createTerminalNewOperationAuditRecord(input: {
  readonly context: InvocationContext;
  readonly definition: OrdinaryEffectOperationDefinition;
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly auditRecordProfile: OperationAuditRecordProfileRegistration;
  readonly result: EffectfulOperationResult;
  readonly receiptId: string;
}): TerminalNewOperationAuditRecord {
  if (typeof input.receiptId !== 'string' || input.receiptId.length === 0) {
    throw new TypeError('invalid_operation_audit_receipt');
  }
  exactTerminalResult({ result: input.result, receiptId: input.receiptId, definition: input.definition });
  return seal<TerminalNewOperationAuditRecord>({
    ...authorizedBase(input),
    disposition: 'terminal_new',
    receiptId: input.receiptId
  }, input.auditRecordProfile);
}

export function createTerminalReplayOperationAuditRecord(input: {
  readonly context: InvocationContext;
  readonly definition: OrdinaryEffectOperationDefinition;
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly auditRecordProfile: OperationAuditRecordProfileRegistration;
  readonly result: EffectfulOperationResult;
  readonly relatedReceiptId: string;
}): TerminalReplayOperationAuditRecord {
  if (typeof input.relatedReceiptId !== 'string' || input.relatedReceiptId.length === 0) {
    throw new TypeError('invalid_operation_audit_receipt');
  }
  exactTerminalResult({
    result: input.result,
    receiptId: input.relatedReceiptId,
    definition: input.definition
  });
  return seal<TerminalReplayOperationAuditRecord>({
    ...authorizedBase(input),
    disposition: 'terminal_replay',
    relatedReceiptId: input.relatedReceiptId
  }, input.auditRecordProfile);
}

export function createIdempotencyConflictOperationAuditRecord(input: {
  readonly context: InvocationContext;
  readonly definition: OrdinaryEffectOperationDefinition;
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly auditRecordProfile: OperationAuditRecordProfileRegistration;
  readonly result: EffectfulOperationResult;
}): IdempotencyConflictOperationAuditRecord {
  exactIdempotencyConflictResult(input.result);
  return seal<IdempotencyConflictOperationAuditRecord>({
    ...authorizedBase(input),
    disposition: 'idempotency_conflict'
  }, input.auditRecordProfile);
}

export function createNonterminalProgressOperationAuditRecord(input: {
  readonly context: InvocationContext;
  readonly definition: OrdinaryEffectOperationDefinition;
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly auditRecordProfile: OperationAuditRecordProfileRegistration;
  readonly result: EffectfulOperationResult;
  readonly reason: NonterminalProgressReason;
}): NonterminalProgressOperationAuditRecord {
  return seal<NonterminalProgressOperationAuditRecord>({
    ...authorizedBase(input),
    disposition: 'nonterminal_progress',
    reason: exactReason(input.reason, input.result)
  }, input.auditRecordProfile);
}

export function createContextDeniedOperationAuditRecord(input: {
  readonly attempt: DeniedEffectAuditAttempt;
  readonly definition: OrdinaryEffectOperationDefinition;
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly auditRecordProfile: OperationAuditRecordProfileRegistration;
  readonly result: EffectfulOperationResult;
}): ContextDeniedOperationAuditRecord {
  if (!isSealedDeniedEffectAuditAttempt(input.attempt)) {
    throw new TypeError('unsealed_operation_audit_attempt');
  }
  exactContextDeniedResult(input.result);
  assertDeclaredOutcome(input.definition, input.result);
  if (input.result.kind !== 'outcome' || !isExactSealedDeniedEffectAuditOutcome({
    attempt: input.attempt,
    outcome: input.result.outcome
  })) {
    throw new TypeError('invalid_operation_audit_context_denied_result');
  }
  const attempt = input.attempt;
  return seal<ContextDeniedOperationAuditRecord>({
    eventId: attempt.invocationId,
    disposition: 'context_denied',
    ...operationMetadata(
      input.definition,
      input.auditTarget,
      input.auditRecordProfile,
      attempt.operation
    ),
    surface: attempt.surface,
    accessLane: attempt.accessLane,
    correlationId: attempt.correlationId,
    recordedAt: attempt.receivedAt,
    client: { ...attempt.client },
    provenance: { ...attempt.provenance },
    scope: auditScope(attempt.scope),
    scopeResolutionEvidenceIds: boundedSortedReferences(
      attempt.scopeResolutionEvidenceIds,
      'scope_resolution_evidence'
    ),
    resultSummary: resultSummary(input.result),
    denialReason: attempt.denialReason
  }, input.auditRecordProfile);
}

export function isSealedOperationAuditRecord(value: unknown): value is OperationAuditRecord {
  return typeof value === 'object' && value !== null && sealedOperationAuditRecords.has(value);
}
