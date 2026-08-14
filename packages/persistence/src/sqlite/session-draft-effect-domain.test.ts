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
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
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
import {
  SESSION_CHANGE_DRAFT_OPERATION,
  SESSION_DRAFT_ACCESS_POLICY,
  SESSION_DRAFT_REQUEST_HASH_PROFILE,
  createSessionDraftOperationModule,
  sessionDraftOperationResultSchema
} from '@jooevents/session-operations';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import { openSQLite } from './database';
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
import {
  createSQLiteSessionChangesetEffectDomainRegistration,
  installSessionChangesetEffectSchema,
  type SQLiteSessionChangesetEffectIds
} from './session-changeset-effect-domain';
import {
  createSQLiteSessionDraftEffectDomainRegistration,
  installSessionDraftEffectSchema,
  type SQLiteSessionDraftEffectIds
} from './session-draft-effect-domain';
import { installSessionSchema, SQLiteSessionRepository } from './session';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';
import { planSessionMutation } from '@jooevents/session';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa121');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa221');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa222');
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa321';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa322';
const missingFormatId = '019c1df7-86b5-769b-bba4-5f7097bfa323';
const now = parseInstant('2026-08-13T09:00:00.000Z');
const profile = Object.freeze({ key: 'session-draft-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-session-draft-session'
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

function seed(sqlite: ReturnType<typeof openSQLite>['sqlite'], currentEvent: boolean): void {
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Session workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Session operator', 1, 1, 1);
  transaction(sqlite, () => {
    sqlite.query<never, [string]>(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, NULL)
    `).run(workspaceId);
    sqlite.query<never, [string, string, string, number, string]>(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date, version,
        created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, 'Session Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
    `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
    sqlite.query<never, [string, string]>(`
      INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
    `).run(workspaceId, eventId);
    if (currentEvent) {
      sqlite.query<never, [string, string]>(`
        UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
         WHERE workspace_id = ?
      `).run(eventId, workspaceId);
    }
  });
}

function openFixture(options: { readonly currentEvent?: boolean } = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSessionSchema(sqlite);
  installSessionDraftEffectSchema(sqlite);
  installSessionChangesetEffectSchema(sqlite);
  seed(sqlite, options.currentEvent !== false);

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
  applyVocabulary(vocabulary, sqlite, {
    action: 'create',
    scope: { workspaceId, eventId },
    expectedSetVersion: 1,
    item: { kind: 'format', id: formatId, name: 'Talk' }
  });
  applyVocabulary(vocabulary, sqlite, {
    action: 'create',
    scope: { workspaceId, eventId },
    expectedSetVersion: 2,
    item: { kind: 'track', id: trackId, name: 'Platform' }
  });

  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteSessionDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newSessionId: next,
    newPreparationHandle: next,
    newTimelineId: next
  };
  const lifecycleIds: SQLiteSessionChangesetEffectIds = {
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
  const draftRegistration = createSQLiteSessionDraftEffectDomainRegistration({
    sqlite, workspaceId, vocabulary, eventRelationships, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteSessionChangesetEffectDomainRegistration({
    sqlite, workspaceId, vocabulary, eventRelationships, ids: lifecycleIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    lifecycleRegistration
  ]);

  const authority: Parameters<typeof createSessionDraftOperationModule>[0]['currentAuthority'] = {
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
          grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: 'schedule.manage' })]),
          evidenceIds: Object.freeze(['session-membership.current']),
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
        verifierSha256: createHash('sha256').update(`session-key:${raw}`).digest('hex')
      });
    }
  };
  const sessionModule = createSessionDraftOperationModule({
    workspaceId,
    draftPolicy: SESSION_DRAFT_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent(requestedWorkspaceId) {
        if (requestedWorkspaceId !== workspaceId) throw new TypeError('session_workspace_mismatch');
        const state = new SQLiteEventSpineRepository(sqlite).readCurrentEventState(workspaceId);
        if (!state) throw new TypeError('session_event_set_missing');
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
    },
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: SESSION_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x61)
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
      keyBytes: new Uint8Array(32).fill(0x62)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => currentTime
  });
  let receiptId = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([sessionModule, changesetModule]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => currentTime },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let correlation = 0x900;

  return {
    sqlite,
    vocabulary,
    lifecycle: lifecycleRegistration.lifecycleStore,
    close: () => sqlite.close(),
    catalog() {
      const value = draftRegistration.sessionRead.readSessionCatalog({ workspaceId, eventId });
      if (!value) throw new TypeError('session_catalog_fixture_missing');
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
  const state = vocabulary.readVocabulary({ workspaceId, eventId });
  if (!state) throw new TypeError('session_vocabulary_fixture_missing');
  const plan = planProgramVocabularyMutation({
    authorInput,
    state,
    referenceRegistry: vocabulary.referenceRegistry,
    referenceSource: vocabulary
  });
  transaction(sqlite, () => vocabulary.applyVocabularyPlan(plan));
  return plan;
}

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    sessions: count(fixture.sqlite, 'sessions'),
    catalogs: count(fixture.sqlite, 'session_catalogs'),
    draftLinks: count(fixture.sqlite, 'session_draft_receipt_links'),
    draftTimeline: count(fixture.sqlite, 'session_draft_timeline'),
    changesetHeads: count(fixture.sqlite, 'changeset_heads'),
    changesetRevisions: count(fixture.sqlite, 'changeset_revisions')
  };
}

function createInput(
  fixture: ReturnType<typeof openFixture>,
  overrides: Record<string, unknown> = {}
) {
  const catalog = fixture.catalog();
  return {
    action: 'create',
    expectedCatalogVersion: catalog.version,
    expectedCatalogDigestSha256: catalog.digestSha256,
    title: 'Opening Keynote',
    plannedDurationMinutes: 45,
    lifecycle: 'draft',
    formatId,
    trackId,
    ...overrides
  };
}

describe('SQLite Session draft effect domain', () => {
  test('returns the typed current-Event prerequisite without allocating draft state', async () => {
    const fixture = openFixture({ currentEvent: false });
    try {
      expect(await fixture.effect({
        operation: SESSION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'create',
          expectedCatalogVersion: 1,
          expectedCatalogDigestSha256: 'a'.repeat(64),
          title: 'Opening Keynote',
          plannedDurationMinutes: 45,
          lifecycle: 'draft',
          formatId,
          trackId: null
        },
        key: 'event-required-draft'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'session.event_required' }
      });
      expect(durableCounts(fixture)).toEqual({
        receipts: 0,
        sessions: 0,
        catalogs: 0,
        draftLinks: 0,
        draftTimeline: 0,
        changesetHeads: 0,
        changesetRevisions: 0
      });
    } finally {
      fixture.close();
    }
  });

  test('writes an inert create draft that leaves the Session catalog untouched', async () => {
    const fixture = openFixture();
    try {
      const before = fixture.catalog();
      const draft = sessionDraftOperationResultSchema.parse(await fixture.effect({
        operation: SESSION_CHANGE_DRAFT_OPERATION,
        businessInput: createInput(fixture),
        key: 'inert-create-draft'
      }));
      if (draft.kind !== 'success') throw new TypeError('session_draft_failed');
      expect(draft.data).toMatchObject({
        schemaVersion: 1,
        action: 'create',
        headVersion: 1,
        status: 'draft',
        revision: { number: 1 },
        riskTier: 'normal',
        approvalPolicy: { requirement: 'none' },
        safeDiff: {
          action: 'create',
          before: null,
          after: {
            title: 'Opening Keynote',
            plannedDurationMinutes: 45,
            lifecycle: 'draft',
            version: 1,
            scope: { workspaceId, eventId },
            programTarget: {
              format: { id: formatId, name: 'Talk', status: 'active', version: 1 },
              track: { id: trackId, name: 'Platform', status: 'active', version: 1 }
            },
            roster: { version: 1, participants: [] },
            createdByUserId: userId,
            createdAt: now,
            updatedByUserId: userId,
            updatedAt: now
          }
        }
      });
      expect(durableCounts(fixture)).toMatchObject({
        sessions: 0,
        catalogs: 0,
        draftLinks: 1,
        draftTimeline: 1,
        changesetHeads: 1,
        changesetRevisions: 1
      });
      expect(fixture.catalog()).toEqual(before);

      const link = fixture.sqlite.query<{
        readonly changeset_id: string;
        readonly revision_id: string;
        readonly revision_digest_sha256: string;
        readonly action: string;
        readonly session_id: string;
      }, [string]>(`
        SELECT changeset_id, revision_id, revision_digest_sha256, action, session_id
          FROM session_draft_receipt_links WHERE receipt_id = ?
      `).get(draft.receipt.id);
      expect(link).toMatchObject({
        action: 'create',
        session_id: draft.data.safeDiff.after?.id,
        changeset_id: draft.data.changesetId,
        revision_id: draft.data.revision.id,
        revision_digest_sha256: draft.data.revision.digestSha256
      });
      const record = fixture.lifecycle.read(draft.data.changesetId);
      if (!record) throw new TypeError('session_changeset_record_missing');
      expect(record.head).toMatchObject({ status: 'draft', version: 1, eventId });
      const operation = record.revisions[0]?.revision.operations[0];
      expect(operation).toMatchObject({ kind: 'session.mutate', version: 1 });
      expect(operation?.aggregateRefs).toEqual([
        { id: `program_format:${formatId}`, version: 1 },
        { id: `program_track:${trackId}`, version: 1 }
      ]);
      expect(operation?.guardRefs.map((guard) => guard.id)).toEqual([
        `session_catalog:${eventId}`,
        `program_vocabulary_set:${eventId}`
      ]);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('drafts the roster visibility off-switch through the same inert ceremony', async () => {
    const fixture = openFixture();
    const personId = uuid(0x7001);
    const sessionId = uuid(0x7002);
    try {
      const vocabularyState = fixture.vocabulary.readVocabulary({ workspaceId, eventId });
      if (!vocabularyState) throw new TypeError('session_vocabulary_fixture_missing');
      const seedPlan = planSessionMutation({
        planningInput: {
          action: 'create',
          scope: { workspaceId, eventId },
          actorUserId: userId,
          occurredAt: now,
          sessionId,
          expectedCatalogVersion: fixture.catalog().version,
          expectedCatalogDigestSha256: fixture.catalog().digestSha256,
          title: 'Visibility Session',
          plannedDurationMinutes: 45,
          lifecycle: 'programmed',
          formatId,
          trackId: null,
          participants: [{
            personId,
            role: 'speaker',
            publiclyVisible: true,
            source: { kind: 'submission', id: 'seeded', version: 1 }
          }]
        },
        catalog: fixture.catalog(),
        vocabulary: vocabularyState
      });
      transaction(fixture.sqlite, () =>
        new SQLiteSessionRepository(fixture.sqlite, fixture.vocabulary).applySessionPlan(seedPlan)
      );
      const current = fixture.catalog().sessions.find((session) => session.id === sessionId);
      if (!current) throw new TypeError('session_visibility_fixture_missing');
      expect(current.roster.participants[0]).toMatchObject({ personId, publiclyVisible: true });

      const draft = sessionDraftOperationResultSchema.parse(await fixture.effect({
        operation: SESSION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'roster_visibility',
          expectedCatalogVersion: fixture.catalog().version,
          expectedCatalogDigestSha256: fixture.catalog().digestSha256,
          sessionId,
          expectedSessionVersion: current.version,
          expectedSessionDigestSha256: current.digestSha256,
          personId,
          publiclyVisible: false
        },
        key: 'roster-visibility-draft'
      }));
      if (draft.kind !== 'success') throw new TypeError('session_visibility_draft_failed');
      expect(draft.data).toMatchObject({
        action: 'roster_visibility',
        status: 'draft',
        safeDiff: {
          action: 'roster_visibility',
          before: { roster: { participants: [{ personId, publiclyVisible: true }] } },
          after: { roster: { participants: [{ personId, publiclyVisible: false }] } }
        }
      });
      // The draft is inert: effective roster state is untouched until commit.
      expect(fixture.catalog().sessions.find((session) => session.id === sessionId)?.roster
        .participants[0]).toMatchObject({ publiclyVisible: true });
      const link = fixture.sqlite.query<{ readonly action: string }, [string]>(`
        SELECT action FROM session_draft_receipt_links WHERE receipt_id = ?
      `).get(draft.receipt.id);
      expect(link).toEqual({ action: 'roster_visibility' });

      // The ordinary propose -> commit lifecycle lands the off-switch: the
      // roster keeps its entry byte-for-byte except the flag.
      const selector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };
      const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: { name: 'changeset.propose', version: 1 },
        businessInput: { ...selector, expectedHeadVersion: draft.data.headVersion },
        key: 'roster-visibility-propose'
      }));
      if (proposed.kind !== 'success' || proposed.data.action !== 'propose') {
        throw new TypeError('session_visibility_propose_failed');
      }
      const committed = await fixture.effect({
        operation: { name: 'changeset.commit', version: 1 },
        businessInput: {
          ...selector,
          expectedHeadVersion: proposed.data.diff.headVersion
        },
        key: 'roster-visibility-commit'
      });
      expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      const switched = fixture.catalog().sessions.find((session) => session.id === sessionId);
      expect(switched?.roster.participants).toHaveLength(1);
      expect(switched?.roster.participants[0]).toMatchObject({
        personId,
        role: 'speaker',
        position: 0,
        publiclyVisible: false,
        source: { kind: 'submission', id: 'seeded', version: 1 }
      });

      const committedSession = fixture.catalog().sessions
        .find((session) => session.id === sessionId);
      if (!committedSession) throw new TypeError('session_visibility_committed_missing');
      expect(await fixture.effect({
        operation: SESSION_CHANGE_DRAFT_OPERATION,
        businessInput: {
          action: 'roster_visibility',
          expectedCatalogVersion: fixture.catalog().version,
          expectedCatalogDigestSha256: fixture.catalog().digestSha256,
          sessionId,
          expectedSessionVersion: committedSession.version,
          expectedSessionDigestSha256: committedSession.digestSha256,
          personId: uuid(0x7003),
          publiclyVisible: false
        },
        key: 'roster-visibility-missing-person'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'session.changed',
          detail: { code: 'participant_missing', action: 'roster_visibility', sessionId }
        }
      });
    } finally {
      fixture.close();
    }
  });

  test('refuses a stale catalog guard and unusable Program Vocabulary targets', async () => {
    const cases = [
      { key: 'stale-catalog', code: 'stale_catalog', overrides: { expectedCatalogVersion: 7 } },
      { key: 'format-missing', code: 'format_missing', overrides: { formatId: missingFormatId } },
      { key: 'track-missing', code: 'track_missing', overrides: { trackId: missingFormatId } },
      { key: 'track-retired', code: 'track_retired', overrides: { retireTrack: true } }
    ] as const;
    for (const scenario of cases) {
      const fixture = openFixture();
      try {
        const { retireTrack, ...overrides } = {
          retireTrack: false,
          ...scenario.overrides
        } as { retireTrack?: boolean } & Record<string, unknown>;
        if (retireTrack === true) {
          const state = fixture.vocabulary.readVocabulary({ workspaceId, eventId });
          const track = state?.tracks.find((candidate) => candidate.id === trackId);
          if (!state || !track) throw new TypeError('session_track_fixture_missing');
          applyVocabulary(fixture.vocabulary, fixture.sqlite, {
            action: 'retire', scope: { workspaceId, eventId }, kind: 'track', id: trackId,
            expectedSetVersion: state.setVersion, expectedItemVersion: track.version
          });
        }
        expect(await fixture.effect({
          operation: SESSION_CHANGE_DRAFT_OPERATION,
          businessInput: createInput(fixture, overrides),
          key: `${scenario.key}-draft`
        })).toMatchObject({
          kind: 'outcome',
          terminal: false,
          outcome: {
            class: 'stale_revision',
            kind: 'session.changed',
            retryable: false,
            detail: { code: scenario.code, action: 'create' }
          }
        });
        expect(durableCounts(fixture)).toMatchObject({
          receipts: 0,
          sessions: 0,
          catalogs: 0,
          draftLinks: 0,
          draftTimeline: 0,
          changesetHeads: 0,
          changesetRevisions: 0
        });
      } finally {
        fixture.close();
      }
    }
  });
});
