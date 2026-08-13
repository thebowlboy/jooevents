import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type EffectInvocationContext,
  type InvocationEvidence,
  type OperationExecutionError
} from '@jooevents/application';
import {
  EVENT_CREATE_HANDLER_CAPABILITY,
  EVENT_CREATE_REQUEST_HASH_PROFILE,
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_READ_ACCESS_POLICY,
  createEventOperationModule
} from '@jooevents/event-operations';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  eventCreateOperationResultSchema,
  type EventCreateInput
} from '@jooevents/contracts';
import { openSQLite } from './database';
import {
  SQLiteEventSpineRepository,
  installEventSpineSchema
} from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';
import {
  SQLiteEventEffectDomainAdapter,
  createSQLiteEventEffectDomainRegistration,
  type SQLiteEventEffectDomainIds
} from './event-effect-domain';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa001');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa002');
const now = parseInstant('2026-08-12T08:30:00.000Z');
const profile = Object.freeze({ key: 'event-sqlite-test', version: parseContractVersion(1) });
const businessInput = Object.freeze({
  expectedEventSetVersion: 1,
  name: 'JooEvents Summit',
  timezone: 'Asia/Singapore',
  startDate: '2026-11-04',
  endDate: '2026-11-06'
});
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-session-handle'
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

const domainTables = [
  'event_spine_heads',
  'event_spine_scope_roots',
  'event_spine_create_links',
  'event_spine_create_plans',
  'event_spine_domain_facts',
  'event_spine_outbox_pointers',
  'event_spine_timeline_projection',
  'foundation_trial_operation_receipts',
  'foundation_trial_operation_receipt_children',
  'foundation_trial_operation_audits',
  'foundation_trial_operation_execution_claims'
] as const;

function expectNoOperationRows(sqlite: ReturnType<typeof openSQLite>['sqlite']): void {
  for (const table of domainTables) expect(count(sqlite, table), table).toBe(0);
  const eventSet = new SQLiteEventSpineRepository(sqlite).requireEventSet(workspaceId);
  expect(eventSet.workspaceId).toBe(workspaceId);
  expect(Number(eventSet.version)).toBe(1);
  expect(eventSet.currentEventId).toBeNull();
}

type AdapterMode =
  | 'ordinary'
  | 'forged_domain'
  | 'wrong_receipt'
  | 'reordered_child'
  | 'duplicate_child'
  | 'substituted_child';

function adversarialAdapter(
  base: SQLiteEventEffectDomainAdapter,
  mode: Exclude<AdapterMode, 'ordinary'>
): SQLiteEffectDomainAdapter {
  let firstChild: unknown;
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution(contribution) {
      if (mode === 'forged_domain') {
        const forged = structuredClone(contribution) as Record<string, unknown>;
        forged.planDigestSha256 = '0'.repeat(64);
        return base.applyDomainContribution(forged);
      }
      return base.applyDomainContribution(contribution);
    },
    afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base),
    afterReceiptChildInserted(receiptId, contribution) {
      if (mode === 'wrong_receipt') {
        return base.afterReceiptChildInserted(uuid(0xff01), contribution);
      }
      if (mode === 'reordered_child') {
        const fact = contribution as { readonly factId?: string };
        return base.afterReceiptChildInserted(receiptId, {
          kind: 'outbox_pointer',
          pointerId: uuid(0xff02),
          sourceKind: 'domain_fact',
          factId: fact.factId
        });
      }
      if (mode === 'substituted_child') {
        const substituted = structuredClone(contribution) as Record<string, unknown>;
        substituted.factId = uuid(0xff03);
        return base.afterReceiptChildInserted(receiptId, substituted);
      }
      if (firstChild === undefined) {
        firstChild = structuredClone(contribution);
        return base.afterReceiptChildInserted(receiptId, contribution);
      }
      return base.afterReceiptChildInserted(receiptId, firstChild);
    },
    afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base),
    afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base)
  };
}

interface FixtureOptions {
  readonly mode?: AdapterMode;
  readonly permission?: 'event.manage' | 'event.read';
  readonly duplicateIds?: boolean;
}

function openFixture(options: FixtureOptions = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Primary workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Event owner', 1, 1, 1);
  const repository = new SQLiteEventSpineRepository(sqlite);
  sqlite.exec('BEGIN IMMEDIATE;');
  repository.bootstrapWorkspaceEventSet(workspaceId);
  sqlite.exec('COMMIT;');

  let generatedId = 0x100;
  const nextDomainId = () => uuid(generatedId++);
  const ids: SQLiteEventEffectDomainIds = options.duplicateIds
    ? {
        newEventId: nextDomainId,
        newPreparationHandle: nextDomainId,
        newFactId: () => uuid(0xdd01),
        newPointerId: () => uuid(0xdd01),
        newTimelineId: nextDomainId
      }
    : {
        newEventId: nextDomainId,
        newPreparationHandle: nextDomainId,
        newFactId: nextDomainId,
        newPointerId: nextDomainId,
        newTimelineId: nextDomainId
      };
  const registration = createSQLiteEventEffectDomainRegistration({
    sqlite,
    workspaceId,
    ids
  });
  const selectedAdapter = options.mode && options.mode !== 'ordinary'
    ? adversarialAdapter(registration.adapter, options.mode)
    : registration.adapter;
  const registry = createSQLiteEffectDomainAdapterRegistry([{
    capability: registration.capability,
    adapter: selectedAdapter
  }]);
  const authority = Object.freeze({
    resolve(input: Parameters<Parameters<typeof createEventOperationModule>[0]['currentAuthority']['resolve']>[0]) {
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
          grants: Object.freeze([Object.freeze({
            kind: 'permission' as const,
            key: options.permission ?? 'event.manage'
          })]),
          evidenceIds: Object.freeze(['membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  });
  const module = createEventOperationModule({
    workspaceId,
    policies: { read: EVENT_READ_ACCESS_POLICY, manage: EVENT_MANAGE_ACCESS_POLICY },
    currentAuthority: authority,
    currentEventRead: {
      readCurrent: () => repository.readCurrentEventProjection(workspaceId) ?? {
        schemaVersion: 1,
        kind: 'no_event',
        eventSetVersion: 1
      }
    },
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(uuid(generatedId++)) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: EVENT_CREATE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x44)
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
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, registry, {
    resolveAuthority: authority.resolve,
    now: () => now
  });
  let receiptId = 0x800;
  const operationRuntime = createApplicationOperationRuntime({
    source: module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId(uuid(generatedId++))
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let correlationId = 0x900;
  let idempotency = 0;
  return {
    sqlite,
    repository,
    adapter: registration.adapter,
    close: () => sqlite.close(),
    async execute(input: EventCreateInput = businessInput) {
      const runtime = await operationRuntime;
      const invocation = await runtime.effectBuilder.build({
        operationName: 'event.create',
        operationVersion: 1,
        surface: 'operator_http',
        correlationId: uuid(correlationId++),
        businessInput: input,
        verifiedEvidence: evidence,
        rawIdempotencyKey: `create-event-${idempotency++}`
      });
      return runtime.effectExecutor.execute(invocation);
    }
  };
}

function expectExecutionFailure(error: unknown, phase: OperationExecutionError['phase']): void {
  expect(error).toMatchObject({ name: 'OperationExecutionError', phase });
}

describe('ordinary SQLite Event effect-domain adapter', () => {
  test('commits exact transaction-authoritative state, receipt linkage and ordered evidence', async () => {
    const fixture = openFixture();
    try {
      const result = eventCreateOperationResultSchema.parse(await fixture.execute());
      expect(result).toMatchObject({
        kind: 'success',
        data: {
          eventSetVersion: 2,
          event: { name: businessInput.name }
        },
        receipt: { operationName: 'event.create', operationVersion: 1 }
      });
      if (result.kind !== 'success') throw new TypeError('expected_success');
      const event = fixture.repository.readEventHead({
        workspaceId,
        eventId: result.data.event.id
      });
      expect(event).toMatchObject({
        createdByUserId: userId,
        createdAt: now,
        workspaceId
      });
      if (!event) throw new TypeError('expected_event');
      const plan = fixture.repository.readEventCreatePlan(result.receipt.id);
      expect(plan.after).toEqual(event);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      expect(count(fixture.sqlite, 'event_spine_domain_facts')).toBe(1);
      expect(count(fixture.sqlite, 'event_spine_outbox_pointers')).toBe(1);
      expect(count(fixture.sqlite, 'event_spine_timeline_projection')).toBe(1);
      expect(fixture.sqlite.query<{ readonly ordinal: number; readonly kind: string }, []>(`
        SELECT ordinal, json_extract(contribution_json, '$.kind') AS kind
          FROM foundation_trial_operation_receipt_children
         ORDER BY ordinal
      `).all()).toEqual([
        { ordinal: 0, kind: 'domain_fact' },
        { ordinal: 1, kind: 'outbox_pointer' },
        { ordinal: 2, kind: 'timeline' }
      ]);
      expect(count(fixture.sqlite, 'events')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('returns typed stale and already-selected refusals without new domain or receipt rows', async () => {
    const stale = openFixture();
    try {
      expect(await stale.execute({ ...businessInput, expectedEventSetVersion: 2 })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'stale_revision', kind: 'event.event_set_changed' }
      });
      expect(count(stale.sqlite, 'event_spine_heads')).toBe(0);
      expect(count(stale.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
      expect(count(stale.sqlite, 'foundation_trial_operation_receipt_children')).toBe(0);
      expect(count(stale.sqlite, 'foundation_trial_operation_audits')).toBe(1);
    } finally {
      stale.close();
    }

    const selected = openFixture();
    try {
      await selected.execute();
      expect(await selected.execute({ ...businessInput, expectedEventSetVersion: 2 })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'conflict', kind: 'event.already_selected' }
      });
      expect(count(selected.sqlite, 'event_spine_heads')).toBe(1);
      expect(count(selected.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
      expect(count(selected.sqlite, 'foundation_trial_operation_receipt_children')).toBe(3);
    } finally {
      selected.close();
    }
  });

  test('rejects use outside a transaction, capability substitution and missing manage grant', async () => {
    const fixture = openFixture({ permission: 'event.read' });
    try {
      expect(() => fixture.adapter.openHandlerSnapshot(
        EVENT_CREATE_HANDLER_CAPABILITY,
        {} as EffectInvocationContext,
        {} as never
      )).toThrow('event_effect_transaction_required');
      expect(() => fixture.adapter.afterExecutionClaimReleased({} as never))
        .toThrow('event_effect_transaction_required');
      fixture.sqlite.exec('BEGIN IMMEDIATE;');
      expect(() => fixture.adapter.openHandlerSnapshot(
        { key: 'capability.event.substituted', version: 1 },
        {} as EffectInvocationContext,
        {} as never
      )).toThrow('event_effect_capability_mismatch');
      fixture.sqlite.exec('ROLLBACK;');
      try {
        await fixture.execute();
        throw new Error('expected_execution_failure');
      } catch (error) {
        expectExecutionFailure(error, 'write_snapshot');
      }
      expectNoOperationRows(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });

  test('rejects a forged prepared domain and colliding server IDs with full rollback', async () => {
    for (const options of [{ mode: 'forged_domain' }, { duplicateIds: true }] as const) {
      const fixture = openFixture(options);
      try {
        try {
          await fixture.execute();
          throw new Error('expected_execution_failure');
        } catch (error) {
          expectExecutionFailure(error, options.mode ? 'domain_contribution' : 'handler');
        }
        expectNoOperationRows(fixture.sqlite);
      } finally {
        fixture.close();
      }
    }
  });

  test('cross-binds the exact receipt ID and rejects reordered, duplicate or substituted children', async () => {
    for (const mode of [
      'wrong_receipt',
      'reordered_child',
      'duplicate_child',
      'substituted_child'
    ] as const) {
      const fixture = openFixture({ mode });
      try {
        try {
          await fixture.execute();
          throw new Error('expected_execution_failure');
        } catch (error) {
          expectExecutionFailure(error, 'receipt_children');
        }
        expectNoOperationRows(fixture.sqlite);
      } finally {
        fixture.close();
      }
    }
  });
});
