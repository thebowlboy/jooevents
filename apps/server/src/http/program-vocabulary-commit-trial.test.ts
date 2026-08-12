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
  createEffectfulOperationResultSchema,
  programVocabularyChangeResultSchema,
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
  SQLiteProgramVocabularyTrialStore,
  installProgramVocabularyTrialSchema,
} from '@jooevents/persistence/testing/program-vocabulary-trial';
import {
  SQLiteProgramVocabularyReviewedCommitTrialAdapter,
  installProgramVocabularyReviewedCommitTrialSchema,
  stageProgramVocabularyReviewedCreateTrial,
  type ProgramVocabularyReviewedCommitTrialControl,
  type ProgramVocabularyReviewedCommitTrialFailurePoint,
  type ProgramVocabularyReviewedCommitTrialRequest
} from '@jooevents/persistence/testing/program-vocabulary-reviewed-commit-trial';
import {
  SQLiteTrialEffectUnitOfWorkPort,
  installFoundationTrialUnitOfWorkSchema
} from '@jooevents/persistence/testing/foundation-trial-uow';
import {
  createProgramReferenceContributorRegistry,
  createProgramVocabularyChangesetBundle
} from '@jooevents/program';
import { z } from 'zod';
import { createHttpApp } from './app';
import { createOperatorEffectHttpAdapter } from './effect-operation-adapter';

const operationName = 'program.vocabulary.commit_reviewed_http_trial';
const routePath = '/api/test/program-vocabulary/reviewed-http-commits';
const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-0123456789a1');
const eventId = parseEventId('018f7d5a-4b3c-7abc-8def-0123456789a2');
const userId = parseUserId('018f7d5a-4b3c-7abc-8def-0123456789a3');
const membershipId = parseMembershipId('018f7d5a-4b3c-7abc-8def-0123456789a4');
const roomId = '018f7d5a-4b3c-7abc-8def-0123456789b1';
const changesetId = '018f7d5a-4b3c-7abc-8def-0123456789c1';
const revisionId = '018f7d5a-4b3c-7abc-8def-0123456789c2';
const receiptId = '018f7d5a-4b3c-7abc-8def-0123456789d1';
const rawIdempotencyKey = 'browser-reviewed-commit-secret';
const correlationId = '018f7d5a-4b3c-7abc-8def-012345678901';
const now = parseInstant('2026-08-11T06:00:00.000Z');
const scope = { workspaceId, eventId } as const;
const invocationIds = [
  '018f7d5a-4b3c-7abc-8def-012345679001',
  '018f7d5a-4b3c-7abc-8def-012345679002',
  '018f7d5a-4b3c-7abc-8def-012345679003',
  '018f7d5a-4b3c-7abc-8def-012345679004',
  '018f7d5a-4b3c-7abc-8def-012345679005'
] as const;

function definitionRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

function schemaRef(key: string, digit: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: digit.repeat(64) };
}

const refs = {
  input: schemaRef('schema.program_reviewed_http_trial.input', '1'),
  contribution: schemaRef('schema.program_reviewed_http_trial.contribution', '2'),
  canonical: schemaRef('schema.program_reviewed_http_trial.canonical', '3'),
  projected: schemaRef('schema.program_reviewed_http_trial.operator_result', '4'),
  nullDetail: schemaRef('schema.program_reviewed_http_trial.null_detail', '5'),
  context: definitionRef('context.program_reviewed_http_trial'),
  capability: definitionRef('capability.program_reviewed_http_trial'),
  handler: definitionRef('handler.program_reviewed_http_trial'),
  projection: definitionRef('projection.program_reviewed_http_trial'),
  autonomy: definitionRef('autonomy.program_reviewed_http_trial'),
  keySource: definitionRef('idempotency.operator_header'),
  requestHash: definitionRef('request_hash.program_reviewed_http_trial'),
  concurrency: definitionRef('concurrency.canonical_changeset_commit'),
  audit: definitionRef('audit.program-vocabulary-reviewed-commit.trial'),
  auditRecordProfile: definitionRef('audit-record.canonical-json')
} as const;
const profile = { key: 'program_reviewed_http_trial.hmac', version: parseContractVersion(1) } as const;
const operatorLane: OperationAccessLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.operator.current', version: 1 }
});

const applicationIdSchema = z.string().length(36);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.strictObject({
  changesetId: applicationIdSchema,
  expectedHeadVersion: z.number().int().positive(),
  expectedRevisionDigest: digestSchema
});
const resultDataSchema = z.strictObject({
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigest: digestSchema,
  action: z.literal('create'),
  itemKind: z.literal('room'),
  affectedIds: z.array(applicationIdSchema).length(1),
  setVersion: z.number().int().positive()
});
const canonicalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: resultDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const factChildSchema = z.strictObject({
  kind: z.literal('domain_fact'),
  factId: z.string().min(1),
  factKind: z.literal('program_vocabulary_changed'),
  factVersion: z.literal(1),
  payload: programVocabularyChangeResultSchema
});
const outboxChildSchema = z.strictObject({
  kind: z.literal('outbox_pointer'),
  pointerId: z.string().min(1),
  sourceKind: z.literal('domain_fact'),
  factId: z.string().min(1)
});
const timelineChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: z.string().min(1),
  sourceKind: z.literal('domain_fact'),
  factId: z.string().min(1),
  occurredAtMs: z.number().int().nonnegative()
});
const contributionSchema = z.strictObject({
  result: canonicalSchema,
  domain: z.strictObject({
    kind: z.literal('program_vocabulary_reviewed_commit_trial'),
    preparationHandle: z.string().min(1),
    expectedResultDigest: digestSchema
  }),
  receiptChildren: z.tuple([
    factChildSchema,
    outboxChildSchema,
    timelineChildSchema
  ])
});
const projectedSchema = createEffectfulOperationResultSchema(resultDataSchema);

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
    resolutionEvidenceIds: ['program-reviewed-http-trial-event:v1']
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

const proposedCounts = {
  claims: 0,
  receipts: 0,
  genericChildren: 0,
  heads: 1,
  revisions: 1,
  links: 0,
  audits: 0,
  facts: 0,
  pointers: 0,
  timeline: 0,
  rooms: 0
} as const;
const committedCounts = {
  claims: 0,
  receipts: 1,
  genericChildren: 3,
  heads: 1,
  revisions: 1,
  links: 1,
  audits: 1,
  facts: 1,
  pointers: 1,
  timeline: 1,
  rooms: 1
} as const;

interface Harness {
  readonly sqlite: Database;
  readonly control: ProgramVocabularyReviewedCommitTrialControl;
  readonly adapter: SQLiteProgramVocabularyReviewedCommitTrialAdapter;
  readonly http: ReturnType<typeof createOperatorEffectHttpAdapter>;
  readonly request: ProgramVocabularyReviewedCommitTrialRequest;
  readonly staged: Awaited<ReturnType<typeof stageProgramVocabularyReviewedCreateTrial>>;
  readonly tracker: {
    protocolChecks: number;
    authorityChecks: number;
    readonly verifiedSessions: string[];
  };
}

async function harness(failAt?: ProgramVocabularyReviewedCommitTrialFailurePoint): Promise<Harness> {
  const sqlite = new Database(':memory:', { strict: true });
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installProgramVocabularyTrialSchema(sqlite);
  installProgramVocabularyReviewedCommitTrialSchema(sqlite);
  sqlite.query<never, [string, string, number]>(`
    INSERT INTO program_vocabulary_trial_sets (workspace_id, event_id, set_version)
    VALUES (?, ?, ?)
  `).run(workspaceId, eventId, 1);

  const referenceRegistry = createProgramReferenceContributorRegistry({ expected: [], contributors: [] });
  const store = new SQLiteProgramVocabularyTrialStore(sqlite, referenceRegistry);
  const changesets = createProgramVocabularyChangesetBundle({
    referenceRegistry,
    policy: {
      activation: 'test_only',
      key: 'program_vocabulary.reviewed_http_commit_trial',
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

  const tracker = { protocolChecks: 0, authorityChecks: 0, verifiedSessions: [] as string[] };
  let nextInvocation = 0;
  const authorityResolver: CurrentAuthorityResolver<InvocationEvidence> = {
    resolve(input) {
      tracker.authorityChecks += 1;
      if (input.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
      if (input.evidence.sessionHandle === 'operator-session-revoked') return { kind: 'denied', reason: 'revoked' };
      if (input.evidence.sessionHandle !== 'operator-session-current') return { kind: 'denied', reason: 'missing' };
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
    requestHashSealer: createHmacRequestHashSealer({
      profile: refs.requestHash,
      keyBytes: new Uint8Array(32).fill(0x36)
    }),
    idempotencyCredentialProfile: profile,
    deniedAuthorityOutcome: deniedOutcome,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHmac('sha256', 'program-reviewed-http-trial-idempotency-v1')
            .update(raw)
            .digest('hex')
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
      { reference: refs.input, schema: requestSchema },
      { reference: refs.contribution, schema: contributionSchema },
      { reference: refs.canonical, schema: canonicalSchema },
      { reference: refs.projected, schema: projectedSchema },
      { reference: refs.nullDetail, schema: z.null() }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
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
    effectHandlers: [createReviewedChangesetCommitHandler({
      reference: refs.handler,
      handlerCapability: refs.capability,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical
    })],
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
      summary: 'Commit one test-only reviewed Program Vocabulary change through HTTP.',
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
        path: routePath,
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
  const builder = createEffectInvocationBuilder(registry);
  const executor = createEffectOperationExecutor({ registry, unitOfWork, newReceiptId: () => receiptId });
  const http = createOperatorEffectHttpAdapter({
    registry,
    builder,
    executor,
    evidence: {
      verify: ({ request: protocolRequest }) => {
        tracker.protocolChecks += 1;
        const sessionHandle = protocolRequest.headers.get('x-test-session');
        if (sessionHandle === null) return { kind: 'rejected', reason: 'unauthenticated' };
        tracker.verifiedSessions.push(sessionHandle);
        return {
          kind: 'verified',
          evidence: {
            kind: 'operator',
            surface: 'operator_http',
            client: { key: 'web.program-reviewed-http-trial' },
            sessionHandle
          }
        };
      }
    }
  });
  return { sqlite, control, adapter, http, request, staged, tracker };
}

function trustedHeaders(
  session = 'operator-session-current',
  idempotencyKey = rawIdempotencyKey
): HeadersInit {
  return {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    'x-test-session': session,
    'x-correlation-id': correlationId
  };
}

function post(target: Harness, body: unknown, headers: HeadersInit = trustedHeaders()) {
  return target.http.request(routePath, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

function evidenceText(sqlite: Database): string {
  return sqlite.query<{ readonly text: string | null }, []>(`
    SELECT group_concat(value, '|') AS text FROM (
      SELECT idempotency_key_verifier AS value FROM foundation_trial_operation_receipts
      UNION ALL SELECT request_hash FROM foundation_trial_operation_receipts
      UNION ALL SELECT result_json FROM foundation_trial_operation_receipts
      UNION ALL SELECT contribution_json FROM foundation_trial_operation_receipt_children
      UNION ALL SELECT record_json FROM foundation_trial_operation_audits
      UNION ALL SELECT payload_json FROM program_vocabulary_reviewed_trial_domain_facts
    )
  `).get()?.text ?? '';
}

describe('disposable Program Vocabulary reviewed commit HTTP composition', () => {
  test('verified current authority commits the reviewed create with exact parent and evidence order', async () => {
    const target = await harness();
    try {
      expect(target.staged.safeDiff).toMatchObject({
        action: 'create',
        before: null,
        after: { kind: 'room', id: roomId, name: 'Breakout room', capacity: 40 }
      });
      const response = await post(target, target.request);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-correlation-id')).toBe(correlationId);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toMatchObject({
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
        correlationId
      });
      expect(target.tracker.verifiedSessions).toEqual(['operator-session-current']);
      expect(target.tracker.authorityChecks).toBe(1);
      expect(target.adapter.trace).toEqual([
        'snapshot', 'prepare', 'domain', 'parent', 'audit',
        'fact', 'outbox', 'timeline', 'claim_release', 'commit'
      ]);
      expect(durableCounts(target.sqlite)).toEqual(committedCounts);
      expect(target.sqlite.query<{ readonly status: string; readonly committed_receipt_id: string }, []>(`
        SELECT status, committed_receipt_id
          FROM program_vocabulary_reviewed_trial_changeset_heads
      `).get()).toEqual({ status: 'committed', committed_receipt_id: receiptId });
      expect(target.sqlite.query<{ readonly ordinal: number; readonly kind: string }, []>(`
        SELECT ordinal, json_extract(contribution_json, '$.kind') AS kind
          FROM foundation_trial_operation_receipt_children
         ORDER BY ordinal
      `).all()).toEqual([
        { ordinal: 0, kind: 'domain_fact' },
        { ordinal: 1, kind: 'outbox_pointer' },
        { ordinal: 2, kind: 'timeline' }
      ]);
      expect(target.sqlite.query<{ readonly fact_id: string; readonly joined_fact: string }, []>(`
        SELECT pointer.fact_id, fact.fact_id AS joined_fact
          FROM program_vocabulary_reviewed_trial_outbox_pointers AS pointer
          JOIN program_vocabulary_reviewed_trial_domain_facts AS fact
            ON fact.fact_id = pointer.fact_id AND fact.receipt_id = pointer.receipt_id
      `).get()).toEqual({ fact_id: `${revisionId}:fact`, joined_fact: `${revisionId}:fact` });
      expect(evidenceText(target.sqlite)).not.toContain(rawIdempotencyKey);
      expect(evidenceText(target.sqlite)).not.toContain('Breakout room');
      expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });

  test('response loss replays one durable commit and changed request bytes conflict without detail', async () => {
    const target = await harness('after_commit_response_loss');
    try {
      const lost = await post(target, target.request);
      expect(lost.status).toBe(500);
      expect(await lost.json()).toEqual({
        kind: 'transport_error', code: 'internal_error', retryable: false, correlationId
      });
      expect(durableCounts(target.sqlite)).toEqual(committedCounts);
      const traceAfterLoss = [...target.adapter.trace];
      target.control.failAt = undefined;

      const replay = await post(target, target.request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        kind: 'success',
        receipt: { id: receiptId },
        correlationId
      });
      expect(target.adapter.trace).toEqual(traceAfterLoss);
      expect(durableCounts(target.sqlite)).toEqual({ ...committedCounts, audits: 2 });

      const changed = await post(target, {
        ...target.request,
        expectedRevisionDigest: 'f'.repeat(64)
      });
      expect(changed.status).toBe(200);
      const conflict = await changed.json();
      expect(conflict).toEqual({
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
        correlationId
      });
      expect(JSON.stringify(conflict)).not.toContain(changesetId);
      expect(JSON.stringify(conflict)).not.toContain(target.staged.revision.digest);
      expect(target.adapter.trace).toEqual(traceAfterLoss);
      expect(durableCounts(target.sqlite)).toEqual({ ...committedCounts, audits: 3 });
    } finally {
      target.sqlite.close();
    }
  });

  test('caller claims and transport ceremony fail before SQL, and current authority can still deny', async () => {
    const target = await harness();
    try {
      const invalidMedia = await target.http.request(routePath, {
        method: 'POST',
        headers: { ...trustedHeaders(), 'content-type': 'text/plain' },
        body: JSON.stringify(target.request)
      });
      expect(invalidMedia.status).toBe(400);
      expect(target.tracker.protocolChecks).toBe(0);

      const invalidJson = await target.http.request(routePath, {
        method: 'POST', headers: trustedHeaders(), body: '{not-json'
      });
      expect(invalidJson.status).toBe(400);

      const duplicateHeaders = new Headers(trustedHeaders());
      duplicateHeaders.append('idempotency-key', 'second-browser-secret');
      const duplicateKey = await target.http.request(routePath, {
        method: 'POST',
        headers: duplicateHeaders,
        body: JSON.stringify(target.request)
      });
      expect(duplicateKey.status).toBe(400);
      expect(JSON.stringify(await duplicateKey.json())).not.toContain('second-browser-secret');

      for (const field of ['actor', 'scope', 'approval'] as const) {
        const response = await post(target, { ...target.request, [field]: 'caller-selected' });
        expect(response.status).toBe(400);
      }
      expect(target.tracker.authorityChecks).toBe(0);
      expect(durableCounts(target.sqlite)).toEqual(proposedCounts);
      expect(target.adapter.trace).toEqual([]);

      const denied = await post(target, target.request, trustedHeaders('operator-session-revoked'));
      expect(denied.status).toBe(200);
      expect(await denied.json()).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'access_denied', kind: 'authority.revoked', detail: null },
        terminal: false,
        correlationId
      });
      expect(target.tracker.authorityChecks).toBe(1);
      expect(durableCounts(target.sqlite)).toEqual({ ...proposedCounts, audits: 1 });
      expect(target.adapter.trace).toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });

  test('a pre-commit evidence failpoint returns safely and rolls back the whole commit', async () => {
    const target = await harness('after_fact');
    try {
      const response = await post(target, target.request);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        kind: 'transport_error', code: 'internal_error', retryable: false, correlationId
      });
      expect(JSON.stringify(body)).not.toContain('injected_program_vocabulary');
      expect(JSON.stringify(body)).not.toContain('Breakout room');
      expect(target.adapter.trace).toEqual(['snapshot', 'prepare', 'domain', 'parent', 'audit', 'fact']);
      expect(durableCounts(target.sqlite)).toEqual(proposedCounts);
      expect(target.sqlite.query<{ readonly status: string; readonly committed_receipt_id: string | null }, []>(`
        SELECT status, committed_receipt_id
          FROM program_vocabulary_reviewed_trial_changeset_heads
      `).get()).toEqual({ status: 'proposed', committed_receipt_id: null });
      expect(target.sqlite.query<unknown, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });

  test('the production HTTP app does not mount the reviewed commit trial route', async () => {
    const production = createHttpApp({
      auth: { handler: () => new Response(null, { status: 401 }), api: {} } as never,
      accessContext: { ensureAuthPrincipalProvisioned: () => { throw new Error('not reached'); } },
      workspaceId: 'workspace-test',
      baseUrl: 'http://localhost:5176'
    });
    const response = await production.request(routePath, {
      method: 'POST',
      headers: trustedHeaders(),
      body: JSON.stringify({})
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'route_not_found', retryable: false });
  });
});
