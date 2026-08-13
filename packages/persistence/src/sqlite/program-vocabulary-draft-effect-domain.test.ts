import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence,
  type OperationExecutionError
} from '@jooevents/application';
import {
  createProgramReferenceContributorRegistry,
  issueProgramVocabularyOrdinaryPolicy
} from '@jooevents/program';
import {
  PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_DELETE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_EDIT_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
  PROGRAM_VOCABULARY_RESTORE_DRAFT_OPERATION,
  PROGRAM_VOCABULARY_RETIRE_DRAFT_OPERATION,
  createProgramVocabularyOperationModule,
  programVocabularyDraftOperationResultSchema,
  type ProgramVocabularyCreateDraftInput
} from '@jooevents/program-operations';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
  , type EventId
} from '@jooevents/kernel';
import { openSQLite } from './database';
import {
  createSQLiteDraftOnlyChangesetLifecycleStore,
  installSQLiteChangesetLifecycleSchema
} from './changeset-lifecycle';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import {
  createSQLiteProgramVocabularyContributorAdapterRegistry,
  installProgramVocabularySchema,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import {
  createSQLiteProgramVocabularyDraftEffectDomainRegistration,
  installProgramVocabularyDraftEffectSchema,
  type SQLiteProgramVocabularyDraftEffectIds
} from './program-vocabulary-draft-effect-domain';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const nonCurrentEventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa102');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const now = parseInstant('2026-08-12T09:00:00.000Z');
const profile = Object.freeze({ key: 'program-vocabulary-sqlite-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-session-handle'
});
const referenceRegistry = createProgramReferenceContributorRegistry({ expected: [], contributors: [] });
const policy = issueProgramVocabularyOrdinaryPolicy({
  key: 'program_vocabulary.bounded',
  version: 1,
  ordinaryRisk: 'low',
  mergeRisk: 'consequential',
  approval: { ordinary: 'none', merge: 'distinct_current_human' }
});
const createInput: ProgramVocabularyCreateDraftInput = Object.freeze({
  kind: 'room',
  expectedSetVersion: 1,
  name: 'Main Hall',
  capacity: 240
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
  'program_vocabulary_draft_receipt_links',
  'program_vocabulary_draft_timeline',
  'foundation_trial_operation_receipts',
  'foundation_trial_operation_receipt_children'
] as const;

function expectNoDraftWrites(sqlite: ReturnType<typeof openSQLite>['sqlite']): void {
  for (const table of draftTables) expect(count(sqlite, table), table).toBe(0);
  expect(count(sqlite, 'program_vocabulary_sets')).toBe(0);
  expect(count(sqlite, 'program_vocabulary_rooms')).toBe(0);
}

function mismatchChildAdapter(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  if (
    !base.afterReceiptParentInserted
    || !base.afterReceiptChildInserted
    || !base.afterExecutionClaimReleased
    || !base.afterUnitOfWorkCommitted
  ) throw new TypeError('program_vocabulary_draft_test_adapter_hooks_missing');
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

function openFixture(options: {
  readonly mismatchChild?: boolean;
  readonly resolvedEventId?: EventId;
} = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installProgramVocabularyDraftEffectSchema(sqlite);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Primary workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Program owner', 1, 1, 1);
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
  if (options.resolvedEventId === nonCurrentEventId) {
    sqlite.query<never, [string, string, string, number, string]>(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date, version,
        created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, 'Older Event', 'UTC', '2026-09-01', '2026-09-02', 1, ?, ?, ?)
    `).run(workspaceId, nonCurrentEventId, userId, Date.parse(now), 'b'.repeat(64));
    sqlite.query<never, [string, string]>(`
      INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
    `).run(workspaceId, nonCurrentEventId);
  }
  sqlite.query<never, [string, string]>(`
    UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ? WHERE workspace_id = ?
  `).run(eventId, workspaceId);
  sqlite.exec('COMMIT;');

  const contributors = createSQLiteProgramVocabularyContributorAdapterRegistry({
    sqlite,
    expected: [],
    adapters: []
  });
  const repository = new SQLiteProgramVocabularyRepository(
    sqlite,
    referenceRegistry,
    contributors,
    () => ({ actorUserId: userId, occurredAt: now })
  );
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const ids: SQLiteProgramVocabularyDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newVocabularyItemId: next
  };
  const registration = createSQLiteProgramVocabularyDraftEffectDomainRegistration({
    sqlite,
    workspaceId,
    policy,
    referenceRegistry,
    contributors,
    eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource(),
    ids
  });
  const selected = options.mismatchChild
    ? mismatchChildAdapter(registration.adapter)
    : registration.adapter;
  const registry = createSQLiteEffectDomainAdapterRegistry([{
    capability: registration.capability,
    adapter: selected
  }]);
  const authority: Parameters<typeof createProgramVocabularyOperationModule>[0]['currentAuthority'] = {
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
  const module = createProgramVocabularyOperationModule({
    workspaceId,
    policies: {
      read: PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
      manage: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY
    },
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent: () => ({
        eventId: options.resolvedEventId ?? eventId,
        evidenceIds: ['event.current']
      })
    },
    vocabularyRead: repository,
    referenceRegistry,
    clock: { now: () => now },
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
          verifierSha256: createHash('sha256').update(`program-key:${raw}`).digest('hex')
        };
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, registry, {
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
    repository,
    lifecycle: createSQLiteDraftOnlyChangesetLifecycleStore(sqlite),
    close: () => sqlite.close(),
    async execute(input: ProgramVocabularyCreateDraftInput = createInput) {
      return this.executeOperation(PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION, input);
    },
    async executeOperation(
      operation: { readonly name: string; readonly version: number },
      input: unknown
    ) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: operation.name,
        operationVersion: operation.version,
        surface: 'operator_http',
        correlationId: uuid(0x900 + request),
        businessInput: input,
        verifiedEvidence: evidence,
        rawIdempotencyKey: `program-draft-${request++}`
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

function expectExecutionFailure(error: unknown, phase: OperationExecutionError['phase']): void {
  expect(error).toMatchObject({ name: 'OperationExecutionError', phase });
}

describe('ordinary SQLite Program Vocabulary draft effect-domain adapter', () => {
  test('atomically persists an inert scoped changeset, receipt link, and exact timeline child', async () => {
    const fixture = openFixture();
    try {
      const before = fixture.repository.readVocabulary({ workspaceId, eventId });
      const result = programVocabularyDraftOperationResultSchema.parse(await fixture.execute());
      expect(result).toMatchObject({
        kind: 'success',
        data: { action: 'create', status: 'draft', safeDiff: { action: 'create' } },
        receipt: {
          operationName: PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION.name,
          operationVersion: 1
        }
      });
      if (result.kind !== 'success') throw new TypeError('expected_success');
      const stored = fixture.lifecycle.read(result.data.changesetId);
      expect(stored).toMatchObject({
        head: { workspaceId, eventId, status: 'draft', version: 1 },
        revisions: [{
          revision: { createdAt: now, proposerPrincipalKey: `workspace_user:${userId}` },
          authorIntents: [{ authorInput: { action: 'create', scope: { workspaceId, eventId } } }]
        }]
      });
      expect(fixture.repository.readVocabulary({ workspaceId, eventId })).toEqual(before);
      expect(count(fixture.sqlite, 'program_vocabulary_sets')).toBe(0);
      expect(count(fixture.sqlite, 'program_vocabulary_rooms')).toBe(0);
      expect(count(fixture.sqlite, 'program_vocabulary_draft_receipt_links')).toBe(1);
      expect(count(fixture.sqlite, 'program_vocabulary_draft_timeline')).toBe(1);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('returns a typed stale planning refusal with zero changeset, receipt, or PV writes', async () => {
    const fixture = openFixture();
    try {
      expect(await fixture.execute({ ...createInput, expectedSetVersion: 2 })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: { class: 'stale_revision', kind: 'program_vocabulary.changed' }
      });
      expectNoDraftWrites(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });

  test('maps all six registered draft operations to their exact typed author action', async () => {
    const fixture = openFixture();
    const itemId = uuid(0xa01);
    const targetId = uuid(0xa02);
    const cases = [
      {
        action: 'create',
        operation: PROGRAM_VOCABULARY_CREATE_DRAFT_OPERATION,
        input: { ...createInput, expectedSetVersion: 2 }
      },
      {
        action: 'edit',
        operation: PROGRAM_VOCABULARY_EDIT_DRAFT_OPERATION,
        input: {
          kind: 'room', id: itemId, expectedSetVersion: 2, expectedItemVersion: 1,
          changes: { name: 'Updated Hall', capacity: 200 }
        }
      },
      {
        action: 'retire',
        operation: PROGRAM_VOCABULARY_RETIRE_DRAFT_OPERATION,
        input: { kind: 'room', id: itemId, expectedSetVersion: 2, expectedItemVersion: 1 }
      },
      {
        action: 'restore',
        operation: PROGRAM_VOCABULARY_RESTORE_DRAFT_OPERATION,
        input: { kind: 'room', id: itemId, expectedSetVersion: 2, expectedItemVersion: 1 }
      },
      {
        action: 'delete',
        operation: PROGRAM_VOCABULARY_DELETE_DRAFT_OPERATION,
        input: { kind: 'room', id: itemId, expectedSetVersion: 2, expectedItemVersion: 1 }
      },
      {
        action: 'merge',
        operation: PROGRAM_VOCABULARY_MERGE_DRAFT_OPERATION,
        input: {
          kind: 'room', sourceId: itemId, targetId,
          expectedSetVersion: 2, expectedSourceVersion: 1, expectedTargetVersion: 1
        }
      }
    ] as const;
    try {
      for (const entry of cases) {
        expect(await fixture.executeOperation(entry.operation, entry.input)).toMatchObject({
          kind: 'outcome',
          terminal: false,
          outcome: {
            class: 'stale_revision',
            kind: 'program_vocabulary.changed',
            detail: { code: 'stale_set', action: entry.action }
          }
        });
      }
      expectNoDraftWrites(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });

  test('rejects an existing but non-current Event scope before any draft write', async () => {
    const fixture = openFixture({ resolvedEventId: nonCurrentEventId });
    try {
      try {
        await fixture.execute();
        throw new Error('expected_execution_failure');
      } catch (error) {
        expectExecutionFailure(error, 'write_snapshot');
      }
      expectNoDraftWrites(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });

  test('rolls back the changeset, parent receipt, and child when timeline evidence is substituted', async () => {
    const fixture = openFixture({ mismatchChild: true });
    try {
      try {
        await fixture.execute();
        throw new Error('expected_execution_failure');
      } catch (error) {
        expectExecutionFailure(error, 'receipt_children');
      }
      expectNoDraftWrites(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });
});
