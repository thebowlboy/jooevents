import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { TerminalEffectReceipt } from '@jooevents/application';
import {
  canonicalJsonValue,
  canonicalJsonText,
  createPayloadRef,
  parseAggregateVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseInstant,
  parseIntegrationInboxReceiptId,
  parseInvocationId,
  parseJobId,
  parsePayloadRefId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifierRevisionId,
  parseWorkspaceId,
  parseEventId,
  type AuthorityCitationId,
  type CanonicalJson,
  type Clock,
  type Instant,
  type InvocationId,
  type JobId
} from '@jooevents/kernel';
import {
  assertSafeCode,
  definitionRef,
  parseInboxProcessingPointerId,
  parseCanonicalSha256,
  parseDefinitionKey,
  parseOpaqueSourceIdentity,
  type CanonicalSha256,
  type DefinitionRef,
  type JobDefinition
} from '@jooevents/reliability';
import type { SQLiteTrialEffectDomainAdapter } from './foundation-trial-uow';
import {
  type RegisteredJobOperationTrialDispositionPolicy,
  type RegisteredJobOperationTrialFaults,
  type RegisteredJobOperationTrialResult,
  type SQLiteRegisteredJobInputTrial
} from './registered-job-operation-trial';
import {
  type ReliabilityTrialJobRecord,
  type SQLiteReliabilityJobTrial
} from './reliability-job-trial';
import type { VerifiedInboxTrialProcessingContract } from './verified-inbox-trial';

const PROCESSING_CURSOR_PREFIX = 'vipc1_';
const PROCESSING_REF_PREFIX = 'vipr1_';
const ENQUEUE_IDENTITY_PREFIX = 'vije1_';
const SOURCE_IDENTITY_PREFIX = 'src1_';

export interface VerifiedInboxDependencyDeferPolicyTrialDraft {
  readonly reference: DefinitionRef<'inbox_dependency_policy'>;
  readonly maximumAttempts: number;
  readonly maximumElapsedMs: number;
  readonly retryDelayMs: number;
  readonly exhaustion: 'attention' | 'block';
}

export interface VerifiedInboxDependencyDeferPolicyTrial
  extends VerifiedInboxDependencyDeferPolicyTrialDraft {
  readonly canonicalDigestSha256: CanonicalSha256;
}

export interface VerifiedInboxProcessorDefinitionTrialDraft {
  readonly reference: DefinitionRef<'inbox_processor'>;
  readonly sourceConnectionId: string;
  readonly sourceConnectionRevisionId: string;
  readonly verifierContract: { readonly key: string; readonly version: number };
  readonly verifierRevisionId: string;
  readonly receiptSource: DefinitionRef<'inbox_receipt'>;
  readonly job: DefinitionRef<'job'>;
  readonly jobDefinitionDigestSha256: CanonicalSha256;
  readonly schedulerAction: DefinitionRef<'scheduler_action'>;
  readonly schedulerCapabilityRevisionId: string;
  readonly dependencyPolicy: VerifiedInboxDependencyDeferPolicyTrial;
}

export interface VerifiedInboxProcessorDefinitionTrial
  extends VerifiedInboxProcessorDefinitionTrialDraft {
  readonly canonicalDigestSha256: CanonicalSha256;
}

export interface VerifiedInboxProcessingDiscoveryCursorTrial {
  readonly value: string;
}

declare const discoveryCandidateBrand: unique symbol;

/** Discovery evidence only. Object identity is authenticated by the creating store. */
export interface VerifiedInboxProcessingDiscoveryCandidateTrial {
  readonly id: string;
  readonly [discoveryCandidateBrand]: true;
}

export interface VerifiedInboxProcessingDiscoveryPageTrial {
  readonly candidates: readonly VerifiedInboxProcessingDiscoveryCandidateTrial[];
  readonly nextCursor: VerifiedInboxProcessingDiscoveryCursorTrial | null;
}

export interface VerifiedInboxProcessingHeadTrial {
  readonly processingRef: string;
  readonly jobId: JobId;
  readonly state: 'queued' | 'succeeded' | 'attention' | 'blocked';
  readonly version: number;
  readonly dependencyDeadlineAt: Instant;
  readonly terminalReceiptId: string | null;
}

export interface VerifiedInboxProcessingEnqueueResultTrial {
  readonly kind: 'enqueued' | 'existing';
  readonly head: VerifiedInboxProcessingHeadTrial;
}

export interface VerifiedInboxProcessingDependencyPortTrial {
  prepare(input: {
    readonly processingRef: string;
    readonly receiptId: string;
    readonly payloadRef: ReturnType<typeof createPayloadRef>;
    readonly processor: DefinitionRef<'inbox_processor'>;
  }): Promise<
    | { readonly kind: 'ready'; readonly prepared: unknown }
    | { readonly kind: 'unavailable'; readonly reasonCode: string }
  >;
}

export interface RegisteredInboxProcessingJobRunnerTrial {
  run(input: {
    readonly jobId: JobId;
    readonly faults?: RegisteredJobOperationTrialFaults;
  }): Promise<RegisteredJobOperationTrialResult>;
}

export type VerifiedInboxProcessingRunResultTrial =
  | { readonly kind: 'terminal'; readonly result: RegisteredJobOperationTrialResult }
  | {
      readonly kind: 'operation_nonterminal';
      readonly result: Extract<
        RegisteredJobOperationTrialResult,
        { readonly kind: 'nonterminal' | 'settled' }
      >;
    }
  | { readonly kind: 'deferred'; readonly job: ReliabilityTrialJobRecord }
  | { readonly kind: 'requires_attention' | 'blocked'; readonly job: ReliabilityTrialJobRecord }
  | { readonly kind: 'not_due'; readonly job: ReliabilityTrialJobRecord };

export class SQLiteVerifiedInboxProcessingTrialError extends Error {
  constructor(
    readonly code:
      | 'composition_mismatch'
      | 'cursor_invalid'
      | 'candidate_invalid'
      | 'contract_mismatch'
      | 'head_not_found'
      | 'state_corrupt'
      | 'terminal_not_atomic',
    message: string,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = 'SQLiteVerifiedInboxProcessingTrialError';
  }
}

interface DiscoveryRow {
  readonly processing_pointer_id: string;
  readonly receipt_id: string;
  readonly created_at_ms: number;
}

interface CandidateSeal extends DiscoveryRow {
  readonly definitionDigestSha256: CanonicalSha256;
}

interface ReceiptAnchorRow extends DiscoveryRow {
  readonly adopted_payload_ref_id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly source_connection_id: string;
  readonly source_connection_revision_id: string;
  readonly verifier_contract_key: string;
  readonly verifier_contract_version: number;
  readonly verifier_revision_id: string;
  readonly processor_key: string;
  readonly processor_version: number;
  readonly processor_digest_sha256: string;
  readonly job_key: string;
  readonly job_version: number;
}

interface HeadRow {
  readonly processing_ref: string;
  readonly receipt_id: string;
  readonly processing_pointer_id: string;
  readonly job_id: string;
  readonly state: VerifiedInboxProcessingHeadTrial['state'];
  readonly version: number;
  readonly dependency_deadline_at_ms: number;
  readonly terminal_receipt_id: string | null;
}

interface ProbeRow extends HeadRow {
  readonly adopted_payload_ref_id: string;
}

function run(sqlite: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  return sqlite.query(sql).run(...bindings);
}

function milliseconds(value: Instant): number {
  const result = Date.parse(parseInstant(value));
  if (!Number.isSafeInteger(result)) throw new TypeError('instant must fit epoch milliseconds');
  return result;
}

function instant(value: number): Instant {
  if (!Number.isSafeInteger(value)) throw new TypeError('stored instant is invalid');
  return parseInstant(new Date(value).toISOString());
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function digest(value: unknown): CanonicalSha256 {
  return parseCanonicalSha256(createHash('sha256').update(canonicalJsonText(value)).digest('hex'));
}

function exactKey(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 128) {
    throw new SQLiteVerifiedInboxProcessingTrialError(
      'composition_mismatch',
      `${label} must contain 32 to 128 server-only bytes`
    );
  }
  return Uint8Array.from(value);
}

function positiveBound(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new SQLiteVerifiedInboxProcessingTrialError(
      'composition_mismatch',
      `${label} must be a positive bounded integer`
    );
  }
  return value;
}

export function sealVerifiedInboxDependencyDeferPolicyTrial(
  draft: VerifiedInboxDependencyDeferPolicyTrialDraft
): VerifiedInboxDependencyDeferPolicyTrial {
  const reference = definitionRef(
    'inbox_dependency_policy',
    String(draft.reference.key),
    Number(draft.reference.version)
  );
  const body = Object.freeze({
    kind: 'verified_inbox_dependency_policy_trial',
    version: 1,
    reference,
    maximumAttempts: positiveBound(draft.maximumAttempts, 100, 'dependency attempt bound'),
    maximumElapsedMs: positiveBound(
      draft.maximumElapsedMs,
      30 * 24 * 60 * 60 * 1_000,
      'dependency elapsed-time bound'
    ),
    retryDelayMs: positiveBound(draft.retryDelayMs, 24 * 60 * 60 * 1_000, 'dependency retry delay'),
    exhaustion: draft.exhaustion
  });
  if (body.exhaustion !== 'attention' && body.exhaustion !== 'block') {
    throw new SQLiteVerifiedInboxProcessingTrialError(
      'composition_mismatch',
      'dependency exhaustion must become attention or block'
    );
  }
  return Object.freeze({
    reference,
    maximumAttempts: body.maximumAttempts,
    maximumElapsedMs: body.maximumElapsedMs,
    retryDelayMs: body.retryDelayMs,
    exhaustion: body.exhaustion,
    canonicalDigestSha256: digest(body)
  });
}

export function sealVerifiedInboxProcessorDefinitionTrial(
  draft: VerifiedInboxProcessorDefinitionTrialDraft
): VerifiedInboxProcessorDefinitionTrial {
  const dependencyPolicy = sealVerifiedInboxDependencyDeferPolicyTrial(draft.dependencyPolicy);
  if (dependencyPolicy.canonicalDigestSha256 !== draft.dependencyPolicy.canonicalDigestSha256) {
    throw new SQLiteVerifiedInboxProcessingTrialError(
      'composition_mismatch',
      'dependency policy digest does not match its exact bounded contract'
    );
  }
  const body = Object.freeze({
    kind: 'verified_inbox_processor_trial',
    version: 1,
    reference: definitionRef(
      'inbox_processor', String(draft.reference.key), Number(draft.reference.version)
    ),
    sourceConnectionId: parseSourceConnectionId(draft.sourceConnectionId),
    sourceConnectionRevisionId: parseSourceConnectionRevisionId(
      draft.sourceConnectionRevisionId
    ),
    verifierContract: Object.freeze({
      key: String(parseDefinitionKey(draft.verifierContract.key)),
      version: parseContractVersion(draft.verifierContract.version)
    }),
    verifierRevisionId: parseVerifierRevisionId(draft.verifierRevisionId),
    receiptSource: definitionRef(
      'inbox_receipt', String(draft.receiptSource.key), Number(draft.receiptSource.version)
    ),
    job: definitionRef('job', String(draft.job.key), Number(draft.job.version)),
    jobDefinitionDigestSha256: parseCanonicalSha256(draft.jobDefinitionDigestSha256),
    schedulerAction: definitionRef(
      'scheduler_action', String(draft.schedulerAction.key), Number(draft.schedulerAction.version)
    ),
    schedulerCapabilityRevisionId: parseCapabilityRevisionId(
      draft.schedulerCapabilityRevisionId
    ),
    dependencyPolicy
  });
  return Object.freeze({ ...body, canonicalDigestSha256: digest(body) });
}

export function verifiedInboxTrialProcessingContractFromDefinition(
  definition: VerifiedInboxProcessorDefinitionTrial
): VerifiedInboxTrialProcessingContract {
  return Object.freeze({
    sourceConnectionId: definition.sourceConnectionId as VerifiedInboxTrialProcessingContract['sourceConnectionId'],
    sourceConnectionRevisionId: definition.sourceConnectionRevisionId as VerifiedInboxTrialProcessingContract['sourceConnectionRevisionId'],
    verifierContract: Object.freeze({
      key: definition.verifierContract.key,
      version: parseContractVersion(definition.verifierContract.version)
    }),
    verifierRevisionId: definition.verifierRevisionId as VerifiedInboxTrialProcessingContract['verifierRevisionId'],
    processor: definition.reference,
    processorDigestSha256: definition.canonicalDigestSha256,
    job: definition.job
  });
}

/** Installs namespaced test tables into the caller-supplied SQLite database. */
export const VERIFIED_INBOX_PROCESSING_TRIAL_SQL = `
    CREATE TABLE verified_inbox_processing_heads_trial (
      processing_ref TEXT NOT NULL UNIQUE CHECK(
        length(processing_ref) = 49 AND substr(processing_ref, 1, 6) = 'vipr1_'
      ),
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) = 36),
      processing_pointer_id TEXT NOT NULL UNIQUE CHECK(length(processing_pointer_id) = 36),
      enqueue_identity TEXT NOT NULL UNIQUE CHECK(
        length(enqueue_identity) = 49 AND substr(enqueue_identity, 1, 6) = 'vije1_'
      ),
      processor_key TEXT NOT NULL,
      processor_version INTEGER NOT NULL CHECK(processor_version > 0),
      processor_digest_sha256 TEXT NOT NULL CHECK(
        length(processor_digest_sha256) = 64
        AND processor_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      job_id TEXT NOT NULL UNIQUE CHECK(length(job_id) = 36),
      dependency_policy_key TEXT NOT NULL,
      dependency_policy_version INTEGER NOT NULL CHECK(dependency_policy_version > 0),
      dependency_policy_digest_sha256 TEXT NOT NULL CHECK(
        length(dependency_policy_digest_sha256) = 64
        AND dependency_policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      dependency_maximum_attempts INTEGER NOT NULL CHECK(dependency_maximum_attempts > 0),
      dependency_maximum_elapsed_ms INTEGER NOT NULL CHECK(dependency_maximum_elapsed_ms > 0),
      dependency_retry_delay_ms INTEGER NOT NULL CHECK(dependency_retry_delay_ms > 0),
      dependency_exhaustion TEXT NOT NULL CHECK(dependency_exhaustion IN ('attention', 'block')),
      enqueued_at_ms INTEGER NOT NULL,
      dependency_deadline_at_ms INTEGER NOT NULL CHECK(dependency_deadline_at_ms > enqueued_at_ms),
      state TEXT NOT NULL CHECK(state IN ('queued', 'succeeded', 'attention', 'blocked')),
      version INTEGER NOT NULL CHECK(version > 0),
      terminal_receipt_id TEXT,
      resolved_at_ms INTEGER,
      FOREIGN KEY (receipt_id) REFERENCES verified_inbox_receipt_processing_contracts_trial(receipt_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (processing_pointer_id) REFERENCES verified_inbox_processing_pointers_trial(processing_pointer_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (job_id) REFERENCES reliability_jobs_trial(job_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (terminal_receipt_id) REFERENCES operation_log(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK(
        (state = 'queued' AND terminal_receipt_id IS NULL AND resolved_at_ms IS NULL)
        OR (state = 'succeeded' AND terminal_receipt_id IS NOT NULL AND resolved_at_ms IS NOT NULL)
        OR (state IN ('attention', 'blocked') AND terminal_receipt_id IS NULL AND resolved_at_ms IS NOT NULL)
      )
    ) STRICT;

    CREATE TRIGGER verified_inbox_processing_heads_reject_binding_update_trial
    BEFORE UPDATE ON verified_inbox_processing_heads_trial
    WHEN OLD.processing_ref IS NOT NEW.processing_ref
      OR OLD.receipt_id IS NOT NEW.receipt_id
      OR OLD.processing_pointer_id IS NOT NEW.processing_pointer_id
      OR OLD.enqueue_identity IS NOT NEW.enqueue_identity
      OR OLD.processor_key IS NOT NEW.processor_key
      OR OLD.processor_version IS NOT NEW.processor_version
      OR OLD.processor_digest_sha256 IS NOT NEW.processor_digest_sha256
      OR OLD.job_id IS NOT NEW.job_id
      OR OLD.dependency_policy_key IS NOT NEW.dependency_policy_key
      OR OLD.dependency_policy_version IS NOT NEW.dependency_policy_version
      OR OLD.dependency_policy_digest_sha256 IS NOT NEW.dependency_policy_digest_sha256
      OR OLD.dependency_maximum_attempts IS NOT NEW.dependency_maximum_attempts
      OR OLD.dependency_maximum_elapsed_ms IS NOT NEW.dependency_maximum_elapsed_ms
      OR OLD.dependency_retry_delay_ms IS NOT NEW.dependency_retry_delay_ms
      OR OLD.dependency_exhaustion IS NOT NEW.dependency_exhaustion
      OR OLD.enqueued_at_ms IS NOT NEW.enqueued_at_ms
      OR OLD.dependency_deadline_at_ms IS NOT NEW.dependency_deadline_at_ms
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox processing binding is immutable');
    END;

    CREATE TRIGGER verified_inbox_processing_heads_reject_transition_trial
    BEFORE UPDATE ON verified_inbox_processing_heads_trial
    WHEN OLD.state <> 'queued'
      OR NEW.state NOT IN ('succeeded', 'attention', 'blocked')
      OR NEW.version <> OLD.version + 1
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox processing transition is invalid');
    END;

    CREATE TRIGGER verified_inbox_processing_heads_reject_delete_trial
    BEFORE DELETE ON verified_inbox_processing_heads_trial
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox processing heads are retained');
    END;

    CREATE TABLE verified_inbox_processing_dependency_events_trial (
      job_id TEXT NOT NULL CHECK(length(job_id) = 36),
      invocation_id TEXT NOT NULL CHECK(length(invocation_id) = 36),
      processing_ref TEXT NOT NULL,
      policy_key TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version > 0),
      policy_digest_sha256 TEXT NOT NULL CHECK(
        length(policy_digest_sha256) = 64
        AND policy_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      disposition TEXT NOT NULL CHECK(disposition IN ('defer', 'attention', 'block')),
      reason_code TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      next_action_at_ms INTEGER,
      PRIMARY KEY (job_id, invocation_id),
      FOREIGN KEY (job_id, invocation_id)
        REFERENCES reliability_job_attempt_completions_trial(job_id, invocation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (processing_ref) REFERENCES verified_inbox_processing_heads_trial(processing_ref)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK(
        (disposition = 'defer' AND next_action_at_ms IS NOT NULL)
        OR (disposition <> 'defer' AND next_action_at_ms IS NULL)
      )
    ) STRICT;

    CREATE TRIGGER verified_inbox_processing_dependency_events_reject_update_trial
    BEFORE UPDATE ON verified_inbox_processing_dependency_events_trial
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox dependency evidence is append-only');
    END;

    CREATE TRIGGER verified_inbox_processing_dependency_events_reject_delete_trial
    BEFORE DELETE ON verified_inbox_processing_dependency_events_trial
    BEGIN
      SELECT RAISE(ABORT, 'verified inbox dependency evidence is append-only');
    END;

    CREATE INDEX verified_inbox_processing_discovery_trial
      ON verified_inbox_processing_pointers_trial(created_at_ms, processing_pointer_id);
  `;

export function installSQLiteVerifiedInboxProcessingTrial(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(VERIFIED_INBOX_PROCESSING_TRIAL_SQL);
}

function encodeOpaque(prefix: string, key: Uint8Array, purpose: string, value: unknown): string {
  const result = createHmac('sha256', key)
    .update(`jooevents.${purpose}.v1\0`, 'utf8')
    .update(canonicalJsonText(value), 'utf8')
    .digest('base64url');
  return `${prefix}${result}`;
}

function cursorBody(row: DiscoveryRow): string {
  return Buffer.from(canonicalJsonText({
    createdAtMs: row.created_at_ms,
    processingPointerId: row.processing_pointer_id
  })).toString('base64url');
}

function cursorValue(row: DiscoveryRow, key: Uint8Array): VerifiedInboxProcessingDiscoveryCursorTrial {
  const body = cursorBody(row);
  const authentication = createHmac('sha256', key)
    .update('jooevents.verified-inbox-processing.cursor.v1\0', 'utf8')
    .update(body, 'utf8')
    .digest('base64url');
  return Object.freeze({ value: `${PROCESSING_CURSOR_PREFIX}${body}.${authentication}` });
}

function parseCursor(
  cursor: VerifiedInboxProcessingDiscoveryCursorTrial | undefined,
  key: Uint8Array
): { readonly createdAtMs: number; readonly processingPointerId: string } | null {
  if (!cursor) return null;
  if (!Object.isFrozen(cursor) || typeof cursor.value !== 'string' || cursor.value.length > 512) {
    throw new SQLiteVerifiedInboxProcessingTrialError('cursor_invalid', 'processing cursor is invalid');
  }
  const encoded = cursor.value.slice(PROCESSING_CURSOR_PREFIX.length);
  if (!cursor.value.startsWith(PROCESSING_CURSOR_PREFIX) || !encoded.includes('.')) {
    throw new SQLiteVerifiedInboxProcessingTrialError('cursor_invalid', 'processing cursor is invalid');
  }
  const [body, supplied, extra] = encoded.split('.');
  if (!body || !supplied || extra !== undefined) {
    throw new SQLiteVerifiedInboxProcessingTrialError('cursor_invalid', 'processing cursor is invalid');
  }
  const expected = createHmac('sha256', key)
    .update('jooevents.verified-inbox-processing.cursor.v1\0', 'utf8')
    .update(body, 'utf8')
    .digest();
  let suppliedBytes: Buffer;
  try {
    suppliedBytes = Buffer.from(supplied, 'base64url');
  } catch {
    throw new SQLiteVerifiedInboxProcessingTrialError('cursor_invalid', 'processing cursor is invalid');
  }
  if (suppliedBytes.length !== expected.length || !timingSafeEqual(suppliedBytes, expected)) {
    throw new SQLiteVerifiedInboxProcessingTrialError('cursor_invalid', 'processing cursor is invalid');
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(',') !== 'createdAtMs,processingPointerId'
      || !Number.isSafeInteger(parsed.createdAtMs)
      || typeof parsed.processingPointerId !== 'string'
    ) throw new TypeError('invalid cursor body');
    return Object.freeze({
      createdAtMs: parsed.createdAtMs as number,
      processingPointerId: String(parseInboxProcessingPointerId(parsed.processingPointerId))
    });
  } catch (cause) {
    throw new SQLiteVerifiedInboxProcessingTrialError(
      'cursor_invalid', 'processing cursor is invalid', { cause }
    );
  }
}

function headFromRow(row: HeadRow): VerifiedInboxProcessingHeadTrial {
  return Object.freeze({
    processingRef: row.processing_ref,
    jobId: parseJobId(row.job_id),
    state: row.state,
    version: row.version,
    dependencyDeadlineAt: instant(row.dependency_deadline_at_ms),
    terminalReceiptId: row.terminal_receipt_id
  });
}

export interface SQLiteVerifiedInboxProcessingTrialOptions {
  readonly definition: VerifiedInboxProcessorDefinitionTrial;
  readonly jobDefinition: JobDefinition;
  readonly authorityCitationId: AuthorityCitationId;
  readonly jobDispositionPolicy: RegisteredJobOperationTrialDispositionPolicy;
  readonly cursorKeyBytes: Uint8Array;
  readonly enqueueKeyBytes: Uint8Array;
  readonly maximumPageSize: number;
  readonly clock: Clock;
  readonly jobs: SQLiteReliabilityJobTrial;
  readonly inputs: SQLiteRegisteredJobInputTrial;
  readonly newJobId?: () => string;
  readonly newInputRefId?: () => string;
  readonly newCandidateId?: () => string;
}

export class SQLiteVerifiedInboxProcessingTrial {
  private readonly definition: VerifiedInboxProcessorDefinitionTrial;
  private readonly jobDefinition: JobDefinition;
  private readonly authorityCitationId: AuthorityCitationId;
  private readonly jobDispositionPolicy: RegisteredJobOperationTrialDispositionPolicy;
  private readonly cursorKey: Uint8Array;
  private readonly enqueueKey: Uint8Array;
  private readonly maximumPageSize: number;
  private readonly candidates = new WeakMap<object, CandidateSeal>();
  private readonly newJobId: () => string;
  private readonly newInputRefId: () => string;
  private readonly newCandidateId: () => string;

  constructor(
    private readonly sqlite: Database,
    private readonly options: SQLiteVerifiedInboxProcessingTrialOptions
  ) {
    this.definition = sealVerifiedInboxProcessorDefinitionTrial(options.definition);
    if (this.definition.canonicalDigestSha256 !== options.definition.canonicalDigestSha256) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'composition_mismatch', 'processor definition digest does not match its exact contract'
      );
    }
    this.jobDefinition = options.jobDefinition;
    if (
      !sameRef(this.definition.job, options.jobDefinition)
      || this.definition.jobDefinitionDigestSha256 !== options.jobDefinition.canonicalDigestSha256
      || this.definition.dependencyPolicy.maximumAttempts > options.jobDefinition.maximumAttempts
    ) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'composition_mismatch', 'processor and registered job definitions do not join exactly'
      );
    }
    if (
      options.jobDispositionPolicy.knownPreSubmissionFailure.disposition !== 'safe_retry'
      || options.jobDispositionPolicy.retryExhausted.disposition !== this.definition.dependencyPolicy.exhaustion
    ) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'composition_mismatch', 'job disposition policy does not preserve dependency defer/exhaustion'
      );
    }
    this.authorityCitationId = parseAuthorityCitationId(options.authorityCitationId);
    this.jobDispositionPolicy = options.jobDispositionPolicy;
    this.cursorKey = exactKey(options.cursorKeyBytes, 'processing cursor key');
    this.enqueueKey = exactKey(options.enqueueKeyBytes, 'processing enqueue key');
    this.maximumPageSize = positiveBound(options.maximumPageSize, 100, 'processing page size');
    this.newJobId = options.newJobId ?? (() => crypto.randomUUID());
    this.newInputRefId = options.newInputRefId ?? (() => crypto.randomUUID());
    this.newCandidateId = options.newCandidateId ?? (() => crypto.randomUUID());
  }

  list(
    cursor?: VerifiedInboxProcessingDiscoveryCursorTrial
  ): VerifiedInboxProcessingDiscoveryPageTrial {
    const after = parseCursor(cursor, this.cursorKey);
    const bindings: SQLQueryBindings[] = [
      this.definition.sourceConnectionId,
      this.definition.sourceConnectionRevisionId,
      this.definition.reference.key,
      this.definition.reference.version,
      this.definition.canonicalDigestSha256
    ];
    const rows = this.sqlite.query<DiscoveryRow, SQLQueryBindings[]>(`
      SELECT p.processing_pointer_id, p.receipt_id, p.created_at_ms
      FROM verified_inbox_processing_pointers_trial p
      WHERE EXISTS (
        SELECT 1
        FROM verified_inbox_receipt_processing_contracts_trial c
        WHERE c.receipt_id = p.receipt_id
          AND c.source_connection_id = ?
          AND c.source_connection_revision_id = ?
          AND c.processor_key = ? AND c.processor_version = ?
          AND c.processor_digest_sha256 = ?
      )
        AND NOT EXISTS (
          SELECT 1 FROM verified_inbox_processing_heads_trial h
          WHERE h.receipt_id = p.receipt_id
        )
        ${after ? 'AND (p.created_at_ms > ? OR (p.created_at_ms = ? AND p.processing_pointer_id > ?))' : ''}
      ORDER BY p.created_at_ms, p.processing_pointer_id
      LIMIT ?
    `).all(
      ...bindings,
      ...(after ? [after.createdAtMs, after.createdAtMs, after.processingPointerId] : []),
      this.maximumPageSize + 1
    );
    const visible = rows.slice(0, this.maximumPageSize);
    const candidates = visible.map((row) => {
      const candidate = Object.freeze({ id: this.newCandidateId() }) as
        VerifiedInboxProcessingDiscoveryCandidateTrial;
      this.candidates.set(candidate, Object.freeze({
        ...row,
        definitionDigestSha256: this.definition.canonicalDigestSha256
      }));
      return candidate;
    });
    const last = visible.at(-1);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      nextCursor: rows.length > this.maximumPageSize && last
        ? cursorValue(last, this.cursorKey)
        : null
    });
  }

  enqueue(
    candidate: VerifiedInboxProcessingDiscoveryCandidateTrial,
    faults?: {
      readonly afterInputInserted?: () => void;
      readonly afterJobInserted?: () => void;
      readonly afterHeadInserted?: () => void;
      readonly afterCommit?: () => void;
    }
  ): VerifiedInboxProcessingEnqueueResultTrial {
    const sealed = this.candidates.get(candidate);
    if (!sealed || sealed.definitionDigestSha256 !== this.definition.canonicalDigestSha256) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'candidate_invalid', 'processing enqueue requires authentic discovery evidence'
      );
    }
    const transaction = this.sqlite.transaction(() => {
      const existing = this.readHeadByReceipt(sealed.receipt_id);
      if (existing) return Object.freeze({ kind: 'existing' as const, head: headFromRow(existing) });
      const anchor = this.readReceiptAnchor(sealed);
      this.assertAnchorMatchesDefinition(anchor);
      const enqueueIdentity = encodeOpaque(
        ENQUEUE_IDENTITY_PREFIX,
        this.enqueueKey,
        'verified-inbox-processing.enqueue-identity',
        { receiptId: anchor.receipt_id, processor: this.definition.reference }
      );
      const processingRef = encodeOpaque(
        PROCESSING_REF_PREFIX,
        this.enqueueKey,
        'verified-inbox-processing.processing-ref',
        { receiptId: anchor.receipt_id, processor: this.definition.reference }
      );
      const sourceIdentity = `${SOURCE_IDENTITY_PREFIX}${encodeOpaque(
        '', this.enqueueKey, 'verified-inbox-processing.source-identity',
        { receiptId: anchor.receipt_id, source: this.definition.receiptSource }
      )}`;
      const jobId = parseJobId(this.newJobId());
      const inputRef = createPayloadRef(parsePayloadRefId(this.newInputRefId()));
      this.options.inputs.append({
        job: this.definition.job,
        inputRef,
        value: Object.freeze({ processingRef })
      });
      faults?.afterInputInserted?.();
      const enqueuedAt = parseInstant(this.options.clock.now());
      this.options.jobs.create({
        id: jobId,
        definition: this.jobDefinition,
        registeredIdempotencyIdentity: enqueueIdentity,
        source: {
          definition: this.definition.receiptSource,
          identity: parseOpaqueSourceIdentity(sourceIdentity),
          version: parseAggregateVersion(1)
        },
        inputRef,
        scope: {
          kind: 'event',
          workspaceId: parseWorkspaceId(anchor.workspace_id),
          eventId: parseEventId(anchor.event_id)
        },
        authorityCitationId: this.authorityCitationId,
        dispositionPolicy: {
          reference: this.jobDispositionPolicy.reference,
          canonicalDigestSha256: this.jobDispositionPolicy.canonicalDigestSha256
        },
        availableAt: enqueuedAt
      });
      faults?.afterJobInserted?.();
      const deadline = milliseconds(enqueuedAt) + this.definition.dependencyPolicy.maximumElapsedMs;
      if (!Number.isSafeInteger(deadline)) {
        throw new SQLiteVerifiedInboxProcessingTrialError(
          'state_corrupt', 'processing dependency deadline overflows epoch milliseconds'
        );
      }
      run(
        this.sqlite,
        `INSERT INTO verified_inbox_processing_heads_trial (
          processing_ref, receipt_id, processing_pointer_id, enqueue_identity,
          processor_key, processor_version, processor_digest_sha256, job_id,
          dependency_policy_key, dependency_policy_version,
          dependency_policy_digest_sha256, dependency_maximum_attempts,
          dependency_maximum_elapsed_ms, dependency_retry_delay_ms,
          dependency_exhaustion, enqueued_at_ms, dependency_deadline_at_ms,
          state, version, terminal_receipt_id, resolved_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, NULL, NULL)`,
        processingRef,
        anchor.receipt_id,
        anchor.processing_pointer_id,
        enqueueIdentity,
        this.definition.reference.key,
        this.definition.reference.version,
        this.definition.canonicalDigestSha256,
        jobId,
        this.definition.dependencyPolicy.reference.key,
        this.definition.dependencyPolicy.reference.version,
        this.definition.dependencyPolicy.canonicalDigestSha256,
        this.definition.dependencyPolicy.maximumAttempts,
        this.definition.dependencyPolicy.maximumElapsedMs,
        this.definition.dependencyPolicy.retryDelayMs,
        this.definition.dependencyPolicy.exhaustion,
        milliseconds(enqueuedAt),
        deadline
      );
      faults?.afterHeadInserted?.();
      return Object.freeze({ kind: 'enqueued' as const, head: this.requireHeadByJob(jobId) });
    });
    const result = transaction.immediate();
    faults?.afterCommit?.();
    return result;
  }

  readHeadByJob(jobId: JobId): VerifiedInboxProcessingHeadTrial | null {
    const row = this.sqlite.query<HeadRow, [string]>(`
      SELECT processing_ref, receipt_id, processing_pointer_id, job_id, state, version,
             dependency_deadline_at_ms, terminal_receipt_id
      FROM verified_inbox_processing_heads_trial WHERE job_id = ?
    `).get(parseJobId(jobId));
    return row ? headFromRow(row) : null;
  }

  requireHeadByJob(jobId: JobId): VerifiedInboxProcessingHeadTrial {
    const head = this.readHeadByJob(jobId);
    if (!head) throw new SQLiteVerifiedInboxProcessingTrialError('head_not_found', 'processing head is absent');
    return head;
  }

  processorReference(): DefinitionRef<'inbox_processor'> {
    return this.definition.reference;
  }

  probeInput(jobId: JobId): {
    readonly processingRef: string;
    readonly receiptId: string;
    readonly payloadRef: ReturnType<typeof createPayloadRef>;
  } {
    const row = this.sqlite.query<ProbeRow, [string]>(`
      SELECT h.processing_ref, h.receipt_id, h.processing_pointer_id, h.job_id,
             h.state, h.version, h.dependency_deadline_at_ms, h.terminal_receipt_id,
             r.adopted_payload_ref_id
      FROM verified_inbox_processing_heads_trial h
      JOIN verified_inbox_receipts_trial r ON r.receipt_id = h.receipt_id
      WHERE h.job_id = ?
    `).get(parseJobId(jobId));
    if (!row || row.state !== 'queued') {
      throw new SQLiteVerifiedInboxProcessingTrialError('head_not_found', 'queued processing head is absent');
    }
    return Object.freeze({
      processingRef: row.processing_ref,
      receiptId: parseIntegrationInboxReceiptId(row.receipt_id),
      payloadRef: createPayloadRef(parsePayloadRefId(row.adopted_payload_ref_id))
    });
  }

  recordDependencyUnavailable(input: {
    readonly jobId: JobId;
    readonly fence: NonNullable<ReliabilityTrialJobRecord['job']['currentFence']>;
    readonly reasonCode: string;
  }): { readonly kind: 'deferred' | 'requires_attention' | 'blocked'; readonly job: ReliabilityTrialJobRecord } {
    assertSafeCode(input.reasonCode, 'inbox dependency reason');
    const transaction = this.sqlite.transaction(() => {
      const current = this.options.jobs.require(input.jobId);
      const headRow = this.sqlite.query<HeadRow, [string]>(`
        SELECT processing_ref, receipt_id, processing_pointer_id, job_id, state, version,
               dependency_deadline_at_ms, terminal_receipt_id
        FROM verified_inbox_processing_heads_trial WHERE job_id = ?
      `).get(input.jobId);
      if (!headRow || headRow.state !== 'queued' || current.job.lease === null) {
        throw new SQLiteVerifiedInboxProcessingTrialError(
          'state_corrupt', 'dependency disposition requires the exact queued job attempt'
        );
      }
      const now = parseInstant(this.options.clock.now());
      const policy = this.definition.dependencyPolicy;
      const nextAt = milliseconds(now) + policy.retryDelayMs;
      const exhausted = current.job.attempts.length >= policy.maximumAttempts
        || nextAt >= headRow.dependency_deadline_at_ms;
      const disposition = exhausted ? policy.exhaustion : 'safe_retry';
      const reasonCode = exhausted
        ? 'inbox.dependency_exhausted'
        : 'inbox.dependency_deferred';
      const settled = this.options.jobs.settle({
        jobId: input.jobId,
        fence: input.fence,
        policy: current.dispositionPolicy,
        cause: 'known_pre_submission_failure',
        disposition,
        reasonCode,
        failure: {
          code: input.reasonCode,
          classification: exhausted ? 'permanent' : 'transient'
        },
        ...(exhausted ? {} : { retryDelayMs: policy.retryDelayMs })
      });
      run(
        this.sqlite,
        `INSERT INTO verified_inbox_processing_dependency_events_trial (
          job_id, invocation_id, processing_ref, policy_key, policy_version,
          policy_digest_sha256, disposition, reason_code, observed_at_ms, next_action_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.jobId,
        current.job.lease.attemptId,
        headRow.processing_ref,
        policy.reference.key,
        policy.reference.version,
        policy.canonicalDigestSha256,
        exhausted ? policy.exhaustion : 'defer',
        reasonCode,
        milliseconds(now),
        exhausted ? null : nextAt
      );
      if (exhausted) {
        const result = run(
          this.sqlite,
          `UPDATE verified_inbox_processing_heads_trial
           SET state = ?, version = version + 1, resolved_at_ms = ?
           WHERE job_id = ? AND state = 'queued'`,
          policy.exhaustion === 'attention' ? 'attention' : 'blocked',
          milliseconds(now),
          input.jobId
        );
        if (result.changes !== 1) {
          throw new SQLiteVerifiedInboxProcessingTrialError(
            'state_corrupt', 'dependency exhaustion did not close one processing head'
          );
        }
      }
      return Object.freeze({
        kind: exhausted
          ? policy.exhaustion === 'attention' ? 'requires_attention' as const : 'blocked' as const
          : 'deferred' as const,
        job: settled
      });
    });
    return transaction.immediate();
  }

  completeWithAuthenticReceipt(receipt: TerminalEffectReceipt): void {
    if (!this.sqlite.inTransaction) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'terminal_not_atomic', 'processing success must share the operation receipt transaction'
      );
    }
    const row = this.sqlite.query<
      { job_id: string; state: string },
      [string, string, number]
    >(`
      SELECT h.job_id, h.state
      FROM verified_inbox_processing_heads_trial h
      JOIN reliability_job_attempt_completions_trial c ON c.job_id = h.job_id
      JOIN operation_log r ON r.id = c.receipt_id
      WHERE c.receipt_id = ? AND c.completion_state = 'succeeded'
        AND r.operation_name = ? AND r.operation_version = ? AND r.surface = 'application_job'
    `).get(receipt.ref.id, receipt.ref.operationName, receipt.ref.operationVersion);
    if (!row) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'terminal_not_atomic', 'authentic job completion is absent from the receipt transaction'
      );
    }
    if (row.state === 'succeeded') return;
    const now = parseInstant(this.options.clock.now());
    const updated = run(
      this.sqlite,
      `UPDATE verified_inbox_processing_heads_trial
       SET state = 'succeeded', version = version + 1,
           terminal_receipt_id = ?, resolved_at_ms = ?
       WHERE job_id = ? AND state = 'queued'`,
      receipt.ref.id,
      milliseconds(now),
      row.job_id
    );
    if (updated.changes !== 1) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'terminal_not_atomic', 'one queued processing head did not terminalize with its receipt'
      );
    }
  }

  private readHeadByReceipt(receiptId: string): HeadRow | null {
    return this.sqlite.query<HeadRow, [string]>(`
      SELECT processing_ref, receipt_id, processing_pointer_id, job_id, state, version,
             dependency_deadline_at_ms, terminal_receipt_id
      FROM verified_inbox_processing_heads_trial WHERE receipt_id = ?
    `).get(receiptId);
  }

  private readReceiptAnchor(sealed: CandidateSeal): ReceiptAnchorRow {
    const row = this.sqlite.query<ReceiptAnchorRow, [string, string, number]>(`
      SELECT p.processing_pointer_id, p.receipt_id, p.created_at_ms,
             r.adopted_payload_ref_id, r.workspace_id, r.event_id,
             c.source_connection_id, c.source_connection_revision_id,
             c.verifier_contract_key, c.verifier_contract_version, c.verifier_revision_id,
             c.processor_key, c.processor_version, c.processor_digest_sha256,
             c.job_key, c.job_version
      FROM verified_inbox_processing_pointers_trial p
      JOIN verified_inbox_receipts_trial r ON r.receipt_id = p.receipt_id
      JOIN verified_inbox_receipt_processing_contracts_trial c ON c.receipt_id = p.receipt_id
      WHERE p.processing_pointer_id = ? AND p.receipt_id = ? AND p.created_at_ms = ?
    `).get(sealed.processing_pointer_id, sealed.receipt_id, sealed.created_at_ms);
    if (!row) throw new SQLiteVerifiedInboxProcessingTrialError('candidate_invalid', 'discovery anchor changed');
    return row;
  }

  private assertAnchorMatchesDefinition(row: ReceiptAnchorRow): void {
    if (
      row.source_connection_id !== this.definition.sourceConnectionId
      || row.source_connection_revision_id !== this.definition.sourceConnectionRevisionId
      || row.verifier_contract_key !== this.definition.verifierContract.key
      || row.verifier_contract_version !== this.definition.verifierContract.version
      || row.verifier_revision_id !== this.definition.verifierRevisionId
      || row.processor_key !== this.definition.reference.key
      || row.processor_version !== this.definition.reference.version
      || row.processor_digest_sha256 !== this.definition.canonicalDigestSha256
      || row.job_key !== this.definition.job.key
      || row.job_version !== this.definition.job.version
    ) {
      throw new SQLiteVerifiedInboxProcessingTrialError(
        'contract_mismatch', 'discovered receipt no longer matches its frozen processing contract'
      );
    }
  }
}

export class VerifiedInboxPreparedSnapshotsTrial {
  private readonly values = new Map<string, unknown>();

  set(jobId: JobId, value: unknown): void {
    if (this.values.has(jobId)) throw new TypeError('job already has a prepared snapshot');
    this.values.set(jobId, deepFreezeCanonical(canonicalJsonValue(value)));
  }

  read(jobId: JobId): unknown {
    if (!this.values.has(jobId)) throw new TypeError('job has no prepared snapshot');
    return this.values.get(jobId);
  }

  clear(jobId: JobId): void {
    this.values.delete(jobId);
  }
}

function deepFreezeCanonical(value: CanonicalJson): CanonicalJson {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreezeCanonical(entry)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepFreezeCanonical(entry)])
    ));
  }
  return value;
}

export function withVerifiedInboxProcessingTerminalReduction(
  processing: SQLiteVerifiedInboxProcessingTrial,
  domain: SQLiteTrialEffectDomainAdapter
): SQLiteTrialEffectDomainAdapter {
  return Object.freeze({
    openHandlerSnapshot: domain.openHandlerSnapshot.bind(domain),
    applyDomainContribution: domain.applyDomainContribution.bind(domain),
    async afterOperationLogInserted(receipt: TerminalEffectReceipt) {
      processing.completeWithAuthenticReceipt(receipt);
      await domain.afterOperationLogInserted?.(receipt);
    },
    ...(domain.afterEffectContributionInserted
      ? { afterEffectContributionInserted: domain.afterEffectContributionInserted.bind(domain) }
      : {}),
    ...(domain.afterEffectApplicationCommitted
      ? { afterEffectApplicationCommitted: domain.afterEffectApplicationCommitted.bind(domain) }
      : {}),
    ...(domain.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: domain.afterUnitOfWorkCommitted.bind(domain) }
      : {})
  });
}

export function createSQLiteVerifiedInboxProcessingRunnerTrial(input: {
  readonly sqlite: Database;
  readonly processing: SQLiteVerifiedInboxProcessingTrial;
  readonly jobs: SQLiteReliabilityJobTrial;
  readonly registeredJobRunner: RegisteredInboxProcessingJobRunnerTrial;
  readonly dependency: VerifiedInboxProcessingDependencyPortTrial;
  readonly preparations: VerifiedInboxPreparedSnapshotsTrial;
  readonly workerKey: string;
  readonly clock: Clock;
  readonly newAttemptId: (jobId: JobId) => InvocationId;
}) {
  return Object.freeze({
    async run(runInput: {
      readonly jobId: JobId;
      readonly faults?: {
        readonly afterClaimed?: () => void;
        readonly afterDependencyPrepared?: () => void;
        readonly registeredJob?: RegisteredJobOperationTrialFaults;
        readonly afterReadyRun?: () => void;
      };
    }): Promise<VerifiedInboxProcessingRunResultTrial> {
      let job = input.jobs.require(runInput.jobId);
      const head = input.processing.requireHeadByJob(runInput.jobId);
      if (head.state === 'succeeded') {
        return Object.freeze({
          kind: 'terminal' as const,
          result: await input.registeredJobRunner.run({ jobId: runInput.jobId })
        });
      }
      if (head.state === 'attention') {
        return Object.freeze({ kind: 'requires_attention' as const, job });
      }
      if (head.state === 'blocked') return Object.freeze({ kind: 'blocked' as const, job });
      const now = parseInstant(input.clock.now());
      if (job.job.state === 'retry_wait' && job.job.nextActionAt && job.job.nextActionAt > now) {
        return Object.freeze({ kind: 'not_due' as const, job });
      }
      if (job.job.state !== 'leased') {
        job = input.jobs.claim({
          jobId: runInput.jobId,
          invocationId: parseInvocationId(input.newAttemptId(runInput.jobId)),
          ownerKey: input.workerKey
        });
        runInput.faults?.afterClaimed?.();
      } else if (job.job.lease?.ownerKey !== input.workerKey) {
        throw new SQLiteVerifiedInboxProcessingTrialError(
          'state_corrupt', 'processing job lease belongs to another worker'
        );
      }
      const fence = job.job.currentFence;
      if (fence === null || job.job.lease === null) {
        throw new SQLiteVerifiedInboxProcessingTrialError(
          'state_corrupt', 'processing dependency probe requires an active fence'
        );
      }
      const probe = input.processing.probeInput(runInput.jobId);
      const dependency = await input.dependency.prepare({
        ...probe,
        processor: input.processing.processorReference()
      });
      if (dependency.kind === 'unavailable') {
        const settled = input.processing.recordDependencyUnavailable({
          jobId: runInput.jobId,
          fence,
          reasonCode: dependency.reasonCode
        });
        return settled;
      }
      input.preparations.set(runInput.jobId, dependency.prepared);
      try {
        runInput.faults?.afterDependencyPrepared?.();
        const result = await input.registeredJobRunner.run({
          jobId: runInput.jobId,
          ...(runInput.faults?.registeredJob
            ? { faults: runInput.faults.registeredJob }
            : {})
        });
        runInput.faults?.afterReadyRun?.();
        return result.kind === 'terminal' || result.kind === 'already_terminal'
          ? Object.freeze({ kind: 'terminal' as const, result })
          : Object.freeze({ kind: 'operation_nonterminal' as const, result });
      } finally {
        input.preparations.clear(runInput.jobId);
      }
    }
  });
}
