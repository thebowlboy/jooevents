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
  deadlineDraftOperationResultSchema,
  deadlineGetReadResultSchema
} from '@jooevents/contracts/deadlines';
import {
  DEADLINE_CHANGE_DRAFT_OPERATION,
  DEADLINE_CURRENT_READ_OPERATION,
  DEADLINE_DRAFT_REQUEST_HASH_PROFILE,
  DEADLINE_MANAGE_ACCESS_POLICY,
  DEADLINE_READ_ACCESS_POLICY,
  createDeadlineOperationModule
} from '@jooevents/deadline-operations';
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
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import {
  createSQLiteDeadlineChangesetEffectDomainRegistration,
  installDeadlineChangesetEffectSchema,
  type SQLiteDeadlineChangesetEffectIds
} from './deadline-changeset-effect-domain';
import {
  createSQLiteDeadlineDraftEffectDomainRegistration,
  installDeadlineDraftEffectSchema,
  type SQLiteDeadlineDraftEffectIds
} from './deadline-draft-effect-domain';
import { installDeadlineSchema } from './deadline';
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
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa111');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa211');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa212');
const now = parseInstant('2026-08-13T02:00:00.000Z');
const profile = Object.freeze({ key: 'deadline-joined-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-deadline-session'
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
  `).run(workspaceId, 'Deadline workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Deadline operator', 1, 1, 1);
  transaction(sqlite, () => {
    sqlite.query<never, [string]>(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, NULL)
    `).run(workspaceId);
    sqlite.query<never, [string, string, string, number, string]>(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date, version,
        created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, 'Deadline Event', 'America/New_York',
                '2026-11-01', '2026-11-03', 1, ?, ?, ?)
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

function openFixture() {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installDeadlineSchema(sqlite);
  installDeadlineDraftEffectSchema(sqlite);
  installDeadlineChangesetEffectSchema(sqlite);
  seed(sqlite);

  let currentTime: Instant = now;
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteDeadlineDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newDeadlineId: next,
    newPreparationHandle: next,
    newTimelineId: next
  };
  const lifecycleIds: SQLiteDeadlineChangesetEffectIds = {
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
  const draftRegistration = createSQLiteDeadlineDraftEffectDomainRegistration({
    sqlite, workspaceId, eventRelationships, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteDeadlineChangesetEffectDomainRegistration({
    sqlite, workspaceId, eventRelationships, ids: lifecycleIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    lifecycleRegistration
  ]);

  const authority: Parameters<typeof createDeadlineOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (input.evidence.kind !== 'operator') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      const grant = input.lane.policy.key === DEADLINE_READ_ACCESS_POLICY.key
        ? 'event.read'
        : 'event.manage';
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({ kind: 'permission' as const, key: grant })]),
          evidenceIds: Object.freeze(['deadline-membership.current']),
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
        verifierSha256: createHash('sha256').update(`deadline-key:${raw}`).digest('hex')
      });
    }
  };
  const deadlineModule = createDeadlineOperationModule({
    workspaceId,
    policies: { read: DEADLINE_READ_ACCESS_POLICY, manage: DEADLINE_MANAGE_ACCESS_POLICY },
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent(requestedWorkspaceId) {
        if (requestedWorkspaceId !== workspaceId) throw new TypeError('deadline_workspace_mismatch');
        const state = new SQLiteEventSpineRepository(sqlite).readCurrentEventState(workspaceId);
        if (!state) throw new TypeError('deadline_event_set_missing');
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
    deadlineRead: draftRegistration.deadlineRead,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: DEADLINE_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x51)
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
      keyBytes: new Uint8Array(32).fill(0x52)
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
    source: composeOperationRegistryModules([deadlineModule, changesetModule]),
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
    lifecycle: lifecycleRegistration.lifecycleStore,
    ownerResolution: lifecycleRegistration.ownerResolution,
    close: () => sqlite.close(),
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
  const draft = deadlineDraftOperationResultSchema.parse(await fixture.effect({
    operation: DEADLINE_CHANGE_DRAFT_OPERATION,
    businessInput: { action: 'create', displayDate: '2026-11-01' },
    key: `${key}-draft`
  }));
  if (draft.kind !== 'success') throw new TypeError('deadline_draft_failed');
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
  if (proposed.kind !== 'success') throw new TypeError('deadline_propose_failed');
  return { draft, selector };
}

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    deadlines: count(fixture.sqlite, 'deadlines'),
    catalogs: count(fixture.sqlite, 'deadline_catalogs'),
    lifecycleLinks: count(fixture.sqlite, 'deadline_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'deadline_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'deadline_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'deadline_changeset_timeline'),
    commitLinks: count(fixture.sqlite, 'changeset_commit_links')
  };
}

describe('ordinary SQLite Deadline changeset effect domain', () => {
  test('runs inert draft, propose, exact commit, active read, fact/outbox evidence, and replay', async () => {
    const fixture = openFixture();
    try {
      const { draft, selector } = await draftAndPropose(fixture, 'deadline-main');
      const record = fixture.lifecycle.read(selector.changesetId);
      if (!record) throw new TypeError('deadline_changeset_record_missing');
      expect(fixture.ownerResolution.resolveOwner(record)).toMatchObject({ id: 'deadline' });
      expect(record.revisions[0]?.revision.operations[0]).toMatchObject({
        kind: 'deadline.cfp_close.mutate',
        aggregateRefs: [{ id: `event:${eventId}`, version: 1 }],
        guardRefs: [{ id: `deadline_catalog:${eventId}`, version: 1 }]
      });

      const commitInput = { ...selector, expectedHeadVersion: 2 };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'deadline-main-commit'
      }));
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 3 }
      });
      const deadlineId = draft.data.safeDiff.after.id;
      expect(deadlineGetReadResultSchema.parse(await fixture.read(
        DEADLINE_CURRENT_READ_OPERATION,
        { deadlineId }
      ))).toMatchObject({
        kind: 'success',
        data: {
          deadline: {
            id: deadlineId,
            status: 'active',
            version: 1,
            displayDate: '2026-11-01',
            effectiveAt: '2026-11-02T05:00:00.000Z'
          }
        }
      });
      expect(fixture.sqlite.query<{ readonly payload_json: string }, []>(`
        SELECT payload_json FROM deadline_changeset_domain_facts
      `).get()?.payload_json).toBe(JSON.stringify({
        action: 'create',
        deadlineId,
        displayDate: '2026-11-01',
        effectiveAt: '2026-11-02T05:00:00.000Z',
        status: 'active',
        version: 1
      }));
      expect(durableCounts(fixture)).toMatchObject({
        deadlines: 1,
        catalogs: 1,
        lifecycleLinks: 2,
        facts: 1,
        pointers: 1,
        timeline: 2,
        commitLinks: 1
      });
      const beforeReplay = durableCounts(fixture);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'deadline-main-commit'
      })).toEqual(committed);
      expect(durableCounts(fixture)).toEqual(beforeReplay);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rolls back canonical state, evidence, receipt, and changeset commit after a late failure', async () => {
    const fixture = openFixture();
    try {
      const { selector } = await draftAndPropose(fixture, 'deadline-atomic');
      const before = durableCounts(fixture);
      fixture.sqlite.exec(`
        CREATE TRIGGER deadline_joined_fail_head
        BEFORE INSERT ON deadlines
        BEGIN SELECT RAISE(ABORT, 'injected deadline head failure'); END;
      `);
      await expect(fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'deadline-atomic-commit'
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
