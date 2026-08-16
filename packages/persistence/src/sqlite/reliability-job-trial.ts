import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { TerminalEffectReceipt } from '@jooevents/application';
import {
  canonicalJsonText,
  createPayloadRef,
  parseAggregateVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parsePayloadRefId,
  parseWorkspaceId,
  type AuthorityCitationId,
  type Clock,
  type EventScopeRef,
  type Instant,
  type InvocationId,
  type JobId,
  type PayloadRef
} from '@jooevents/kernel';
import {
  assertSafeCode,
  claimJob,
  completeJob,
  createJob,
  definitionRef,
  parseAttemptNumber,
  parseCanonicalSha256,
  parseDefinitionKey,
  parseLeaseFence,
  parseOpaqueSourceIdentity,
  type CanonicalSha256,
  type DefinitionRef,
  type JobAttemptFinished,
  type JobAttemptRunning,
  type JobDefinition,
  type JobRecord,
  type JobSource,
  type SafeFailure,
  type SchemaRef
} from '@jooevents/reliability';

const RELIABILITY_JOB_IMMUTABLE_TABLES = [
  'reliability_job_attempts_trial',
  'reliability_job_attempt_completions_trial',
  'reliability_job_dispositions_trial'
] as const;

export const TRIAL_JOB_DISPOSITIONS = [
  'safe_retry',
  'reconcile',
  'renewed_approval',
  'replan',
  'compensate',
  'block',
  'attention'
] as const;

export type TrialJobDisposition = (typeof TRIAL_JOB_DISPOSITIONS)[number];

export const TRIAL_JOB_DISPOSITION_CAUSES = [
  'operation_nonterminal',
  'known_pre_submission_failure',
  'ambiguous_failure',
  'lease_expired',
  'timeout'
] as const;

export type TrialJobDispositionCause = (typeof TRIAL_JOB_DISPOSITION_CAUSES)[number];

export interface TrialJobDispositionPolicyRef {
  readonly reference: DefinitionRef<'job_disposition'>;
  readonly canonicalDigestSha256: CanonicalSha256;
}

export interface ReliabilityTrialJobDefinitionSnapshot {
  readonly inputSchema: SchemaRef;
  readonly resultSchema: SchemaRef;
  readonly errorDetailSchema: SchemaRef;
  readonly source: DefinitionRef<'source'>;
  readonly scopeCausation: DefinitionRef<'scope_causation'>;
  readonly inputProjection: DefinitionRef<'input_projection'>;
  readonly targetOperation: DefinitionRef<'operation'>;
  readonly capabilityRevisionId: JobDefinition['capabilityRevisionId'];
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly backoff: DefinitionRef<'backoff'>;
  readonly cancellation: DefinitionRef<'cancellation'>;
}

export interface ReliabilityTrialJobRecord {
  readonly job: JobRecord;
  readonly scope: EventScopeRef;
  readonly authorityCitationId: AuthorityCitationId;
  readonly definitionSnapshot: ReliabilityTrialJobDefinitionSnapshot;
  readonly dispositionPolicy: TrialJobDispositionPolicyRef;
}

export interface CreateReliabilityJobTrialInput {
  readonly id: JobId;
  readonly definition: JobDefinition;
  readonly registeredIdempotencyIdentity: string;
  readonly source: JobSource;
  readonly inputRef: PayloadRef;
  readonly scope: EventScopeRef;
  readonly authorityCitationId: AuthorityCitationId;
  readonly dispositionPolicy: TrialJobDispositionPolicyRef;
  readonly availableAt: Instant;
}

export interface ClaimReliabilityJobTrialInput {
  readonly jobId: JobId;
  readonly invocationId: InvocationId;
  readonly ownerKey: string;
  readonly faults?: {
    readonly afterAttemptInserted?: () => void;
  };
}

export interface CompleteReliabilityJobWithReceiptTrialInput {
  readonly jobId: JobId;
  readonly fence: ReturnType<typeof parseLeaseFence>;
  readonly receipt: TerminalEffectReceipt;
  readonly resultRef?: PayloadRef | null;
  readonly faults?: {
    readonly afterAttemptCompletionInserted?: () => void;
    readonly afterJobUpdated?: () => void;
  };
}

export interface SettleReliabilityJobTrialInput {
  readonly jobId: JobId;
  readonly fence: ReturnType<typeof parseLeaseFence>;
  readonly policy: TrialJobDispositionPolicyRef;
  readonly cause: TrialJobDispositionCause;
  readonly disposition: TrialJobDisposition;
  readonly reasonCode: string;
  readonly failure: SafeFailure;
  /** A relative delay; the store derives the absolute instant from its Clock. */
  readonly retryDelayMs?: number;
  readonly faults?: {
    readonly afterAttemptCompletionInserted?: () => void;
    readonly afterDispositionInserted?: () => void;
  };
}

export interface ReliabilityTrialJobAttemptEvidence {
  readonly jobId: JobId;
  readonly invocationId: InvocationId;
  readonly number: ReturnType<typeof parseAttemptNumber>;
  readonly fence: ReturnType<typeof parseLeaseFence>;
  readonly ownerKey: string;
  readonly startedAt: Instant;
  readonly leaseExpiresAt: Instant;
  readonly definitionDigestSha256: CanonicalSha256;
  readonly inputProjection: DefinitionRef<'input_projection'>;
  readonly targetOperation: DefinitionRef<'operation'>;
  readonly capabilityRevisionId: JobDefinition['capabilityRevisionId'];
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly completion:
    | {
        readonly state: JobAttemptFinished['state'];
        readonly completedAt: Instant;
        readonly resultRef: PayloadRef | null;
        readonly receiptId: string | null;
        readonly failure: SafeFailure | null;
      }
    | null;
}

export interface ReliabilityTrialJobDispositionEvidence {
  readonly jobId: JobId;
  readonly invocationId: InvocationId;
  readonly policy: TrialJobDispositionPolicyRef;
  readonly cause: TrialJobDispositionCause;
  readonly disposition: TrialJobDisposition;
  readonly reasonCode: string;
  readonly recordedAt: Instant;
  readonly nextActionAt: Instant | null;
}

export class SQLiteReliabilityJobTrialError extends Error {
  constructor(
    readonly code:
      | 'job_not_found'
      | 'concurrent_transition'
      | 'lost_fence'
      | 'lease_expired'
      | 'policy_mismatch'
      | 'invalid_disposition'
      | 'receipt_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'SQLiteReliabilityJobTrialError';
  }
}

interface JobRow {
  readonly job_id: string;
  readonly definition_key: string;
  readonly definition_version: number;
  readonly definition_digest_sha256: string;
  readonly registered_idempotency_identity: string;
  readonly source_kind: JobSource['definition']['kind'];
  readonly source_key: string;
  readonly source_version: number;
  readonly source_identity: string;
  readonly source_aggregate_version: number;
  readonly input_ref_id: string;
  readonly input_schema_key: string;
  readonly input_schema_version: number;
  readonly input_schema_digest_sha256: string;
  readonly result_schema_key: string;
  readonly result_schema_version: number;
  readonly result_schema_digest_sha256: string;
  readonly error_schema_key: string;
  readonly error_schema_version: number;
  readonly error_schema_digest_sha256: string;
  readonly registered_source_key: string;
  readonly registered_source_version: number;
  readonly scope_causation_key: string;
  readonly scope_causation_version: number;
  readonly input_projection_key: string;
  readonly input_projection_version: number;
  readonly target_operation_key: string;
  readonly target_operation_version: number;
  readonly capability_revision_id: string;
  readonly authority_citation_key: string;
  readonly authority_citation_version: number;
  readonly authority_citation_id: string;
  readonly backoff_key: string;
  readonly backoff_version: number;
  readonly cancellation_key: string;
  readonly cancellation_version: number;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly disposition_policy_key: string;
  readonly disposition_policy_version: number;
  readonly disposition_policy_digest_sha256: string;
  readonly external_retry_policy: JobRecord['externalRetryPolicy'];
  readonly maximum_attempts: number;
  readonly lease_duration_ms: number;
  readonly timeout_ms: number;
  readonly state: JobRecord['state'];
  readonly version: number;
  readonly current_fence: number | null;
  readonly lease_owner_key: string | null;
  readonly lease_attempt_id: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly next_action_at_ms: number | null;
}

interface AttemptRow {
  readonly job_id: string;
  readonly invocation_id: string;
  readonly attempt_number: number;
  readonly fence: number;
  readonly owner_key: string;
  readonly started_at_ms: number;
  readonly lease_expires_at_ms: number;
  readonly definition_digest_sha256: string;
  readonly input_projection_key: string;
  readonly input_projection_version: number;
  readonly target_operation_key: string;
  readonly target_operation_version: number;
  readonly capability_revision_id: string;
  readonly authority_citation_key: string;
  readonly authority_citation_version: number;
  readonly completion_state: JobAttemptFinished['state'] | null;
  readonly completed_at_ms: number | null;
  readonly result_ref_id: string | null;
  readonly receipt_id: string | null;
  readonly failure_code: string | null;
  readonly failure_classification: SafeFailure['classification'] | null;
}

interface DispositionRow {
  readonly job_id: string;
  readonly invocation_id: string;
  readonly policy_key: string;
  readonly policy_version: number;
  readonly policy_digest_sha256: string;
  readonly cause: TrialJobDispositionCause;
  readonly disposition: TrialJobDisposition;
  readonly reason_code: string;
  readonly recorded_at_ms: number;
  readonly next_action_at_ms: number | null;
}

interface ReceiptParentRow {
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: string;
  readonly result_json: string;
}

function run(sqlite: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  return sqlite.query(sql).run(...bindings);
}

function milliseconds(value: Instant): number {
  const parsed = Date.parse(parseInstant(value));
  if (!Number.isSafeInteger(parsed)) throw new TypeError('instant must fit epoch milliseconds');
  return parsed;
}

function instant(value: number): Instant {
  if (!Number.isSafeInteger(value)) throw new TypeError('stored instant must be epoch milliseconds');
  return parseInstant(new Date(value).toISOString());
}

function plusMilliseconds(value: Instant, durationMs: number, label: string): Instant {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  const result = milliseconds(value) + durationMs;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} overflows epoch milliseconds`);
  return instant(result);
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function samePolicy(left: TrialJobDispositionPolicyRef, right: TrialJobDispositionPolicyRef): boolean {
  return sameRef(left.reference, right.reference)
    && left.canonicalDigestSha256 === right.canonicalDigestSha256;
}

function failureFromRow(row: AttemptRow): SafeFailure | null {
  if (row.failure_code === null || row.failure_classification === null) return null;
  assertSafeCode(row.failure_code, 'stored job failure code');
  return Object.freeze({
    code: row.failure_code,
    classification: row.failure_classification
  });
}

function immutableTrigger(sqlite: Database, table: string): void {
  sqlite.exec(reliabilityJobImmutableTriggerSql(table));
}

function reliabilityJobImmutableTriggerSql(table: string): string {
  return `
    CREATE TRIGGER ${table}_reject_update
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table}_immutable');
    END;

    CREATE TRIGGER ${table}_reject_delete
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${table}_immutable');
    END;
  `;
}

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const RELIABILITY_JOB_TRIAL_SQL = `
    CREATE TABLE reliability_jobs_trial (
      job_id TEXT PRIMARY KEY,
      definition_key TEXT NOT NULL,
      definition_version INTEGER NOT NULL CHECK(definition_version > 0),
      definition_digest_sha256 TEXT NOT NULL CHECK(length(definition_digest_sha256) = 64 AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      registered_idempotency_identity TEXT NOT NULL CHECK(length(registered_idempotency_identity) BETWEEN 1 AND 240),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('domain_fact', 'effect', 'job', 'inbox_receipt')),
      source_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK(source_version > 0),
      source_identity TEXT NOT NULL,
      source_aggregate_version INTEGER NOT NULL CHECK(source_aggregate_version > 0),
      input_ref_id TEXT NOT NULL,
      input_schema_key TEXT NOT NULL,
      input_schema_version INTEGER NOT NULL CHECK(input_schema_version > 0),
      input_schema_digest_sha256 TEXT NOT NULL CHECK(length(input_schema_digest_sha256) = 64 AND input_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      result_schema_key TEXT NOT NULL,
      result_schema_version INTEGER NOT NULL CHECK(result_schema_version > 0),
      result_schema_digest_sha256 TEXT NOT NULL CHECK(length(result_schema_digest_sha256) = 64 AND result_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      error_schema_key TEXT NOT NULL,
      error_schema_version INTEGER NOT NULL CHECK(error_schema_version > 0),
      error_schema_digest_sha256 TEXT NOT NULL CHECK(length(error_schema_digest_sha256) = 64 AND error_schema_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      registered_source_key TEXT NOT NULL,
      registered_source_version INTEGER NOT NULL CHECK(registered_source_version > 0),
      scope_causation_key TEXT NOT NULL,
      scope_causation_version INTEGER NOT NULL CHECK(scope_causation_version > 0),
      input_projection_key TEXT NOT NULL,
      input_projection_version INTEGER NOT NULL CHECK(input_projection_version > 0),
      target_operation_key TEXT NOT NULL,
      target_operation_version INTEGER NOT NULL CHECK(target_operation_version > 0),
      capability_revision_id TEXT NOT NULL,
      authority_citation_key TEXT NOT NULL,
      authority_citation_version INTEGER NOT NULL CHECK(authority_citation_version > 0),
      authority_citation_id TEXT NOT NULL,
      backoff_key TEXT NOT NULL,
      backoff_version INTEGER NOT NULL CHECK(backoff_version > 0),
      cancellation_key TEXT NOT NULL,
      cancellation_version INTEGER NOT NULL CHECK(cancellation_version > 0),
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      disposition_policy_key TEXT NOT NULL,
      disposition_policy_version INTEGER NOT NULL CHECK(disposition_policy_version > 0),
      disposition_policy_digest_sha256 TEXT NOT NULL CHECK(length(disposition_policy_digest_sha256) = 64 AND disposition_policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      external_retry_policy TEXT NOT NULL CHECK(external_retry_policy IN ('forbidden', 'anchor_inspection_only')),
      maximum_attempts INTEGER NOT NULL CHECK(maximum_attempts > 0),
      lease_duration_ms INTEGER NOT NULL CHECK(lease_duration_ms > 0),
      timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
      state TEXT NOT NULL CHECK(state IN ('pending', 'leased', 'retry_wait', 'succeeded', 'dead_lettered', 'cancelled')),
      version INTEGER NOT NULL CHECK(version > 0),
      current_fence INTEGER CHECK(current_fence IS NULL OR current_fence > 0),
      lease_owner_key TEXT,
      lease_attempt_id TEXT,
      lease_expires_at_ms INTEGER,
      next_action_at_ms INTEGER,
      UNIQUE(definition_key, definition_version, registered_idempotency_identity),
      CHECK(
        (state = 'leased' AND current_fence IS NOT NULL AND lease_owner_key IS NOT NULL
          AND lease_attempt_id IS NOT NULL AND lease_expires_at_ms IS NOT NULL
          AND next_action_at_ms IS NULL)
        OR
        (state <> 'leased' AND lease_owner_key IS NULL AND lease_attempt_id IS NULL
          AND lease_expires_at_ms IS NULL)
      ),
      CHECK(
        (state IN ('pending', 'retry_wait') AND next_action_at_ms IS NOT NULL)
        OR
        (state IN ('leased', 'succeeded', 'dead_lettered', 'cancelled') AND next_action_at_ms IS NULL)
      )
    ) STRICT;

    CREATE TABLE reliability_job_attempts_trial (
      job_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
      fence INTEGER NOT NULL CHECK(fence > 0),
      owner_key TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL CHECK(lease_expires_at_ms > started_at_ms),
      definition_digest_sha256 TEXT NOT NULL CHECK(length(definition_digest_sha256) = 64 AND definition_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      input_projection_key TEXT NOT NULL,
      input_projection_version INTEGER NOT NULL CHECK(input_projection_version > 0),
      target_operation_key TEXT NOT NULL,
      target_operation_version INTEGER NOT NULL CHECK(target_operation_version > 0),
      capability_revision_id TEXT NOT NULL,
      authority_citation_key TEXT NOT NULL,
      authority_citation_version INTEGER NOT NULL CHECK(authority_citation_version > 0),
      PRIMARY KEY(job_id, invocation_id),
      UNIQUE(invocation_id),
      UNIQUE(job_id, attempt_number),
      UNIQUE(job_id, fence),
      FOREIGN KEY(job_id) REFERENCES reliability_jobs_trial(job_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION
    ) STRICT;

    CREATE TABLE reliability_job_attempt_completions_trial (
      job_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      completion_state TEXT NOT NULL CHECK(completion_state IN ('succeeded', 'retry_scheduled', 'dead_lettered', 'cancelled', 'lost_fence')),
      completed_at_ms INTEGER NOT NULL,
      result_ref_id TEXT,
      receipt_id TEXT,
      failure_code TEXT,
      failure_classification TEXT CHECK(failure_classification IS NULL OR failure_classification IN ('transient', 'permanent', 'ambiguous')),
      PRIMARY KEY(job_id, invocation_id),
      FOREIGN KEY(job_id, invocation_id) REFERENCES reliability_job_attempts_trial(job_id, invocation_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      FOREIGN KEY(receipt_id) REFERENCES operation_log(id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      CHECK(
        (completion_state IN ('retry_scheduled', 'dead_lettered') AND failure_code IS NOT NULL AND failure_classification IS NOT NULL)
        OR
        (completion_state IN ('succeeded', 'cancelled', 'lost_fence') AND failure_code IS NULL AND failure_classification IS NULL)
      ),
      CHECK(completion_state <> 'retry_scheduled' OR receipt_id IS NULL),
      CHECK(completion_state = 'succeeded' OR result_ref_id IS NULL)
    ) STRICT;

    CREATE TABLE reliability_job_dispositions_trial (
      job_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      policy_key TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version > 0),
      policy_digest_sha256 TEXT NOT NULL CHECK(length(policy_digest_sha256) = 64 AND policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
      cause TEXT NOT NULL CHECK(cause IN ('operation_nonterminal', 'known_pre_submission_failure', 'ambiguous_failure', 'lease_expired', 'timeout')),
      disposition TEXT NOT NULL CHECK(disposition IN ('safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention')),
      reason_code TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      next_action_at_ms INTEGER,
      PRIMARY KEY(job_id, invocation_id),
      FOREIGN KEY(job_id, invocation_id) REFERENCES reliability_job_attempt_completions_trial(job_id, invocation_id)
        ON UPDATE NO ACTION ON DELETE NO ACTION,
      CHECK((disposition = 'safe_retry' AND next_action_at_ms IS NOT NULL)
        OR (disposition <> 'safe_retry' AND next_action_at_ms IS NULL))
    ) STRICT;

    CREATE INDEX reliability_jobs_due_trial
      ON reliability_jobs_trial(state, next_action_at_ms, job_id);
    CREATE INDEX reliability_job_attempts_by_job_trial
      ON reliability_job_attempts_trial(job_id, attempt_number);

    CREATE TRIGGER reliability_jobs_trial_reject_delete
    BEFORE DELETE ON reliability_jobs_trial
    BEGIN
      SELECT RAISE(ABORT, 'reliability_jobs_trial_history_required');
    END;

    CREATE TRIGGER reliability_jobs_trial_reject_binding_update
    BEFORE UPDATE ON reliability_jobs_trial
    WHEN OLD.job_id IS NOT NEW.job_id
      OR OLD.definition_key IS NOT NEW.definition_key
      OR OLD.definition_version IS NOT NEW.definition_version
      OR OLD.definition_digest_sha256 IS NOT NEW.definition_digest_sha256
      OR OLD.registered_idempotency_identity IS NOT NEW.registered_idempotency_identity
      OR OLD.source_kind IS NOT NEW.source_kind
      OR OLD.source_key IS NOT NEW.source_key
      OR OLD.source_version IS NOT NEW.source_version
      OR OLD.source_identity IS NOT NEW.source_identity
      OR OLD.source_aggregate_version IS NOT NEW.source_aggregate_version
      OR OLD.input_ref_id IS NOT NEW.input_ref_id
      OR OLD.input_schema_key IS NOT NEW.input_schema_key
      OR OLD.input_schema_version IS NOT NEW.input_schema_version
      OR OLD.input_schema_digest_sha256 IS NOT NEW.input_schema_digest_sha256
      OR OLD.result_schema_key IS NOT NEW.result_schema_key
      OR OLD.result_schema_version IS NOT NEW.result_schema_version
      OR OLD.result_schema_digest_sha256 IS NOT NEW.result_schema_digest_sha256
      OR OLD.error_schema_key IS NOT NEW.error_schema_key
      OR OLD.error_schema_version IS NOT NEW.error_schema_version
      OR OLD.error_schema_digest_sha256 IS NOT NEW.error_schema_digest_sha256
      OR OLD.registered_source_key IS NOT NEW.registered_source_key
      OR OLD.registered_source_version IS NOT NEW.registered_source_version
      OR OLD.scope_causation_key IS NOT NEW.scope_causation_key
      OR OLD.scope_causation_version IS NOT NEW.scope_causation_version
      OR OLD.input_projection_key IS NOT NEW.input_projection_key
      OR OLD.input_projection_version IS NOT NEW.input_projection_version
      OR OLD.target_operation_key IS NOT NEW.target_operation_key
      OR OLD.target_operation_version IS NOT NEW.target_operation_version
      OR OLD.capability_revision_id IS NOT NEW.capability_revision_id
      OR OLD.authority_citation_key IS NOT NEW.authority_citation_key
      OR OLD.authority_citation_version IS NOT NEW.authority_citation_version
      OR OLD.authority_citation_id IS NOT NEW.authority_citation_id
      OR OLD.backoff_key IS NOT NEW.backoff_key
      OR OLD.backoff_version IS NOT NEW.backoff_version
      OR OLD.cancellation_key IS NOT NEW.cancellation_key
      OR OLD.cancellation_version IS NOT NEW.cancellation_version
      OR OLD.workspace_id IS NOT NEW.workspace_id
      OR OLD.event_id IS NOT NEW.event_id
      OR OLD.disposition_policy_key IS NOT NEW.disposition_policy_key
      OR OLD.disposition_policy_version IS NOT NEW.disposition_policy_version
      OR OLD.disposition_policy_digest_sha256 IS NOT NEW.disposition_policy_digest_sha256
      OR OLD.external_retry_policy IS NOT NEW.external_retry_policy
      OR OLD.maximum_attempts IS NOT NEW.maximum_attempts
      OR OLD.lease_duration_ms IS NOT NEW.lease_duration_ms
      OR OLD.timeout_ms IS NOT NEW.timeout_ms
    BEGIN
      SELECT RAISE(ABORT, 'reliability_job_binding_immutable');
    END;
  `;

export const RELIABILITY_JOB_IMMUTABILITY_TRIAL_SQL = RELIABILITY_JOB_IMMUTABLE_TABLES
  .map(reliabilityJobImmutableTriggerSql)
  .join('\n');

export function installSQLiteReliabilityJobTrial(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(RELIABILITY_JOB_TRIAL_SQL);

  for (const table of RELIABILITY_JOB_IMMUTABLE_TABLES) {
    immutableTrigger(sqlite, table);
  }
}

export class SQLiteReliabilityJobTrial {
  private readonly readClock: () => Instant;

  constructor(
    private readonly sqlite: Database,
    clock: Clock
  ) {
    if (typeof clock?.now !== 'function') throw new TypeError('job execution requires a Clock');
    this.readClock = clock.now.bind(clock);
  }

  private now(): Instant {
    return parseInstant(this.readClock());
  }

  create(input: CreateReliabilityJobTrialInput): ReliabilityTrialJobRecord {
    const job = createJob(input);
    const policy = Object.freeze({
      reference: definitionRef(
        'job_disposition',
        String(parseDefinitionKey(input.dispositionPolicy.reference.key)),
        Number(parseContractVersion(input.dispositionPolicy.reference.version))
      ),
      canonicalDigestSha256: parseCanonicalSha256(
        input.dispositionPolicy.canonicalDigestSha256
      )
    });
    run(
      this.sqlite,
      `INSERT INTO reliability_jobs_trial (
        job_id, definition_key, definition_version, definition_digest_sha256,
        registered_idempotency_identity, source_kind, source_key, source_version,
        source_identity, source_aggregate_version, input_ref_id,
        input_schema_key, input_schema_version, input_schema_digest_sha256,
        result_schema_key, result_schema_version, result_schema_digest_sha256,
        error_schema_key, error_schema_version, error_schema_digest_sha256,
        registered_source_key, registered_source_version,
        scope_causation_key, scope_causation_version,
        input_projection_key, input_projection_version,
        target_operation_key, target_operation_version, capability_revision_id,
        authority_citation_key, authority_citation_version, authority_citation_id,
        backoff_key, backoff_version, cancellation_key, cancellation_version,
        workspace_id, event_id, disposition_policy_key, disposition_policy_version,
        disposition_policy_digest_sha256, external_retry_policy, maximum_attempts,
        lease_duration_ms, timeout_ms, state, version, current_fence,
        lease_owner_key, lease_attempt_id, lease_expires_at_ms, next_action_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )`,
      job.id,
      job.definition.key,
      job.definition.version,
      job.definitionDigestSha256,
      job.registeredIdempotencyIdentity,
      job.source.definition.kind,
      job.source.definition.key,
      job.source.definition.version,
      job.source.identity,
      job.source.version,
      job.inputRef.id,
      input.definition.inputSchema.key,
      input.definition.inputSchema.version,
      input.definition.inputSchema.canonicalSchemaDigestSha256,
      input.definition.resultSchema.key,
      input.definition.resultSchema.version,
      input.definition.resultSchema.canonicalSchemaDigestSha256,
      input.definition.errorDetailSchema.key,
      input.definition.errorDetailSchema.version,
      input.definition.errorDetailSchema.canonicalSchemaDigestSha256,
      input.definition.source.key,
      input.definition.source.version,
      input.definition.scopeCausation.key,
      input.definition.scopeCausation.version,
      job.inputProjection.key,
      job.inputProjection.version,
      job.targetOperation.key,
      job.targetOperation.version,
      job.capabilityRevisionId,
      job.authorityCitation.key,
      job.authorityCitation.version,
      input.authorityCitationId,
      input.definition.backoff.key,
      input.definition.backoff.version,
      input.definition.cancellation.key,
      input.definition.cancellation.version,
      input.scope.workspaceId,
      input.scope.eventId,
      policy.reference.key,
      policy.reference.version,
      policy.canonicalDigestSha256,
      job.externalRetryPolicy,
      job.maximumAttempts,
      job.leaseDurationMs,
      job.timeoutMs,
      job.state,
      job.version,
      job.currentFence,
      job.lease?.ownerKey ?? null,
      job.lease?.attemptId ?? null,
      job.lease ? milliseconds(job.lease.expiresAt) : null,
      job.nextActionAt ? milliseconds(job.nextActionAt) : null
    );
    return this.require(input.id);
  }

  read(jobId: JobId): ReliabilityTrialJobRecord | null {
    const row = this.sqlite.query<JobRow, [string]>(
      'SELECT * FROM reliability_jobs_trial WHERE job_id = ?'
    ).get(jobId);
    return row === null ? null : this.fromRow(row);
  }

  require(jobId: JobId): ReliabilityTrialJobRecord {
    const record = this.read(jobId);
    if (!record) throw new SQLiteReliabilityJobTrialError('job_not_found', 'job does not exist');
    return record;
  }

  claim(input: ClaimReliabilityJobTrialInput): ReliabilityTrialJobRecord {
    return this.sqlite.transaction(() => {
      const current = this.require(input.jobId);
      const now = this.now();
      if (
        current.job.state === 'leased'
        && current.job.lease !== null
        && current.job.lease.ownerKey === input.ownerKey
        && current.job.lease.expiresAt > now
      ) {
        return current;
      }
      const next = claimJob(current.job, {
        invocationId: input.invocationId,
        ownerKey: input.ownerKey,
        now,
        leaseExpiresAt: plusMilliseconds(now, current.job.leaseDurationMs, 'job lease')
      });
      const attempt = next.attempts.at(-1);
      if (attempt === undefined || attempt.state !== 'running' || next.lease === null) {
        throw new TypeError('job claim did not append a running attempt');
      }
      run(
        this.sqlite,
        `INSERT INTO reliability_job_attempts_trial (
          job_id, invocation_id, attempt_number, fence, owner_key, started_at_ms,
          lease_expires_at_ms, definition_digest_sha256,
          input_projection_key, input_projection_version,
          target_operation_key, target_operation_version, capability_revision_id,
          authority_citation_key, authority_citation_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        next.id,
        attempt.invocationId,
        attempt.number,
        attempt.fence,
        input.ownerKey,
        milliseconds(attempt.startedAt),
        milliseconds(next.lease.expiresAt),
        next.definitionDigestSha256,
        next.inputProjection.key,
        next.inputProjection.version,
        next.targetOperation.key,
        next.targetOperation.version,
        next.capabilityRevisionId,
        next.authorityCitation.key,
        next.authorityCitation.version
      );
      input.faults?.afterAttemptInserted?.();
      this.update(current.job, next);
      return this.require(next.id);
    })();
  }

  completeWithReceipt(
    input: CompleteReliabilityJobWithReceiptTrialInput
  ): ReliabilityTrialJobRecord {
    const transition = () => {
      const current = this.require(input.jobId);
      const now = this.now();
      this.assertCurrentFence(current.job, input.fence);
      if (current.job.lease === null || current.job.lease.expiresAt <= now) {
        throw new SQLiteReliabilityJobTrialError(
          'lease_expired',
          'expired job work cannot attach a terminal receipt'
        );
      }
      const running = current.job.attempts.find(
        (attempt) => attempt.state === 'running' && attempt.fence === input.fence
      );
      if (!running || milliseconds(now) - milliseconds(running.startedAt) >= current.job.timeoutMs) {
        throw new SQLiteReliabilityJobTrialError(
          'lease_expired',
          'timed-out job work cannot attach a terminal receipt'
        );
      }
      if (
        input.receipt.ref.operationName !== current.job.targetOperation.key
        || input.receipt.ref.operationVersion !== current.job.targetOperation.version
        || input.receipt.identity.surface !== 'application_job'
      ) {
        throw new SQLiteReliabilityJobTrialError(
          'receipt_mismatch',
          'terminal receipt does not belong to the job target operation'
        );
      }
      const parent = this.sqlite.query<ReceiptParentRow, [string]>(`
        SELECT operation_name, operation_version, surface, result_json
        FROM operation_log
        WHERE id = ?
      `).get(input.receipt.ref.id);
      if (
        parent === null
        || parent.operation_name !== input.receipt.ref.operationName
        || parent.operation_version !== input.receipt.ref.operationVersion
        || parent.surface !== input.receipt.identity.surface
        || parent.result_json !== canonicalJsonText(input.receipt.result)
      ) {
        throw new SQLiteReliabilityJobTrialError(
          'receipt_mismatch',
          'terminal operation log is absent or differs from the authenticated receipt'
        );
      }
      const next = completeJob(current.job, input.fence, now, {
        kind: 'succeeded',
        resultRef: input.resultRef ?? null
      });
      this.insertCompletion(current.job, next, input.receipt.ref.id);
      input.faults?.afterAttemptCompletionInserted?.();
      this.update(current.job, next);
      input.faults?.afterJobUpdated?.();
      return this.require(next.id);
    };
    return this.sqlite.inTransaction ? transition() : this.sqlite.transaction(transition)();
  }

  /** Uses the store-owned Clock to prevent callers from downgrading timeout/expiry ambiguity. */
  classifyDispositionCause(
    jobId: JobId,
    fence: ReturnType<typeof parseLeaseFence>,
    intended: Exclude<TrialJobDispositionCause, 'lease_expired' | 'timeout'>
  ): TrialJobDispositionCause {
    if (!TRIAL_JOB_DISPOSITION_CAUSES.includes(intended)) {
      throw new SQLiteReliabilityJobTrialError(
        'invalid_disposition',
        'job disposition cause is not closed'
      );
    }
    const current = this.require(jobId);
    this.assertCurrentFence(current.job, fence);
    const now = this.now();
    const lease = current.job.lease;
    if (lease === null) {
      throw new SQLiteReliabilityJobTrialError('lost_fence', 'job has no active lease');
    }
    if (lease.expiresAt <= now) return 'lease_expired';
    const running = current.job.attempts.find(
      (attempt) => attempt.state === 'running' && attempt.fence === fence
    );
    if (!running) {
      throw new SQLiteReliabilityJobTrialError('lost_fence', 'job attempt is not running');
    }
    if (milliseconds(now) - milliseconds(running.startedAt) >= current.job.timeoutMs) {
      return 'timeout';
    }
    return intended;
  }

  settle(input: SettleReliabilityJobTrialInput): ReliabilityTrialJobRecord {
    const transition = () => {
      const current = this.require(input.jobId);
      const now = this.now();
      this.assertCurrentFence(current.job, input.fence);
      if (!samePolicy(current.dispositionPolicy, input.policy)) {
        throw new SQLiteReliabilityJobTrialError(
          'policy_mismatch',
          'job disposition policy differs from its frozen registration'
        );
      }
      assertSafeCode(input.reasonCode, 'job disposition reason');
      assertSafeCode(input.failure.code, 'job disposition failure');
      if (!TRIAL_JOB_DISPOSITION_CAUSES.includes(input.cause)) {
        throw new SQLiteReliabilityJobTrialError('invalid_disposition', 'job disposition cause is not closed');
      }
      if (!TRIAL_JOB_DISPOSITIONS.includes(input.disposition)) {
        throw new SQLiteReliabilityJobTrialError('invalid_disposition', 'job disposition is not closed');
      }
      const lease = current.job.lease;
      if (lease === null) {
        throw new SQLiteReliabilityJobTrialError('lost_fence', 'job has no active lease');
      }
      if (input.cause === 'lease_expired' && lease.expiresAt > now) {
        throw new SQLiteReliabilityJobTrialError(
          'invalid_disposition',
          'an unexpired job cannot be reduced as lease-expired'
        );
      }
      if (input.cause !== 'lease_expired' && lease.expiresAt <= now) {
        throw new SQLiteReliabilityJobTrialError(
          'lease_expired',
          'expired job work must use the registered lease-expiry disposition'
        );
      }
      const running = current.job.attempts.find(
        (attempt) => attempt.state === 'running' && attempt.fence === input.fence
      );
      if (!running) throw new SQLiteReliabilityJobTrialError('lost_fence', 'job attempt is not running');
      if (
        input.cause === 'timeout'
        && milliseconds(now) - milliseconds(running.startedAt) < current.job.timeoutMs
      ) {
        throw new SQLiteReliabilityJobTrialError(
          'invalid_disposition',
          'job timeout has not elapsed'
        );
      }

      const closedAmbiguity = input.cause === 'ambiguous_failure'
        || input.cause === 'lease_expired'
        || input.cause === 'timeout';
      if (closedAmbiguity) {
        const required = current.job.externalRetryPolicy === 'anchor_inspection_only'
          ? 'reconcile'
          : 'block';
        if (input.disposition !== required || input.failure.classification !== 'ambiguous') {
          throw new SQLiteReliabilityJobTrialError(
            'invalid_disposition',
            'ambiguous or expired work must remain closed under its external retry policy'
          );
        }
      }
      if (input.disposition === 'safe_retry' && input.failure.classification === 'ambiguous') {
        throw new SQLiteReliabilityJobTrialError(
          'invalid_disposition',
          'ambiguous work cannot become a safe retry without registered anchor inspection'
        );
      }

      let next: JobRecord;
      if (input.disposition === 'safe_retry') {
        if (
          input.retryDelayMs === undefined
          || !Number.isSafeInteger(input.retryDelayMs)
          || input.retryDelayMs <= 0
          || input.retryDelayMs > 86_400_000
        ) {
          throw new SQLiteReliabilityJobTrialError(
            'invalid_disposition',
            'safe retry requires one bounded relative delay'
          );
        }
        next = completeJob(current.job, input.fence, now, {
          kind: 'retry',
          retryAt: plusMilliseconds(now, input.retryDelayMs, 'job retry delay'),
          failure: input.failure
        });
        if (next.state !== 'retry_wait') {
          throw new SQLiteReliabilityJobTrialError(
            'invalid_disposition',
            'safe retry exceeds the frozen attempt policy'
          );
        }
      } else {
        if (input.retryDelayMs !== undefined) {
          throw new SQLiteReliabilityJobTrialError(
            'invalid_disposition',
            'only safe retry may carry a retry delay'
          );
        }
        next = completeJob(current.job, input.fence, now, {
          kind: 'dead_lettered',
          failure: input.failure
        });
      }

      this.insertCompletion(current.job, next, null);
      input.faults?.afterAttemptCompletionInserted?.();
      run(
        this.sqlite,
        `INSERT INTO reliability_job_dispositions_trial (
          job_id, invocation_id, policy_key, policy_version, policy_digest_sha256,
          cause, disposition, reason_code, recorded_at_ms, next_action_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        current.job.id,
        lease.attemptId,
        current.dispositionPolicy.reference.key,
        current.dispositionPolicy.reference.version,
        current.dispositionPolicy.canonicalDigestSha256,
        input.cause,
        input.disposition,
        input.reasonCode,
        milliseconds(now),
        next.nextActionAt ? milliseconds(next.nextActionAt) : null
      );
      input.faults?.afterDispositionInserted?.();
      this.update(current.job, next);
      return this.require(next.id);
    };
    return this.sqlite.inTransaction ? transition() : this.sqlite.transaction(transition)();
  }

  listAttemptEvidence(jobId: JobId): readonly ReliabilityTrialJobAttemptEvidence[] {
    return Object.freeze(this.attemptRows(jobId).map((row) => Object.freeze({
      jobId: parseJobId(row.job_id),
      invocationId: parseInvocationId(row.invocation_id),
      number: parseAttemptNumber(row.attempt_number),
      fence: parseLeaseFence(row.fence),
      ownerKey: row.owner_key,
      startedAt: instant(row.started_at_ms),
      leaseExpiresAt: instant(row.lease_expires_at_ms),
      definitionDigestSha256: parseCanonicalSha256(row.definition_digest_sha256),
      inputProjection: definitionRef(
        'input_projection',
        String(parseDefinitionKey(row.input_projection_key)),
        Number(parseContractVersion(row.input_projection_version))
      ),
      targetOperation: definitionRef(
        'operation',
        String(parseDefinitionKey(row.target_operation_key)),
        Number(parseContractVersion(row.target_operation_version))
      ),
      capabilityRevisionId: parseCapabilityRevisionId(row.capability_revision_id),
      authorityCitation: definitionRef(
        'authority_citation',
        String(parseDefinitionKey(row.authority_citation_key)),
        Number(parseContractVersion(row.authority_citation_version))
      ),
      completion: row.completion_state === null || row.completed_at_ms === null
        ? null
        : Object.freeze({
            state: row.completion_state,
            completedAt: instant(row.completed_at_ms),
            resultRef: row.result_ref_id === null
              ? null
              : createPayloadRef(parsePayloadRefId(row.result_ref_id)),
            receiptId: row.receipt_id,
            failure: failureFromRow(row)
          })
    })));
  }

  readLatestDisposition(jobId: JobId): ReliabilityTrialJobDispositionEvidence | null {
    const row = this.sqlite.query<DispositionRow, [string]>(`
      SELECT * FROM reliability_job_dispositions_trial
      WHERE job_id = ?
      ORDER BY recorded_at_ms DESC, invocation_id DESC
      LIMIT 1
    `).get(jobId);
    if (row === null) return null;
    return Object.freeze({
      jobId: parseJobId(row.job_id),
      invocationId: parseInvocationId(row.invocation_id),
      policy: Object.freeze({
        reference: definitionRef(
          'job_disposition',
          String(parseDefinitionKey(row.policy_key)),
          Number(parseContractVersion(row.policy_version))
        ),
        canonicalDigestSha256: parseCanonicalSha256(row.policy_digest_sha256)
      }),
      cause: row.cause,
      disposition: row.disposition,
      reasonCode: row.reason_code,
      recordedAt: instant(row.recorded_at_ms),
      nextActionAt: row.next_action_at_ms === null ? null : instant(row.next_action_at_ms)
    });
  }

  private assertCurrentFence(job: JobRecord, fence: ReturnType<typeof parseLeaseFence>): void {
    if (
      job.state !== 'leased'
      || job.lease === null
      || job.currentFence !== fence
      || job.lease.fence !== fence
    ) {
      throw new SQLiteReliabilityJobTrialError('lost_fence', 'job attempt lost its durable fence');
    }
  }

  private insertCompletion(
    previous: JobRecord,
    next: JobRecord,
    receiptId: string | null
  ): void {
    const attemptId = previous.lease?.attemptId;
    if (attemptId === undefined) throw new TypeError('job completion has no active attempt');
    const finished = next.attempts.find(
      (attempt): attempt is JobAttemptFinished =>
        attempt.invocationId === attemptId && attempt.state !== 'running'
    );
    if (!finished) throw new TypeError('job reducer did not finish its active attempt');
    run(
      this.sqlite,
      `INSERT INTO reliability_job_attempt_completions_trial (
        job_id, invocation_id, completion_state, completed_at_ms, result_ref_id,
        receipt_id, failure_code, failure_classification
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      previous.id,
      finished.invocationId,
      finished.state,
      milliseconds(finished.completedAt),
      finished.resultRef?.id ?? null,
      receiptId,
      finished.failure?.code ?? null,
      finished.failure?.classification ?? null
    );
  }

  private update(previous: JobRecord, next: JobRecord): void {
    const result = run(
      this.sqlite,
      `UPDATE reliability_jobs_trial
       SET state = ?, version = ?, current_fence = ?, lease_owner_key = ?,
           lease_attempt_id = ?, lease_expires_at_ms = ?, next_action_at_ms = ?
       WHERE job_id = ? AND version = ?`,
      next.state,
      next.version,
      next.currentFence,
      next.lease?.ownerKey ?? null,
      next.lease?.attemptId ?? null,
      next.lease ? milliseconds(next.lease.expiresAt) : null,
      next.nextActionAt ? milliseconds(next.nextActionAt) : null,
      previous.id,
      previous.version
    );
    if (result.changes !== 1) {
      throw new SQLiteReliabilityJobTrialError(
        'concurrent_transition',
        'job changed during its conditional transition'
      );
    }
  }

  private fromRow(row: JobRow): ReliabilityTrialJobRecord {
    const attempts = this.attemptRows(parseJobId(row.job_id)).map((attempt) =>
      this.attemptFromRow(attempt)
    );
    const job: JobRecord = Object.freeze({
      id: parseJobId(row.job_id),
      definition: definitionRef(
        'job',
        String(parseDefinitionKey(row.definition_key)),
        Number(parseContractVersion(row.definition_version))
      ),
      definitionDigestSha256: parseCanonicalSha256(row.definition_digest_sha256),
      registeredIdempotencyIdentity: row.registered_idempotency_identity,
      source: Object.freeze({
        definition: definitionRef(
          row.source_kind,
          String(parseDefinitionKey(row.source_key)),
          Number(parseContractVersion(row.source_version))
        ),
        identity: parseOpaqueSourceIdentity(row.source_identity),
        version: parseAggregateVersion(row.source_aggregate_version)
      }),
      inputRef: createPayloadRef(parsePayloadRefId(row.input_ref_id)),
      inputProjection: definitionRef(
        'input_projection',
        String(parseDefinitionKey(row.input_projection_key)),
        Number(parseContractVersion(row.input_projection_version))
      ),
      targetOperation: definitionRef(
        'operation',
        String(parseDefinitionKey(row.target_operation_key)),
        Number(parseContractVersion(row.target_operation_version))
      ),
      capabilityRevisionId: parseCapabilityRevisionId(row.capability_revision_id),
      authorityCitation: definitionRef(
        'authority_citation',
        String(parseDefinitionKey(row.authority_citation_key)),
        Number(parseContractVersion(row.authority_citation_version))
      ),
      externalRetryPolicy: row.external_retry_policy,
      maximumAttempts: row.maximum_attempts,
      leaseDurationMs: row.lease_duration_ms,
      timeoutMs: row.timeout_ms,
      state: row.state,
      version: parseAggregateVersion(row.version),
      currentFence: row.current_fence === null ? null : parseLeaseFence(row.current_fence),
      lease: row.lease_owner_key === null
        || row.lease_attempt_id === null
        || row.lease_expires_at_ms === null
        || row.current_fence === null
        ? null
        : Object.freeze({
            fence: parseLeaseFence(row.current_fence),
            ownerKey: row.lease_owner_key,
            attemptId: parseInvocationId(row.lease_attempt_id),
            expiresAt: instant(row.lease_expires_at_ms)
          }),
      nextActionAt: row.next_action_at_ms === null ? null : instant(row.next_action_at_ms),
      attempts: Object.freeze(attempts)
    });
    return Object.freeze({
      job,
      scope: Object.freeze({
        kind: 'event',
        workspaceId: parseWorkspaceId(row.workspace_id),
        eventId: parseEventId(row.event_id)
      }),
      authorityCitationId: parseAuthorityCitationId(row.authority_citation_id),
      definitionSnapshot: Object.freeze({
        inputSchema: this.schemaFromRow(
          row.input_schema_key,
          row.input_schema_version,
          row.input_schema_digest_sha256
        ),
        resultSchema: this.schemaFromRow(
          row.result_schema_key,
          row.result_schema_version,
          row.result_schema_digest_sha256
        ),
        errorDetailSchema: this.schemaFromRow(
          row.error_schema_key,
          row.error_schema_version,
          row.error_schema_digest_sha256
        ),
        source: definitionRef(
          'source',
          String(parseDefinitionKey(row.registered_source_key)),
          Number(parseContractVersion(row.registered_source_version))
        ),
        scopeCausation: definitionRef(
          'scope_causation',
          String(parseDefinitionKey(row.scope_causation_key)),
          Number(parseContractVersion(row.scope_causation_version))
        ),
        inputProjection: job.inputProjection,
        targetOperation: job.targetOperation,
        capabilityRevisionId: job.capabilityRevisionId,
        authorityCitation: job.authorityCitation,
        backoff: definitionRef(
          'backoff',
          String(parseDefinitionKey(row.backoff_key)),
          Number(parseContractVersion(row.backoff_version))
        ),
        cancellation: definitionRef(
          'cancellation',
          String(parseDefinitionKey(row.cancellation_key)),
          Number(parseContractVersion(row.cancellation_version))
        )
      }),
      dispositionPolicy: Object.freeze({
        reference: definitionRef(
          'job_disposition',
          String(parseDefinitionKey(row.disposition_policy_key)),
          Number(parseContractVersion(row.disposition_policy_version))
        ),
        canonicalDigestSha256: parseCanonicalSha256(row.disposition_policy_digest_sha256)
      })
    });
  }

  private schemaFromRow(key: string, version: number, digest: string): SchemaRef {
    return Object.freeze({
      key: parseDefinitionKey(key),
      version: parseContractVersion(version),
      canonicalSchemaDigestSha256: parseCanonicalSha256(digest)
    });
  }

  private attemptRows(jobId: JobId): readonly AttemptRow[] {
    return this.sqlite.query<AttemptRow, [string]>(`
      SELECT a.*, c.completion_state, c.completed_at_ms, c.result_ref_id,
             c.receipt_id, c.failure_code, c.failure_classification
      FROM reliability_job_attempts_trial a
      LEFT JOIN reliability_job_attempt_completions_trial c
        ON c.job_id = a.job_id AND c.invocation_id = a.invocation_id
      WHERE a.job_id = ?
      ORDER BY a.attempt_number, a.invocation_id
    `).all(jobId);
  }

  private attemptFromRow(row: AttemptRow): JobAttemptRunning | JobAttemptFinished {
    const base = {
      invocationId: parseInvocationId(row.invocation_id),
      number: parseAttemptNumber(row.attempt_number),
      fence: parseLeaseFence(row.fence),
      startedAt: instant(row.started_at_ms)
    };
    if (row.completion_state === null) return Object.freeze({ ...base, state: 'running' });
    if (row.completed_at_ms === null) throw new TypeError('finished job attempt lacks completion time');
    return Object.freeze({
      ...base,
      state: row.completion_state,
      completedAt: instant(row.completed_at_ms),
      resultRef: row.result_ref_id === null
        ? null
        : createPayloadRef(parsePayloadRefId(row.result_ref_id)),
      failure: failureFromRow(row)
    });
  }
}
