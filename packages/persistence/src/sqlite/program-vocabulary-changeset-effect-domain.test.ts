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
  APPROVE_CHANGESET_REVISION_OPERATION,
  COMMIT_CHANGESET_OPERATION,
  DRAFT_CHANGESET_CORRECTION_OPERATION,
  GET_CHANGESET_DIFF_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  REBUILD_CHANGESET_OPERATION,
  changesetDiffOperationResultSchema,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  createProgramReferenceContributorRegistry,
  issueProgramVocabularyOrdinaryPolicy
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
  createProgramVocabularyOperationModule,
  programVocabularyDraftOperationResultSchema
} from '@jooevents/program-operations';
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
import { openSQLite } from './database';
import {
  installSQLiteChangesetLifecycleSchema
} from './changeset-lifecycle';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
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
  installProgramVocabularyChangesetEffectSchema,
  type ProgramVocabularyApproverAuthoritySource,
  type SQLiteProgramVocabularyChangesetEffectIds
} from './program-vocabulary-changeset-effect-domain';
import {
  createSQLiteProgramVocabularyDraftEffectDomainRegistration,
  installProgramVocabularyDraftEffectSchema,
  type SQLiteProgramVocabularyDraftEffectIds
} from './program-vocabulary-draft-effect-domain';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const approverUserId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa203');
const approverMembershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa204');
const now = parseInstant('2026-08-12T10:00:00.000Z');
const profile = Object.freeze({ key: 'changeset-joined-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-session-handle'
});
const approverEvidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-approver-session-handle'
});
const referenceRegistry = createProgramReferenceContributorRegistry({
  expected: [], contributors: []
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function seed(sqlite: ReturnType<typeof openSQLite>['sqlite']): void {
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Primary workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Program owner', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(approverUserId, 'Program approver', 1, 1, 1);
  sqlite.exec('BEGIN IMMEDIATE;');
  sqlite.query<never, [string]>(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)
  `).run(workspaceId);
  sqlite.query<never, [string, string, string, number, string]>(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Program Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query<never, [string, string]>(`
    INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
  `).run(workspaceId, eventId);
  sqlite.query<never, [string, string]>(`
    UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ? WHERE workspace_id = ?
  `).run(eventId, workspaceId);
  sqlite.exec('COMMIT;');
}

function openFixture(options: {
  readonly ordinaryApproval?: 'none' | 'distinct_current_human';
  readonly mergeApproval?: 'none' | 'distinct_current_human';
  readonly enableApproval?: boolean;
} = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installProgramVocabularyDraftEffectSchema(sqlite);
  installProgramVocabularyChangesetEffectSchema(sqlite);
  seed(sqlite);
  const contributors = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite, expected: [], adapters: []
  });
  const policy = issueProgramVocabularyOrdinaryPolicy({
    key: 'program_vocabulary.same_operator',
    version: 1,
    ordinaryRisk: 'low',
    mergeRisk: 'normal',
    approval: {
      ordinary: options.ordinaryApproval ?? 'none',
      merge: options.mergeApproval ?? 'none'
    }
  });
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteProgramVocabularyDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newVocabularyItemId: next
  };
  const lifecycleIds: SQLiteProgramVocabularyChangesetEffectIds = {
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
  const draftRegistration = createSQLiteProgramVocabularyDraftEffectDomainRegistration({
    sqlite,
    workspaceId,
    policy,
    referenceRegistry,
    contributors,
    eventRelationships,
    ids: draftIds
  });
  const lifecycleRegistration =
    createSQLiteProgramVocabularyChangesetEffectDomainRegistration({
      sqlite,
      workspaceId,
      policy,
      referenceRegistry,
      contributors,
      eventRelationships,
      ids: lifecycleIds,
      approverAuthority: Object.freeze({
        isCurrentlyAuthorized(input:
          Parameters<ProgramVocabularyApproverAuthoritySource['isCurrentlyAuthorized']>[0]) {
          const { sqlite: received, principalKey } = input;
          if (received !== sqlite || principalKey !== `workspace_user:${approverUserId}`) {
            return false;
          }
          return received.query<{ readonly status: string }, [string]>(`
            SELECT status FROM users WHERE id = ?
          `).get(approverUserId)?.status === 'active';
        }
      })
    });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    lifecycleRegistration
  ]);
  let revoked = false;
  let currentTime: Instant = now;
  const authority: Parameters<typeof createChangesetOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (revoked) {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }
      if (input.evidence.kind !== 'operator') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      const approver = input.evidence.sessionHandle === 'verified-approver-session-handle';
      const actorUserId = approver ? approverUserId : userId;
      const actorMembershipId = approver ? approverMembershipId : membershipId;
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId: actorUserId }),
          principal: Object.freeze({
            kind: 'workspace_user' as const,
            userId: actorUserId,
            membershipId: actorMembershipId
          }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({
            kind: 'permission' as const,
            key: 'program.vocabulary.manage'
          })]),
          evidenceIds: Object.freeze(['membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const repository = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    contributors,
    () => ({ actorUserId: userId, occurredAt: currentTime })
  );
  const draftModule = createProgramVocabularyOperationModule({
    workspaceId,
    policies: {
      read: PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
      manage: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY
    },
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] })
    },
    vocabularyRead: repository,
    referenceRegistry,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x45)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`joined-key:${raw}`).digest('hex')
        };
      }
    }
  });
  const lifecycleModule = createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority,
    lifecycleStore: lifecycleRegistration.lifecycleStore,
    ownerResolution: lifecycleRegistration.ownerResolution,
    ...(options.enableApproval === undefined
      ? {}
      : { enableDistinctHumanApproval: options.enableApproval }),
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x46)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`joined-key:${raw}`).digest('hex')
        };
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => currentTime
  });
  let receiptId = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([draftModule, lifecycleModule]),
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
    repository,
    lifecycle: lifecycleRegistration.lifecycleStore,
    close: () => sqlite.close(),
    setRevoked(value: boolean) { revoked = value; },
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
      readonly actor?: 'owner' | 'approver';
    }) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: input.operation.name,
        operationVersion: input.operation.version,
        surface: 'operator_http',
        correlationId: uuid(correlation++),
        businessInput: input.businessInput,
        verifiedEvidence: input.actor === 'approver' ? approverEvidence : evidence,
        rawIdempotencyKey: input.key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

describe('ordinary SQLite Program Vocabulary changeset effect domain', () => {
  test('runs draft, rebuild, diff, propose, exact commit, replay, effective read, and correction', async () => {
    const fixture = openFixture();
    try {
      const draft = programVocabularyDraftOperationResultSchema.parse(await fixture.effect({
        operation: PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
        businessInput: {
          kind: 'room', expectedSetVersion: 1, name: 'Main Hall', capacity: 240
        },
        key: 'draft-main-hall'
      }));
      if (draft.kind !== 'success') throw new TypeError('draft_failed');
      const firstSelector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };
      const rebuilt = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: REBUILD_CHANGESET_OPERATION,
        businessInput: {
          changesetId: draft.data.changesetId,
          expectedHeadVersion: 1,
          sourceRevisionId: draft.data.revision.id,
          sourceRevisionDigest: draft.data.revision.digestSha256,
          groups: ['program_vocabulary']
        },
        key: 'rebuild-main-hall'
      }));
      expect(rebuilt).toMatchObject({
        kind: 'success', data: { action: 'rebuild', diff: { headVersion: 2, status: 'draft' } }
      });
      if (rebuilt.kind !== 'success' || rebuilt.data.action !== 'rebuild') {
        throw new TypeError('rebuild_failed');
      }
      const selector = {
        changesetId: rebuilt.data.diff.changesetId,
        revisionId: rebuilt.data.diff.revisionId,
        revisionDigest: rebuilt.data.diff.revisionDigest
      };
      expect(changesetDiffOperationResultSchema.parse(await fixture.read(
        GET_CHANGESET_DIFF_OPERATION, selector
      ))).toMatchObject({
        kind: 'success', data: { headVersion: 2, status: 'draft', operations: [{
          kind: 'program.vocabulary.mutate'
        }] }
      });
      const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'propose-main-hall'
      }));
      expect(proposed).toMatchObject({
        kind: 'success', data: { action: 'propose', diff: { headVersion: 3, status: 'proposed' } }
      });

      const beforeStale = {
        receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
        links: count(fixture.sqlite, 'changeset_lifecycle_effect_receipt_links'),
        rooms: count(fixture.sqlite, 'program_vocabulary_rooms')
      };
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'commit-stale-main-hall'
      })).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: { class: 'stale_revision', detail: { code: 'stale_head' } }
      });
      expect({
        receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
        links: count(fixture.sqlite, 'changeset_lifecycle_effect_receipt_links'),
        rooms: count(fixture.sqlite, 'program_vocabulary_rooms')
      }).toEqual(beforeStale);

      const commitInput = { ...selector, expectedHeadVersion: 3 };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-main-hall'
      }));
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', expectedHeadVersion: 3, committedHeadVersion: 4 }
      });
      if (committed.kind !== 'success' || committed.data.action !== 'commit') {
        throw new TypeError('commit_failed');
      }
      const receiptId = committed.receipt.id;
      const receiptCount = count(fixture.sqlite, 'foundation_trial_operation_receipts');
      const replay = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-main-hall'
      }));
      expect(replay).toMatchObject({ kind: 'success', receipt: { id: receiptId } });
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(receiptCount);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...commitInput, expectedHeadVersion: 4 },
        key: 'commit-main-hall'
      })).toMatchObject({
        kind: 'outcome', outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(receiptCount);
      fixture.setRevoked(true);
      fixture.advance(1_000);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-main-hall'
      })).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(receiptCount);
      fixture.setRevoked(false);

      expect(fixture.repository.readVocabulary({ workspaceId, eventId })).toMatchObject({
        setVersion: 2,
        rooms: [{ name: 'Main Hall', capacity: 240, status: 'active', version: 1 }]
      });
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'committed', version: 4 }
      });
      expect(count(fixture.sqlite, 'changeset_lifecycle_domain_facts')).toBe(1);
      expect(count(fixture.sqlite, 'changeset_lifecycle_outbox_pointers')).toBe(1);
      expect(count(fixture.sqlite, 'changeset_lifecycle_timeline_projection')).toBe(3);

      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: selector.changesetId,
          sourceRevisionId: selector.revisionId,
          sourceRevisionDigest: selector.revisionDigest,
          sourceCommitReceiptId: receiptId
        },
        key: 'correct-main-hall'
      }));
      expect(correction).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'exact', target: { status: 'draft' } }
      });
      expect(count(fixture.sqlite, 'changeset_correction_links')).toBe(1);
      expect(count(fixture.sqlite, 'changeset_lifecycle_timeline_projection')).toBe(4);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      expect(firstSelector.revisionId).not.toBe(selector.revisionId);
    } finally {
      fixture.close();
    }
  });

  test('keeps a bounded merge committable by the same authorized operator', async () => {
    const fixture = openFixture();
    async function createRoom(name: string, expectedSetVersion: number, key: string) {
      const draft = programVocabularyDraftOperationResultSchema.parse(await fixture.effect({
        operation: PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
        businessInput: { kind: 'room', expectedSetVersion, name, capacity: 100 },
        key: `${key}-draft`
      }));
      if (draft.kind !== 'success') throw new TypeError('create_room_draft_failed');
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
      if (proposed.kind !== 'success') throw new TypeError('create_room_propose_failed');
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: `${key}-commit`
      }));
      if (committed.kind !== 'success') throw new TypeError('create_room_commit_failed');
    }
    try {
      await createRoom('Source Room', 1, 'source');
      fixture.advance(1_000);
      await createRoom('Target Room', 2, 'target');
      const before = fixture.repository.readVocabulary({ workspaceId, eventId });
      const source = before?.rooms.find((room) => room.name === 'Source Room');
      const target = before?.rooms.find((room) => room.name === 'Target Room');
      if (!before || !source || !target) throw new TypeError('merge_fixture_missing');
      const draft = programVocabularyDraftOperationResultSchema.parse(await fixture.effect({
        operation: PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
        businessInput: {
          kind: 'room',
          sourceId: source.id,
          targetId: target.id,
          expectedSetVersion: 3,
          expectedSourceVersion: source.version,
          expectedTargetVersion: target.version
        },
        key: 'merge-draft'
      }));
      expect(draft).toMatchObject({
        kind: 'success',
        data: {
          action: 'merge',
          approvalPolicy: { requirement: 'none' },
          safeDiff: { action: 'merge' }
        }
      });
      if (draft.kind !== 'success') throw new TypeError('merge_draft_failed');
      const selector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 1 },
        key: 'merge-propose'
      })).toMatchObject({ kind: 'success' });
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'merge-commit'
      })).toMatchObject({ kind: 'success' });
      expect(fixture.repository.readVocabulary({ workspaceId, eventId })).toMatchObject({
        setVersion: 4,
        rooms: [
          { id: source.id, status: 'retired', version: 2 },
          { id: target.id, status: 'active', version: 1 }
        ]
      });
    } finally {
      fixture.close();
    }
  });

  test('requires a genuinely distinct current human when the issued policy is elevated', async () => {
    const fixture = openFixture({
      ordinaryApproval: 'distinct_current_human',
      enableApproval: true
    });
    try {
      const draft = programVocabularyDraftOperationResultSchema.parse(await fixture.effect({
        operation: PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
        businessInput: {
          kind: 'room', expectedSetVersion: 1, name: 'Approval Hall', capacity: 80
        },
        key: 'approval-draft'
      }));
      expect(draft).toMatchObject({
        kind: 'success', data: { approvalPolicy: { requirement: 'distinct_current_human' } }
      });
      if (draft.kind !== 'success') throw new TypeError('approval_draft_failed');
      const selector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 1 },
        key: 'approval-propose'
      })).toMatchObject({ kind: 'success' });
      expect(await fixture.effect({
        operation: APPROVE_CHANGESET_REVISION_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'approval-same-human'
      })).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: {
          class: 'policy_violation',
          detail: { code: 'approval_separation_required' }
        }
      });
      expect(count(fixture.sqlite, 'changeset_approvals')).toBe(0);
      const approved = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: APPROVE_CHANGESET_REVISION_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'approval-distinct-human',
        actor: 'approver'
      }));
      expect(approved).toMatchObject({
        kind: 'success', data: { action: 'approve', changesetId: selector.changesetId }
      });
      expect(count(fixture.sqlite, 'changeset_approvals')).toBe(1);
      expect(fixture.sqlite.query<{ readonly record_json: string }, []>(`
        SELECT record_json FROM changeset_approvals
      `).get()?.record_json).toContain(`workspace_user:${approverUserId}`);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'approval-commit'
      })).toMatchObject({ kind: 'success' });
      expect(fixture.repository.readVocabulary({ workspaceId, eventId })).toMatchObject({
        setVersion: 2,
        rooms: [{ name: 'Approval Hall' }]
      });
    } finally {
      fixture.close();
    }
  });
});
