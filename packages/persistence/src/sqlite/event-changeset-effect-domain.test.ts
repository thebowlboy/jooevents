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
  GET_CHANGESET_DIFF_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  changesetDiffOperationResultSchema,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import { eventCreateDraftOperationResultSchema } from '@jooevents/contracts';
import {
  createEventDependencyContributorRegistry,
  issueEventOrdinaryPolicy,
  type EventDependencyContributorRef
} from '@jooevents/event';
import {
  EVENT_CREATE_DRAFT_OPERATION,
  EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  createEventCreateDraftOperationModule
} from '@jooevents/event-operations';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import { createSQLiteChangesetLifecycleEffectDomainRouter } from './changeset-lifecycle-effect-domain-router';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import { openSQLite } from './database';
import {
  createSQLiteEventCreationChangesetEffectDomainRegistration,
  installEventCreationChangesetEffectSchema,
  type SQLiteEventCreationChangesetEffectIds
} from './event-changeset-effect-domain';
import {
  createSQLiteEventCreateDraftEffectDomainRegistration,
  installEventCreateDraftEffectSchema,
  type SQLiteEventCreateDraftEffectIds
} from './event-create-draft-effect-domain';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const now = parseInstant('2026-08-12T10:00:00.000Z');
const profile = Object.freeze({ key: 'event-joined-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-event-session'
});
const dependencyContributor: EventDependencyContributorRef = Object.freeze({
  key: 'test.event_dependency', version: 1
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

function openFixture(options: {
  readonly dependencyPresent?: boolean;
  readonly createdEventInitializer?: 'succeed' | 'fail';
} = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installEventCreateDraftEffectSchema(sqlite);
  installEventCreationChangesetEffectSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE event_created_initializer_proof (
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, event_id)
    ) STRICT, WITHOUT ROWID;
  `);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Event workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Event operator', 1, 1, 1);
  transaction(sqlite, () => {
    new SQLiteEventSpineRepository(sqlite).bootstrapWorkspaceEventSet(workspaceId);
  });

  let currentTime: Instant = now;
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const expected = options.dependencyPresent ? [dependencyContributor] : [];
  const dependencyRegistry = createEventDependencyContributorRegistry({
    expected,
    contributors: expected
  });
  const dependencySource = Object.freeze({
    readContributor(contributor: EventDependencyContributorRef, scope: {
      readonly workspaceId: string;
      readonly eventId: string;
    }) {
      if (contributor.key !== dependencyContributor.key
          || contributor.version !== dependencyContributor.version) return undefined;
      return {
        contributor,
        scope,
        guard: {
          id: `event_dependency:test:${scope.eventId}`,
          version: 1,
          digest: 'd'.repeat(64)
        },
        dependencies: options.dependencyPresent ? [{
          referenceKey: `test:${scope.eventId}`,
          version: 1,
          destination: { kind: 'test_record', id: 'dependent-1' }
        }] : []
      };
    }
  });
  const policy = issueEventOrdinaryPolicy({
    key: 'event.creation.joined', version: 1, risk: 'normal', approval: 'none'
  });
  const draftIds: SQLiteEventCreateDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newEventId: next
  };
  const lifecycleIds: SQLiteEventCreationChangesetEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newApprovalId: next,
    newCorrectionAttemptId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newFactId: next,
    newPointerId: next
  };
  const draftRegistration = createSQLiteEventCreateDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, dependencyRegistry, dependencySource, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteEventCreationChangesetEffectDomainRegistration({
    sqlite, workspaceId, policy, dependencyRegistry, dependencySource, ids: lifecycleIds,
    ...(options.createdEventInitializer === undefined ? {} : {
      createdEventInitializer: Object.freeze({
        initializeCreatedEvent(scope: { readonly workspaceId: string; readonly eventId: string }) {
          if (!sqlite.inTransaction) throw new TypeError('event_initializer_transaction_missing');
          sqlite.query<never, [string, string]>(`
            INSERT INTO event_created_initializer_proof (workspace_id, event_id)
            VALUES (?, ?)
          `).run(scope.workspaceId, scope.eventId);
          if (options.createdEventInitializer === 'fail') {
            throw new TypeError('injected_event_initializer_failure');
          }
        }
      })
    })
  });
  const routedLifecycle = createSQLiteChangesetLifecycleEffectDomainRouter([{
    ownerId: 'event_creation',
    adapter: lifecycleRegistration.adapter,
    ownerResolution: lifecycleRegistration.ownerResolution,
    subjectRelationships: lifecycleRegistration.subjectRelationships
  }]);
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    routedLifecycle
  ]);
  let revoked = false;
  const authority: Parameters<typeof createEventCreateDraftOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (revoked) return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({
            kind: 'permission' as const, key: 'event.manage'
          })]),
          evidenceIds: Object.freeze(['event-membership.current']),
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
        verifierSha256: createHash('sha256').update(`event-key:${raw}`).digest('hex')
      });
    }
  };
  const draftModule = createEventCreateDraftOperationModule({
    workspaceId,
    managePolicy: EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE,
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
    source: composeOperationRegistryModules([draftModule, changesetModule]),
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
    repository: new SQLiteEventSpineRepository(sqlite),
    lifecycle: lifecycleRegistration.lifecycleStore,
    ownerResolution: routedLifecycle.ownerResolution,
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

async function draftAndPropose(fixture: ReturnType<typeof openFixture>, key: string) {
  const draft = eventCreateDraftOperationResultSchema.parse(await fixture.effect({
    operation: EVENT_CREATE_DRAFT_OPERATION,
    businessInput: {
      name: 'Joo Summit',
      timezone: 'Asia/Singapore',
      startDate: '2026-11-01',
      endDate: '2026-11-03'
    },
    key: `${key}-draft`
  }));
  if (draft.kind !== 'success') throw new TypeError('event_draft_failed');
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
  if (proposed.kind !== 'success') throw new TypeError('event_propose_failed');
  return { draft, selector };
}

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    events: count(fixture.sqlite, 'event_spine_heads'),
    scopeRoots: count(fixture.sqlite, 'event_spine_scope_roots'),
    initializedChildren: count(fixture.sqlite, 'event_created_initializer_proof'),
    lifecycleLinks: count(fixture.sqlite, 'event_creation_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'event_creation_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'event_creation_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'event_creation_changeset_timeline'),
    commitLinks: count(fixture.sqlite, 'changeset_commit_links')
  };
}

describe('ordinary SQLite Event creation changeset effect domain', () => {
  test('runs exact diff, propose, atomic commit, replay, access-currentness, and correction', async () => {
    const fixture = openFixture({ createdEventInitializer: 'succeed' });
    try {
      const { draft, selector } = await draftAndPropose(fixture, 'create');
      expect(fixture.repository.readCurrentEventState(workspaceId)).toMatchObject({
        eventSet: { version: 1, currentEventId: null }, currentEvent: undefined
      });
      const record = fixture.lifecycle.read(selector.changesetId);
      if (!record) throw new TypeError('event_changeset_record_missing');
      expect(await fixture.ownerResolution.resolveOwner(record)).toMatchObject({
        id: 'event_creation'
      });
      expect(record.head.eventId).toBeUndefined();
      expect(record.revisions[0]?.revision.operations[0]?.guardRefs).toEqual([{
        id: `workspace_event_set:${workspaceId}`,
        version: 1,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/)
      }]);
      expect(changesetDiffOperationResultSchema.parse(await fixture.read(
        GET_CHANGESET_DIFF_OPERATION,
        selector
      ))).toMatchObject({
        kind: 'success',
        data: {
          status: 'proposed',
          operations: [{
            kind: 'event.creation',
            safeDiff: {
              after: {
                name: 'Joo Summit', timezone: 'Asia/Singapore',
                startDate: '2026-11-01', endDate: '2026-11-03'
              }
            }
          }]
        }
      });
      const commitInput = { ...selector, expectedHeadVersion: 2 };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'create-commit'
      }));
      expect(committed).toMatchObject({
        kind: 'success', data: { action: 'commit', committedHeadVersion: 3 }
      });
      if (committed.kind !== 'success') throw new TypeError('event_commit_failed');
      expect(fixture.repository.readCurrentEventState(workspaceId)).toMatchObject({
        eventSet: { version: 2, currentEventId: draft.data.safeDiff.after.id },
        currentEvent: {
          id: draft.data.safeDiff.after.id,
          name: 'Joo Summit', timezone: 'Asia/Singapore',
          startDate: '2026-11-01', endDate: '2026-11-03'
        }
      });
      expect(count(fixture.sqlite, 'event_created_initializer_proof')).toBe(1);
      const beforeReplay = durableCounts(fixture);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'create-commit'
      })).toMatchObject({ kind: 'success', receipt: { id: committed.receipt.id } });
      expect(durableCounts(fixture)).toEqual(beforeReplay);
      fixture.setRevoked(true);
      fixture.advance(1_000);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'create-commit'
      })).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(durableCounts(fixture)).toEqual(beforeReplay);
      fixture.setRevoked(false);

      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: selector.changesetId,
          sourceRevisionId: selector.revisionId,
          sourceRevisionDigest: selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'create-correction'
      }));
      expect(correction).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction', resultKind: 'exact',
          target: { status: 'draft', operations: [{ safeDiff: { action: 'compensate_create' } }] }
        }
      });
      if (correction.kind !== 'success' || correction.data.action !== 'correction'
          || correction.data.target === null) throw new TypeError('event_correction_missing');
      const target = correction.data.target;
      const correctionSelector = {
        changesetId: target.changesetId,
        revisionId: target.revisionId,
        revisionDigest: target.revisionDigest
      };
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 1 },
        key: 'correction-propose'
      })).toMatchObject({ kind: 'success' });
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...correctionSelector, expectedHeadVersion: 2 },
        key: 'correction-commit'
      })).toMatchObject({ kind: 'success' });
      expect(fixture.repository.readCurrentEventState(workspaceId)).toMatchObject({
        eventSet: { version: 3, currentEventId: null }, currentEvent: undefined
      });
      expect(count(fixture.sqlite, 'event_spine_heads')).toBe(1);
      expect(count(fixture.sqlite, 'event_creation_changeset_domain_facts')).toBe(2);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a stale first-event guard with zero Event or lifecycle commit writes', async () => {
    const fixture = openFixture();
    try {
      const { selector } = await draftAndPropose(fixture, 'stale');
      transaction(fixture.sqlite, () => {
        fixture.sqlite.query<never, [string]>(`
          UPDATE event_spine_workspace_sets SET version = version + 1 WHERE workspace_id = ?
        `).run(workspaceId);
      });
      const before = durableCounts(fixture);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'stale-commit'
      })).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed', subjectId: `workspace_event_set:${workspaceId}` }
        }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });

  test('rolls back Event, guard, receipt, fact, outbox, timeline, and commit link on late failure', async () => {
    const fixture = openFixture();
    try {
      const { selector } = await draftAndPropose(fixture, 'atomic');
      const before = durableCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER event_joined_fail_head
        BEFORE INSERT ON event_spine_heads
        BEGIN SELECT RAISE(ABORT, 'injected Event head failure'); END;
      `);
      await expect(fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'atomic-commit'
      })).rejects.toThrow('Operation execution failed during handler.');
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.repository.readCurrentEventState(workspaceId)).toMatchObject({
        eventSet: { version: 1, currentEventId: null }, currentEvent: undefined
      });
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });

  test('rolls back the Event and structural child when created-Event initialization fails', async () => {
    const fixture = openFixture({ createdEventInitializer: 'fail' });
    try {
      const { selector } = await draftAndPropose(fixture, 'initializer-atomic');
      const before = durableCounts(fixture);
      await expect(fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'initializer-atomic-commit'
      })).rejects.toThrow('Operation execution failed during handler.');
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.repository.readCurrentEventState(workspaceId)).toMatchObject({
        eventSet: { version: 1, currentEventId: null }, currentEvent: undefined
      });
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });

  test('records an honest blocked correction when a registered dependency exists', async () => {
    const fixture = openFixture({ dependencyPresent: true });
    try {
      const { selector } = await draftAndPropose(fixture, 'dependency');
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'dependency-commit'
      }));
      if (committed.kind !== 'success') throw new TypeError('dependency_commit_failed');
      expect(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: selector.changesetId,
          sourceRevisionId: selector.revisionId,
          sourceRevisionDigest: selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'dependency-correction'
      })).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction', resultKind: 'blocked', target: null,
          evidence: { blockers: [{ reasonKey: 'event.creation.dependencies_present' }] }
        }
      });
      expect(fixture.repository.readCurrentEventState(workspaceId)).toMatchObject({
        currentEvent: { name: 'Joo Summit' }
      });
      expect(count(fixture.sqlite, 'changeset_correction_links')).toBe(1);
    } finally {
      fixture.close();
    }
  });
});
