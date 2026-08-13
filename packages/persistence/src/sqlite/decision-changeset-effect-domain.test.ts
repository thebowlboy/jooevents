import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  COMMIT_CHANGESET_OPERATION,
  DRAFT_CHANGESET_CORRECTION_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import type { DecisionReviewPinDto } from '@jooevents/contracts';
import type { DecisionCandidateDto, DecisionEnvironmentSource } from '@jooevents/decision';
import {
  DECISION_DECIDE_DRAFT_OPERATION,
  DECISION_DRAFT_ACCESS_POLICY,
  DECISION_DRAFT_REQUEST_HASH_PROFILE,
  createDecisionDraftOperationModule,
  decisionDecideDraftOperationResultSchema
} from '@jooevents/decision-operations';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import { findSession, planSessionMutation } from '@jooevents/session';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import { openSQLite } from './database';
import {
  createSQLiteDecisionChangesetEffectDomainRegistration,
  installDecisionChangesetEffectSchema,
  type SQLiteDecisionChangesetEffectIds
} from './decision-changeset-effect-domain';
import {
  createSQLiteDecisionDraftEffectDomainRegistration,
  installDecisionDraftEffectSchema,
  type SQLiteDecisionDraftEffectIds
} from './decision-draft-effect-domain';
import { installDecisionSchema, SQLiteDecisionRepository } from './decision';
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
import { installSchedulePlacementSchema } from './schedule-placement';
import { installSessionSchema, SQLiteSessionRepository } from './session';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa141');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa241');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa242');
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa341';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa342';
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa343';
const collectingSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa441';
const submissionA = '019c1df7-86b5-769b-bba4-5f7097bfa541';
const submissionB = '019c1df7-86b5-769b-bba4-5f7097bfa542';
const formVersionId = '019c1df7-86b5-769b-bba4-5f7097bfa543';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfa641';
const personB = '019c1df7-86b5-769b-bba4-5f7097bfa642';
const roundId = '019c1df7-86b5-769b-bba4-5f7097bfa741';
const now = parseInstant('2026-08-13T11:00:00.000Z');
const scope = { workspaceId, eventId };
const profile = Object.freeze({ key: 'decision-changeset-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-decision-changeset-session'
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function transaction<Result>(sqlite: ReturnType<typeof openSQLite>['sqlite'], work: () => Result) {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function seed(sqlite: ReturnType<typeof openSQLite>['sqlite']): void {
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Decision workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Decision operator', 1, 1, 1);
  transaction(sqlite, () => {
    sqlite.query<never, [string]>(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, NULL)
    `).run(workspaceId);
    sqlite.query<never, [string, string, string, number, string]>(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date, version,
        created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, 'Decision Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
    `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
    sqlite.query<never, [string, string]>(`
      INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
    `).run(workspaceId, eventId);
    sqlite.query<never, [string, string]>(`
      UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
       WHERE workspace_id = ?
    `).run(eventId, workspaceId);
  });
}

function candidate(overrides: Partial<DecisionCandidateDto> = {}): DecisionCandidateDto {
  return Object.freeze({
    submissionId: submissionA,
    formVersionId,
    candidateVersion: 11,
    title: 'Effect Domain Talk',
    formatId,
    trackId,
    targetSessionId: null,
    participantPersonIds: Object.freeze([personA, personB]),
    ...overrides
  });
}

function openFixture() {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSessionSchema(sqlite);
  installSchedulePlacementSchema(sqlite);
  installDecisionSchema(sqlite);
  installDecisionDraftEffectSchema(sqlite);
  installDecisionChangesetEffectSchema(sqlite);
  seed(sqlite);

  let currentTime: Instant = now;
  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [], contributors: []
  });
  const contributors = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite, expected: [], adapters: []
  });
  const vocabulary = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    contributors,
    () => ({ actorUserId: userId, occurredAt: currentTime })
  );
  const sessions = new SQLiteSessionRepository(sqlite, vocabulary);
  applyVocabulary(vocabulary, sqlite, {
    action: 'create',
    scope,
    expectedSetVersion: 1,
    item: { kind: 'format', id: formatId, name: 'Talk' }
  });
  applyVocabulary(vocabulary, sqlite, {
    action: 'create',
    scope,
    expectedSetVersion: 2,
    item: { kind: 'track', id: trackId, name: 'Platform' }
  });

  const candidates = new Map<string, DecisionCandidateDto>();
  const reviewBasis = new Map<string, DecisionReviewPinDto>();
  const environment: DecisionEnvironmentSource = Object.freeze({
    readDecisionCandidate: (_scope: unknown, submissionId: string) =>
      candidates.get(submissionId),
    readDecisionReviewBasis: (_scope: unknown, submissionId: string) =>
      reviewBasis.get(submissionId)
  });
  const decisions = new SQLiteDecisionRepository({ sqlite, sessions, environment });

  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteDecisionDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newSessionId: next,
    newPreparationHandle: next,
    newTimelineId: next
  };
  const lifecycleIds: SQLiteDecisionChangesetEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newApprovalId: next,
    newCorrectionAttemptId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newFactId: next,
    newPointerId: next
  };
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const draftRegistration = createSQLiteDecisionDraftEffectDomainRegistration({
    sqlite, workspaceId, vocabulary, environment, eventRelationships, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteDecisionChangesetEffectDomainRegistration({
    sqlite, workspaceId, vocabulary, environment, eventRelationships, ids: lifecycleIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    lifecycleRegistration
  ]);

  const authority: Parameters<typeof createDecisionDraftOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (input.evidence.kind !== 'operator') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: 'event.manage' })]),
          evidenceIds: Object.freeze(['decision-membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const keySealer = {
    seal(raw: string) {
      return Object.freeze({
        verifierProfile: profile,
        verifierSha256: createHash('sha256').update(`decision-key:${raw}`).digest('hex')
      });
    }
  };
  const currentEvent = {
    resolveCurrentEvent(requestedWorkspaceId: typeof workspaceId) {
      if (requestedWorkspaceId !== workspaceId) throw new TypeError('decision_workspace_mismatch');
      const state = new SQLiteEventSpineRepository(sqlite).readCurrentEventState(workspaceId);
      if (!state) throw new TypeError('decision_event_set_missing');
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
  const decisionModule = createDecisionDraftOperationModule({
    workspaceId,
    draftPolicy: DECISION_DRAFT_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: DECISION_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x71)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const changesetModule = createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority,
    lifecycleStore: lifecycleRegistration.lifecycleStore,
    ownerResolution: lifecycleRegistration.ownerResolution,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x72)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => currentTime
  });
  let receiptId = 0x900;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([decisionModule, changesetModule]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => currentTime },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let correlation = 0xa00;

  return {
    sqlite,
    vocabulary,
    sessions,
    decisions,
    candidates,
    reviewBasis,
    lifecycle: lifecycleRegistration.lifecycleStore,
    ownerResolution: lifecycleRegistration.ownerResolution,
    close: () => sqlite.close(),
    advance(milliseconds: number) {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + milliseconds).toISOString());
    },
    catalog() {
      const value = sessions.readSessionCatalog(scope);
      if (!value) throw new TypeError('decision_catalog_fixture_missing');
      return value;
    },
    async effect(input: {
      readonly operation: { readonly name: string; readonly version: number };
      readonly businessInput: unknown;
      readonly key: string;
    }) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: input.operation.name,
        operationVersion: input.operation.version,
        surface: 'operator_http',
        correlationId: uuid(correlation++),
        businessInput: input.businessInput,
        verifiedEvidence: evidence,
        rawIdempotencyKey: input.key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

function applyVocabulary(
  vocabulary: SQLiteProgramVocabularyRepository,
  sqlite: ReturnType<typeof openSQLite>['sqlite'],
  authorInput: Parameters<typeof planProgramVocabularyMutation>[0]['authorInput']
): ProgramVocabularyMutationPlan {
  const state = vocabulary.readVocabulary(authorInput.scope);
  if (!state) throw new TypeError('decision_vocabulary_fixture_missing');
  const plan = planProgramVocabularyMutation({
    authorInput,
    state,
    referenceRegistry: vocabulary.referenceRegistry,
    referenceSource: vocabulary
  });
  transaction(sqlite, () => vocabulary.applyVocabularyPlan(plan));
  return plan;
}

function seedCollectingSession(
  fixture: ReturnType<typeof openFixture>,
  participants: readonly { personId: string; sourceId: string }[] = []
): void {
  const catalog = fixture.catalog();
  const plan = planSessionMutation({
    catalog,
    vocabulary: fixture.sessions.readSessionVocabulary(scope)!,
    planningInput: {
      action: 'create', scope, sessionId: collectingSessionId,
      actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      title: 'Collecting Panel', plannedDurationMinutes: 60,
      lifecycle: 'collecting', formatId, trackId,
      participants: participants.map((participant) => ({
        personId: participant.personId,
        role: 'speaker' as const,
        publiclyVisible: true,
        source: { kind: 'submission', id: participant.sourceId, version: 1 }
      }))
    }
  });
  transaction(fixture.sqlite, () => fixture.sessions.applySessionPlan(plan));
}

function graduateCollectingSession(fixture: ReturnType<typeof openFixture>): void {
  const catalog = fixture.catalog();
  const session = findSession(catalog, collectingSessionId)!;
  const plan = planSessionMutation({
    catalog,
    vocabulary: fixture.sessions.readSessionVocabulary(scope)!,
    planningInput: {
      action: 'transition', scope, sessionId: collectingSessionId,
      actorUserId: userId, occurredAt: now,
      expectedCatalogVersion: catalog.version,
      expectedCatalogDigestSha256: catalog.digestSha256,
      expectedSessionVersion: session.version,
      expectedSessionDigestSha256: session.digestSha256,
      to: 'programmed'
    }
  });
  transaction(fixture.sqlite, () => fixture.sessions.applySessionPlan(plan));
}

function decideInput(rows: readonly Record<string, unknown>[]) {
  return {
    action: 'decide',
    decisions: rows.map((row) => ({
      expectedDecisionVersion: null,
      expectedDecisionDigestSha256: null,
      ...row
    }))
  };
}

/** Places one Session on the schedule the way a concurrent schedule commit would. */
function placeSessionOnSchedule(
  fixture: ReturnType<typeof openFixture>,
  sessionId: string
): void {
  transaction(fixture.sqlite, () => {
    fixture.sqlite.query(`
      INSERT INTO program_vocabulary_rooms (
        workspace_id, event_id, id, name, status, capacity, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, 'Main Hall', 'active', NULL, 1, ?, ?, ?, ?)
    `).run(workspaceId, eventId, roomId, userId, Date.parse(now), userId, Date.parse(now));
    fixture.sqlite.query(`
      INSERT INTO schedule_placement_sets (
        workspace_id, event_id, schedule_version, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, 2, ?, ?)
    `).run(workspaceId, eventId, userId, Date.parse(now));
    fixture.sqlite.query(`
      INSERT INTO schedule_occurrences (
        workspace_id, event_id, id, session_id, room_id, start_at_ms, end_at_ms,
        version, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      workspaceId, eventId, uuid(0xe01), sessionId, roomId,
      Date.parse(now), Date.parse(now) + 3_600_000, userId, Date.parse(now)
    );
  });
}

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    heads: count(fixture.sqlite, 'decision_heads'),
    origins: count(fixture.sqlite, 'submission_session_origins'),
    sessions: count(fixture.sqlite, 'sessions'),
    lifecycleLinks: count(fixture.sqlite, 'decision_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'decision_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'decision_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'decision_changeset_timeline'),
    commitLinks: count(fixture.sqlite, 'changeset_commit_links')
  };
}

async function draftAndPropose(
  fixture: ReturnType<typeof openFixture>,
  businessInput: unknown,
  key: string
) {
  const draft = decisionDecideDraftOperationResultSchema.parse(await fixture.effect({
    operation: DECISION_DECIDE_DRAFT_OPERATION,
    businessInput,
    key: `${key}-draft`
  }));
  if (draft.kind !== 'success') throw new TypeError(`decision_draft_failed:${JSON.stringify(draft)}`);
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: PROPOSE_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: draft.data.headVersion },
    key: `${key}-propose`
  }));
  if (proposed.kind !== 'success') throw new TypeError('decision_propose_failed');
  return { draft, selector };
}

async function commit(
  fixture: ReturnType<typeof openFixture>,
  selector: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string },
  key: string
) {
  return changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: COMMIT_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: 2 },
    key
  }));
}

async function correction(
  fixture: ReturnType<typeof openFixture>,
  selector: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string },
  commitReceiptId: string,
  key: string
) {
  return changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
    businessInput: {
      sourceChangesetId: selector.changesetId,
      sourceRevisionId: selector.revisionId,
      sourceRevisionDigest: selector.revisionDigest,
      sourceCommitReceiptId: commitReceiptId
    },
    key
  }));
}

describe('ordinary SQLite Decision changeset effect domain', () => {
  test('accept-spawn commits head, Session, and origin atomically with merged facts and idempotent replay', async () => {
    const fixture = openFixture();
    try {
      fixture.candidates.set(submissionA, candidate());
      fixture.reviewBasis.set(submissionA, Object.freeze({
        roundId, roundVersion: 2,
        standing: Object.freeze({ value: 4.2, n: 9, band: 'upper' as const })
      }));
      const created = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'accepted' }]),
        'spawn'
      );
      if (created.draft.kind !== 'success') throw new TypeError('decision_draft_failed');
      expect(created.draft.data.riskTier).toBe('consequential');
      const diffRow = created.draft.data.safeDiff.rows[0]!;
      expect(diffRow.evidence?.review).toEqual({
        roundId, roundVersion: 2, standing: { value: 4.2, n: 9, band: 'upper' }
      });
      expect(diffRow.session).toMatchObject({ action: 'create', before: null });
      const record = fixture.lifecycle.read(created.selector.changesetId);
      if (!record) throw new TypeError('decision_changeset_record_missing');
      expect(await fixture.ownerResolution.resolveOwner(record)).toMatchObject({ id: 'decision' });
      expect(durableCounts(fixture)).toMatchObject({ heads: 0, origins: 0, sessions: 0 });

      const commitInput = { ...created.selector, expectedHeadVersion: 2 };
      const committed = await commit(fixture, created.selector, 'spawn-commit');
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 3 }
      });
      const spawnedSessionId = diffRow.session?.after?.id;
      if (spawnedSessionId === undefined) throw new TypeError('decision_spawn_image_missing');
      const session = findSession(fixture.catalog(), spawnedSessionId)!;
      expect(session).toMatchObject({
        lifecycle: 'programmed',
        title: 'Effect Domain Talk',
        plannedDurationMinutes: 30
      });
      expect(session.roster.participants.map((participant) => participant.personId))
        .toEqual([personA, personB]);
      expect(fixture.decisions.readDecisionHead(scope, submissionA))
        .toMatchObject({ state: 'accepted', version: 1 });
      expect(fixture.decisions.readSubmissionSessionOrigin(scope, submissionA))
        .toMatchObject({ kind: 'spawned', sessionId: spawnedSessionId });
      const factPayload = JSON.parse(fixture.sqlite.query<{ readonly payload_json: string }, []>(`
        SELECT payload_json FROM decision_changeset_domain_facts
      `).get()?.payload_json ?? 'null');
      expect(factPayload.contributions[0].facts.map((fact: { kind: string }) => fact.kind))
        .toEqual(['decision_changed', 'session_changed']);
      const afterCommit = durableCounts(fixture);
      expect(afterCommit).toMatchObject({
        heads: 1, origins: 1, sessions: 1,
        lifecycleLinks: 2, facts: 1, pointers: 1, timeline: 2, commitLinks: 1
      });

      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'spawn-commit'
      })).toEqual(committed);
      expect(durableCounts(fixture)).toEqual(afterCommit);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('accept-attach appends the roster without clobbering, dedups by personId, and graduates in place', async () => {
    const fixture = openFixture();
    try {
      seedCollectingSession(fixture, [{ personId: personA, sourceId: submissionB }]);
      const before = findSession(fixture.catalog(), collectingSessionId)!;
      fixture.candidates.set(submissionA, candidate({ targetSessionId: collectingSessionId }));
      const created = await draftAndPropose(
        fixture,
        decideInput([{
          submissionId: submissionA,
          state: 'accepted',
          graduation: {
            kind: 'attach', sessionId: collectingSessionId, graduateTo: 'programmed'
          }
        }]),
        'attach'
      );
      expect(await commit(fixture, created.selector, 'attach-commit')).toMatchObject({
        kind: 'success',
        data: { action: 'commit' }
      });
      const session = findSession(fixture.catalog(), collectingSessionId)!;
      expect(session.lifecycle).toBe('programmed');
      expect(session.roster.participants[0]).toEqual(before.roster.participants[0]!);
      expect(session.roster.participants.map((participant) => participant.personId))
        .toEqual([personA, personB]);
      expect(fixture.decisions.readSubmissionSessionOrigin(scope, submissionA))
        .toMatchObject({ kind: 'attached', sessionId: collectingSessionId });
      expect(count(fixture.sqlite, 'sessions')).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('a collecting target graduated mid-flight refuses commit and re-draft with the structured filled-target outcome', async () => {
    const fixture = openFixture();
    try {
      seedCollectingSession(fixture);
      fixture.candidates.set(submissionA, candidate({ targetSessionId: collectingSessionId }));
      // Omitted graduation routes by the effective target: a collecting target attaches.
      const created = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'accepted' }]),
        'filled'
      );
      if (created.draft.kind !== 'success') throw new TypeError('decision_draft_failed');
      expect(created.draft.data.safeDiff.rows[0]?.session)
        .toMatchObject({ action: 'roster_append' });

      graduateCollectingSession(fixture);
      const before = durableCounts(fixture);
      // The commit fences on the pinned target Session aggregate, so the
      // mid-flight graduation refuses as a typed stale plan without writing.
      expect(await commit(fixture, created.selector, 'filled-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          retryable: false,
          detail: {
            code: 'base_version_changed',
            subjectId: `session:${collectingSessionId}`
          }
        }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.lifecycle.read(created.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });

      // The replan exit carries the structured filled-target refusal with the
      // two decided exits, because no collecting target remains.
      expect(decisionDecideDraftOperationResultSchema.parse(await fixture.effect({
        operation: DECISION_DECIDE_DRAFT_OPERATION,
        businessInput: decideInput([{ submissionId: submissionA, state: 'accepted' }]),
        key: 'filled-redraft'
      }))).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'conflict',
          kind: 'decision.target_unavailable',
          detail: { reason: 'target_graduated', exits: ['retarget', 'spawn'] }
        }
      });
    } finally {
      fixture.close();
    }
  });

  test('bulk waitlist and decline write heads only and never touch Sessions or origins', async () => {
    const fixture = openFixture();
    try {
      fixture.candidates.set(submissionA, candidate());
      fixture.candidates.set(submissionB, candidate({
        submissionId: submissionB, title: 'Second Talk',
        participantPersonIds: Object.freeze([personB])
      }));
      const created = await draftAndPropose(
        fixture,
        decideInput([
          { submissionId: submissionA, state: 'waitlisted' },
          { submissionId: submissionB, state: 'declined' }
        ]),
        'bulk'
      );
      expect(await commit(fixture, created.selector, 'bulk-commit')).toMatchObject({
        kind: 'success',
        data: { action: 'commit' }
      });
      expect(fixture.decisions.readDecisionHead(scope, submissionA)?.state).toBe('waitlisted');
      expect(fixture.decisions.readDecisionHead(scope, submissionB)?.state).toBe('declined');
      expect(durableCounts(fixture)).toMatchObject({ heads: 2, origins: 0, sessions: 0 });
    } finally {
      fixture.close();
    }
  });

  test('compensation unspawns an unreferenced Session exactly and blocks compensating the compensation', async () => {
    const fixture = openFixture();
    try {
      fixture.candidates.set(submissionA, candidate());
      const created = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'accepted' }]),
        'unspawn'
      );
      const committed = await commit(fixture, created.selector, 'unspawn-commit');
      if (committed.kind !== 'success') throw new TypeError('decision_commit_failed');
      expect(durableCounts(fixture)).toMatchObject({ heads: 1, origins: 1, sessions: 1 });

      const corrected = await correction(
        fixture, created.selector, committed.receipt.id, 'unspawn-correction'
      );
      expect(corrected).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'exact' }
      });
      if (corrected.kind !== 'success' || corrected.data.action !== 'correction'
          || corrected.data.target === null) throw new TypeError('decision_correction_missing');
      const correctionSelector = {
        changesetId: corrected.data.target.changesetId,
        revisionId: corrected.data.target.revisionId,
        revisionDigest: corrected.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 1 },
        key: 'unspawn-correction-propose'
      })).toMatchObject({ kind: 'success' });
      const compensated = await commit(fixture, correctionSelector, 'unspawn-correction-commit');
      if (compensated.kind !== 'success') throw new TypeError('decision_compensation_commit_failed');
      expect(durableCounts(fixture)).toMatchObject({ heads: 0, origins: 0, sessions: 0 });
      expect(fixture.catalog().sessions).toEqual([]);

      expect(await correction(
        fixture, correctionSelector, compensated.receipt.id, 'compensation-of-compensation'
      )).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'blocked',
          target: null,
          evidence: { blockers: [{ reasonKey: 'decision.compensation_of_compensation' }] }
        }
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('a referenced Session stays standing: compensation unlinks the origin and reverts the head only', async () => {
    const fixture = openFixture();
    try {
      fixture.candidates.set(submissionA, candidate());
      const created = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'accepted' }]),
        'standing'
      );
      const committed = await commit(fixture, created.selector, 'standing-commit');
      if (committed.kind !== 'success') throw new TypeError('decision_commit_failed');
      const spawnedSessionId = fixture.decisions
        .readSubmissionSessionOrigin(scope, submissionA)!.sessionId;

      placeSessionOnSchedule(fixture, spawnedSessionId);

      const corrected = await correction(
        fixture, created.selector, committed.receipt.id, 'standing-correction'
      );
      expect(corrected).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'semantic' }
      });
      if (corrected.kind !== 'success' || corrected.data.action !== 'correction'
          || corrected.data.target === null) throw new TypeError('decision_correction_missing');
      const correctionSelector = {
        changesetId: corrected.data.target.changesetId,
        revisionId: corrected.data.target.revisionId,
        revisionDigest: corrected.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 1 },
        key: 'standing-correction-propose'
      })).toMatchObject({ kind: 'success' });
      expect(await commit(fixture, correctionSelector, 'standing-correction-commit'))
        .toMatchObject({ kind: 'success' });
      expect(fixture.decisions.readDecisionHead(scope, submissionA)).toBeUndefined();
      expect(fixture.decisions.readSubmissionSessionOrigin(scope, submissionA)).toBeUndefined();
      expect(findSession(fixture.catalog(), spawnedSessionId)).toMatchObject({
        lifecycle: 'programmed'
      });
      expect(count(fixture.sqlite, 'sessions')).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('a placement landing between compensation derive and commit refuses the unspawn and replans to stays-standing', async () => {
    const fixture = openFixture();
    try {
      fixture.candidates.set(submissionA, candidate());
      const created = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'accepted' }]),
        'race'
      );
      const committed = await commit(fixture, created.selector, 'race-commit');
      if (committed.kind !== 'success') throw new TypeError('decision_commit_failed');
      const spawnedSessionId = fixture.decisions
        .readSubmissionSessionOrigin(scope, submissionA)!.sessionId;

      // Derived and proposed while the spawned Session is unreferenced: an
      // exact unspawn.
      const corrected = await correction(
        fixture, created.selector, committed.receipt.id, 'race-correction'
      );
      expect(corrected).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'exact' }
      });
      if (corrected.kind !== 'success' || corrected.data.action !== 'correction'
          || corrected.data.target === null) throw new TypeError('decision_correction_missing');
      const correctionSelector = {
        changesetId: corrected.data.target.changesetId,
        revisionId: corrected.data.target.revisionId,
        revisionDigest: corrected.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 1 },
        key: 'race-correction-propose'
      })).toMatchObject({ kind: 'success' });

      // A concurrent schedule commit places the spawned Session AFTER the
      // compensation was derived. The placement moves neither the Session
      // digest nor the catalog digest, so no aggregate or guard fences it —
      // only the commit-time reference re-check can.
      placeSessionOnSchedule(fixture, spawnedSessionId);

      const before = durableCounts(fixture);
      expect(await commit(fixture, correctionSelector, 'race-correction-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          retryable: false,
          detail: { code: 'domain_changed' }
        }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(findSession(fixture.catalog(), spawnedSessionId)).toMatchObject({
        lifecycle: 'programmed'
      });
      expect(fixture.decisions.readDecisionHead(scope, submissionA))
        .toMatchObject({ state: 'accepted' });
      expect(fixture.decisions.readSubmissionSessionOrigin(scope, submissionA))
        .toMatchObject({ kind: 'spawned', sessionId: spawnedSessionId });
      expect(count(fixture.sqlite, 'schedule_occurrences')).toBe(1);

      // Retry-by-replan: a fresh correction derived against current state
      // keeps the placed Session standing and unlinks only.
      const replanned = await correction(
        fixture, created.selector, committed.receipt.id, 'race-replan'
      );
      expect(replanned).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'semantic' }
      });
      if (replanned.kind !== 'success' || replanned.data.action !== 'correction'
          || replanned.data.target === null) throw new TypeError('decision_correction_missing');
      const replanSelector = {
        changesetId: replanned.data.target.changesetId,
        revisionId: replanned.data.target.revisionId,
        revisionDigest: replanned.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...replanSelector, expectedHeadVersion: 1 },
        key: 'race-replan-propose'
      })).toMatchObject({ kind: 'success' });
      expect(await commit(fixture, replanSelector, 'race-replan-commit'))
        .toMatchObject({ kind: 'success' });
      expect(fixture.decisions.readDecisionHead(scope, submissionA)).toBeUndefined();
      expect(fixture.decisions.readSubmissionSessionOrigin(scope, submissionA)).toBeUndefined();
      expect(count(fixture.sqlite, 'sessions')).toBe(1);
      expect(count(fixture.sqlite, 'schedule_occurrences')).toBe(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('detach compensation restores the exact roster-before image and lifecycle', async () => {
    const fixture = openFixture();
    try {
      seedCollectingSession(fixture, [{ personId: personA, sourceId: submissionB }]);
      const before = findSession(fixture.catalog(), collectingSessionId)!;
      fixture.candidates.set(submissionA, candidate({ targetSessionId: collectingSessionId }));
      const created = await draftAndPropose(
        fixture,
        decideInput([{
          submissionId: submissionA,
          state: 'accepted',
          graduation: {
            kind: 'attach', sessionId: collectingSessionId, graduateTo: 'programmed'
          }
        }]),
        'detach'
      );
      const committed = await commit(fixture, created.selector, 'detach-commit');
      if (committed.kind !== 'success') throw new TypeError('decision_commit_failed');
      expect(findSession(fixture.catalog(), collectingSessionId)!.lifecycle).toBe('programmed');

      const corrected = await correction(
        fixture, created.selector, committed.receipt.id, 'detach-correction'
      );
      expect(corrected).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'exact' }
      });
      if (corrected.kind !== 'success' || corrected.data.action !== 'correction'
          || corrected.data.target === null) throw new TypeError('decision_correction_missing');
      const correctionSelector = {
        changesetId: corrected.data.target.changesetId,
        revisionId: corrected.data.target.revisionId,
        revisionDigest: corrected.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 1 },
        key: 'detach-correction-propose'
      })).toMatchObject({ kind: 'success' });
      expect(await commit(fixture, correctionSelector, 'detach-correction-commit'))
        .toMatchObject({ kind: 'success' });
      const restored = findSession(fixture.catalog(), collectingSessionId)!;
      expect(restored.lifecycle).toBe('collecting');
      expect(restored.roster.participants).toEqual(before.roster.participants);
      expect(restored.roster.version).toBe(before.roster.version);
      expect(fixture.decisions.readDecisionHead(scope, submissionA)).toBeUndefined();
      expect(fixture.decisions.readSubmissionSessionOrigin(scope, submissionA)).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  test('a competing first decide surfaces as a decision head absence guard change without writing', async () => {
    const fixture = openFixture();
    try {
      fixture.candidates.set(submissionA, candidate());
      const first = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'waitlisted' }]),
        'race-first'
      );
      const second = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'declined' }]),
        'race-second'
      );
      expect(await commit(fixture, first.selector, 'race-first-commit')).toMatchObject({
        kind: 'success'
      });
      const before = durableCounts(fixture);
      expect(await commit(fixture, second.selector, 'race-second-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed', subjectId: `decision_head_absence:${submissionA}` }
        }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.decisions.readDecisionHead(scope, submissionA)?.state).toBe('waitlisted');
    } finally {
      fixture.close();
    }
  });

  test('rolls back Decision, Session, and origin domains together after a late failure', async () => {
    const fixture = openFixture();
    try {
      fixture.candidates.set(submissionA, candidate());
      const created = await draftAndPropose(
        fixture,
        decideInput([{ submissionId: submissionA, state: 'accepted' }]),
        'atomic'
      );
      const before = durableCounts(fixture);
      const catalogBefore = fixture.catalog();
      fixture.sqlite.exec(`
        CREATE TRIGGER decision_joined_fail_head
        BEFORE INSERT ON decision_heads
        BEGIN SELECT RAISE(ABORT, 'injected decision head failure'); END;
      `);
      await expect(commit(fixture, created.selector, 'atomic-commit'))
        .rejects.toThrow('Operation execution failed during handler.');
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.catalog()).toEqual(catalogBefore);
      expect(fixture.lifecycle.read(created.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
