import type { Database, SQLQueryBindings } from 'bun:sqlite';
import {
  assertTerminalEffectReceiptIssuedForInvocation,
  createEffectInvocationBuilder,
  createEffectOperationExecutor,
  getCompiledRegisteredJobEffectOperation,
  listCompiledRegisteredJobEffectOperations,
  resolveTerminalEffectReceipt,
  type OperationRegistry,
  type TerminalEffectReceipt
} from '@jooevents/application';
import type { EffectfulOperationResult, SafeSchemaManifestRef } from '@jooevents/contracts';
import {
  canonicalJsonText,
  parseInvocationId,
  type InvocationId,
  type JobId,
  type PayloadRef
} from '@jooevents/kernel';
import {
  assertSafeCode,
  definitionRef as reliabilityDefinitionRef,
  parseCanonicalSha256,
  resolveReliabilityDefinition,
  type DefinitionRef,
  type JobDefinition,
  type ReliabilityRegistry,
  type SafeFailure,
  type SchemaRef
} from '@jooevents/reliability';
import {
  SQLiteTrialEffectUnitOfWorkPort,
  type SQLiteTrialEffectAuditHooks,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';
import {
  TRIAL_JOB_DISPOSITIONS,
  SQLiteReliabilityJobTrial,
  SQLiteReliabilityJobTrialError,
  type ReliabilityTrialJobRecord,
  type TrialJobDisposition,
  type TrialJobDispositionCause,
  type TrialJobDispositionPolicyRef
} from './reliability-job-trial';

interface SafeParser {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false };
}

export interface RegisteredJobInputSchemaRegistration {
  readonly job: DefinitionRef<'job'>;
  readonly inputSchema: SchemaRef;
  readonly schema: SafeParser;
}

/** Disposable executable registration; the retained reliability catalog cites only its reference. */
export interface RegisteredJobInputProjectionRegistration {
  readonly reference: DefinitionRef<'input_projection'>;
  readonly jobInputSchema: SchemaRef;
  readonly operationInputSchema: SafeSchemaManifestRef;
  project(jobInput: unknown): unknown;
}

export interface RegisteredJobOperationTrialDispositionAction {
  readonly disposition: TrialJobDisposition;
  readonly reasonCode: string;
  readonly retryDelayMs?: number;
}

/**
 * Disposable trial policy. It proves a registered, digest-bound gate without
 * freezing this trial shape or vocabulary as the retained intervention model.
 */
export interface RegisteredJobOperationTrialDispositionPolicy {
  readonly reference: DefinitionRef<'job_disposition'>;
  readonly canonicalDigestSha256: ReturnType<typeof parseCanonicalSha256>;
  readonly operationNonterminal: RegisteredJobOperationTrialDispositionAction;
  readonly knownPreSubmissionFailure: RegisteredJobOperationTrialDispositionAction;
  readonly retryExhausted: RegisteredJobOperationTrialDispositionAction;
  readonly ambiguous: {
    readonly anchorInspectionOnly: RegisteredJobOperationTrialDispositionAction;
    readonly forbidden: RegisteredJobOperationTrialDispositionAction;
  };
}

export type RegisteredJobOperationTrialDispositionPolicyDraft = Omit<
  RegisteredJobOperationTrialDispositionPolicy,
  'canonicalDigestSha256'
>;

export interface RegisteredJobOperationTrialFaults {
  /** Simulates process loss after a durable claim; the active lease is deliberately retained. */
  readonly afterClaimed?: () => void;
  /** Runs in the receipt transaction after job completion and before executor audit. */
  readonly afterAtomicJobCompletion?: () => void;
  /** Simulates loss after authentic replay resolution but before job completion. */
  readonly afterReplayReceiptResolved?: () => void;
}

export interface RunRegisteredJobOperationTrialInput {
  readonly jobId: JobId;
  readonly faults?: RegisteredJobOperationTrialFaults;
}

export type RegisteredJobOperationTrialResult =
  | {
      readonly kind: 'terminal';
      readonly replay: boolean;
      readonly result: EffectfulOperationResult;
      readonly job: ReliabilityTrialJobRecord;
    }
  | {
      readonly kind: 'nonterminal';
      readonly result: EffectfulOperationResult;
      readonly cause: TrialJobDispositionCause;
      readonly job: ReliabilityTrialJobRecord;
    }
  | {
      readonly kind: 'settled';
      readonly cause: TrialJobDispositionCause;
      readonly job: ReliabilityTrialJobRecord;
    }
  | {
      readonly kind: 'already_terminal';
      readonly job: ReliabilityTrialJobRecord;
    };

export class RegisteredJobOperationTrialError extends Error {
  constructor(
    readonly code:
      | 'composition_mismatch'
      | 'job_input_missing'
      | 'job_input_mismatch'
      | 'job_mismatch'
      | 'job_not_dispatchable'
      | 'lost_fence'
      | 'projection_failed'
      | 'receipt_mismatch'
      | 'disposition_failed',
    message: string,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = 'RegisteredJobOperationTrialError';
  }
}

interface JobInputRow {
  readonly payload_ref_id: string;
  readonly job_key: string;
  readonly job_version: number;
  readonly schema_key: string;
  readonly schema_version: number;
  readonly schema_digest_sha256: string;
  readonly input_json: string;
}

interface JoinedJob {
  readonly definition: JobDefinition;
  readonly projector: RegisteredJobInputProjectionRegistration;
}

class InjectedTrialCrash extends Error {
  constructor(readonly original: unknown) {
    super('injected registered-job trial crash');
    this.name = 'InjectedTrialCrash';
  }
}

function run(sqlite: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  return sqlite.query(sql).run(...bindings);
}

function refKey(reference: { readonly key: string; readonly version: number }): string {
  return `${reference.key}@${reference.version}`;
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameReliabilitySchema(left: SchemaRef, right: SchemaRef): boolean {
  return sameRef(left, right)
    && left.canonicalSchemaDigestSha256 === right.canonicalSchemaDigestSha256;
}

function sameApplicationSchema(
  reliability: SchemaRef,
  application: SafeSchemaManifestRef
): boolean {
  return sameRef(reliability, application)
    && reliability.canonicalSchemaDigestSha256 === application.digestSha256;
}

function isPromiseLike(value: unknown): boolean {
  return Boolean(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value: unknown): unknown {
  return deepFreeze(JSON.parse(canonicalJsonText(value)) as unknown);
}

function actionBody(action: RegisteredJobOperationTrialDispositionAction) {
  return {
    disposition: action.disposition,
    reasonCode: action.reasonCode,
    ...(action.retryDelayMs === undefined ? {} : { retryDelayMs: action.retryDelayMs })
  };
}

function dispositionPolicyBody(policy: RegisteredJobOperationTrialDispositionPolicyDraft) {
  return {
    kind: 'disposable_registered_job_operation_trial',
    schemaVersion: 1,
    reference: { ...policy.reference },
    operationNonterminal: actionBody(policy.operationNonterminal),
    knownPreSubmissionFailure: actionBody(policy.knownPreSubmissionFailure),
    retryExhausted: actionBody(policy.retryExhausted),
    ambiguous: {
      anchorInspectionOnly: actionBody(policy.ambiguous.anchorInspectionOnly),
      forbidden: actionBody(policy.ambiguous.forbidden)
    }
  };
}

async function sha256(value: unknown): Promise<ReturnType<typeof parseCanonicalSha256>> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJsonText(value))
  );
  return parseCanonicalSha256(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

function assertDispositionAction(
  action: RegisteredJobOperationTrialDispositionAction,
  label: string
): void {
  if (!TRIAL_JOB_DISPOSITIONS.includes(action.disposition)) {
    throw new RegisteredJobOperationTrialError(
      'composition_mismatch',
      `${label} uses an unregistered trial disposition`
    );
  }
  try {
    assertSafeCode(action.reasonCode, `${label} reason`);
  } catch (cause) {
    throw new RegisteredJobOperationTrialError(
      'composition_mismatch',
      `${label} has an unsafe reason code`,
      { cause }
    );
  }
  if (action.disposition === 'safe_retry') {
    if (
      action.retryDelayMs === undefined
      || !Number.isSafeInteger(action.retryDelayMs)
      || action.retryDelayMs <= 0
      || action.retryDelayMs > 86_400_000
    ) {
      throw new RegisteredJobOperationTrialError(
        'composition_mismatch',
        `${label} safe retry requires one bounded delay`
      );
    }
  } else if (action.retryDelayMs !== undefined) {
    throw new RegisteredJobOperationTrialError(
      'composition_mismatch',
      `${label} carries a delay without safe retry`
    );
  }
}

function frozenAction(
  action: RegisteredJobOperationTrialDispositionAction
): RegisteredJobOperationTrialDispositionAction {
  return Object.freeze(actionBody(action));
}

export async function sealRegisteredJobOperationTrialDispositionPolicy(
  draft: RegisteredJobOperationTrialDispositionPolicyDraft
): Promise<RegisteredJobOperationTrialDispositionPolicy> {
  try {
    const reference = reliabilityDefinitionRef(
      'job_disposition',
      draft.reference.key,
      draft.reference.version
    );
    if (
      draft.reference.kind !== 'job_disposition'
      || !sameRef(reference, draft.reference)
    ) throw new TypeError('wrong disposition policy kind');
  } catch (cause) {
    throw new RegisteredJobOperationTrialError(
      'composition_mismatch',
      'disposable disposition policy has an invalid exact reference',
      { cause }
    );
  }
  assertDispositionAction(draft.operationNonterminal, 'operation-nonterminal');
  assertDispositionAction(draft.knownPreSubmissionFailure, 'known-pre-submission');
  assertDispositionAction(draft.retryExhausted, 'retry-exhausted');
  assertDispositionAction(draft.ambiguous.anchorInspectionOnly, 'anchor-inspection ambiguity');
  assertDispositionAction(draft.ambiguous.forbidden, 'forbidden ambiguity');
  if (draft.retryExhausted.disposition === 'safe_retry') {
    throw new RegisteredJobOperationTrialError(
      'composition_mismatch',
      'retry exhaustion cannot schedule another retry'
    );
  }
  if (
    draft.ambiguous.anchorInspectionOnly.disposition !== 'reconcile'
    || draft.ambiguous.forbidden.disposition !== 'block'
  ) {
    throw new RegisteredJobOperationTrialError(
      'composition_mismatch',
      'ambiguous work must reconcile by registered anchor or remain blocked'
    );
  }
  const frozenDraft: RegisteredJobOperationTrialDispositionPolicyDraft = deepFreeze({
    reference: { ...draft.reference },
    operationNonterminal: frozenAction(draft.operationNonterminal),
    knownPreSubmissionFailure: frozenAction(draft.knownPreSubmissionFailure),
    retryExhausted: frozenAction(draft.retryExhausted),
    ambiguous: {
      anchorInspectionOnly: frozenAction(draft.ambiguous.anchorInspectionOnly),
      forbidden: frozenAction(draft.ambiguous.forbidden)
    }
  });
  return deepFreeze({
    ...frozenDraft,
    canonicalDigestSha256: await sha256(dispositionPolicyBody(frozenDraft))
  });
}

/** Installs only disposable job-input evidence for the registered-job proof. */
export function installSQLiteRegisteredJobOperationTrial(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE registered_job_inputs_trial (
      payload_ref_id TEXT PRIMARY KEY,
      job_key TEXT NOT NULL,
      job_version INTEGER NOT NULL CHECK(job_version > 0),
      schema_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      schema_digest_sha256 TEXT NOT NULL
        CHECK(length(schema_digest_sha256) = 64
          AND schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      input_json TEXT NOT NULL CHECK(json_valid(input_json))
    ) STRICT;

    CREATE TRIGGER registered_job_inputs_trial_reject_update
    BEFORE UPDATE ON registered_job_inputs_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_job_input_immutable');
    END;

    CREATE TRIGGER registered_job_inputs_trial_reject_delete
    BEFORE DELETE ON registered_job_inputs_trial
    BEGIN
      SELECT RAISE(ABORT, 'registered_job_input_immutable');
    END;
  `);
}

export class SQLiteRegisteredJobInputTrial {
  private readonly registrations: ReadonlyMap<string, RegisteredJobInputSchemaRegistration>;

  constructor(
    private readonly sqlite: Database,
    registrations: readonly RegisteredJobInputSchemaRegistration[]
  ) {
    const mapped = new Map<string, RegisteredJobInputSchemaRegistration>();
    for (const registration of registrations) {
      const key = refKey(registration.job);
      if (mapped.has(key) || typeof registration.schema?.safeParse !== 'function') {
        throw new RegisteredJobOperationTrialError(
          'composition_mismatch',
          `job input schema ${key} must be registered exactly once`
        );
      }
      const safeParse = registration.schema.safeParse.bind(registration.schema);
      mapped.set(key, Object.freeze({
        job: Object.freeze({ ...registration.job }),
        inputSchema: Object.freeze({ ...registration.inputSchema }),
        schema: Object.freeze({ safeParse })
      }));
    }
    this.registrations = mapped;
  }

  append(input: {
    readonly job: DefinitionRef<'job'>;
    readonly inputRef: PayloadRef;
    readonly value: unknown;
  }): void {
    const registration = this.registrations.get(refKey(input.job));
    const parsed = registration?.schema.safeParse(input.value);
    if (!registration || !parsed?.success) {
      throw new RegisteredJobOperationTrialError(
        'job_input_mismatch',
        'job input does not match its exact registered schema'
      );
    }
    run(
      this.sqlite,
      `INSERT INTO registered_job_inputs_trial (
        payload_ref_id, job_key, job_version, schema_key, schema_version,
        schema_digest_sha256, input_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.inputRef.id,
      registration.job.key,
      registration.job.version,
      registration.inputSchema.key,
      registration.inputSchema.version,
      registration.inputSchema.canonicalSchemaDigestSha256,
      canonicalJsonText(parsed.data)
    );
  }

  read(job: ReliabilityTrialJobRecord): {
    readonly input: unknown;
    readonly inputSchema: SchemaRef;
  } {
    const row = this.sqlite.query<JobInputRow, [string]>(`
      SELECT * FROM registered_job_inputs_trial WHERE payload_ref_id = ?
    `).get(job.job.inputRef.id);
    if (!row) {
      throw new RegisteredJobOperationTrialError(
        'job_input_missing',
        'durable job input is unavailable'
      );
    }
    if (
      row.job_key !== job.job.definition.key
      || row.job_version !== job.job.definition.version
    ) {
      throw new RegisteredJobOperationTrialError(
        'job_input_mismatch',
        'durable job input belongs to another job definition'
      );
    }
    const registration = this.registrations.get(`${row.job_key}@${row.job_version}`);
    const value = JSON.parse(row.input_json) as unknown;
    const parsed = registration?.schema.safeParse(value);
    const schema = Object.freeze({
      key: row.schema_key,
      version: row.schema_version,
      canonicalSchemaDigestSha256: parseCanonicalSha256(row.schema_digest_sha256)
    }) as SchemaRef;
    if (
      !registration
      || !parsed?.success
      || !sameReliabilitySchema(schema, registration.inputSchema)
      || !sameReliabilitySchema(schema, job.definitionSnapshot.inputSchema)
    ) {
      throw new RegisteredJobOperationTrialError(
        'job_input_mismatch',
        'stored job input or schema no longer matches its registration'
      );
    }
    return Object.freeze({ input: immutableJson(parsed.data), inputSchema: schema });
  }
}

function includesInjectedCrash(error: unknown): InjectedTrialCrash | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && !visited.has(current)) {
    if (current instanceof InjectedTrialCrash) return current;
    visited.add(current);
    current = typeof current === 'object' && 'cause' in current
      ? (current as { readonly cause?: unknown }).cause
      : undefined;
  }
  return undefined;
}

export async function createSQLiteRegisteredJobOperationTrialRunner(input: {
  readonly sqlite: Database;
  readonly operationRegistry: OperationRegistry;
  readonly reliabilityRegistry: ReliabilityRegistry;
  readonly reliability: SQLiteReliabilityJobTrial;
  readonly inputs: SQLiteRegisteredJobInputTrial;
  readonly inputSchemas: readonly RegisteredJobInputSchemaRegistration[];
  readonly inputProjectors: readonly RegisteredJobInputProjectionRegistration[];
  readonly dispositionPolicies: readonly RegisteredJobOperationTrialDispositionPolicy[];
  readonly domain: SQLiteTrialEffectDomainAdapter;
  readonly auditHooks?: SQLiteTrialEffectAuditHooks;
  readonly workerKey: string;
  readonly newAttemptId: (jobId: JobId) => InvocationId;
  readonly newCorrelationId: (jobId: JobId, attemptId: InvocationId) => string;
  readonly newReceiptId?: () => string;
}) {
  const compositionFailure = (message: string): never => {
    throw new RegisteredJobOperationTrialError('composition_mismatch', message);
  };
  const jobs = new Map<string, JobDefinition>();
  for (const definition of input.reliabilityRegistry.definitions) {
    if (definition.kind === 'job') jobs.set(refKey(definition), definition);
  }
  const inputSchemas = new Map<string, RegisteredJobInputSchemaRegistration>();
  for (const registration of input.inputSchemas) {
    const key = refKey(registration.job);
    if (inputSchemas.has(key)) compositionFailure(`job input schema ${key} is duplicated`);
    const safeParse = registration.schema.safeParse.bind(registration.schema);
    inputSchemas.set(key, Object.freeze({
      job: Object.freeze({ ...registration.job }),
      inputSchema: Object.freeze({ ...registration.inputSchema }),
      schema: Object.freeze({ safeParse })
    }));
  }
  const projectors = new Map<string, RegisteredJobInputProjectionRegistration>();
  for (const registration of input.inputProjectors) {
    const key = refKey(registration.reference);
    if (projectors.has(key)) compositionFailure(`job input projector ${key} is duplicated`);
    projectors.set(key, Object.freeze({
      reference: Object.freeze({ ...registration.reference }),
      jobInputSchema: Object.freeze({ ...registration.jobInputSchema }),
      operationInputSchema: Object.freeze({ ...registration.operationInputSchema }),
      project: registration.project.bind(registration)
    }));
  }
  const policies = new Map<string, RegisteredJobOperationTrialDispositionPolicy>();
  for (const policy of input.dispositionPolicies) {
    const key = refKey(policy.reference);
    if (policies.has(key)) compositionFailure(`job disposition policy ${key} is duplicated`);
    const expected = await sealRegisteredJobOperationTrialDispositionPolicy(policy);
    if (expected.canonicalDigestSha256 !== policy.canonicalDigestSha256) {
      compositionFailure(`job disposition policy ${key} has a mismatched canonical digest`);
    }
    policies.set(key, expected);
  }

  const internalBindings = listCompiledRegisteredJobEffectOperations(input.operationRegistry);
  if (internalBindings.length !== jobs.size) {
    compositionFailure('registered jobs and internal operation bindings differ');
  }
  const joined = new Map<string, JoinedJob>();
  const requiredProjectors = new Set<string>();
  for (const [jobKey, definition] of jobs) {
    const resolved = getCompiledRegisteredJobEffectOperation(
      input.operationRegistry,
      definition.key,
      definition.version
    ) ?? compositionFailure(`job ${jobKey} has no exact internal operation binding`);
    if (!sameRef(definition.targetOperation, {
      key: resolved.operation.definition.name,
      version: resolved.operation.definition.version
    })) compositionFailure(`job ${jobKey} targets another operation`);
    if (
      !sameRef(definition.inputProjection, resolved.binding.inputProjection)
      || definition.capabilityRevisionId !== resolved.binding.capabilityRevisionId
      || !sameRef(definition.authorityCitation, resolved.binding.authorityCitation)
    ) compositionFailure(`job ${jobKey} execution authority or input projection differs`);
    if (!resolved.operation.definition.accessLanes.some(
      (lane) => lane.surface === 'application_job' && lane.kind === 'registered_job'
    )) compositionFailure(`job ${jobKey} has no registered-job application-job lane`);
    if (!sameApplicationSchema(definition.resultSchema, resolved.binding.projectedResultSchema.reference)) {
      compositionFailure(`job ${jobKey} result schema differs from its operation lane`);
    }
    const projector = projectors.get(refKey(definition.inputProjection))
      ?? compositionFailure(`job ${jobKey} input projector is missing`);
    requiredProjectors.add(refKey(definition.inputProjection));
    if (
      !sameReliabilitySchema(projector.jobInputSchema, definition.inputSchema)
      || !sameRef(projector.operationInputSchema, resolved.operation.inputSchema.reference)
      || projector.operationInputSchema.digestSha256 !== resolved.operation.inputSchema.reference.digestSha256
    ) compositionFailure(`job ${jobKey} input projector schema join is not exact`);
    const schema = inputSchemas.get(jobKey);
    if (!schema || !sameReliabilitySchema(schema.inputSchema, definition.inputSchema)) {
      compositionFailure(`job ${jobKey} input schema registration differs`);
    }
    const manifestCandidate = input.operationRegistry.internalManifest.bindings.find(
      (entry) => entry.kind === 'registered_job'
        && entry.selector.key === definition.key
        && entry.selector.version === definition.version
    );
    const manifest = manifestCandidate?.kind === 'registered_job'
      ? manifestCandidate
      : undefined;
    if (
      !manifest
      || manifest.operation.name !== definition.targetOperation.key
      || manifest.operation.version !== definition.targetOperation.version
      || !sameRef(manifest.inputProjection, definition.inputProjection)
      || manifest.capabilityRevisionId !== definition.capabilityRevisionId
      || !sameRef(manifest.authorityCitation, definition.authorityCitation)
      || canonicalJsonText(manifest.operationInputSchema) !== canonicalJsonText(projector.operationInputSchema)
    ) compositionFailure(`job ${jobKey} internal manifest differs from executable composition`);
    joined.set(jobKey, Object.freeze({ definition, projector }));
  }
  if (
    inputSchemas.size !== jobs.size
    || projectors.size !== requiredProjectors.size
    || [...projectors.keys()].some((key) => !requiredProjectors.has(key))
  ) compositionFailure('orphan job input schema or projector registration exists');
  if (policies.size === 0) compositionFailure('at least one disposable disposition policy is required');

  const assertDurableJob = (record: ReliabilityTrialJobRecord): JoinedJob => {
    const definition = resolveReliabilityDefinition(input.reliabilityRegistry, record.job.definition);
    const candidate = joined.get(refKey(record.job.definition));
    if (
      !definition
      || definition.kind !== 'job'
      || !candidate
      || definition.canonicalDigestSha256 !== record.job.definitionDigestSha256
      || !sameReliabilitySchema(definition.inputSchema, record.definitionSnapshot.inputSchema)
      || !sameReliabilitySchema(definition.resultSchema, record.definitionSnapshot.resultSchema)
      || !sameReliabilitySchema(definition.errorDetailSchema, record.definitionSnapshot.errorDetailSchema)
      || !sameRef(definition.source, record.definitionSnapshot.source)
      || !sameRef(definition.scopeCausation, record.definitionSnapshot.scopeCausation)
      || !sameRef(definition.inputProjection, record.job.inputProjection)
      || !sameRef(definition.inputProjection, record.definitionSnapshot.inputProjection)
      || !sameRef(definition.targetOperation, record.job.targetOperation)
      || !sameRef(definition.targetOperation, record.definitionSnapshot.targetOperation)
      || definition.capabilityRevisionId !== record.job.capabilityRevisionId
      || definition.capabilityRevisionId !== record.definitionSnapshot.capabilityRevisionId
      || !sameRef(definition.authorityCitation, record.job.authorityCitation)
      || !sameRef(definition.authorityCitation, record.definitionSnapshot.authorityCitation)
      || definition.externalRetryPolicy !== record.job.externalRetryPolicy
      || definition.maximumAttempts !== record.job.maximumAttempts
      || definition.leaseDurationMs !== record.job.leaseDurationMs
      || definition.timeoutMs !== record.job.timeoutMs
      || !sameRef(definition.backoff, record.definitionSnapshot.backoff)
      || !sameRef(definition.cancellation, record.definitionSnapshot.cancellation)
    ) {
      throw new RegisteredJobOperationTrialError(
        'job_mismatch',
        'durable job no longer matches its exact registered definition'
      );
    }
    const policy = policies.get(refKey(record.dispositionPolicy.reference));
    if (!policy || policy.canonicalDigestSha256 !== record.dispositionPolicy.canonicalDigestSha256) {
      throw new RegisteredJobOperationTrialError(
        'job_mismatch',
        'durable job cites an unknown or changed disposable disposition policy'
      );
    }
    return candidate;
  };

  const policyFor = (record: ReliabilityTrialJobRecord) => {
    return policies.get(refKey(record.dispositionPolicy.reference))
      ?? compositionFailure('durable job disposition policy disappeared');
  };

  const actionFor = (
    record: ReliabilityTrialJobRecord,
    cause: TrialJobDispositionCause
  ): RegisteredJobOperationTrialDispositionAction => {
    const policy = policyFor(record);
    if (cause === 'lease_expired' || cause === 'timeout' || cause === 'ambiguous_failure') {
      return record.job.externalRetryPolicy === 'anchor_inspection_only'
        ? policy.ambiguous.anchorInspectionOnly
        : policy.ambiguous.forbidden;
    }
    const selected = cause === 'operation_nonterminal'
      ? policy.operationNonterminal
      : policy.knownPreSubmissionFailure;
    return selected.disposition === 'safe_retry'
      && record.job.attempts.length >= record.job.maximumAttempts
      ? policy.retryExhausted
      : selected;
  };

  const settle = (settleInput: {
    readonly record: ReliabilityTrialJobRecord;
    readonly fence: NonNullable<ReliabilityTrialJobRecord['job']['currentFence']>;
    readonly intended: Exclude<TrialJobDispositionCause, 'lease_expired' | 'timeout'>;
    readonly failureCode: string;
  }): { readonly cause: TrialJobDispositionCause; readonly job: ReliabilityTrialJobRecord } => {
    let lastError: unknown;
    for (let timingAttempt = 0; timingAttempt < 3; timingAttempt += 1) {
      try {
        const cause = input.reliability.classifyDispositionCause(
          settleInput.record.job.id,
          settleInput.fence,
          settleInput.intended
        );
        const current = input.reliability.require(settleInput.record.job.id);
        const action = actionFor(current, cause);
        const failure: SafeFailure = Object.freeze({
          code: cause === 'timeout'
            ? 'job.execution_timeout'
            : cause === 'lease_expired'
              ? 'job.lease_expired'
              : settleInput.failureCode,
          classification: cause === 'ambiguous_failure' || cause === 'lease_expired' || cause === 'timeout'
            ? 'ambiguous'
            : action.disposition === 'safe_retry'
              ? 'transient'
              : 'permanent'
        });
        const job = input.reliability.settle({
          jobId: current.job.id,
          fence: settleInput.fence,
          policy: current.dispositionPolicy,
          cause,
          disposition: action.disposition,
          reasonCode: action.reasonCode,
          failure,
          ...(action.retryDelayMs === undefined ? {} : { retryDelayMs: action.retryDelayMs })
        });
        return Object.freeze({ cause, job });
      } catch (causeError) {
        lastError = causeError;
        if (
          causeError instanceof SQLiteReliabilityJobTrialError
          && causeError.code === 'lease_expired'
        ) continue;
        break;
      }
    }
    throw new RegisteredJobOperationTrialError(
      'disposition_failed',
      'registered job could not persist its fail-closed disposition',
      { cause: lastError }
    );
  };

  const builder = createEffectInvocationBuilder(input.operationRegistry, {
    registeredJobAnchorResolver: {
      resolve: ({ job, jobId }) => {
        const durable = input.reliability.require(jobId);
        assertDurableJob(durable);
        if (
          !sameRef(job, durable.job.definition)
          || durable.job.state !== 'leased'
          || durable.job.lease?.ownerKey !== input.workerKey
        ) {
          throw new RegisteredJobOperationTrialError(
            'lost_fence',
            'registered job invocation anchor is not the current durable lease'
          );
        }
        return {
          registeredIdempotencyIdentity: durable.job.registeredIdempotencyIdentity
        };
      }
    }
  });

  return Object.freeze({
    async run(runInput: RunRegisteredJobOperationTrialInput): Promise<RegisteredJobOperationTrialResult> {
      let record = input.reliability.read(runInput.jobId);
      if (!record) {
        throw new RegisteredJobOperationTrialError('job_not_dispatchable', 'registered job does not exist');
      }
      const joinedJob = assertDurableJob(record);
      if (record.job.state === 'succeeded' || record.job.state === 'dead_lettered' || record.job.state === 'cancelled') {
        return Object.freeze({ kind: 'already_terminal', job: record });
      }

      if (record.job.state === 'leased' && record.job.lease !== null) {
        const existingFence = record.job.currentFence;
        if (existingFence === null) {
          throw new RegisteredJobOperationTrialError('lost_fence', 'leased job has no fence');
        }
        try {
          const cause = input.reliability.classifyDispositionCause(
            record.job.id,
            existingFence,
            'ambiguous_failure'
          );
          if (cause === 'lease_expired' || cause === 'timeout') {
            const settled = settle({
              record,
              fence: existingFence,
              intended: 'ambiguous_failure',
              failureCode: cause === 'timeout' ? 'job.execution_timeout' : 'job.lease_expired'
            });
            return Object.freeze({ kind: 'settled', ...settled });
          }
        } catch (error) {
          if (!(error instanceof SQLiteReliabilityJobTrialError)) throw error;
        }
      }

      if (record.job.state !== 'leased') {
        let attemptId: InvocationId;
        try {
          attemptId = parseInvocationId(input.newAttemptId(record.job.id));
        } catch (cause) {
          throw new RegisteredJobOperationTrialError(
            'job_not_dispatchable',
            'trusted job attempt generator returned an invalid identity',
            { cause }
          );
        }
        try {
          record = input.reliability.claim({
            jobId: record.job.id,
            invocationId: attemptId,
            ownerKey: input.workerKey
          });
        } catch (cause) {
          throw new RegisteredJobOperationTrialError(
            'job_not_dispatchable',
            'registered job could not acquire its durable lease',
            { cause }
          );
        }
        runInput.faults?.afterClaimed?.();
      } else if (record.job.lease?.ownerKey !== input.workerKey) {
        throw new RegisteredJobOperationTrialError(
          'job_not_dispatchable',
          'registered job has an unexpired lease owned by another worker'
        );
      }

      record = input.reliability.require(record.job.id);
      assertDurableJob(record);
      const attemptId = record.job.lease?.attemptId;
      const fence = record.job.currentFence;
      if (
        record.job.state !== 'leased'
        || record.job.lease?.ownerKey !== input.workerKey
        || attemptId === undefined
        || fence === null
      ) {
        throw new RegisteredJobOperationTrialError(
          'lost_fence',
          'registered job acquisition did not produce the current durable attempt'
        );
      }

      const timingCause = input.reliability.classifyDispositionCause(
        record.job.id,
        fence,
        'ambiguous_failure'
      );
      if (timingCause === 'lease_expired' || timingCause === 'timeout') {
        const settled = settle({
          record,
          fence,
          intended: 'ambiguous_failure',
          failureCode: timingCause === 'timeout' ? 'job.execution_timeout' : 'job.lease_expired'
        });
        return Object.freeze({ kind: 'settled', ...settled });
      }

      let projected: unknown;
      try {
        const stored = input.inputs.read(record);
        if (!sameReliabilitySchema(stored.inputSchema, joinedJob.projector.jobInputSchema)) {
          throw new RegisteredJobOperationTrialError(
            'job_input_mismatch',
            'job projector input schema differs from durable input'
          );
        }
        const immutableInput = immutableJson(stored.input);
        const first = joinedJob.projector.project(immutableInput);
        const second = joinedJob.projector.project(immutableJson(stored.input));
        if (isPromiseLike(first) || isPromiseLike(second)) {
          throw new TypeError('registered job input projection must be synchronous');
        }
        if (canonicalJsonText(first) !== canonicalJsonText(second)) {
          throw new TypeError('registered job input projection must be byte-repeatable');
        }
        const resolved = getCompiledRegisteredJobEffectOperation(
          input.operationRegistry,
          record.job.definition.key,
          record.job.definition.version
        );
        const parsed = resolved?.operation.inputSchema.schema.safeParse(first);
        if (!resolved || !parsed?.success) {
          throw new TypeError('registered job input projection returned another schema');
        }
        projected = immutableJson(parsed.data);
      } catch (error) {
        if (error instanceof RegisteredJobOperationTrialError && error.code === 'job_mismatch') throw error;
        const settled = settle({
          record,
          fence,
          intended: 'known_pre_submission_failure',
          failureCode: 'job.input_projection_failed'
        });
        return Object.freeze({ kind: 'settled', ...settled });
      }

      let invocation;
      try {
        invocation = await builder.buildRegisteredJob({
          job: { key: record.job.definition.key, version: record.job.definition.version },
          jobId: record.job.id,
          correlationId: input.newCorrelationId(record.job.id, attemptId),
          businessInput: projected
        });
      } catch (error) {
        const settled = settle({
          record,
          fence,
          intended: 'ambiguous_failure',
          failureCode: 'job.invocation_build_failed'
        });
        return Object.freeze({ kind: 'settled', ...settled });
      }

      const beforeExecute = input.reliability.require(record.job.id);
      if (
        beforeExecute.job.state !== 'leased'
        || beforeExecute.job.lease?.attemptId !== attemptId
        || beforeExecute.job.lease.ownerKey !== input.workerKey
        || beforeExecute.job.currentFence !== fence
      ) {
        throw new RegisteredJobOperationTrialError(
          'lost_fence',
          'registered job lost its durable fence before operation execution'
        );
      }

      let freshReceipt = false;
      const domain: SQLiteTrialEffectDomainAdapter = Object.freeze({
        openHandlerSnapshot: input.domain.openHandlerSnapshot.bind(input.domain),
        applyDomainContribution: input.domain.applyDomainContribution.bind(input.domain),
        async afterReceiptParentInserted(receipt: TerminalEffectReceipt) {
          assertTerminalEffectReceiptIssuedForInvocation({ invocation, receipt });
          input.reliability.completeWithReceipt({
            jobId: record.job.id,
            fence,
            receipt
          });
          freshReceipt = true;
          if (runInput.faults?.afterAtomicJobCompletion) {
            try {
              runInput.faults.afterAtomicJobCompletion();
            } catch (error) {
              throw new InjectedTrialCrash(error);
            }
          }
          await input.domain.afterReceiptParentInserted?.(receipt);
        },
        ...(input.domain.afterReceiptChildInserted
          ? { afterReceiptChildInserted: input.domain.afterReceiptChildInserted.bind(input.domain) }
          : {}),
        ...(input.domain.afterExecutionClaimReleased
          ? { afterExecutionClaimReleased: input.domain.afterExecutionClaimReleased.bind(input.domain) }
          : {}),
        ...(input.domain.afterUnitOfWorkCommitted
          ? { afterUnitOfWorkCommitted: input.domain.afterUnitOfWorkCommitted.bind(input.domain) }
          : {})
      });
      const unitOfWork = new SQLiteTrialEffectUnitOfWorkPort(
        input.sqlite,
        domain,
        input.auditHooks
      );
      const executor = createEffectOperationExecutor({
        registry: input.operationRegistry,
        unitOfWork,
        ...(input.newReceiptId ? { newReceiptId: input.newReceiptId } : {})
      });

      let result: EffectfulOperationResult;
      try {
        result = await executor.execute(invocation);
      } catch (error) {
        const injected = includesInjectedCrash(error);
        if (injected) throw injected.original;
        const current = input.reliability.require(record.job.id);
        if (current.job.state !== 'leased' || current.job.currentFence !== fence) {
          throw new RegisteredJobOperationTrialError(
            'lost_fence',
            'operation failure occurred after the job lost its durable fence',
            { cause: error }
          );
        }
        const settled = settle({
          record: current,
          fence,
          intended: 'ambiguous_failure',
          failureCode: 'job.operation_execution_ambiguous'
        });
        return Object.freeze({ kind: 'settled', ...settled });
      }

      const terminal = result.kind === 'success'
        || (result.kind === 'outcome' && result.terminal === true);
      if (!terminal) {
        const current = input.reliability.require(record.job.id);
        const settled = settle({
          record: current,
          fence,
          intended: 'operation_nonterminal',
          failureCode: 'job.operation_nonterminal'
        });
        return Object.freeze({ kind: 'nonterminal', result, ...settled });
      }

      let completed = input.reliability.require(record.job.id);
      if (!freshReceipt) {
        const receipt = await resolveTerminalEffectReceipt({
          invocation,
          result,
          unitOfWork
        });
        if (!receipt) {
          throw new RegisteredJobOperationTrialError(
            'receipt_mismatch',
            'terminal operation result has no authentic receipt'
          );
        }
        runInput.faults?.afterReplayReceiptResolved?.();
        completed = input.reliability.completeWithReceipt({
          jobId: completed.job.id,
          fence,
          receipt
        });
      }
      if (completed.job.state !== 'succeeded') {
        throw new RegisteredJobOperationTrialError(
          'receipt_mismatch',
          'terminal operation receipt did not complete its registered job'
        );
      }
      return Object.freeze({
        kind: 'terminal',
        replay: !freshReceipt,
        result,
        job: completed
      });
    }
  });
}
