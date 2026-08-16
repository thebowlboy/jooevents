import { createHmac } from 'node:crypto';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  applyModelIntervention,
  attachModelToolReceipt,
  calculateModelProfileDigest,
  calculateModelScaffoldDigest,
  claimModelAttempt,
  confirmModelCancellation,
  createModelRun,
  createModelToolCall,
  modelProviderIdempotencyKeyFor,
  parseModelRequestBinding,
  parseModelToolInputBinding,
  reduceModelAttempt,
  recordModelCancellationResult,
  requestModelCancellation,
  resolveExecutionMode,
  resumeModelRunAfterTools,
  validateProfile,
  validateScaffold,
  type ApplyModelInterventionInput,
  type ClaimModelAttemptInput,
  type CreateModelRunInput,
  type DeterministicFakeStore,
  type ModelAttemptObservation,
  type ModelAttemptRecord,
  type ModelCancelObservation,
  type ModelDefinitionRef,
  type ModelExecutionMode,
  type ModelProfileRevision,
  type ModelProviderIdempotencyKey,
  type ModelRequestBinding,
  type ModelRunRecord,
  type ModelScaffoldRevision,
  type ModelToolCallRecord,
  type ModelToolInputBinding,
  type NormalizedUsage,
  type SafeProviderEvidence,
  validateModelAttemptObservationUsage,
  validateNormalizedUsage
} from '@jooevents/model-adapter';
import type { TerminalEffectReceipt } from '@jooevents/application';
import {
  canonicalJsonText,
  createPayloadRef,
  encodeCanonicalJson,
  parseModelAttemptId,
  parsePayloadRefId,
  type AgentRunId,
  type ModelAttemptId,
  type ModelToolCallId,
  type OperationReceiptId,
  type PayloadRef,
  type UtcInstant
} from '@jooevents/kernel';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const MODEL_DURABILITY_TRIAL_SQL = `
CREATE TABLE model_profile_revisions_trial (
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  adapter_key TEXT NOT NULL CHECK(length(adapter_key) BETWEEN 1 AND 160),
  adapter_version INTEGER NOT NULL CHECK(adapter_version > 0),
  default_execution_mode TEXT NOT NULL CHECK(default_execution_mode IN ('batch', 'fast')),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  PRIMARY KEY (profile_key, revision_version),
  UNIQUE (profile_key, revision_version, digest)
) WITHOUT ROWID;

CREATE TRIGGER model_profile_revisions_immutable_update_trial
BEFORE UPDATE ON model_profile_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model profile revisions are immutable');
END;

CREATE TRIGGER model_profile_revisions_immutable_delete_trial
BEFORE DELETE ON model_profile_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model profile revisions are immutable');
END;

CREATE TABLE model_profile_current_trial (
  profile_key TEXT PRIMARY KEY,
  pointer_version INTEGER NOT NULL CHECK(pointer_version > 0),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  revision_digest TEXT NOT NULL CHECK(length(revision_digest) = 64 AND revision_digest NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (profile_key, revision_version, revision_digest)
    REFERENCES model_profile_revisions_trial(profile_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE model_scaffold_revisions_trial (
  scaffold_key TEXT NOT NULL CHECK(length(scaffold_key) BETWEEN 1 AND 160),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 160),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  PRIMARY KEY (scaffold_key, revision_version),
  UNIQUE (scaffold_key, revision_version, digest)
) WITHOUT ROWID;

CREATE TRIGGER model_scaffold_revisions_immutable_update_trial
BEFORE UPDATE ON model_scaffold_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model scaffold revisions are immutable');
END;

CREATE TRIGGER model_scaffold_revisions_immutable_delete_trial
BEFORE DELETE ON model_scaffold_revisions_trial
BEGIN
  SELECT RAISE(ABORT, 'model scaffold revisions are immutable');
END;

CREATE TABLE model_scaffold_current_trial (
  scaffold_key TEXT PRIMARY KEY,
  pointer_version INTEGER NOT NULL CHECK(pointer_version > 0),
  revision_version INTEGER NOT NULL CHECK(revision_version > 0),
  revision_digest TEXT NOT NULL CHECK(length(revision_digest) = 64 AND revision_digest NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (scaffold_key, revision_version, revision_digest)
    REFERENCES model_scaffold_revisions_trial(scaffold_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE model_binding_profiles_trial (
  profile_key TEXT NOT NULL CHECK(length(profile_key) BETWEEN 1 AND 160),
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  key_verification_digest TEXT NOT NULL
    CHECK(length(key_verification_digest) = 64 AND key_verification_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (profile_key, profile_version)
) WITHOUT ROWID;

CREATE TRIGGER model_binding_profiles_immutable_update_trial
BEFORE UPDATE ON model_binding_profiles_trial
BEGIN
  SELECT RAISE(ABORT, 'model binding profiles are immutable');
END;

CREATE TRIGGER model_binding_profiles_immutable_delete_trial
BEFORE DELETE ON model_binding_profiles_trial
BEGIN
  SELECT RAISE(ABORT, 'model binding profiles are immutable');
END;

CREATE TABLE model_runs_trial (
  run_id TEXT PRIMARY KEY CHECK(length(run_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN (
    'queued', 'running', 'waiting_for_tool', 'reconciling', 'cancel_requested',
    'attention', 'succeeded', 'failed', 'cancelled', 'exhausted'
  )),
  profile_key TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK(profile_version > 0),
  profile_digest TEXT NOT NULL CHECK(length(profile_digest) = 64 AND profile_digest NOT GLOB '*[^0-9a-f]*'),
  profile_adapter_key TEXT NOT NULL CHECK(length(profile_adapter_key) BETWEEN 1 AND 160),
  profile_adapter_version INTEGER NOT NULL CHECK(profile_adapter_version > 0),
  scaffold_key TEXT NOT NULL,
  scaffold_version INTEGER NOT NULL CHECK(scaffold_version > 0),
  scaffold_digest TEXT NOT NULL CHECK(length(scaffold_digest) = 64 AND scaffold_digest NOT GLOB '*[^0-9a-f]*'),
  active_attempt_id TEXT,
  active_attempt_fence INTEGER CHECK(active_attempt_fence IS NULL OR active_attempt_fence > 0),
  result_payload_ref_id TEXT CHECK(result_payload_ref_id IS NULL OR length(result_payload_ref_id) = 36),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  CHECK((active_attempt_id IS NULL) = (active_attempt_fence IS NULL)),
  FOREIGN KEY (profile_key, profile_version, profile_digest)
    REFERENCES model_profile_revisions_trial(profile_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (scaffold_key, scaffold_version, scaffold_digest)
    REFERENCES model_scaffold_revisions_trial(scaffold_key, revision_version, digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE model_attempts_trial (
  attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) = 36),
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  fence INTEGER NOT NULL CHECK(fence > 0),
  request_binding TEXT NOT NULL CHECK(
    length(request_binding) = 69 AND substr(request_binding, 1, 5) = 'mrb1_'
    AND substr(request_binding, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  request_binding_profile_key TEXT NOT NULL,
  request_binding_profile_version INTEGER NOT NULL CHECK(request_binding_profile_version > 0),
  normalized_request_payload_ref_id TEXT NOT NULL CHECK(length(normalized_request_payload_ref_id) = 36),
  request_binding_attempt_id TEXT NOT NULL CHECK(length(request_binding_attempt_id) = 36),
  adapter_key TEXT NOT NULL CHECK(length(adapter_key) BETWEEN 1 AND 160),
  adapter_version INTEGER NOT NULL CHECK(adapter_version > 0),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('batch', 'fast')),
  state TEXT NOT NULL CHECK(state IN (
    'started', 'succeeded', 'tool_requests', 'schema_invalid',
    'known_failure', 'acceptance_unknown', 'cancelled'
  )),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE (run_id, attempt_number),
  UNIQUE (run_id, fence),
  FOREIGN KEY (run_id) REFERENCES model_runs_trial(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (request_binding_profile_key, request_binding_profile_version)
    REFERENCES model_binding_profiles_trial(profile_key, profile_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE model_tool_calls_trial (
  tool_call_id TEXT PRIMARY KEY CHECK(length(tool_call_id) = 36),
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  provider_call_id TEXT NOT NULL CHECK(length(provider_call_id) BETWEEN 1 AND 300),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 200),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  input_payload_ref_id TEXT NOT NULL CHECK(length(input_payload_ref_id) = 36),
  input_binding TEXT NOT NULL CHECK(
    length(input_binding) = 69 AND substr(input_binding, 1, 5) = 'mtb1_'
    AND substr(input_binding, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  input_binding_profile_key TEXT NOT NULL,
  input_binding_profile_version INTEGER NOT NULL CHECK(input_binding_profile_version > 0),
  operation_receipt_id TEXT,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE (attempt_id, sequence),
  UNIQUE (attempt_id, provider_call_id),
  FOREIGN KEY (run_id) REFERENCES model_runs_trial(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES model_attempts_trial(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (input_binding_profile_key, input_binding_profile_version)
    REFERENCES model_binding_profiles_trial(profile_key, profile_version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_receipt_id)
    REFERENCES operation_log(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE model_attempt_payload_adoptions_trial (
  payload_ref_id TEXT PRIMARY KEY CHECK(length(payload_ref_id) = 36),
  run_id TEXT NOT NULL CHECK(length(run_id) = 36),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) = 36),
  attempt_fence INTEGER NOT NULL CHECK(attempt_fence > 0),
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('model_result', 'model_tool_input')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  model_tool_call_id TEXT,
  provider_call_id TEXT,
  operation_name TEXT,
  operation_version INTEGER CHECK(operation_version IS NULL OR operation_version > 0),
  stage_id TEXT NOT NULL CHECK(length(stage_id) = 36),
  stage_expected_version INTEGER NOT NULL CHECK(stage_expected_version > 0),
  stage_fence INTEGER NOT NULL CHECK(stage_fence > 0),
  stage_expires_at_ms INTEGER NOT NULL,
  reconciliation_policy_key TEXT NOT NULL,
  reconciliation_policy_version INTEGER NOT NULL CHECK(reconciliation_policy_version > 0),
  authentication_profile_key TEXT NOT NULL,
  authentication_profile_version INTEGER NOT NULL CHECK(authentication_profile_version > 0),
  authentication_tag TEXT NOT NULL CHECK(length(authentication_tag) = 64 AND authentication_tag NOT GLOB '*[^0-9a-f]*'),
  classification_profile_key TEXT NOT NULL,
  classification_profile_version INTEGER NOT NULL CHECK(classification_profile_version > 0),
  schema_profile_key TEXT NOT NULL,
  schema_profile_version INTEGER NOT NULL CHECK(schema_profile_version > 0),
  content_profile_key TEXT NOT NULL,
  content_profile_version INTEGER NOT NULL CHECK(content_profile_version > 0),
  integrity_profile_key TEXT NOT NULL,
  integrity_profile_version INTEGER NOT NULL CHECK(integrity_profile_version > 0),
  descriptor_auth_profile_key TEXT NOT NULL,
  descriptor_auth_profile_version INTEGER NOT NULL CHECK(descriptor_auth_profile_version > 0),
  scope_binding TEXT NOT NULL CHECK(length(scope_binding) BETWEEN 1 AND 256),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 255),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  integrity_digest TEXT NOT NULL CHECK(length(integrity_digest) = 64 AND integrity_digest NOT GLOB '*[^0-9a-f]*'),
  reduction_committed INTEGER NOT NULL DEFAULT 0 CHECK(reduction_committed IN (0, 1)),
  marked_adopted INTEGER NOT NULL DEFAULT 0 CHECK(marked_adopted IN (0, 1)),
  UNIQUE (run_id, attempt_id, attempt_fence, owner_kind, ordinal),
  UNIQUE (stage_id),
  CHECK(
    (owner_kind = 'model_result' AND ordinal = 0 AND model_tool_call_id IS NULL
      AND provider_call_id IS NULL AND operation_name IS NULL AND operation_version IS NULL)
    OR
    (owner_kind = 'model_tool_input' AND ordinal > 0 AND model_tool_call_id IS NOT NULL
      AND provider_call_id IS NOT NULL AND operation_name IS NOT NULL AND operation_version IS NOT NULL)
  ),
  CHECK(marked_adopted <= reduction_committed),
  FOREIGN KEY (run_id) REFERENCES model_runs_trial(run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES model_attempts_trial(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER model_attempt_payload_adoptions_identity_immutable_trial
BEFORE UPDATE ON model_attempt_payload_adoptions_trial
WHEN NEW.payload_ref_id != OLD.payload_ref_id
  OR NEW.run_id != OLD.run_id
  OR NEW.attempt_id != OLD.attempt_id
  OR NEW.attempt_fence != OLD.attempt_fence
  OR NEW.owner_kind != OLD.owner_kind
  OR NEW.ordinal != OLD.ordinal
  OR NEW.stage_id != OLD.stage_id
  OR NEW.scope_binding != OLD.scope_binding
  OR NEW.integrity_digest != OLD.integrity_digest
BEGIN
  SELECT RAISE(ABORT, 'model payload adoption identity is immutable');
END;

CREATE TABLE deterministic_fake_attempts_trial (
  attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) = 36),
  request_binding TEXT NOT NULL CHECK(
    length(request_binding) = 69 AND substr(request_binding, 1, 5) = 'mrb1_'
    AND substr(request_binding, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN (
    'succeeded', 'tool_requests', 'schema_invalid', 'known_failure',
    'acceptance_unknown', 'cancelled'
  )),
  cancelled INTEGER NOT NULL CHECK(cancelled IN (0, 1)),
  output_payload_ref_id TEXT CHECK(output_payload_ref_id IS NULL OR length(output_payload_ref_id) = 36),
  safe_code TEXT,
  retryability TEXT CHECK(retryability IS NULL OR retryability IN ('never', 'policy')),
  recovery TEXT CHECK(recovery IS NULL OR recovery IN ('lookup', 'idempotent_reuse', 'manual')),
  usage_present INTEGER NOT NULL CHECK(usage_present IN (0, 1)),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR (
    typeof(input_tokens) = 'integer' AND input_tokens BETWEEN 0 AND 9007199254740991
  )),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR (
    typeof(output_tokens) = 'integer' AND output_tokens BETWEEN 0 AND 9007199254740991
  )),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR (
    typeof(cached_input_tokens) = 'integer' AND cached_input_tokens BETWEEN 0 AND 9007199254740991
  )),
  cost_micros INTEGER CHECK(cost_micros IS NULL OR (
    typeof(cost_micros) = 'integer' AND cost_micros BETWEEN 0 AND 9007199254740991
  )),
  adapter_key TEXT,
  adapter_version INTEGER CHECK(adapter_version IS NULL OR adapter_version > 0),
  provider_request_id TEXT,
  idempotency_supported INTEGER CHECK(idempotency_supported IS NULL OR idempotency_supported IN (0, 1)),
  execution_mode TEXT CHECK(execution_mode IS NULL OR execution_mode IN ('batch', 'fast')),
  resolved_controls_json TEXT CHECK(resolved_controls_json IS NULL OR json_valid(resolved_controls_json)),
  CHECK((adapter_key IS NULL) = (adapter_version IS NULL)),
  CHECK((adapter_key IS NULL) = (idempotency_supported IS NULL))
) WITHOUT ROWID;

CREATE TABLE deterministic_fake_tool_requests_trial (
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  provider_call_id TEXT NOT NULL CHECK(length(provider_call_id) BETWEEN 1 AND 300),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 200),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  input_payload_ref_id TEXT NOT NULL CHECK(length(input_payload_ref_id) = 36),
  PRIMARY KEY (attempt_id, sequence),
  UNIQUE (attempt_id, provider_call_id),
  FOREIGN KEY (attempt_id) REFERENCES deterministic_fake_attempts_trial(attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;
`;

const digestPattern = /^[a-f0-9]{64}$/;

type StoredFakeAttempt = Exclude<ReturnType<DeterministicFakeStore['get']>, undefined>;

interface RevisionRow {
  readonly revision_json: string;
  readonly digest: string;
}

interface PointerRow {
  readonly pointer_version: number;
  readonly revision_version: number;
  readonly revision_digest: string;
}

interface RecordRow {
  readonly record_json: string;
}

interface RunRow extends RecordRow {
  readonly run_id: string;
  readonly version: number;
  readonly state: ModelRunRecord['state'];
  readonly profile_key: string;
  readonly profile_version: number;
  readonly profile_digest: string;
  readonly profile_adapter_key: string;
  readonly profile_adapter_version: number;
  readonly scaffold_key: string;
  readonly scaffold_version: number;
  readonly scaffold_digest: string;
  readonly active_attempt_id: string | null;
  readonly active_attempt_fence: number | null;
  readonly result_payload_ref_id: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

interface AttemptRow extends RecordRow {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly attempt_number: number;
  readonly fence: number;
  readonly request_binding: string;
  readonly request_binding_profile_key: string;
  readonly request_binding_profile_version: number;
  readonly normalized_request_payload_ref_id: string;
  readonly request_binding_attempt_id: string;
  readonly adapter_key: string;
  readonly adapter_version: number;
  readonly execution_mode: ModelExecutionMode;
  readonly state: ModelAttemptRecord['state'];
  readonly started_at_ms: number;
  readonly finished_at_ms: number | null;
}

interface ToolCallRow extends RecordRow {
  readonly tool_call_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly sequence: number;
  readonly provider_call_id: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly input_payload_ref_id: string;
  readonly input_binding: string;
  readonly input_binding_profile_key: string;
  readonly input_binding_profile_version: number;
  readonly operation_receipt_id: string | null;
}

interface FakeAttemptRow {
  readonly attempt_id: string;
  readonly request_binding: string;
  readonly outcome_kind: ModelAttemptObservation['kind'];
  readonly cancelled: number;
  readonly output_payload_ref_id: string | null;
  readonly safe_code: string | null;
  readonly retryability: 'never' | 'policy' | null;
  readonly recovery: 'lookup' | 'idempotent_reuse' | 'manual' | null;
  readonly usage_present: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cost_micros: number | null;
  readonly adapter_key: string | null;
  readonly adapter_version: number | null;
  readonly provider_request_id: string | null;
  readonly idempotency_supported: number | null;
  readonly execution_mode: ModelExecutionMode | null;
  readonly resolved_controls_json: string | null;
}

interface FakeToolRow {
  readonly provider_call_id: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly input_payload_ref_id: string;
}

export interface ModelRevisionPointer {
  readonly key: string;
  readonly pointerVersion: number;
  readonly revision: ModelDefinitionRef & { readonly digest: string };
}

export interface ModelBindingProfileRef {
  readonly key: string;
  readonly version: number;
}

export interface ModelTrialFrozenRequestBinding {
  readonly normalizedRequestPayloadRef: PayloadRef;
  readonly requestBindingAttemptId: ModelAttemptId;
}

export interface ModelTrialSealedAttemptReduction {
  readonly runId: AgentRunId;
  readonly attemptId: ModelAttemptId;
  readonly expectedRunVersion: number;
  readonly expectedFence: number;
  readonly requestBinding: ModelRequestBinding;
  readonly profile: ModelDefinitionRef & { readonly digest: string };
  readonly scaffold: ModelDefinitionRef & { readonly digest: string };
  readonly adapter: ModelDefinitionRef;
  readonly executionMode: ModelExecutionMode;
  readonly providerIdempotencyKey: ModelProviderIdempotencyKey;
  readonly observation: ModelAttemptObservation;
  readonly finishedAt: UtcInstant;
  readonly toolCalls: readonly {
    readonly id: ModelToolCallId;
    readonly sequence: number;
    readonly providerCallId: string;
    readonly operation: { readonly name: string; readonly version: number };
    readonly inputPayloadRef: PayloadRef;
  }[];
}

export interface ModelTrialSealedToolReceiptAttachment {
  readonly runId: AgentRunId;
  readonly attemptId: ModelAttemptId;
  readonly expectedFence: number;
  readonly toolCallId: ModelToolCallId;
  readonly expectedInputPayloadRef: PayloadRef;
  readonly expectedInputBinding: ModelToolInputBinding;
  readonly receipt: TerminalEffectReceipt;
}

export interface ModelTrialSealedToolResume {
  readonly runId: AgentRunId;
  readonly attemptId: ModelAttemptId;
  readonly expectedRunVersion: number;
  readonly expectedFence: number;
  readonly resumedAt: UtcInstant;
}

export interface ModelTrialSealedPersistenceOpeners {
  openAttemptReduction(seal: object): ModelTrialSealedAttemptReduction | undefined;
  openToolReceiptAttachment(seal: object): ModelTrialSealedToolReceiptAttachment | undefined;
  openToolResume(seal: object): ModelTrialSealedToolResume | undefined;
}

function assertDigest(value: string, label: string): void {
  if (!digestPattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
}

function epochMilliseconds(value: UtcInstant): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('instant must fit epoch milliseconds');
  return parsed;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function parseRecord<Value>(text: string): Value {
  return deepFreeze(JSON.parse(text) as Value);
}

function exactPayloadRef(value: unknown, label: string): PayloadRef {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 1 || typeof (value as { readonly id?: unknown }).id !== 'string'
  ) {
    throw new TypeError(`${label} must be an opaque PayloadRef`);
  }
  return createPayloadRef(parsePayloadRefId((value as { readonly id: string }).id));
}

function optionalUsage(row: FakeAttemptRow): NormalizedUsage | undefined {
  if (row.usage_present === 0) return undefined;
  const usage: NormalizedUsage = {
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.cached_input_tokens === null ? {} : { cachedInputTokens: row.cached_input_tokens }),
    ...(row.cost_micros === null ? {} : { costMicros: row.cost_micros })
  };
  validateNormalizedUsage(usage);
  return usage;
}

function optionalEvidence(row: FakeAttemptRow): SafeProviderEvidence | undefined {
  if (row.adapter_key === null || row.adapter_version === null || row.idempotency_supported === null) return undefined;
  return {
    adapter: { key: row.adapter_key, version: row.adapter_version },
    ...(row.provider_request_id === null ? {} : { providerRequestId: row.provider_request_id }),
    idempotencySupported: row.idempotency_supported === 1,
    ...(row.execution_mode === null ? {} : { executionMode: row.execution_mode }),
    ...(row.resolved_controls_json === null
      ? {}
      : { resolvedControls: parseRecord<Readonly<Record<string, string | number | boolean>>>(row.resolved_controls_json) })
  };
}

function requireUsage(row: FakeAttemptRow): NormalizedUsage {
  const usage = optionalUsage(row);
  if (!usage) throw new TypeError('durable_fake_usage_missing');
  return usage;
}

function requireEvidence(row: FakeAttemptRow): SafeProviderEvidence {
  const evidence = optionalEvidence(row);
  if (!evidence) throw new TypeError('durable_fake_evidence_missing');
  return evidence;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function runColumns(run: ModelRunRecord): SQLQueryBindings[] {
  return [
    run.version,
    run.state,
    run.profile.key,
    run.profile.version,
    run.profile.digest,
    run.profileAdapter.key,
    run.profileAdapter.version,
    run.scaffold.key,
    run.scaffold.version,
    run.scaffold.digest,
    run.activeAttempt?.id ?? null,
    run.activeAttempt?.fence ?? null,
    run.resultRef?.id ?? null,
    epochMilliseconds(run.updatedAt),
    canonicalJsonText(run)
  ];
}

function attemptColumns(attempt: ModelAttemptRecord): SQLQueryBindings[] {
  return [
    attempt.state,
    attempt.finishedAt ? epochMilliseconds(attempt.finishedAt) : null,
    canonicalJsonText(attempt)
  ];
}

export function installModelDurabilityTrial(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON');
  const foundationReceiptTable = sqlite.query<{ readonly present: number }, []>(`
    SELECT 1 AS present FROM sqlite_master
     WHERE type = 'table' AND name = 'operation_log'
  `).get();
  if (!foundationReceiptTable) throw new TypeError('foundation_trial_receipt_schema_required');
  sqlite.transaction(() => sqlite.exec(MODEL_DURABILITY_TRIAL_SQL))();
}

export class SqliteDeterministicFakeTrialStore implements DeterministicFakeStore {
  constructor(private readonly sqlite: Database) {}

  get(attemptId: string): StoredFakeAttempt | undefined {
    const row = this.sqlite.query<FakeAttemptRow, [string]>(`
      SELECT * FROM deterministic_fake_attempts_trial WHERE attempt_id = ?
    `).get(attemptId);
    if (!row) return undefined;

    const usage = optionalUsage(row);
    const evidence = optionalEvidence(row);
    let observation: ModelAttemptObservation;
    switch (row.outcome_kind) {
      case 'succeeded':
        observation = {
          kind: 'succeeded',
          output: createPayloadRef(parsePayloadRefId(row.output_payload_ref_id)),
          usage: requireUsage(row),
          evidence: requireEvidence(row)
        };
        break;
      case 'tool_requests': {
        const requests = this.sqlite.query<FakeToolRow, [string]>(`
          SELECT provider_call_id, operation_name, operation_version, input_payload_ref_id
            FROM deterministic_fake_tool_requests_trial
           WHERE attempt_id = ? ORDER BY sequence
        `).all(attemptId).map((request) => ({
          callId: request.provider_call_id,
          operation: { name: request.operation_name, version: request.operation_version },
          input: createPayloadRef(parsePayloadRefId(request.input_payload_ref_id))
        }));
        observation = { kind: 'tool_requests', requests, usage: requireUsage(row), evidence: requireEvidence(row) };
        break;
      }
      case 'schema_invalid':
        observation = {
          kind: 'schema_invalid',
          rawOutputRef: createPayloadRef(parsePayloadRefId(row.output_payload_ref_id)),
          usage: requireUsage(row),
          safeCode: row.safe_code ?? 'model_output_schema_invalid',
          evidence: requireEvidence(row)
        };
        break;
      case 'known_failure':
        if (!row.safe_code || !row.retryability) throw new TypeError('durable_fake_failure_evidence_missing');
        observation = {
          kind: 'known_failure',
          safeCode: row.safe_code,
          retryability: row.retryability,
          ...(usage ? { usage } : {}),
          ...(evidence ? { evidence } : {})
        };
        break;
      case 'acceptance_unknown':
        if (!row.recovery) throw new TypeError('durable_fake_recovery_missing');
        observation = { kind: 'acceptance_unknown', evidence: requireEvidence(row), recovery: row.recovery };
        break;
      case 'cancelled':
        observation = {
          kind: 'cancelled',
          ...(usage ? { usage } : {}),
          ...(evidence ? { evidence } : {})
        };
        break;
    }
    return {
      requestBinding: parseModelRequestBinding(row.request_binding),
      observation,
      cancelled: row.cancelled === 1
    };
  }

  put(attemptId: string, attempt: StoredFakeAttempt): void {
    parseModelRequestBinding(attempt.requestBinding);
    validateModelAttemptObservationUsage(attempt.observation);
    const existing = this.get(attemptId);
    if (existing) {
      if (existing.requestBinding !== attempt.requestBinding) throw new TypeError('attempt_request_conflict');
      if (sameCanonical(existing, attempt)) return;
      if (attempt.observation.kind !== 'cancelled' || attempt.cancelled !== true || existing.cancelled) {
        throw new TypeError('durable_fake_attempt_conflict');
      }
    }

    const observation = attempt.observation;
    const usage = 'usage' in observation ? observation.usage : undefined;
    const evidence = 'evidence' in observation ? observation.evidence : undefined;
    let outputRef: PayloadRef | undefined;
    if (observation.kind === 'succeeded') {
      outputRef = exactPayloadRef(observation.output, 'successful model output');
    } else if (observation.kind === 'schema_invalid') {
      outputRef = exactPayloadRef(observation.rawOutputRef, 'schema-invalid model output');
    }
    const toolRequests = observation.kind === 'tool_requests'
      ? observation.requests.map((request, index) => ({
          sequence: index + 1,
          callId: request.callId,
          operation: request.operation,
          inputRef: exactPayloadRef(request.input, 'model tool input')
        }))
      : [];

    this.sqlite.transaction(() => {
      if (!existing) {
        this.sqlite.query(`
          INSERT INTO deterministic_fake_attempts_trial (
            attempt_id, request_binding, outcome_kind, cancelled, output_payload_ref_id,
            safe_code, retryability, recovery, usage_present, input_tokens, output_tokens,
            cached_input_tokens, cost_micros, adapter_key, adapter_version,
            provider_request_id, idempotency_supported, execution_mode, resolved_controls_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attemptId,
          attempt.requestBinding,
          observation.kind,
          attempt.cancelled ? 1 : 0,
          outputRef?.id ?? null,
          'safeCode' in observation ? observation.safeCode : null,
          'retryability' in observation ? observation.retryability : null,
          'recovery' in observation ? observation.recovery : null,
          usage === undefined ? 0 : 1,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.costMicros ?? null,
          evidence?.adapter.key ?? null,
          evidence?.adapter.version ?? null,
          evidence?.providerRequestId ?? null,
          evidence === undefined ? null : evidence.idempotencySupported ? 1 : 0,
          evidence?.executionMode ?? null,
          evidence?.resolvedControls === undefined ? null : canonicalJsonText(evidence.resolvedControls)
        );
      } else {
        const result = this.sqlite.query(`
          UPDATE deterministic_fake_attempts_trial
             SET outcome_kind = 'cancelled', cancelled = 1, output_payload_ref_id = NULL,
                 safe_code = NULL, retryability = NULL, recovery = NULL,
                 usage_present = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, cost_micros = ?,
                 adapter_key = ?, adapter_version = ?, provider_request_id = ?,
                 idempotency_supported = ?, execution_mode = ?, resolved_controls_json = ?
           WHERE attempt_id = ? AND request_binding = ? AND cancelled = 0
        `).run(
          usage === undefined ? 0 : 1,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.costMicros ?? null,
          evidence?.adapter.key ?? null,
          evidence?.adapter.version ?? null,
          evidence?.providerRequestId ?? null,
          evidence === undefined ? null : evidence.idempotencySupported ? 1 : 0,
          evidence?.executionMode ?? null,
          evidence?.resolvedControls === undefined ? null : canonicalJsonText(evidence.resolvedControls),
          attemptId,
          attempt.requestBinding
        );
        if (result.changes !== 1) throw new TypeError('durable_fake_attempt_conflict');
        this.sqlite.query('DELETE FROM deterministic_fake_tool_requests_trial WHERE attempt_id = ?').run(attemptId);
      }

      for (const request of toolRequests) {
        this.sqlite.query(`
          INSERT INTO deterministic_fake_tool_requests_trial (
            attempt_id, sequence, provider_call_id, operation_name, operation_version, input_payload_ref_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          attemptId,
          request.sequence,
          request.callId,
          request.operation.name,
          request.operation.version,
          request.inputRef.id
        );
      }
    })();
  }
}

export class ModelDurabilityTrialRepository {
  readonly #bindingKey: Uint8Array;
  readonly #bindingProfile: ModelBindingProfileRef;
  readonly #sealedPersistence: Readonly<ModelTrialSealedPersistenceOpeners> | undefined;

  constructor(readonly sqlite: Database, input: {
    readonly binding: {
      readonly profile: ModelBindingProfileRef;
      readonly keyBytes: Uint8Array;
    };
    readonly sealedPersistence?: ModelTrialSealedPersistenceOpeners;
  }) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(input.binding.profile.key)) {
      throw new TypeError('model trial binding profile key is invalid');
    }
    if (!Number.isSafeInteger(input.binding.profile.version) || input.binding.profile.version <= 0) {
      throw new TypeError('model trial binding profile version must be positive');
    }
    if (input.binding.keyBytes.byteLength < 32) throw new TypeError('model trial binding key must be at least 256 bits');
    this.#bindingKey = Uint8Array.from(input.binding.keyBytes);
    this.#bindingProfile = deepFreeze({ ...input.binding.profile });
    this.#sealedPersistence = input.sealedPersistence === undefined
      ? undefined
      : Object.freeze({
          openAttemptReduction: input.sealedPersistence.openAttemptReduction.bind(input.sealedPersistence),
          openToolReceiptAttachment: input.sealedPersistence.openToolReceiptAttachment.bind(input.sealedPersistence),
          openToolResume: input.sealedPersistence.openToolResume.bind(input.sealedPersistence)
        });
    this.bindProfile();
  }

  insertProfileRevision(profile: ModelProfileRevision): ModelProfileRevision {
    validateProfile(profile);
    if (calculateModelProfileDigest(profile) !== profile.digest) throw new TypeError('model_profile_digest_mismatch');
    const text = canonicalJsonText(profile);
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<RevisionRow, [string, number]>(`
        SELECT revision_json, digest FROM model_profile_revisions_trial
         WHERE profile_key = ? AND revision_version = ?
      `).get(profile.key, profile.version);
      if (existing) {
        if (existing.digest !== profile.digest || existing.revision_json !== text) {
          throw new TypeError('model_profile_revision_conflict');
        }
        return parseRecord<ModelProfileRevision>(existing.revision_json);
      }
      this.sqlite.query(`
        INSERT INTO model_profile_revisions_trial (
          profile_key, revision_version, digest, adapter_key, adapter_version,
          default_execution_mode, revision_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        profile.key,
        profile.version,
        profile.digest,
        profile.adapter.key,
        profile.adapter.version,
        profile.defaultExecutionMode,
        text
      );
      return parseRecord<ModelProfileRevision>(text);
    })();
  }

  insertScaffoldRevision(scaffold: ModelScaffoldRevision): ModelScaffoldRevision {
    validateScaffold(scaffold);
    if (calculateModelScaffoldDigest(scaffold) !== scaffold.digest) throw new TypeError('model_scaffold_digest_mismatch');
    const text = canonicalJsonText(scaffold);
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<RevisionRow, [string, number]>(`
        SELECT revision_json, digest FROM model_scaffold_revisions_trial
         WHERE scaffold_key = ? AND revision_version = ?
      `).get(scaffold.key, scaffold.version);
      if (existing) {
        if (existing.digest !== scaffold.digest || existing.revision_json !== text) {
          throw new TypeError('model_scaffold_revision_conflict');
        }
        return parseRecord<ModelScaffoldRevision>(existing.revision_json);
      }
      this.sqlite.query(`
        INSERT INTO model_scaffold_revisions_trial (
          scaffold_key, revision_version, digest, purpose, revision_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(scaffold.key, scaffold.version, scaffold.digest, scaffold.purpose, text);
      return parseRecord<ModelScaffoldRevision>(text);
    })();
  }

  getProfile(reference: ModelDefinitionRef & { readonly digest?: string }): ModelProfileRevision | undefined {
    const row = this.sqlite.query<RevisionRow, [string, number]>(`
      SELECT revision_json, digest FROM model_profile_revisions_trial
       WHERE profile_key = ? AND revision_version = ?
    `).get(reference.key, reference.version);
    if (!row) return undefined;
    if (reference.digest !== undefined && reference.digest !== row.digest) throw new TypeError('model_profile_digest_mismatch');
    const profile = parseRecord<ModelProfileRevision>(row.revision_json);
    validateProfile(profile);
    if (profile.digest !== row.digest || calculateModelProfileDigest(profile) !== row.digest) {
      throw new TypeError('model_profile_persistence_drift');
    }
    return profile;
  }

  getScaffold(reference: ModelDefinitionRef & { readonly digest?: string }): ModelScaffoldRevision | undefined {
    const row = this.sqlite.query<RevisionRow, [string, number]>(`
      SELECT revision_json, digest FROM model_scaffold_revisions_trial
       WHERE scaffold_key = ? AND revision_version = ?
    `).get(reference.key, reference.version);
    if (!row) return undefined;
    if (reference.digest !== undefined && reference.digest !== row.digest) throw new TypeError('model_scaffold_digest_mismatch');
    const scaffold = parseRecord<ModelScaffoldRevision>(row.revision_json);
    validateScaffold(scaffold);
    if (scaffold.digest !== row.digest || calculateModelScaffoldDigest(scaffold) !== row.digest) {
      throw new TypeError('model_scaffold_persistence_drift');
    }
    return scaffold;
  }

  pointProfileCurrent(input: {
    readonly revision: ModelDefinitionRef & { readonly digest: string };
    readonly expectedPointerVersion: number | null;
  }): ModelRevisionPointer {
    return this.pointCurrent('profile', input);
  }

  pointScaffoldCurrent(input: {
    readonly revision: ModelDefinitionRef & { readonly digest: string };
    readonly expectedPointerVersion: number | null;
  }): ModelRevisionPointer {
    return this.pointCurrent('scaffold', input);
  }

  getCurrentProfile(key: string): { readonly pointer: ModelRevisionPointer; readonly revision: ModelProfileRevision } | undefined {
    const pointer = this.getCurrentPointer('profile', key);
    if (!pointer) return undefined;
    const revision = this.getProfile(pointer.revision);
    if (!revision) throw new TypeError('current_model_profile_missing');
    return { pointer, revision };
  }

  getCurrentScaffold(key: string): { readonly pointer: ModelRevisionPointer; readonly revision: ModelScaffoldRevision } | undefined {
    const pointer = this.getCurrentPointer('scaffold', key);
    if (!pointer) return undefined;
    const revision = this.getScaffold(pointer.revision);
    if (!revision) throw new TypeError('current_model_scaffold_missing');
    return { pointer, revision };
  }

  startRun(input: Omit<CreateModelRunInput, 'profile' | 'scaffold' | 'budget'> & {
    readonly profileKey: string;
    readonly scaffoldKey: string;
  }): ModelRunRecord {
    const profile = this.getCurrentProfile(input.profileKey)?.revision;
    const scaffold = this.getCurrentScaffold(input.scaffoldKey)?.revision;
    if (!profile || !scaffold) throw new TypeError('current_model_configuration_missing');
    const run = createModelRun({
      id: input.id,
      profile: {
        key: profile.key,
        version: profile.version,
        digest: profile.digest,
        adapter: profile.adapter
      },
      scaffold,
      sourceOperation: input.sourceOperation,
      scopeKey: input.scopeKey,
      authorityCitationId: input.authorityCitationId,
      classifiedInputRefs: input.classifiedInputRefs,
      createdAt: input.createdAt,
      budget: profile.budget
    });
    return this.insertRun(run);
  }

  insertRun(run: ModelRunRecord): ModelRunRecord {
    const profile = this.getProfile(run.profile);
    if (!profile || !this.getScaffold(run.scaffold)) {
      throw new TypeError('model_run_configuration_missing');
    }
    if (
      profile.adapter.key !== run.profileAdapter.key ||
      profile.adapter.version !== run.profileAdapter.version
    ) throw new TypeError('model_run_profile_adapter_drift');
    const text = canonicalJsonText(run);
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<RecordRow, [string]>(`
        SELECT record_json FROM model_runs_trial WHERE run_id = ?
      `).get(run.id);
      if (existing) {
        if (existing.record_json !== text) throw new TypeError('model_run_identity_conflict');
        return this.getRun(run.id)!;
      }
      this.sqlite.query(`
        INSERT INTO model_runs_trial (
          run_id, version, state, profile_key, profile_version, profile_digest,
          profile_adapter_key, profile_adapter_version,
          scaffold_key, scaffold_version, scaffold_digest, active_attempt_id,
          active_attempt_fence, result_payload_ref_id, created_at_ms, updated_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.version,
        run.state,
        run.profile.key,
        run.profile.version,
        run.profile.digest,
        run.profileAdapter.key,
        run.profileAdapter.version,
        run.scaffold.key,
        run.scaffold.version,
        run.scaffold.digest,
        run.activeAttempt?.id ?? null,
        run.activeAttempt?.fence ?? null,
        run.resultRef?.id ?? null,
        epochMilliseconds(run.createdAt),
        epochMilliseconds(run.updatedAt),
        text
      );
      return this.getRun(run.id)!;
    })();
  }

  getRun(runId: AgentRunId | string): ModelRunRecord | undefined {
    const row = this.sqlite.query<RunRow, [string]>('SELECT * FROM model_runs_trial WHERE run_id = ?').get(runId);
    if (!row) return undefined;
    const run = parseRecord<ModelRunRecord>(row.record_json);
    if (
      run.id !== row.run_id || run.version !== row.version || run.state !== row.state ||
      run.profile.key !== row.profile_key || run.profile.version !== row.profile_version ||
      run.profile.digest !== row.profile_digest ||
      run.profileAdapter.key !== row.profile_adapter_key ||
      run.profileAdapter.version !== row.profile_adapter_version ||
      run.scaffold.key !== row.scaffold_key ||
      run.scaffold.version !== row.scaffold_version || run.scaffold.digest !== row.scaffold_digest ||
      (run.activeAttempt?.id ?? null) !== row.active_attempt_id ||
      (run.activeAttempt?.fence ?? null) !== row.active_attempt_fence ||
      (run.resultRef?.id ?? null) !== row.result_payload_ref_id ||
      epochMilliseconds(run.createdAt) !== row.created_at_ms || epochMilliseconds(run.updatedAt) !== row.updated_at_ms
    ) throw new TypeError('model_run_persistence_drift');
    return run;
  }

  getAttempt(attemptId: ModelAttemptId | string): ModelAttemptRecord | undefined {
    const row = this.sqlite.query<AttemptRow, [string]>('SELECT * FROM model_attempts_trial WHERE attempt_id = ?').get(attemptId);
    if (!row) return undefined;
    const attempt = parseRecord<ModelAttemptRecord>(row.record_json);
    if (
      attempt.id !== row.attempt_id || attempt.runId !== row.run_id || attempt.number !== row.attempt_number ||
      attempt.fence !== row.fence || attempt.requestBinding !== parseModelRequestBinding(row.request_binding) ||
      attempt.adapter.key !== row.adapter_key || attempt.adapter.version !== row.adapter_version ||
      attempt.executionMode !== row.execution_mode || attempt.state !== row.state ||
      epochMilliseconds(attempt.startedAt) !== row.started_at_ms ||
      (attempt.finishedAt ? epochMilliseconds(attempt.finishedAt) : null) !== row.finished_at_ms ||
      row.request_binding_profile_key !== this.#bindingProfile.key ||
      row.request_binding_profile_version !== this.#bindingProfile.version
    ) throw new TypeError('model_attempt_persistence_drift');
    return attempt;
  }

  getFrozenRequestBinding(attemptId: ModelAttemptId | string): ModelTrialFrozenRequestBinding | undefined {
    const row = this.sqlite.query<Pick<AttemptRow,
      'normalized_request_payload_ref_id' | 'request_binding_attempt_id'
    >, [string]>(`
      SELECT normalized_request_payload_ref_id, request_binding_attempt_id
        FROM model_attempts_trial WHERE attempt_id = ?
    `).get(attemptId);
    return row ? deepFreeze({
      normalizedRequestPayloadRef: createPayloadRef(parsePayloadRefId(row.normalized_request_payload_ref_id)),
      requestBindingAttemptId: parseModelAttemptId(row.request_binding_attempt_id)
    }) : undefined;
  }

  getToolCall(toolCallId: ModelToolCallId | string): ModelToolCallRecord | undefined {
    const row = this.sqlite.query<ToolCallRow, [string]>('SELECT * FROM model_tool_calls_trial WHERE tool_call_id = ?').get(toolCallId);
    if (!row) return undefined;
    const call = parseRecord<ModelToolCallRecord>(row.record_json);
    if (
      call.id !== row.tool_call_id || call.runId !== row.run_id || call.attemptId !== row.attempt_id ||
      call.sequence !== row.sequence || call.providerCallId !== row.provider_call_id ||
      call.operation.name !== row.operation_name || call.operation.version !== row.operation_version ||
      call.inputRef.id !== row.input_payload_ref_id ||
      call.inputBinding !== parseModelToolInputBinding(row.input_binding) ||
      (call.operationReceiptId ?? null) !== row.operation_receipt_id ||
      row.input_binding_profile_key !== this.#bindingProfile.key ||
      row.input_binding_profile_version !== this.#bindingProfile.version
    ) throw new TypeError('model_tool_call_persistence_drift');
    return call;
  }

  claimAttempt(input: Omit<ClaimModelAttemptInput, 'requestBinding' | 'executionMode'> & {
    readonly runId: AgentRunId;
    readonly normalizedRequestPayloadRef: PayloadRef;
    readonly requestedExecutionMode?: ModelExecutionMode;
  }): {
    readonly run: ModelRunRecord;
    readonly attempt: ModelAttemptRecord;
    readonly executionMode: ModelExecutionMode;
    readonly requestBinding: ModelRequestBinding;
    readonly providerIdempotencyKey: ModelProviderIdempotencyKey;
  } {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.version !== input.expectedRunVersion) throw new TypeError('stale_model_run');
      const profile = this.getProfile(run.profile);
      if (!profile) throw new TypeError('model_run_profile_missing');
      if (
        profile.adapter.key !== run.profileAdapter.key ||
        profile.adapter.version !== run.profileAdapter.version
      ) throw new TypeError('model_run_profile_adapter_drift');
      const normalizedRequestPayloadRef = exactPayloadRef(
        input.normalizedRequestPayloadRef,
        'normalized model request payload'
      );
      let executionMode: ModelExecutionMode;
      let requestBinding: ModelRequestBinding;
      let requestBindingAttemptId: ModelAttemptId;
      const requiredRetryBinding = run.retryAllowance?.requiredRequestBinding;
      if (requiredRetryBinding !== undefined) {
        parseModelRequestBinding(requiredRetryBinding);
        const sourceAttempt = this.getAttempt(run.retryAllowance!.sourceAttemptId);
        if (!sourceAttempt || sourceAttempt.runId !== run.id || sourceAttempt.state !== 'acceptance_unknown') {
          throw new TypeError('model_retry_source_attempt_missing');
        }
        if (sourceAttempt.requestBinding !== requiredRetryBinding) {
          throw new TypeError('model_retry_source_binding_drift');
        }
        if (input.requestedExecutionMode !== undefined && input.requestedExecutionMode !== sourceAttempt.executionMode) {
          throw new TypeError('model_retry_execution_mode_mismatch');
        }
        const rehydratedBinding = this.modelRequestBinding({
          runId: run.id,
          attemptId: sourceAttempt.id,
          profile: run.profile,
          scaffold: run.scaffold,
          executionMode: sourceAttempt.executionMode,
          normalizedRequestPayloadRef: normalizedRequestPayloadRef.id
        });
        if (rehydratedBinding !== sourceAttempt.requestBinding) {
          throw new TypeError('model_retry_request_binding_mismatch');
        }
        executionMode = sourceAttempt.executionMode;
        requestBinding = sourceAttempt.requestBinding;
        requestBindingAttemptId = sourceAttempt.id;
      } else {
        const resolutionBinding = this.modelRequestBinding({
          runId: run.id,
          attemptId: input.attemptId,
          phase: 'execution_mode_resolution'
        });
        executionMode = resolveExecutionMode({
          runId: run.id,
          attemptId: input.attemptId,
          requestBinding: resolutionBinding,
          profile,
          scaffold: this.requireScaffold(run.scaffold),
          messages: [],
          tools: [],
          providerIdempotencyKey: modelProviderIdempotencyKeyFor(resolutionBinding),
          ...(input.requestedExecutionMode ? { executionMode: input.requestedExecutionMode } : {})
        });
        requestBinding = this.modelRequestBinding({
          runId: run.id,
          attemptId: input.attemptId,
          profile: run.profile,
          scaffold: run.scaffold,
          executionMode,
          normalizedRequestPayloadRef: normalizedRequestPayloadRef.id
        });
        requestBindingAttemptId = input.attemptId;
      }
      const providerIdempotencyKey = modelProviderIdempotencyKeyFor(requestBinding);
      const reduced = claimModelAttempt(run, {
        expectedRunVersion: input.expectedRunVersion,
        attemptId: input.attemptId,
        requestBinding,
        executionMode,
        costReservationMicros: input.costReservationMicros,
        startedAt: input.startedAt
      });
      this.updateRun(run, reduced.run);
      this.sqlite.query(`
        INSERT INTO model_attempts_trial (
          attempt_id, run_id, attempt_number, fence, request_binding,
          request_binding_profile_key, request_binding_profile_version,
          normalized_request_payload_ref_id, request_binding_attempt_id,
          adapter_key, adapter_version, execution_mode,
          state, started_at_ms, finished_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reduced.attempt.id,
        reduced.attempt.runId,
        reduced.attempt.number,
        reduced.attempt.fence,
        reduced.attempt.requestBinding,
        this.#bindingProfile.key,
        this.#bindingProfile.version,
        normalizedRequestPayloadRef.id,
        requestBindingAttemptId,
        reduced.attempt.adapter.key,
        reduced.attempt.adapter.version,
        reduced.attempt.executionMode,
        reduced.attempt.state,
        epochMilliseconds(reduced.attempt.startedAt),
        null,
        canonicalJsonText(reduced.attempt)
      );
      return { ...reduced, executionMode, requestBinding, providerIdempotencyKey };
    })();
  }

  reduceAttempt(seal: object): { readonly run: ModelRunRecord; readonly attempt: ModelAttemptRecord } {
    const input = this.#sealedPersistence?.openAttemptReduction(seal);
    if (!input) throw new TypeError('unsealed_model_attempt_reduction');
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const attempt = this.requireAttempt(input.attemptId);
      if (run.version !== input.expectedRunVersion) throw new TypeError('stale_model_run');
      if (attempt.fence !== input.expectedFence) throw new TypeError('stale_model_attempt_fence');
      if (
        attempt.requestBinding !== input.requestBinding ||
        run.profile.key !== input.profile.key || run.profile.version !== input.profile.version ||
        run.profile.digest !== input.profile.digest ||
        run.scaffold.key !== input.scaffold.key || run.scaffold.version !== input.scaffold.version ||
        run.scaffold.digest !== input.scaffold.digest ||
        attempt.adapter.key !== input.adapter.key || attempt.adapter.version !== input.adapter.version ||
        attempt.executionMode !== input.executionMode ||
        input.providerIdempotencyKey !== modelProviderIdempotencyKeyFor(attempt.requestBinding)
      ) throw new TypeError('sealed_model_attempt_identity_mismatch');

      const deadline = epochMilliseconds(run.createdAt) + run.budget.timeoutMs;
      const finishedAt = epochMilliseconds(input.finishedAt);
      const timeoutObservation = input.observation.kind === 'known_failure'
        && input.observation.safeCode === 'model_run_timeout_exceeded'
        && input.observation.retryability === 'never';
      if (finishedAt >= deadline && !timeoutObservation) throw new TypeError('model_run_timeout_exceeded');

      let adoptedResultRef: PayloadRef | undefined;
      if (input.observation.kind === 'succeeded') {
        adoptedResultRef = exactPayloadRef(input.observation.output, 'sealed successful model output');
      }
      if (input.observation.kind === 'tool_requests') {
        if (input.toolCalls.length !== input.observation.requests.length) {
          throw new TypeError('sealed_model_tool_set_mismatch');
        }
        input.observation.requests.forEach((request, index) => {
          const call = input.toolCalls[index];
          if (!call
            || call.sequence !== index + 1
            || call.providerCallId !== request.callId
            || call.operation.name !== request.operation.name
            || call.operation.version !== request.operation.version
            || exactPayloadRef(request.input, 'sealed model tool input').id !== call.inputPayloadRef.id) {
            throw new TypeError('sealed_model_tool_set_mismatch');
          }
        });
      } else if (input.toolCalls.length !== 0) {
        throw new TypeError('sealed_model_tool_set_mismatch');
      }
      const reduced = reduceModelAttempt(run, attempt, {
        expectedRunVersion: input.expectedRunVersion,
        observation: input.observation,
        finishedAt: input.finishedAt,
        ...(adoptedResultRef ? { adoptedResultRef } : {})
      });
      this.updateRun(run, reduced.run);
      const changed = this.sqlite.query(`
        UPDATE model_attempts_trial
           SET state = ?, finished_at_ms = ?, record_json = ?
         WHERE attempt_id = ? AND run_id = ? AND fence = ? AND state = 'started'
      `).run(...attemptColumns(reduced.attempt), attempt.id, run.id, input.expectedFence);
      if (changed.changes !== 1) throw new TypeError('stale_model_attempt_fence');
      for (const call of input.toolCalls) this.insertSealedToolCall(reduced.run, reduced.attempt, call);
      this.commitSealedPayloadAdoptions(input);
      return reduced;
    })();
  }

  applyIntervention(input: { readonly runId: AgentRunId } & ApplyModelInterventionInput): ModelRunRecord {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const next = applyModelIntervention(run, input);
      this.updateRun(run, next);
      return next;
    })();
  }

  requestCancellation(input: {
    readonly runId: AgentRunId;
    readonly expectedRunVersion: number;
    readonly attemptId: ModelAttemptId;
    readonly expectedAttemptFence: number;
    readonly requestedAt: UtcInstant;
  }): ModelRunRecord {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const next = requestModelCancellation(run, {
        expectedRunVersion: input.expectedRunVersion,
        expectedActiveAttempt: { id: input.attemptId, fence: input.expectedAttemptFence },
        requestedAt: input.requestedAt
      });
      this.updateRun(run, next);
      return next;
    })();
  }

  recordCancellationResult(input: {
    readonly runId: AgentRunId;
    readonly attemptId: ModelAttemptId;
    readonly expectedRunVersion: number;
    readonly expectedFence: number;
    readonly observation: ModelCancelObservation;
    readonly observedAt: UtcInstant;
  }): ModelRunRecord {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const attempt = this.requireAttempt(input.attemptId);
      const next = recordModelCancellationResult(run, attempt, {
        expectedRunVersion: input.expectedRunVersion,
        expectedAttemptId: input.attemptId,
        expectedFence: input.expectedFence,
        observation: input.observation,
        observedAt: input.observedAt
      });
      this.updateRun(run, next);
      return next;
    })();
  }

  confirmCancellation(input: {
    readonly runId: AgentRunId;
    readonly attemptId: ModelAttemptId;
    readonly expectedRunVersion: number;
    readonly expectedFence: number;
    readonly observation: Extract<ModelAttemptObservation, { readonly kind: 'cancelled' }>;
    readonly finishedAt: UtcInstant;
  }): { readonly run: ModelRunRecord; readonly attempt: ModelAttemptRecord } {
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const attempt = this.requireAttempt(input.attemptId);
      const reduced = confirmModelCancellation(run, attempt, {
        expectedRunVersion: input.expectedRunVersion,
        expectedAttemptId: input.attemptId,
        expectedFence: input.expectedFence,
        observation: input.observation,
        finishedAt: input.finishedAt
      });
      this.updateRun(run, reduced.run);
      const changed = this.sqlite.query(`
        UPDATE model_attempts_trial
           SET state = ?, finished_at_ms = ?, record_json = ?
         WHERE attempt_id = ? AND run_id = ? AND fence = ? AND state = 'started'
      `).run(...attemptColumns(reduced.attempt), attempt.id, run.id, input.expectedFence);
      if (changed.changes !== 1) throw new TypeError('stale_model_attempt_fence');
      return reduced;
    })();
  }

  private insertSealedToolCall(
    run: ModelRunRecord,
    attempt: ModelAttemptRecord,
    input: {
    readonly id: ModelToolCallId;
    readonly sequence: number;
    readonly providerCallId: string;
    readonly operation: { readonly name: string; readonly version: number };
    readonly inputPayloadRef: PayloadRef;
  }): ModelToolCallRecord {
      const inputBinding = this.modelToolInputBinding({
        runId: run.id,
        attemptId: attempt.id,
        toolCallId: input.id,
        providerCallId: input.providerCallId,
        operation: input.operation,
        inputPayloadRef: exactPayloadRef(input.inputPayloadRef, 'model tool input payload').id
      });
      const call = createModelToolCall({
        run,
        attempt,
        id: input.id,
        sequence: input.sequence,
        providerCallId: input.providerCallId,
        operation: input.operation,
        inputRef: exactPayloadRef(input.inputPayloadRef, 'model tool input payload'),
        inputBinding
      });
      const existing = this.getToolCall(call.id);
      if (existing) {
        if (!sameCanonical(existing, call)) throw new TypeError('model_tool_call_identity_conflict');
        return existing;
      }
      this.sqlite.query(`
        INSERT INTO model_tool_calls_trial (
          tool_call_id, run_id, attempt_id, sequence, provider_call_id,
          operation_name, operation_version, input_payload_ref_id, input_binding,
          input_binding_profile_key, input_binding_profile_version,
          operation_receipt_id, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        call.id,
        call.runId,
        call.attemptId,
        call.sequence,
        call.providerCallId,
        call.operation.name,
        call.operation.version,
        call.inputRef.id,
        call.inputBinding,
        this.#bindingProfile.key,
        this.#bindingProfile.version,
        null,
        canonicalJsonText(call)
      );
      return call;
  }

  attachToolReceipt(seal: object): ModelToolCallRecord {
    const input = this.#sealedPersistence?.openToolReceiptAttachment(seal);
    if (!input) throw new TypeError('unsealed_model_tool_receipt');
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const attempt = this.requireAttempt(input.attemptId);
      const call = this.requireToolCall(input.toolCallId);
      if (attempt.runId !== run.id || attempt.fence !== input.expectedFence
        || call.runId !== run.id || call.attemptId !== attempt.id
        || call.inputRef.id !== input.expectedInputPayloadRef.id
        || call.inputBinding !== input.expectedInputBinding) {
        throw new TypeError('sealed_model_tool_identity_mismatch');
      }
      const receipt = input.receipt;
      if (receipt.identity.surface !== 'app_model'
        || receipt.ref.operationName !== call.operation.name
        || receipt.ref.operationVersion !== call.operation.version
        || receipt.identity.operationName !== call.operation.name
        || receipt.identity.operationVersion !== call.operation.version) {
        throw new TypeError('model_tool_receipt_operation_mismatch');
      }
      const stored = this.sqlite.query<{
        id: string;
        scope_partition_key: string;
        authority_principal_key: string;
        operation_name: string;
        operation_version: number;
        surface: string;
        idempotency_verifier_profile_key: string;
        idempotency_verifier_profile_version: number;
        idempotency_key_verifier: string;
        request_hash: string;
        result_json: string;
      }, [string]>(`
        SELECT id, scope_partition_key, authority_principal_key, operation_name,
               operation_version, surface, idempotency_verifier_profile_key,
               idempotency_verifier_profile_version, idempotency_key_verifier,
               request_hash, result_json
          FROM operation_log WHERE id = ?
      `).get(receipt.ref.id);
      if (!stored
        || stored.scope_partition_key !== receipt.identity.scopePartitionKey
        || stored.authority_principal_key !== receipt.identity.authorityPrincipalKey
        || stored.operation_name !== receipt.identity.operationName
        || stored.operation_version !== receipt.identity.operationVersion
        || stored.surface !== receipt.identity.surface
        || stored.idempotency_verifier_profile_key !== receipt.identity.idempotencyVerifierProfile.key
        || stored.idempotency_verifier_profile_version !== receipt.identity.idempotencyVerifierProfile.version
        || stored.idempotency_key_verifier !== receipt.identity.idempotencyKeyVerifier
        || stored.request_hash !== receipt.requestHash
        || stored.result_json !== canonicalJsonText(receipt.result)) {
        throw new TypeError('terminal_model_tool_receipt_missing');
      }
      const next = attachModelToolReceipt(call, receipt.ref.id as OperationReceiptId);
      if (next === call) return call;
      const changed = this.sqlite.query(`
        UPDATE model_tool_calls_trial
           SET operation_receipt_id = ?, record_json = ?
         WHERE tool_call_id = ? AND operation_receipt_id IS NULL
      `).run(receipt.ref.id, canonicalJsonText(next), call.id);
      if (changed.changes !== 1) throw new TypeError('model_tool_receipt_conflict');
      return next;
    })();
  }

  resumeAfterTools(seal: object): ModelRunRecord {
    const input = this.#sealedPersistence?.openToolResume(seal);
    if (!input) throw new TypeError('unsealed_model_tool_resume');
    return this.sqlite.transaction(() => {
      const run = this.requireRun(input.runId);
      const attempt = this.requireAttempt(input.attemptId);
      if (attempt.fence !== input.expectedFence) throw new TypeError('stale_model_attempt_fence');
      const calls = this.sqlite.query<ToolCallRow, [string]>(`
        SELECT * FROM model_tool_calls_trial
         WHERE attempt_id = ? ORDER BY sequence
      `).all(input.attemptId).map((row) => {
        const call = this.getToolCall(row.tool_call_id);
        if (!call) throw new TypeError('model_tool_call_missing');
        if (call.operationReceiptId) this.assertActualToolReceipt(call);
        return call;
      });
      const next = resumeModelRunAfterTools({
        run,
        attempt,
        calls,
        expectedRunVersion: input.expectedRunVersion,
        resumedAt: input.resumedAt
      });
      this.updateRun(run, next);
      return next;
    })();
  }

  private pointCurrent(
    kind: 'profile' | 'scaffold',
    input: {
      readonly revision: ModelDefinitionRef & { readonly digest: string };
      readonly expectedPointerVersion: number | null;
    }
  ): ModelRevisionPointer {
    assertDigest(input.revision.digest, `${kind} revision digest`);
    const revision = kind === 'profile'
      ? this.getProfile(input.revision)
      : this.getScaffold(input.revision);
    if (!revision) throw new TypeError(`model_${kind}_revision_missing`);
    const table = kind === 'profile' ? 'model_profile_current_trial' : 'model_scaffold_current_trial';
    const keyColumn = kind === 'profile' ? 'profile_key' : 'scaffold_key';
    return this.sqlite.transaction(() => {
      if (input.expectedPointerVersion === null) {
        try {
          this.sqlite.query(`
            INSERT INTO ${table} (${keyColumn}, pointer_version, revision_version, revision_digest)
            VALUES (?, 1, ?, ?)
          `)
            .run(input.revision.key, input.revision.version, input.revision.digest);
        } catch {
          throw new TypeError(`stale_model_${kind}_pointer`);
        }
      } else {
        if (!Number.isSafeInteger(input.expectedPointerVersion) || input.expectedPointerVersion <= 0) {
          throw new TypeError('expected pointer version must be positive');
        }
        const changed = this.sqlite.query(`
          UPDATE ${table}
             SET pointer_version = pointer_version + 1,
                 revision_version = ?, revision_digest = ?
           WHERE ${keyColumn} = ? AND pointer_version = ?
        `).run(
          input.revision.version,
          input.revision.digest,
          input.revision.key,
          input.expectedPointerVersion
        );
        if (changed.changes !== 1) throw new TypeError(`stale_model_${kind}_pointer`);
      }
      return this.getCurrentPointer(kind, input.revision.key)!;
    })();
  }

  private getCurrentPointer(kind: 'profile' | 'scaffold', key: string): ModelRevisionPointer | undefined {
    const table = kind === 'profile' ? 'model_profile_current_trial' : 'model_scaffold_current_trial';
    const keyColumn = kind === 'profile' ? 'profile_key' : 'scaffold_key';
    const row = this.sqlite.query<PointerRow, [string]>(`
      SELECT pointer_version, revision_version, revision_digest FROM ${table} WHERE ${keyColumn} = ?
    `).get(key);
    return row ? deepFreeze({
      key,
      pointerVersion: row.pointer_version,
      revision: { key, version: row.revision_version, digest: row.revision_digest }
    }) : undefined;
  }

  private requireRun(runId: AgentRunId): ModelRunRecord {
    const run = this.getRun(runId);
    if (!run) throw new TypeError('model_run_missing');
    return run;
  }

  private requireAttempt(attemptId: ModelAttemptId): ModelAttemptRecord {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new TypeError('model_attempt_missing');
    return attempt;
  }

  private requireToolCall(toolCallId: ModelToolCallId): ModelToolCallRecord {
    const call = this.getToolCall(toolCallId);
    if (!call) throw new TypeError('model_tool_call_missing');
    return call;
  }

  private assertActualToolReceipt(call: ModelToolCallRecord): void {
    if (!call.operationReceiptId) throw new TypeError('terminal_model_tool_receipt_missing');
    const row = this.sqlite.query<{
      operation_name: string;
      operation_version: number;
      surface: string;
      result_json: string;
    }, [string]>(`
      SELECT operation_name, operation_version, surface, result_json
        FROM operation_log WHERE id = ?
    `).get(call.operationReceiptId);
    if (!row
      || row.operation_name !== call.operation.name
      || row.operation_version !== call.operation.version
      || row.surface !== 'app_model') {
      throw new TypeError('terminal_model_tool_receipt_missing');
    }
    let result: unknown;
    try {
      result = JSON.parse(row.result_json);
    } catch {
      throw new TypeError('terminal_model_tool_receipt_missing');
    }
    if (!result || typeof result !== 'object'
      || (result as { readonly receipt?: { readonly id?: unknown } }).receipt?.id !== call.operationReceiptId) {
      throw new TypeError('terminal_model_tool_receipt_missing');
    }
  }

  private commitSealedPayloadAdoptions(input: ModelTrialSealedAttemptReduction): void {
    const expected = input.observation.kind === 'succeeded'
      ? [{
          ownerKind: 'model_result' as const,
          ordinal: 0,
          payloadRef: exactPayloadRef(input.observation.output, 'sealed successful model output')
        }]
      : input.observation.kind === 'tool_requests'
        ? input.toolCalls.map((call) => ({
            ownerKind: 'model_tool_input' as const,
            ordinal: call.sequence,
            payloadRef: exactPayloadRef(call.inputPayloadRef, 'sealed model tool input')
          }))
        : [];
    for (const adoption of expected) {
      const changed = this.sqlite.query(`
        UPDATE model_attempt_payload_adoptions_trial
           SET reduction_committed = 1
         WHERE run_id = ? AND attempt_id = ? AND attempt_fence = ?
           AND owner_kind = ? AND ordinal = ? AND payload_ref_id = ?
           AND reduction_committed = 0
      `).run(
        input.runId,
        input.attemptId,
        input.expectedFence,
        adoption.ownerKind,
        adoption.ordinal,
        adoption.payloadRef.id
      );
      if (changed.changes !== 1) throw new TypeError('unsealed_model_payload_adoption');
    }
  }

  private requireScaffold(reference: ModelDefinitionRef & { readonly digest: string }): ModelScaffoldRevision {
    const scaffold = this.getScaffold(reference);
    if (!scaffold) throw new TypeError('model_run_scaffold_missing');
    return scaffold;
  }

  private updateRun(current: ModelRunRecord, next: ModelRunRecord): void {
    const changed = this.sqlite.query(`
      UPDATE model_runs_trial
         SET version = ?, state = ?, profile_key = ?, profile_version = ?, profile_digest = ?,
             profile_adapter_key = ?, profile_adapter_version = ?,
             scaffold_key = ?, scaffold_version = ?, scaffold_digest = ?, active_attempt_id = ?,
             active_attempt_fence = ?, result_payload_ref_id = ?, updated_at_ms = ?, record_json = ?
       WHERE run_id = ? AND version = ?
    `).run(...runColumns(next), current.id, current.version);
    if (changed.changes !== 1) throw new TypeError('stale_model_run');
  }

  private modelRequestBinding(value: unknown): ModelRequestBinding {
    return parseModelRequestBinding(`mrb1_${this.bindingMac('model_request', value)}`);
  }

  private modelToolInputBinding(value: unknown): ModelToolInputBinding {
    return parseModelToolInputBinding(`mtb1_${this.bindingMac('model_tool_input', value)}`);
  }

  /** Persisted bindings cover only opaque identities and are keyed to prevent equality-oracle use. */
  private bindingMac(kind: 'model_request' | 'model_tool_input', value: unknown): string {
    return createHmac('sha256', this.#bindingKey)
      .update(encodeCanonicalJson({ kind, version: 1, profile: this.#bindingProfile, value }))
      .digest('hex');
  }

  private bindProfile(): void {
    const keyVerificationDigest = createHmac('sha256', this.#bindingKey)
      .update(encodeCanonicalJson({
        kind: 'model_binding_key_verifier',
        version: 1,
        profile: this.#bindingProfile
      }))
      .digest('hex');
    const rows = this.sqlite.query<{
      profile_key: string;
      profile_version: number;
      key_verification_digest: string;
    }, []>(`
      SELECT profile_key, profile_version, key_verification_digest
        FROM model_binding_profiles_trial ORDER BY profile_key, profile_version
    `).all();
    if (rows.length === 0) {
      this.sqlite.query(`
        INSERT INTO model_binding_profiles_trial (
          profile_key, profile_version, key_verification_digest
        ) VALUES (?, ?, ?)
      `).run(this.#bindingProfile.key, this.#bindingProfile.version, keyVerificationDigest);
      return;
    }
    if (
      rows.length !== 1 || rows[0]?.profile_key !== this.#bindingProfile.key ||
      rows[0]?.profile_version !== this.#bindingProfile.version
    ) {
      throw new TypeError('model_binding_profile_mismatch');
    }
    if (rows[0].key_verification_digest !== keyVerificationDigest) {
      throw new TypeError('model_binding_key_mismatch');
    }
  }
}
