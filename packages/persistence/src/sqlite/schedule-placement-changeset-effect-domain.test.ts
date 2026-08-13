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
  GET_CHANGESET_DIFF_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  changesetDiffOperationResultSchema,
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
  issueProgramVocabularyOrdinaryPolicy,
  planProgramVocabularyMutation,
  type ProgramVocabularyMutationPlan
} from '@jooevents/program';
import {
  parseSchedulePlacementScope,
  parseScheduleSessionId,
  type ProgrammedSessionIdentityPort,
  type SchedulePlacementScope,
  type ScheduleSessionId
} from '@jooevents/schedule';
import {
  SCHEDULE_PLACEMENT_DRAFT_OPERATION,
  SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE,
  SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_READ_ACCESS_POLICY,
  SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
  createSchedulePlacementOperationModule,
  schedulePlacementDraftOperationResultSchema,
  schedulePlacementSnapshotReadResultSchema
} from '@jooevents/schedule-operations';
import {
  createSQLiteChangesetLifecycleEffectDomainRouter
} from './changeset-lifecycle-effect-domain-router';
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
  createSQLiteProgramVocabularyChangesetEffectDomainRegistration,
  installProgramVocabularyChangesetEffectSchema
} from './program-vocabulary-changeset-effect-domain';
import {
  createSQLiteSchedulePlacementChangesetEffectDomainRegistration,
  installSchedulePlacementChangesetEffectSchema,
  type SQLiteSchedulePlacementChangesetEffectIds
} from './schedule-placement-changeset-effect-domain';
import {
  createSQLiteSchedulePlacementDraftEffectDomainRegistration,
  installSchedulePlacementDraftEffectSchema,
  type SQLiteSchedulePlacementDraftEffectIds
} from './schedule-placement-draft-effect-domain';
import {
  createSQLiteScheduleRoomReferenceAdapter,
  installSchedulePlacementSchema,
  SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR
} from './schedule-placement';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfa301';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfa501';
const session2Id = '019c1df7-86b5-769b-bba4-5f7097bfa502';
const now = parseInstant('2026-08-12T10:00:00.000Z');
const profile = Object.freeze({ key: 'schedule-joined-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-schedule-session'
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

function seed(
  sqlite: ReturnType<typeof openSQLite>['sqlite'],
  currentEvent: boolean
): void {
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Schedule workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Schedule operator', 1, 1, 1);
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
  installProgramVocabularyChangesetEffectSchema(sqlite);
  installSchedulePlacementSchema(sqlite);
  installSchedulePlacementDraftEffectSchema(sqlite);
  installSchedulePlacementChangesetEffectSchema(sqlite);
  seed(sqlite, options.currentEvent !== false);

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
  applyVocabulary(vocabulary, sqlite, {
    action: 'create',
    scope: { workspaceId, eventId },
    expectedSetVersion: 1,
    item: { kind: 'room', id: roomId, name: 'Main Hall', capacity: 240 }
  });

  const scope = parseSchedulePlacementScope({ workspaceId, eventId });
  const sessions: ProgrammedSessionIdentityPort = Object.freeze({
    readProgrammedSession(requestScope: SchedulePlacementScope, requested: ScheduleSessionId) {
      if (requestScope.workspaceId !== scope.workspaceId
          || requestScope.eventId !== scope.eventId
          || (requested !== sessionId && requested !== session2Id)) return undefined;
      return Object.freeze({
        scope,
        id: parseScheduleSessionId(requested),
        lifecycle: 'programmed' as const
      });
    }
  });
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteSchedulePlacementDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newOccurrenceId: next,
    newPreparationHandle: next,
    newTimelineId: next
  };
  const lifecycleIds: SQLiteSchedulePlacementChangesetEffectIds = {
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
  const draftRegistration = createSQLiteSchedulePlacementDraftEffectDomainRegistration({
    sqlite, workspaceId, sessions, vocabulary, eventRelationships, ids: draftIds
  });
  const lifecycleRegistration =
    createSQLiteSchedulePlacementChangesetEffectDomainRegistration({
      sqlite, workspaceId, sessions, vocabulary, eventRelationships, ids: lifecycleIds
    });
  const programLifecycleRegistration =
    createSQLiteProgramVocabularyChangesetEffectDomainRegistration({
      sqlite,
      workspaceId,
      policy: issueProgramVocabularyOrdinaryPolicy({
        key: 'program_vocabulary.schedule_router_conformance',
        version: 1,
        ordinaryRisk: 'low',
        mergeRisk: 'normal',
        approval: { ordinary: 'none', merge: 'none' }
      }),
      referenceRegistry,
      contributors,
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
  const routedLifecycle = createSQLiteChangesetLifecycleEffectDomainRouter([
    {
      ownerId: 'program_vocabulary',
      adapter: programLifecycleRegistration.adapter,
      ownerResolution: programLifecycleRegistration.ownerResolution,
      subjectRelationships: programLifecycleRegistration.subjectRelationships
    },
    {
      ownerId: 'schedule_placement',
      adapter: lifecycleRegistration.adapter,
      ownerResolution: lifecycleRegistration.ownerResolution,
      subjectRelationships: lifecycleRegistration.subjectRelationships
    }
  ]);
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    routedLifecycle
  ]);

  const authority: Parameters<typeof createSchedulePlacementOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (input.evidence.kind !== 'operator') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      const grant = input.lane.policy.key === SCHEDULE_PLACEMENT_READ_ACCESS_POLICY.key
        ? 'schedule.read'
        : 'schedule.manage';
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: grant })]),
          evidenceIds: Object.freeze(['schedule-membership.current']),
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
        verifierSha256: createHash('sha256').update(`schedule-key:${raw}`).digest('hex')
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
      resolveCurrentEvent(requestedWorkspaceId) {
        if (requestedWorkspaceId !== workspaceId) {
          throw new TypeError('schedule_test_workspace_mismatch');
        }
        const current = new SQLiteEventSpineRepository(sqlite)
          .readCurrentEventState(workspaceId);
        if (!current) throw new TypeError('schedule_test_event_set_missing');
        return Object.freeze({
          ...(current.currentEvent ? { eventId: current.currentEvent.id } : {}),
          evidenceIds: Object.freeze([
            `event-spine-set:${workspaceId}@${current.eventSet.version}`,
            ...(current.currentEvent
              ? [`event-spine-root:${current.currentEvent.id}@${current.currentEvent.version}`]
              : [])
          ])
        });
      }
    },
    scheduleRead: draftRegistration.scheduleRead,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: SCHEDULE_PLACEMENT_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x47)
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
      keyBytes: new Uint8Array(32).fill(0x48)
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
  let correlation = 0x900;

  return {
    sqlite,
    vocabulary,
    lifecycle: lifecycleRegistration.lifecycleStore,
    ownerResolution: routedLifecycle.ownerResolution,
    scope,
    close: () => sqlite.close(),
    advance(milliseconds: number) {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + milliseconds).toISOString());
    },
    async read(operation: { readonly name: string; readonly version: number }, businessInput: unknown) {
      const composed = await runtime;
      return composed.readExecutor.execute({
        operationName: operation.name,
        operationVersion: operation.version,
        surface: 'operator_http',
        correlationId: uuid(correlation++),
        businessInput,
        verifiedEvidence: evidence
      });
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
  if (!state) throw new TypeError('schedule_vocabulary_fixture_missing');
  const plan = planProgramVocabularyMutation({
    authorInput,
    state,
    referenceRegistry: vocabulary.referenceRegistry,
    referenceSource: vocabulary
  });
  transaction(sqlite, () => vocabulary.applyVocabularyPlan(plan));
  return plan;
}

async function draftAndPropose(fixture: ReturnType<typeof openFixture>, key: string) {
  const draft = schedulePlacementDraftOperationResultSchema.parse(await fixture.effect({
    operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
    businessInput: {
      action: 'place',
      expectedScheduleVersion: 1,
      sessionId,
      roomId,
      startAt: '2026-11-01T09:00:00.000Z',
      endAt: '2026-11-01T10:00:00.000Z'
    },
    key: `${key}-draft`
  }));
  if (draft.kind !== 'success') throw new TypeError('schedule_draft_failed');
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: PROPOSE_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: 1 },
    key: `${key}-propose`
  }));
  if (proposed.kind !== 'success') throw new TypeError('schedule_propose_failed');
  return { draft, selector };
}

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    occurrences: count(fixture.sqlite, 'schedule_occurrences'),
    scheduleSets: count(fixture.sqlite, 'schedule_placement_sets'),
    lifecycleLinks: count(fixture.sqlite, 'schedule_placement_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'schedule_placement_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'schedule_placement_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'schedule_placement_changeset_timeline'),
    commitLinks: count(fixture.sqlite, 'changeset_commit_links')
  };
}

describe('ordinary SQLite Schedule placement changeset effect domain', () => {
  test('returns the typed current-Event prerequisite without allocating draft state', async () => {
    const fixture = openFixture({ currentEvent: false });
    try {
      expect(await fixture.effect({
        operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
        businessInput: {
          action: 'place',
          expectedScheduleVersion: 1,
          sessionId,
          roomId,
          startAt: '2026-11-01T09:00:00.000Z',
          endAt: '2026-11-01T10:00:00.000Z'
        },
        key: 'event-required-draft'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'schedule.event_required' }
      });
      expect(durableCounts(fixture)).toEqual({
        receipts: 0,
        occurrences: 0,
        scheduleSets: 0,
        lifecycleLinks: 0,
        facts: 0,
        pointers: 0,
        timeline: 0,
        commitLinks: 0
      });
      expect(count(fixture.sqlite, 'schedule_placement_draft_receipt_links')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('runs draft, safe diff, propose, exact commit, effective range read, and overlap refusal', async () => {
    const fixture = openFixture();
    try {
      const { draft, selector } = await draftAndPropose(fixture, 'main-hall');
      const record = fixture.lifecycle.read(selector.changesetId);
      if (!record) throw new TypeError('schedule_changeset_record_missing');
      expect(await fixture.ownerResolution.resolveOwner(record)).toMatchObject({
        id: 'schedule_placement'
      });
      const frozen = record?.revisions[0]?.revision.operations[0];
      expect(frozen?.aggregateRefs).toEqual([
        { id: `program_room:${roomId}`, version: 1 }
      ]);
      expect(frozen?.guardRefs.map((guard) => guard.id)).toEqual([
        `event_schedule:${eventId}`,
        expect.stringMatching(new RegExp(`^schedule_room_query:${eventId}:${roomId}$`)),
        `program_vocabulary_set:${eventId}`
      ]);
      expect(changesetDiffOperationResultSchema.parse(await fixture.read(
        GET_CHANGESET_DIFF_OPERATION,
        selector
      ))).toMatchObject({
        kind: 'success',
        data: { status: 'proposed', headVersion: 2, operations: [{ kind: 'schedule.placement.mutate' }] }
      });

      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'main-hall-commit'
      }));
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 3 }
      });
      expect(schedulePlacementSnapshotReadResultSchema.parse(await fixture.read(
        SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
        {
          startAt: '2026-11-01T08:00:00.000Z',
          endAt: '2026-11-01T11:00:00.000Z',
          limit: 20
        }
      ))).toMatchObject({
        kind: 'success',
        data: {
          scheduleVersion: 2,
          occurrences: [{
            id: draft.data.safeDiff.after?.id,
            sessionId,
            roomId,
            version: 1
          }]
        }
      });
      expect(durableCounts(fixture)).toMatchObject({
        occurrences: 1,
        scheduleSets: 1,
        lifecycleLinks: 2,
        facts: 1,
        pointers: 1,
        timeline: 2,
        commitLinks: 1
      });

      const beforeOverlap = durableCounts(fixture);
      expect(await fixture.effect({
        operation: SCHEDULE_PLACEMENT_DRAFT_OPERATION,
        businessInput: {
          action: 'place',
          expectedScheduleVersion: 2,
          sessionId: session2Id,
          roomId,
          startAt: '2026-11-01T09:30:00.000Z',
          endAt: '2026-11-01T10:30:00.000Z'
        },
        key: 'overlap-draft'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'conflict',
          kind: 'schedule_room_overlap',
          detail: {
            severity: 'block',
            roomId,
            conflicts: [{ occurrenceId: draft.data.safeDiff.after?.id }]
          }
        }
      });
      expect(durableCounts(fixture)).toEqual(beforeOverlap);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses exact room item and vocabulary set drift with zero Schedule/lifecycle writes', async () => {
    for (const mutation of ['edit', 'retire', 'set_change'] as const) {
      const fixture = openFixture();
      try {
        const { selector } = await draftAndPropose(fixture, mutation);
        const state = fixture.vocabulary.readVocabulary(fixture.scope);
        const room = state?.rooms.find((candidate) => candidate.id === roomId);
        if (!state || !room) throw new TypeError('schedule_room_fixture_missing');
        if (mutation === 'edit') {
          applyVocabulary(fixture.vocabulary, fixture.sqlite, {
            action: 'edit', scope: fixture.scope, kind: 'room', id: roomId,
            expectedSetVersion: state.setVersion, expectedItemVersion: room.version,
            changes: { name: 'Edited Hall', capacity: 200 }
          });
        } else if (mutation === 'retire') {
          applyVocabulary(fixture.vocabulary, fixture.sqlite, {
            action: 'retire', scope: fixture.scope, kind: 'room', id: roomId,
            expectedSetVersion: state.setVersion, expectedItemVersion: room.version
          });
        } else {
          applyVocabulary(fixture.vocabulary, fixture.sqlite, {
            action: 'create', scope: fixture.scope, expectedSetVersion: state.setVersion,
            item: { kind: 'room', id: uuid(0x701), name: 'Unrelated Room', capacity: 40 }
          });
        }
        const before = durableCounts(fixture);
        expect(await fixture.effect({
          operation: COMMIT_CHANGESET_OPERATION,
          businessInput: { ...selector, expectedHeadVersion: 2 },
          key: `${mutation}-commit`
        })).toMatchObject({
          kind: 'outcome',
          terminal: false,
          outcome: {
            class: 'stale_revision',
            kind: 'changeset.lifecycle_refused',
            detail: mutation === 'set_change'
              ? { code: 'guard_changed', subjectId: `program_vocabulary_set:${eventId}` }
              : { code: 'base_version_changed', subjectId: `program_room:${roomId}` }
          }
        });
        expect(durableCounts(fixture)).toEqual(before);
        expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
          head: { status: 'proposed', version: 2 }
        });
      } finally {
        fixture.close();
      }
    }
  });

  test('a late occurrence failure rolls back Schedule state, receipt, evidence, and changeset commit', async () => {
    const fixture = openFixture();
    try {
      const { selector } = await draftAndPropose(fixture, 'atomic');
      const before = durableCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER schedule_joined_fail_occurrence
        BEFORE INSERT ON schedule_occurrences
        BEGIN SELECT RAISE(ABORT, 'injected schedule occurrence failure'); END;
      `);
      await expect(fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'atomic-commit'
      })).rejects.toThrow('Operation execution failed during handler.');
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
