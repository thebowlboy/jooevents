import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import {
  appendChangesetDraftSynchronous,
  changesetLifecycleOperationResultSchema,
  CHANGESET_LIFECYCLE_ACCESS_POLICY,
  CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
  COMMIT_CHANGESET_OPERATION,
  createChangesetOperationModule,
  PROPOSE_CHANGESET_OPERATION
} from '@jooevents/changeset-operations';
import type {
  EngagementSnapshotDto,
  ReleasePlanningInput,
  ReleaseScopeDto,
  SessionCatalogDto,
  SessionHeadDto
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  encodeCanonicalJson,
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
import { createReleaseChangesetBundle, releaseReadPort, RELEASE_CHANGESET_KIND, RELEASE_CHANGESET_VERSION } from '@jooevents/release';
import { parseSchedulePlacementState } from '@jooevents/schedule';
import { sessionCatalogDigest, sessionHeadDigest, sessionRosterDigest } from '@jooevents/session';
import { installSQLiteChangesetLifecycleSchema } from './changeset-lifecycle';
import { openSQLite } from './database';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import {
  createSQLiteReleaseChangesetEffectDomainRegistration,
  installReleaseChangesetEffectSchema,
  type SQLiteReleaseChangesetEffectIds
} from './release-changeset-effect-domain';
import {
  installReleaseSchema,
  SQLiteReleaseRepository,
  type SQLiteReleaseUpstreamSources
} from './release';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('019c1df7-86b5-769b-bba4-5f7097bfd101');
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfd201');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfd202');
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfd301';
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfd401';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfd501';
const personHidden = '019c1df7-86b5-769b-bba4-5f7097bfd502';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfd601';
const now = parseInstant('2026-08-14T09:00:00.000Z');
const scope: ReleaseScopeDto = { workspaceId, eventId };
const themeArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfd710';
const speakersArtifactId = '019c1df7-86b5-769b-bba4-5f7097bfd711';
const templateRevisionId = '019c1df7-86b5-769b-bba4-5f7097bfd712';
const templatePin = (artifactId: string) => ({
  artifactId, revisionId: templateRevisionId, revisionNumber: 1, digestSha256: 'd'.repeat(64)
});
const themeRecipe = {
  name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
  text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
};
const profile = Object.freeze({ key: 'release-changeset-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-release-changeset-session'
});

const approvalPolicy = (() => {
  const reference = Object.freeze({ key: 'policy.release.publish.bounded', version: 1 });
  const definition = Object.freeze({ reference, requirement: 'none' as const });
  return Object.freeze({
    ...definition,
    definitionDigestSha256: createHash('sha256')
      .update(encodeCanonicalJson(definition))
      .digest('hex')
  });
})();

function uuid(suffix: number): string {
  return `019c1df7-86b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: ReturnType<typeof openSQLite>['sqlite'], table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

function transaction<Result>(sqlite: ReturnType<typeof openSQLite>['sqlite'], work: () => Result) {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    sqlite.exec('COMMIT;');
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function programmedSession(): SessionHeadDto {
  const rosterUnsigned = {
    version: 1,
    participants: [
      {
        personId: personA,
        role: 'speaker' as const,
        position: 0,
        publiclyVisible: true,
        source: { kind: 'submission', id: 'seeded', version: 1 }
      },
      {
        personId: personHidden,
        role: 'speaker' as const,
        position: 1,
        publiclyVisible: false,
        source: { kind: 'submission', id: 'seeded', version: 1 }
      }
    ]
  };
  const roster = { ...rosterUnsigned, digestSha256: sessionRosterDigest(rosterUnsigned) };
  const unsigned = {
    schemaVersion: 1 as const,
    scope,
    id: sessionId,
    title: 'Opening Keynote',
    plannedDurationMinutes: 60,
    lifecycle: 'programmed' as const,
    programTarget: {
      setVersion: 1,
      setDigestSha256: 'a'.repeat(64),
      format: { kind: 'format' as const, id: formatId, name: 'Talk', status: 'active' as const, version: 1 },
      track: null
    },
    roster,
    version: 1,
    createdByUserId: userId,
    createdAt: now,
    updatedByUserId: userId,
    updatedAt: now
  };
  return { ...unsigned, digestSha256: sessionHeadDigest(unsigned) } as SessionHeadDto;
}

function fixtureCatalog(): SessionCatalogDto {
  const unsigned = { schemaVersion: 1 as const, scope, version: 4, sessions: [programmedSession()] };
  return { ...unsigned, digestSha256: sessionCatalogDigest(unsigned) } as SessionCatalogDto;
}

function fixtureEngagements(): EngagementSnapshotDto {
  const entries = [
    { personId: personA, id: '019c1df7-86b5-769b-bba4-5f7097bfd801' },
    { personId: personHidden, id: '019c1df7-86b5-769b-bba4-5f7097bfd802' }
  ].sort((left, right) => left.personId < right.personId ? -1 : 1);
  return {
    schemaVersion: 1,
    scope,
    engagements: entries.map((entry) => ({
      schemaVersion: 1,
      id: entry.id,
      scope,
      sessionId,
      personId: entry.personId,
      submissionId: null,
      seededByDecision: null,
      state: 'confirmed',
      invitedAt: now,
      respondBy: null,
      confirmation: {
        attribution: 'self', personId: entry.personId, recordedByUserId: null, confirmedAt: now
      },
      cancellationRequest: null,
      cancelledAt: null,
      source: { kind: 'organizer', id: 'direct', version: 1 },
      version: 2
    }))
  } as EngagementSnapshotDto;
}

function openFixture() {
  const opened = openSQLite(':memory:');
  const sqlite = opened.sqlite;
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteChangesetLifecycleSchema(sqlite);
  installReleaseSchema(sqlite);
  installReleaseChangesetEffectSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Release workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Release operator', 1, 1, 1)
  `).run(userId);
  transaction(sqlite, () => {
    sqlite.query(`
      INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
      VALUES (?, 1, NULL)
    `).run(workspaceId);
    sqlite.query(`
      INSERT INTO event_spine_heads (
        workspace_id, id, name, timezone, start_date, end_date, version,
        created_by_user_id, created_at_ms, create_plan_digest_sha256
      ) VALUES (?, ?, 'Release Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
    `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
    sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
      .run(workspaceId, eventId);
    sqlite.query(`
      UPDATE event_spine_workspace_sets SET version = 2, current_event_id = ?
       WHERE workspace_id = ?
    `).run(eventId, workspaceId);
  });

  const names = new Map([[personA, 'Ada Lovelace'], [personHidden, 'Hidden Person']]);
  const sources: SQLiteReleaseUpstreamSources = {
    sessions: { readSessionCatalog: () => fixtureCatalog() },
    schedule: {
      readSchedule: () => parseSchedulePlacementState({
        schemaVersion: 1,
        scope,
        scheduleVersion: 3,
        occurrences: [{
          id: '019c1df7-86b5-769b-bba4-5f7097bfd901',
          sessionId,
          roomId,
          startAt: '2026-11-01T09:00:00.000Z',
          endAt: '2026-11-01T10:00:00.000Z',
          version: 1
        }]
      })
    },
    engagements: { readEngagementSnapshot: () => fixtureEngagements() },
    vocabulary: {
      readVocabulary: () => createProgramVocabularyState({
        scope,
        setVersion: 2,
        rooms: [{ id: roomId, name: 'Main Hall', status: 'active', version: 1, capacity: null }],
        formats: [{ id: formatId, name: 'Talk', status: 'active', version: 1 }]
      })
    },
    eventSettings: {
      readEventSettings: () => ({ event: { id: eventId, version: 5 } }) as never
    },
    names: { readParticipantDisplayName: (_scope, personId) => names.get(personId) },
    forms: { readCurrentPublishedFormVersionId: () => undefined },
    templates: {
      readPinnedArtifact: (_scope, pin) => {
        if (pin.artifactId === themeArtifactId) return {
          kind: 'theme' as const, recipe: themeRecipe, markText: 'JE'
        };
        return pin.artifactId === speakersArtifactId ? {
          kind: 'surface' as const, surfaceKind: 'speaker-roster' as const,
          name: 'Speakers', purpose: 'Public lineup.', blocks: [], usedBy: []
        } : undefined;
      }
    }
  };

  let currentTime: Instant = now;
  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const lifecycleIds: SQLiteReleaseChangesetEffectIds = {
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
  const registration = createSQLiteReleaseChangesetEffectDomainRegistration({
    sqlite,
    workspaceId,
    approvalPolicy,
    permissionId: 'schedule.publish',
    eventRelationships,
    sources,
    ids: lifecycleIds
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry([registration]);

  const authority = {
    resolve(input: {
      readonly evidence: InvocationEvidence;
      readonly lane: unknown;
      readonly scope: unknown;
      readonly evaluatedAt: Instant;
    }) {
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
          grants: Object.freeze([
            Object.freeze({ kind: 'permission' as const, key: 'schedule.publish' })
          ]),
          evidenceIds: Object.freeze(['release-membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  };
  const keySealer = {
    seal(raw: string) {
      return Object.freeze({
        verifierProfile: profile,
        verifierSha256: createHash('sha256').update(`release-key:${raw}`).digest('hex')
      });
    }
  };
  const changesetModule = createChangesetOperationModule({
    workspaceId,
    policy: CHANGESET_LIFECYCLE_ACCESS_POLICY,
    currentAuthority: authority as never,
    lifecycleStore: registration.lifecycleStore,
    ownerResolution: registration.ownerResolution,
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x65)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: keySealer
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve as never,
    now: () => currentTime
  });
  let receiptId = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([changesetModule]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => currentTime },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });
  let correlation = 0x900;

  const repository = new SQLiteReleaseRepository(sqlite, sources);
  const bundle = createReleaseChangesetBundle();

  return {
    sqlite,
    repository,
    lifecycle: registration.lifecycleStore,
    ownerResolution: registration.ownerResolution,
    names,
    close: () => sqlite.close(),
    /** Seeds one inert release draft directly into the lifecycle store. */
    draftRelease(planningInput: ReleasePlanningInput) {
      const changesetId = next();
      const revisionId = next();
      const appended = transaction(sqlite, () => appendChangesetDraftSynchronous({
        store: registration.lifecycleStore,
        registry: bundle.registry,
        snapshot: Object.freeze({
          getPort<Port>(key: unknown): Port {
            if (key !== releaseReadPort) throw new TypeError('undeclared_read_port');
            return repository as unknown as Port;
          }
        }) as never,
        ids: {
          newChangesetId: () => changesetId,
          newRevisionId: () => revisionId,
          newApprovalId: () => { throw new TypeError('approval_id_unavailable'); },
          newCorrectionAttemptId: () => { throw new TypeError('correction_id_unavailable'); }
        },
        context: {
          workspaceId,
          eventId,
          principalKey: `workspace_user:${userId}`,
          authorityPrincipalKey: createHash('sha256')
            .update(`workspace_user:${userId}`)
            .digest('hex'),
          evaluatedAt: currentTime
        },
        operations: [{
          kind: RELEASE_CHANGESET_KIND,
          version: RELEASE_CHANGESET_VERSION,
          dependencyGroup: 'release',
          authorInput: planningInput
        }],
        dependencyGroups: [{ key: 'release', dependsOn: [] }],
        approvalPolicy,
        origin: 'human_ui'
      }));
      if (appended.kind !== 'success') throw new TypeError('release_draft_seed_failed');
      const revision = appended.record.revisions[0]!.revision;
      return {
        changesetId: appended.record.head.id,
        revisionId: revision.id,
        revisionDigest: revision.digest,
        headVersion: appended.record.head.version
      };
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

function durableCounts(fixture: ReturnType<typeof openFixture>) {
  return {
    receipts: count(fixture.sqlite, 'foundation_trial_operation_receipts'),
    releases: count(fixture.sqlite, 'program_releases'),
    names: count(fixture.sqlite, 'program_release_names'),
    lifecycleLinks: count(fixture.sqlite, 'release_changeset_receipt_links'),
    facts: count(fixture.sqlite, 'release_changeset_domain_facts'),
    pointers: count(fixture.sqlite, 'release_changeset_outbox_pointers'),
    timeline: count(fixture.sqlite, 'release_changeset_timeline'),
    commitLinks: count(fixture.sqlite, 'changeset_commit_links')
  };
}

function publishInput(releaseId: string, expected: number | null): ReleasePlanningInput {
  return {
    action: 'publish_schedule',
    scope,
    actorUserId: userId,
    occurredAt: now,
    releaseId,
    expectedCurrentReleaseNumber: expected
  };
}

async function propose(
  fixture: ReturnType<typeof openFixture>,
  selector: {
    readonly changesetId: string; readonly revisionId: string;
    readonly revisionDigest: string; readonly headVersion: number;
  },
  key: string
) {
  return changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: PROPOSE_CHANGESET_OPERATION,
    businessInput: {
      changesetId: selector.changesetId,
      revisionId: selector.revisionId,
      revisionDigest: selector.revisionDigest,
      expectedHeadVersion: selector.headVersion
    },
    key
  }));
}

function commitInput(selector: {
  readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string;
}) {
  return {
    changesetId: selector.changesetId,
    revisionId: selector.revisionId,
    revisionDigest: selector.revisionDigest,
    expectedHeadVersion: 2
  };
}

async function commit(
  fixture: ReturnType<typeof openFixture>,
  selector: { readonly changesetId: string; readonly revisionId: string; readonly revisionDigest: string },
  key: string
) {
  return changesetLifecycleOperationResultSchema.parse(await fixture.effect({
    operation: COMMIT_CHANGESET_OPERATION,
    businessInput: commitInput(selector),
    key
  }));
}

describe('ordinary SQLite release changeset effect domain', () => {
  test('commits the reviewed publish, writes the audited name copy, and replays idempotently', async () => {
    const fixture = openFixture();
    try {
      const releaseId = uuid(0xa01);
      const selector = fixture.draftRelease(publishInput(releaseId, null));
      const record = fixture.lifecycle.read(selector.changesetId);
      if (!record) throw new TypeError('release_changeset_record_missing');
      expect(await fixture.ownerResolution.resolveOwner(record)).toMatchObject({ id: 'release' });
      expect(fixture.repository.readCurrentProgramRelease(scope)).toBeUndefined();

      expect(await propose(fixture, selector, 'publish-propose')).toMatchObject({
        kind: 'success',
        data: { action: 'propose' }
      });
      // Proposing froze the reviewed plan; nothing is public yet.
      expect(fixture.repository.readCurrentProgramRelease(scope)).toBeUndefined();
      expect(count(fixture.sqlite, 'program_releases')).toBe(0);

      const committed = await commit(fixture, selector, 'publish-commit');
      expect(committed).toMatchObject({
        kind: 'success',
        data: { action: 'commit', committedHeadVersion: 3 }
      });
      const released = fixture.repository.readCurrentProgramRelease(scope);
      expect(released).toMatchObject({
        id: releaseId,
        number: 1,
        origin: { kind: 'publish' },
        nameDeclassifications: [{ personId: personA, displayName: 'Ada Lovelace' }]
      });
      // The hidden participant's name never reaches release state or facts.
      const factPayload = fixture.sqlite.query<{ readonly payload_json: string }, []>(`
        SELECT payload_json FROM release_changeset_domain_facts
      `).get()?.payload_json ?? 'null';
      expect(factPayload).toContain('Ada Lovelace');
      expect(factPayload).not.toContain('Hidden Person');
      expect(canonicalJsonText(released)).not.toContain('Hidden Person');

      const afterCommit = durableCounts(fixture);
      expect(afterCommit).toMatchObject({
        releases: 1,
        names: 1,
        lifecycleLinks: 2,
        facts: 1,
        pointers: 1,
        timeline: 2,
        commitLinks: 1
      });

      // Idempotent replay: the same idempotency key returns the same terminal
      // receipt without a second effective write.
      expect(await fixture.effect({
        operation: COMMIT_CHANGESET_OPERATION,
        businessInput: commitInput(selector),
        key: 'publish-commit'
      })).toEqual(committed as never);
      expect(durableCounts(fixture)).toEqual(afterCommit);

      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('commits a reviewed framing-allowlist change onto the published surface head', async () => {
    const fixture = openFixture();
    try {
      const styleSetId = uuid(0xb01);
      const styleSelector = fixture.draftRelease({
        action: 'style_set_publish',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId: styleSetId,
        sourceTemplateRevision: templatePin(themeArtifactId),
        recipe: themeRecipe,
        expectedCurrentStyleSetNumber: null
      });
      await propose(fixture, styleSelector, 'style-propose');
      await commit(fixture, styleSelector, 'style-commit');

      const surfaceId = uuid(0xb02);
      const surfaceSelector = fixture.draftRelease({
        action: 'surface_publish',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId: surfaceId,
        kind: 'speakers',
        sourceTemplateRevision: templatePin(speakersArtifactId),
        manifest: { schemaVersion: 1, heading: null, intro: null },
        styleSetReleaseId: styleSetId,
        formRef: null,
        expectedSurfaceHeadVersion: null
      });
      await propose(fixture, surfaceSelector, 'surface-propose');
      await commit(fixture, surfaceSelector, 'surface-commit');
      expect(fixture.repository.readSurfaceHead(scope, 'speakers')).toMatchObject({
        activeReleaseId: surfaceId,
        version: 1,
        allowedFrameOrigins: []
      });

      const allowlistSelector = fixture.draftRelease({
        action: 'surface_allowlist',
        scope,
        actorUserId: userId,
        occurredAt: now,
        kind: 'speakers',
        allowedFrameOrigins: ['https://www.example.org', 'https://Conference.example.com/'],
        expectedSurfaceHeadVersion: 1
      });
      // The reviewed diff shows both origin lists on the head images.
      const drafted = fixture.lifecycle.read(allowlistSelector.changesetId);
      if (!drafted) throw new TypeError('allowlist_changeset_missing');
      expect(drafted.revisions[0]!.revision.operations[0]!.safeDiff).toMatchObject({
        action: 'surface_allowlist',
        kind: 'speakers',
        before: { allowedFrameOrigins: [] },
        after: {
          allowedFrameOrigins: ['https://conference.example.com', 'https://www.example.org']
        }
      });
      await propose(fixture, allowlistSelector, 'allowlist-propose');
      // Proposing froze the reviewed policy; nothing served changes yet.
      expect(fixture.repository.readSurfaceHead(scope, 'speakers')?.allowedFrameOrigins)
        .toEqual([]);
      const committed = await commit(fixture, allowlistSelector, 'allowlist-commit');
      expect(committed).toMatchObject({ kind: 'success', data: { action: 'commit' } });
      expect(fixture.repository.readSurfaceHead(scope, 'speakers')).toMatchObject({
        activeReleaseId: surfaceId,
        version: 2,
        allowedFrameOrigins: ['https://conference.example.com', 'https://www.example.org']
      });
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('refuses a release chain that moved after propose without writing anything', async () => {
    const fixture = openFixture();
    try {
      const first = fixture.draftRelease(publishInput(uuid(0xb01), null));
      const second = fixture.draftRelease(publishInput(uuid(0xb02), null));
      expect(await propose(fixture, first, 'first-propose')).toMatchObject({ kind: 'success' });
      expect(await propose(fixture, second, 'second-propose')).toMatchObject({ kind: 'success' });
      expect(await commit(fixture, first, 'first-commit')).toMatchObject({
        kind: 'success',
        data: { action: 'commit' }
      });
      const before = durableCounts(fixture);
      expect(await commit(fixture, second, 'second-commit')).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'changeset.lifecycle_refused',
          detail: { code: 'guard_changed', subjectId: `program_release_chain:${eventId}` }
        }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.repository.readCurrentProgramRelease(scope)?.number).toBe(1);
      expect(fixture.lifecycle.read(second.changesetId)).toMatchObject({
        head: { status: 'proposed', version: 2 }
      });
    } finally {
      fixture.close();
    }
  });

  test('a renamed participant between propose and commit refuses the frozen plan', async () => {
    const fixture = openFixture();
    try {
      const selector = fixture.draftRelease(publishInput(uuid(0xc01), null));
      expect(await propose(fixture, selector, 'rename-propose')).toMatchObject({ kind: 'success' });
      fixture.names.set(personA, 'Ada King');
      const before = durableCounts(fixture);
      expect(await commit(fixture, selector, 'rename-commit')).toMatchObject({
        kind: 'outcome',
        outcome: { class: 'stale_revision', kind: 'changeset.lifecycle_refused' }
      });
      expect(durableCounts(fixture)).toEqual(before);
      expect(fixture.repository.readCurrentProgramRelease(scope)).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
});
