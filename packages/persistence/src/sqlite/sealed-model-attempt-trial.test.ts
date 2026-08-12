import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  createClassifiedPayloadProfileRef,
  createEffectInvocationContextBuilder,
  createHmacRequestHashSealer,
  createOperationAutonomyPolicy,
  createOperationRegistry,
  createSingleUnitOfWorkConformanceFixture,
  createStageReconciliationPolicyRef,
  createUnadoptedStageProofAuthority,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type ClassifiedPayloadStageStore,
  type OperationRegistrySource,
  type PayloadStageAdoptionResult,
  type StageReconciliationPolicyRef
} from '@jooevents/application';
import {
  effectfulOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  calculateModelProfileDigest,
  calculateModelScaffoldDigest,
  createModelRegistry,
  type ModelAttemptObservation,
  type ModelAttemptRequest,
  type ModelCancelObservation,
  type ModelLookupObservation,
  type ModelProfileRevision,
  type ModelProviderAdapter,
  type ModelScaffoldRevision,
  type ProviderCapabilities,
  type SafeProviderEvidence
} from '@jooevents/model-adapter';
import {
  createPayloadRef,
  parseAgentRunId,
  parseAuthorityCitationId,
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseOperationReceiptId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId,
  type Clock,
  type Instant,
  type PayloadRef
} from '@jooevents/kernel';
import {
  LocalFilesystemClassifiedPayloadStageStore,
  type RetainedClassifiedPayloadProfileResolver
} from '../filesystem/classified-payload-stage-store';
import {
  installFoundationTrialUnitOfWorkSchema,
  SQLiteTrialEffectUnitOfWorkPort
} from './foundation-trial-uow';
import {
  installModelDurabilityTrial,
  type ModelDurabilityTrialRepository
} from './model-durability-trial';
import {
  createSealedModelAttemptTrialComposition,
  installSealedModelAttemptTrial,
  type RegisteredModelAttemptAdmission,
  type RegisteredModelClassifiedMaterialReader,
  type RegisteredModelOutputValidator,
  type SealedModelAttemptTrialComposition,
  type SealedModelAttemptTrialFaults
} from './sealed-model-attempt-trial';

const directories = new Set<string>();
const databases = new Set<Database>();

afterEach(() => {
  for (const sqlite of databases) sqlite.close();
  databases.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc101'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc102'),
  invocation: parseInvocationId('01890f47-9abc-7def-8123-456789abc103'),
  citation: parseAuthorityCitationId('01890f47-9abc-7def-8123-456789abc104'),
  sourceReceipt: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abc105'),
  input: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abc106')),
  run: parseAgentRunId('01890f47-9abc-7def-8123-456789abc107')
} as const;

const bindingKey = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
const bindingProfile = Object.freeze({ key: 'sealed_model_trial_binding', version: 1 });
const keyProfile = Object.freeze({ key: 'sealed-model-effect', version: parseContractVersion(1) });
const appModelLane = parseOperationAccessLane({
  kind: 'app_model',
  surface: 'app_model',
  policy: { key: 'authority.sealed-model-effect', version: 1 }
});

const profiles: ClassifiedPayloadProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef('classification', 'classification.model-private', 1),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.model-json', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.model-json', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', 'descriptor-auth.model-hmac', 1)
});
const reconciliationPolicy = createStageReconciliationPolicyRef('reconciliation.model-attempt', 1);
const descriptorKey = new TextEncoder().encode('sealed-model-attempt-descriptor-key-material-v1');

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, character: string): SafeSchemaManifestRef {
  return Object.freeze({ key, version: 1, digestSha256: character.repeat(64) });
}

const operationRefs = {
  input: schemaRef('schema.sealed-note.input', '1'),
  contribution: schemaRef('schema.sealed-note.contribution', '2'),
  canonical: schemaRef('schema.sealed-note.canonical', '3'),
  projected: schemaRef('schema.sealed-note.projected', '4'),
  conflict: schemaRef('schema.sealed-note.conflict', '5'),
  context: ref('context.sealed-note'),
  autonomy: ref('autonomy.sealed-note'),
  capability: ref('capability.sealed-note'),
  handler: ref('handler.sealed-note'),
  projection: ref('projection.sealed-note'),
  keySource: ref('idempotency.sealed-note'),
  requestHash: ref('request-hash.sealed-note'),
  concurrency: ref('concurrency.sealed-note'),
  audit: ref('audit.sealed-note'),
  auditRecordProfile: ref('audit-record.canonical-json')
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function trialSchema<Output>(parse: (value: unknown) => Output) {
  return {
    parse,
    safeParse(value: unknown) {
      try {
        return { success: true as const, data: parse(value) };
      } catch (error) {
        return { success: false as const, error };
      }
    }
  };
}

const operationInputSchema = trialSchema((value: unknown) => {
  if (!record(value) || Object.keys(value).length !== 1 || typeof value.secret !== 'string' || value.secret.length === 0) {
    throw new TypeError('invalid operation input');
  }
  return { secret: value.secret };
});
const canonicalSchema = trialSchema((value: unknown) => {
  if (!record(value) || typeof value.kind !== 'string') throw new TypeError('invalid canonical result');
  if (value.kind === 'success') {
    if (!record(value.data) || value.data.accepted !== true || Object.keys(value.data).length !== 1) {
      throw new TypeError('invalid canonical success');
    }
    return { kind: 'success' as const, data: { accepted: true as const } };
  }
  if (value.kind === 'outcome') {
    return { kind: 'outcome' as const, outcome: structuredOutcomeSchema.parse(value.outcome) };
  }
  throw new TypeError('invalid canonical result');
});
const contributionSchema = trialSchema((value: unknown) => {
  if (!record(value) || !record(value.domain) || value.domain.accepted !== true
    || !Array.isArray(value.receiptChildren)
    || value.receiptChildren.length !== 0) {
    throw new TypeError('invalid contribution');
  }
  return {
    result: canonicalSchema.parse(value.result),
    domain: { accepted: true as const },
    receiptChildren: []
  };
});
const projectedSchema = trialSchema((value: unknown) => {
  const parsed = effectfulOperationResultSchema.parse(value);
  if (parsed.kind === 'success' && (!record(parsed.data) || parsed.data.accepted !== true)) {
    throw new TypeError('invalid projected success');
  }
  return parsed;
});
const nullSchema = trialSchema((value: unknown) => {
  if (value !== null) throw new TypeError('expected null');
  return null;
});

async function sha256Text(value: string): Promise<string> {
  return createHash('sha256').update(value).digest('hex');
}

class MutableClock implements Clock {
  constructor(private value: Instant) {}
  now(): Instant { return this.value; }
  set(value: string): void { this.value = parseInstant(value); }
}

function profileKey(profile: ClassifiedPayloadProfileRef): string {
  return `${profile.kind}:${profile.key}@${profile.version}`;
}

function policyKey(policy: StageReconciliationPolicyRef): string {
  return `${policy.key}@${policy.version}`;
}

class RetainedProfiles implements RetainedClassifiedPayloadProfileResolver {
  isRetainedProfile(profile: ClassifiedPayloadProfileRef): boolean {
    return [profiles.classification, profiles.schema, profiles.content, profiles.integrity, profiles.descriptorAuth]
      .some((candidate) => profileKey(candidate) === profileKey(profile));
  }
  isRetainedReconciliationPolicy(policy: StageReconciliationPolicyRef): boolean {
    return policyKey(policy) === policyKey(reconciliationPolicy);
  }
  resolveDescriptorAuthenticationKey(profile: ClassifiedPayloadProfileRef<'descriptor_auth'>): Uint8Array | undefined {
    return profileKey(profile) === profileKey(profiles.descriptorAuth) ? Uint8Array.from(descriptorKey) : undefined;
  }
}

class TrialMaterialVault implements ClassifiedPayloadStageStore, RegisteredModelClassifiedMaterialReader {
  readonly registration = ref('classified-reader.sealed-model');
  readonly reads: unknown[] = [];
  readonly #stageBytes = new Map<string, Uint8Array>();
  readonly #payloadBytes = new Map<string, Uint8Array>();
  readonly #requests = new Map<string, { readonly runId: string; readonly value: unknown }>();

  constructor(private readonly store: LocalFilesystemClassifiedPayloadStageStore) {}

  registerRequest(payloadRef: PayloadRef, runId: string, value: unknown): void {
    this.#requests.set(payloadRef.id, { runId, value: structuredClone(value) });
  }

  read(input: Parameters<RegisteredModelClassifiedMaterialReader['read']>[0]): unknown {
    this.reads.push(structuredClone(input));
    if (input.purpose === 'model_attempt_request') {
      const registered = this.#requests.get(input.payloadRef.id);
      if (!registered || registered.runId !== input.owner.runId) throw new TypeError('classified request owner mismatch');
      return structuredClone(registered.value);
    }
    const bytes = this.#payloadBytes.get(input.payloadRef.id);
    if (!bytes) throw new TypeError('classified tool material missing');
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async put(input: Parameters<ClassifiedPayloadStageStore['put']>[0]) {
    const stage = await this.store.put(input);
    this.#stageBytes.set(stage.stageId, Uint8Array.from(input.bytes));
    return stage;
  }

  inspect(input: Parameters<ClassifiedPayloadStageStore['inspect']>[0]) { return this.store.inspect(input); }

  async adopt(input: Parameters<ClassifiedPayloadStageStore['adopt']>[0]): Promise<PayloadStageAdoptionResult> {
    const adopted = await this.store.adopt(input);
    const bytes = this.#stageBytes.get(input.stage.stageId);
    if (bytes) this.#payloadBytes.set(adopted.payloadRef.id, Uint8Array.from(bytes));
    return adopted;
  }

  markAdopted(input: Parameters<ClassifiedPayloadStageStore['markAdopted']>[0]) { return this.store.markAdopted(input); }
  purge(input: Parameters<ClassifiedPayloadStageStore['purge']>[0]) { return this.store.purge(input); }
  listReconciliationCandidates(input: Parameters<ClassifiedPayloadStageStore['listReconciliationCandidates']>[0]) {
    return this.store.listReconciliationCandidates(input);
  }
}

const providerCapabilities: ProviderCapabilities = Object.freeze({
  structuredOutput: true,
  tools: true,
  batch: true,
  fast: true,
  lookup: true,
  cancellation: false,
  idempotency: true
});

type ProviderScenario =
  | { readonly kind: 'success'; readonly output: unknown; readonly advanceClockTo?: string }
  | { readonly kind: 'tools'; readonly inputs: readonly unknown[] }
  | { readonly kind: 'ambiguous'; readonly lookup?: ModelLookupObservation };

class DurableTrialAdapter implements ModelProviderAdapter {
  readonly ref = ref('sealed_trial_adapter');
  readonly observations = new Map<string, ModelAttemptObservation>();
  executeCalls = 0;
  newWork = 0;
  lookupCalls = 0;

  constructor(private readonly scenario: ProviderScenario, private readonly clock: MutableClock) {}
  describeCapabilities(): ProviderCapabilities { return providerCapabilities; }

  async execute(request: ModelAttemptRequest): Promise<ModelAttemptObservation> {
    this.executeCalls += 1;
    const existing = this.observations.get(request.requestBinding);
    if (existing) return existing;
    this.newWork += 1;
    const evidence: SafeProviderEvidence = {
      adapter: this.ref,
      providerRequestId: `sealed:${request.attemptId}`,
      idempotencySupported: true,
      ...(request.executionMode ? { executionMode: request.executionMode } : {})
    };
    let observation: ModelAttemptObservation;
    if (this.scenario.kind === 'success') {
      observation = { kind: 'succeeded', output: structuredClone(this.scenario.output), usage: { costMicros: 20 }, evidence };
      if (this.scenario.advanceClockTo) this.clock.set(this.scenario.advanceClockTo);
    } else if (this.scenario.kind === 'tools') {
      observation = {
        kind: 'tool_requests',
        requests: this.scenario.inputs.map((value, index) => ({
          callId: `provider-call-${index + 1}`,
          operation: { name: 'note.draft', version: 1 },
          input: structuredClone(value)
        })),
        usage: { costMicros: 20 },
        evidence
      };
    } else {
      observation = { kind: 'acceptance_unknown', recovery: 'lookup', evidence };
    }
    this.observations.set(request.requestBinding, observation);
    return observation;
  }

  async lookup(_evidence: SafeProviderEvidence, _request: ModelAttemptRequest): Promise<ModelLookupObservation> {
    this.lookupCalls += 1;
    return this.scenario.kind === 'ambiguous'
      ? this.scenario.lookup ?? { kind: 'pending', evidence: { adapter: this.ref, idempotencySupported: true } }
      : { kind: 'not_found' };
  }

  async cancel(_evidence: SafeProviderEvidence): Promise<ModelCancelObservation> {
    return { kind: 'unsupported' };
  }
}

function modelProfile(timeoutMs = 300_000): ModelProfileRevision {
  const candidate: ModelProfileRevision = {
    key: 'sealed_trial_profile',
    version: 1,
    digest: '0'.repeat(64),
    adapter: ref('sealed_trial_adapter'),
    modelId: 'sealed-trial-model',
    controls: { maxOutputTokens: 500, requireStructuredOutput: true },
    defaultExecutionMode: 'batch',
    budget: {
      maximumAttempts: 2,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostMicros: 1_000,
      timeoutMs
    },
    capabilities: providerCapabilities
  };
  return Object.freeze({ ...candidate, digest: calculateModelProfileDigest(candidate) });
}

function modelScaffold(): ModelScaffoldRevision {
  const candidate: ModelScaffoldRevision = {
    key: 'sealed_trial_scaffold',
    version: 1,
    digest: '0'.repeat(64),
    purpose: 'sealed_trial',
    outputSchema: ref('sealed_trial_output'),
    allowedTools: [{ name: 'note.draft', version: 1 }]
  };
  return Object.freeze({ ...candidate, digest: calculateModelScaffoldDigest(candidate) });
}

async function operationRegistry(sqlite: Database, clock: Clock): Promise<Awaited<ReturnType<typeof createOperationRegistry>>> {
  const autonomy = createOperationAutonomyPolicy({
    definition: operationRefs.autonomy,
    operation: { name: 'note.draft', version: 1 },
    riskFloor: 'normal',
    unattendedRiskCeiling: 'normal',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block',
      unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval',
      known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile',
      stale_plan: 'replan',
      compensation_required: 'compensate',
      terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
  const context = createEffectInvocationContextBuilder({
    reference: operationRefs.context,
    operation: { name: 'note.draft', version: 1 },
    effect: 'draft',
    lanes: [appModelLane],
    scopeResolver: {
      resolve: ({ evidence }) => {
        if (evidence.kind !== 'app_model') throw new TypeError('app-model evidence required');
        const current = sqlite.query<{ readonly state: string }, [string, string, string]>(`
          SELECT r.state FROM model_tool_calls_trial c
          JOIN model_attempts_trial a ON a.attempt_id = c.attempt_id
          JOIN model_runs_trial r ON r.run_id = c.run_id
          WHERE c.run_id = ? AND c.attempt_id = ? AND c.tool_call_id = ?
        `).get(evidence.agentRunId, evidence.modelAttemptId, evidence.modelToolCallId);
        if (!current || current.state !== 'waiting_for_tool') throw new TypeError('model tool is not current');
        return {
          workspaceId: ids.workspace,
          subjects: [{ kind: 'workspace' as const, id: ids.workspace }],
          resolutionEvidenceIds: [`model-tool:${evidence.modelToolCallId}`]
        };
      }
    },
    authorityResolver: {
      resolve: (authorityInput) => {
        if (authorityInput.evidence.kind !== 'app_model') return { kind: 'denied' as const, reason: 'lane_mismatch' as const };
        const evidence = authorityInput.evidence;
        const current = sqlite.query<{ readonly operation_name: string; readonly operation_version: number }, [string, string, string]>(`
          SELECT operation_name, operation_version FROM model_tool_calls_trial
           WHERE run_id = ? AND attempt_id = ? AND tool_call_id = ?
        `).get(evidence.agentRunId, evidence.modelAttemptId, evidence.modelToolCallId);
        if (!current || current.operation_name !== 'note.draft' || current.operation_version !== 1) {
          return { kind: 'denied' as const, reason: 'not_authorized' as const };
        }
        return {
          kind: 'authorized' as const,
          authority: {
            actor: {
              kind: 'app_model_run' as const,
              agentRunId: evidence.agentRunId,
              delegatedByPrincipalId: `workspace-user:${ids.user}`
            },
            principal: { kind: 'workspace_user' as const, userId: ids.user, membershipId: ids.membership },
            lane: authorityInput.lane,
            scope: authorityInput.scope,
            grants: [{ kind: 'permission' as const, key: 'test.note.draft' }],
            evidenceIds: [`model-tool-current:${evidence.modelToolCallId}`],
            authorityCitationIds: [],
            evaluatedAt: authorityInput.evaluatedAt
          }
        };
      }
    },
    clock,
    newInvocationId: () => parseInvocationId(crypto.randomUUID()),
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    requestHashProfile: operationRefs.requestHash,
    requestHashSealer: createHmacRequestHashSealer({ profile: operationRefs.requestHash, keyBytes: new Uint8Array(32).fill(0x3a) }),
    idempotencyCredentialProfile: keyProfile,
    deniedAuthorityOutcome: () => ({
      class: 'access_denied',
      kind: 'authority.denied',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    }),
    idempotencyCredentialSealer: {
      async seal(raw) {
        return { verifierProfile: keyProfile, verifierSha256: await sha256Text(`sealed:v1:${raw}`) };
      }
    }
  });
  const phaseControl = createSingleUnitOfWorkConformanceFixture({
    operation: { name: 'note.draft', version: 1, effect: 'draft' },
    maximumRisk: 'normal',
    consequenceTags: [],
    autonomyPolicy: autonomy,
    handler: operationRefs.handler,
    handlerCapability: operationRefs.capability,
    contributionSchema: operationRefs.contribution,
    nullDetailSchema: operationRefs.conflict
  });
  const source: OperationRegistrySource = {
    ...phaseControl.registrations,
    autonomyPolicies: [autonomy],
    schemas: [
      { reference: operationRefs.input, schema: operationInputSchema as never },
      { reference: operationRefs.contribution, schema: contributionSchema as never },
      { reference: operationRefs.canonical, schema: canonicalSchema as never },
      { reference: operationRefs.projected, schema: projectedSchema as never },
      { reference: operationRefs.conflict, schema: nullSchema as never }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
    projections: [{
      reference: operationRefs.projection,
      canonicalResultSchema: operationRefs.canonical,
      projectedResultSchema: operationRefs.projected,
      project: (candidate) => canonicalSchema.parse(candidate)
    }],
    operations: [],
    effectContextBuilders: [context],
    operationAuditTargets: [{
      reference: operationRefs.audit,
      kind: 'operation_audit_record',
      recordProfile: operationRefs.auditRecordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: operationRefs.auditRecordProfile,
      kind: 'canonical_json',
      maximumBytes: 65_536
    }],
    effectHandlers: [{
      reference: operationRefs.handler,
      effect: 'draft',
      handlerCapability: operationRefs.capability,
      contributionSchema: operationRefs.contribution,
      canonicalResultSchema: operationRefs.canonical,
      handle: ({ businessInput }) => {
        operationInputSchema.parse(businessInput);
        return {
          result: { kind: 'success', data: { accepted: true } },
          domain: { accepted: true },
          receiptChildren: []
        };
      }
    }],
    effectOperations: [{
      name: 'note.draft',
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Create a safe inert note draft.',
      effect: 'draft',
      maxRisk: 'normal',
      autonomyPolicy: operationRefs.autonomy,
      consequenceTags: [],
      inputSchema: operationRefs.input,
      contributionSchema: operationRefs.contribution,
      canonicalResultSchema: operationRefs.canonical,
      outcomes: [
        { class: 'idempotency_conflict', kind: 'operation.request_changed', retryable: false, detailSchema: operationRefs.conflict },
        { class: 'access_denied', kind: 'authority.denied', retryable: false, detailSchema: operationRefs.conflict },
        phaseControl.contentionOutcomeDeclaration,
        ...phaseControl.outcomeDeclarations
      ],
      accessLanes: [appModelLane],
      contextBuilder: operationRefs.context,
      handlerCapability: operationRefs.capability,
      handler: operationRefs.handler,
      audit: { mode: 'required', target: operationRefs.audit },
      idempotency: {
        keySource: operationRefs.keySource,
        credentialVerifierProfile: keyProfile,
        requestHashProfile: operationRefs.requestHash
      },
      concurrency: operationRefs.concurrency,
      execution: phaseControl.execution,
      bindings: [{ surface: 'app_model', toolName: 'note_draft', projection: operationRefs.projection }]
    }]
  };
  return createOperationRegistry(source);
}

class OneShotFaults implements SealedModelAttemptTrialFaults {
  constructor(private point: keyof SealedModelAttemptTrialFaults | undefined) {}
  private hit(point: keyof SealedModelAttemptTrialFaults): void {
    if (this.point === point) {
      this.point = undefined;
      throw new Error(`crash:${point}`);
    }
  }
  beforeStage = () => this.hit('beforeStage');
  afterStagePutBeforeRegistration = () => this.hit('afterStagePutBeforeRegistration');
  afterStage = () => this.hit('afterStage');
  afterAdoption = () => this.hit('afterAdoption');
  afterReductionCommit = () => this.hit('afterReductionCommit');
  afterMarkAdopted = () => this.hit('afterMarkAdopted');
  afterOperationReceipt = () => this.hit('afterOperationReceipt');
}

interface Harness {
  readonly sqlite: Database;
  readonly clock: MutableClock;
  readonly adapter: DurableTrialAdapter;
  readonly vault: TrialMaterialVault;
  readonly operationRegistry: Awaited<ReturnType<typeof createOperationRegistry>>;
  readonly unitOfWork: SQLiteTrialEffectUnitOfWorkPort;
  readonly profile: ModelProfileRevision;
  readonly scaffold: ModelScaffoldRevision;
  readonly faults: OneShotFaults;
  readonly admission: RegisteredModelAttemptAdmission;
  composition: SealedModelAttemptTrialComposition;
  nextAttempt: number;
  nextTool: number;
  nextPayload: number;
  nextCorrelation: number;
  nextReceipt: number;
  recreate(): void;
}

function uuid(suffix: number): string {
  return `01890f47-9abc-7def-8123-${String(suffix).padStart(12, '0')}`;
}

async function harness(input: {
  readonly scenario: ProviderScenario;
  readonly fault?: keyof SealedModelAttemptTrialFaults;
  readonly timeoutMs?: number;
  readonly reservationMicros?: number;
  readonly toolCount?: number;
}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-sealed-model-runner-'));
  directories.add(directory);
  chmodSync(directory, 0o700);
  const stageRoot = join(directory, 'stages');
  mkdirSync(stageRoot, { mode: 0o700 });
  chmodSync(stageRoot, 0o700);
  const sqlite = new Database(join(directory, 'trial.sqlite'), { create: true, strict: true });
  databases.add(sqlite);
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installModelDurabilityTrial(sqlite);
  installSealedModelAttemptTrial(sqlite);
  sqlite.exec(`CREATE TABLE sealed_note_domain_trial (id INTEGER PRIMARY KEY, accepted INTEGER NOT NULL CHECK(accepted = 1));`);

  const clock = new MutableClock(parseInstant('2026-08-11T00:00:00.000Z'));
  const localStore = new LocalFilesystemClassifiedPayloadStageStore({
    root: stageRoot,
    profileResolver: new RetainedProfiles(),
    purgeProofVerifier: createUnadoptedStageProofAuthority({
      clock,
      ownership: { resolve: () => Object.freeze({ kind: 'uncertain' as const }) }
    }).verifier
  });
  const vault = new TrialMaterialVault(localStore);
  const adapter = new DurableTrialAdapter(input.scenario, clock);
  const profile = modelProfile(input.timeoutMs);
  const scaffold = modelScaffold();
  const modelRegistry = createModelRegistry({
    adapters: [{ adapter, implementationDigestSha256: 'a'.repeat(64) }],
    profiles: [profile],
    scaffolds: [scaffold],
    purposes: [{ purpose: scaffold.purpose, profile, scaffold }]
  });
  const registeredOperations = await operationRegistry(sqlite, clock);
  const unitOfWork = new SQLiteTrialEffectUnitOfWorkPort(sqlite, {
    openHandlerSnapshot: () => Object.freeze({ current: null }),
    applyDomainContribution: (contribution) => {
      if (!contribution || typeof contribution !== 'object' || (contribution as { accepted?: unknown }).accepted !== true) {
        throw new TypeError('invalid test contribution');
      }
      sqlite.query('INSERT INTO sealed_note_domain_trial (accepted) VALUES (1)').run();
    }
  });
  const faults = new OneShotFaults(input.fault);
  const admission: RegisteredModelAttemptAdmission = Object.freeze({
    registration: ref('admission.sealed-model'),
    reserve: () => ({ costReservationMicros: input.reservationMicros ?? 100 })
  });
  const outputValidator: RegisteredModelOutputValidator = Object.freeze({
    registration: ref('output-validator.sealed-model'),
    parse: ({ value }: Parameters<RegisteredModelOutputValidator['parse']>[0]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('output schema invalid');
      return structuredClone(value);
    }
  });
  const state = {
    sqlite,
    clock,
    adapter,
    vault,
    operationRegistry: registeredOperations,
    unitOfWork,
    profile,
    scaffold,
    faults,
    admission,
    nextAttempt: 201,
    nextTool: 301,
    nextPayload: 401,
    nextCorrelation: 501,
    nextReceipt: 601
  };
  const compose = () => createSealedModelAttemptTrialComposition({
    sqlite,
    binding: { profile: bindingProfile, keyBytes: bindingKey },
    clock,
    modelRegistry,
    operationRegistry: registeredOperations,
    classifiedStageStore: vault,
    classifiedProfiles: profiles,
    reconciliationPolicy,
    classifiedMaterialReader: vault,
    outputValidator,
    attemptAdmission: admission,
    effectUnitOfWork: unitOfWork,
    stageTtlMs: 600_000,
    newAttemptId: () => uuid(state.nextAttempt++),
    newToolCallId: () => uuid(state.nextTool++),
    newPayloadRefId: () => uuid(state.nextPayload++),
    newCorrelationId: () => uuid(state.nextCorrelation++),
    newReceiptId: () => uuid(state.nextReceipt++),
    faults
  });
  const result = state as Harness;
  result.composition = compose();
  result.recreate = () => { result.composition = compose(); };
  result.composition.repository.insertProfileRevision(profile);
  result.composition.repository.insertScaffoldRevision(scaffold);
  result.composition.repository.pointProfileCurrent({ revision: profile, expectedPointerVersion: null });
  result.composition.repository.pointScaffoldCurrent({ revision: scaffold, expectedPointerVersion: null });
  result.composition.repository.startRun({
    id: ids.run,
    profileKey: profile.key,
    scaffoldKey: scaffold.key,
    sourceOperation: { name: 'model.start', version: 1, receiptId: ids.sourceReceipt },
    scopeKey: `workspace:${ids.workspace}`,
    authorityCitationId: ids.citation,
    classifiedInputRefs: [ids.input],
    createdAt: clock.now()
  });
  const toolCount = input.toolCount ?? (input.scenario.kind === 'tools' ? input.scenario.inputs.length : 0);
  vault.registerRequest(ids.input, ids.run, {
    messages: [{ role: 'user', content: 'classified-request-canary-never-in-sql' }],
    tools: toolCount > 0 ? [{
      operation: { name: 'note.draft', version: 1 },
      description: 'Create an inert draft.',
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['secret'], properties: { secret: { type: 'string' } } }
    }] : [],
    outputJsonSchema: { name: 'sealed_trial_output', schema: { type: 'object' }, strict: true }
  });
  return result;
}

function sqliteBytes(sqlite: Database): Buffer {
  return Buffer.from(sqlite.serialize());
}

function expectAbsent(sqlite: Database, ...canaries: string[]): void {
  const bytes = sqliteBytes(sqlite);
  for (const canary of canaries) {
    expect(bytes.includes(Buffer.from(canary))).toBe(false);
    expect(bytes.includes(Buffer.from(createHash('sha256').update(canary).digest('hex')))).toBe(false);
  }
}

describe('sealed model-attempt trial composition', () => {
  test('requires explicit Foundation-before-model install order and retains the real receipt FK', () => {
    const sqlite = new Database(':memory:', { strict: true });
    databases.add(sqlite);
    expect(() => installModelDurabilityTrial(sqlite)).toThrow('foundation_trial_receipt_schema_required');
    installFoundationTrialUnitOfWorkSchema(sqlite);
    installModelDurabilityTrial(sqlite);
    expect(() => installSealedModelAttemptTrial(sqlite)).not.toThrow();
    expect(sqlite.query<{ table: string }, []>(`
      SELECT "table" AS "table" FROM pragma_foreign_key_list('model_tool_calls_trial')
       WHERE "from" = 'operation_receipt_id'
    `).get()?.table).toBe('foundation_trial_operation_receipts');
    expect(sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM sqlite_master WHERE name = 'model_tool_operation_receipts_trial'
    `).get()?.count).toBe(0);
  });

  for (const fault of [
    'beforeStage', 'afterStage', 'afterAdoption',
    'afterReductionCommit', 'afterMarkAdopted'
  ] as const) {
    test(`recovers the same frozen provider work after ${fault}`, async () => {
      const outputCanary = `classified-output-${fault}-never-in-sql`;
      const test = await harness({ scenario: { kind: 'success', output: { privateValue: outputCanary } }, fault });
      await expect(test.composition.runner.runAttempt({ runId: ids.run })).rejects.toThrow(`crash:${fault}`);
      test.recreate();
      const completed = await test.composition.runner.runAttempt({ runId: ids.run });
      expect(completed.run.state).toBe('succeeded');
      expect(completed.run.resultRef?.id).toBeDefined();
      expect(test.adapter.newWork).toBe(1);
      expect(test.sqlite.query<{ reduction_committed: number; marked_adopted: number }, []>(`
        SELECT reduction_committed, marked_adopted FROM model_attempt_payload_adoptions_trial
      `).get()).toEqual({ reduction_committed: 1, marked_adopted: 1 });
      expectAbsent(test.sqlite, outputCanary, 'classified-request-canary-never-in-sql');
    });
  }

  test('a crash after stage put leaves only a bounded reconciliation candidate and retries the same attempt', async () => {
    const outputCanary = 'classified-orphan-stage-output-never-in-sql';
    const test = await harness({
      scenario: { kind: 'success', output: { privateValue: outputCanary } },
      fault: 'afterStagePutBeforeRegistration'
    });

    await expect(test.composition.runner.runAttempt({ runId: ids.run }))
      .rejects.toThrow('crash:afterStagePutBeforeRegistration');

    const interruptedRun = test.composition.repository.getRun(ids.run)!;
    const interruptedAttempt = test.composition.repository.getAttempt(interruptedRun.activeAttempt!.id)!;
    expect(interruptedRun.state).toBe('running');
    expect(Object.hasOwn(interruptedRun, 'resultRef')).toBe(false);
    expect(interruptedAttempt.state).toBe('started');
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM model_attempt_payload_adoptions_trial
    `).get()?.count).toBe(0);
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM model_tool_calls_trial
    `).get()?.count).toBe(0);
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM foundation_trial_operation_receipts
    `).get()?.count).toBe(0);
    expectAbsent(test.sqlite, outputCanary);

    test.recreate();
    const orphanPage = await test.vault.listReconciliationCandidates({ limit: 1 });
    expect(orphanPage.candidates).toHaveLength(1);
    expect(orphanPage.nextCursor).toBeUndefined();
    expect(orphanPage.candidates[0]?.reconciliationPolicy).toEqual(reconciliationPolicy);

    const completed = await test.composition.runner.runAttempt({ runId: ids.run });
    expect(completed.run.state).toBe('succeeded');
    expect(completed.attempt.id).toBe(interruptedAttempt.id);
    expect(completed.attempt.fence).toBe(interruptedAttempt.fence);
    expect(test.adapter.executeCalls).toBe(2);
    expect(test.adapter.newWork).toBe(1);
    expect((await test.vault.listReconciliationCandidates({ limit: 1 })).candidates)
      .toEqual(orphanPage.candidates);
    expectAbsent(test.sqlite, outputCanary);
  });

  test('stages every tool input, resolves one actual Foundation receipt, and resumes only after attachment', async () => {
    const firstCanary = 'classified-tool-one-never-in-sql';
    const secondCanary = 'classified-tool-two-never-in-sql';
    const test = await harness({
      scenario: { kind: 'tools', inputs: [{ secret: firstCanary }, { secret: secondCanary }] },
      toolCount: 2
    });
    const waiting = await test.composition.runner.runAttempt({ runId: ids.run });
    expect(waiting.run.state).toBe('waiting_for_tool');
    const calls = test.sqlite.query<{ tool_call_id: string; input_payload_ref_id: string }, []>(`
      SELECT tool_call_id, input_payload_ref_id FROM model_tool_calls_trial ORDER BY sequence
    `).all();
    expect(calls).toHaveLength(2);
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM model_attempt_payload_adoptions_trial
       WHERE owner_kind = 'model_tool_input' AND reduction_committed = 1 AND marked_adopted = 1
    `).get()?.count).toBe(2);
    expect(() => test.sqlite.query(`
      UPDATE model_tool_calls_trial SET operation_receipt_id = ? WHERE tool_call_id = ?
    `).run(uuid(999), calls[0]!.tool_call_id)).toThrow();
    await expect(test.composition.runner.resumeAfterTools({ runId: ids.run })).rejects.toThrow('incomplete');
    for (const call of calls) {
      const attached = await test.composition.runner.executeToolCall({ toolCallId: call.tool_call_id as never });
      expect(attached.kind).toBe('attached');
    }
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM foundation_trial_operation_receipts WHERE surface = 'app_model'
    `).get()?.count).toBe(2);
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM sealed_note_domain_trial
    `).get()?.count).toBe(2);
    expect((await test.composition.runner.resumeAfterTools({ runId: ids.run })).state).toBe('queued');
    expectAbsent(test.sqlite, firstCanary, secondCanary);
    expect(test.vault.reads.filter((entry) => (entry as { purpose?: string }).purpose === 'model_tool_operation_input')).toHaveLength(2);
  });

  test('receipt response loss replays the same operation and cannot be replaced by a caller-shaped receipt', async () => {
    const test = await harness({
      scenario: { kind: 'tools', inputs: [{ secret: 'receipt-loss-private-input' }] },
      fault: 'afterOperationReceipt'
    });
    await test.composition.runner.runAttempt({ runId: ids.run });
    const toolCallId = test.sqlite.query<{ tool_call_id: string }, []>(`
      SELECT tool_call_id FROM model_tool_calls_trial
    `).get()!.tool_call_id;
    await expect(test.composition.runner.executeToolCall({ toolCallId: toolCallId as never }))
      .rejects.toThrow('crash:afterOperationReceipt');
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM foundation_trial_operation_receipts
    `).get()?.count).toBe(1);
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM sealed_note_domain_trial
    `).get()?.count).toBe(1);
    test.recreate();
    expect((await test.composition.runner.executeToolCall({ toolCallId: toolCallId as never })).kind).toBe('attached');
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM foundation_trial_operation_receipts
    `).get()?.count).toBe(1);
    expect(() => test.composition.repository.attachToolReceipt(Object.freeze({})))
      .toThrow('unsealed_model_tool_receipt');
    expectAbsent(test.sqlite, 'receipt-loss-private-input');
  });

  test('caller budget/mode fields and registered under-reservation fail before provider work', async () => {
    const caller = await harness({ scenario: { kind: 'success', output: { ok: true } } });
    await expect((caller.composition.runner.runAttempt as (value: unknown) => Promise<unknown>)({
      runId: ids.run,
      costReservationMicros: 1,
      requestedExecutionMode: 'fast'
    })).rejects.toThrow('sealed_model_runner_input_invalid');
    expect(caller.adapter.newWork).toBe(0);
    expect(caller.composition.repository.getRun(ids.run)?.state).toBe('queued');

    const under = await harness({ scenario: { kind: 'success', output: { ok: true } }, reservationMicros: 0 });
    await expect(under.composition.runner.runAttempt({ runId: ids.run }))
      .rejects.toThrow('sealed_model_cost_reservation_invalid');
    expect(under.adapter.newWork).toBe(0);
    expect(under.composition.repository.getRun(ids.run)?.state).toBe('queued');
  });

  test('trusted run timeout prevents provider work and blocks ambiguous recovery without caller intervention', async () => {
    const before = await harness({ scenario: { kind: 'success', output: { private: 'late' } }, timeoutMs: 30_000 });
    before.clock.set('2026-08-11T00:00:31.000Z');
    const timedOut = await before.composition.runner.runAttempt({ runId: ids.run });
    expect(timedOut.run).toMatchObject({ state: 'attention', safeFailureCode: 'model_run_timeout_exceeded' });
    expect(before.adapter.newWork).toBe(0);

    const recoveredCanary = 'lookup-terminal-output-never-escapes';
    const ambiguous = await harness({
      scenario: {
        kind: 'ambiguous',
        lookup: {
          kind: 'succeeded',
          output: { private: recoveredCanary },
          usage: { costMicros: 1 },
          evidence: { adapter: ref('sealed_trial_adapter'), idempotencySupported: true }
        }
      },
      timeoutMs: 30_000
    });
    expect((await ambiguous.composition.runner.runAttempt({ runId: ids.run })).run.state).toBe('reconciling');
    ambiguous.recreate();
    ambiguous.clock.set('2026-08-11T00:00:31.000Z');
    expect(await ambiguous.composition.runner.recoverAmbiguous({ runId: ids.run }))
      .toEqual({ kind: 'paused', reason: 'timeout' });
    expect(ambiguous.adapter.lookupCalls).toBe(0);
    expectAbsent(ambiguous.sqlite, recoveredCanary);
  });

  test('a terminal ambiguity lookup is contained as a safe pause and never returns raw canary material', async () => {
    const canary = 'ambiguous-lookup-output-must-not-return';
    const test = await harness({
      scenario: {
        kind: 'ambiguous',
        lookup: {
          kind: 'succeeded',
          output: { private: canary },
          usage: { costMicros: 1 },
          evidence: { adapter: ref('sealed_trial_adapter'), idempotencySupported: true }
        }
      }
    });
    await test.composition.runner.runAttempt({ runId: ids.run });
    test.recreate();
    const safe = await test.composition.runner.recoverAmbiguous({ runId: ids.run });
    expect(safe).toEqual({ kind: 'paused', reason: 'terminal_reconciliation_required' });
    expect(JSON.stringify(safe)).not.toContain(canary);
    expectAbsent(test.sqlite, canary);
  });

  test('provider completion after the frozen deadline reduces only the safe timeout outcome', async () => {
    const canary = 'late-provider-output-never-adopted';
    const test = await harness({
      scenario: {
        kind: 'success',
        output: { private: canary },
        advanceClockTo: '2026-08-11T00:00:31.000Z'
      },
      timeoutMs: 30_000
    });
    const result = await test.composition.runner.runAttempt({ runId: ids.run });
    expect(result.run).toMatchObject({ state: 'attention', safeFailureCode: 'model_run_timeout_exceeded' });
    expect(test.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM model_attempt_payload_adoptions_trial
    `).get()?.count).toBe(0);
    expectAbsent(test.sqlite, canary);
  });
});
