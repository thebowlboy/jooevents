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
  DRAFT_CHANGESET_CORRECTION_OPERATION,
  GET_CHANGESET_DIFF_OPERATION,
  PROPOSE_CHANGESET_OPERATION,
  REBUILD_CHANGESET_OPERATION,
  changesetDiffOperationResultSchema,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_FORM_CREATE_DRAFT_OPERATION,
  INTAKE_FORM_DRAFT_REQUEST_HASH_PROFILE,
  INTAKE_FORM_LIFECYCLE_DRAFT_OPERATION,
  INTAKE_FORM_PUBLISH_DRAFT_OPERATION,
  INTAKE_FORM_REVISE_DRAFT_OPERATION,
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
import { initializeCanonicalFieldRegistry, installFieldRegistrySchema } from './field-registry';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
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
import {
  createSQLiteIntakeFormVersionPinSource,
  installReleaseSchema,
  SQLiteReleaseRepository,
  SQLiteReleaseSurfaceSuccessorStore
} from './release';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';
import { planReleaseMutation } from '@jooevents/release';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const now = parseInstant('2026-08-12T09:00:00.000Z');
const themeArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfa211';
const applyArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfa212';
const templateRevisionOne = '019c1df7-86b5-769b-bba4-5f7097bfa213';
const templateRevisionTwo = '019c1df7-86b5-769b-bba4-5f7097bfa214';
const templatePin = (artifactId: string, revisionId = templateRevisionOne) => ({
  artifactId,
  revisionId,
  revisionNumber: revisionId === templateRevisionOne ? 1 : 2,
  digestSha256: (revisionId === templateRevisionOne ? 'd' : 'e').repeat(64)
});
const themeRecipe = {
  name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
  text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
};
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
const revisedDefinition = {
  ...createInput.definition,
  name: 'Revised CFP'
};

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function failingCommitChild(base: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  return {
    openHandlerSnapshot: base.openHandlerSnapshot.bind(base),
    applyDomainContribution: base.applyDomainContribution.bind(base),
    ...(base.afterReceiptParentInserted
      ? { afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base) }
      : {}),
    afterReceiptChildInserted(receiptId, contribution) {
      if ((contribution as { readonly kind?: unknown }).kind === 'domain_fact') {
        throw new TypeError('injected_form_changeset_child_failure');
      }
      return base.afterReceiptChildInserted?.(receiptId, contribution);
    },
    ...(base.afterExecutionClaimReleased
      ? { afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base) }
      : {})
  };
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

function openFixture(options: {
  readonly failCommitChild?: boolean;
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
  installIntakeFormChangesetEffectSchema(sqlite);
  // The successor collaboration reads/writes the release surface tables inside
  // any version-minting form plan, so the release schema is a hard install
  // prerequisite for the intake form effect domains.
  installReleaseSchema(sqlite);
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
      adapter: options.failCommitChild
        ? failingCommitChild(formLifecycle.adapter)
        : formLifecycle.adapter,
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

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    audits: count(fixture.sqlite, 'foundation_trial_operation_audits'),
    formHeads: count(fixture.sqlite, 'intake_form_heads'),
    formVersions: count(fixture.sqlite, 'intake_form_versions'),
    lifecycleLinks: count(fixture.sqlite, 'intake_form_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'intake_form_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'intake_form_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'intake_form_changeset_timeline'),
    commitLinks: count(fixture.sqlite, 'changeset_commit_links'),
    correctionLinks: count(fixture.sqlite, 'changeset_correction_links')
  };
}

describe('ordinary SQLite Form changeset effect-domain adapter', () => {
  test('routes Form through generic lifecycle, rebuilds, commits once, and replays exactly', async () => {
    const fixture = openFixture();
    try {
      const drafted = intakeFormDraftOperationResultSchema.parse(await fixture.effect({
        operation: INTAKE_FORM_CREATE_DRAFT_OPERATION,
        businessInput: createInput,
        key: 'create-draft'
      }));
      if (drafted.kind !== 'success') throw new TypeError('expected_form_draft');
      const rebuilt = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: REBUILD_CHANGESET_OPERATION,
        businessInput: {
          changesetId: drafted.data.changesetId,
          expectedHeadVersion: 1,
          sourceRevisionId: drafted.data.revision.id,
          sourceRevisionDigest: drafted.data.revision.digestSha256,
          groups: ['intake_form']
        },
        key: 'create-rebuild'
      }));
      if (rebuilt.kind !== 'success' || rebuilt.data.action !== 'rebuild') {
        throw new TypeError('expected_form_rebuild');
      }
      const selector = {
        changesetId: rebuilt.data.diff.changesetId,
        revisionId: rebuilt.data.diff.revisionId,
        revisionDigest: rebuilt.data.diff.revisionDigest
      };
      expect(await fixture.ownerResolution.resolveOwner(fixture.lifecycle.read(
        selector.changesetId
      )!)).toMatchObject({ id: 'intake_form' });
      expect(changesetDiffOperationResultSchema.parse(await fixture.read(
        GET_CHANGESET_DIFF_OPERATION, selector
      ))).toMatchObject({
        kind: 'success',
        data: { headVersion: 2, status: 'draft', operations: [{ kind: 'intake.form.mutate' }] }
      });
      expect(fixture.repository.readFormCatalog({ workspaceId, eventId })?.heads).toEqual([]);
      const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'create-propose'
      }));
      expect(proposed).toMatchObject({
        kind: 'success', data: { action: 'propose', diff: { headVersion: 3 } }
      });
      expect(fixture.repository.readFormCatalog({ workspaceId, eventId })?.heads).toEqual([]);
      const commitInput = { ...selector, expectedHeadVersion: 3 };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'create-commit'
      }));
      expect(committed).toMatchObject({
        kind: 'success', data: { action: 'commit', committedHeadVersion: 4 }
      });
      if (committed.kind !== 'success') throw new TypeError('expected_form_commit');
      const receiptId = committed.receipt.id;
      const committedCounts = durableCounts(fixture);
      expect(committedCounts).toMatchObject({
        formHeads: 1, lifecycleLinks: 3, facts: 1, pointers: 1, timeline: 3, commitLinks: 1
      });
      expect(fixture.sqlite.query<{
        readonly receipt_id: string;
        readonly action: string;
        readonly operation_name: string;
        readonly changeset_id: string;
        readonly revision_id: string;
        readonly fact_kind: string;
        readonly pointer_source: string;
        readonly timeline_source: string;
        readonly commit_receipt_id: string;
        readonly audit_disposition: string;
      }, [string]>(`
        SELECT link.receipt_id, link.action, link.operation_name,
               link.changeset_id, link.revision_id, fact.fact_kind,
               pointer.source_kind AS pointer_source,
               timeline.source_kind AS timeline_source,
               committed.commit_receipt_id,
               audit.disposition AS audit_disposition
          FROM intake_form_changeset_receipt_links AS link
          JOIN intake_form_changeset_domain_facts AS fact
            ON fact.receipt_id = link.receipt_id
          JOIN intake_form_changeset_outbox_pointers AS pointer
            ON pointer.receipt_id = link.receipt_id AND pointer.fact_id = fact.fact_id
          JOIN intake_form_changeset_timeline AS timeline
            ON timeline.receipt_id = link.receipt_id
          JOIN changeset_commit_links AS committed
            ON committed.changeset_id = link.changeset_id
           AND committed.revision_id = link.revision_id
           AND committed.revision_digest_sha256 = link.revision_digest_sha256
           AND committed.commit_receipt_id = link.receipt_id
          JOIN foundation_trial_operation_audits AS audit
            ON audit.receipt_id = link.receipt_id
         WHERE link.receipt_id = ?
      `).get(receiptId)).toEqual({
        receipt_id: receiptId,
        action: 'commit',
        operation_name: COMMIT_CHANGESET_OPERATION.name,
        changeset_id: selector.changesetId,
        revision_id: selector.revisionId,
        fact_kind: 'intake_form_changed',
        pointer_source: 'domain_fact',
        timeline_source: 'changeset_commit',
        commit_receipt_id: receiptId,
        audit_disposition: 'terminal_new'
      });
      expect(fixture.sqlite.query<{ readonly kind: string }, [string]>(`
        SELECT json_extract(contribution_json, '$.kind') AS kind
          FROM foundation_trial_operation_receipt_children
         WHERE receipt_id = ? ORDER BY ordinal
      `).all(receiptId)).toEqual([
        { kind: 'domain_fact' }, { kind: 'outbox_pointer' }, { kind: 'timeline' }
      ]);
      expect(changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'create-commit'
      }))).toMatchObject({ kind: 'success', receipt: { id: receiptId } });
      expect(durableCounts(fixture)).toEqual({ ...committedCounts, audits: committedCounts.audits + 1 });
      const replayedCounts = durableCounts(fixture);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...commitInput, expectedHeadVersion: 4 },
        key: 'create-commit'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });
      expect(durableCounts(fixture)).toEqual({
        ...replayedCounts,
        audits: replayedCounts.audits + 1
      });
      const conflictCounts = durableCounts(fixture);
      fixture.setRevoked(true);
      fixture.advance(1_000);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'create-commit'
      })).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(durableCounts(fixture)).toEqual({
        ...conflictCounts,
        audits: conflictCounts.audits + 1
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('returns typed stale catalog drift with zero lifecycle or Form writes', async () => {
    const fixture = openFixture();
    try {
      const { selector } = await draftAndPropose(
        fixture, createInput, INTAKE_FORM_CREATE_DRAFT_OPERATION, 'stale-create'
      );
      fixture.sqlite.exec(`
        INSERT INTO intake_form_catalogs (workspace_id, event_id, catalog_version)
        VALUES ('${workspaceId}', '${eventId}', 2);
      `);
      const before = durableCounts(fixture);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'stale-create-commit'
      })).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: {
          class: 'stale_revision', kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed', subjectId: `intake_form_catalog:${eventId}` }
        }
      });
      expect(durableCounts(fixture)).toEqual({ ...before, audits: before.audits + 1 });
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });

  test('drafts revise and lifecycle corrections with fresh actor time, and blocks create correction honestly', async () => {
    const fixture = openFixture();
    try {
      const created = await commitDraft(
        fixture, createInput, INTAKE_FORM_CREATE_DRAFT_OPERATION, 'correction-create'
      );
      const createdHead = fixture.repository.readFormCatalog({ workspaceId, eventId })?.heads[0];
      if (!createdHead) throw new TypeError('created_form_missing');
      const beforeBlockedCreate = durableCounts(fixture);
      const blockedCreate = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: created.selector.changesetId,
          sourceRevisionId: created.selector.revisionId,
          sourceRevisionDigest: created.selector.revisionDigest,
          sourceCommitReceiptId: created.result.receipt.id
        },
        key: 'correct-create-blocked'
      }));
      expect(blockedCreate).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction', resultKind: 'blocked', target: null,
          evidence: { blockers: [{ reasonKey: 'intake.form_delete_not_available' }] }
        }
      });
      expect(durableCounts(fixture)).toMatchObject({
        formHeads: beforeBlockedCreate.formHeads,
        correctionLinks: beforeBlockedCreate.correctionLinks + 1,
        lifecycleLinks: beforeBlockedCreate.lifecycleLinks + 1,
        timeline: beforeBlockedCreate.timeline + 1
      });
      fixture.advance(1_000);
      const revised = await commitDraft(fixture, {
        formId: createdHead.id,
        expectedDefinitionVersion: createdHead.version,
        expectedRegistryVersion: 1,
        definition: revisedDefinition
      }, INTAKE_FORM_REVISE_DRAFT_OPERATION, 'correction-revise');
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, createdHead.id)).toMatchObject({
        version: 2, definition: { name: 'Revised CFP' }
      });
      fixture.advance(1_000);
      const correctionAt = parseInstant('2026-08-12T09:00:02.000Z');
      const reviseCorrection = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: revised.selector.changesetId,
          sourceRevisionId: revised.selector.revisionId,
          sourceRevisionDigest: revised.selector.revisionDigest,
          sourceCommitReceiptId: revised.result.receipt.id
        },
        key: 'correct-revise'
      }));
      expect(reviseCorrection).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'semantic', target: { status: 'draft' } }
      });
      if (reviseCorrection.kind !== 'success' || reviseCorrection.data.action !== 'correction'
          || !reviseCorrection.data.target) throw new TypeError('revise_correction_missing');
      const reviseTarget = {
        changesetId: reviseCorrection.data.target.changesetId,
        revisionId: reviseCorrection.data.target.revisionId,
        revisionDigest: reviseCorrection.data.target.revisionDigest
      };
      const proposedCorrection = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: {
          ...reviseTarget,
          expectedHeadVersion: reviseCorrection.data.target.headVersion
        },
        key: 'correct-revise-propose'
      }));
      if (proposedCorrection.kind !== 'success' || proposedCorrection.data.action !== 'propose') {
        throw new TypeError('revise_correction_propose_missing');
      }
      const committedCorrection = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: {
          ...reviseTarget,
          expectedHeadVersion: proposedCorrection.data.diff.headVersion
        },
        key: 'correct-revise-commit'
      }));
      expect(committedCorrection).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, createdHead.id)).toMatchObject({
        version: 3,
        definition: { name: 'Main CFP' },
        updatedByUserId: userId,
        updatedAt: correctionAt
      });

      fixture.advance(1_000);
      const opened = await commitDraft(fixture, {
        formId: createdHead.id,
        expectedDefinitionVersion: 3,
        expectedRegistryVersion: 1,
        transition: 'publish_and_open'
      }, INTAKE_FORM_LIFECYCLE_DRAFT_OPERATION, 'correction-open');
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, createdHead.id))
        .toMatchObject({ version: 4, status: 'open' });
      fixture.advance(1_000);
      const published = await commitDraft(fixture, {
        formId: createdHead.id,
        expectedDefinitionVersion: 4,
        expectedRegistryVersion: 1
      }, INTAKE_FORM_PUBLISH_DRAFT_OPERATION, 'correction-publish');
      const beforeBlockedPublish = durableCounts(fixture);
      const blockedPublish = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: published.selector.changesetId,
          sourceRevisionId: published.selector.revisionId,
          sourceRevisionDigest: published.selector.revisionDigest,
          sourceCommitReceiptId: published.result.receipt.id
        },
        key: 'correct-publish-blocked'
      }));
      expect(blockedPublish).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction', resultKind: 'blocked', target: null,
          evidence: { blockers: [{ reasonKey: 'intake.form_published_version_is_immutable' }] }
        }
      });
      expect(durableCounts(fixture)).toMatchObject({
        formHeads: beforeBlockedPublish.formHeads,
        formVersions: beforeBlockedPublish.formVersions,
        correctionLinks: beforeBlockedPublish.correctionLinks + 1
      });
      fixture.advance(1_000);
      const closed = await commitDraft(fixture, {
        formId: createdHead.id,
        expectedDefinitionVersion: 5,
        transition: 'close'
      }, INTAKE_FORM_LIFECYCLE_DRAFT_OPERATION, 'correction-close');
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, createdHead.id)?.status)
        .toBe('closed');
      fixture.advance(1_000);
      const lifecycleCorrectionAt = parseInstant('2026-08-12T09:00:06.000Z');
      const lifecycleCorrection = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: closed.selector.changesetId,
          sourceRevisionId: closed.selector.revisionId,
          sourceRevisionDigest: closed.selector.revisionDigest,
          sourceCommitReceiptId: closed.result.receipt.id
        },
        key: 'correct-close'
      }));
      expect(lifecycleCorrection).toMatchObject({
        kind: 'success',
        data: { action: 'correction', resultKind: 'semantic', target: { status: 'draft' } }
      });
      if (lifecycleCorrection.kind !== 'success'
          || lifecycleCorrection.data.action !== 'correction'
          || !lifecycleCorrection.data.target) throw new TypeError('lifecycle_correction_missing');
      const lifecycleTarget = {
        changesetId: lifecycleCorrection.data.target.changesetId,
        revisionId: lifecycleCorrection.data.target.revisionId,
        revisionDigest: lifecycleCorrection.data.target.revisionDigest
      };
      const lifecycleProposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: {
          ...lifecycleTarget,
          expectedHeadVersion: lifecycleCorrection.data.target.headVersion
        },
        key: 'correct-close-propose'
      }));
      if (lifecycleProposed.kind !== 'success' || lifecycleProposed.data.action !== 'propose') {
        throw new TypeError('lifecycle_correction_propose_missing');
      }
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: {
          ...lifecycleTarget,
          expectedHeadVersion: lifecycleProposed.data.diff.headVersion
        },
        key: 'correct-close-commit'
      })).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, createdHead.id)).toMatchObject({
        status: 'open', updatedByUserId: userId, updatedAt: lifecycleCorrectionAt
      });
      const beforeLaterHead = durableCounts(fixture);
      const laterHeadBlocked = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: opened.selector.changesetId,
          sourceRevisionId: opened.selector.revisionId,
          sourceRevisionDigest: opened.selector.revisionDigest,
          sourceCommitReceiptId: opened.result.receipt.id
        },
        key: 'correct-open-after-later-head'
      }));
      expect(laterHeadBlocked).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction', resultKind: 'blocked', target: null,
          evidence: { blockers: [{ reasonKey: 'intake.form_later_change' }] }
        }
      });
      expect(durableCounts(fixture)).toMatchObject({
        formHeads: beforeLaterHead.formHeads,
        formVersions: beforeLaterHead.formVersions,
        correctionLinks: beforeLaterHead.correctionLinks + 1
      });
      expect(opened.result.data.action).toBe('commit');
    } finally {
      fixture.close();
    }
  });

  test('a committed republish re-releases the pinned apply surface in the same unit of work', async () => {
    const fixture = openFixture();
    const scope = { workspaceId, eventId };
    try {
      await commitDraft(fixture, createInput, INTAKE_FORM_CREATE_DRAFT_OPERATION, 'successor-create');
      const formId = fixture.repository.readFormCatalog(scope)!.heads[0]!.id;
      fixture.advance(1_000);
      await commitDraft(fixture, {
        formId,
        expectedDefinitionVersion: 1,
        expectedRegistryVersion: 1,
        transition: 'publish_and_open'
      }, INTAKE_FORM_LIFECYCLE_DRAFT_OPERATION, 'successor-open');
      const openedHead = fixture.repository.readFormHead(scope, formId);
      const versionOne = openedHead?.currentPublishedVersionId;
      if (!versionOne) throw new TypeError('successor_first_version_missing');

      // Publish a style set and an apply surface pinning version 1 through the
      // canonical release domain over the same database.
      const releases = new SQLiteReleaseRepository(fixture.sqlite, {
        sessions: { readSessionCatalog: () => { throw new TypeError('unused_source'); } },
        schedule: { readSchedule: () => { throw new TypeError('unused_source'); } },
        engagements: { readEngagementSnapshot: () => { throw new TypeError('unused_source'); } },
        vocabulary: { readVocabulary: () => { throw new TypeError('unused_source'); } },
        eventSettings: { readEventSettings: () => { throw new TypeError('unused_source'); } },
        names: { readParticipantDisplayName: () => { throw new TypeError('unused_source'); } },
        forms: createSQLiteIntakeFormVersionPinSource(fixture.sqlite),
        templates: {
          readPinnedArtifact: (_scope, pin) => {
            if (pin.artifactId === themeArtifactId
                && pin.revisionId === templateRevisionOne) return {
              kind: 'theme' as const, recipe: themeRecipe, markText: 'JE'
            };
            if (pin.artifactId !== applyArtifactId) return undefined;
            const heading = pin.revisionId === templateRevisionOne
              ? 'Apply now'
              : pin.revisionId === templateRevisionTwo ? 'Apply today' : null;
            return heading === null ? undefined : {
              kind: 'surface' as const, surfaceKind: 'application-form' as const,
              name: 'Apply', purpose: 'Application.',
              blocks: [{ type: 'hero' as const, title: heading, intro: '' }], usedBy: []
            };
          }
        }
      });
      const releasedAt = '2026-08-12T09:00:01.000Z';
      const styleSetReleaseId = uuid(0xa001);
      const surfaceReleaseId = uuid(0xa002);
      const stylePlan = planReleaseMutation({
        planningInput: {
          action: 'style_set_publish',
          scope,
          actorUserId: userId,
          occurredAt: releasedAt,
          releaseId: styleSetReleaseId,
          sourceTemplateRevision: templatePin(themeArtifactId),
          recipe: themeRecipe,
          expectedCurrentStyleSetNumber: null
        },
        port: releases
      });
      fixture.sqlite.exec('BEGIN IMMEDIATE;');
      releases.applyReleasePlan(stylePlan);
      fixture.sqlite.exec('COMMIT;');
      const surfacePlan = planReleaseMutation({
        planningInput: {
          action: 'surface_publish',
          scope,
          actorUserId: userId,
          occurredAt: releasedAt,
          releaseId: surfaceReleaseId,
          kind: 'apply',
          sourceTemplateRevision: templatePin(applyArtifactId),
          manifest: { schemaVersion: 1, heading: 'Apply now', intro: null },
          styleSetReleaseId,
          formRef: { formId, formVersionId: versionOne },
          expectedSurfaceHeadVersion: null
        },
        port: releases
      });
      fixture.sqlite.exec('BEGIN IMMEDIATE;');
      releases.applyReleasePlan(surfacePlan);
      fixture.sqlite.exec('COMMIT;');

      fixture.advance(1_000);
      const { draft, selector, proposed } = await draftAndPropose(fixture, {
        formId,
        expectedDefinitionVersion: 2,
        expectedRegistryVersion: 1
      }, INTAKE_FORM_PUBLISH_DRAFT_OPERATION, 'successor-republish');
      if (draft.kind !== 'success' || draft.data.safeDiff.action !== 'publish') {
        throw new TypeError('successor_republish_draft_missing');
      }
      expect(draft.data.safeDiff.surfaceSuccessors).toEqual([{
        surfaceReleaseId: expect.any(String),
        supersedesReleaseId: surfaceReleaseId,
        formVersionId: draft.data.safeDiff.publishedVersion.id,
        headVersion: 2
      }]);
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: {
          ...selector,
          expectedHeadVersion: proposed.kind === 'success' && proposed.data.action === 'propose'
            ? proposed.data.diff.headVersion
            : 0
        },
        key: 'successor-republish-commit'
      }));
      expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });

      const versionTwo = fixture.repository.readFormHead(scope, formId)?.currentPublishedVersionId;
      if (!versionTwo || versionTwo === versionOne) {
        throw new TypeError('successor_republish_version_missing');
      }
      const store = new SQLiteReleaseSurfaceSuccessorStore(fixture.sqlite);
      const head = store.readSurfaceHead(scope, 'apply');
      expect(head).toMatchObject({ kind: 'apply', version: 2 });
      const active = store.readSurfaceRelease(scope, head!.activeReleaseId);
      expect(active).toMatchObject({
        kind: 'apply',
        number: 2,
        predecessor: { releaseId: surfaceReleaseId },
        formRef: { formId, formVersionId: versionTwo }
      });
      expect(count(fixture.sqlite, 'surface_releases')).toBe(2);
      // The hosted successor rides the intake commit fact as a canonical
      // release-domain surface_publish result.
      const factRow = fixture.sqlite.query<{ readonly payload_json: string }, [string]>(`
        SELECT payload_json FROM intake_form_changeset_domain_facts
         WHERE changeset_id = ?
      `).get(selector.changesetId);
      const payload = JSON.parse(factRow!.payload_json) as {
        readonly contributions: readonly {
          readonly facts: readonly { readonly kind: string; readonly payload: unknown }[];
        }[];
      };
      expect(payload.contributions[0]!.facts.map((fact) => fact.kind))
        .toEqual(['intake_form_changed', 'release_changed']);
      expect(payload.contributions[0]!.facts[1]!.payload).toMatchObject({
        action: 'surface_publish',
        release: { formRef: { formId, formVersionId: versionTwo } },
        head: { activeReleaseId: head!.activeReleaseId, version: 2 }
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);

      // A surface publish landing between propose and commit moves the fenced
      // apply head and refuses the pending republish instead of committing a
      // stale successor.
      fixture.advance(1_000);
      const drifted = await draftAndPropose(fixture, {
        formId,
        expectedDefinitionVersion: 3,
        expectedRegistryVersion: 1
      }, INTAKE_FORM_PUBLISH_DRAFT_OPERATION, 'successor-drift');
      const repinPlan = planReleaseMutation({
        planningInput: {
          action: 'surface_publish',
          scope,
          actorUserId: userId,
          occurredAt: '2026-08-12T09:00:03.000Z',
          releaseId: uuid(0xa003),
          kind: 'apply',
          sourceTemplateRevision: templatePin(applyArtifactId, templateRevisionTwo),
          manifest: { schemaVersion: 1, heading: 'Apply today', intro: null },
          styleSetReleaseId,
          formRef: { formId, formVersionId: versionTwo },
          expectedSurfaceHeadVersion: 2
        },
        port: releases
      });
      fixture.sqlite.exec('BEGIN IMMEDIATE;');
      releases.applyReleasePlan(repinPlan);
      fixture.sqlite.exec('COMMIT;');
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: {
          ...drifted.selector,
          expectedHeadVersion: drifted.proposed.kind === 'success'
            && drifted.proposed.data.action === 'propose'
            ? drifted.proposed.data.diff.headVersion
            : 0
        },
        key: 'successor-drift-commit'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed', subjectId: `surface_head_state:${eventId}:apply` }
        }
      });
      expect(count(fixture.sqlite, 'surface_releases')).toBe(3);
      expect(count(fixture.sqlite, 'intake_form_versions')).toBe(2);
    } finally {
      fixture.close();
    }
  });

  test('rolls back effective Form, receipt, fact, pointer, timeline and commit link on late failure', async () => {
    const fixture = openFixture({ failCommitChild: true });
    try {
      const { selector } = await draftAndPropose(
        fixture, createInput, INTAKE_FORM_CREATE_DRAFT_OPERATION, 'atomic-create'
      );
      const before = durableCounts(fixture);
      await expect(fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'atomic-create-commit'
      })).rejects.toThrow('Operation execution failed during receipt_children.');
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });
});
