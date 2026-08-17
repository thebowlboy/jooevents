import {
  correlationIdSchema,
  effectfulOperationResultSchema,
  operationReceiptRefSchema,
  structuredOutcomeSchema,
  versionedDefinitionRefSchema,
  type EffectfulOperationResult,
  type StructuredOutcome
} from '@jooevents/contracts';
import { canonicalJsonText, encodeCanonicalJson, parseJobId } from '@jooevents/kernel';
import { z } from 'zod';
import { OperationExecutionError, OperationInputError, type OperationExecutionPhase } from './executor';
import { effectOperationIdentitiesEqual } from './effect-identity';
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
  DirectOperationFeatureContribution,
  DirectOperationFeatureContributor,
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
  effectContributions: z.array(z.json()).max(100)
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
const directFeatureContexts = new WeakMap<SealedEffectInvocation, unknown>();
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

function bindDirectFeatureContributor(
  candidate: DirectOperationFeatureContributor | undefined
): DirectOperationFeatureContributor | undefined {
  if (candidate === undefined) return undefined;
  const reference = versionedDefinitionRefSchema.safeParse(candidate.reference);
  if (!reference.success || typeof candidate.contribute !== 'function') {
    throw new TypeError('direct_operation_feature_contributor_invalid');
  }
  return Object.freeze({
    reference: Object.freeze({ ...reference.data }),
    contribute: candidate.contribute.bind(candidate)
  });
}

function resolveDirectFeatureContribution(input: Readonly<{
  contributor: DirectOperationFeatureContributor | undefined;
  invocation: InternalEffectInvocation;
  canonicalResult: unknown;
  operationLogId: string;
  featureContext?: unknown;
}>): DirectOperationFeatureContribution | undefined {
  if (!input.contributor) return undefined;
  const candidate = input.contributor.contribute(Object.freeze({
    operation: Object.freeze({
      name: input.invocation.operation.definition.name,
      version: input.invocation.operation.definition.version
    }),
    businessInput: structuredClone(input.invocation.businessInput),
    canonicalResult: structuredClone(input.canonicalResult),
    scope: input.invocation.contextResolution.kind === 'ready'
      ? structuredClone(input.invocation.contextResolution.context.scope)
      : (() => { throw new OperationExecutionError('contribution'); })(),
    occurredAt: input.invocation.contextResolution.kind === 'ready'
      ? input.invocation.contextResolution.context.receivedAt
      : (() => { throw new OperationExecutionError('contribution'); })(),
    provenance: input.invocation.contextResolution.kind === 'ready'
      ? structuredClone(input.invocation.contextResolution.context.provenance)
      : (() => { throw new OperationExecutionError('contribution'); })(),
    ...(input.featureContext === undefined
      ? {}
      : { featureContext: structuredClone(input.featureContext) })
  }));
  if (isPromiseLike(candidate)) {
    throw new TypeError('direct operation feature contributor returned a promise');
  }
  if (candidate === undefined) return undefined;
  let canonicalText: string;
  try {
    canonicalText = canonicalJsonText(candidate);
  } catch (error) {
    throw new OperationExecutionError('contribution', error);
  }
  if (new TextEncoder().encode(canonicalText).byteLength > 262_144) {
    throw new OperationExecutionError('contribution');
  }
  return deepFreeze({
    contributor: { ...input.contributor.reference },
    operationLogId: input.operationLogId,
    value: JSON.parse(canonicalText) as unknown
  });
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
    throw new OperationExecutionError('replay_preflight');
  }
  const base = effectfulOperationResultSchema.safeParse(receipt.result);
  const projected = invocation.binding.projectedResultSchema.schema.safeParse(receipt.result);
  if (!base.success || !projected.success || (base.data.kind === 'outcome' && base.data.terminal !== true)) {
    throw new OperationExecutionError('replay_preflight');
  }
  if (base.data.receipt.id !== receipt.ref.id
    || base.data.receipt.operationName !== receipt.ref.operationName
    || base.data.receipt.operationVersion !== receipt.ref.operationVersion) {
    throw new OperationExecutionError('replay_preflight');
  }
  return deepFreeze(base.data);
}

function canonicalResult(
  operation: CompiledEffectOperation,
  candidate: unknown
): z.infer<typeof internalCanonicalResultSchema> {
  const base = internalCanonicalResultSchema.safeParse(candidate);
  if (!base.success) throw new OperationExecutionError('canonical_result');
  const parsed = operation.canonicalResultSchema.schema.safeParse(base.data);
  if (!parsed.success) throw new OperationExecutionError('canonical_result');
  const outcome = outcomeFrom(base.data);
  if (outcome && !validateDeclaredOutcome(operation, outcome)) throw new OperationExecutionError('canonical_result');
  return base.data;
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

function newUuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let milliseconds = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isDirectAudited(invocation: InternalEffectInvocation): boolean {
  return 'profile' in invocation.operation.definition.execution
    && invocation.operation.definition.execution.profile === 'direct_audited';
}

function resolveDirectHistorySummary(
  history: Extract<CompiledEffectOperation['definition']['execution'], { readonly profile: 'direct_audited' }>['history'],
  canonical: z.infer<typeof internalCanonicalResultSchema>
): string {
  if ('summary' in history) return history.summary;
  if (canonical.kind !== 'success'
      || canonical.data === null
      || typeof canonical.data !== 'object'
      || Array.isArray(canonical.data)) {
    throw new OperationExecutionError('canonical_result');
  }
  const data = canonical.data as { readonly action?: unknown; readonly kind?: unknown };
  const action = data.action;
  const summary = typeof action !== 'string'
    ? undefined
    : 'summariesByAction' in history
      ? history.summariesByAction[action]
      : typeof data.kind === 'string'
        ? history.summariesByActionAndKind[`${action}:${data.kind}`]
        : undefined;
  if (typeof summary !== 'string') throw new OperationExecutionError('canonical_result');
  return summary;
}

async function executeDirectAudited(input: {
  readonly invocation: InternalEffectInvocation;
  readonly unitOfWork: EffectUnitOfWorkPort;
  readonly registryDigestSha256: string;
  readonly newOperationLogId: () => string;
  readonly featureContributor: DirectOperationFeatureContributor | undefined;
  readonly featureContext?: unknown;
}): Promise<EffectfulOperationResult> {
  const { invocation } = input;
  if (!isDirectAudited(invocation)) throw new OperationExecutionError('binding');
  const direct = invocation.operation.definition.execution;
  if (!('profile' in direct) || direct.profile !== 'direct_audited') {
    throw new OperationExecutionError('binding');
  }
  if (invocation.contextResolution.kind === 'outcome') {
    return nonterminalResult(invocation, invocation.contextResolution.outcome);
  }
  if (!input.unitOfWork.findTerminalOperationLog || !input.unitOfWork.runInDirectUnitOfWork) {
    throw new OperationExecutionError('unit_of_work');
  }

  const readyContext = invocation.contextResolution;
  const identity = identityFor(invocation);
  const requestHash = readyContext.requestHash;
  const sealedExecutionAuthority = await phase('authority_recheck', () =>
    recheckEffectInvocationCurrentAuthority(readyContext.context)
  );
  const executionAuthority = await phase('authority_recheck', () =>
    consumeEffectInvocationCurrentAuthorityRecheck(readyContext.context, sealedExecutionAuthority)
  );
  if (executionAuthority.kind === 'denied') {
    return nonterminalResult(invocation, executionAuthority.outcome);
  }

  const existing = await phase('replay_preflight', () =>
    input.unitOfWork.findTerminalOperationLog!(identity)
  );
  if (existing) {
    const replay = validateReplay(invocation, identity, existing);
    return existing.requestHash === requestHash
      ? replay
      : nonterminalResult(invocation, requestChangedOutcome(invocation.operation));
  }

  let executionDirective: SealedAutonomyExecutionDirective | undefined;
  const result = await phase('unit_of_work', () => input.unitOfWork.runInDirectUnitOfWork!(async (unitOfWork) => {
    const sealedAuthorityRecheck = await phase('authority_recheck', () =>
      unitOfWork.recheckCurrentAuthority(readyContext.context)
    );
    const authorityRecheck = await phase('authority_recheck', () =>
      consumeEffectInvocationCurrentAuthorityRecheck(readyContext.context, sealedAuthorityRecheck)
    );
    if (authorityRecheck.kind === 'denied') {
      return nonterminalResult(invocation, authorityRecheck.outcome);
    }

    const afterLock = await phase('replay_recheck', () =>
      unitOfWork.findTerminalOperationLog(identity)
    );
    if (afterLock) {
      const replay = validateReplay(invocation, identity, afterLock);
      return afterLock.requestHash === requestHash
        ? replay
        : nonterminalResult(invocation, requestChangedOutcome(invocation.operation));
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
      return nonterminalResult(invocation, preflight.outcome);
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
      if (isPromiseLike(candidate)) throw new TypeError('direct-audited handler returned a promise');
      return candidate;
    });
    const envelope = handlerContributionEnvelopeSchema.safeParse(handlerCandidate);
    if (!envelope.success) throw new OperationExecutionError('contribution');
    const contribution = invocation.operation.contributionSchema.schema.safeParse(envelope.data);
    if (!contribution.success) throw new OperationExecutionError('contribution');
    const sealedContribution = handlerContributionEnvelopeSchema.safeParse(contribution.data);
    if (!sealedContribution.success || sealedContribution.data.effectContributions.length !== 0) {
      throw new OperationExecutionError('contribution');
    }

    const canonical = canonicalResult(invocation.operation, sealedContribution.data.result);
    const terminalization = await phase('terminalization', () => resolveTerminalization({
      operation: invocation.operation.definition,
      phase: invocation.operation.executionPhase,
      resolver: invocation.operation.terminalizationResolver,
      evidence: terminalizationEvidenceFor({
        canonicalResult: canonical,
        domainContribution: sealedContribution.data.domain,
        effectContributions: sealedContribution.data.effectContributions
      })
    }));
    if (terminalization.kind === 'nonterminal') {
      const outcome = outcomeFrom(canonical);
      if (!outcome || sealedContribution.data.domain !== null) {
        throw new OperationExecutionError('terminalization');
      }
      return nonterminalResult(invocation, outcome);
    }

    const projected = projectedBase(invocation, canonical);
    const historySummary = resolveDirectHistorySummary(direct.history, canonical);
    const logId = await phase('operation_log', () => input.newOperationLogId());
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(logId)) {
      throw new OperationExecutionError('operation_log');
    }
    const featureContribution = await phase('feature_contribution', () =>
      resolveDirectFeatureContribution({
        contributor: input.featureContributor,
        invocation,
        canonicalResult: canonical,
        operationLogId: logId,
        ...(input.featureContext === undefined ? {} : { featureContext: input.featureContext })
      })
    );
    await phase('domain_contribution', () => unitOfWork.applyDomainContribution(
      invocation.operation.definition.handlerCapability,
      sealedContribution.data.domain
    ));
    const terminal = terminalResult({ invocation, projected, receiptId: logId });
    const receipt: TerminalEffectReceipt = deepFreeze({
      ref: terminal.ref,
      identity,
      requestHash,
      result: terminal.result
    });
    await phase('operation_log', () => unitOfWork.insertOperationLog(deepFreeze({
      receipt,
      registryDigestSha256: input.registryDigestSha256,
      actor: readyContext.context.actor,
      scope: {
        workspaceId: readyContext.context.scope.workspaceId,
        ...(readyContext.context.scope.eventId
          ? { eventId: readyContext.context.scope.eventId }
          : {}),
        subjects: readyContext.context.scope.subjects
      },
      summary: historySummary,
      occurredAt: readyContext.context.receivedAt,
      correlationId: readyContext.context.correlationId
    })));
    if (featureContribution) {
      if (!unitOfWork.applyFeatureContribution) {
        throw new OperationExecutionError('feature_contribution');
      }
      await phase('feature_contribution', () =>
        unitOfWork.applyFeatureContribution!(featureContribution)
      );
    }
    return terminal.result;
  }));

  return executionDirective === undefined
    ? result
    : bindAutonomyExecution({ invocation, result, directive: executionDirective });
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
  readonly newOperationLogId?: () => string;
  readonly directFeatureContributor?: DirectOperationFeatureContributor;
}): EffectOperationExecutor {
  const newOperationLogId = input.newOperationLogId ?? newUuidV7;
  const featureContributor = bindDirectFeatureContributor(input.directFeatureContributor);
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
        if (isDirectAudited(invocation)) {
          const result = await executeDirectAudited({
            invocation,
            unitOfWork: input.unitOfWork,
            registryDigestSha256: input.registry.manifestDigestSha256,
            newOperationLogId,
            featureContributor,
            ...(directFeatureContexts.has(sealed)
              ? { featureContext: directFeatureContexts.get(sealed) }
              : {})
          });
          completed = true;
          return result;
        }
        if (invocation.contextResolution.kind === 'outcome') {
        const result = nonterminalResult(invocation, invocation.contextResolution.outcome);
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
        completed = true;
        return result;
      }
      const existing = await phase('replay_preflight', () => input.unitOfWork.findTerminalReceipt(identity));
      if (existing) {
        const validatedReplay = validateReplay(invocation, identity, existing);
        const matchingRequest = existing.requestHash === requestHash;
        const result = matchingRequest
          ? validatedReplay
          : nonterminalResult(invocation, requestChangedOutcome(invocation.operation));
        completed = true;
        return result;
      }
      let executionDirective: SealedAutonomyExecutionDirective | undefined;
      const result = await phase('unit_of_work', () => input.unitOfWork.runInUnitOfWork(async (unitOfWork) => {
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
          return nonterminalResult(invocation, authorityRecheck.outcome);
        }
        const afterLock = await phase('replay_recheck', () => unitOfWork.findTerminalReceipt(identity));
        if (afterLock) {
          const replay = validateReplay(invocation, identity, afterLock);
          return afterLock.requestHash === requestHash
            ? replay
            : nonterminalResult(invocation, requestChangedOutcome(invocation.operation));
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
          return nonterminalResult(invocation, preflight.outcome);
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
        assertNoHandlerAuthoredAudit(sealedContribution.data.effectContributions);

        const canonical = canonicalResult(invocation.operation, sealedContribution.data.result);
        const terminalization = await phase('terminalization', () => resolveTerminalization({
          operation: invocation.operation.definition,
          phase: invocation.operation.executionPhase,
          resolver: invocation.operation.terminalizationResolver,
          evidence: terminalizationEvidenceFor({
            canonicalResult: canonical,
            domainContribution: sealedContribution.data.domain,
            effectContributions: sealedContribution.data.effectContributions
          })
        }));
        if (terminalization.kind === 'nonterminal') {
          const outcome = outcomeFrom(canonical);
          if (!outcome || sealedContribution.data.domain !== null || sealedContribution.data.effectContributions.length !== 0) {
            throw new OperationExecutionError('terminalization');
          }
          return nonterminalResult(invocation, outcome);
        }
        const projected = projectedBase(invocation, canonical);
        const receiptId = await phase('operation_log', () => newOperationLogId());
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
        if (!unitOfWork.insertOperationLog) throw new OperationExecutionError('operation_log');
        await phase('operation_log', () => unitOfWork.insertOperationLog!(deepFreeze({
          receipt,
          registryDigestSha256: input.registry.manifestDigestSha256,
          actor: readyContext.context.actor,
          scope: {
            workspaceId: readyContext.context.scope.workspaceId,
            ...(readyContext.context.scope.eventId
              ? { eventId: readyContext.context.scope.eventId }
              : {}),
            subjects: readyContext.context.scope.subjects
          },
          summary: `Completed ${invocation.operation.definition.name}`,
          occurredAt: readyContext.context.receivedAt,
          correlationId: readyContext.context.correlationId
        })));
        for (const child of sealedContribution.data.effectContributions) {
          await phase('effect_contributions', () => unitOfWork.applyEffectContribution?.(receipt.ref.id, child));
        }
        await phase('invocation_release', () => unitOfWork.finishEffectApplication?.(identity));
        return terminal.result;
      }));
      const visibleResult = executionDirective === undefined
        ? result
        : bindAutonomyExecution({ invocation, result, directive: executionDirective });
      completed = true;
      return visibleResult;
      } finally {
        executingInvocations.delete(sealed);
        if (completed) completedInvocations.add(sealed);
      }
    }
  });
}

/**
 * Attaches bounded feature-owned context to an authentic invocation without
 * widening its registered business input. Only the direct contributor can see it;
 * handlers, request hashes, and public manifests remain unchanged.
 */
export function attachDirectOperationFeatureContext(
  invocation: SealedEffectInvocation,
  context: unknown
): SealedEffectInvocation {
  const internal = sealedInvocations.get(invocation);
  if (!internal || executingInvocations.has(invocation) || completedInvocations.has(invocation)) {
    throw new OperationExecutionError('binding');
  }
  let canonicalText: string;
  try {
    canonicalText = canonicalJsonText(context);
  } catch (error) {
    throw new OperationExecutionError('binding', error);
  }
  if (new TextEncoder().encode(canonicalText).byteLength > 65_536) {
    throw new OperationExecutionError('binding');
  }
  directFeatureContexts.set(invocation, deepFreeze(JSON.parse(canonicalText) as unknown));
  return invocation;
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
 * intended for operation-log-aware internal completion hooks; byte-equivalent
 * caller-created objects cannot pass the WeakMap seal.
 */
export function assertTerminalEffectReceiptIssuedForInvocation(input: {
  readonly invocation: SealedEffectInvocation;
  readonly receipt: TerminalEffectReceipt;
}): void {
  const invocation = sealedInvocations.get(input.invocation);
  if (!invocation || issuedTerminalReceipts.get(input.receipt) !== invocation) {
    throw new OperationExecutionError('operation_log');
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
  if (!parsed.success) throw new OperationExecutionError('replay_preflight');
  if (parsed.data.kind === 'outcome' && parsed.data.terminal !== true) return undefined;
  if (invocation.contextResolution.kind !== 'ready') return undefined;

  const identity = identityFor(invocation);
  const receipt = await phase('replay_preflight', () => input.unitOfWork.findTerminalReceipt(identity));
  if (!receipt
    || receipt.requestHash !== invocation.contextResolution.requestHash
    || receipt.ref.id !== parsed.data.receipt.id
    || receipt.ref.operationName !== parsed.data.receipt.operationName
    || receipt.ref.operationVersion !== parsed.data.receipt.operationVersion
    || canonicalJsonText(receipt.result) !== canonicalJsonText(parsed.data)) {
    throw new OperationExecutionError('replay_preflight');
  }
  validateReplay(invocation, identity, receipt);
  return receipt;
}
