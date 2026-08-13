import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
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
import { installEventSpineSchema, SQLiteEventSpineRepository } from './event-spine';
import { initializeCreatedEventSettings, installEventSettingsSchema, SQLiteEventSettingsRepository } from './event-settings';
import {
  createSQLiteEventSettingsUpdateDraftEffectDomainRegistration,
  installEventSettingsUpdateDraftEffectSchema,
  type SQLiteEventSettingsUpdateDraftEffectIds
} from './event-settings-draft-effect-domain';
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

function openFixture(options: { readonly noEvent?: boolean } = {}) {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installEventSettingsSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installEventSettingsUpdateDraftEffectSchema(sqlite);
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
    if (options.noEvent) return;
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
  const ids: SQLiteEventSettingsUpdateDraftEffectIds = {
    newChangesetId: next,
    newRevisionId: next,
    newPreparationHandle: next,
    newTimelineId: next
  };
  const registration = createSQLiteEventSettingsUpdateDraftEffectDomainRegistration({
    sqlite, workspaceId, policy, ids
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([registration]);
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
  const module = createEventSettingsUpdateDraftOperationModule({
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
  return {
    sqlite,
    settings: new SQLiteEventSettingsRepository(sqlite),
    lifecycle: createSQLiteDraftOnlyChangesetLifecycleStore(sqlite),
    async execute(
      input: EventSettingsUpdateDraftInput = updateInput,
      key = 'event-settings-draft'
    ) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION.name,
        operationVersion: EVENT_SETTINGS_UPDATE_DRAFT_OPERATION.version,
        surface: 'operator_http',
        correlationId: uuid(0x900),
        businessInput: input,
        verifiedEvidence: evidence,
        rawIdempotencyKey: key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

describe('ordinary SQLite Event settings draft effect domain', () => {
  test('persists an inert selected-Event draft and exactly replays its receipt', async () => {
    const fixture = openFixture();
    try {
      const before = fixture.settings.readCurrentEventSettings(workspaceId);
      const first = eventSettingsUpdateDraftOperationResultSchema.parse(
        await fixture.execute(updateInput, 'same-request')
      );
      const replay = eventSettingsUpdateDraftOperationResultSchema.parse(
        await fixture.execute(updateInput, 'same-request')
      );
      expect(replay).toEqual(first);
      expect(first).toMatchObject({
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
      expect(fixture.settings.readCurrentEventSettings(workspaceId)).toEqual(before);
      expect(count(fixture.sqlite, 'changeset_heads')).toBe(1);
      expect(count(fixture.sqlite, 'event_settings_update_draft_receipt_links')).toBe(1);
      expect(count(fixture.sqlite, 'event_settings_update_draft_timeline')).toBe(1);
      if (first.kind !== 'success') throw new TypeError('settings_draft_missing');
      const stored = fixture.lifecycle.read(first.data.changesetId);
      expect(stored?.head.eventId).toBe(eventId);
      expect(stored?.revisions[0]?.revision).toMatchObject({
        createdAt: now,
        proposerPrincipalKey: `workspace_user:${userId}`,
        origin: 'human_ui'
      });
    } finally {
      fixture.sqlite.close();
    }
  });

  test('returns a stale outcome without a changeset when the cached Event head moved', async () => {
    const fixture = openFixture();
    try {
      const result = eventSettingsUpdateDraftOperationResultSchema.parse(await fixture.execute({
        ...updateInput,
        expectedEventVersion: 2
      }, 'stale-request'));
      expect(result).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'event.settings_changed',
          detail: { code: 'stale_event', action: 'update', eventId }
        }
      });
      expect(count(fixture.sqlite, 'changeset_heads')).toBe(0);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    } finally {
      fixture.sqlite.close();
    }
  });

  test('refuses drafting before Event selection with zero writes or terminal receipt', async () => {
    const fixture = openFixture({ noEvent: true });
    try {
      const result = eventSettingsUpdateDraftOperationResultSchema.parse(
        await fixture.execute(updateInput, 'event-required')
      );
      expect(result).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'conflict',
          kind: 'event.settings.event_required',
          retryable: false,
          detail: null
        }
      });
      expect(count(fixture.sqlite, 'changeset_heads')).toBe(0);
      expect(count(fixture.sqlite, 'event_settings_update_draft_receipt_links')).toBe(0);
      expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    } finally {
      fixture.sqlite.close();
    }
  });
});
