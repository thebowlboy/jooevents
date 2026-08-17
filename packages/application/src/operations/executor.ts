import {
  correlationIdSchema,
  readOperationResultSchema,
  structuredOutcomeSchema,
  type StructuredOutcome
} from '@jooevents/contracts';
import { parseCorrelationId, parseInstant, parseInvocationId } from '@jooevents/kernel';
import {
  createReadImmutableAuditRecord,
  createReadOperationalTraceRecord
} from './read-observability';
import { getCompiledReadOperation } from './registry';
import { assertNoCallerSecurityClaims, isSealedInvocationContext } from './invocation-context';
import type {
  ExecuteReadOperationInput,
  ReadCapabilitySnapshot,
  ReadInvocationContext,
  ReadObservationResultSummary,
  ReadOperationExecutor,
  ReadOperationExecutorOptions,
  ReadOperationRegistry
} from './types';
import type { DeniedReadObservationAttempt } from './invocation-context';
import type { CompiledReadOperation } from './registry';

export type OperationExecutionPhase =
  | 'binding'
  | 'input'
  | 'context'
  | 'read_snapshot'
  | 'handler'
  | 'contribution'
  | 'terminalization'
  | 'canonical_result'
  | 'projection'
  | 'projected_result'
  | 'read_operational_trace'
  | 'read_immutable_audit'
  | 'replay_preflight'
  | 'autonomy_preflight'
  | 'unit_of_work'
  | 'replay_recheck'
  | 'authority_recheck'
  | 'write_snapshot'
  | 'domain_contribution'
  | 'operation_log'
  | 'feature_contribution'
  | 'effect_contributions'
  | 'invocation_release';

export class OperationInputError extends Error {
  constructor() {
    super('Operation input did not match its registered schema.');
    this.name = 'OperationInputError';
  }
}

export class OperationExecutionError extends Error {
  readonly phase: OperationExecutionPhase;
  override readonly cause?: unknown;

  constructor(phase: OperationExecutionPhase, cause?: unknown) {
    super(`Operation execution failed during ${phase}.`);
    this.name = 'OperationExecutionError';
    this.phase = phase;
    if (cause !== undefined) this.cause = cause;
  }
}

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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function');
}

function validateDeclaredOutcome(input: {
  readonly outcome: StructuredOutcome;
  readonly declarations: ReadonlyMap<string, { readonly retryable: boolean; readonly detailSchema: { readonly key: string; readonly version: number } }>;
  readonly schemas: ReadonlyMap<string, { readonly schema: { safeParse(value: unknown): { success: boolean } } }>;
}): boolean {
  const declaration = input.declarations.get(`${input.outcome.class}:${input.outcome.kind}`);
  if (!declaration || declaration.retryable !== input.outcome.retryable || declaration.detailSchema.version !== input.outcome.detailSchemaVersion) return false;
  return input.schemas.get(`${declaration.detailSchema.key}@${declaration.detailSchema.version}`)?.schema.safeParse(input.outcome.detail).success === true;
}

function outcomeFrom(value: unknown): StructuredOutcome | undefined {
  if (!isPlainRecord(value) || value.kind !== 'outcome') return undefined;
  const parsed = structuredOutcomeSchema.safeParse(value.outcome);
  return parsed.success ? parsed.data : undefined;
}

async function phase<Value>(name: OperationExecutionPhase, execute: () => Value | Promise<Value>): Promise<Value> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof OperationExecutionError || error instanceof OperationInputError) throw error;
    throw new OperationExecutionError(name, error);
  }
}

function freezeContext(value: unknown): ReadInvocationContext {
  if (!isSealedInvocationContext(value)) throw new TypeError('Read context is not application-sealed.');
  return value;
}

function freezeSnapshot(value: unknown): ReadCapabilitySnapshot {
  if (!isPlainRecord(value)) throw new TypeError('A read snapshot must be a plain record.');
  return deepFreeze(value);
}

type ReadObservationSubject =
  | { readonly kind: 'authorized'; readonly context: ReadInvocationContext }
  | { readonly kind: 'denied'; readonly attempt: DeniedReadObservationAttempt }
  | {
      readonly kind: 'pre_context';
      readonly eventId: ReturnType<typeof parseInvocationId>;
      readonly surface: ExecuteReadOperationInput['surface'];
      readonly correlationId: ReturnType<typeof parseCorrelationId>;
      readonly recordedAt: ReturnType<typeof parseInstant>;
    };

function requiresReadImmutableAudit(
  operation: CompiledReadOperation,
  surface: ExecuteReadOperationInput['surface']
): boolean {
  const declaration = operation.definition.observability.immutableAudit;
  return declaration.mode === 'required'
    || (declaration.mode === 'external_mcp_app_model'
      && (surface === 'external_mcp' || surface === 'app_model'));
}

function failureSummary(error: unknown): ReadObservationResultSummary {
  if (error instanceof OperationInputError) return { kind: 'request_rejected', reason: 'invalid_input' };
  const phase = error instanceof OperationExecutionError ? error.phase : 'context';
  if (
    phase === 'read_snapshot'
    || phase === 'handler'
    || phase === 'canonical_result'
    || phase === 'projection'
    || phase === 'projected_result'
  ) return { kind: 'internal_failure', phase };
  return { kind: 'internal_failure', phase: 'context' };
}

function resultSummary(result: ReturnType<typeof readOperationResultSchema.parse>): ReadObservationResultSummary {
  return result.kind === 'success'
    ? { kind: 'success' }
    : {
        kind: 'outcome',
        outcomeClass: result.outcome.class,
        outcomeKind: result.outcome.kind,
        retryable: result.outcome.retryable
      };
}

export function createReadOperationExecutor(
  registry: ReadOperationRegistry,
  options: ReadOperationExecutorOptions
): ReadOperationExecutor {
  const emitOperationalTrace = options.operationalTrace.emit.bind(options.operationalTrace);
  const appendImmutableAudit = options.immutableAudit.append.bind(options.immutableAudit);
  const readClock = options.clock.now.bind(options.clock);
  const newInvocationId = options.newInvocationId;

  return Object.freeze({
    async execute(invocation: ExecuteReadOperationInput) {
      const correlation = correlationIdSchema.safeParse(invocation.correlationId);
      if (!correlation.success) throw new OperationExecutionError('binding');
      const resolved = getCompiledReadOperation(registry, invocation.operationName, invocation.operationVersion, invocation.surface);
      if (!resolved) throw new OperationExecutionError('binding');
      const { operation, binding } = resolved;

      const preContextSubject = (): ReadObservationSubject => ({
        kind: 'pre_context',
        eventId: parseInvocationId(newInvocationId()),
        surface: invocation.surface,
        correlationId: parseCorrelationId(correlation.data),
        recordedAt: parseInstant(readClock())
      });
      let subject: ReadObservationSubject | undefined;

      const observe = async (summary: ReadObservationResultSummary): Promise<void> => {
        const currentSubject = subject ?? await phase(
          'read_operational_trace',
          () => preContextSubject()
        );
        const recordInput = {
          ...currentSubject,
          definition: operation.definition,
          resultSummary: summary
        } as const;
        if (requiresReadImmutableAudit(operation, invocation.surface)) {
          if (!operation.auditTarget || !operation.auditRecordProfile) {
            throw new OperationExecutionError('read_immutable_audit');
          }
          try {
            const auditRecord = createReadImmutableAuditRecord({
              ...recordInput,
              auditTarget: operation.auditTarget,
              recordProfile: operation.auditRecordProfile
            });
            await appendImmutableAudit(auditRecord);
          } catch (error) {
            const traceRecord = await phase('read_operational_trace', () =>
              createReadOperationalTraceRecord({
                ...recordInput,
                resultSummary: { kind: 'internal_failure', phase: 'immutable_audit' },
                traceTarget: operation.traceTarget,
                recordProfile: operation.traceRecordProfile
              })
            );
            try { emitOperationalTrace(traceRecord); } catch { /* best-effort sink */ }
            throw new OperationExecutionError('read_immutable_audit', error);
          }
        }
        const traceRecord = await phase('read_operational_trace', () =>
          createReadOperationalTraceRecord({
            ...recordInput,
            traceTarget: operation.traceTarget,
            recordProfile: operation.traceRecordProfile
          })
        );
        try { emitOperationalTrace(traceRecord); } catch { /* best-effort sink */ }
      };

      let finalResult: ReturnType<typeof readOperationResultSchema.parse>;
      try {
        try {
          assertNoCallerSecurityClaims(invocation.businessInput);
        } catch {
          throw new OperationInputError();
        }
        const parsedInput = operation.inputSchema.schema.safeParse(invocation.businessInput);
        if (!parsedInput.success) throw new OperationInputError();

        const contextResolution = await phase('context', () => operation.contextBuilder.build({
          operationName: operation.definition.name,
          operationVersion: operation.definition.version,
          surface: invocation.surface,
          correlationId: correlation.data,
          businessInput: parsedInput.data,
          verifiedEvidence: invocation.verifiedEvidence
        }));

        let canonicalCandidate: unknown;
        if (contextResolution.kind === 'outcome') {
          subject = { kind: 'denied', attempt: contextResolution.observationAttempt };
          canonicalCandidate = { kind: 'outcome', outcome: contextResolution.outcome };
        } else if (contextResolution.kind === 'ready') {
          const context = await phase('context', () => freezeContext(contextResolution.context));
          subject = { kind: 'authorized', context };
          const snapshot = await phase('read_snapshot', async () => freezeSnapshot(await operation.readCapability.openSnapshot(context)));
          canonicalCandidate = await phase('handler', () => operation.handler.handle({
            businessInput: parsedInput.data,
            context,
            snapshot
          }));
        } else {
          throw new OperationExecutionError('context');
        }

        const canonical = operation.canonicalResultSchema.schema.safeParse(canonicalCandidate);
        if (!canonical.success) throw new OperationExecutionError('canonical_result');
        const canonicalOutcome = outcomeFrom(canonical.data);
        if (canonicalOutcome && !validateDeclaredOutcome({ outcome: canonicalOutcome, declarations: operation.outcomes, schemas: operation.schemas })) {
          throw new OperationExecutionError('canonical_result');
        }

        const projectedCandidate = await phase('projection', () => {
          const projected = binding.projection.project(canonical.data);
          if (isPromiseLike(projected)) throw new TypeError('Read projections must be synchronous.');
          if (!isPlainRecord(projected)) throw new TypeError('Read projections must return a result record.');
          return { ...projected, correlationId: correlation.data };
        });
        const closedResult = readOperationResultSchema.safeParse(projectedCandidate);
        if (!closedResult.success) throw new OperationExecutionError('projected_result');
        const projected = binding.projectedResultSchema.schema.safeParse(closedResult.data);
        if (!projected.success) throw new OperationExecutionError('projected_result');
        const projectedOutcome = outcomeFrom(projected.data);
        if (projectedOutcome && !validateDeclaredOutcome({ outcome: projectedOutcome, declarations: operation.outcomes, schemas: operation.schemas })) {
          throw new OperationExecutionError('projected_result');
        }
        const parsedFinalResult = readOperationResultSchema.safeParse(projected.data);
        if (!parsedFinalResult.success) throw new OperationExecutionError('projected_result');
        finalResult = parsedFinalResult.data;
      } catch (error) {
        await observe(failureSummary(error));
        throw error;
      }
      await observe(resultSummary(finalResult));
      return deepFreeze(finalResult);
    }
  });
}
