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
  fieldRegistryDraftOperationResultSchema,
  fieldRegistrySnapshotReadResultSchema
} from '@jooevents/contracts';
import {
  FIELD_REGISTRY_ADD_DRAFT_OPERATION,
  FIELD_REGISTRY_DRAFT_REQUEST_HASH_PROFILE,
  FIELD_REGISTRY_EDIT_DRAFT_OPERATION,
  FIELD_REGISTRY_MANAGE_ACCESS_POLICY,
  FIELD_REGISTRY_MOVE_DRAFT_OPERATION,
  FIELD_REGISTRY_READ_ACCESS_POLICY,
  FIELD_REGISTRY_REMOVE_DRAFT_OPERATION,
  FIELD_REGISTRY_RESTORE_DRAFT_OPERATION,
  createFieldRegistryOperationModule,
  createFieldRegistryOrdinaryPolicy
} from '@jooevents/field-registry';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { openSQLite } from './database';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import {
  createSQLiteFieldRegistryChangesetEffectDomainRegistration,
  installFieldRegistryChangesetEffectSchema,
  type SQLiteFieldRegistryChangesetEffectIds
} from './field-registry-changeset-effect-domain';
import {
  createSQLiteFieldRegistryDraftEffectDomainRegistration,
  installFieldRegistryDraftEffectSchema,
  type SQLiteFieldRegistryDraftEffectIds
} from './field-registry-draft-effect-domain';
import {
  initializeCanonicalFieldRegistry,
  installFieldRegistrySchema,
  SQLiteFieldRegistryRepository,
  SQLiteIntakeFieldRegistryFormReferenceResolver,
  SQLiteProgramVocabularyFieldOptionSource
} from './field-registry';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import { installSQLiteIntakeSchema } from './intake';
import type { SQLiteOperatorEventRelationshipSource } from './operator-authority-repositories';
import { installProgramVocabularySchema } from './program-vocabulary';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const now = parseInstant('2026-08-13T02:00:00.000Z');
const profile = Object.freeze({ key: 'field-registry-joined-test', version: parseContractVersion(1) });
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
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function seed(sqlite: ReturnType<typeof openSQLite>['sqlite'], next: () => string): void {
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(workspaceId, 'Primary workspace', 1, 1, 1);
  sqlite.query<never, [string, string, number, number, number]>(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(userId, 'Field Registry owner', 1, 1, 1);
  sqlite.exec('BEGIN IMMEDIATE');
  sqlite.query<never, [string]>(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)
  `).run(workspaceId);
  sqlite.query<never, [string, string, string, number, string]>(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Registry Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query<never, [string, string]>(`
    INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)
  `).run(workspaceId, eventId);
  sqlite.query<never, [string, string]>(`
    UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
     WHERE workspace_id = ?
  `).run(eventId, workspaceId);
  initializeCanonicalFieldRegistry({
    sqlite,
    scope: { workspaceId, eventId },
    ids: { newFieldId: next, newChoiceId: next }
  });
  sqlite.exec('COMMIT');
}

function openFixture() {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installFieldRegistryDraftEffectSchema(sqlite);
  installFieldRegistryChangesetEffectSchema(sqlite);
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  seed(sqlite, next);
  const policy = createFieldRegistryOrdinaryPolicy({
    key: 'field_registry.same_operator',
    version: 1,
    ordinaryRisk: 'low',
    approval: 'none'
  });
  const draftIds: SQLiteFieldRegistryDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newFieldId: next,
    newChoiceId: next
  };
  const lifecycleIds: SQLiteFieldRegistryChangesetEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newApprovalId: next,
    newCorrectionAttemptId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newFactId: next,
    newPointerId: next
  };
  const eventRelationships: SQLiteOperatorEventRelationshipSource =
    createSQLiteEventSpineOperatorEventRelationshipSource();
  const draftRegistration = createSQLiteFieldRegistryDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, eventRelationships, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteFieldRegistryChangesetEffectDomainRegistration({
    sqlite, workspaceId, policy, eventRelationships, ids: lifecycleIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    lifecycleRegistration
  ]);
  let revoked = false;
  const authority: Parameters<typeof createChangesetOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      if (revoked) return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      if (input.evidence.kind !== 'operator') {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
          principal: Object.freeze({
            kind: 'workspace_user' as const, userId, membershipId
          }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([Object.freeze({
            kind: 'permission' as const,
            key: 'event.manage'
          })]),
          evidenceIds: Object.freeze(['membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const repository = new SQLiteFieldRegistryRepository(
    sqlite,
    new SQLiteIntakeFieldRegistryFormReferenceResolver(sqlite)
  );
  const draftModule = createFieldRegistryOperationModule({
    workspaceId,
    policies: {
      read: FIELD_REGISTRY_READ_ACCESS_POLICY,
      manage: FIELD_REGISTRY_MANAGE_ACCESS_POLICY
    },
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] })
    },
    registryRead: repository,
    optionSource: new SQLiteProgramVocabularyFieldOptionSource(sqlite),
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: FIELD_REGISTRY_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x45)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`field-registry:${raw}`).digest('hex')
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
    clock: { now: () => now },
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
          verifierSha256: createHash('sha256').update(`field-registry:${raw}`).digest('hex')
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
    source: composeOperationRegistryModules([draftModule, lifecycleModule]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => now },
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
    setRevoked(value: boolean) { revoked = value; },
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

describe('joined Field Registry draft and changeset lifecycle', () => {
  test('drafts inertly, exposes compact diff, commits atomically, replays, and logs recovery evidence', async () => {
    const fixture = openFixture();
    try {
      const baseline = fixture.repository.readFieldRegistry({ workspaceId, eventId });
      if (!baseline) throw new TypeError('field_registry_fixture_missing');
      const draft = fieldRegistryDraftOperationResultSchema.parse(await fixture.effect({
        operation: FIELD_REGISTRY_ADD_DRAFT_OPERATION,
        businessInput: {
          expectedRegistryVersion: baseline.version,
          field: {
            kind: 'text',
            label: 'Company',
            help: 'Where you work.',
            answerOwner: 'person',
            scope: { kind: 'shared' },
            contexts: {
              apply: { visible: true, required: false },
              onboard: { visible: false, required: false },
              profile: { visible: true, required: false }
            },
            options: { kind: 'none' }
          }
        },
        key: 'draft-company'
      }));
      expect(draft).toMatchObject({
        kind: 'success',
        data: {
          action: 'add',
          status: 'draft',
          safeDiff: {
            action: 'add', registryVersionBefore: 1, registryVersionAfter: 2
          }
        }
      });
      if (draft.kind !== 'success') throw new TypeError('draft_failed');
      expect(fixture.repository.readFieldRegistry({ workspaceId, eventId })).toEqual(baseline);
      expect(count(fixture.sqlite, 'field_registry_draft_receipt_links')).toBe(1);
      expect(count(fixture.sqlite, 'field_registry_draft_timeline')).toBe(1);

      const selector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };
      expect(changesetDiffOperationResultSchema.parse(await fixture.read(
        GET_CHANGESET_DIFF_OPERATION,
        selector
      ))).toMatchObject({
        kind: 'success',
        data: {
          headVersion: 1,
          status: 'draft',
          operations: [{ kind: 'field_registry.mutate', safeDiff: { action: 'add' } }]
        }
      });
      expect(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 1 },
        key: 'propose-company'
      })).toMatchObject({
        kind: 'success', data: { action: 'propose', diff: { status: 'proposed' } }
      });

      const commitInput = { ...selector, expectedHeadVersion: 2 };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-company'
      }));
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', expectedHeadVersion: 2, committedHeadVersion: 3 }
      });
      if (committed.kind !== 'success') throw new TypeError('commit_failed');
      const after = fixture.repository.readFieldRegistry({ workspaceId, eventId });
      expect(after).toMatchObject({
        version: 2,
        fields: expect.arrayContaining([expect.objectContaining({
          label: 'Company', key: expect.stringMatching(/^custom\./), version: 1
        })])
      });
      expect(fixture.lifecycle.read(selector.changesetId)).toMatchObject({
        head: { status: 'committed', version: 3 }
      });
      expect(count(fixture.sqlite, 'field_registry_changeset_domain_facts')).toBe(1);
      expect(count(fixture.sqlite, 'field_registry_changeset_outbox_pointers')).toBe(1);
      expect(count(fixture.sqlite, 'field_registry_changeset_timeline')).toBe(2);

      const receiptCount = count(fixture.sqlite, 'foundation_trial_operation_receipts');
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-company'
      })).toMatchObject({ kind: 'success', receipt: { id: committed.receipt.id } });
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(receiptCount);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...commitInput, expectedHeadVersion: 3 },
        key: 'commit-company'
      })).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });
      fixture.setRevoked(true);
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-company'
      })).toMatchObject({
        kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('returns a typed stale draft refusal with zero changeset or effective writes', async () => {
    const fixture = openFixture();
    try {
      expect(await fixture.effect({
        operation: FIELD_REGISTRY_ADD_DRAFT_OPERATION,
        businessInput: {
          expectedRegistryVersion: 9,
          field: {
            kind: 'text', label: 'Company', answerOwner: 'person',
            scope: { kind: 'shared' },
            contexts: {
              apply: { visible: true, required: false },
              onboard: { visible: false, required: false },
              profile: { visible: false, required: false }
            },
            options: { kind: 'none' }
          }
        },
        key: 'stale-company'
      })).toMatchObject({
        kind: 'outcome',
        terminal: false,
        outcome: {
          class: 'stale_revision',
          kind: 'field_registry.changed',
          detail: { code: 'stale_registry', action: 'add' }
        }
      });
      expect(count(fixture.sqlite, 'changeset_heads')).toBe(0);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
      expect(fixture.repository.readFieldRegistry({ workspaceId, eventId })?.version).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('maps all five registered draft endpoints to exact typed inert actions', async () => {
    const fixture = openFixture();
    const fieldId = fixture.repository.readFieldRegistry({ workspaceId, eventId })?.fields[0]?.id;
    if (!fieldId) throw new TypeError('field_fixture_missing');
    const cases = [{
      action: 'add',
      operation: FIELD_REGISTRY_ADD_DRAFT_OPERATION,
      input: {
        expectedRegistryVersion: 9,
        field: {
          kind: 'text', label: 'Company', answerOwner: 'person',
          scope: { kind: 'shared' },
          contexts: {
            apply: { visible: true, required: false },
            onboard: { visible: false, required: false },
            profile: { visible: false, required: false }
          },
          options: { kind: 'none' }
        }
      }
    }, {
      action: 'edit',
      operation: FIELD_REGISTRY_EDIT_DRAFT_OPERATION,
      input: {
        fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 9,
        changes: { label: 'Updated name' }
      }
    }, {
      action: 'move',
      operation: FIELD_REGISTRY_MOVE_DRAFT_OPERATION,
      input: { fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 9, toIndex: 1 }
    }, {
      action: 'remove',
      operation: FIELD_REGISTRY_REMOVE_DRAFT_OPERATION,
      input: { fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 9 }
    }, {
      action: 'restore',
      operation: FIELD_REGISTRY_RESTORE_DRAFT_OPERATION,
      input: { fieldId, expectedFieldVersion: 1, expectedRegistryVersion: 9, toIndex: 0 }
    }] as const;
    try {
      for (const entry of cases) {
        expect(await fixture.effect({
          operation: entry.operation,
          businessInput: entry.input,
          key: `stale-${entry.action}`
        })).toMatchObject({
          kind: 'outcome',
          terminal: false,
          outcome: {
            class: 'stale_revision',
            kind: 'field_registry.changed',
            detail: { code: 'stale_registry', action: entry.action }
          }
        });
      }
      expect(count(fixture.sqlite, 'changeset_heads')).toBe(0);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
      expect(fixture.repository.readFieldRegistry({ workspaceId, eventId })?.version).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('serves the exact canonical baseline snapshot through the registered read operation', async () => {
    const fixture = openFixture();
    try {
      const result = fieldRegistrySnapshotReadResultSchema.parse(await fixture.read(
        { name: 'field_registry.snapshot.read', version: 1 },
        {}
      ));
      expect(result).toMatchObject({
        kind: 'success',
        data: { scope: { workspaceId, eventId }, version: 1 }
      });
      if (result.kind !== 'success') throw new TypeError('read_failed');
      expect(result.data.fields).toHaveLength(19);
    } finally {
      fixture.close();
    }
  });
});
