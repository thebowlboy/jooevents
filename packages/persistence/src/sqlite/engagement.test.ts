import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import {
  applyEngagementRosterInviteFrom,
  applyEngagementSeedFrom,
  applyEngagementSeedReversalFrom,
  deterministicEngagementId,
  planEngagementMutation,
  planEngagementRosterInviteFrom,
  planEngagementSeedFrom,
  planEngagementSeedReversalFrom,
  validateEngagementSeedReversalFrom,
  EngagementSeedError
} from '@jooevents/engagement';
import {
  ENGAGEMENT_CHANGE_OPERATION,
  ENGAGEMENT_MANAGE_ACCESS_POLICY,
  ENGAGEMENT_REQUEST_HASH_PROFILE,
  createEngagementDirectOperationModule,
  engagementChangeOperationResultSchema
} from '@jooevents/engagement-operations';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseIntegrationInboxReceiptId,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseSourceConnectionId,
  parseVerifierRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation
} from '@jooevents/program';
import { planSessionMutation } from '@jooevents/session';
import { installDeadlineSchema } from './deadline';
import { createSQLiteEngagementDirectEffectDomainRegistration } from './engagement-direct-effect-domain';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema,
  SQLiteEventSpineRepository
} from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import { installSessionSchema, SQLiteSessionRepository } from './session';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';
import { installTaskSchema } from './tasks';
import {
  createSQLiteEngagementSubmissionReferenceSource,
  installEngagementSchema,
  SQLiteEngagementRepository
} from './engagement';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfb101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfb201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfb202');
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfb301';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfb401';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfb501';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfb502';
const submissionA = '019c1df7-86b5-769b-bba4-5f7097bfb601';
const submissionB = '019c1df7-86b5-769b-bba4-5f7097bfb602';
const now = parseInstant('2026-08-14T08:00:00.000Z');
const later = parseInstant('2026-08-14T09:00:00.000Z');
const scope = { workspaceId, eventId };
const seededBy = Object.freeze({ version: 1, digestSha256: 'e'.repeat(64) });
const otherSeededBy = Object.freeze({ version: 1, digestSha256: 'f'.repeat(64) });
const profile = Object.freeze({ key: 'engagement-direct-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-engagement-direct-session'
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function fixture() {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
  `);
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSessionSchema(sqlite);
  installEngagementSchema(sqlite);
  installDeadlineSchema(sqlite);
  installTaskSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Operator', 1, 1, 1)
  `).run(userId);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, null)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);
  sqlite.query(`
    UPDATE event_spine_workspace_sets
       SET version = 2, current_event_id = ?
     WHERE workspace_id = ?
  `).run(eventId, workspaceId);

  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [], contributors: []
  });
  const adapterRegistry = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite, expected: [], adapters: []
  });
  const program = new SQLiteProgramVocabularyRepository(
    sqlite, referenceRegistry, adapterRegistry,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  const state = program.readVocabulary(scope)!;
  const vocabularyPlan = planProgramVocabularyMutation({
    state,
    referenceRegistry,
    referenceSource: program,
    authorInput: {
      action: 'create', scope, expectedSetVersion: state.setVersion,
      item: { kind: 'format', id: formatId, name: 'Talk' }
    }
  });
  sqlite.exec('BEGIN IMMEDIATE;');
  program.applyVocabularyPlan(vocabularyPlan);
  sqlite.exec('COMMIT;');
  const sessions = new SQLiteSessionRepository(sqlite, program);
  const catalog = sessions.readSessionCatalog(scope)!;
  const sessionPlan = planSessionMutation({
    catalog,
    vocabulary: sessions.readSessionVocabulary(scope)!,
    planningInput: {
      action: 'create', scope, sessionId, actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      title: 'Seeded Panel', plannedDurationMinutes: 60,
      lifecycle: 'collecting', formatId, trackId: null
    }
  });
  sqlite.exec('BEGIN IMMEDIATE;');
  sessions.applySessionPlan(sessionPlan);
  sqlite.exec('COMMIT;');

  const engagements = new SQLiteEngagementRepository(sqlite);
  return { sqlite, engagements };
}

function directEffect(fx: ReturnType<typeof fixture>, providerIngress = false) {
  let nextId = 0x700;
  let receiptId = 0x900;
  let correlationId = 0xa00;
  const next = () => uuid(nextId++);
  const authority: Parameters<typeof createEngagementDirectOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if ((!providerIngress && input.evidence.kind !== 'operator')
          || (providerIngress && input.evidence.kind !== 'verified_inbox')) {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      if (providerIngress && input.evidence.kind === 'verified_inbox') {
        return Object.freeze({ kind: 'authorized' as const, authority: Object.freeze({
          actor: Object.freeze({ kind: 'verified_inbox_processing' as const,
            inboxReceiptId: input.evidence.inboxReceiptId,
            sourceConnectionId: parseSourceConnectionId(uuid(0xb01)) }),
          principal: Object.freeze({ kind: 'verified_inbox_processing' as const,
            inboxReceiptId: input.evidence.inboxReceiptId,
            verifierRevisionId: parseVerifierRevisionId(uuid(0xb02)) }),
          lane: input.lane, scope: input.scope,
          grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: 'event.manage' })]),
          evidenceIds: Object.freeze(['airtable.inbox.current']), authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        }) });
      }
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: 'event.manage' })]),
          evidenceIds: Object.freeze(['engagement-membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const currentEvent = {
    resolveCurrentEvent(requestedWorkspaceId: typeof workspaceId) {
      if (requestedWorkspaceId !== workspaceId) throw new TypeError('engagement_workspace_mismatch');
      const state = new SQLiteEventSpineRepository(fx.sqlite).readCurrentEventState(workspaceId);
      if (!state) throw new TypeError('engagement_event_set_missing');
      return Object.freeze({
        ...(state.currentEvent ? { eventId: state.currentEvent.id } : {}),
        evidenceIds: Object.freeze([
          `event-spine-set:${workspaceId}@${state.eventSet.version}`,
          ...(state.currentEvent
            ? [`event-spine-root:${state.currentEvent.id}@${state.currentEvent.version}`]
            : [])
        ])
      });
    }
  };
  const module = createEngagementDirectOperationModule({
    workspaceId,
    managePolicy: ENGAGEMENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent,
    clock: { now: () => later },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: ENGAGEMENT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x73)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw: string) {
        return Object.freeze({
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`engagement-key:${raw}`).digest('hex')
        });
      }
    },
    enableVerifiedInbox: providerIngress
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    createSQLiteEngagementDirectEffectDomainRegistration({
      sqlite: fx.sqlite,
      workspaceId,
      eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource()
      , ...(providerIngress ? { verifiedInboxAttribution: { resolve: () => userId } } : {})
    })
  ]);
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(fx.sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => later
  });
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([module]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => later },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newOperationLogId: () => uuid(receiptId++)
  });
  return async (businessInput: unknown, key: string) => {
    const composed = await runtime;
    const invocation = await composed.effectBuilder.build({
      operationName: ENGAGEMENT_CHANGE_OPERATION.name,
      operationVersion: ENGAGEMENT_CHANGE_OPERATION.version,
      surface: providerIngress ? 'provider_ingress' : 'operator_http',
      correlationId: uuid(correlationId++),
      businessInput,
      verifiedEvidence: providerIngress ? Object.freeze({
        kind: 'verified_inbox' as const, surface: 'provider_ingress' as const,
        client: Object.freeze({ key: 'airtable.settle' }),
        inboxReceiptId: parseIntegrationInboxReceiptId(uuid(0xb03))
      }) : evidence,
      rawIdempotencyKey: key
    });
    return engagementChangeOperationResultSchema.parse(
      await composed.effectExecutor.execute(invocation)
    );
  };
}

function seedInput(overrides: Record<string, unknown> = {}) {
  return {
    scope,
    sessionId,
    submissionId: submissionA,
    seededByDecision: seededBy,
    source: { kind: 'submission', id: submissionA, version: 7 },
    personIds: [personA, personB],
    invitedAt: now,
    respondBy: null,
    ...overrides
  } as Parameters<typeof planEngagementSeedFrom>[1];
}

function applySeed(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const contribution = planEngagementSeedFrom(fx.engagements, seedInput(overrides));
  fx.sqlite.exec('BEGIN IMMEDIATE;');
  const result = applyEngagementSeedFrom(fx.engagements, contribution);
  fx.sqlite.exec('COMMIT;');
  return result;
}

describe('disposable SQLite engagement repository', () => {
  test('creates or preserves an organizer roster invitation under the caller transaction', () => {
    const fx = fixture();
    try {
      const personId = uuid(0xc01);
      const source = { kind: 'organizer', id: userId, version: 1 };
      const plan = planEngagementRosterInviteFrom(fx.engagements, {
        scope, sessionId, personId, source, invitedAt: now, respondBy: null
      });
      expect(() => applyEngagementRosterInviteFrom(fx.engagements, plan))
        .toThrow('transaction_required');
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      const created = applyEngagementRosterInviteFrom(fx.engagements, plan);
      fx.sqlite.exec('COMMIT;');
      expect(created).toMatchObject({
        sessionId, personId, source, state: 'invited',
        submissionId: null, seededByDecision: null, version: 1
      });

      const preserve = planEngagementRosterInviteFrom(fx.engagements, plan.input);
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(applyEngagementRosterInviteFrom(fx.engagements, preserve)).toEqual(created);
      fx.sqlite.exec('COMMIT;');
      expect(fx.sqlite.query('SELECT count(*) AS count FROM engagement_heads').get())
        .toEqual({ count: 1 });
    } finally {
      fx.sqlite.close();
    }
  });

  test('seeds invited rows transactionally with guarded inserts and typed replay refusals', () => {
    const fx = fixture();
    try {
      const contribution = planEngagementSeedFrom(fx.engagements, seedInput());
      expect(() => applyEngagementSeedFrom(fx.engagements, contribution))
        .toThrow('transaction_required');
      const result = applySeed(fx);
      expect(result.seeded.map((head) => head.personId)).toEqual([personA, personB]);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      expect(head).toMatchObject({
        id: deterministicEngagementId(scope, sessionId, personA),
        state: 'invited', version: 1, submissionId: submissionA
      });
      expect(fx.engagements.readEngagementHead(scope, head.id)).toEqual(head);
      // Replaying the exact seeded contribution refuses: the physical pair and
      // the guarded insert both fence it.
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => applyEngagementSeedFrom(fx.engagements, contribution))
        .toThrow('seed_conflict');
      fx.sqlite.exec('ROLLBACK;');
      // A replanned seed over current state skips both pairs and applies cleanly.
      const replay = planEngagementSeedFrom(fx.engagements, seedInput());
      expect(replay.rows).toHaveLength(0);
      expect(replay.skippedPersonIds).toEqual([personA, personB]);
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      applyEngagementSeedFrom(fx.engagements, replay);
      fx.sqlite.exec('COMMIT;');
      expect(fx.sqlite.query('SELECT count(*) AS count FROM engagement_heads').get())
        .toEqual({ count: 2 });
      expect(fx.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fx.sqlite.close();
    }
  });

  test('responses use exact-image guarded updates and identity stays immutable', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      const plan = planEngagementMutation({
        planningInput: {
          action: 'record_confirmation',
          scope, actorUserId: userId, occurredAt: later,
          engagementId: head.id,
          expectedEngagementVersion: 1,
          attribution: 'organizer_recorded'
        },
        environment: { engagements: fx.engagements }
      });
      expect(() => fx.engagements.applyEngagementPlan(plan)).toThrow('transaction_required');
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(fx.engagements.applyEngagementPlan(plan)).toMatchObject({
        action: 'record_confirmation',
        engagement: { state: 'confirmed', version: 2 }
      });
      fx.sqlite.exec('COMMIT;');
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.engagements.applyEngagementPlan(plan)).toThrow('stale_engagement');
      fx.sqlite.exec('ROLLBACK;');
      expect(() => fx.sqlite.query(`
        UPDATE engagement_heads SET person_id = ?
      `).run(personB)).toThrow('immutable');
      // The seed provenance pin inside the head image is physically immutable
      // too: no response or raw write may re-home a row to another acceptance.
      expect(() => fx.sqlite.query(`
        UPDATE engagement_heads
           SET head_json = json_set(head_json, '$.seededByDecision.digestSha256', ?)
      `).run('9'.repeat(64))).toThrow('seed provenance is immutable');
      expect(fx.engagements.readEngagementHead(scope, head.id)).toMatchObject({
        state: 'confirmed',
        seededByDecision: seededBy,
        confirmation: { attribution: 'organizer_recorded', recordedByUserId: userId }
      });
    } finally {
      fx.sqlite.close();
    }
  });

  test('reversal removes exactly one submission\'s seeded rows and refuses advanced rows', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      applySeed(fx, {
        submissionId: submissionB,
        seededByDecision: otherSeededBy,
        source: { kind: 'submission', id: submissionB, version: 3 },
        personIds: [personA, '019c1df7-86b5-769b-bba4-5f7097bfb503']
      });
      expect(fx.engagements.listSeededEngagements(scope, sessionId, submissionB))
        .toHaveLength(1);
      const reversal = planEngagementSeedReversalFrom(fx.engagements, {
        scope, sessionId, submissionId: submissionA, seededByDecision: seededBy
      });
      expect(validateEngagementSeedReversalFrom(fx.engagements, reversal))
        .toEqual({ kind: 'ready' });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      const removed = applyEngagementSeedReversalFrom(fx.engagements, reversal);
      fx.sqlite.exec('COMMIT;');
      expect(removed.removedPersonIds).toEqual([personA, personB]);
      expect(fx.engagements.listSeededEngagements(scope, sessionId, submissionA)).toEqual([]);
      expect(fx.engagements.listSeededEngagements(scope, sessionId, submissionB))
        .toHaveLength(1);

      // Advance the remaining row; its submission's reversal now refuses.
      const standing = fx.engagements.listSeededEngagements(scope, sessionId, submissionB)[0]!;
      const decline = planEngagementMutation({
        planningInput: {
          action: 'decline',
          scope, actorUserId: userId, occurredAt: later,
          engagementId: standing.id,
          expectedEngagementVersion: 1
        },
        environment: { engagements: fx.engagements }
      });
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      fx.engagements.applyEngagementPlan(decline);
      fx.sqlite.exec('COMMIT;');
      expect(() => planEngagementSeedReversalFrom(fx.engagements, {
        scope, sessionId, submissionId: submissionB, seededByDecision: otherSeededBy
      })).toThrow(EngagementSeedError);
    } finally {
      fx.sqlite.close();
    }
  });

  test('snapshot orders canonically and the census counts durable submission references', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const snapshot = fx.engagements.readEngagementSnapshot(scope)!;
      expect(snapshot.engagements.map((head) => head.personId)).toEqual([personA, personB]);
      const census = createSQLiteEngagementSubmissionReferenceSource(fx.sqlite);
      expect(census.countSubmissionReferences(scope, submissionA)).toBe(2);
      expect(census.countSubmissionReferences(scope, submissionB)).toBe(0);
    } finally {
      fx.sqlite.close();
    }
  });

  test('the pair is physically unique and the Session foreign key holds deletion order', () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.sqlite.query(`
        INSERT INTO engagement_heads (
          workspace_id, event_id, id, session_id, person_id, submission_id,
          state, version, head_json, invited_at_ms, cancelled_at_ms
        ) VALUES (?, ?, ?, ?, ?, NULL, 'invited', 1, ?, ?, NULL)
      `).run(
        workspaceId, eventId, '019c1df7-86b5-769b-bba4-5f7097bfbff0',
        sessionId, personA,
        JSON.stringify({
          ...head, id: '019c1df7-86b5-769b-bba4-5f7097bfbff0', submissionId: null
        }),
        Date.parse(now)
      )).toThrow();
      fx.sqlite.exec('ROLLBACK;');
      // A Session with engagement rows cannot be deleted from under them.
      fx.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fx.sqlite.query('DELETE FROM sessions').run()).toThrow();
      fx.sqlite.exec('ROLLBACK;');
    } finally {
      fx.sqlite.close();
    }
  });
});

describe('SQLite Engagement direct effect domain', () => {
  test('verified Airtable inbox requests and withdraws cancellation through the same operation', async () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      const effect = directEffect(fx, true);
      expect(await effect({
        action: 'request_cancellation', engagementId: head.id,
        expectedEngagementVersion: 1, requestedBy: 'organizer', note: 'Travel changed'
      }, 'airtable-request')).toMatchObject({
        kind: 'success', data: { action: 'request_cancellation', engagement: {
          state: 'invited', version: 2, cancellationRequest: { note: 'Travel changed' }
        } }
      });
      expect(await effect({
        action: 'withdraw_cancellation', engagementId: head.id,
        expectedEngagementVersion: 2
      }, 'airtable-withdraw')).toMatchObject({
        kind: 'success', data: { action: 'withdraw_cancellation', engagement: {
          state: 'invited', version: 3, cancellationRequest: null
        } }
      });
      expect(fx.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM operation_log WHERE surface = 'provider_ingress'"
      ).get()).toEqual({ count: 2 });
    } finally {
      fx.sqlite.close();
    }
  });

  test('one call commits the head and log atomically, replays, and key-conflicts changed bytes', async () => {
    const fx = fixture();
    try {
      applySeed(fx);
      const head = fx.engagements.readSessionPersonEngagement(scope, sessionId, personA)!;
      const effect = directEffect(fx);
      const input = {
        action: 'record_confirmation',
        engagementId: head.id,
        expectedEngagementVersion: 1,
        attribution: 'organizer_recorded'
      };
      const committed = await effect(input, 'engagement-one-key');
      expect(committed).toMatchObject({
        kind: 'success',
        data: {
          action: 'record_confirmation',
          engagement: { id: head.id, state: 'confirmed', version: 2 }
        },
        receipt: { operationName: 'engagement.change', operationVersion: 1 }
      });
      if (committed.kind !== 'success') throw new TypeError('engagement_commit_failed');
      expect(fx.engagements.readEngagementHead(scope, head.id)).toMatchObject({
        state: 'confirmed', version: 2,
        confirmation: { attribution: 'organizer_recorded', recordedByUserId: userId }
      });
      expect(fx.sqlite.query<{ count: number }, []>(
        'SELECT count(*) AS count FROM operation_log'
      ).get()).toEqual({ count: 1 });
      expect(fx.sqlite.query<{ summary: string }, []>(
        "SELECT summary FROM operation_log WHERE operation_name = 'engagement.change'"
      ).get()).toEqual({ summary: 'Recorded a speaker confirmation' });

      const replayed = await effect(input, 'engagement-one-key');
      expect(replayed).toMatchObject({ kind: 'success', receipt: { id: committed.receipt.id } });
      expect(fx.sqlite.query<{ count: number }, []>(
        'SELECT count(*) AS count FROM operation_log'
      ).get()).toEqual({ count: 1 });

      expect(await effect({
        action: 'decline',
        engagementId: head.id,
        expectedEngagementVersion: 1
      }, 'engagement-one-key')).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });
      expect(await effect(input, 'engagement-stale')).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'stale_revision', kind: 'engagement.changed' }
      });
      expect(fx.sqlite.query<{ count: number }, []>(
        'SELECT count(*) AS count FROM operation_log'
      ).get()).toEqual({ count: 1 });
    } finally {
      fx.sqlite.close();
    }
  });
});
