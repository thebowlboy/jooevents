import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import {
  createAuthenticatedPayloadStageDescriptor,
  createClassifiedPayloadDescriptor,
  createClassifiedPayloadProfileRef,
  createEffectInvocationBuilder,
  createEffectOperationExecutor,
  createStageReconciliationPolicyRef,
  resolveTerminalEffectReceipt,
  type AuthenticatedPayloadStageDescriptor,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfiles,
  type ClassifiedPayloadStageStore,
  type EffectUnitOfWorkPort,
  type OperationRegistry,
  type StageReconciliationPolicyRef
} from '@jooevents/application';
import {
  modelProviderIdempotencyKeyFor,
  validateAttemptRequest,
  type ModelAttemptObservation,
  type ModelAttemptRecord,
  type ModelAttemptRequest,
  type ModelDefinitionRef,
  type ModelMessage,
  type ModelOutputJsonSchema,
  type ModelRegistry,
  type ModelRunRecord,
  type ModelToolDefinition
} from '@jooevents/model-adapter';
import {
  createPayloadRef,
  encodeCanonicalJson,
  parseAgentRunId,
  parseCorrelationId,
  parseInstant,
  parseModelAttemptId,
  parseModelToolCallId,
  parsePayloadRefId,
  type AgentRunId,
  type Clock,
  type ModelAttemptId,
  type ModelToolCallId,
  type PayloadRef,
  type UtcInstant
} from '@jooevents/kernel';
import {
  ModelDurabilityTrialRepository,
  type ModelBindingProfileRef,
  type ModelTrialSealedAttemptReduction,
  type ModelTrialSealedPersistenceOpeners,
  type ModelTrialSealedToolReceiptAttachment,
  type ModelTrialSealedToolResume
} from './model-durability-trial';

export const SEALED_MODEL_ATTEMPT_TRIAL_REQUIRED_TABLE = 'model_attempt_payload_adoptions_trial';

type MaybePromise<Value> = Value | Promise<Value>;

export interface RegisteredModelClassifiedMaterialReader {
  readonly registration: ModelDefinitionRef;
  read(input:
    | {
        readonly purpose: 'model_attempt_request';
        readonly payloadRef: PayloadRef;
        readonly owner: { readonly kind: 'model_run'; readonly runId: AgentRunId };
      }
    | {
        readonly purpose: 'model_tool_operation_input';
        readonly payloadRef: PayloadRef;
        readonly owner: {
          readonly kind: 'model_tool_call';
          readonly runId: AgentRunId;
          readonly attemptId: ModelAttemptId;
          readonly attemptFence: number;
          readonly toolCallId: ModelToolCallId;
          readonly inputBinding: string;
        };
      }
  ): MaybePromise<unknown>;
}

export interface RegisteredModelOutputValidator {
  readonly registration: ModelDefinitionRef;
  parse(input: {
    readonly schema: ModelDefinitionRef;
    readonly value: unknown;
    readonly owner: {
      readonly runId: AgentRunId;
      readonly attemptId: ModelAttemptId;
      readonly attemptFence: number;
    };
  }): MaybePromise<unknown>;
}

export interface RegisteredModelAttemptAdmission {
  readonly registration: ModelDefinitionRef;
  reserve(input: {
    readonly run: ModelRunRecord;
    readonly profile: ModelAttemptRequest['profile'];
    readonly scaffold: ModelAttemptRequest['scaffold'];
  }): MaybePromise<{ readonly costReservationMicros: number }>;
}

export interface SealedModelAttemptTrialFaults {
  beforeStage?(): void;
  afterStagePutBeforeRegistration?(): void;
  afterStage?(): void;
  afterAdoption?(): void;
  afterReductionCommit?(): void;
  afterMarkAdopted?(): void;
  afterOperationReceipt?(): void;
}

export interface SealedModelAttemptTrialRunner {
  runAttempt(input: {
    readonly runId: AgentRunId;
  }): Promise<{ readonly run: ModelRunRecord; readonly attempt: ModelAttemptRecord }>;
  executeToolCall(input: {
    readonly toolCallId: ModelToolCallId;
  }): Promise<{ readonly kind: 'nonterminal' } | { readonly kind: 'attached'; readonly receiptId: string }>;
  resumeAfterTools(input: {
    readonly runId: AgentRunId;
  }): Promise<ModelRunRecord>;
  recoverAmbiguous(input: {
    readonly runId: AgentRunId;
  }): Promise<
    | { readonly kind: 'not_reconciling' }
    | { readonly kind: 'paused'; readonly reason: 'timeout' | 'manual' | 'terminal_reconciliation_required' }
    | { readonly kind: 'pending' }
  >;
}

export interface SealedModelAttemptTrialComposition {
  readonly repository: ModelDurabilityTrialRepository;
  readonly runner: SealedModelAttemptTrialRunner;
}

interface RequestMaterial {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly outputJsonSchema?: ModelOutputJsonSchema;
}

interface AdoptionRow {
  readonly payload_ref_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly attempt_fence: number;
  readonly owner_kind: 'model_result' | 'model_tool_input';
  readonly ordinal: number;
  readonly model_tool_call_id: string | null;
  readonly provider_call_id: string | null;
  readonly operation_name: string | null;
  readonly operation_version: number | null;
  readonly stage_id: string;
  readonly stage_expected_version: number;
  readonly stage_fence: number;
  readonly stage_expires_at_ms: number;
  readonly reconciliation_policy_key: string;
  readonly reconciliation_policy_version: number;
  readonly authentication_profile_key: string;
  readonly authentication_profile_version: number;
  readonly authentication_tag: string;
  readonly classification_profile_key: string;
  readonly classification_profile_version: number;
  readonly schema_profile_key: string;
  readonly schema_profile_version: number;
  readonly content_profile_key: string;
  readonly content_profile_version: number;
  readonly integrity_profile_key: string;
  readonly integrity_profile_version: number;
  readonly descriptor_auth_profile_key: string;
  readonly descriptor_auth_profile_version: number;
  readonly scope_binding: string;
  readonly content_type: string;
  readonly byte_size: number;
  readonly integrity_digest: string;
  readonly reduction_committed: number;
  readonly marked_adopted: number;
}

interface AdoptedMaterial {
  readonly row: AdoptionRow;
  readonly payloadRef: PayloadRef;
}

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be positive`);
  return value as number;
}

function parseDefinitionRef(value: unknown, label: string): ModelDefinitionRef {
  if (!plainRecord(value) || !exactKeys(value, ['key', 'version'])
    || typeof value.key !== 'string' || !stableKey.test(value.key)) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({ key: value.key, version: positive(value.version, `${label}.version`) });
}

function parseOperationRef(value: unknown, label: string): { readonly name: string; readonly version: number } {
  if (!plainRecord(value) || !exactKeys(value, ['name', 'version'])
    || typeof value.name !== 'string' || !stableKey.test(value.name)) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({ name: value.name, version: positive(value.version, `${label}.version`) });
}

function parseRequestMaterial(value: unknown): RequestMaterial {
  if (!plainRecord(value) || !exactKeys(value, ['messages', 'tools'], ['outputJsonSchema'])
    || !Array.isArray(value.messages) || !Array.isArray(value.tools)) {
    throw new TypeError('registered_model_request_material_invalid');
  }
  const messages = value.messages.map((entry, index): ModelMessage => {
    if (!plainRecord(entry) || !exactKeys(entry, ['role', 'content'], ['toolCallId'])
      || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(entry.role))
      || typeof entry.content !== 'string'
      || (entry.toolCallId !== undefined && typeof entry.toolCallId !== 'string')) {
      throw new TypeError(`registered_model_request_message_${index}_invalid`);
    }
    return Object.freeze({
      role: entry.role as ModelMessage['role'],
      content: entry.content,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId })
    });
  });
  const tools = value.tools.map((entry, index): ModelToolDefinition => {
    if (!plainRecord(entry) || !exactKeys(entry, ['operation', 'description', 'inputJsonSchema'])
      || typeof entry.description !== 'string' || !plainRecord(entry.inputJsonSchema)) {
      throw new TypeError(`registered_model_request_tool_${index}_invalid`);
    }
    return Object.freeze({
      operation: parseOperationRef(entry.operation, `registered model request tool ${index}`),
      description: entry.description,
      inputJsonSchema: Object.freeze(structuredClone(entry.inputJsonSchema))
    });
  });
  let outputJsonSchema: ModelOutputJsonSchema | undefined;
  if (value.outputJsonSchema !== undefined) {
    const candidate = value.outputJsonSchema;
    if (!plainRecord(candidate) || !exactKeys(candidate, ['name', 'schema', 'strict'])
      || typeof candidate.name !== 'string' || !plainRecord(candidate.schema) || candidate.strict !== true) {
      throw new TypeError('registered_model_output_schema_invalid');
    }
    outputJsonSchema = Object.freeze({
      name: candidate.name,
      schema: Object.freeze(structuredClone(candidate.schema)),
      strict: true
    });
  }
  return Object.freeze({ messages: Object.freeze(messages), tools: Object.freeze(tools), ...(outputJsonSchema ? { outputJsonSchema } : {}) });
}

function instantMilliseconds(value: UtcInstant): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('trusted clock returned an invalid instant');
  return parsed;
}

function instantAfter(value: UtcInstant, milliseconds: number): UtcInstant {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new TypeError('stage TTL must be positive');
  const result = instantMilliseconds(value) + milliseconds;
  if (!Number.isSafeInteger(result)) throw new TypeError('stage expiry overflow');
  return parseInstant(new Date(result).toISOString());
}

function sameRef(left: ModelDefinitionRef, right: ModelDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function sameFrozenRevision(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left)).equals(Buffer.from(encodeCanonicalJson(right)));
}

function deadlineReached(run: ModelRunRecord, at: UtcInstant): boolean {
  return instantMilliseconds(at) >= instantMilliseconds(run.createdAt) + run.budget.timeoutMs;
}

function timeoutObservation(): Extract<ModelAttemptObservation, { readonly kind: 'known_failure' }> {
  return Object.freeze({
    kind: 'known_failure',
    safeCode: 'model_run_timeout_exceeded',
    retryability: 'never'
  });
}

function stageFromRow(row: AdoptionRow): AuthenticatedPayloadStageDescriptor {
  return createAuthenticatedPayloadStageDescriptor({
    stageId: row.stage_id,
    expectedVersion: row.stage_expected_version,
    fence: row.stage_fence,
    expiresAt: new Date(row.stage_expires_at_ms).toISOString(),
    reconciliationPolicy: createStageReconciliationPolicyRef(
      row.reconciliation_policy_key,
      row.reconciliation_policy_version
    ),
    authenticationProfile: createClassifiedPayloadProfileRef(
      'descriptor_auth',
      row.authentication_profile_key,
      row.authentication_profile_version
    ),
    authenticationTag: row.authentication_tag
  });
}

function descriptorFromRow(row: AdoptionRow): ClassifiedPayloadDescriptor {
  return createClassifiedPayloadDescriptor({
    profiles: {
      classification: createClassifiedPayloadProfileRef('classification', row.classification_profile_key, row.classification_profile_version),
      schema: createClassifiedPayloadProfileRef('schema', row.schema_profile_key, row.schema_profile_version),
      content: createClassifiedPayloadProfileRef('content', row.content_profile_key, row.content_profile_version),
      integrity: createClassifiedPayloadProfileRef('integrity', row.integrity_profile_key, row.integrity_profile_version),
      descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', row.descriptor_auth_profile_key, row.descriptor_auth_profile_version)
    },
    scopeBinding: row.scope_binding,
    contentType: row.content_type,
    byteSize: row.byte_size,
    integrityDigest: row.integrity_digest
  });
}

function adoptionOwnerKey(input: {
  readonly runId: AgentRunId;
  readonly attemptId: ModelAttemptId;
  readonly fence: number;
  readonly kind: AdoptionRow['owner_kind'];
  readonly ordinal: number;
}): string {
  return `${input.runId}:${input.attemptId}:${input.fence}:${input.kind}:${input.ordinal}`;
}

function requireInstalled(sqlite: Database, table: string, code: string): void {
  const row = sqlite.query<{ readonly present: number }, [string]>(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table);
  if (!row) throw new TypeError(code);
}

/** Validates composition order; it creates no Foundation or model schema as a side effect. */
export function installSealedModelAttemptTrial(sqlite: Database): void {
  requireInstalled(sqlite, 'operation_log', 'operation_log_schema_required');
  requireInstalled(sqlite, 'model_attempt_payload_adoptions_trial', 'model_durability_trial_schema_required');
  sqlite.exec('PRAGMA foreign_keys = ON');
}

export function createSealedModelAttemptTrialComposition(input: {
  readonly sqlite: Database;
  readonly binding: { readonly profile: ModelBindingProfileRef; readonly keyBytes: Uint8Array };
  readonly clock: Clock;
  readonly modelRegistry: ModelRegistry;
  readonly operationRegistry: OperationRegistry;
  readonly classifiedStageStore: ClassifiedPayloadStageStore;
  readonly classifiedProfiles: ClassifiedPayloadProfiles;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
  readonly classifiedMaterialReader: RegisteredModelClassifiedMaterialReader;
  readonly outputValidator: RegisteredModelOutputValidator;
  readonly attemptAdmission: RegisteredModelAttemptAdmission;
  readonly effectUnitOfWork: EffectUnitOfWorkPort;
  readonly stageTtlMs: number;
  readonly newAttemptId: () => string;
  readonly newToolCallId: () => string;
  readonly newPayloadRefId: () => string;
  readonly newCorrelationId: () => string;
  readonly newOperationLogId: () => string;
  readonly faults?: SealedModelAttemptTrialFaults;
}): SealedModelAttemptTrialComposition {
  installSealedModelAttemptTrial(input.sqlite);
  if (typeof input.clock?.now !== 'function') throw new TypeError('sealed model runner requires a clock');
  positive(input.stageTtlMs, 'stageTtlMs');
  parseDefinitionRef(input.classifiedMaterialReader.registration, 'classified material reader registration');
  parseDefinitionRef(input.outputValidator.registration, 'model output validator registration');
  parseDefinitionRef(input.attemptAdmission.registration, 'model attempt admission registration');

  const readClock = input.clock.now.bind(input.clock);
  const materialRead = input.classifiedMaterialReader.read.bind(input.classifiedMaterialReader);
  const parseOutput = input.outputValidator.parse.bind(input.outputValidator);
  const reserveAttempt = input.attemptAdmission.reserve.bind(input.attemptAdmission);
  const reductionSeals = new WeakMap<object, ModelTrialSealedAttemptReduction>();
  const attachmentSeals = new WeakMap<object, ModelTrialSealedToolReceiptAttachment>();
  const resumeSeals = new WeakMap<object, ModelTrialSealedToolResume>();
  const openers: ModelTrialSealedPersistenceOpeners = Object.freeze({
    openAttemptReduction: (seal: object) => reductionSeals.get(seal),
    openToolReceiptAttachment: (seal: object) => attachmentSeals.get(seal),
    openToolResume: (seal: object) => resumeSeals.get(seal)
  });
  const repository = new ModelDurabilityTrialRepository(input.sqlite, {
    binding: input.binding,
    sealedPersistence: openers
  });
  const invocationBuilder = createEffectInvocationBuilder(input.operationRegistry);
  const effectExecutor = createEffectOperationExecutor({
    registry: input.operationRegistry,
    unitOfWork: input.effectUnitOfWork,
    newOperationLogId: input.newOperationLogId
  });

  const now = (): UtcInstant => parseInstant(readClock());
  const latestAttempt = (runId: AgentRunId): ModelAttemptRecord | undefined => {
    const row = input.sqlite.query<{ readonly attempt_id: string }, [string]>(`
      SELECT attempt_id FROM model_attempts_trial WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 1
    `).get(runId);
    return row ? repository.getAttempt(parseModelAttemptId(row.attempt_id)) : undefined;
  };

  const exactConfiguration = (run: ModelRunRecord) => {
    const durableProfile = repository.getProfile(run.profile);
    const durableScaffold = repository.getScaffold(run.scaffold);
    const registeredProfile = input.modelRegistry.getProfile(run.profile);
    const registeredScaffold = input.modelRegistry.getScaffold(run.scaffold);
    const adapter = input.modelRegistry.getAdapter(run.profileAdapter);
    if (!durableProfile || !durableScaffold || !registeredProfile || !registeredScaffold || !adapter
      || !sameFrozenRevision(durableProfile, registeredProfile)
      || !sameFrozenRevision(durableScaffold, registeredScaffold)
      || !sameRef(registeredProfile.adapter, run.profileAdapter)
      || !sameRef(adapter.ref, run.profileAdapter)) {
      throw new TypeError('sealed_model_configuration_mismatch');
    }
    return { profile: registeredProfile, scaffold: registeredScaffold, adapter };
  };

  const requestMaterialFor = async (run: ModelRunRecord): Promise<RequestMaterial> => {
    if (run.classifiedInputRefs.length !== 1 || !run.classifiedInputRefs[0]) {
      throw new TypeError('sealed_model_request_input_binding_missing');
    }
    return parseRequestMaterial(await materialRead({
      purpose: 'model_attempt_request',
      payloadRef: run.classifiedInputRefs[0],
      owner: { kind: 'model_run', runId: run.id }
    }));
  };

  const frozenRequest = async (
    run: ModelRunRecord,
    attempt: ModelAttemptRecord,
    material?: RequestMaterial
  ): Promise<ModelAttemptRequest> => {
    const configuration = exactConfiguration(run);
    const binding = repository.getFrozenRequestBinding(attempt.id);
    if (!binding || binding.normalizedRequestPayloadRef.id !== run.classifiedInputRefs[0]?.id) {
      throw new TypeError('sealed_model_request_binding_missing');
    }
    const expectedBinding = binding.requestBindingAttemptId === attempt.id || attempt.number > 1;
    if (!expectedBinding) throw new TypeError('sealed_model_request_binding_mismatch');
    const selected = material ?? await requestMaterialFor(run);
    const allowedAppModelOperations = new Set(input.operationRegistry.appModelEffectBindings
      .map((entry) => `${entry.operationName}@${entry.operationVersion}`));
    if (selected.tools.some((tool) => !allowedAppModelOperations.has(`${tool.operation.name}@${tool.operation.version}`))) {
      throw new TypeError('sealed_model_tool_not_registered');
    }
    const request: ModelAttemptRequest = Object.freeze({
      runId: run.id,
      attemptId: attempt.id,
      requestBinding: attempt.requestBinding,
      profile: configuration.profile,
      scaffold: configuration.scaffold,
      messages: selected.messages,
      tools: selected.tools,
      ...(selected.outputJsonSchema ? { outputJsonSchema: selected.outputJsonSchema } : {}),
      executionMode: attempt.executionMode,
      providerIdempotencyKey: modelProviderIdempotencyKeyFor(attempt.requestBinding)
    });
    validateAttemptRequest(request, configuration.adapter.describeCapabilities());
    return request;
  };

  const adoptionRow = (owner: {
    readonly runId: AgentRunId;
    readonly attemptId: ModelAttemptId;
    readonly fence: number;
    readonly kind: AdoptionRow['owner_kind'];
    readonly ordinal: number;
  }): AdoptionRow | undefined => input.sqlite.query<AdoptionRow, [string, string, number, string, number]>(`
    SELECT * FROM model_attempt_payload_adoptions_trial
     WHERE run_id = ? AND attempt_id = ? AND attempt_fence = ? AND owner_kind = ? AND ordinal = ?
  `).get(owner.runId, owner.attemptId, owner.fence, owner.kind, owner.ordinal) ?? undefined;

  const stageAndAdopt = async (stageInput: {
    readonly run: ModelRunRecord;
    readonly attempt: ModelAttemptRecord;
    readonly kind: AdoptionRow['owner_kind'];
    readonly ordinal: number;
    readonly value: unknown;
    readonly tool?: {
      readonly id: ModelToolCallId;
      readonly providerCallId: string;
      readonly operation: { readonly name: string; readonly version: number };
    };
  }): Promise<AdoptedMaterial> => {
    const bytes = encodeCanonicalJson(stageInput.value);
    const scopeBinding = adoptionOwnerKey({
      runId: stageInput.run.id,
      attemptId: stageInput.attempt.id,
      fence: stageInput.attempt.fence,
      kind: stageInput.kind,
      ordinal: stageInput.ordinal
    });
    const descriptor = createClassifiedPayloadDescriptor({
      profiles: input.classifiedProfiles,
      scopeBinding,
      contentType: 'application/json',
      byteSize: bytes.byteLength,
      integrityDigest: createHash('sha256').update(bytes).digest('hex')
    });
    let row = adoptionRow({
      runId: stageInput.run.id,
      attemptId: stageInput.attempt.id,
      fence: stageInput.attempt.fence,
      kind: stageInput.kind,
      ordinal: stageInput.ordinal
    });
    if (!row) {
      input.faults?.beforeStage?.();
      const at = now();
      const stage = await input.classifiedStageStore.put({
        descriptor,
        bytes,
        expiresAt: instantAfter(at, input.stageTtlMs),
        reconciliationPolicy: input.reconciliationPolicy
      });
      input.faults?.afterStagePutBeforeRegistration?.();
      const payloadRef = createPayloadRef(parsePayloadRefId(input.newPayloadRefId()));
      input.sqlite.query(`
        INSERT INTO model_attempt_payload_adoptions_trial (
          payload_ref_id, run_id, attempt_id, attempt_fence, owner_kind, ordinal,
          model_tool_call_id, provider_call_id, operation_name, operation_version,
          stage_id, stage_expected_version, stage_fence, stage_expires_at_ms,
          reconciliation_policy_key, reconciliation_policy_version,
          authentication_profile_key, authentication_profile_version, authentication_tag,
          classification_profile_key, classification_profile_version,
          schema_profile_key, schema_profile_version, content_profile_key, content_profile_version,
          integrity_profile_key, integrity_profile_version,
          descriptor_auth_profile_key, descriptor_auth_profile_version,
          scope_binding, content_type, byte_size, integrity_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payloadRef.id,
        stageInput.run.id,
        stageInput.attempt.id,
        stageInput.attempt.fence,
        stageInput.kind,
        stageInput.ordinal,
        stageInput.tool?.id ?? null,
        stageInput.tool?.providerCallId ?? null,
        stageInput.tool?.operation.name ?? null,
        stageInput.tool?.operation.version ?? null,
        stage.stageId,
        stage.expectedVersion,
        stage.fence,
        instantMilliseconds(stage.expiresAt),
        stage.reconciliationPolicy.key,
        stage.reconciliationPolicy.version,
        stage.authenticationProfile.key,
        stage.authenticationProfile.version,
        stage.authenticationTag,
        descriptor.profiles.classification.key,
        descriptor.profiles.classification.version,
        descriptor.profiles.schema.key,
        descriptor.profiles.schema.version,
        descriptor.profiles.content.key,
        descriptor.profiles.content.version,
        descriptor.profiles.integrity.key,
        descriptor.profiles.integrity.version,
        descriptor.profiles.descriptorAuth.key,
        descriptor.profiles.descriptorAuth.version,
        descriptor.scopeBinding,
        descriptor.contentType,
        descriptor.byteSize,
        descriptor.integrityDigest
      );
      input.faults?.afterStage?.();
      row = adoptionRow({
        runId: stageInput.run.id,
        attemptId: stageInput.attempt.id,
        fence: stageInput.attempt.fence,
        kind: stageInput.kind,
        ordinal: stageInput.ordinal
      });
      if (!row) throw new TypeError('sealed_model_stage_registration_missing');
    }
    const expectedTool = stageInput.tool;
    if (row.scope_binding !== descriptor.scopeBinding
      || row.byte_size !== descriptor.byteSize
      || row.integrity_digest !== descriptor.integrityDigest
      || row.content_type !== descriptor.contentType
      || row.model_tool_call_id !== (expectedTool?.id ?? null)
      || row.provider_call_id !== (expectedTool?.providerCallId ?? null)
      || row.operation_name !== (expectedTool?.operation.name ?? null)
      || row.operation_version !== (expectedTool?.operation.version ?? null)) {
      throw new TypeError('sealed_model_stage_replay_mismatch');
    }
    const adopted = await input.classifiedStageStore.adopt({
      stage: stageFromRow(row),
      expectedDescriptor: descriptorFromRow(row),
      payloadRefId: parsePayloadRefId(row.payload_ref_id),
      at: now()
    });
    input.sqlite.query(`
      UPDATE model_attempt_payload_adoptions_trial
         SET stage_expected_version = ?, stage_fence = ?,
             authentication_profile_key = ?, authentication_profile_version = ?,
             authentication_tag = ?
       WHERE payload_ref_id = ? AND reduction_committed = 0
    `).run(
      adopted.continuation.expectedVersion,
      adopted.continuation.fence,
      adopted.continuation.authenticationProfile.key,
      adopted.continuation.authenticationProfile.version,
      adopted.continuation.authenticationTag,
      row.payload_ref_id
    );
    input.faults?.afterAdoption?.();
    const current = adoptionRow({
      runId: stageInput.run.id,
      attemptId: stageInput.attempt.id,
      fence: stageInput.attempt.fence,
      kind: stageInput.kind,
      ordinal: stageInput.ordinal
    });
    if (!current) throw new TypeError('sealed_model_stage_registration_missing');
    return Object.freeze({ row: current, payloadRef: createPayloadRef(parsePayloadRefId(current.payload_ref_id)) });
  };

  const markCommittedAdoptions = async (runId: AgentRunId, attemptId: ModelAttemptId): Promise<void> => {
    const rows = input.sqlite.query<AdoptionRow, [string, string]>(`
      SELECT * FROM model_attempt_payload_adoptions_trial
       WHERE run_id = ? AND attempt_id = ? AND reduction_committed = 1 AND marked_adopted = 0
       ORDER BY owner_kind, ordinal
    `).all(runId, attemptId);
    for (const row of rows) {
      await input.classifiedStageStore.markAdopted({
        stage: stageFromRow(row),
        payloadRef: createPayloadRef(parsePayloadRefId(row.payload_ref_id))
      });
      const changed = input.sqlite.query(`
        UPDATE model_attempt_payload_adoptions_trial SET marked_adopted = 1
         WHERE payload_ref_id = ? AND reduction_committed = 1 AND marked_adopted = 0
      `).run(row.payload_ref_id);
      if (changed.changes !== 1) throw new TypeError('sealed_model_mark_adopted_conflict');
      input.faults?.afterMarkAdopted?.();
    }
  };

  const sealAndReduce = (
    run: ModelRunRecord,
    attempt: ModelAttemptRecord,
    observation: ModelAttemptObservation,
    finishedAt: UtcInstant,
    toolCalls: ModelTrialSealedAttemptReduction['toolCalls'] = []
  ) => {
    const seal = Object.freeze({});
    reductionSeals.set(seal, Object.freeze({
      runId: run.id,
      attemptId: attempt.id,
      expectedRunVersion: run.version,
      expectedFence: attempt.fence,
      requestBinding: attempt.requestBinding,
      profile: run.profile,
      scaffold: run.scaffold,
      adapter: attempt.adapter,
      executionMode: attempt.executionMode,
      providerIdempotencyKey: modelProviderIdempotencyKeyFor(attempt.requestBinding),
      observation,
      finishedAt,
      toolCalls
    }));
    return repository.reduceAttempt(seal);
  };

  const runner: SealedModelAttemptTrialRunner = Object.freeze({
    async runAttempt(runInput: Parameters<SealedModelAttemptTrialRunner['runAttempt']>[0]) {
      if (!plainRecord(runInput) || !exactKeys(runInput, ['runId'])) {
        throw new TypeError('sealed_model_runner_input_invalid');
      }
      let run = repository.getRun(parseAgentRunId(runInput.runId));
      if (!run) throw new TypeError('model_run_missing');

      if (run.state !== 'queued' && run.state !== 'running') {
        const prior = latestAttempt(run.id);
        if (!prior) throw new TypeError('model_attempt_missing');
        await markCommittedAdoptions(run.id, prior.id);
        return { run: repository.getRun(run.id)!, attempt: repository.getAttempt(prior.id)! };
      }

      const material = await requestMaterialFor(run);
      let attempt: ModelAttemptRecord;
      if (run.state === 'queued') {
        const configuration = exactConfiguration(run);
        const admission = await reserveAttempt({
          run,
          profile: configuration.profile,
          scaffold: configuration.scaffold
        });
        if (!plainRecord(admission) || !exactKeys(admission, ['costReservationMicros'])
          || !Number.isSafeInteger(admission.costReservationMicros)
          || admission.costReservationMicros < 0
          || (run.budget.maxCostMicros > 0 && admission.costReservationMicros === 0)) {
          throw new TypeError('sealed_model_cost_reservation_invalid');
        }
        const claimed = repository.claimAttempt({
          runId: run.id,
          expectedRunVersion: run.version,
          attemptId: parseModelAttemptId(input.newAttemptId()),
          normalizedRequestPayloadRef: run.classifiedInputRefs[0]!,
          costReservationMicros: admission.costReservationMicros,
          startedAt: now()
        });
        run = claimed.run;
        attempt = claimed.attempt;
      } else {
        if (!run.activeAttempt) throw new TypeError('model_active_attempt_missing');
        const current = repository.getAttempt(run.activeAttempt.id);
        if (!current || current.fence !== run.activeAttempt.fence || current.state !== 'started') {
          throw new TypeError('stale_model_attempt_fence');
        }
        attempt = current;
      }

      const request = await frozenRequest(run, attempt, material);
      const beforeProvider = now();
      if (deadlineReached(run, beforeProvider)) {
        return sealAndReduce(run, attempt, timeoutObservation(), beforeProvider);
      }
      const adapter = exactConfiguration(run).adapter;
      const observed = await adapter.execute(request);
      const finishedAt = now();
      if (deadlineReached(run, finishedAt)) {
        return sealAndReduce(run, attempt, timeoutObservation(), finishedAt);
      }

      let observation: ModelAttemptObservation = observed;
      let toolCalls: ModelTrialSealedAttemptReduction['toolCalls'] = [];
      if (observed.kind === 'succeeded') {
        const parsed = await parseOutput({
          schema: run.requestedOutputSchema,
          value: observed.output,
          owner: { runId: run.id, attemptId: attempt.id, attemptFence: attempt.fence }
        });
        const adopted = await stageAndAdopt({
          run,
          attempt,
          kind: 'model_result',
          ordinal: 0,
          value: parsed
        });
        observation = Object.freeze({ ...observed, output: adopted.payloadRef });
      } else if (observed.kind === 'tool_requests') {
        const declared = new Map(request.tools.map((tool) => [`${tool.operation.name}@${tool.operation.version}`, tool]));
        const providerIds = new Set<string>();
        const stagedCalls: ModelTrialSealedAttemptReduction['toolCalls'][number][] = [];
        const rewritten = [];
        for (const [index, requested] of observed.requests.entries()) {
          const operationKey = `${requested.operation.name}@${requested.operation.version}`;
          if (!declared.has(operationKey) || providerIds.has(requested.callId)) {
            throw new TypeError('sealed_model_tool_observation_mismatch');
          }
          providerIds.add(requested.callId);
          const ordinal = index + 1;
          const prior = adoptionRow({
            runId: run.id,
            attemptId: attempt.id,
            fence: attempt.fence,
            kind: 'model_tool_input',
            ordinal
          });
          const toolCallId = prior?.model_tool_call_id
            ? parseModelToolCallId(prior.model_tool_call_id)
            : parseModelToolCallId(input.newToolCallId());
          const adopted = await stageAndAdopt({
            run,
            attempt,
            kind: 'model_tool_input',
            ordinal,
            value: requested.input,
            tool: { id: toolCallId, providerCallId: requested.callId, operation: requested.operation }
          });
          stagedCalls.push(Object.freeze({
            id: toolCallId,
            sequence: ordinal,
            providerCallId: requested.callId,
            operation: requested.operation,
            inputPayloadRef: adopted.payloadRef
          }));
          rewritten.push(Object.freeze({ ...requested, input: adopted.payloadRef }));
        }
        toolCalls = Object.freeze(stagedCalls);
        observation = Object.freeze({ ...observed, requests: Object.freeze(rewritten) });
      }

      const reduced = sealAndReduce(run, attempt, observation, finishedAt, toolCalls);
      input.faults?.afterReductionCommit?.();
      await markCommittedAdoptions(run.id, attempt.id);
      return reduced;
    },

    async executeToolCall(toolInput: Parameters<SealedModelAttemptTrialRunner['executeToolCall']>[0]) {
      const call = repository.getToolCall(parseModelToolCallId(toolInput.toolCallId));
      if (!call) throw new TypeError('model_tool_call_missing');
      const run = repository.getRun(call.runId);
      const attempt = repository.getAttempt(call.attemptId);
      if (!run || !attempt || run.state !== 'waiting_for_tool' || attempt.state !== 'tool_requests') {
        throw new TypeError('model_tool_call_not_expected');
      }
      const row = input.sqlite.query<AdoptionRow, [string]>(`
        SELECT * FROM model_attempt_payload_adoptions_trial WHERE payload_ref_id = ?
      `).get(call.inputRef.id);
      if (!row || row.run_id !== run.id || row.attempt_id !== attempt.id
        || row.attempt_fence !== attempt.fence || row.owner_kind !== 'model_tool_input'
        || row.model_tool_call_id !== call.id || row.reduction_committed !== 1 || row.marked_adopted !== 1) {
        throw new TypeError('sealed_model_tool_input_adoption_missing');
      }
      if (deadlineReached(run, now())) throw new TypeError('model_run_timeout_exceeded');
      const businessInput = await materialRead({
        purpose: 'model_tool_operation_input',
        payloadRef: call.inputRef,
        owner: {
          kind: 'model_tool_call',
          runId: run.id,
          attemptId: attempt.id,
          attemptFence: attempt.fence,
          toolCallId: call.id,
          inputBinding: call.inputBinding
        }
      });
      const invocation = await invocationBuilder.build({
        operationName: call.operation.name,
        operationVersion: call.operation.version,
        surface: 'app_model',
        correlationId: parseCorrelationId(input.newCorrelationId()),
        businessInput,
        verifiedEvidence: {
          kind: 'app_model',
          surface: 'app_model',
          client: { key: 'sealed.model.attempt.runner', version: '1' },
          agentRunId: run.id,
          modelAttemptId: attempt.id,
          modelToolCallId: call.id
        },
        rawIdempotencyKey: `model-tool:${run.id}:${attempt.id}:${attempt.fence}:${call.id}:${call.inputBinding}`
      });
      const result = await effectExecutor.execute(invocation);
      const receipt = await resolveTerminalEffectReceipt({
        invocation,
        result,
        unitOfWork: input.effectUnitOfWork
      });
      if (!receipt) return { kind: 'nonterminal' as const };
      input.faults?.afterOperationReceipt?.();
      const seal = Object.freeze({});
      attachmentSeals.set(seal, Object.freeze({
        runId: run.id,
        attemptId: attempt.id,
        expectedFence: attempt.fence,
        toolCallId: call.id,
        expectedInputPayloadRef: call.inputRef,
        expectedInputBinding: call.inputBinding,
        receipt
      }));
      const attached = repository.attachToolReceipt(seal);
      return { kind: 'attached' as const, receiptId: attached.operationReceiptId! };
    },

    async resumeAfterTools(resumeInput: Parameters<SealedModelAttemptTrialRunner['resumeAfterTools']>[0]) {
      const run = repository.getRun(parseAgentRunId(resumeInput.runId));
      const attempt = latestAttempt(parseAgentRunId(resumeInput.runId));
      if (!run || !attempt) throw new TypeError('model_run_or_attempt_missing');
      const resumedAt = now();
      if (deadlineReached(run, resumedAt)) throw new TypeError('model_run_timeout_exceeded');
      const seal = Object.freeze({});
      resumeSeals.set(seal, Object.freeze({
        runId: run.id,
        attemptId: attempt.id,
        expectedRunVersion: run.version,
        expectedFence: attempt.fence,
        resumedAt
      }));
      return repository.resumeAfterTools(seal);
    },

    async recoverAmbiguous(recoveryInput: Parameters<SealedModelAttemptTrialRunner['recoverAmbiguous']>[0]) {
      const run = repository.getRun(parseAgentRunId(recoveryInput.runId));
      const attempt = latestAttempt(parseAgentRunId(recoveryInput.runId));
      if (!run || !attempt || run.state !== 'reconciling' || attempt.state !== 'acceptance_unknown') {
        return { kind: 'not_reconciling' as const };
      }
      const at = now();
      if (deadlineReached(run, at)) return { kind: 'paused' as const, reason: 'timeout' as const };
      if (attempt.evidence === undefined || run.pendingIntervention?.providerRecovery === 'manual') {
        return { kind: 'paused' as const, reason: 'manual' as const };
      }
      const request = await frozenRequest(run, attempt);
      const adapter = exactConfiguration(run).adapter;
      const observation = await adapter.lookup(attempt.evidence, request);
      if (deadlineReached(run, now())) return { kind: 'paused' as const, reason: 'timeout' as const };
      if (observation.kind === 'pending' || observation.kind === 'not_found') {
        return { kind: 'pending' as const };
      }
      return { kind: 'paused' as const, reason: 'terminal_reconciliation_required' as const };
    }
  });

  return Object.freeze({ repository, runner });
}
