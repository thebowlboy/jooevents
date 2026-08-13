import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence,
  type OperationExecutionError
} from '@jooevents/application';
import {
  createEventDependencyContributorRegistry,
  issueEventOrdinaryPolicy
} from '@jooevents/event';
import {
  EVENT_CREATE_DRAFT_OPERATION,
  EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  createEventCreateDraftOperationModule
} from '@jooevents/event-operations';
import { eventCreateDraftOperationResultSchema, type EventCreateDraftInput } from '@jooevents/contracts';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { openSQLite } from './database';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  installSQLiteChangesetLifecycleSchema
} from './changeset-lifecycle';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import {
  createSQLiteEventCreateDraftEffectDomainRegistration,
  installEventCreateDraftEffectSchema,
  type SQLiteEventCreateDraftEffectIds
} from './event-create-draft-effect-domain';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const now = parseInstant('2026-08-12T09:00:00.000Z');
const profile = Object.freeze({ key: 'event-draft-sqlite-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-session-handle'
});
const dependencyRegistry = createEventDependencyContributorRegistry({
  expected: [], contributors: []
});
const dependencySource = Object.freeze({ readContributor: () => undefined });
const policy = issueEventOrdinaryPolicy({
  key: 'event.creation.bounded', version: 1, risk: 'normal', approval: 'none'
});
const createInput: EventCreateDraftInput = Object.freeze({
  name: 'Joo Summit',
  timezone: 'Asia/Singapore',
  startDate: '2026-11-01',
  endDate: '2026-11-03'
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

const draftTables = [
  'changeset_heads',
  'changeset_revisions',
  'event_create_draft_receipt_links',
  'event_create_draft_timeline',
  'foundation_trial_operation_receipts',
  'foundation_trial_operation_receipt_children'
] as const;

function expectNoDraftWrites(sqlite: ReturnType<typeof openSQLite>['sqlite']): void {
  for (const table of draftTables) expect(count(sqlite, table), table).toBe(0);
}

function mismatchChildAdapter(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  if (!base.afterReceiptParentInserted || !base.afterReceiptChildInserted
      || !base.afterExecutionClaimReleased || !base.afterUnitOfWorkCommitted) {
    throw new TypeError('event_create_draft_test_adapter_hooks_missing');
  }
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base),
    afterReceiptChildInserted(receiptId, contribution) {
      const substituted = structuredClone(contribution) as Record<string, unknown>;
      substituted.timelineId = uuid(0xff01);
      return base.afterReceiptChildInserted!(receiptId, substituted);
    },
    afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base),
    afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base)
  };
}

function openFixture(options: { readonly mismatchChild?: boolean; readonly deny?: boolean } = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installEventCreateDraftEffectSchema(sqlite);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Primary workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Event owner', 1, 1, 1);
  sqlite.transaction(() => {
    new SQLiteEventSpineRepository(sqlite).bootstrapWorkspaceEventSet(workspaceId);
  }).immediate();

  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const ids: SQLiteEventCreateDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newEventId: next
  };
  const registration = createSQLiteEventCreateDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, dependencyRegistry, dependencySource, ids
  });
  const adapter = options.mismatchChild
    ? mismatchChildAdapter(registration.adapter)
    : registration.adapter;
  const adapters = createSQLiteEffectDomainAdapterRegistry([{
    capability: registration.capability,
    adapter
  }]);
  let authorityChecks = 0;
  const authority: Parameters<typeof createEventCreateDraftOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      authorityChecks += 1;
      if (options.deny && authorityChecks > 1) {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }
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
          evidenceIds: Object.freeze(['membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const module = createEventCreateDraftOperationModule({
    workspaceId,
    managePolicy: EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: EVENT_CREATE_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x45)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`event-key:${raw}`).digest('hex')
        };
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => now
  });
  let receiptId = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let request = 0;
  return {
    sqlite,
    repository: new SQLiteEventSpineRepository(sqlite),
    lifecycle: createSQLiteDraftOnlyChangesetLifecycleStore(sqlite),
    close: () => sqlite.close(),
    async execute(input: EventCreateDraftInput = createInput, key = `event-draft-${request++}`) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: EVENT_CREATE_DRAFT_OPERATION.name,
        operationVersion: EVENT_CREATE_DRAFT_OPERATION.version,
        surface: 'operator_http',
        correlationId: uuid(0x900 + request),
        businessInput: input,
        verifiedEvidence: evidence,
        rawIdempotencyKey: key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

function expectExecutionFailure(error: unknown, phase: OperationExecutionError['phase']): void {
  expect(error).toMatchObject({ name: 'OperationExecutionError', phase });
}

describe('ordinary SQLite Event create-draft effect domain', () => {
  test('persists an inert workspace changeset with exact safe diff and replays one receipt', async () => {
    const fixture = openFixture();
    try {
      const before = fixture.repository.readCurrentEventState(workspaceId);
      const first = eventCreateDraftOperationResultSchema.parse(
        await fixture.execute(createInput, 'same-request')
      );
      const replay = eventCreateDraftOperationResultSchema.parse(
        await fixture.execute(createInput, 'same-request')
      );
      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        kind: 'success',
        data: {
          action: 'create',
          safeDiff: {
            action: 'create',
            after: {
              name: createInput.name,
              timezone: createInput.timezone,
              startDate: createInput.startDate,
              endDate: createInput.endDate
            }
          }
        },
        receipt: { operationName: EVENT_CREATE_DRAFT_OPERATION.name, operationVersion: 1 }
      });
      if (first.kind !== 'success') throw new TypeError('expected_success');
      expect(fixture.lifecycle.read(first.data.changesetId)).toMatchObject({
        head: { workspaceId, status: 'draft', version: 1 },
        revisions: [{
          revision: { createdAt: now, proposerPrincipalKey: `workspace_user:${userId}` },
          authorIntents: [{ authorInput: { action: 'create', workspaceId } }]
        }]
      });
      expect(fixture.repository.readCurrentEventState(workspaceId)).toEqual(before);
      expect(count(fixture.sqlite, 'event_spine_heads')).toBe(0);
      expect(count(fixture.sqlite, 'event_create_draft_receipt_links')).toBe(1);
      expect(count(fixture.sqlite, 'event_create_draft_timeline')).toBe(1);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('fails closed on current access loss before any draft write', async () => {
    const fixture = openFixture({ deny: true });
    try {
      expect(await fixture.execute()).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expectNoDraftWrites(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });

  test('rolls back changeset, receipt, and child when timeline evidence is substituted', async () => {
    const fixture = openFixture({ mismatchChild: true });
    try {
      try {
        await fixture.execute();
        throw new Error('expected_execution_failure');
      } catch (error) {
        expectExecutionFailure(error, 'receipt_children');
      }
      expectNoDraftWrites(fixture.sqlite);
      expect(count(fixture.sqlite, 'event_spine_heads')).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
