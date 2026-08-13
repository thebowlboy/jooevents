import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence,
  type OperationExecutionError
} from '@jooevents/application';
import type { FormDefinitionCreateDraftInput } from '@jooevents/contracts';
import { issueFormOrdinaryPolicy } from '@jooevents/intake';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_FORM_CREATE_DRAFT_OPERATION,
  INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
  createIntakeFormDraftOperationModule,
  intakeFormDraftOperationResultSchema
} from '@jooevents/intake-operations';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type EventId
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
import { initializeCanonicalFieldRegistry, installFieldRegistrySchema } from './field-registry';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from './foundation-trial-uow';
import {
  createSQLiteIntakeFormDraftEffectDomainRegistration,
  installSQLiteIntakeFormDraftEffectSchema,
  type SQLiteIntakeFormDraftEffectIds
} from './intake-form-draft-effect-domain';
import { installSQLiteIntakeSchema, SQLiteIntakeRepository } from './intake';
import { installDeadlineSchema } from './deadline';
import { installProgramVocabularySchema } from './program-vocabulary';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const nonCurrentEventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa102');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const now = parseInstant('2026-08-12T09:00:00.000Z');
const profile = Object.freeze({ key: 'intake-form-sqlite-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'verified-session-handle'
});
const policy = issueFormOrdinaryPolicy({
  key: 'intake.form.bounded', version: 1, ordinaryRisk: 'low',
  approval: { ordinary: 'none' }
});
const createInput: FormDefinitionCreateDraftInput = {
  expectedCatalogVersion: 1,
  expectedRegistryVersion: 1,
  definition: {
    kind: 'cfp', name: 'Main CFP', target: { kind: 'general_pool' },
    availability: { kind: 'evergreen' }, confirmation: 'Application received.',
    composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
    rules: []
  }
};

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function expectNoWrites(sqlite: ReturnType<typeof openSQLite>['sqlite']): void {
  for (const table of [
    'changeset_heads', 'changeset_revisions', 'intake_form_draft_receipt_links',
    'intake_form_draft_timeline', 'foundation_trial_operation_receipts',
    'foundation_trial_operation_receipt_children', 'intake_form_heads', 'intake_form_versions'
  ]) expect(count(sqlite, table), table).toBe(0);
}

function mismatchedChild(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  if (!base.afterReceiptParentInserted || !base.afterReceiptChildInserted
      || !base.afterExecutionClaimReleased || !base.afterUnitOfWorkCommitted) {
    throw new TypeError('intake_form_draft_test_hooks_missing');
  }
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base),
    afterReceiptChildInserted(receiptId, contribution) {
      const changed = structuredClone(contribution) as Record<string, unknown>;
      changed.timelineId = uuid(0xff01);
      return base.afterReceiptChildInserted!(receiptId, changed);
    },
    afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base),
    afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base),
    ...(base.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base) }
      : {})
  };
}

function openFixture(options: {
  readonly mismatchChild?: boolean;
  readonly resolvedEventId?: EventId;
  readonly noCurrentEvent?: boolean;
} = {}) {
  const { sqlite } = openSQLite(':memory:');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  installSQLiteIntakeFormDraftEffectSchema(sqlite);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Primary workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Form owner', 1, 1, 1);
  sqlite.exec('BEGIN IMMEDIATE;');
  sqlite.query<never, [string]>(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)
  `).run(workspaceId);
  sqlite.query<never, [string, string, string, number, string]>(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Forms Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
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

  let nextRegistrySuffix = 0x2000;
  const nextRegistryId = () => uuid(nextRegistrySuffix++);
  sqlite.exec('BEGIN IMMEDIATE;');
  initializeCanonicalFieldRegistry({
    sqlite, scope: { workspaceId, eventId },
    ids: { newFieldId: nextRegistryId, newChoiceId: nextRegistryId }
  });
  sqlite.exec('COMMIT;');

  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory() { return undefined; }
  });
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const ids: SQLiteIntakeFormDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newFormEntityId: next,
    newFormVersionId: next
  };
  const registration = createSQLiteIntakeFormDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, repository,
    eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource(), ids
  });
  const adapter = options.mismatchChild
    ? mismatchedChild(registration.adapter)
    : registration.adapter;
  const registry = createSQLiteEffectDomainAdapterRegistry([{
    capability: registration.capability, adapter
  }]);
  const authority: Parameters<typeof createIntakeFormDraftOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (input.evidence.kind !== 'operator') {
        return { kind: 'denied', reason: 'lane_mismatch' };
      }
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId, membershipId },
          lane: input.lane,
          scope: input.scope,
          grants: [{ kind: 'permission', key: 'event.manage' }],
          evidenceIds: ['membership.current'], authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const module = createIntakeFormDraftOperationModule({
    workspaceId,
    policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: { resolveCurrentEvent: () => options.noCurrentEvent
      ? { evidenceIds: ['event.none'] }
      : { eventId: options.resolvedEventId ?? eventId, evidenceIds: ['event.current'] } },
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x45)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(raw) {
          return {
            verifierProfile: profile,
            verifierSha256: createHash('sha256').update(`intake-form:${raw}`).digest('hex')
          };
        }
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
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => now }, newInvocationId: () => parseInvocationId(next())
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
    async execute(input: FormDefinitionCreateDraftInput = createInput) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: INTAKE_FORM_CREATE_DRAFT_OPERATION.name,
        operationVersion: 1,
        surface: 'operator_http',
        correlationId: uuid(0x900 + request),
        businessInput: input,
        verifiedEvidence: evidence,
        rawIdempotencyKey: `intake-form-draft-${request++}`
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

function expectExecutionFailure(error: unknown, phase: OperationExecutionError['phase']): void {
  expect(error).toMatchObject({ name: 'OperationExecutionError', phase });
}

describe('ordinary SQLite Form draft effect-domain adapter', () => {
  test('persists an inert Form changeset, exact receipt link and timeline atomically', async () => {
    const fixture = openFixture();
    try {
      const result = intakeFormDraftOperationResultSchema.parse(await fixture.execute());
      expect(result).toMatchObject({
        kind: 'success',
        data: { action: 'create', status: 'draft', safeDiff: { action: 'create' } },
        receipt: { operationName: INTAKE_FORM_CREATE_DRAFT_OPERATION.name, operationVersion: 1 }
      });
      if (result.kind !== 'success') throw new TypeError('expected_success');
      expect(fixture.lifecycle.read(result.data.changesetId)).toMatchObject({
        head: { workspaceId, eventId, status: 'draft', version: 1 },
        revisions: [{
          revision: { createdAt: now, proposerPrincipalKey: `workspace_user:${userId}` },
          authorIntents: [{ authorInput: { action: 'create', scope: { workspaceId, eventId } } }]
        }]
      });
      expect(fixture.repository.readFormCatalog({ workspaceId, eventId })).toEqual({
        scope: { workspaceId, eventId }, version: 1, heads: []
      });
      expect(count(fixture.sqlite, 'intake_form_draft_receipt_links')).toBe(1);
      expect(count(fixture.sqlite, 'intake_form_draft_timeline')).toBe(1);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('returns a typed stale refusal with zero changeset, receipt or Form writes', async () => {
    const fixture = openFixture();
    try {
      expect(await fixture.execute({ ...createInput, expectedCatalogVersion: 2 })).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: { class: 'stale_revision', kind: 'intake_form.changed' }
      });
      expectNoWrites(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });

  test('returns a typed event-required refusal with zero writes when no Event is current', async () => {
    const fixture = openFixture({ noCurrentEvent: true });
    try {
      expect(await fixture.execute()).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'conflict',
          kind: 'intake_form.event_required',
          retryable: false,
          detail: null
        }
      });
      expectNoWrites(fixture.sqlite);
    } finally {
      fixture.close();
    }
  });

  test('rejects a non-current Event and rolls back substituted child evidence completely', async () => {
    for (const { fixture, phase } of [
      { fixture: openFixture({ resolvedEventId: nonCurrentEventId }), phase: 'write_snapshot' as const },
      { fixture: openFixture({ mismatchChild: true }), phase: 'receipt_children' as const }
    ]) {
      try {
        try {
          await fixture.execute();
          throw new Error('expected_execution_failure');
        } catch (error) {
          expectExecutionFailure(error, phase);
        }
        expectNoWrites(fixture.sqlite);
      } finally {
        fixture.close();
      }
    }
  });
});
