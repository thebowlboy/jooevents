import type { OperationSurface } from '@jooevents/contracts';
import { canonicalJsonText, type CorrelationId, type Instant, type InvocationId } from '@jooevents/kernel';
import {
  isSealedDeniedReadObservationAttempt,
  isSealedInvocationContext,
  type DeniedReadObservationAttempt,
  type InvocationContext
} from './invocation-context';
import type {
  OperationAuditRecordProfileRegistration,
  OperationAuditScope,
  OperationAuditTargetRegistration,
  ReadImmutableAuditRecord,
  ReadObservationResultSummary,
  ReadOperationalTraceRecord,
  ReadOperationalTraceTargetRegistration,
  ReadOperationDefinition
} from './types';

const sealedReadOperationalTraceRecords = new WeakSet<object>();
const sealedReadImmutableAuditRecords = new WeakSet<object>();

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function boundedSortedReferences(values: readonly string[], label: string): readonly string[] {
  const normalized = [...new Set(values)].sort();
  if (normalized.length > 100 || normalized.some((value) => value.length === 0 || value.length > 256)) {
    throw new TypeError(`invalid_read_observation_${label}`);
  }
  return Object.freeze(normalized);
}

function observationScope(
  scope: InvocationContext['scope'] | DeniedReadObservationAttempt['scope']
): OperationAuditScope {
  return deepFreeze({
    workspaceId: scope.workspaceId,
    ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
    subjects: scope.subjects.map((subject) => ({ ...subject }))
  });
}

function operationMetadata(definition: ReadOperationDefinition) {
  if (definition.effect !== 'read') throw new TypeError('read_observation_effect_mismatch');
  return {
    operation: { name: definition.name, version: definition.version, effect: 'read' as const },
    maxRisk: definition.maxRisk,
    autonomyPolicy: { ...definition.autonomyPolicy },
    consequenceTags: Object.freeze([...new Set(definition.consequenceTags)].sort())
  };
}

function authorizedBase(input: {
  readonly definition: ReadOperationDefinition;
  readonly context: InvocationContext;
  readonly resultSummary: ReadObservationResultSummary;
}) {
  if (!isSealedInvocationContext(input.context)
    || input.context.operation.effect !== 'read'
    || input.context.operation.name !== input.definition.name
    || input.context.operation.version !== input.definition.version) {
    throw new TypeError('unsealed_read_observation_context');
  }
  const { context } = input;
  return {
    ...operationMetadata(input.definition),
    eventId: context.invocationId,
    disposition: 'authorized' as const,
    surface: context.surface,
    accessLane: context.authority.lane,
    correlationId: context.correlationId,
    recordedAt: context.receivedAt,
    client: { ...context.client },
    provenance: { ...context.provenance },
    scope: observationScope(context.scope),
    scopeResolutionEvidenceIds: boundedSortedReferences(
      context.scope.resolutionEvidenceIds,
      'scope_resolution_evidence'
    ),
    resultSummary: { ...input.resultSummary },
    actor: { ...context.actor },
    authorityEvidenceIds: boundedSortedReferences(context.authority.evidenceIds, 'authority_evidence'),
    authorityCitationIds: boundedSortedReferences(
      context.authority.authorityCitationIds,
      'authority_citations'
    )
  };
}

function deniedBase(input: {
  readonly definition: ReadOperationDefinition;
  readonly attempt: DeniedReadObservationAttempt;
  readonly resultSummary: ReadObservationResultSummary;
}) {
  if (!isSealedDeniedReadObservationAttempt(input.attempt)
    || input.attempt.operation.name !== input.definition.name
    || input.attempt.operation.version !== input.definition.version) {
    throw new TypeError('unsealed_read_observation_attempt');
  }
  const { attempt } = input;
  return {
    ...operationMetadata(input.definition),
    eventId: attempt.invocationId,
    disposition: 'context_denied' as const,
    surface: attempt.surface,
    accessLane: attempt.accessLane,
    correlationId: attempt.correlationId,
    recordedAt: attempt.receivedAt,
    client: { ...attempt.client },
    provenance: { ...attempt.provenance },
    scope: observationScope(attempt.scope),
    scopeResolutionEvidenceIds: boundedSortedReferences(
      attempt.scopeResolutionEvidenceIds,
      'scope_resolution_evidence'
    ),
    resultSummary: { ...input.resultSummary },
    denialReason: attempt.denialReason
  };
}

function preContextBase(input: {
  readonly definition: ReadOperationDefinition;
  readonly eventId: InvocationId;
  readonly surface: OperationSurface;
  readonly correlationId: CorrelationId;
  readonly recordedAt: Instant;
  readonly resultSummary: ReadObservationResultSummary;
}) {
  if (input.resultSummary.kind !== 'internal_failure'
    && input.resultSummary.kind !== 'request_rejected') {
    throw new TypeError('invalid_pre_context_read_observation_result');
  }
  return {
    ...operationMetadata(input.definition),
    eventId: input.eventId,
    disposition: 'pre_context_failure' as const,
    surface: input.surface,
    correlationId: input.correlationId,
    recordedAt: input.recordedAt,
    resultSummary: { ...input.resultSummary }
  };
}

type BaseInput =
  | {
      readonly kind: 'authorized';
      readonly definition: ReadOperationDefinition;
      readonly context: InvocationContext;
      readonly resultSummary: ReadObservationResultSummary;
    }
  | {
      readonly kind: 'denied';
      readonly definition: ReadOperationDefinition;
      readonly attempt: DeniedReadObservationAttempt;
      readonly resultSummary: ReadObservationResultSummary;
    }
  | ({ readonly kind: 'pre_context' } & Parameters<typeof preContextBase>[0]);

function material(input: BaseInput) {
  if (input.kind === 'authorized') return authorizedBase(input);
  if (input.kind === 'denied') return deniedBase(input);
  return preContextBase(input);
}

function assertProfile(
  targetProfile: { readonly key: string; readonly version: number },
  profile: OperationAuditRecordProfileRegistration
): void {
  if (!sameRef(targetProfile, profile.reference) || profile.kind !== 'canonical_json') {
    throw new TypeError('read_observation_record_profile_mismatch');
  }
}

function seal<RecordType extends object>(
  record: RecordType,
  profile: OperationAuditRecordProfileRegistration,
  records: WeakSet<object>
): RecordType {
  if (new TextEncoder().encode(canonicalJsonText(record)).byteLength > profile.maximumBytes) {
    throw new TypeError('read_observation_record_too_large');
  }
  const sealed = deepFreeze(record);
  records.add(sealed);
  return sealed;
}

export function createReadOperationalTraceRecord(input: BaseInput & {
  readonly traceTarget: ReadOperationalTraceTargetRegistration;
  readonly recordProfile: OperationAuditRecordProfileRegistration;
}): ReadOperationalTraceRecord {
  if (input.traceTarget.kind !== 'read_operational_trace_record'
    || input.definition.observability.trace.mode !== 'required'
    || !sameRef(input.definition.observability.trace.target, input.traceTarget.reference)) {
    throw new TypeError('read_operational_trace_target_mismatch');
  }
  assertProfile(input.traceTarget.recordProfile, input.recordProfile);
  return seal({
    ...material(input),
    recordKind: 'read_operational_trace' as const,
    traceTarget: { ...input.traceTarget.reference },
    recordProfile: { ...input.recordProfile.reference }
  } as ReadOperationalTraceRecord, input.recordProfile, sealedReadOperationalTraceRecords);
}

export function createReadImmutableAuditRecord(input: BaseInput & {
  readonly auditTarget: OperationAuditTargetRegistration;
  readonly recordProfile: OperationAuditRecordProfileRegistration;
}): ReadImmutableAuditRecord {
  const declaration = input.definition.observability.immutableAudit;
  if (declaration.mode === 'none'
    || input.auditTarget.kind !== 'operation_audit_record'
    || !sameRef(declaration.target, input.auditTarget.reference)) {
    throw new TypeError('read_immutable_audit_target_mismatch');
  }
  assertProfile(input.auditTarget.recordProfile, input.recordProfile);
  return seal({
    ...material(input),
    recordKind: 'read_immutable_audit' as const,
    auditTarget: { ...input.auditTarget.reference },
    recordProfile: { ...input.recordProfile.reference }
  } as ReadImmutableAuditRecord, input.recordProfile, sealedReadImmutableAuditRecords);
}

export function isSealedReadOperationalTraceRecord(value: unknown): value is ReadOperationalTraceRecord {
  return typeof value === 'object' && value !== null && sealedReadOperationalTraceRecords.has(value);
}

export function isSealedReadImmutableAuditRecord(value: unknown): value is ReadImmutableAuditRecord {
  return typeof value === 'object' && value !== null && sealedReadImmutableAuditRecords.has(value);
}
