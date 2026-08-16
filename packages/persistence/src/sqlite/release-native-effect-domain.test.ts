import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import type {
  EngagementSnapshotDto,
  ReleaseScopeDto,
  SessionCatalogDto,
  SessionHeadDto
} from '@jooevents/contracts';
import {
  releasePublishOperationResultSchema,
  releaseReviewDraftOperationResultSchema
} from '@jooevents/contracts';
import {
  RELEASE_CHANGE_DRAFT_OPERATION,
  RELEASE_DRAFT_ACCESS_POLICY,
  RELEASE_DRAFT_PERMISSION_ID,
  RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE,
  RELEASE_NATIVE_PUBLISH_REQUEST_HASH_PROFILE,
  RELEASE_PUBLISH_OPERATION,
  createReleaseNativeOperationModule
} from '@jooevents/release-operations';
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
import { createProgramVocabularyState } from '@jooevents/program';
import { parseSchedulePlacementState } from '@jooevents/schedule';
import { sessionCatalogDigest, sessionHeadDigest, sessionRosterDigest } from '@jooevents/session';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import { installReleaseSchema, type SQLiteReleaseUpstreamSources } from './release';
import {
  createSQLiteReleaseNativeEffectDomainRegistrations,
  installReleaseNativeEffectSchema
} from './release-native-effect-domain';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const id = (suffix: number): string =>
  `019c1df9-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(id(1));
const eventId = parseEventId(id(2));
const userId = parseUserId(id(3));
const membershipId = parseMembershipId(id(4));
const formatId = id(5);
const roomId = id(6);
const personId = id(7);
const sessionId = id(8);
const occurrenceId = id(9);
const start = parseInstant('2026-08-16T02:00:00.000Z');
const scope: ReleaseScopeDto = { workspaceId, eventId };
const profile = Object.freeze({ key: 'release-native-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'verified-session-handle'
});

function sessionHead(): SessionHeadDto {
  const rosterUnsigned = {
    version: 1,
    participants: [{
      personId,
      role: 'speaker' as const,
      position: 0,
      publiclyVisible: true,
      source: { kind: 'submission' as const, id: 'seeded', version: 1 }
    }]
  };
  const roster = { ...rosterUnsigned, digestSha256: sessionRosterDigest(rosterUnsigned) };
  const unsigned = {
    schemaVersion: 1 as const,
    scope,
    id: sessionId,
    title: 'Opening keynote',
    plannedDurationMinutes: 60,
    lifecycle: 'programmed' as const,
    programTarget: {
      setVersion: 1,
      setDigestSha256: 'a'.repeat(64),
      format: {
        kind: 'format' as const,
        id: formatId,
        name: 'Talk',
        status: 'active' as const,
        version: 1
      },
      track: null
    },
    roster,
    version: 1,
    createdByUserId: userId,
    createdAt: start,
    updatedByUserId: userId,
    updatedAt: start
  };
  return { ...unsigned, digestSha256: sessionHeadDigest(unsigned) } as SessionHeadDto;
}

function catalog(): SessionCatalogDto {
  const sessions = [sessionHead()];
  const unsigned = { schemaVersion: 1 as const, scope, version: 1, sessions };
  return { ...unsigned, digestSha256: sessionCatalogDigest(unsigned) } as SessionCatalogDto;
}

function engagements(): EngagementSnapshotDto {
  return {
    schemaVersion: 1,
    scope,
    engagements: [{
      schemaVersion: 1,
      id: id(10),
      scope,
      sessionId,
      personId,
      submissionId: null,
      seededByDecision: null,
      state: 'confirmed',
      invitedAt: start,
      respondBy: null,
      confirmation: {
        attribution: 'self', personId, recordedByUserId: null, confirmedAt: start
      },
      cancellationRequest: null,
      cancelledAt: null,
      source: { kind: 'organizer', id: 'direct', version: 1 },
      version: 1
    }]
  } as EngagementSnapshotDto;
}

function openFixture() {
  const sqlite = new Database(':memory:', { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installReleaseSchema(sqlite);
  installReleaseNativeEffectSchema(sqlite);
  sqlite.query(`INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)`).run(workspaceId);
  sqlite.query(`INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Publisher', 1, 1, 1)`).run(userId);
  sqlite.exec('BEGIN IMMEDIATE');
  sqlite.query(`INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)`).run(workspaceId);
  sqlite.query(`INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Release Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)`)
    .run(workspaceId, eventId, userId, Date.parse(start), 'b'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);
  sqlite.query(`UPDATE event_spine_workspace_sets
    SET version = 2, current_event_id = ? WHERE workspace_id = ?`).run(eventId, workspaceId);
  sqlite.exec('COMMIT');

  let scheduleConflict = false;
  const sources: SQLiteReleaseUpstreamSources = {
    sessions: { readSessionCatalog: () => catalog() },
    schedule: {
      readSchedule: () => parseSchedulePlacementState({
        schemaVersion: 1,
        scope,
        scheduleVersion: 1,
        occurrences: scheduleConflict
          ? [{
              id: occurrenceId,
              sessionId,
              roomId,
              startAt: '2026-11-01T09:00:00.000Z',
              endAt: '2026-11-01T10:00:00.000Z',
              version: 1
            }, {
              id: id(11),
              sessionId,
              roomId,
              startAt: '2026-11-01T09:30:00.000Z',
              endAt: '2026-11-01T10:30:00.000Z',
              version: 1
            }]
          : [{
              id: occurrenceId,
              sessionId,
              roomId,
              startAt: '2026-11-01T09:00:00.000Z',
              endAt: '2026-11-01T10:00:00.000Z',
              version: 1
            }]
      })
    },
    engagements: { readEngagementSnapshot: () => engagements() },
    vocabulary: {
      readVocabulary: () => createProgramVocabularyState({
        scope,
        setVersion: 1,
        rooms: [{ id: roomId, name: 'Main Hall', status: 'active', version: 1, capacity: null }],
        formats: [{ id: formatId, name: 'Talk', status: 'active', version: 1 }]
      })
    },
    eventSettings: { readEventSettings: () => ({ event: { id: eventId, version: 1 } }) as never },
    names: { readParticipantDisplayName: () => 'Ada Lovelace' },
    forms: { readCurrentPublishedFormVersionId: () => undefined }
  };

  let generated = 0x1000;
  const next = () => id(generated++);
  const registrations = createSQLiteReleaseNativeEffectDomainRegistrations({
    sqlite,
    workspaceId,
    eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource(),
    sources,
    ids: { newDraftId: next, newRevisionId: next, newReleaseId: next }
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry(registrations);
  let currentTime: Instant = start;
  const authority: Parameters<typeof createReleaseNativeOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId, membershipId },
          lane: input.lane,
          scope: input.scope,
          grants: [{ kind: 'permission', key: RELEASE_DRAFT_PERMISSION_ID }],
          evidenceIds: ['membership.current'],
          authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const requestSealer = (requestProfile: typeof RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE) =>
    createHmacRequestHashSealer({
      profile: requestProfile,
      keyBytes: new Uint8Array(32).fill(requestProfile.key.endsWith('publish') ? 0x71 : 0x70)
    });
  const module = createReleaseNativeOperationModule({
    workspaceId,
    policy: RELEASE_DRAFT_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] }) },
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    draftRequestHashSealer: requestSealer(RELEASE_NATIVE_DRAFT_REQUEST_HASH_PROFILE),
    publishRequestHashSealer: requestSealer(RELEASE_NATIVE_PUBLISH_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw: string) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`release:${raw}`).digest('hex')
        };
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => currentTime
  });
  let receipt = 0x8000;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([module]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => currentTime },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newOperationLogId: () => id(receipt++)
  });
  let correlation = 0x9000;
  return {
    sqlite,
    close: () => sqlite.close(),
    setScheduleConflict(value: boolean) { scheduleConflict = value; },
    advance() {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + 1_000).toISOString());
    },
    async effect(operation: { readonly name: string; readonly version: number }, input: unknown, key: string) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: operation.name,
        operationVersion: operation.version,
        surface: 'operator_http',
        correlationId: id(correlation++),
        businessInput: input,
        verifiedEvidence: evidence,
        rawIdempotencyKey: key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

function count(fixture: ReturnType<typeof openFixture>, table: string): number {
  return fixture.sqlite.query<{ total: number }, []>(`SELECT count(*) AS total FROM ${table}`)
    .get()?.total ?? -1;
}

describe('SQLite Release feature-native effect domain', () => {
  test('drafts inert review state, publishes exactly once, replays, and logs the action summary', async () => {
    const fixture = openFixture();
    try {
      const drafted = releaseReviewDraftOperationResultSchema.parse(await fixture.effect(
        RELEASE_CHANGE_DRAFT_OPERATION,
        { action: 'publish_schedule', expectedCurrentReleaseNumber: null },
        'release-draft-key'
      ));
      expect(drafted).toMatchObject({
        kind: 'success',
        data: { action: 'publish_schedule', status: 'draft', revision: { number: 1 } }
      });
      if (drafted.kind !== 'success') throw new TypeError('release_native_draft_failed');
      expect(count(fixture, 'release_review_drafts')).toBe(1);
      expect(count(fixture, 'release_review_revisions')).toBe(1);
      expect(count(fixture, 'program_releases')).toBe(0);

      const selector = {
        draftId: drafted.data.draftId,
        revisionId: drafted.data.revision.id,
        revisionDigestSha256: drafted.data.revision.digestSha256
      };
      fixture.advance();
      const published = releasePublishOperationResultSchema.parse(await fixture.effect(
        RELEASE_PUBLISH_OPERATION, selector, 'release-publish-key'
      ));
      expect(published).toMatchObject({
        kind: 'success', data: { action: 'publish_schedule', release: { number: 1 } }
      });
      if (published.kind !== 'success') throw new TypeError('release_native_publish_failed');
      expect(count(fixture, 'program_releases')).toBe(1);
      expect(fixture.sqlite.query<{ status: string }, []>(
        'SELECT status FROM release_review_drafts'
      ).get()).toEqual({ status: 'published' });
      expect(fixture.sqlite.query<{ summary: string }, []>(
        "SELECT summary FROM operation_log WHERE operation_name = 'release.publish'"
      ).get()).toEqual({ summary: 'Published the schedule' });
      const replay = releasePublishOperationResultSchema.parse(await fixture.effect(
        RELEASE_PUBLISH_OPERATION, selector, 'release-publish-key'
      ));
      expect(replay).toMatchObject({ kind: 'success', receipt: { id: published.receipt.id } });
      expect(count(fixture, 'program_releases')).toBe(1);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally { fixture.close(); }
  });

  test('rechecks the reviewed plan and leaves draft/effective state unchanged when guards drift', async () => {
    const fixture = openFixture();
    try {
      const drafted = releaseReviewDraftOperationResultSchema.parse(await fixture.effect(
        RELEASE_CHANGE_DRAFT_OPERATION,
        { action: 'publish_schedule', expectedCurrentReleaseNumber: null },
        'stale-release-draft'
      ));
      if (drafted.kind !== 'success') throw new TypeError('release_native_draft_failed');
      fixture.setScheduleConflict(true);
      const refused = releasePublishOperationResultSchema.parse(await fixture.effect(
        RELEASE_PUBLISH_OPERATION, {
        draftId: drafted.data.draftId,
        revisionId: drafted.data.revision.id,
        revisionDigestSha256: drafted.data.revision.digestSha256
        }, 'stale-release-publish'
      ));
      expect(refused).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'release.changed',
          detail: { code: 'schedule_conflicts_block', action: 'publish_schedule' }
        }
      });
      expect(count(fixture, 'program_releases')).toBe(0);
      expect(fixture.sqlite.query<{ status: string }, []>(
        'SELECT status FROM release_review_drafts'
      ).get()).toEqual({ status: 'draft' });
      expect(count(fixture, 'operation_log')).toBe(1);
    } finally { fixture.close(); }
  });
});
