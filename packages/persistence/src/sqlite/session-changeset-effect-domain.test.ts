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
  REBUILD_CHANGESET_OPERATION,
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
  type EventId,
  type Instant
} from '@jooevents/kernel';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import { planSessionMutation } from '@jooevents/session';
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
import { installSchedulePlacementSchema } from './schedule-placement';
import {
  createSQLiteSessionDraftEffectDomainRegistration,
  installSessionDraftEffectSchema,
  type SQLiteSessionDraftEffectIds
} from './session-draft-effect-domain';
import { installSessionSchema, SQLiteSessionRepository } from './session';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa131');
const otherEventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa132');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa231');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa232');
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfa331';
const trackId = '019c1df7-86b5-769b-bba4-5f7097bfa332';
const otherFormatId = '019c1df7-86b5-769b-bba4-5f7097bfa333';
const otherSessionId = '019c1df7-86b5-769b-bba4-5f7097bfa334';
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa335';
const now = parseInstant('2026-08-13T11:00:00.000Z');
const profile = Object.freeze({ key: 'session-changeset-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-session-changeset-session'
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
    for (const [id, name] of [[eventId, 'Session Event'], [otherEventId, 'Other Event']] as const) {
      sqlite.query<never, [string, string, string, string, number, string]>(`
        INSERT INTO event_spine_heads (
          workspace_id, id, name, timezone, start_date, end_date, version,
          created_by_user_id, created_at_ms, create_plan_digest_sha256
        ) VALUES (?, ?, ?, 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
      `).run(workspaceId, id, name, userId, Date.parse(now), 'a'.repeat(64));
      sqlite.query<never, [string, string]>(`
        INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
      `).run(workspaceId, id);
    }
    sqlite.query<never, [string, string]>(`
      UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
       WHERE workspace_id = ?
    `).run(eventId, workspaceId);
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
  installSessionDraftEffectSchema(sqlite);
  installSessionChangesetEffectSchema(sqlite);
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
      keyBytes: new Uint8Array(32).fill(0x63)
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
      keyBytes: new Uint8Array(32).fill(0x64)
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
    sessions,
    lifecycle: lifecycleRegistration.lifecycleStore,
    ownerResolution: lifecycleRegistration.ownerResolution,
    subjectRelationships: lifecycleRegistration.subjectRelationships,
    close: () => sqlite.close(),
    advance(milliseconds: number) {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + milliseconds).toISOString());
    },
    catalog(scopeEventId: EventId = eventId) {
      const value = draftRegistration.sessionRead.readSessionCatalog({
        workspaceId, eventId: scopeEventId
      });
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
  const state = vocabulary.readVocabulary(authorInput.scope);
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
    lifecycleLinks: count(fixture.sqlite, 'session_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'session_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'session_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'session_changeset_timeline'),
    commitLinks: count(fixture.sqlite, 'changeset_commit_links')
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

function transitionInput(
  fixture: ReturnType<typeof openFixture>,
  sessionId: string,
  to: 'collecting' | 'programmed'
) {
  const catalog = fixture.catalog();
  const session = catalog.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new TypeError('session_head_fixture_missing');
  return {
    action: 'transition',
    expectedCatalogVersion: catalog.version,
    expectedCatalogDigestSha256: catalog.digestSha256,
    sessionId,
    expectedSessionVersion: session.version,
    expectedSessionDigestSha256: session.digestSha256,
    to
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

async function draftAndPropose(
  fixture: ReturnType<typeof openFixture>,
  businessInput: unknown,
  key: string
) {
  const draft = sessionDraftOperationResultSchema.parse(await fixture.effect({
    operation: SESSION_CHANGE_DRAFT_OPERATION,
    businessInput,
    key: `${key}-draft`
  }));
  if (draft.kind !== 'success') throw new TypeError('session_draft_failed');
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const sessionId = draft.data.safeDiff.after?.id;
  if (sessionId === undefined) throw new TypeError('session_draft_image_missing');
  const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: PROPOSE_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: draft.data.headVersion },
    key: `${key}-propose`
  }));
  if (proposed.kind !== 'success') throw new TypeError('session_propose_failed');
  return { draft, selector, sessionId };
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

describe('ordinary SQLite Session changeset effect domain', () => {
  test('commits the exact drafted image, advances lifecycle, and replays idempotently', async () => {
    const fixture = openFixture();
    try {
      const created = await draftAndPropose(fixture, createInput(fixture), 'keynote');
      if (created.draft.kind !== 'success') throw new TypeError('session_draft_failed');
      const planned = created.draft.data.safeDiff.after;
      const record = fixture.lifecycle.read(created.selector.changesetId);
      if (!record) throw new TypeError('session_changeset_record_missing');
      expect(await fixture.ownerResolution.resolveOwner(record)).toMatchObject({ id: 'session' });
      expect(fixture.catalog()).toMatchObject({ version: 1, sessions: [] });

      const commitInput = { ...created.selector, expectedHeadVersion: 2 };
      const committed = await commit(fixture, created.selector, 'keynote-commit');
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 3 }
      });
      expect(fixture.catalog()).toMatchObject({
        version: 2,
        sessions: [planned]
      });
      expect(JSON.parse(fixture.sqlite.query<{ readonly payload_json: string }, []>(`
        SELECT payload_json FROM session_changeset_domain_facts
      `).get()?.payload_json ?? 'null')).toMatchObject({
        action: 'create',
        catalogVersion: 2,
        session: { id: created.sessionId, lifecycle: 'draft', version: 1 }
      });
      const afterCommit = durableCounts(fixture);
      expect(afterCommit).toMatchObject({
        sessions: 1,
        catalogs: 1,
        lifecycleLinks: 2,
        facts: 1,
        pointers: 1,
        timeline: 2,
        commitLinks: 1
      });

      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'keynote-commit'
      })).toEqual(committed);
      expect(durableCounts(fixture)).toEqual(afterCommit);

      for (const [to, key] of [['collecting', 'collect'], ['programmed', 'program']] as const) {
        fixture.advance(60_000);
        const moved = await draftAndPropose(
          fixture,
          transitionInput(fixture, created.sessionId, to),
          key
        );
        expect(await commit(fixture, moved.selector, `${key}-commit`)).toMatchObject({
          kind: 'success',
          data: { action: 'commit' }
        });
        expect(fixture.catalog().sessions[0]).toMatchObject({ id: created.sessionId, lifecycle: to });
      }
      expect(fixture.catalog()).toMatchObject({
        version: 4,
        sessions: [{ id: created.sessionId, lifecycle: 'programmed', version: 3 }]
      });
      expect(count(fixture.sqlite, 'sessions')).toBe(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a Session catalog guard that changed after the draft without writing', async () => {
    const fixture = openFixture();
    try {
      const stale = await draftAndPropose(fixture, createInput(fixture), 'stale');
      const other = await draftAndPropose(
        fixture,
        createInput(fixture, { title: 'Closing Panel' }),
        'other'
      );
      expect(await commit(fixture, other.selector, 'other-commit')).toMatchObject({
        kind: 'success',
        data: { action: 'commit' }
      });
      const before = durableCounts(fixture);
      expect(await commit(fixture, stale.selector, 'stale-commit')).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed', subjectId: `session_catalog:${eventId}` }
        }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.lifecycle.read(stale.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
      expect(fixture.catalog().sessions).toMatchObject([{ title: 'Closing Panel' }]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a rebuild whose stored author intent no longer plans without writing', async () => {
    const fixture = openFixture();
    try {
      const stale = await draftAndPropose(fixture, createInput(fixture), 'replan');
      const other = await draftAndPropose(
        fixture,
        createInput(fixture, { title: 'Closing Panel' }),
        'replan-other'
      );
      expect(await commit(fixture, other.selector, 'replan-other-commit')).toMatchObject({
        kind: 'success',
        data: { action: 'commit' }
      });
      const before = durableCounts(fixture);
      expect(await fixture.effect({
        operation: REBUILD_CHANGESET_OPERATION,
        businessInput: {
          changesetId: stale.selector.changesetId,
          expectedHeadVersion: 2,
          sourceRevisionId: stale.selector.revisionId,
          sourceRevisionDigest: stale.selector.revisionDigest,
          groups: ['session']
        },
        key: 'replan-rebuild'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'domain_changed' }
        }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.lifecycle.read(stale.selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('compensates a committed create exactly and blocks compensating the compensation', async () => {
    const fixture = openFixture();
    try {
      const created = await draftAndPropose(fixture, createInput(fixture), 'compensated');
      const committed = await commit(fixture, created.selector, 'compensated-commit');
      if (committed.kind !== 'success') throw new TypeError('session_commit_failed');
      const beforeCompensation = fixture.catalog();
      expect(beforeCompensation.sessions).toHaveLength(1);

      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: created.selector.changesetId,
          sourceRevisionId: created.selector.revisionId,
          sourceRevisionDigest: created.selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'compensated-correction'
      }));
      expect(correction).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'exact',
          target: { status: 'draft', operations: [{ safeDiff: { action: 'restore', after: null } }] }
        }
      });
      if (correction.kind !== 'success' || correction.data.action !== 'correction'
          || correction.data.target === null) throw new TypeError('session_correction_missing');
      const correctionSelector = {
        changesetId: correction.data.target.changesetId,
        revisionId: correction.data.target.revisionId,
        revisionDigest: correction.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 1 },
        key: 'compensated-correction-propose'
      })).toMatchObject({ kind: 'success' });
      const compensated = await commit(fixture, correctionSelector, 'compensated-correction-commit');
      if (compensated.kind !== 'success') throw new TypeError('session_compensation_commit_failed');
      expect(fixture.catalog()).toMatchObject({ version: 3, sessions: [] });
      expect(count(fixture.sqlite, 'sessions')).toBe(0);
      expect(JSON.parse(fixture.sqlite.query<{ readonly payload_json: string }, [string]>(`
        SELECT payload_json FROM session_changeset_domain_facts
         WHERE receipt_id = ?
      `).get(compensated.receipt.id)?.payload_json ?? 'null')).toMatchObject({
        action: 'restore',
        catalogVersion: 3,
        session: null
      });

      expect(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: correctionSelector.changesetId,
          sourceRevisionId: correctionSelector.revisionId,
          sourceRevisionDigest: correctionSelector.revisionDigest,
          sourceCommitReceiptId: compensated.receipt.id
        },
        key: 'compensation-of-compensation'
      })).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'blocked',
          target: null,
          evidence: { blockers: [{ reasonKey: 'session.compensation_of_compensation' }] }
        }
      });
      expect(fixture.catalog()).toMatchObject({ version: 3, sessions: [] });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('a placement landing between compensation propose and commit refuses the delete without writing', async () => {
    const fixture = openFixture();
    try {
      const created = await draftAndPropose(
        fixture,
        createInput(fixture, { lifecycle: 'programmed' }),
        'placed-race'
      );
      const committed = await commit(fixture, created.selector, 'placed-race-commit');
      if (committed.kind !== 'success') throw new TypeError('session_commit_failed');

      // Derived and proposed while the Session is unplaced: an exact delete.
      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: created.selector.changesetId,
          sourceRevisionId: created.selector.revisionId,
          sourceRevisionDigest: created.selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'placed-race-correction'
      }));
      expect(correction).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'exact',
          target: { operations: [{ safeDiff: { action: 'restore', after: null } }] }
        }
      });
      if (correction.kind !== 'success' || correction.data.action !== 'correction'
          || correction.data.target === null) throw new TypeError('session_correction_missing');
      const correctionSelector = {
        changesetId: correction.data.target.changesetId,
        revisionId: correction.data.target.revisionId,
        revisionDigest: correction.data.target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 1 },
        key: 'placed-race-correction-propose'
      })).toMatchObject({ kind: 'success' });

      // A concurrent schedule commit places the Session AFTER the compensation
      // was derived and proposed. The placement moves neither the Session
      // digest nor the catalog digest, so no aggregate or guard fences it —
      // only the commit-time reference re-check can.
      placeSessionOnSchedule(fixture, created.sessionId);

      const before = durableCounts(fixture);
      expect(await commit(fixture, correctionSelector, 'placed-race-correction-commit'))
        .toMatchObject({
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
      expect(fixture.catalog().sessions).toMatchObject([
        { id: created.sessionId, lifecycle: 'programmed' }
      ]);
      expect(count(fixture.sqlite, 'schedule_occurrences')).toBe(1);

      // Retry-by-replan reaches the same wall: a fresh correction derived
      // against current state blocks because the Session is placed.
      expect(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: created.selector.changesetId,
          sourceRevisionId: created.selector.revisionId,
          sourceRevisionDigest: created.selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'placed-race-rederive'
      })).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'blocked',
          target: null,
          evidence: { blockers: [{ reasonKey: 'session.placed' }] }
        }
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('blocks deriving a delete compensation for a Session already on the schedule', async () => {
    const fixture = openFixture();
    try {
      const created = await draftAndPropose(
        fixture,
        createInput(fixture, { lifecycle: 'programmed' }),
        'placed-derive'
      );
      const committed = await commit(fixture, created.selector, 'placed-derive-commit');
      if (committed.kind !== 'success') throw new TypeError('session_commit_failed');

      placeSessionOnSchedule(fixture, created.sessionId);

      expect(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: created.selector.changesetId,
          sourceRevisionId: created.selector.revisionId,
          sourceRevisionDigest: created.selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'placed-derive-correction'
      })).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'blocked',
          target: null,
          evidence: { blockers: [{ reasonKey: 'session.placed' }] }
        }
      });
      expect(fixture.catalog().sessions).toMatchObject([
        { id: created.sessionId, lifecycle: 'programmed' }
      ]);
      expect(count(fixture.sqlite, 'schedule_occurrences')).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('leaves another Event scope untouched and denies foreign changeset owner subjects', async () => {
    const fixture = openFixture();
    try {
      applyVocabulary(fixture.vocabulary, fixture.sqlite, {
        action: 'create',
        scope: { workspaceId, eventId: otherEventId },
        expectedSetVersion: 1,
        item: { kind: 'format', id: otherFormatId, name: 'Workshop' }
      });
      const otherScope = { workspaceId, eventId: otherEventId };
      const otherCatalog = fixture.sessions.readSessionCatalog(otherScope);
      const otherVocabulary = fixture.sessions.readSessionVocabulary(otherScope);
      if (!otherCatalog || !otherVocabulary) throw new TypeError('session_other_scope_missing');
      const otherPlan = planSessionMutation({
        catalog: otherCatalog,
        vocabulary: otherVocabulary,
        planningInput: {
          action: 'create',
          scope: otherScope,
          sessionId: otherSessionId,
          actorUserId: userId,
          occurredAt: now,
          expectedCatalogVersion: otherCatalog.version,
          expectedCatalogDigestSha256: otherCatalog.digestSha256,
          title: 'Other Event Session',
          plannedDurationMinutes: 30,
          lifecycle: 'collecting',
          formatId: otherFormatId,
          trackId: null
        }
      });
      transaction(fixture.sqlite, () => fixture.sessions.applySessionPlan(otherPlan));
      const isolated = fixture.catalog(otherEventId);

      const created = await draftAndPropose(fixture, createInput(fixture), 'isolated');
      expect(await commit(fixture, created.selector, 'isolated-commit')).toMatchObject({
        kind: 'success',
        data: { action: 'commit' }
      });
      expect(fixture.catalog(otherEventId)).toEqual(isolated);
      expect(fixture.sqlite.query<{ readonly event_id: string; readonly id: string }, []>(`
        SELECT event_id, id FROM sessions ORDER BY event_id, id
      `).all()).toEqual([
        { event_id: eventId, id: created.sessionId },
        { event_id: otherEventId, id: otherSessionId }
      ]);

      for (const denied of [
        { workspaceId, eventId: otherEventId, id: 'schedule_placement' },
        { workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001'), eventId, id: 'session' }
      ] as const) {
        expect(fixture.subjectRelationships.validateSubject({
          sqlite: fixture.sqlite,
          workspaceId: denied.workspaceId,
          eventId: denied.eventId,
          userId,
          subject: { kind: 'domain', domain: 'changeset', entity: 'owner', id: denied.id },
          evaluatedAt: now
        })).toMatchObject({ kind: 'denied', reason: 'cross_scope' });
      }
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rolls back Session state, evidence, receipt, and changeset commit after a late failure', async () => {
    const fixture = openFixture();
    try {
      const created = await draftAndPropose(fixture, createInput(fixture), 'atomic');
      const before = durableCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER session_joined_fail_head
        BEFORE INSERT ON sessions
        BEGIN SELECT RAISE(ABORT, 'injected session head failure'); END;
      `);
      await expect(commit(fixture, created.selector, 'atomic-commit'))
        .rejects.toThrow('Operation execution failed during handler.');
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.catalog()).toMatchObject({ version: 1, sessions: [] });
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
