import { describe, expect, test } from 'bun:test';
import {
  createOperationAutonomyPolicy,
  createEffectInvocationContextBuilder,
  createApplicationOperationRuntime,
  composeOperationRegistryModules,
  createHmacRequestHashSealer,
  createSingleUnitOfWorkConformanceFixture,
  isSealedInvocationContext,
  type EffectInvocationContext,
  type ApplicationOperationRuntime,
  type InvocationEvidence,
  type OperationRegistrySource,
  type ShortOperationAuditRecord
} from '@jooevents/application';
import {
  effectfulOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type OperationAccessLane
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type ResolvedScope
} from '@jooevents/kernel';
import { Database } from 'bun:sqlite';
import {
  SQLiteTrialEffectUnitOfWorkPort,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';

const operationName = 'foundation.note.draft';
const now = parseInstant('2026-08-11T00:00:00.000Z');
const profile = { key: 'foundation.invocation-proof', version: parseContractVersion(1) } as const;

const ids = {
  workspaceAlpha: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  workspaceBeta: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001'),
  ada: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  adaMembership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  grace: parseUserId('01890f47-9abc-7def-8123-456789abc003'),
  graceMembership: parseMembershipId('01890f47-9abc-7def-8123-456789abc004')
} as const;

const invocationIds = [
  '01890f47-9abc-7def-8123-456789abc101',
  '01890f47-9abc-7def-8123-456789abc102',
  '01890f47-9abc-7def-8123-456789abc103',
  '01890f47-9abc-7def-8123-456789abc104',
  '01890f47-9abc-7def-8123-456789abc105',
  '01890f47-9abc-7def-8123-456789abc106',
  '01890f47-9abc-7def-8123-456789abc107'
] as const;

const correlationIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c7001',
  '018f0f47-7a86-7d36-8a25-9f86589c7002',
  '018f0f47-7a86-7d36-8a25-9f86589c7003',
  '018f0f47-7a86-7d36-8a25-9f86589c7004',
  '018f0f47-7a86-7d36-8a25-9f86589c7005',
  '018f0f47-7a86-7d36-8a25-9f86589c7006',
  '018f0f47-7a86-7d36-8a25-9f86589c7007'
] as const;

const receiptIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c8001',
  '018f0f47-7a86-7d36-8a25-9f86589c8002',
  '018f0f47-7a86-7d36-8a25-9f86589c8003',
  '018f0f47-7a86-7d36-8a25-9f86589c8004'
] as const;

const credentials = {
  adaAlpha: 'session-secret-ada-alpha',
  graceAlpha: 'session-secret-grace-alpha',
  adaBeta: 'session-secret-ada-beta',
  sharedIdempotency: 'idempotency-secret-shared',
  transactionRevoked: 'idempotency-secret-transaction-revoked',
  deniedIdempotency: 'idempotency-secret-denied'
} as const;

function definitionRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: seed.repeat(64) };
}

const refs = {
  input: schemaRef('schema.foundation-note.input', '1'),
  contribution: schemaRef('schema.foundation-note.contribution', '2'),
  canonical: schemaRef('schema.foundation-note.canonical', '3'),
  projected: schemaRef('schema.foundation-note.operator-result', '4'),
  nullDetail: schemaRef('schema.foundation-note.null-detail', '5'),
  context: definitionRef('context.foundation-note'),
  capability: definitionRef('capability.foundation-note-write'),
  handler: definitionRef('handler.foundation-note'),
  projection: definitionRef('projection.foundation-note-operator'),
  autonomy: definitionRef('autonomy.foundation-note-draft'),
  keySource: definitionRef('idempotency.operator-header'),
  requestHash: definitionRef('request-hash.foundation-canonical-input'),
  concurrency: definitionRef('concurrency.foundation-ordinary-effect'),
  audit: definitionRef('audit.foundation-note'),
  auditRecordProfile: definitionRef('audit-record.canonical-json')
} as const;

const operatorLane: OperationAccessLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.operator.current', version: 1 }
});

interface NoteInput {
  readonly title: string;
  readonly workspaceId: ReturnType<typeof parseWorkspaceId>;
}

interface DomainContribution {
  readonly noteId: string;
  readonly scopePartitionKey: string;
  readonly authorityPrincipalKey: string;
  readonly title: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isNoteInput(value: unknown): value is NoteInput {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['title', 'workspaceId'])
    || typeof value.title !== 'string'
    || value.title.length === 0
    || value.title.length > 200) return false;
  try {
    parseWorkspaceId(value.workspaceId);
    return true;
  } catch {
    return false;
  }
}

function isDomainContribution(value: unknown): value is DomainContribution {
  return isPlainRecord(value)
    && hasExactKeys(value, ['authorityPrincipalKey', 'noteId', 'scopePartitionKey', 'title'])
    && typeof value.noteId === 'string'
    && typeof value.scopePartitionKey === 'string'
    && /^[a-f0-9]{64}$/.test(value.scopePartitionKey)
    && typeof value.authorityPrincipalKey === 'string'
    && /^[a-f0-9]{64}$/.test(value.authorityPrincipalKey)
    && typeof value.title === 'string';
}

function isCanonicalResult(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'outcome') {
    return hasExactKeys(value, ['kind', 'outcome'])
      && structuredOutcomeSchema.safeParse(value.outcome).success;
  }
  if (value.kind !== 'success' || !hasExactKeys(value, ['data', 'kind']) || !isPlainRecord(value.data)) return false;
  return hasExactKeys(value.data, ['noteId', 'title'])
    && typeof value.data.noteId === 'string'
    && typeof value.data.title === 'string';
}

function isReceiptChild(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['action', 'kind', 'noteId'])
    && value.kind === 'domain_evidence'
    && value.action === 'note.drafted'
    && typeof value.noteId === 'string';
}

function isContributionEnvelope(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['domain', 'receiptChildren', 'result'])
    || !isCanonicalResult(value.result)
    || !isDomainContribution(value.domain)
    || !Array.isArray(value.receiptChildren)) return false;
  return value.receiptChildren.every(isReceiptChild);
}

const jsonSchema = structuredOutcomeSchema.shape.detail;
const inputSchema = jsonSchema.refine(isNoteInput);
const canonicalSchema = jsonSchema.refine(isCanonicalResult);
const contributionSchema = jsonSchema.refine(isContributionEnvelope);
const nullDetailSchema = jsonSchema.refine((value) => value === null);

function requireNoteInput(value: unknown): NoteInput {
  if (!isNoteInput(value)) throw new TypeError('invalid_foundation_note_input');
  return value;
}

function requireDomainContribution(value: unknown): DomainContribution {
  if (!isDomainContribution(value)) throw new TypeError('invalid_foundation_domain_contribution');
  return value;
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface SessionAuthority {
  readonly workspaceId: ReturnType<typeof parseWorkspaceId>;
  readonly userId: ReturnType<typeof parseUserId>;
  readonly membershipId: ReturnType<typeof parseMembershipId>;
}

const sessionDirectory: ReadonlyMap<string, SessionAuthority> = new Map([
  [credentials.adaAlpha, { workspaceId: ids.workspaceAlpha, userId: ids.ada, membershipId: ids.adaMembership }],
  [credentials.graceAlpha, { workspaceId: ids.workspaceAlpha, userId: ids.grace, membershipId: ids.graceMembership }],
  [credentials.adaBeta, { workspaceId: ids.workspaceBeta, userId: ids.ada, membershipId: ids.adaMembership }]
]);

function resolvedScope(workspaceId: ReturnType<typeof parseWorkspaceId>): ResolvedScope {
  return {
    workspaceId,
    subjects: [{ kind: 'workspace', id: workspaceId }],
    resolutionEvidenceIds: ['workspace-routing-current:v1']
  };
}

function deniedAuthorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return {
    class: 'access_denied',
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  };
}

interface Faults {
  domain: boolean;
  projection: boolean;
  terminalAudit: boolean;
  shortAudit: boolean;
}

interface Tracker {
  authorityResolutionCount: number;
  transactionAuthorityResolutionCount: number;
  readonly transactionAuthorityStates: boolean[];
  handlerCalls: number;
  projectionCalls: number;
  domainCalls: number;
  readonly sealedIdempotencyCredentials: string[];
  readonly requestBindingFrames: Uint8Array[];
  readonly handlerContexts: EffectInvocationContext[];
  readonly domainTransactionStates: boolean[];
  readonly domainContributions: DomainContribution[];
}

interface Harness {
  readonly sqlite: Database;
  readonly tracker: Tracker;
  readonly faults: Faults;
  readonly revokedSessions: Set<string>;
  readonly builder: ApplicationOperationRuntime['effectBuilder'];
  readonly executor: ApplicationOperationRuntime['effectExecutor'];
  readonly unitOfWork: SQLiteTrialEffectUnitOfWorkPort;
  readonly shortAudits: ShortOperationAuditRecord[];
  readonly invocationIdControl: { override: string | undefined };
}

async function createHarness(): Promise<Harness> {
  const sqlite = new Database(':memory:', { strict: true });
  installFoundationTrialUnitOfWorkSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE foundation_trial_domain_notes (
      note_id TEXT PRIMARY KEY,
      scope_partition_key TEXT NOT NULL CHECK(length(scope_partition_key) = 64),
      authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) = 64),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200)
    );
  `);

  const tracker: Tracker = {
    authorityResolutionCount: 0,
    transactionAuthorityResolutionCount: 0,
    transactionAuthorityStates: [],
    handlerCalls: 0,
    projectionCalls: 0,
    domainCalls: 0,
    sealedIdempotencyCredentials: [],
    requestBindingFrames: [],
    handlerContexts: [],
    domainTransactionStates: [],
    domainContributions: []
  };
  const faults: Faults = { domain: false, projection: false, terminalAudit: false, shortAudit: false };
  const revokedSessions = new Set<string>();
  let nextInvocationId = 0;
  let nextReceiptId = 0;
  const invocationIdControl: { override: string | undefined } = { override: undefined };
  const shortAudits: ShortOperationAuditRecord[] = [];

  const authorityResolver: CurrentAuthorityResolver<InvocationEvidence> = {
    resolve(input) {
      tracker.authorityResolutionCount += 1;
      if (input.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
      const session = sessionDirectory.get(input.evidence.sessionHandle);
      if (!session) return { kind: 'denied', reason: 'missing' };
      if (revokedSessions.has(input.evidence.sessionHandle)) return { kind: 'denied', reason: 'revoked' };
      if (input.scope.workspaceId !== session.workspaceId) {
        return { kind: 'denied', reason: 'cross_scope' };
      }
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId: session.userId },
          principal: { kind: 'workspace_user', userId: session.userId, membershipId: session.membershipId },
          lane: input.lane,
          scope: input.scope,
          grants: [{ kind: 'permission', key: 'foundation.note.draft' }],
          evidenceIds: [`membership-current:${session.membershipId}`],
          authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  sqlite.exec(`
    CREATE TABLE foundation_trial_current_operator_authority (
      session_handle TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      membership_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'revoked'))
    );
  `);
  const seedAuthority = sqlite.query<never, [string, string, string, string]>(`
    INSERT INTO foundation_trial_current_operator_authority (
      session_handle, workspace_id, user_id, membership_id, state
    ) VALUES (?, ?, ?, ?, 'active')
  `);
  for (const [sessionHandle, session] of sessionDirectory) {
    seedAuthority.run(sessionHandle, session.workspaceId, session.userId, session.membershipId);
  }
  const transactionAuthorityResolver: CurrentAuthorityResolver<InvocationEvidence> = {
    resolve(input) {
      tracker.transactionAuthorityResolutionCount += 1;
      tracker.transactionAuthorityStates.push(sqlite.inTransaction);
      if (!sqlite.inTransaction) throw new TypeError('transaction authority read escaped SQLite transaction');
      if (input.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
      const session = sqlite.query<{
        readonly workspace_id: string;
        readonly user_id: string;
        readonly membership_id: string;
        readonly state: 'active' | 'revoked';
      }, [string]>(`
        SELECT workspace_id, user_id, membership_id, state
          FROM foundation_trial_current_operator_authority
         WHERE session_handle = ?
      `).get(input.evidence.sessionHandle);
      if (!session) return { kind: 'denied', reason: 'missing' };
      if (session.state === 'revoked') return { kind: 'denied', reason: 'revoked' };
      if (input.scope.workspaceId !== session.workspace_id) return { kind: 'denied', reason: 'cross_scope' };
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId: parseUserId(session.user_id) },
          principal: {
            kind: 'workspace_user',
            userId: parseUserId(session.user_id),
            membershipId: parseMembershipId(session.membership_id)
          },
          lane: input.lane,
          scope: input.scope,
          grants: [{ kind: 'permission', key: 'foundation.note.draft' }],
          evidenceIds: [`membership-current:${session.membership_id}`],
          authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };

  const requestHashSealer = createHmacRequestHashSealer({
    profile: refs.requestHash,
    keyBytes: new Uint8Array(32).fill(0x38)
  });
  const contextBuilder = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: { name: operationName, version: 1 },
    effect: 'draft',
    lanes: [operatorLane],
    scopeResolver: {
      resolve({ businessInput }) {
        return resolvedScope(requireNoteInput(businessInput).workspaceId);
      }
    },
    authorityResolver,
    clock: { now: () => now },
    newInvocationId: () => {
      const selected = invocationIdControl.override
        ?? invocationIds[nextInvocationId++]
        ?? crypto.randomUUID();
      invocationIdControl.override = undefined;
      return parseInvocationId(selected);
    },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashProfile: refs.requestHash,
    requestHashSealer: {
      seal(bytes) {
        tracker.requestBindingFrames.push(Uint8Array.from(bytes));
        return requestHashSealer.seal(bytes);
      }
    },
    idempotencyCredentialProfile: profile,
    deniedAuthorityOutcome,
    idempotencyCredentialSealer: {
      async seal(rawIdempotencyKey) {
        tracker.sealedIdempotencyCredentials.push(rawIdempotencyKey);
        return {
          verifierProfile: profile,
          verifierSha256: await hmacSha256('foundation-proof-idempotency-v1', rawIdempotencyKey)
        };
      }
    }
  });

  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: refs.nullDetail
  }));
  const autonomyPolicy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: { name: operationName, version: 1 },
    riskFloor: 'normal',
    unattendedRiskCeiling: 'normal',
    supportedDispositions: [
      'proceed',
      'safe_retry',
      'reconcile',
      'renewed_approval',
      'replan',
      'compensate',
      'block',
      'attention'
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
  const phaseControl = createSingleUnitOfWorkConformanceFixture({
    operation: { name: operationName, version: 1, effect: 'draft' },
    maximumRisk: 'normal',
    consequenceTags: [],
    autonomyPolicy,
    handler: refs.handler,
    handlerCapability: refs.capability,
    contributionSchema: refs.contribution,
    nullDetailSchema: refs.nullDetail
  });
  const source: OperationRegistrySource = {
    ...phaseControl.registrations,
    autonomyPolicies: [autonomyPolicy],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.contribution, schema: contributionSchema },
      { reference: refs.canonical, schema: canonicalSchema },
      { reference: refs.projected, schema: effectfulOperationResultSchema },
      { reference: refs.nullDetail, schema: nullDetailSchema }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project(candidate) {
        tracker.projectionCalls += 1;
        if (faults.projection) return null;
        return canonicalSchema.parse(candidate);
      }
    }],
    operations: [],
    effectContextBuilders: [contextBuilder],
    operationAuditTargets: [{
      reference: refs.audit,
      kind: 'operation_audit_record',
      recordProfile: refs.auditRecordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: refs.auditRecordProfile,
      kind: 'canonical_json',
      maximumBytes: 65_536
    }],
    effectHandlers: [{
      reference: refs.handler,
      effect: 'draft',
      handlerCapability: refs.capability,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical,
      handle({ businessInput, context, snapshot }) {
        tracker.handlerCalls += 1;
        if (!isSealedInvocationContext(context)) throw new TypeError('unsealed_foundation_context');
        if (!isPlainRecord(snapshot) || typeof snapshot.existingNoteCount !== 'number') {
          throw new TypeError('invalid_foundation_snapshot');
        }
        tracker.handlerContexts.push(context);
        const request = requireNoteInput(businessInput);
        const noteId = String(context.invocationId);
        return {
          result: { kind: 'success', data: { noteId, title: request.title } },
          domain: {
            noteId,
            scopePartitionKey: context.requestBinding.scopePartitionKey,
            authorityPrincipalKey: context.authorityPrincipalKey,
            title: request.title
          },
          receiptChildren: [{ kind: 'domain_evidence', action: 'note.drafted', noteId }]
        };
      }
    }],
    effectOperations: [{
      name: operationName,
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Draft a disposable foundation proof note.',
      effect: 'draft',
      maxRisk: 'normal',
      autonomyPolicy: refs.autonomy,
      consequenceTags: [],
      inputSchema: refs.input,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical,
      outcomes: [
        ...accessOutcomes,
        {
          class: 'idempotency_conflict',
          kind: 'operation.request_changed',
          retryable: false,
          detailSchema: refs.nullDetail
        },
        phaseControl.contentionOutcomeDeclaration,
        ...phaseControl.outcomeDeclarations
      ],
      accessLanes: [operatorLane],
      contextBuilder: refs.context,
      handlerCapability: refs.capability,
      handler: refs.handler,
      audit: { mode: 'required', target: refs.audit },
      idempotency: {
        keySource: refs.keySource,
        credentialVerifierProfile: profile,
        requestHashProfile: refs.requestHash
      },
      concurrency: refs.concurrency,
      execution: phaseControl.execution,
      bindings: [{
        surface: 'operator_http',
        method: 'POST',
        path: '/api/foundation-proof/notes',
        input: 'body',
        browserResumption: { kind: 'none' },
        projection: refs.projection
      }]
    }]
  };

  const domain: SQLiteTrialEffectDomainAdapter = {
    openHandlerSnapshot(capability, context) {
      if (capability.key !== refs.capability.key || capability.version !== refs.capability.version) {
        throw new TypeError('unexpected_foundation_capability');
      }
      const count = sqlite.query<{ readonly count: number }, [string, string]>(`
        SELECT count(*) AS count
          FROM foundation_trial_domain_notes
         WHERE scope_partition_key = ? AND authority_principal_key = ?
      `).get(context.requestBinding.scopePartitionKey, context.authorityPrincipalKey)?.count ?? -1;
      return Object.freeze({ existingNoteCount: count });
    },
    applyDomainContribution(candidate) {
      tracker.domainCalls += 1;
      tracker.domainTransactionStates.push(sqlite.inTransaction);
      const contribution = requireDomainContribution(candidate);
      tracker.domainContributions.push(structuredClone(contribution));
      sqlite.query<never, [string, string, string, string]>(`
        INSERT INTO foundation_trial_domain_notes (
          note_id, scope_partition_key, authority_principal_key, title
        ) VALUES (?, ?, ?, ?)
      `).run(
        contribution.noteId,
        contribution.scopePartitionKey,
        contribution.authorityPrincipalKey,
        contribution.title
      );
      if (faults.domain) throw new Error('injected_foundation_domain_failure_after_write');
    }
  };

  try {
    const unitOfWork = new SQLiteTrialEffectUnitOfWorkPort(sqlite, domain, {
      resolveAuthority: transactionAuthorityResolver.resolve.bind(transactionAuthorityResolver),
      now: () => now
    }, {
      afterTerminalAuditInserted: () => {
        if (faults.terminalAudit) throw new Error('injected_foundation_terminal_audit_failure');
      },
      afterShortAuditInserted: (record) => {
        shortAudits.push(record);
        if (faults.shortAudit) throw new Error('injected_foundation_short_audit_failure');
      }
    });
    const runtime = await createApplicationOperationRuntime({
      source: composeOperationRegistryModules([{ id: 'foundation-note-proof', source }]),
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => now },
        newInvocationId: () => parseInvocationId(crypto.randomUUID())
      },
      unitOfWork,
      newReceiptId: () => receiptIds[nextReceiptId++] ?? crypto.randomUUID()
    });
    return {
      sqlite,
      tracker,
      faults,
      revokedSessions,
      unitOfWork,
      shortAudits,
      invocationIdControl,
      builder: runtime.effectBuilder,
      executor: runtime.effectExecutor
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function evidence(sessionHandle: string): InvocationEvidence {
  return {
    kind: 'operator',
    surface: 'operator_http',
    client: { key: 'web.foundation-proof', version: '1' },
    sessionHandle
  };
}

function buildInvocation(harness: Harness, input: {
  readonly sessionHandle?: string;
  readonly rawIdempotencyKey?: string;
  readonly title?: string;
  readonly correlationId?: string;
}) {
  const sessionHandle = input.sessionHandle ?? credentials.adaAlpha;
  const workspaceId = sessionDirectory.get(sessionHandle)?.workspaceId ?? ids.workspaceAlpha;
  return harness.builder.build({
    operationName,
    operationVersion: 1,
    surface: 'operator_http',
    correlationId: input.correlationId ?? correlationIds[0],
    businessInput: { title: input.title ?? 'Foundation note', workspaceId },
    verifiedEvidence: evidence(sessionHandle),
    rawIdempotencyKey: input.rawIdempotencyKey ?? credentials.sharedIdempotency
  });
}

function databaseCounts(sqlite: Database) {
  const count = (sql: string) => sqlite.query<{ readonly count: number }, []>(sql).get()?.count ?? -1;
  return {
    claims: count('SELECT count(*) AS count FROM foundation_trial_operation_execution_claims'),
    receipts: count('SELECT count(*) AS count FROM foundation_trial_operation_receipts'),
    children: count('SELECT count(*) AS count FROM foundation_trial_operation_receipt_children'),
    audits: count('SELECT count(*) AS count FROM foundation_trial_operation_audits'),
    notes: count('SELECT count(*) AS count FROM foundation_trial_domain_notes')
  };
}

function serializedPersistentRows(sqlite: Database): string {
  return JSON.stringify({
    claims: sqlite.query<Record<string, unknown>, []>(
      'SELECT * FROM foundation_trial_operation_execution_claims'
    ).all(),
    receipts: sqlite.query<Record<string, unknown>, []>(
      'SELECT * FROM foundation_trial_operation_receipts'
    ).all(),
    children: sqlite.query<Record<string, unknown>, []>(
      'SELECT * FROM foundation_trial_operation_receipt_children'
    ).all(),
    audits: sqlite.query<Record<string, unknown>, []>(
      'SELECT * FROM foundation_trial_operation_audits'
    ).all(),
    notes: sqlite.query<Record<string, unknown>, []>(
      'SELECT * FROM foundation_trial_domain_notes'
    ).all()
  });
}

describe('strong invocation pipeline with real disposable SQLite', () => {
  test('rechecks current authority, replays after response loss, isolates identities, and persists no raw credentials', async () => {
    const harness = await createHarness();
    try {
      const firstInvocation = await buildInvocation(harness, { correlationId: correlationIds[0] });
      expect(JSON.stringify(firstInvocation)).not.toContain(credentials.sharedIdempotency);

      // Treat this successful return as lost by the transport. Only durable state remains.
      const lostResponse = await harness.executor.execute(firstInvocation);
      const originalReceiptChildren = harness.sqlite.query<{
        readonly ordinal: number;
        readonly contribution_json: string;
      }, []>(`
        SELECT ordinal, contribution_json
          FROM foundation_trial_operation_receipt_children
         ORDER BY ordinal
      `).all();
      const replay = await harness.executor.execute(await buildInvocation(harness, {
        correlationId: correlationIds[1]
      }));
      expect(replay).toEqual(lostResponse);
      expect(replay.correlationId).toBe(correlationIds[0]);
      expect(harness.tracker.handlerCalls).toBe(1);
      expect(harness.tracker.domainCalls).toBe(1);
      expect(harness.tracker.domainTransactionStates).toEqual([true]);
      expect(databaseCounts(harness.sqlite)).toEqual({ claims: 0, receipts: 1, children: 1, audits: 2, notes: 1 });
      expect(harness.sqlite.query<{ readonly ordinal: number; readonly contribution_json: string }, []>(`
        SELECT ordinal, contribution_json
          FROM foundation_trial_operation_receipt_children
         ORDER BY ordinal
      `).all()).toEqual(originalReceiptChildren);
      expect(harness.shortAudits[0]).toMatchObject({
        disposition: 'terminal_replay',
        relatedReceiptId: lostResponse.kind === 'success' ? lostResponse.receipt.id : undefined
      });
      await harness.unitOfWork.recordShortOperationAudit(harness.shortAudits[0]!);
      expect(databaseCounts(harness.sqlite).audits).toBe(2);

      harness.invocationIdControl.override = invocationIds[1];
      await expect(harness.executor.execute(await buildInvocation(harness, {
        correlationId: correlationIds[2],
        title: 'Conflicting bytes for the same audit event identity'
      }))).rejects.toMatchObject({ phase: 'operation_audit' });
      expect(databaseCounts(harness.sqlite).audits).toBe(2);

      const changed = await harness.executor.execute(await buildInvocation(harness, {
        correlationId: correlationIds[2],
        title: 'Changed request under the same credential'
      }));
      expect(changed).toEqual({
        kind: 'outcome',
        outcome: {
          class: 'idempotency_conflict',
          kind: 'operation.request_changed',
          retryable: false,
          subjects: [],
          detail: null,
          detailSchemaVersion: 1
        },
        terminal: false,
        correlationId: correlationIds[2]
      });
      expect('receipt' in changed).toBe(false);
      expect(harness.tracker.handlerCalls).toBe(1);
      expect(harness.tracker.domainCalls).toBe(1);
      expect(databaseCounts(harness.sqlite)).toEqual({ claims: 0, receipts: 1, children: 1, audits: 3, notes: 1 });

      await harness.executor.execute(await buildInvocation(harness, {
        correlationId: correlationIds[3],
        sessionHandle: credentials.graceAlpha
      }));
      await harness.executor.execute(await buildInvocation(harness, {
        correlationId: correlationIds[4],
        sessionHandle: credentials.adaBeta
      }));
      expect(databaseCounts(harness.sqlite)).toEqual({ claims: 0, receipts: 3, children: 3, audits: 5, notes: 3 });
      expect(harness.tracker.handlerCalls).toBe(3);
      expect(harness.tracker.domainCalls).toBe(3);

      const receiptPartitions = harness.sqlite.query<{
        readonly scope_partition_key: string;
        readonly authority_principal_key: string;
        readonly idempotency_key_verifier: string;
      }, []>(`
        SELECT scope_partition_key, authority_principal_key, idempotency_key_verifier
          FROM foundation_trial_operation_receipts
         ORDER BY scope_partition_key, authority_principal_key
      `).all();
      expect(new Set(receiptPartitions.map((row) => row.scope_partition_key)).size).toBe(2);
      expect(new Set(receiptPartitions.map((row) => row.authority_principal_key)).size).toBe(2);
      expect(new Set(receiptPartitions.map((row) => row.idempotency_key_verifier)).size).toBe(1);
      expect(receiptPartitions[0]?.idempotency_key_verifier).toBe(
        await hmacSha256('foundation-proof-idempotency-v1', credentials.sharedIdempotency)
      );

      const builtBeforeRevocation = await buildInvocation(harness, {
        correlationId: correlationIds[5],
        rawIdempotencyKey: credentials.transactionRevoked
      });
      harness.revokedSessions.add(credentials.adaAlpha);
      const revokedInTransaction = await harness.executor.execute(builtBeforeRevocation);
      expect(revokedInTransaction).toEqual({
        kind: 'outcome',
        outcome: {
          class: 'access_denied',
          kind: 'authority.revoked',
          retryable: false,
          subjects: [],
          detail: null,
          detailSchemaVersion: 1
        },
        terminal: false,
        correlationId: correlationIds[5]
      });
      expect(databaseCounts(harness.sqlite)).toEqual({ claims: 0, receipts: 3, children: 3, audits: 6, notes: 3 });

      const denied = await harness.executor.execute(await buildInvocation(harness, {
        correlationId: correlationIds[6],
        rawIdempotencyKey: credentials.deniedIdempotency
      }));
      expect(denied).toEqual({
        kind: 'outcome',
        outcome: {
          class: 'access_denied',
          kind: 'authority.revoked',
          retryable: false,
          subjects: [],
          detail: null,
          detailSchemaVersion: 1
        },
        terminal: false,
        correlationId: correlationIds[6]
      });
      expect(harness.tracker.authorityResolutionCount).toBe(15);
      expect(harness.tracker.transactionAuthorityResolutionCount).toBe(3);
      expect(harness.tracker.transactionAuthorityStates).toEqual(Array(3).fill(true));
      expect(harness.tracker.sealedIdempotencyCredentials).toEqual([
        credentials.sharedIdempotency,
        credentials.sharedIdempotency,
        credentials.sharedIdempotency,
        credentials.sharedIdempotency,
        credentials.sharedIdempotency,
        credentials.sharedIdempotency,
        credentials.transactionRevoked
      ]);
      expect(databaseCounts(harness.sqlite)).toEqual({ claims: 0, receipts: 3, children: 3, audits: 7, notes: 3 });
      expect(harness.sqlite.query<{
        readonly disposition: string;
        readonly receipt_id: string | null;
        readonly related_receipt_id: string | null;
      }, []>(`
        SELECT disposition, receipt_id, related_receipt_id
          FROM foundation_trial_operation_audits
         ORDER BY rowid
      `).all()).toEqual([
        { disposition: 'terminal_new', receipt_id: receiptIds[0], related_receipt_id: null },
        { disposition: 'terminal_replay', receipt_id: null, related_receipt_id: receiptIds[0] },
        { disposition: 'idempotency_conflict', receipt_id: null, related_receipt_id: null },
        { disposition: 'terminal_new', receipt_id: receiptIds[1], related_receipt_id: null },
        { disposition: 'terminal_new', receipt_id: receiptIds[2], related_receipt_id: null },
        { disposition: 'nonterminal_progress', receipt_id: null, related_receipt_id: null },
        { disposition: 'context_denied', receipt_id: null, related_receipt_id: null }
      ]);
      expect(harness.tracker.handlerContexts.every((context) =>
        context.authority.grants.some((grant) => grant.kind === 'permission' && grant.key === 'foundation.note.draft')
      )).toBe(true);

      const persistentRows = serializedPersistentRows(harness.sqlite);
      const trustedHandlerMaterial = JSON.stringify({
        contexts: harness.tracker.handlerContexts,
        contributions: harness.tracker.domainContributions
      });
      for (const credential of Object.values(credentials)) {
        expect(persistentRows).not.toContain(credential);
        expect(trustedHandlerMaterial).not.toContain(credential);
      }
      for (const frame of harness.tracker.requestBindingFrames) {
        expect(persistentRows).not.toContain(await sha256Bytes(frame));
      }
    } finally {
      harness.sqlite.close();
    }
  });

  test('a transaction-time authority loss returns a typed zero-write refusal', async () => {
    const harness = await createHarness();
    try {
      const invocation = await buildInvocation(harness, {
        rawIdempotencyKey: credentials.transactionRevoked
      });
      harness.sqlite.query<never, [string]>(`
        UPDATE foundation_trial_current_operator_authority
           SET state = 'revoked'
         WHERE session_handle = ?
      `).run(credentials.adaAlpha);

      const result = await harness.executor.execute(invocation);
      expect(result).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'access_denied',
          kind: 'authority.revoked',
          retryable: false
        }
      });
      expect(harness.tracker.authorityResolutionCount).toBe(2);
      expect(harness.tracker.transactionAuthorityResolutionCount).toBe(1);
      expect(harness.tracker.transactionAuthorityStates).toEqual([true]);
      expect(databaseCounts(harness.sqlite)).toEqual({
        claims: 0, receipts: 0, children: 0, audits: 1, notes: 0
      });
      expect(harness.sqlite.query<{ readonly disposition: string; readonly record_json: string }, []>(
        'SELECT disposition, record_json FROM foundation_trial_operation_audits'
      ).get()).toMatchObject({
        disposition: 'nonterminal_progress',
        record_json: expect.stringContaining('authority_recheck')
      });
    } finally {
      harness.sqlite.close();
    }
  });

  test('domain-after-write and projection failures roll back the row, receipt, and transient claim', async () => {
    for (const failure of ['domain', 'projection', 'terminalAudit'] as const) {
      const harness = await createHarness();
      try {
        harness.faults[failure] = true;
        await expect(harness.executor.execute(await buildInvocation(harness, {
          rawIdempotencyKey: `idempotency-secret-${failure}`
        }))).rejects.toMatchObject({
          name: 'OperationExecutionError',
          phase: failure === 'domain'
            ? 'domain_contribution'
            : failure === 'terminalAudit'
              ? 'operation_audit'
              : 'projection'
        });
        expect(databaseCounts(harness.sqlite)).toEqual({ claims: 0, receipts: 0, children: 0, audits: 0, notes: 0 });
        expect(harness.tracker.handlerCalls).toBe(1);
        expect(harness.tracker.domainCalls).toBe(failure === 'projection' ? 0 : 1);
        expect(harness.tracker.domainTransactionStates).toEqual(failure === 'projection' ? [] : [true]);
        expect(serializedPersistentRows(harness.sqlite)).not.toContain(`idempotency-secret-${failure}`);
      } finally {
        harness.sqlite.close();
      }
    }
  });

  test('a short-audit failure suppresses replay and rolls back only the attempted audit', async () => {
    const harness = await createHarness();
    try {
      const first = await harness.executor.execute(await buildInvocation(harness, {}));
      const children = harness.sqlite.query<{ readonly contribution_json: string }, []>(
        'SELECT contribution_json FROM foundation_trial_operation_receipt_children ORDER BY ordinal'
      ).all();
      harness.faults.shortAudit = true;
      await expect(harness.executor.execute(await buildInvocation(harness, {
        correlationId: correlationIds[1]
      }))).rejects.toMatchObject({ phase: 'operation_audit' });
      expect(first.kind).toBe('success');
      expect(databaseCounts(harness.sqlite)).toEqual({
        claims: 0, receipts: 1, children: 1, audits: 1, notes: 1
      });
      expect(harness.sqlite.query<{ readonly contribution_json: string }, []>(
        'SELECT contribution_json FROM foundation_trial_operation_receipt_children ORDER BY ordinal'
      ).all()).toEqual(children);
    } finally {
      harness.sqlite.close();
    }
  });
});
