import { createHmac } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createEffectInvocationBuilder,
  createEffectInvocationContextBuilder,
  createEffectOperationExecutor,
  createHmacRequestHashSealer,
  createOperationAutonomyPolicy,
  createOperationRegistry,
  createReviewedChangesetCommitHandler,
  createSingleUnitOfWorkConformanceFixture,
  type InvocationEvidence,
  type OperationRegistrySource
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
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type ResolvedScope
} from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  createProgramVocabularyChangesetBundle,
  createProgramVocabularyState,
  resolveProgramVocabularyItem
} from '@jooevents/program';
import {
  SQLiteTrialEffectUnitOfWorkPort,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import {
  SQLiteProgramVocabularyReviewedCommitTrialAdapter,
  installProgramVocabularyReviewedCommitTrialSchema,
  stageProgramVocabularyReviewedCreateTrial,
  type ProgramVocabularyReviewedCommitTrialControl,
  type ProgramVocabularyReviewedCommitTrialFailurePoint,
  type ProgramVocabularyReviewedCommitTrialRequest
} from './program-vocabulary-reviewed-commit-trial';
import {
  SQLiteProgramVocabularyTrialStore,
  installProgramVocabularyTrialSchema
} from './program-vocabulary-trial';
import { seedProgramVocabularyTrialStateForTest } from './program-vocabulary-trial-fixtures';

const operationName = 'program.vocabulary.commit_reviewed_trial';
const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-0123456789a1');
const eventId = parseEventId('018f7d5a-4b3c-7abc-8def-0123456789a2');
const userId = parseUserId('018f7d5a-4b3c-7abc-8def-0123456789a3');
const membershipId = parseMembershipId('018f7d5a-4b3c-7abc-8def-0123456789a4');
const roomId = '018f7d5a-4b3c-7abc-8def-0123456789b1';
const changesetId = '018f7d5a-4b3c-7abc-8def-0123456789c1';
const revisionId = '018f7d5a-4b3c-7abc-8def-0123456789c2';
const receiptId = '018f7d5a-4b3c-7abc-8def-0123456789d1';
const rawIdempotencyKey = 'browser-action-secret-1';
const now = parseInstant('2026-08-11T06:00:00.000Z');
const scope = { workspaceId, eventId } as const;

const correlationIds = [
  '018f7d5a-4b3c-7abc-8def-012345678901',
  '018f7d5a-4b3c-7abc-8def-012345678902',
  '018f7d5a-4b3c-7abc-8def-012345678903',
  '018f7d5a-4b3c-7abc-8def-012345678904'
] as const;
const invocationIds = [
  '018f7d5a-4b3c-7abc-8def-012345679001',
  '018f7d5a-4b3c-7abc-8def-012345679002',
  '018f7d5a-4b3c-7abc-8def-012345679003',
  '018f7d5a-4b3c-7abc-8def-012345679004'
] as const;

function definitionRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

function schemaRef(key: string, digit: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: digit.repeat(64) };
}

const refs = {
  input: schemaRef('schema.program_reviewed_trial.input', '1'),
  contribution: schemaRef('schema.program_reviewed_trial.contribution', '2'),
  canonical: schemaRef('schema.program_reviewed_trial.canonical', '3'),
  projected: schemaRef('schema.program_reviewed_trial.operator_result', '4'),
  nullDetail: schemaRef('schema.program_reviewed_trial.null_detail', '5'),
  context: definitionRef('context.program_reviewed_trial'),
  capability: definitionRef('capability.program_reviewed_trial'),
  handler: definitionRef('handler.program_reviewed_trial'),
  projection: definitionRef('projection.program_reviewed_trial'),
  autonomy: definitionRef('autonomy.program_reviewed_trial'),
  keySource: definitionRef('idempotency.operator_header'),
  requestHash: definitionRef('request_hash.program_reviewed_trial'),
  concurrency: definitionRef('concurrency.canonical_changeset_commit'),
  audit: definitionRef('audit.program-vocabulary-reviewed-commit.trial'),
  auditRecordProfile: definitionRef('audit-record.canonical-json')
} as const;
const profile = { key: 'program_reviewed_trial.hmac', version: parseContractVersion(1) } as const;
const operatorLane: OperationAccessLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.operator.current', version: 1 }
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRequest(value: unknown): value is ProgramVocabularyReviewedCommitTrialRequest {
  return isPlainRecord(value)
    && exactKeys(value, ['changesetId', 'expectedHeadVersion', 'expectedRevisionDigest'])
    && typeof value.changesetId === 'string'
    && value.changesetId.length === 36
    && Number.isSafeInteger(value.expectedHeadVersion)
    && (value.expectedHeadVersion as number) > 0
    && typeof value.expectedRevisionDigest === 'string'
    && /^[a-f0-9]{64}$/.test(value.expectedRevisionDigest);
}

function isCanonicalResult(value: unknown): boolean {
  if (!isPlainRecord(value) || !exactKeys(value, ['kind', value.kind === 'success' ? 'data' : 'outcome'])) return false;
  if (value.kind === 'outcome') return structuredOutcomeSchema.safeParse(value.outcome).success;
  if (value.kind !== 'success' || !isPlainRecord(value.data)) return false;
  return exactKeys(value.data, [
    'changesetId', 'revisionId', 'revisionDigest', 'action',
    'itemKind', 'affectedIds', 'setVersion'
  ])
    && value.data.action === 'create'
    && value.data.itemKind === 'room'
    && Array.isArray(value.data.affectedIds)
    && value.data.affectedIds.length === 1;
}

function isEvidenceChild(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  return ['domain_fact', 'outbox_pointer', 'timeline'].includes(value.kind);
}

function isContribution(value: unknown): boolean {
  return isPlainRecord(value)
    && exactKeys(value, ['result', 'domain', 'receiptChildren'])
    && isCanonicalResult(value.result)
    && isPlainRecord(value.domain)
    && exactKeys(value.domain, ['kind', 'preparationHandle', 'expectedResultDigest'])
    && value.domain.kind === 'program_vocabulary_reviewed_commit_trial'
    && typeof value.domain.preparationHandle === 'string'
    && typeof value.domain.expectedResultDigest === 'string'
    && Array.isArray(value.receiptChildren)
    && value.receiptChildren.length === 3
    && value.receiptChildren.every(isEvidenceChild);
}

const jsonSchema = structuredOutcomeSchema.shape.detail;
const inputSchema = jsonSchema.refine(isRequest);
const canonicalSchema = jsonSchema.refine(isCanonicalResult);
const contributionSchema = jsonSchema.refine(isContribution);
const nullDetailSchema = jsonSchema.refine((value) => value === null);

function deniedOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return {
    class: 'access_denied',
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  };
}

function resolvedScope(): ResolvedScope {
  return {
    workspaceId,
    eventId,
    subjects: [{ kind: 'event', id: eventId }],
    resolutionEvidenceIds: ['program-reviewed-trial-event:v1']
  };
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? -1;
}

function durableCounts(sqlite: Database) {
  return {
    claims: count(sqlite, 'foundation_trial_operation_execution_claims'),
    receipts: count(sqlite, 'foundation_trial_operation_receipts'),
    genericChildren: count(sqlite, 'foundation_trial_operation_receipt_children'),
    heads: count(sqlite, 'program_vocabulary_reviewed_trial_changeset_heads'),
    revisions: count(sqlite, 'program_vocabulary_reviewed_trial_changeset_revisions'),
    links: count(sqlite, 'program_vocabulary_reviewed_trial_commit_links'),
    audits: count(sqlite, 'foundation_trial_operation_audits'),
    facts: count(sqlite, 'program_vocabulary_reviewed_trial_domain_facts'),
    pointers: count(sqlite, 'program_vocabulary_reviewed_trial_outbox_pointers'),
    timeline: count(sqlite, 'program_vocabulary_reviewed_trial_timeline_projection'),
    rooms: count(sqlite, 'program_vocabulary_trial_rooms')
  };
}

interface Harness {
  readonly sqlite: Database;
  readonly control: ProgramVocabularyReviewedCommitTrialControl;
  readonly revoked: { value: boolean };
  readonly adapter: SQLiteProgramVocabularyReviewedCommitTrialAdapter;
  readonly builder: ReturnType<typeof createEffectInvocationBuilder>;
  readonly executor: ReturnType<typeof createEffectOperationExecutor>;
  readonly request: ProgramVocabularyReviewedCommitTrialRequest;
  readonly staged: Awaited<ReturnType<typeof stageProgramVocabularyReviewedCreateTrial>>;
}

async function harness(failAt?: ProgramVocabularyReviewedCommitTrialFailurePoint): Promise<Harness> {
  const sqlite = new Database(':memory:', { strict: true });
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installProgramVocabularyTrialSchema(sqlite);
  installProgramVocabularyReviewedCommitTrialSchema(sqlite);
  seedProgramVocabularyTrialStateForTest(sqlite, createProgramVocabularyState({ scope, setVersion: 1 }));
  const referenceRegistry = createProgramReferenceContributorRegistry({ expected: [], contributors: [] });
  const store = new SQLiteProgramVocabularyTrialStore(sqlite, referenceRegistry);
  const changesets = createProgramVocabularyChangesetBundle({
    referenceRegistry,
    policy: {
      activation: 'test_only',
      key: 'program_vocabulary.reviewed_commit_trial',
      version: 1,
      ordinaryRisk: 'low',
      mergeRisk: 'consequential'
    }
  });
  const staged = await stageProgramVocabularyReviewedCreateTrial({
    sqlite,
    store,
    registry: changesets.registry,
    authorInput: {
      action: 'create',
      scope,
      expectedSetVersion: 1,
      item: { kind: 'room', id: roomId, name: 'Breakout room', capacity: 40 }
    },
    changesetId,
    revisionId,
    createdAt: '2026-08-11T05:55:00.000Z',
    proposerPrincipalKey: 'trial-proposer'
  });
  const request: ProgramVocabularyReviewedCommitTrialRequest = {
    changesetId,
    expectedHeadVersion: staged.head.version,
    expectedRevisionDigest: staged.revision.digest
  };

  const revoked = { value: false };
  let nextInvocation = 0;
  const authorityResolver: CurrentAuthorityResolver<InvocationEvidence> = {
    resolve(input) {
      if (input.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
      if (revoked.value) return { kind: 'denied', reason: 'revoked' };
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId, membershipId },
          lane: input.lane,
          scope: input.scope,
          grants: [{ kind: 'permission', key: 'program.vocabulary.manage' }],
          evidenceIds: [`membership-current:${membershipId}`],
          authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const contextBuilder = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: { name: operationName, version: 1 },
    effect: 'commit',
    lanes: [operatorLane],
    scopeResolver: { resolve: () => resolvedScope() },
    authorityResolver,
    clock: { now: () => now },
    newInvocationId: () => parseInvocationId(invocationIds[nextInvocation++] ?? crypto.randomUUID()),
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashProfile: refs.requestHash,
    requestHashSealer: createHmacRequestHashSealer({ profile: refs.requestHash, keyBytes: new Uint8Array(32).fill(0x37) }),
    idempotencyCredentialProfile: profile,
    deniedAuthorityOutcome: deniedOutcome,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHmac('sha256', 'program-reviewed-trial-idempotency-v1').update(raw).digest('hex')
        };
      }
    }
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: { name: operationName, version: 1 },
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
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
  const handler = createReviewedChangesetCommitHandler({
    reference: refs.handler,
    handlerCapability: refs.capability,
    contributionSchema: refs.contribution,
    canonicalResultSchema: refs.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: refs.nullDetail
  }));
  const phaseControl = createSingleUnitOfWorkConformanceFixture({
    operation: { name: operationName, version: 1, effect: 'commit' },
    maximumRisk: 'low',
    consequenceTags: ['program_vocabulary_changed'],
    autonomyPolicy: autonomy,
    handler: refs.handler,
    handlerCapability: refs.capability,
    contributionSchema: refs.contribution,
    nullDetailSchema: refs.nullDetail
  });
  const source: OperationRegistrySource = {
    ...phaseControl.registrations,
    autonomyPolicies: [autonomy],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.contribution, schema: contributionSchema },
      { reference: refs.canonical, schema: canonicalSchema },
      { reference: refs.projected, schema: effectfulOperationResultSchema },
      { reference: refs.nullDetail, schema: nullDetailSchema }
    ],
    contextBuilders: [], readCapabilities: [], handlers: [], operations: [],
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
    effectHandlers: [handler],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project: (candidate) => canonicalSchema.parse(candidate)
    }],
    effectOperations: [{
      name: operationName,
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Commit one test-only reviewed Program Vocabulary change.',
      effect: 'commit',
      maxRisk: 'low',
      autonomyPolicy: refs.autonomy,
      consequenceTags: ['program_vocabulary_changed'],
      inputSchema: refs.input,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical,
      outcomes: [{
        class: 'idempotency_conflict',
        kind: 'operation.request_changed',
        retryable: false,
        detailSchema: refs.nullDetail
      }, ...accessOutcomes, phaseControl.contentionOutcomeDeclaration, ...phaseControl.outcomeDeclarations],
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
        path: '/api/test/program-vocabulary/reviewed-commits',
        input: 'body',
        browserResumption: { kind: 'none' },
        projection: refs.projection
      }]
    }]
  };
  const registry = await createOperationRegistry(source);
  const control: ProgramVocabularyReviewedCommitTrialControl = { failAt };
  const adapter = new SQLiteProgramVocabularyReviewedCommitTrialAdapter(
    sqlite,
    store,
    changesets.registry,
    refs.capability,
    control,
    () => '018f7d5a-4b3c-7abc-8def-0123456789e1'
  );
  const unitOfWork = new SQLiteTrialEffectUnitOfWorkPort(sqlite, adapter, {
    afterTerminalAuditInserted: (record) => adapter.afterTerminalAuditInserted(record)
  });
  return {
    sqlite,
    control,
    revoked,
    adapter,
    builder: createEffectInvocationBuilder(registry),
    executor: createEffectOperationExecutor({ registry, unitOfWork, newReceiptId: () => receiptId }),
    request,
    staged
  };
}

function evidence(): InvocationEvidence {
  return {
    kind: 'operator',
    surface: 'operator_http',
    client: { key: 'program_reviewed_trial_browser' },
    sessionHandle: 'operator-session-current'
  };
}

async function execute(
  target: Harness,
  input: ProgramVocabularyReviewedCommitTrialRequest = target.request,
  key: string = rawIdempotencyKey,
  correlationIndex = 0
) {
  const invocation = await target.builder.build({
    operationName,
    operationVersion: 1,
    surface: 'operator_http',
    correlationId: correlationIds[correlationIndex] ?? crypto.randomUUID(),
    businessInput: input,
    verifiedEvidence: evidence(),
    rawIdempotencyKey: key
  });
  return target.executor.execute(invocation);
}

describe('reviewed Program Vocabulary create through the Foundation trial UnitOfWork', () => {
  test('commits the exact reviewed create with one receipt and fact-backed evidence, then replays without writes', async () => {
    const target = await harness();
    try {
      expect(target.staged.safeDiff).toMatchObject({
        action: 'create',
        before: null,
        after: { kind: 'room', id: roomId, name: 'Breakout room', capacity: 40 }
      });
      const first = await execute(target);
      expect(first).toMatchObject({
        kind: 'success',
        data: {
          changesetId,
          revisionId,
          revisionDigest: target.staged.revision.digest,
          action: 'create',
          itemKind: 'room',
          affectedIds: [roomId],
          setVersion: 2
        },
        receipt: { id: receiptId, operationName, operationVersion: 1 },
        correlationId: correlationIds[0]
      });
      expect(target.adapter.trace).toEqual([
        'snapshot', 'prepare', 'domain', 'parent', 'audit',
        'fact', 'outbox', 'timeline', 'claim_release', 'commit'
      ]);
      expect(durableCounts(target.sqlite)).toEqual({
        claims: 0, receipts: 1, genericChildren: 3, heads: 1, revisions: 1,
        links: 1, audits: 1, facts: 1, pointers: 1, timeline: 1, rooms: 1
      });
      expect(target.sqlite.query<{ status: string; committed_receipt_id: string }, []>(`
        SELECT status, committed_receipt_id
          FROM program_vocabulary_reviewed_trial_changeset_heads
      `).get()).toEqual({ status: 'committed', committed_receipt_id: receiptId });
      expect(target.sqlite.query<{ source_kind: string; fact_id: string; joined_fact: string }, []>(`
        SELECT pointer.source_kind, pointer.fact_id, fact.fact_id AS joined_fact
          FROM program_vocabulary_reviewed_trial_outbox_pointers AS pointer
          JOIN program_vocabulary_reviewed_trial_domain_facts AS fact
            ON fact.fact_id = pointer.fact_id AND fact.receipt_id = pointer.receipt_id
      `).get()).toEqual({
        source_kind: 'domain_fact',
        fact_id: `${revisionId}:fact`,
        joined_fact: `${revisionId}:fact`
      });
      const evidenceText = target.sqlite.query<{ text: string }, []>(`
        SELECT group_concat(value, '|') AS text FROM (
          SELECT payload_json AS value FROM program_vocabulary_reviewed_trial_domain_facts
          UNION ALL SELECT contribution_json FROM foundation_trial_operation_receipt_children
          UNION ALL SELECT result_json FROM foundation_trial_operation_receipts
        )
      `).get()?.text ?? '';
      expect(evidenceText).not.toContain('Breakout room');
      expect(evidenceText).not.toContain(rawIdempotencyKey);
      expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);

      const traceBeforeReplay = [...target.adapter.trace];
      const replay = await execute(target, target.request, rawIdempotencyKey, 1);
      expect(replay).toEqual(first);
      expect(target.adapter.trace).toEqual(traceBeforeReplay);
      expect(durableCounts(target.sqlite)).toEqual({
        claims: 0, receipts: 1, genericChildren: 3, heads: 1, revisions: 1,
        links: 1, audits: 2, facts: 1, pointers: 1, timeline: 1, rooms: 1
      });

      const changed = await execute(target, {
        ...target.request,
        expectedRevisionDigest: 'f'.repeat(64)
      }, rawIdempotencyKey, 2);
      expect(changed).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed', detail: null }
      });
      expect(JSON.stringify(changed)).not.toContain(receiptId);
      expect(JSON.stringify(changed)).not.toContain(changesetId);
      expect(JSON.stringify(changed)).not.toContain(target.staged.revision.digest);
      expect(target.adapter.trace).toEqual(traceBeforeReplay);

      target.revoked.value = true;
      const denied = await execute(target, target.request, rawIdempotencyKey, 3);
      expect(denied).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(target.adapter.trace).toEqual(traceBeforeReplay);
      expect(target.sqlite.query<{
        readonly disposition: string;
        readonly receipt_id: string | null;
        readonly related_receipt_id: string | null;
      }, []>(`
        SELECT disposition, receipt_id, related_receipt_id
          FROM foundation_trial_operation_audits
         ORDER BY rowid
      `).all()).toEqual([
        { disposition: 'terminal_new', receipt_id: receiptId, related_receipt_id: null },
        { disposition: 'terminal_replay', receipt_id: null, related_receipt_id: receiptId },
        { disposition: 'idempotency_conflict', receipt_id: null, related_receipt_id: null },
        { disposition: 'context_denied', receipt_id: null, related_receipt_id: null }
      ]);
      expect(count(target.sqlite, 'foundation_trial_operation_receipt_children')).toBe(3);
    } finally {
      target.sqlite.close();
    }
  });

  test('a response lost after COMMIT retries to the prior terminal receipt without repeating any hook', async () => {
    const target = await harness('after_commit_response_loss');
    try {
      await expect(execute(target)).rejects.toThrow('Operation execution failed during unit_of_work');
      expect(durableCounts(target.sqlite)).toEqual({
        claims: 0, receipts: 1, genericChildren: 3, heads: 1, revisions: 1,
        links: 1, audits: 1, facts: 1, pointers: 1, timeline: 1, rooms: 1
      });
      const traceAfterLoss = [...target.adapter.trace];
      expect(traceAfterLoss).toEqual([
        'snapshot', 'prepare', 'domain', 'parent', 'audit',
        'fact', 'outbox', 'timeline', 'claim_release', 'commit'
      ]);
      target.control.failAt = undefined;
      const replay = await execute(target, target.request, rawIdempotencyKey, 1);
      expect(replay).toMatchObject({
        kind: 'success',
        receipt: { id: receiptId },
        correlationId: correlationIds[0]
      });
      expect(target.adapter.trace).toEqual(traceAfterLoss);
    } finally {
      target.sqlite.close();
    }
  });

  test('failure after every meaningful write boundary leaves the proposal intact and no partial commit', async () => {
    const failures = [
      'after_domain',
      'after_parent',
      'after_audit',
      'after_fact',
      'after_outbox',
      'after_timeline',
      'after_claim_release'
    ] as const satisfies readonly ProgramVocabularyReviewedCommitTrialFailurePoint[];

    for (const failAt of failures) {
      const target = await harness(failAt);
      try {
        await expect(execute(target)).rejects.toThrow(/Operation execution failed during/);
        expect(durableCounts(target.sqlite), failAt).toEqual({
          claims: 0, receipts: 0, genericChildren: 0, heads: 1, revisions: 1,
          links: 0, audits: 0, facts: 0, pointers: 0, timeline: 0, rooms: 0
        });
        expect(target.sqlite.query<{ status: string; head_version: number; committed_receipt_id: string | null }, []>(`
          SELECT status, head_version, committed_receipt_id
            FROM program_vocabulary_reviewed_trial_changeset_heads
        `).get(), failAt).toEqual({
          status: 'proposed',
          head_version: target.staged.head.version,
          committed_receipt_id: null
        });
        expect(resolveProgramVocabularyItem(
          new SQLiteProgramVocabularyTrialStore(
            target.sqlite,
            createProgramReferenceContributorRegistry({ expected: [], contributors: [] })
          ).readVocabulary(scope)!,
          'room',
          roomId
        ), failAt).toBeUndefined();
        expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all(), failAt).toEqual([]);

        target.control.failAt = undefined;
        await expect(execute(target, target.request, rawIdempotencyKey, 1)).resolves.toMatchObject({
          kind: 'success', receipt: { id: receiptId }
        });
      } finally {
        target.sqlite.close();
      }
    }
  });

  test('the distinct evidence families enforce immutable immediate relationships', async () => {
    const target = await harness();
    try {
      await execute(target);
      expect(() => target.sqlite.query<never, [string, string, string, string]>(`
        INSERT INTO program_vocabulary_reviewed_trial_outbox_pointers (
          pointer_id, receipt_id, fact_id, source_kind
        ) VALUES (?, ?, ?, ?)
      `).run('orphan-pointer', receiptId, 'missing-fact', 'domain_fact')).toThrow();
      expect(() => target.sqlite.exec(`
        UPDATE program_vocabulary_reviewed_trial_domain_facts
           SET payload_json = '{}'
      `)).toThrow('trial domain facts are immutable');
      expect(() => target.sqlite.exec(`
        UPDATE foundation_trial_operation_audits SET record_json = '{}'
      `)).toThrow('foundation operation audits are immutable');
      expect(() => target.sqlite.exec(`
        DELETE FROM foundation_trial_operation_audits
      `)).toThrow('foundation operation audits are immutable');
      expect(() => target.sqlite.exec(`
        DELETE FROM program_vocabulary_reviewed_trial_changeset_revisions
      `)).toThrow('trial changeset revisions are immutable');
      const timelineColumns = target.sqlite.query<{ readonly name: string }, []>(
        'PRAGMA table_info(program_vocabulary_reviewed_trial_timeline_projection)'
      ).all().map((column) => column.name);
      expect(timelineColumns).not.toContain('payload_json');
      expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });
});
