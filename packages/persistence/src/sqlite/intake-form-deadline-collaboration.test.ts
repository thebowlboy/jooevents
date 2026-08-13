import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import type { FormDefinitionCreateDraftInput } from '@jooevents/contracts';
import { issueFormOrdinaryPolicy } from '@jooevents/intake';
import {
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  COMMIT_CHANGESET_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_FORM_CREATE_DRAFT_OPERATION,
  INTAKE_FORM_CLOSING_DRAFT_OPERATION,
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
  type Instant
} from '@jooevents/kernel';
import { openSQLite } from './database';
import {
  installSQLiteChangesetLifecycleSchema
} from './changeset-lifecycle';
import {
  createSQLiteChangesetLifecycleEffectDomainRouter,
  type SQLiteChangesetLifecycleOwnerRegistration
} from './changeset-lifecycle-effect-domain-router';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import {
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema
} from './field-registry';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import {
  createSQLiteIntakeFormChangesetEffectDomainRegistration,
  installIntakeFormChangesetEffectSchema,
  type SQLiteIntakeFormChangesetEffectIds
} from './intake-form-changeset-effect-domain';
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
function createInput(registryVersion: number, closesAt: string | null): FormDefinitionCreateDraftInput {
  return {
    expectedCatalogVersion: 1,
    expectedRegistryVersion: registryVersion,
    definition: {
      kind: 'cfp', name: 'Main CFP', target: { kind: 'general_pool' },
      availability: closesAt === null
        ? { kind: 'evergreen' }
        : { kind: 'fixed_close_date', displayDate: closesAt },
      confirmation: 'Application received.',
      composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
      rules: []
    }
  };
}

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function unselectedOwner(
  ownerId: 'program_vocabulary' | 'schedule_placement'
): SQLiteChangesetLifecycleOwnerRegistration {
  return {
    ownerId,
    adapter: {
      openHandlerSnapshot() { throw new TypeError(`unexpected_${ownerId}_selection`); },
      applyDomainContribution() { throw new TypeError(`unexpected_${ownerId}_selection`); }
    },
    ownerResolution: { resolveOwner() { return undefined; } },
    subjectRelationships: {
      validateSubject() { return { kind: 'denied', reason: 'cross_scope' }; }
    }
  };
}

function openFixture() {
  const { sqlite } = openSQLite(':memory:');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installDeadlineSchema(sqlite);
  installSQLiteIntakeFormDraftEffectSchema(sqlite);
  installIntakeFormChangesetEffectSchema(sqlite);
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
  sqlite.query<never, [string, string]>(`
    UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ? WHERE workspace_id = ?
  `).run(eventId, workspaceId);
  sqlite.exec('COMMIT;');

  let nextRegistrySuffix = 0x2000;
  const nextRegistryId = () => uuid(nextRegistrySuffix++);
  sqlite.exec('BEGIN IMMEDIATE;');
  const fieldRegistry = initializeCanonicalFieldRegistry({
    sqlite,
    scope: { workspaceId, eventId },
    ids: { newFieldId: nextRegistryId, newChoiceId: nextRegistryId }
  });
  sqlite.exec('COMMIT;');

  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory() { return undefined; }
  });
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteIntakeFormDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newFormEntityId: next,
    newFormVersionId: next
  };
  const lifecycleIds: SQLiteIntakeFormChangesetEffectIds = {
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
  const draftRegistration = createSQLiteIntakeFormDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, repository,
    eventRelationships, ids: draftIds
  });
  const formLifecycle = createSQLiteIntakeFormChangesetEffectDomainRegistration({
    sqlite, workspaceId, policy, repository, eventRelationships, ids: lifecycleIds
  });
  const routedLifecycle = createSQLiteChangesetLifecycleEffectDomainRouter([
    unselectedOwner('program_vocabulary'),
    {
      ownerId: formLifecycle.ownerId,
      adapter: formLifecycle.adapter,
      ownerResolution: formLifecycle.ownerResolution,
      subjectRelationships: formLifecycle.subjectRelationships
    },
    unselectedOwner('schedule_placement')
  ]);
  const registry = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    routedLifecycle
  ]);
  let revoked = false;
  let currentTime: Instant = now;
  const authority: Parameters<typeof createIntakeFormDraftOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (revoked) return { kind: 'denied', reason: 'revoked' };
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
  const draftModule = createIntakeFormDraftOperationModule({
    workspaceId,
    policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] }) },
    clock: { now: () => currentTime },
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
  const lifecycleModule = createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority,
    lifecycleStore: formLifecycle.lifecycleStore,
    ownerResolution: routedLifecycle.ownerResolution,
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
          verifierSha256: createHash('sha256').update(`intake-form:${raw}`).digest('hex')
        };
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, registry, {
    resolveAuthority: authority.resolve,
    now: () => currentTime
  });
  let receiptId = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([draftModule, lifecycleModule]),
    read: {
      operationalTrace: { emit() {} }, immutableAudit: { append() {} },
      clock: { now: () => currentTime }, newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let request = 0x900;
  return {
    sqlite,
    repository,
    lifecycle: formLifecycle.lifecycleStore,
    ownerResolution: routedLifecycle.ownerResolution,
    registryVersion: fieldRegistry.version,
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
        correlationId: uuid(request++),
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
        correlationId: uuid(request++),
        businessInput: input.businessInput,
        verifiedEvidence: evidence,
        rawIdempotencyKey: input.key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

async function draftAndPropose(
  fixture: ReturnType<typeof openFixture>,
  input: unknown,
  operation: { readonly name: string; readonly version: number },
  key: string
) {
  const draft = intakeFormDraftOperationResultSchema.parse(await fixture.effect({
    operation,
    businessInput: input,
    key: `${key}-draft`
  }));
  if (draft.kind !== 'success') throw new TypeError('form_changeset_draft_failed');
  const selector = {
    changesetId: draft.data.changesetId,
    revisionId: draft.data.revision.id,
    revisionDigest: draft.data.revision.digestSha256
  };
  const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: PROPOSE_CHANGESET_OPERATION,
    businessInput: { ...selector, expectedHeadVersion: draft.data.headVersion },
    key: `${key}-propose`
  }));
  if (proposed.kind !== 'success' || proposed.data.action !== 'propose') {
    throw new TypeError('form_changeset_propose_failed');
  }
  return { draft, selector, proposed };
}

async function commitDraft(
  fixture: ReturnType<typeof openFixture>,
  input: unknown,
  operation: { readonly name: string; readonly version: number },
  key: string
) {
  const { selector, proposed } = await draftAndPropose(fixture, input, operation, key);
  const result = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: COMMIT_CHANGESET_OPERATION,
    businessInput: {
      ...selector,
      expectedHeadVersion: proposed.kind === 'success' && proposed.data.action === 'propose'
        ? proposed.data.diff.headVersion
        : 0
    },
    key: `${key}-commit`
  }));
  if (result.kind !== 'success' || result.data.action !== 'commit') {
    throw new TypeError('form_changeset_commit_failed');
  }
  return { selector, result };
}

describe('SQLite Form and canonical Deadline collaboration', () => {
  test('creates, updates, and clears one linked Deadline in each Form-owned changeset UoW', async () => {
    const fixture = openFixture();
    try {
      await commitDraft(
        fixture,
        createInput(fixture.registryVersion, '2026-11-01'),
        INTAKE_FORM_CREATE_DRAFT_OPERATION,
        'deadline-form-create'
      );
      const createdForm = fixture.repository.readFormCatalog({ workspaceId, eventId })?.heads[0];
      if (!createdForm || createdForm.definition.availability.kind !== 'deadline') {
        throw new TypeError('created_deadline_form_missing');
      }
      const deadlineId = createdForm.definition.availability.deadlineId;
      expect(createdForm).toMatchObject({
        version: 1,
        definition: { availability: { kind: 'deadline', deadlineId } }
      });
      expect(fixture.repository.readDeadline({ workspaceId, eventId }, deadlineId)).toMatchObject({
        id: deadlineId,
        status: 'active',
        version: 1,
        displayDate: '2026-11-01',
        effectiveAt: '2026-11-02T00:00:00.000Z'
      });
      expect(fixture.repository.readDeadlineCatalog({ workspaceId, eventId })).toMatchObject({
        version: 2,
        deadlines: [{ id: deadlineId, version: 1, status: 'active' }]
      });

      fixture.advance(1_000);
      await commitDraft(fixture, {
        formId: createdForm.id,
        expectedDefinitionVersion: createdForm.version,
        closesAt: '2026-11-02'
      }, INTAKE_FORM_CLOSING_DRAFT_OPERATION, 'deadline-form-update');
      const updatedForm = fixture.repository.readFormHead(
        { workspaceId, eventId }, createdForm.id
      );
      expect(updatedForm).toMatchObject({
        version: 2,
        definition: { availability: { kind: 'deadline', deadlineId } }
      });
      expect(fixture.repository.readDeadline({ workspaceId, eventId }, deadlineId)).toMatchObject({
        id: deadlineId,
        status: 'active',
        version: 2,
        displayDate: '2026-11-02',
        effectiveAt: '2026-11-03T00:00:00.000Z'
      });
      expect(fixture.repository.readDeadlineCatalog({ workspaceId, eventId })?.version).toBe(3);

      fixture.advance(1_000);
      await commitDraft(fixture, {
        formId: createdForm.id,
        expectedDefinitionVersion: 2,
        closesAt: null
      }, INTAKE_FORM_CLOSING_DRAFT_OPERATION, 'deadline-form-clear');
      expect(fixture.repository.readFormHead(
        { workspaceId, eventId }, createdForm.id
      )).toMatchObject({
        version: 3,
        definition: { availability: { kind: 'evergreen' } }
      });
      expect(fixture.repository.readDeadline({ workspaceId, eventId }, deadlineId)).toMatchObject({
        id: deadlineId,
        status: 'cleared',
        version: 3,
        displayDate: null,
        effectiveAt: null
      });
      expect(fixture.repository.resolveCurrentDeadline(
        { workspaceId, eventId }, { kind: 'deadline', deadlineId }
      )).toBeUndefined();
      expect(fixture.repository.readDeadlineCatalog({ workspaceId, eventId })?.version).toBe(4);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rolls back a Deadline update when the later Form head write fails', async () => {
    const fixture = openFixture();
    try {
      await commitDraft(
        fixture,
        createInput(fixture.registryVersion, '2026-11-01'),
        INTAKE_FORM_CREATE_DRAFT_OPERATION,
        'deadline-form-rollback-create'
      );
      const form = fixture.repository.readFormCatalog({ workspaceId, eventId })?.heads[0];
      if (!form || form.definition.availability.kind !== 'deadline') {
        throw new TypeError('rollback_deadline_form_missing');
      }
      const deadlineId = form.definition.availability.deadlineId;
      const { selector, proposed } = await draftAndPropose(fixture, {
        formId: form.id,
        expectedDefinitionVersion: form.version,
        closesAt: '2026-11-02'
      }, INTAKE_FORM_CLOSING_DRAFT_OPERATION, 'deadline-form-rollback-update');
      fixture.sqlite.exec(`
        CREATE TRIGGER form_deadline_collaboration_fail_form_head
        BEFORE UPDATE ON intake_form_heads
        BEGIN SELECT RAISE(ABORT, 'injected later Form head failure'); END;
      `);
      await expect(fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: {
          ...selector,
          expectedHeadVersion: proposed.kind === 'success' && proposed.data.action === 'propose'
            ? proposed.data.diff.headVersion
            : 0
        },
        key: 'deadline-form-rollback-update-commit'
      })).rejects.toThrow('Operation execution failed during handler.');
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, form.id)).toMatchObject({
        version: 1,
        definition: { availability: { kind: 'deadline', deadlineId } }
      });
      expect(fixture.repository.readDeadline({ workspaceId, eventId }, deadlineId)).toMatchObject({
        version: 1,
        status: 'active',
        displayDate: '2026-11-01'
      });
      expect(fixture.repository.readDeadlineCatalog({ workspaceId, eventId })?.version).toBe(2);
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });
});
