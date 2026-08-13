import {
  correlationIdSchema,
  effectfulOperationResultSchema,
  operationReceiptRefSchema,
  structuredOutcomeSchema,
  type EffectfulOperationResult,
  type StructuredOutcome
} from '@jooevents/contracts';
import { canonicalJsonText, encodeCanonicalJson, parseJobId } from '@jooevents/kernel';
import { z } from 'zod';
import { OperationExecutionError, OperationInputError, type OperationExecutionPhase } from './executor';
import { effectOperationIdentitiesEqual } from './effect-identity';
import {
  createContextDeniedOperationAuditRecord,
  createIdempotencyConflictOperationAuditRecord,
  createNonterminalProgressOperationAuditRecord,
  createTerminalNewOperationAuditRecord,
  createTerminalReplayOperationAuditRecord
} from './audit';
import {
  consumeAutonomyPreflightDecision,
  executeAutonomyPreflight,
  resolveAutonomyExecutionDirectiveEvidence,
  type AutonomyExecutionDirectiveEvidence,
  type SealedAutonomyExecutionDirective
} from './autonomy-preflight';
import {
  assertNoCallerSecurityClaims,
  consumeEffectInvocationCurrentAuthorityRecheck,
  isSealedDeniedEffectAuditAttempt,
  isSealedInvocationContext,
  recheckEffectInvocationCurrentAuthority,
  type DeniedEffectAuditAttempt
} from './invocation-context';
import {
  getCompiledEffectOperation,
  getCompiledRegisteredConsumerEffectOperation,
  getCompiledRegisteredJobEffectOperation,
  type CompiledEffectBinding,
  type CompiledEffectOperation,
  type CompiledRegisteredConsumerEffectBinding,
  type CompiledRegisteredJobEffectBinding
} from './registry';
import { resolveTerminalization, terminalizationEvidenceFor } from './phase-contract';
import type {
  BuildEffectInvocationInput,
  BuildRegisteredConsumerEffectInvocationInput,
  BuildRegisteredJobEffectInvocationInput,
  EffectHandlerSnapshot,
  EffectInvocationBuilder,
  EffectInvocationBuilderOptions,
  EffectInvocationContext,
  EffectOperationExecutor,
  EffectOperationIdentity,
  EffectUnitOfWorkPort,
  OperationRegistry,
  SealedEffectInvocation,
  TerminalEffectReceipt
} from './types';

const sha256Pattern = /^[a-f0-9]{64}$/;
const authorityPrincipalPattern = /^[A-Za-z0-9._:-]{1,256}$/;

const internalCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: z.json() }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

const handlerContributionEnvelopeSchema = z.strictObject({
  result: z.unknown(),
  domain: z.json(),
  receiptChildren: z.array(z.json()).max(100)
});

interface InternalEffectInvocation {
	readonly registry: OperationRegistry;
  readonly operation: CompiledEffectOperation;
  readonly binding:
    | CompiledEffectBinding
    | CompiledRegisteredConsumerEffectBinding
    | CompiledRegisteredJobEffectBinding;
  readonly correlationId: string;
  readonly businessInput: unknown;
  readonly contextResolution:
    | {
        readonly kind: 'outcome';
        readonly outcome: StructuredOutcome;
        readonly auditAttempt: DeniedEffectAuditAttempt;
      }
    | {
        readonly kind: 'ready';
        readonly context: EffectInvocationContext;
        readonly scopePartitionKey: string;
        readonly authorityPrincipalKey: string;
        readonly idempotencyVerifierProfile: EffectOperationIdentity['idempotencyVerifierProfile'];
        readonly idempotencyKeyVerifier: string;
        readonly requestHash: string;
      };
}

const sealedInvocations = new WeakMap<SealedEffectInvocation, InternalEffectInvocation>();
const executingInvocations = new WeakSet<SealedEffectInvocation>();
const completedInvocations = new WeakSet<SealedEffectInvocation>();
const issuedTerminalReceipts = new WeakMap<TerminalEffectReceipt, InternalEffectInvocation>();
const completedAutonomyExecutions = new WeakMap<InternalEffectInvocation, {
  readonly result: EffectfulOperationResult;
  readonly directive: SealedAutonomyExecutionDirective;
}>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<Value>(value: Value): Value {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
  }
  return value;
}

function freezeHandlerSnapshot(value: unknown): EffectHandlerSnapshot {
  if (!isPlainRecord(value)) throw new TypeError('Effect handler snapshot must be a plain record.');
  const visited = new WeakSet<object>();
  const validate = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return;
    if (typeof candidate !== 'object') {
      throw new TypeError('Effect handler snapshots can contain only inert canonical data.');
    }
    if (visited.has(candidate)) throw new TypeError('Effect handler snapshots cannot contain cycles.');
    visited.add(candidate);
    if (!Array.isArray(candidate) && !isPlainRecord(candidate)) {
      throw new TypeError('Effect handler snapshots can contain only arrays and plain records.');
    }
    if (Object.getOwnPropertySymbols(candidate).length !== 0) {
      throw new TypeError('Effect handler snapshots cannot expose symbol capabilities.');
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(candidate))) {
      if (descriptor.enumerable !== true && !(Array.isArray(candidate) && key === 'length')) {
        throw new TypeError('Effect handler snapshots cannot contain hidden properties.');
      }
      if (!Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Effect handler snapshots cannot expose accessors.');
      }
      validate(descriptor.value);
    }
  };
  validate(value);
  for (const lifecycleKey of ['begin', 'commit', 'rollback', 'transaction', 'unitOfWork']) {
    if (Object.hasOwn(value, lifecycleKey)) throw new TypeError('Effect handler snapshots cannot expose transaction lifecycle control.');
  }
  if (encodeCanonicalJson(value).byteLength > 1024 * 1024) {
    throw new TypeError('Effect handler snapshot exceeds the bounded canonical size.');
  }
  return deepFreeze(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function');
}

async function phase<Value>(name: OperationExecutionPhase, execute: () => Value | Promise<Value>): Promise<Value> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof OperationExecutionError || error instanceof OperationInputError) throw error;
    throw new OperationExecutionError(name, error);
  }
}

function validateDeclaredOutcome(operation: CompiledEffectOperation, outcome: StructuredOutcome): boolean {
  const declaration = operation.outcomes.get(`${outcome.class}:${outcome.kind}`);
  if (!declaration || declaration.retryable !== outcome.retryable || declaration.detailSchema.version !== outcome.detailSchemaVersion) return false;
  return operation.schemas.get(`${declaration.detailSchema.key}@${declaration.detailSchema.version}`)?.schema.safeParse(outcome.detail).success === true;
}

function outcomeFrom(value: unknown): StructuredOutcome | undefined {
  if (!isPlainRecord(value) || value.kind !== 'outcome') return undefined;
  const parsed = structuredOutcomeSchema.safeParse(value.outcome);
  return parsed.success ? parsed.data : undefined;
}

function requestChangedOutcome(operation: CompiledEffectOperation): StructuredOutcome {
  const declaration = operation.outcomes.get('idempotency_conflict:operation.request_changed');
  if (!declaration) throw new OperationExecutionError('canonical_result');
  return {
    class: 'idempotency_conflict',
    kind: 'operation.request_changed',
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: declaration.detailSchema.version
  };
}

function assertNoHandlerAuthoredAudit(children: readonly unknown[]): void {
  for (const child of children) {
    if (isPlainRecord(child) && (child.kind === 'audit' || child.kind === 'operation_audit')) {
      throw new OperationExecutionError('contribution');
    }
  }
}

export function createEffectInvocationBuilder(
  registry: OperationRegistry,
  options: EffectInvocationBuilderOptions = {}
): EffectInvocationBuilder {
  const buildResolved = async (
    input: BuildEffectInvocationInput,
    resolved: {
      readonly operation: CompiledEffectOperation;
      readonly binding:
        | CompiledEffectBinding
        | CompiledRegisteredConsumerEffectBinding
        | CompiledRegisteredJobEffectBinding;
    }
  ): Promise<SealedEffectInvocation> => {
      const correlation = correlationIdSchema.safeParse(input.correlationId);
      if (!correlation.success) throw new OperationExecutionError('binding');
      if (typeof input.rawIdempotencyKey !== 'string' || input.rawIdempotencyKey.length < 1 || input.rawIdempotencyKey.length > 512) {
        throw new OperationInputError();
      }
      try {
        assertNoCallerSecurityClaims(input.businessInput);
      } catch {
        throw new OperationInputError();
      }
      const parsedInput = resolved.operation.inputSchema.schema.safeParse(input.businessInput);
      if (!parsedInput.success) throw new OperationInputError();
      const built = await phase('context', () => resolved.operation.contextBuilder.build({
        operationName: resolved.operation.definition.name,
        operationVersion: resolved.operation.definition.version,
        surface: input.surface,
        correlationId: correlation.data,
        businessInput: parsedInput.data,
        verifiedEvidence: input.verifiedEvidence,
        rawIdempotencyKey: input.rawIdempotencyKey
      }));

      let contextResolution: InternalEffectInvocation['contextResolution'];
      if (built.kind === 'outcome') {
        const outcome = structuredOutcomeSchema.safeParse(built.outcome);
        if (!outcome.success
          || !validateDeclaredOutcome(resolved.operation, outcome.data)
          || !isSealedDeniedEffectAuditAttempt(built.auditAttempt)
          || built.auditAttempt.operation.name !== resolved.operation.definition.name
          || built.auditAttempt.operation.version !== resolved.operation.definition.version
          || built.auditAttempt.operation.effect !== resolved.operation.definition.effect
          || built.auditAttempt.surface !== input.surface
          || built.auditAttempt.correlationId !== correlation.data) {
          throw new OperationExecutionError('context');
        }
        contextResolution = {
          kind: 'outcome',
          outcome: outcome.data,
          auditAttempt: built.auditAttempt
        };
      } else if (built.kind === 'ready') {
        const identity = built.requestIdentity;
        if (!sha256Pattern.test(identity.scopePartitionKey)
          || !authorityPrincipalPattern.test(identity.authorityPrincipalKey)
          || identity.idempotencyVerifierProfile.key !== resolved.operation.definition.idempotency.credentialVerifierProfile.key
          || identity.idempotencyVerifierProfile.version !== resolved.operation.definition.idempotency.credentialVerifierProfile.version
          || !sha256Pattern.test(identity.idempotencyKeyVerifier)
          || !sha256Pattern.test(identity.requestHash)) {
          throw new OperationExecutionError('context');
        }
        if (!isSealedInvocationContext(built.context)) {
          throw new OperationExecutionError('context');
        }
        contextResolution = {
          kind: 'ready',
          context: built.context,
          scopePartitionKey: identity.scopePartitionKey,
          authorityPrincipalKey: identity.authorityPrincipalKey,
          idempotencyVerifierProfile: identity.idempotencyVerifierProfile,
          idempotencyKeyVerifier: identity.idempotencyKeyVerifier,
          requestHash: identity.requestHash
        };
      } else {
        throw new OperationExecutionError('context');
      }

      const sealed: SealedEffectInvocation = Object.freeze({
        operationName: input.operationName,
        operationVersion: input.operationVersion,
        surface: input.surface,
        correlationId: correlation.data
      });
      sealedInvocations.set(sealed, {
			registry,
        operation: resolved.operation,
        binding: resolved.binding,
        correlationId: correlation.data,
        businessInput: parsedInput.data,
        contextResolution
      });
      return sealed;
  };

  return Object.freeze({
    async build(input: BuildEffectInvocationInput) {
      const resolved = getCompiledEffectOperation(
        registry,
        input.operationName,
        input.operationVersion,
        input.surface
      );
      if (!resolved) throw new OperationExecutionError('binding');
      return buildResolved(input, resolved);
    },
    async buildRegisteredConsumer(input: BuildRegisteredConsumerEffectInvocationInput) {
      const resolved = getCompiledRegisteredConsumerEffectOperation(
        registry,
        input.consumer.key,
        input.consumer.version
      );
      if (!resolved) throw new OperationExecutionError('binding');
      return buildResolved({
        operationName: resolved.operation.definition.name,
        operationVersion: resolved.operation.definition.version,
        surface: 'application_job',
        correlationId: input.correlationId,
        businessInput: input.businessInput,
        verifiedEvidence: input.verifiedEvidence,
        rawIdempotencyKey: input.rawIdempotencyKey
      }, resolved);
    },
    async buildRegisteredJob(input: BuildRegisteredJobEffectInvocationInput) {
      const resolved = getCompiledRegisteredJobEffectOperation(
        registry,
        input.job.key,
        input.job.version
      );
      if (!resolved || !options.registeredJobAnchorResolver) {
        throw new OperationExecutionError('binding');
      }
      let jobId;
      try {
        jobId = parseJobId(input.jobId);
      } catch {
        throw new OperationExecutionError('binding');
      }
      const anchor = await phase('binding', () => options.registeredJobAnchorResolver!.resolve({
        job: Object.freeze({ ...resolved.binding.job }),
        jobId
      }));
      if (
        !anchor
        || typeof anchor.registeredIdempotencyIdentity !== 'string'
        || anchor.registeredIdempotencyIdentity.length < 1
        || anchor.registeredIdempotencyIdentity.length > 240
        || anchor.registeredIdempotencyIdentity.trim() !== anchor.registeredIdempotencyIdentity
      ) {
        throw new OperationExecutionError('binding');
      }
      return buildResolved({
        operationName: resolved.operation.definition.name,
        operationVersion: resolved.operation.definition.version,
        surface: 'application_job',
        correlationId: input.correlationId,
        businessInput: input.businessInput,
        verifiedEvidence: {
          kind: 'registered_job',
          surface: 'application_job',
          client: { key: 'worker.registered-job' },
          jobId
        },
        rawIdempotencyKey: [
          'registered-job',
          `${resolved.binding.job.key}@${resolved.binding.job.version}`,
          jobId,
          anchor.registeredIdempotencyIdentity
        ].join(':')
      }, resolved);
    }
  });
}

function identityFor(invocation: InternalEffectInvocation): EffectOperationIdentity {
  if (invocation.contextResolution.kind !== 'ready') throw new OperationExecutionError('context');
  return deepFreeze({
    scopePartitionKey: invocation.contextResolution.scopePartitionKey,
    authorityPrincipalKey: invocation.contextResolution.authorityPrincipalKey,
    operationName: invocation.operation.definition.name,
    operationVersion: invocation.operation.definition.version,
    surface: invocation.binding.surface,
    idempotencyVerifierProfile: { ...invocation.contextResolution.idempotencyVerifierProfile },
    idempotencyKeyVerifier: invocation.contextResolution.idempotencyKeyVerifier
  });
}

function validateReplay(
  invocation: InternalEffectInvocation,
  identity: EffectOperationIdentity,
  receipt: TerminalEffectReceipt
): EffectfulOperationResult {
  if (!effectOperationIdentitiesEqual(identity, receipt.identity) || receipt.ref.operationName !== identity.operationName || receipt.ref.operationVersion !== identity.operationVersion) {
    throw new OperationExecutionError('receipt_preflight');
  }
  const base = effectfulOperationResultSchema.safeParse(receipt.result);
  const projected = invocation.binding.projectedResultSchema.schema.safeParse(receipt.result);
  if (!base.success || !projected.success || (base.data.kind === 'outcome' && base.data.terminal !== true)) {
    throw new OperationExecutionError('receipt_preflight');
  }
  if (base.data.receipt.id !== receipt.ref.id
    || base.data.receipt.operationName !== receipt.ref.operationName
    || base.data.receipt.operationVersion !== receipt.ref.operationVersion) {
    throw new OperationExecutionError('receipt_preflight');
  }
  return deepFreeze(base.data);
}

function canonicalResult(operation: CompiledEffectOperation, candidate: unknown): unknown {
  const base = internalCanonicalResultSchema.safeParse(candidate);
  if (!base.success) throw new OperationExecutionError('canonical_result');
  const parsed = operation.canonicalResultSchema.schema.safeParse(base.data);
  if (!parsed.success) throw new OperationExecutionError('canonical_result');
  const outcome = outcomeFrom(parsed.data);
  if (outcome && !validateDeclaredOutcome(operation, outcome)) throw new OperationExecutionError('canonical_result');
  return parsed.data;
}

function projectedBase(invocation: InternalEffectInvocation, canonical: unknown): z.infer<typeof internalCanonicalResultSchema> {
  const source = internalCanonicalResultSchema.safeParse(canonical);
  if (!source.success) throw new OperationExecutionError('projection');
  const firstCandidate = invocation.binding.projection.project(structuredClone(canonical));
  if (isPromiseLike(firstCandidate)) throw new OperationExecutionError('projection');
  const secondCandidate = invocation.binding.projection.project(structuredClone(canonical));
  if (isPromiseLike(secondCandidate)) throw new OperationExecutionError('projection');
  const first = internalCanonicalResultSchema.safeParse(firstCandidate);
  const second = internalCanonicalResultSchema.safeParse(secondCandidate);
  if (!first.success || !second.success || canonicalJsonText(first.data) !== canonicalJsonText(second.data)) {
    throw new OperationExecutionError('projection');
  }
  if (first.data.kind !== source.data.kind
    || (first.data.kind === 'outcome' && source.data.kind === 'outcome'
      && canonicalJsonText(first.data.outcome) !== canonicalJsonText(source.data.outcome))) {
    throw new OperationExecutionError('projection');
  }
  const outcome = outcomeFrom(first.data);
  if (outcome && !validateDeclaredOutcome(invocation.operation, outcome)) throw new OperationExecutionError('projection');
  return first.data;
}

function nonterminalResult(invocation: InternalEffectInvocation, outcome: StructuredOutcome): EffectfulOperationResult {
  const canonical = canonicalResult(invocation.operation, { kind: 'outcome', outcome });
  const projected = projectedBase(invocation, canonical);
  if (projected.kind !== 'outcome') throw new OperationExecutionError('projection');
  const candidate = { ...projected, terminal: false as const, correlationId: invocation.correlationId };
  const base = effectfulOperationResultSchema.safeParse(candidate);
  const lane = invocation.binding.projectedResultSchema.schema.safeParse(candidate);
  if (!base.success || !lane.success) throw new OperationExecutionError('projected_result');
  return deepFreeze(base.data);
}

function bindAutonomyExecution(input: {
  readonly invocation: InternalEffectInvocation;
  readonly result: EffectfulOperationResult;
  readonly directive: SealedAutonomyExecutionDirective;
}): EffectfulOperationResult {
  completedAutonomyExecutions.set(input.invocation, {
    result: input.result,
    directive: input.directive
  });
  return input.result;
}

function terminalResult(input: {
  readonly invocation: InternalEffectInvocation;
  readonly projected: z.infer<typeof internalCanonicalResultSchema>;
  readonly receiptId: string;
}): { readonly result: EffectfulOperationResult; readonly ref: TerminalEffectReceipt['ref'] } {
  const ref = operationReceiptRefSchema.parse({
    id: input.receiptId,
    operationName: input.invocation.operation.definition.name,
    operationVersion: input.invocation.operation.definition.version
  });
  const candidate = input.projected.kind === 'success'
    ? { ...input.projected, receipt: ref, correlationId: input.invocation.correlationId }
    : { ...input.projected, terminal: true as const, receipt: ref, correlationId: input.invocation.correlationId };
  const base = effectfulOperationResultSchema.safeParse(candidate);
  const lane = input.invocation.binding.projectedResultSchema.schema.safeParse(candidate);
  if (!base.success || !lane.success) throw new OperationExecutionError('projected_result');
  return { result: deepFreeze(base.data), ref };
}

export function createEffectOperationExecutor(input: {
  readonly registry: OperationRegistry;
  readonly unitOfWork: EffectUnitOfWorkPort;
  readonly newReceiptId?: () => string;
}): EffectOperationExecutor {
  const newReceiptId = input.newReceiptId ?? (() => crypto.randomUUID());
  return Object.freeze({
    async execute(sealed: SealedEffectInvocation) {
      const invocation = sealedInvocations.get(sealed);
			if (!invocation || invocation.registry !== input.registry) {
				throw new OperationExecutionError('binding');
			}
      if (completedInvocations.has(sealed) || executingInvocations.has(sealed)) {
        throw new OperationExecutionError('binding');
      }
      executingInvocations.add(sealed);
      let completed = false;
      try {
      if (invocation.contextResolution.kind === 'outcome') {
        const deniedResolution = invocation.contextResolution;
        const result = nonterminalResult(invocation, deniedResolution.outcome);
        await phase('operation_audit', () => input.unitOfWork.recordShortOperationAudit(
          createContextDeniedOperationAuditRecord({
            attempt: deniedResolution.auditAttempt,
            definition: invocation.operation.definition,
            auditTarget: invocation.operation.auditTarget,
            auditRecordProfile: invocation.operation.auditRecordProfile,
            result
          })
        ));
        completed = true;
        return result;
      }

      const readyContext = invocation.contextResolution;
      const identity = identityFor(invocation);
      const requestHash = readyContext.requestHash;
      const sealedExecutionAuthority = await phase('authority_recheck', () =>
        recheckEffectInvocationCurrentAuthority(readyContext.context)
      );
      const executionAuthority = await phase('authority_recheck', () =>
        consumeEffectInvocationCurrentAuthorityRecheck(
          readyContext.context,
          sealedExecutionAuthority
        )
      );
      if (executionAuthority.kind === 'denied') {
        const result = nonterminalResult(invocation, executionAuthority.outcome);
        await phase('operation_audit', () => input.unitOfWork.recordShortOperationAudit(
          createNonterminalProgressOperationAuditRecord({
            context: readyContext.context,
            definition: invocation.operation.definition,
            auditTarget: invocation.operation.auditTarget,
            auditRecordProfile: invocation.operation.auditRecordProfile,
            result,
            authorityRecheck: sealedExecutionAuthority,
            reason: {
              kind: 'authority_recheck',
              denialReason: executionAuthority.reason
            }
          })
        ));
        completed = true;
        return result;
      }
      const existing = await phase('receipt_preflight', () => input.unitOfWork.findTerminalReceipt(identity));
      if (existing) {
        const validatedReplay = validateReplay(invocation, identity, existing);
        const matchingRequest = existing.requestHash === requestHash;
        const result = matchingRequest
          ? validatedReplay
          : nonterminalResult(invocation, requestChangedOutcome(invocation.operation));
        await phase('operation_audit', () => input.unitOfWork.recordShortOperationAudit(
          matchingRequest
            ? createTerminalReplayOperationAuditRecord({
                context: readyContext.context,
                definition: invocation.operation.definition,
                auditTarget: invocation.operation.auditTarget,
                auditRecordProfile: invocation.operation.auditRecordProfile,
                result,
                relatedReceiptId: existing.ref.id,
                authorityRecheck: sealedExecutionAuthority
              })
            : createIdempotencyConflictOperationAuditRecord({
                context: readyContext.context,
                definition: invocation.operation.definition,
                auditTarget: invocation.operation.auditTarget,
                auditRecordProfile: invocation.operation.auditRecordProfile,
                result,
                authorityRecheck: sealedExecutionAuthority
              })
        ));
        completed = true;
        return result;
      }
      let executionDirective: SealedAutonomyExecutionDirective | undefined;
      const execution = await phase('unit_of_work', () => input.unitOfWork.runInUnitOfWork(async (unitOfWork) => {
        const sealedAuthorityRecheck = await phase('authority_recheck', () =>
          unitOfWork.recheckCurrentAuthority(readyContext.context)
        );
        const authorityRecheck = await phase('authority_recheck', () =>
          consumeEffectInvocationCurrentAuthorityRecheck(
            readyContext.context,
            sealedAuthorityRecheck
          )
        );
        if (authorityRecheck.kind === 'denied') {
          const result = nonterminalResult(invocation, authorityRecheck.outcome);
          return {
            kind: 'short_audit' as const,
            result,
            record: createNonterminalProgressOperationAuditRecord({
              context: readyContext.context,
              definition: invocation.operation.definition,
              auditTarget: invocation.operation.auditTarget,
              auditRecordProfile: invocation.operation.auditRecordProfile,
              result,
              authorityRecheck: sealedAuthorityRecheck,
              reason: {
                kind: 'authority_recheck',
                denialReason: authorityRecheck.reason
              }
            })
          };
        }

        const claim = await phase('execution_claim', () => unitOfWork.acquireExecutionClaim(identity, requestHash));
        if (claim.kind === 'contended_changed_request') {
          const result = nonterminalResult(invocation, requestChangedOutcome(invocation.operation));
          return {
            kind: 'short_audit' as const,
            result,
            record: createIdempotencyConflictOperationAuditRecord({
              context: readyContext.context,
              definition: invocation.operation.definition,
              auditTarget: invocation.operation.auditTarget,
              auditRecordProfile: invocation.operation.auditRecordProfile,
              result,
              authorityRecheck: sealedAuthorityRecheck
            })
          };
        }
        if (claim.kind === 'contended_same_request') {
          const result = nonterminalResult(invocation, invocation.operation.executionPhase.contentionOutcome);
          return {
            kind: 'short_audit' as const,
            result,
            record: createNonterminalProgressOperationAuditRecord({
              context: readyContext.context,
              definition: invocation.operation.definition,
              auditTarget: invocation.operation.auditTarget,
              auditRecordProfile: invocation.operation.auditRecordProfile,
              result,
              authorityRecheck: sealedAuthorityRecheck,
              reason: { kind: 'same_request_contended' }
            })
          };
        }
        if (claim.kind !== 'acquired') {
          throw new OperationExecutionError('execution_claim');
        }
        const afterClaim = await phase('receipt_recheck', () => unitOfWork.findTerminalReceipt(identity));
        if (afterClaim) {
          const validatedReplay = validateReplay(invocation, identity, afterClaim);
          const result = afterClaim.requestHash === requestHash
            ? validatedReplay
            : nonterminalResult(invocation, requestChangedOutcome(invocation.operation));
          await phase('claim_release', () => unitOfWork.releaseExecutionClaim(identity));
          return {
            kind: 'short_audit' as const,
            result,
            record: afterClaim.requestHash === requestHash
              ? createTerminalReplayOperationAuditRecord({
                  context: readyContext.context,
                  definition: invocation.operation.definition,
                  auditTarget: invocation.operation.auditTarget,
                  auditRecordProfile: invocation.operation.auditRecordProfile,
                  result,
                  relatedReceiptId: afterClaim.ref.id,
                  authorityRecheck: sealedAuthorityRecheck
                })
              : createIdempotencyConflictOperationAuditRecord({
                  context: readyContext.context,
                  definition: invocation.operation.definition,
                  auditTarget: invocation.operation.auditTarget,
                  auditRecordProfile: invocation.operation.auditRecordProfile,
                  result,
                  authorityRecheck: sealedAuthorityRecheck
                })
          };
        }

        const sealedPreflight = await phase('autonomy_preflight', () => executeAutonomyPreflight({
          registration: invocation.operation.autonomyPreflight,
          policy: invocation.operation.autonomyPolicy,
          riskResolver: invocation.operation.riskResolver,
          evidenceResolver: invocation.operation.autonomyEvidenceResolver,
          approvalResolver: invocation.operation.renewedApprovalResolver,
          context: readyContext.context,
          maximumRisk: invocation.operation.definition.maxRisk,
          consequenceTags: invocation.operation.definition.consequenceTags,
          requestHashSha256: requestHash,
          evaluatedAt: authorityRecheck.evaluatedAt
        }));
        const preflight = await phase('autonomy_preflight', () => consumeAutonomyPreflightDecision({
          decision: sealedPreflight,
          registration: invocation.operation.autonomyPreflight,
          operation: {
            name: invocation.operation.definition.name,
            version: invocation.operation.definition.version
          },
          requestHashSha256: requestHash
        }));
        executionDirective = preflight.directive;
        if (preflight.disposition !== 'proceed') {
          const result = nonterminalResult(invocation, preflight.outcome);
          await phase('claim_release', () => unitOfWork.releaseExecutionClaim(identity));
          return {
            kind: 'short_audit' as const,
            result,
            record: createNonterminalProgressOperationAuditRecord({
              context: readyContext.context,
              definition: invocation.operation.definition,
              auditTarget: invocation.operation.auditTarget,
              auditRecordProfile: invocation.operation.auditRecordProfile,
              result,
              authorityRecheck: sealedAuthorityRecheck,
              reason: {
                kind: 'autonomy_intervention',
                autonomyDisposition: preflight.disposition
              }
            })
          };
        }

        const snapshot = await phase('write_snapshot', async () => freezeHandlerSnapshot(
          await unitOfWork.openHandlerSnapshot(
            invocation.operation.definition.handlerCapability,
            readyContext.context,
            sealedAuthorityRecheck
          )
        ));
        const handlerCandidate = await phase('handler', () => {
          const candidate = invocation.operation.handler.handle({
            businessInput: invocation.businessInput,
            context: readyContext.context,
            snapshot
          });
          if (isPromiseLike(candidate)) throw new TypeError('single-unit-of-work handler returned a promise');
          return candidate;
        });
        const envelope = handlerContributionEnvelopeSchema.safeParse(handlerCandidate);
        if (!envelope.success) throw new OperationExecutionError('contribution');
        const contribution = invocation.operation.contributionSchema.schema.safeParse(envelope.data);
        if (!contribution.success) throw new OperationExecutionError('contribution');
        const sealedContribution = handlerContributionEnvelopeSchema.safeParse(contribution.data);
        if (!sealedContribution.success) throw new OperationExecutionError('contribution');
        assertNoHandlerAuthoredAudit(sealedContribution.data.receiptChildren);

        const canonical = canonicalResult(invocation.operation, sealedContribution.data.result);
        const terminalization = await phase('terminalization', () => resolveTerminalization({
          operation: invocation.operation.definition,
          phase: invocation.operation.executionPhase,
          resolver: invocation.operation.terminalizationResolver,
          evidence: terminalizationEvidenceFor({
            canonicalResult: canonical,
            domainContribution: sealedContribution.data.domain,
            receiptChildren: sealedContribution.data.receiptChildren
          })
        }));
        if (terminalization.kind === 'nonterminal') {
          const outcome = outcomeFrom(canonical);
          if (!outcome || sealedContribution.data.domain !== null || sealedContribution.data.receiptChildren.length !== 0) {
            throw new OperationExecutionError('terminalization');
          }
          const result = nonterminalResult(invocation, outcome);
          await phase('claim_release', () => unitOfWork.releaseExecutionClaim(identity));
          return {
            kind: 'short_audit' as const,
            result,
            record: createNonterminalProgressOperationAuditRecord({
              context: readyContext.context,
              definition: invocation.operation.definition,
              auditTarget: invocation.operation.auditTarget,
              auditRecordProfile: invocation.operation.auditRecordProfile,
              result,
              authorityRecheck: sealedAuthorityRecheck,
              reason: { kind: 'phase_nonterminal' }
            })
          };
        }
        const projected = projectedBase(invocation, canonical);
        const receiptId = await phase('receipt_parent', () => newReceiptId());
        const terminal = terminalResult({ invocation, projected, receiptId });
        const receipt: TerminalEffectReceipt = deepFreeze({
          ref: terminal.ref,
          identity,
          requestHash,
          result: terminal.result
        });

        await phase('domain_contribution', () => unitOfWork.applyDomainContribution(
          invocation.operation.definition.handlerCapability,
          sealedContribution.data.domain
        ));
        issuedTerminalReceipts.set(receipt, invocation);
        await phase('receipt_parent', () => unitOfWork.insertReceiptParent(receipt));
        await phase('operation_audit', () => unitOfWork.insertTerminalNewOperationAudit(
          createTerminalNewOperationAuditRecord({
            context: readyContext.context,
            definition: invocation.operation.definition,
            auditTarget: invocation.operation.auditTarget,
            auditRecordProfile: invocation.operation.auditRecordProfile,
            result: terminal.result,
            receiptId: receipt.ref.id,
            authorityRecheck: sealedAuthorityRecheck
          })
        ));
        for (const child of sealedContribution.data.receiptChildren) {
          await phase('receipt_children', () => unitOfWork.insertReceiptChild(receipt.ref.id, child));
        }
        await phase('claim_release', () => unitOfWork.releaseExecutionClaim(identity));
        return { kind: 'terminal_new' as const, result: terminal.result };
      }));
      if (execution.kind === 'short_audit') {
        await phase('operation_audit', () => input.unitOfWork.recordShortOperationAudit(execution.record));
      }
      const result = executionDirective === undefined
        ? execution.result
        : bindAutonomyExecution({ invocation, result: execution.result, directive: executionDirective });
      completed = true;
      return result;
      } finally {
        executingInvocations.delete(sealed);
        if (completed) completedInvocations.add(sealed);
      }
    }
  });
}

/**
 * Resolves the exact process-local autonomy evidence retained for an authentic
 * invocation/result pair. Replays resolved before preflight and authority-denied
 * results intentionally have no directive; a cloned result cannot recover one.
 */
export function resolveEffectAutonomyExecutionEvidence(input: {
  readonly invocation: SealedEffectInvocation;
  readonly result: EffectfulOperationResult;
}): AutonomyExecutionDirectiveEvidence | undefined {
  const invocation = sealedInvocations.get(input.invocation);
  if (!invocation) throw new OperationExecutionError('binding');
  const completed = completedAutonomyExecutions.get(invocation);
  if (!completed) return undefined;
  if (completed.result !== input.result) return undefined;
  return resolveAutonomyExecutionDirectiveEvidence(completed.directive);
}

/**
 * Proves exact object identity between an authentic builder-owned invocation and
 * the receipt object issued for it immediately before parent insertion. This is
 * intended for receipt-parent-aware internal completion hooks; byte-equivalent
 * caller-created objects cannot pass the WeakMap seal.
 */
export function assertTerminalEffectReceiptIssuedForInvocation(input: {
  readonly invocation: SealedEffectInvocation;
  readonly receipt: TerminalEffectReceipt;
}): void {
  const invocation = sealedInvocations.get(input.invocation);
  if (!invocation || issuedTerminalReceipts.get(input.receipt) !== invocation) {
    throw new OperationExecutionError('receipt_parent');
  }
}

/**
 * Resolves only the real terminal receipt belonging to an authentic sealed
 * invocation and its exact returned result. Internal runners use this after the
 * executor returns; a receipt-shaped caller object cannot satisfy the seal.
 */
export async function resolveTerminalEffectReceipt(input: {
  readonly invocation: SealedEffectInvocation;
  readonly result: EffectfulOperationResult;
  readonly unitOfWork: EffectUnitOfWorkPort;
}): Promise<TerminalEffectReceipt | undefined> {
  const invocation = sealedInvocations.get(input.invocation);
  if (!invocation) throw new OperationExecutionError('binding');
  const parsed = effectfulOperationResultSchema.safeParse(input.result);
  if (!parsed.success) throw new OperationExecutionError('receipt_preflight');
  if (parsed.data.kind === 'outcome' && parsed.data.terminal !== true) return undefined;
  if (invocation.contextResolution.kind !== 'ready') return undefined;

  const identity = identityFor(invocation);
  const receipt = await phase('receipt_preflight', () => input.unitOfWork.findTerminalReceipt(identity));
  if (!receipt
    || receipt.requestHash !== invocation.contextResolution.requestHash
    || receipt.ref.id !== parsed.data.receipt.id
    || receipt.ref.operationName !== parsed.data.receipt.operationName
    || receipt.ref.operationVersion !== parsed.data.receipt.operationVersion
    || canonicalJsonText(receipt.result) !== canonicalJsonText(parsed.data)) {
    throw new OperationExecutionError('receipt_preflight');
  }
  validateReplay(invocation, identity, receipt);
  return receipt;
}
