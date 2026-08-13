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
  PROPOSE_CHANGESET_OPERATION,
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
  openSQLite
} from '@jooevents/persistence';
import {
  createSQLiteChangesetLifecycleEffectDomainRouter
} from '@jooevents/persistence/changeset-lifecycle-effect-domain-router';
import {
  installSQLiteChangesetLifecycleSchema
} from '@jooevents/persistence/changeset-lifecycle';
import type {
  ProgrammedSessionIdentityPort,
  SchedulePlacementScope,
  ScheduleSessionId
} from '@jooevents/schedule';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from '@jooevents/persistence/event-spine';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from '@jooevents/persistence/program-vocabulary';
import {
  createSQLiteSchedulePlacementChangesetEffectDomainRegistration,
  installSchedulePlacementChangesetEffectSchema
} from '@jooevents/persistence/schedule-placement-changeset-effect-domain';
import {
  createSQLiteSchedulePlacementDraftEffectDomainRegistration,
  installSchedulePlacementDraftEffectSchema
} from '@jooevents/persistence/schedule-placement-draft-effect-domain';
import {
  createSQLiteScheduleRoomReferenceAdapter,
  installSchedulePlacementSchema,
  SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR
} from '@jooevents/persistence/schedule-placement';
import {
  createSQLiteEffectDomainAdapterRegistry,
  SQLiteEffectUnitOfWorkPort
} from '@jooevents/persistence/sqlite-effect-unit-of-work';
import {
  installFoundationTrialUnitOfWorkSchema
} from '@jooevents/persistence/testing/foundation-trial-uow';
import {
  createProgramReferenceContributorRegistry,
  planProgramVocabularyMutation
} from '@jooevents/program';
import {
  SCHEDULE_PLACEMENT_DRAFT_OPERATION,
  SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE,
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
  createSchedulePlacementOperationModule,
  schedulePlacementDraftOperationResultSchema,
  schedulePlacementSnapshotReadResultSchema
} from '@jooevents/schedule-operations';
import { createOperatorOperationsHttpAdapter } from './operator-operations';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const now = parseInstant('2026-08-12T10:00:00.000Z');
const profile = Object.freeze({ key: 'schedule-http-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-schedule-http-session'
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
  `).run(workspaceId, 'Schedule HTTP workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Schedule HTTP operator', 1, 1, 1);
  transaction(sqlite, () => {
    sqlite.query<never, [string]>(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, NULL)
    `).run(workspaceId);
    sqlite.query<never, [string, string, string, number, string]>(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date, version,
        created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, 'Schedule Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
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

async function openFixture() {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSchedulePlacementSchema(sqlite);
  installSchedulePlacementDraftEffectSchema(sqlite);
  installSchedulePlacementChangesetEffectSchema(sqlite);
  seed(sqlite);

  let currentTime: Instant = now;
  const roomReferences = createSQLiteScheduleRoomReferenceAdapter({
    sqlite,
    attribution: () => ({ actorUserId: userId, occurredAt: currentTime })
  });
  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR],
    contributors: [SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR]
  });
  const contributors = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite,
    expected: [SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR],
    adapters: [roomReferences]
  });
  const vocabulary = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    contributors,
    () => ({ actorUserId: userId, occurredAt: currentTime })
  );
  const vocabularyState = vocabulary.readVocabulary({ workspaceId, eventId });
  if (!vocabularyState) throw new TypeError('schedule_http_vocabulary_missing');
  const roomPlan = planProgramVocabularyMutation({
    state: vocabularyState,
    referenceRegistry,
    referenceSource: vocabulary,
    authorInput: {
      action: 'create', scope: { workspaceId, eventId }, expectedSetVersion: 1,
      item: { kind: 'room', id: roomId, name: 'Main Hall', capacity: 240 }
    }
  });
  transaction(sqlite, () => vocabulary.applyVocabularyPlan(roomPlan));

  const sessions: ProgrammedSessionIdentityPort = Object.freeze({
    readProgrammedSession(scope: SchedulePlacementScope, requested: ScheduleSessionId) {
      if (scope.workspaceId !== workspaceId
          || scope.eventId !== eventId
          || requested !== sessionId) return undefined;
      return Object.freeze({ scope, id: requested, lifecycle: 'programmed' as const });
    }
  });
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const eventRelationships = createSQLiteEventSpineOperatorEventRelationshipSource();
  const draftRegistration = createSQLiteSchedulePlacementDraftEffectDomainRegistration({
    sqlite,
    workspaceId,
    sessions,
    vocabulary,
    eventRelationships,
    ids: {
      newChangesetId: next,
      newRevisionId: next,
      newOccurrenceId: next,
      newPreparationHandle: next,
      newTimelineId: next
    }
  });
  const lifecycleRegistration =
    createSQLiteSchedulePlacementChangesetEffectDomainRegistration({
      sqlite,
      workspaceId,
      sessions,
      vocabulary,
      eventRelationships,
      ids: {
        newChangesetId: next,
        newRevisionId: next,
        newApprovalId: next,
        newCorrectionAttemptId: next,
        newPreparationHandle: next,
        newTimelineId: next,
        newFactId: next,
        newPointerId: next
      }
    });
  const routedLifecycle = createSQLiteChangesetLifecycleEffectDomainRouter([{
    ownerId: 'schedule_placement',
    adapter: lifecycleRegistration.adapter,
    ownerResolution: lifecycleRegistration.ownerResolution,
    subjectRelationships: lifecycleRegistration.subjectRelationships
  }]);
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    routedLifecycle
  ]);
  let authorityChecks = 0;
  const authority: Parameters<typeof createSchedulePlacementOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      authorityChecks += 1;
      if (input.evidence.kind !== 'operator') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      const permission = input.lane.policy.key === SCHEDULE_PLACEMENT_READ_ACCESS_POLICY.key
        ? 'schedule.read'
        : 'schedule.manage';
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: permission })]),
          evidenceIds: Object.freeze(['schedule-http-membership.current']),
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
        verifierSha256: createHash('sha256').update(`schedule-http-key:${raw}`).digest('hex')
      });
    }
  };
  const scheduleModule = createSchedulePlacementOperationModule({
    workspaceId,
    policies: {
      read: SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
      manage: SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY
    },
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] })
    },
    scheduleRead: draftRegistration.scheduleRead,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x49)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const changesetModule = createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority,
    lifecycleStore: lifecycleRegistration.lifecycleStore,
    ownerResolution: routedLifecycle.ownerResolution,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x4a)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => currentTime
  });
  let receiptId = 0x800;
  const runtime = await createApplicationOperationRuntime({
    source: composeOperationRegistryModules([scheduleModule, changesetModule]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => currentTime },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let evidenceChecks = 0;
  const http = createOperatorOperationsHttpAdapter({
    operations: runtime,
    evidence: {
      verify() {
        evidenceChecks += 1;
        return Object.freeze({ kind: 'verified' as const, evidence });
      }
    }
  });
  return {
    sqlite,
    http,
    counts: () => Object.freeze({
      draftLinks: count(sqlite, 'schedule_placement_draft_receipt_links'),
      lifecycleLinks: count(sqlite, 'schedule_placement_changeset_receipt_links'),
      occurrences: count(sqlite, 'schedule_occurrences'),
      receipts: count(sqlite, 'foundation_trial_operation_receipts')
    }),
    checks: () => Object.freeze({ authority: authorityChecks, evidence: evidenceChecks }),
    close: () => sqlite.close()
  };
}

function jsonRequest(body: unknown, key: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-correlation-id': uuid(0x900)
    },
    body: JSON.stringify(body)
  };
}

describe('Schedule placement operator HTTP contract', () => {
  test('serves strict query read and registered draft/propose/commit paths through real SQLite', async () => {
    const fixture = await openFixture();
    try {
      const initial = await fixture.http.request(
        '/api/events/current/schedule/placements'
          + '?startAt=2026-11-01T08%3A00%3A00.000Z'
          + '&endAt=2026-11-01T11%3A00%3A00.000Z&limit=20'
      );
      expect(initial.status).toBe(200);
      expect(schedulePlacementSnapshotReadResultSchema.parse(await initial.json())).toMatchObject({
        kind: 'success', data: { scheduleVersion: 1, occurrences: [] }
      });

      const draftedResponse = await fixture.http.request(
        '/api/events/current/schedule/placements/drafts',
        jsonRequest({
          action: 'place',
          expectedScheduleVersion: 1,
          sessionId,
          roomId,
          startAt: '2026-11-01T09:00:00.000Z',
          endAt: '2026-11-01T10:00:00.000Z'
        }, 'schedule-http-draft')
      );
      expect(draftedResponse.status).toBe(200);
      const drafted = schedulePlacementDraftOperationResultSchema.parse(await draftedResponse.json());
      if (drafted.kind !== 'success') throw new TypeError('schedule_http_draft_failed');
      const selector = {
        changesetId: drafted.data.changesetId,
        revisionId: drafted.data.revision.id,
        revisionDigest: drafted.data.revision.digestSha256
      };

      const proposedResponse = await fixture.http.request(
        '/api/changesets/proposals',
        jsonRequest({ ...selector, expectedHeadVersion: 1 }, 'schedule-http-propose')
      );
      expect(proposedResponse.status).toBe(200);
      expect(changesetLifecycleOperationResultSchema.parse(await proposedResponse.json()))
        .toMatchObject({ kind: 'success', data: { action: 'propose' } });

      const committedResponse = await fixture.http.request(
        '/api/changesets/commits',
        jsonRequest({ ...selector, expectedHeadVersion: 2 }, 'schedule-http-commit')
      );
      expect(committedResponse.status).toBe(200);
      expect(changesetLifecycleOperationResultSchema.parse(await committedResponse.json()))
        .toMatchObject({ kind: 'success', data: { action: 'commit' } });

      const effective = await fixture.http.request(
        '/api/events/current/schedule/placements'
          + '?startAt=2026-11-01T08%3A00%3A00.000Z'
          + '&endAt=2026-11-01T11%3A00%3A00.000Z&limit=20'
      );
      expect(effective.status).toBe(200);
      expect(schedulePlacementSnapshotReadResultSchema.parse(await effective.json())).toMatchObject({
        kind: 'success',
        data: { scheduleVersion: 2, occurrences: [{ sessionId, roomId }] }
      });
      expect(fixture.counts()).toEqual({
        draftLinks: 1, lifecycleLinks: 2, occurrences: 1, receipts: 3
      });
    } finally {
      fixture.close();
    }
  });

  test('rejects repeated/non-decimal query values and caller-supplied scope or generated IDs', async () => {
    const fixture = await openFixture();
    try {
      const before = fixture.counts();
      for (const query of [
        'limit=20&limit=30',
        'limit=1e2',
        'limit=',
        `limit=20&workspaceId=${workspaceId}`
      ]) {
        const response = await fixture.http.request(
          '/api/events/current/schedule/placements'
            + '?startAt=2026-11-01T08%3A00%3A00.000Z'
            + `&endAt=2026-11-01T11%3A00%3A00.000Z&${query}`
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          kind: 'transport_error', code: 'invalid_request', retryable: false
        });
      }

      const forged = await fixture.http.request(
        '/api/events/current/schedule/placements/drafts',
        jsonRequest({
          action: 'place',
          expectedScheduleVersion: 1,
          sessionId,
          roomId,
          startAt: '2026-11-01T09:00:00.000Z',
          endAt: '2026-11-01T10:00:00.000Z',
          scope: { workspaceId, eventId },
          occurrenceId: uuid(0x601),
          changesetId: uuid(0x602),
          revisionId: uuid(0x603),
          receiptId: uuid(0x604),
          actorUserId: userId,
          approval: { requirement: 'none' }
        }, 'schedule-http-forged-authority')
      );
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({
        kind: 'transport_error', code: 'invalid_request', retryable: false
      });
      expect(fixture.counts()).toEqual(before);
      // Evidence is verified at the protocol edge, but schema refusal happens
      // before current authority or transaction-bound authority is consulted.
      expect(fixture.checks()).toEqual({ authority: 0, evidence: 5 });
    } finally {
      fixture.close();
    }
  });
});
