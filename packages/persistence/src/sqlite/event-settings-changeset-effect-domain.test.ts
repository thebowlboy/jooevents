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
  PROPOSE_CHANGESET_OPERATION,
  changesetLifecycleOperationResultSchema,
  createChangesetOperationModule
} from '@jooevents/changeset-operations';
import {
  eventSettingsUpdateDraftOperationResultSchema,
  type EventSettingsUpdateDraftInput
} from '@jooevents/contracts';
import { issueEventOrdinaryPolicy, planEventCreation } from '@jooevents/event';
import {
  EVENT_MANAGE_ACCESS_POLICY,
  EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
  EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE,
  createEventSettingsUpdateDraftOperationModule
} from '@jooevents/event-operations';
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
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema,
  SQLiteEventSpineRepository
} from './event-spine';
import { initializeCreatedEventSettings, installEventSettingsSchema, SQLiteEventSettingsRepository } from './event-settings';
import {
  createSQLiteEventSettingsUpdateDraftEffectDomainRegistration,
  installEventSettingsUpdateDraftEffectSchema,
  type SQLiteEventSettingsUpdateDraftEffectIds
} from './event-settings-draft-effect-domain';
import {
  createSQLiteEventSettingsChangesetEffectDomainRegistration,
  installEventSettingsChangesetEffectSchema,
  type SQLiteEventSettingsChangesetEffectIds
} from './event-settings-changeset-effect-domain';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfa111';
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const now = parseInstant('2026-08-13T09:00:00.000Z');
const profile = Object.freeze({ key: 'event-settings-sqlite-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-session-handle'
});
const policy = issueEventOrdinaryPolicy({
  key: 'event.settings.ordinary', version: 1, risk: 'low', approval: 'none'
});
const updateInput = Object.freeze({
  expectedEventId: eventId,
  expectedEventSetVersion: 2,
  expectedEventVersion: 1,
  name: 'JooConf Live',
  timezone: 'Asia/Singapore',
  startDate: '2027-04-16',
  endDate: '2027-04-19',
  location: 'Suntec City',
  venueNote: 'Use level 3.',
  dayStart: '08:30',
  dayEnd: '17:30',
  slotMinutes: 30
});

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function openFixture() {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installEventSettingsSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installEventSettingsUpdateDraftEffectSchema(sqlite);
  installEventSettingsChangesetEffectSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Primary workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Event owner', 1, 1, 1)
  `).run(userId);
  const spine = new SQLiteEventSpineRepository(sqlite);
  sqlite.transaction(() => {
    const eventSet = spine.bootstrapWorkspaceEventSet(workspaceId);
    spine.commitEventCreatePlan(planEventCreation({
      eventSet,
      authorInput: {
        expectedEventSetVersion: 1,
        name: 'JooConf',
        timezone: 'Asia/Singapore',
        startDate: '2027-04-16',
        endDate: '2027-04-18'
      },
      server: {
        workspaceId,
        eventId,
        createdByUserId: userId,
        createdAt: now
      }
    }));
    initializeCreatedEventSettings({ sqlite, scope: { workspaceId, eventId } });
  }).immediate();

  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const draftIds: SQLiteEventSettingsUpdateDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next
  };
  const lifecycleIds: SQLiteEventSettingsChangesetEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newApprovalId: next,
    newCorrectionAttemptId: next,
    newPreparationHandle: next,
    newTimelineId: next,
    newFactId: next,
    newPointerId: next
  };
  const draftRegistration = createSQLiteEventSettingsUpdateDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, ids: draftIds
  });
  const lifecycleRegistration = createSQLiteEventSettingsChangesetEffectDomainRegistration({
    sqlite,
    workspaceId,
    policy,
    eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource(),
    ids: lifecycleIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([
    draftRegistration,
    lifecycleRegistration
  ]);
  const authority: Parameters<
    typeof createEventSettingsUpdateDraftOperationModule
  >[0]['currentAuthority'] = {
    resolve(input) {
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
            kind: 'permission' as const, key: 'event.manage'
          })]),
          evidenceIds: Object.freeze(['membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const draftModule = createEventSettingsUpdateDraftOperationModule({
    workspaceId,
    managePolicy: EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: EVENT_SETTINGS_UPDATE_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x45)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`settings-key:${raw}`).digest('hex')
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
          verifierSha256: createHash('sha256').update(`settings-lifecycle:${raw}`).digest('hex')
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
  return {
    sqlite,
    settings: new SQLiteEventSettingsRepository(sqlite),
    lifecycle: lifecycleRegistration.lifecycleStore,
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
        correlationId: uuid(0x900),
        businessInput: input.businessInput,
        verifiedEvidence: evidence,
        rawIdempotencyKey: input.key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

describe('joined SQLite Event settings changeset lifecycle', () => {
  test('drafts inertly, commits atomically once, and records causal recovery evidence', async () => {
    const fixture = openFixture();
    try {
      const before = fixture.settings.readCurrentEventSettings(workspaceId);
      const draft = eventSettingsUpdateDraftOperationResultSchema.parse(await fixture.effect({
        operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
        businessInput: updateInput,
        key: 'draft-settings'
      }));
      expect(draft).toMatchObject({
        kind: 'success',
        data: {
          action: 'update',
          status: 'draft',
          safeDiff: {
            selection: { eventId, eventSetVersion: 2 },
            before: { eventVersion: 1 },
            after: { eventVersion: 2, name: 'JooConf Live', location: 'Suntec City' }
          }
        }
      });
      if (draft.kind !== 'success') throw new TypeError('settings_draft_missing');
      expect(fixture.settings.readCurrentEventSettings(workspaceId)).toEqual(before);
      const selector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };
      const proposed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 1 },
        key: 'propose-settings'
      }));
      expect(proposed).toMatchObject({
        kind: 'success', data: { action: 'propose', diff: { headVersion: 2 } }
      });

      const commitInput = { ...selector, expectedHeadVersion: 2 };
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-settings'
      }));
      const replay = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput,
        key: 'commit-settings'
      }));
      expect(replay).toEqual(committed);
      expect(committed).toMatchObject({
        kind: 'success', data: { action: 'commit', committedHeadVersion: 3 }
      });
      expect(fixture.settings.readCurrentEventSettings(workspaceId)).toMatchObject({
        eventId,
        eventSetVersion: 2,
        eventVersion: 2,
        name: 'JooConf Live',
        endDate: '2027-04-19',
        location: 'Suntec City',
        venueNote: 'Use level 3.',
        dayStart: '08:30',
        dayEnd: '17:30',
        slotMinutes: 30
      });
      expect(count(fixture.sqlite, 'event_settings_changeset_domain_facts')).toBe(1);
      expect(count(fixture.sqlite, 'event_settings_changeset_outbox_pointers')).toBe(1);
      expect(count(fixture.sqlite, 'event_settings_changeset_timeline')).toBe(2);
      expect(count(fixture.sqlite, 'event_settings_changeset_receipt_links')).toBe(2);
      expect(fixture.lifecycle.read(draft.data.changesetId)?.head).toMatchObject({
        status: 'committed', version: 3, eventId
      });
    } finally {
      fixture.sqlite.close();
    }
  });

  test('derives an exact correction draft only from the unchanged committed state', async () => {
    const fixture = openFixture();
    try {
      const draft = eventSettingsUpdateDraftOperationResultSchema.parse(await fixture.effect({
        operation: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION,
        businessInput: updateInput,
        key: 'draft-correctable-settings'
      }));
      if (draft.kind !== 'success') throw new TypeError('settings_draft_missing');
      const selector = {
        changesetId: draft.data.changesetId,
        revisionId: draft.data.revision.id,
        revisionDigest: draft.data.revision.digestSha256
      };
      await fixture.effect({
        operation: PROPOSE_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 1 },
        key: 'propose-correctable-settings'
      });
      const committed = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: { ...selector, expectedHeadVersion: 2 },
        key: 'commit-correctable-settings'
      }));
      if (committed.kind !== 'success') throw new TypeError('settings_commit_missing');
      const correction = changesetLifecycleOperationResultSchema.parse(await fixture.effect({
        operation: DRAFT_CHANGESET_CORRECTION_OPERATION,
        businessInput: {
          sourceChangesetId: selector.changesetId,
          sourceRevisionId: selector.revisionId,
          sourceRevisionDigest: selector.revisionDigest,
          sourceCommitReceiptId: committed.receipt.id
        },
        key: 'correct-settings'
      }));
      expect(correction).toMatchObject({
        kind: 'success',
        data: {
          action: 'correction',
          resultKind: 'exact',
          target: {
            status: 'draft',
            operations: [{
              kind: 'event.settings.update',
              safeDiff: {
                before: { eventVersion: 2, name: 'JooConf Live' },
                after: { eventVersion: 3, name: 'JooConf' }
              }
            }]
          }
        }
      });
      expect(count(fixture.sqlite, 'changeset_correction_links')).toBe(1);
      expect(count(fixture.sqlite, 'event_settings_changeset_timeline')).toBe(3);
    } finally {
      fixture.sqlite.close();
    }
  });
});
