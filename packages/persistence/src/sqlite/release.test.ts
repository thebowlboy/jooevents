import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type {
  EngagementSnapshotDto,
  ReleasePlanningInput,
  ReleaseScopeDto,
  SessionCatalogDto,
  SessionHeadDto
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import { createProgramVocabularyState } from '@jooevents/program';
import {
  isProgramPlan,
  isStyleSetPlan,
  isSurfacePublishPlan,
  planReleaseMutation,
  planReleaseSurfaceSuccessorFrom,
  ReleasePlanningError
} from '@jooevents/release';
import { parseSchedulePlacementState } from '@jooevents/schedule';
import { sessionCatalogDigest, sessionHeadDigest, sessionRosterDigest } from '@jooevents/session';
import { installEventSpineSchema } from './event-spine';
import {
  createSQLiteIntakeFormVersionPinSource,
  installReleaseSchema,
  SQLiteReleaseError,
  SQLiteReleaseRepository,
  type SQLiteReleaseUpstreamSources
} from './release';
import { installSQLiteIntakeSchema } from './intake';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const eventId = '019c1df7-86b5-769b-bba4-5f7097bfc101';
const userId = '019c1df7-86b5-769b-bba4-5f7097bfc201';
const formatId = '019c1df7-86b5-769b-bba4-5f7097bfc301';
const roomId = '019c1df7-86b5-769b-bba4-5f7097bfc401';
const personA = '019c1df7-86b5-769b-bba4-5f7097bfc501';
const sessionId = '019c1df7-86b5-769b-bba4-5f7097bfc601';
const collectingId = '019c1df7-86b5-769b-bba4-5f7097bfc602';
const formId = '019c1df7-86b5-769b-bba4-5f7097bfc701';
const formVersion1 = '019c1df7-86b5-769b-bba4-5f7097bfc702';
const formVersion2 = '019c1df7-86b5-769b-bba4-5f7097bfc703';
const now = '2026-08-14T08:00:00.000Z';
const later = '2026-08-14T09:00:00.000Z';
const scope: ReleaseScopeDto = { workspaceId, eventId };

let nextIdOrdinal = 0x9000;
function uuid(): string {
  nextIdOrdinal += 1;
  return `019c1df7-86b5-769b-bba4-${nextIdOrdinal.toString(16).padStart(12, '0')}`;
}

function sessionHead(input: {
  readonly id: string;
  readonly title: string;
  readonly lifecycle: 'draft' | 'collecting' | 'programmed';
  readonly visible?: boolean;
}): SessionHeadDto {
  const participants = input.lifecycle === 'programmed'
    ? [{
        personId: personA,
        role: 'speaker' as const,
        position: 0,
        publiclyVisible: input.visible ?? true,
        source: { kind: 'submission', id: 'seeded', version: 1 }
      }]
    : [];
  const rosterUnsigned = { version: 1, participants };
  const roster = { ...rosterUnsigned, digestSha256: sessionRosterDigest(rosterUnsigned) };
  const unsigned = {
    schemaVersion: 1 as const,
    scope,
    id: input.id,
    title: input.title,
    plannedDurationMinutes: 60,
    lifecycle: input.lifecycle,
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

function catalog(visibleA = true): SessionCatalogDto {
  const sessions = [
    sessionHead({ id: sessionId, title: 'Opening Keynote', lifecycle: 'programmed', visible: visibleA }),
    sessionHead({ id: collectingId, title: 'Collecting Panel', lifecycle: 'collecting' })
  ].sort((left, right) => left.id < right.id ? -1 : 1);
  const unsigned = { schemaVersion: 1 as const, scope, version: 4, sessions };
  return { ...unsigned, digestSha256: sessionCatalogDigest(unsigned) } as SessionCatalogDto;
}

function engagements(): EngagementSnapshotDto {
  return {
    schemaVersion: 1,
    scope,
    engagements: [{
      schemaVersion: 1,
      id: '019c1df7-86b5-769b-bba4-5f7097bfc801',
      scope,
      sessionId,
      personId: personA,
      submissionId: null,
      seededByDecision: null,
      state: 'confirmed',
      invitedAt: now,
      respondBy: null,
      confirmation: { attribution: 'self', personId: personA, recordedByUserId: null, confirmedAt: now },
      cancellationRequest: null,
      cancelledAt: null,
      source: { kind: 'organizer', id: 'direct', version: 1 },
      version: 2
    }]
  } as EngagementSnapshotDto;
}

interface FixtureControls {
  names: Map<string, string>;
  publishedFormVersions: Map<string, string>;
  visibleA: boolean;
  occurrences: {
    readonly id: string; readonly sessionId: string; readonly roomId: string;
    readonly startAt: string; readonly endAt: string; readonly version: number;
  }[];
}

function fixture(): {
  readonly sqlite: Database;
  readonly repository: SQLiteReleaseRepository;
  readonly controls: FixtureControls;
} {
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
  `);
  installEventSpineSchema(sqlite);
  installReleaseSchema(sqlite);
  sqlite.query(`
    INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Operator', 1, 1, 1)
  `).run(userId);
  sqlite.query(`
    INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, null)
  `).run(workspaceId);
  sqlite.query(`
    INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Event', 'UTC', '2026-11-01', '2026-11-02', 1, ?, ?, ?)
  `).run(workspaceId, eventId, userId, Date.parse(now), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);

  const controls: FixtureControls = {
    names: new Map([[personA, 'Ada Lovelace']]),
    publishedFormVersions: new Map([[formId, formVersion1]]),
    visibleA: true,
    occurrences: [{
      id: '019c1df7-86b5-769b-bba4-5f7097bfc901',
      sessionId,
      roomId,
      startAt: '2026-11-01T09:00:00.000Z',
      endAt: '2026-11-01T10:00:00.000Z',
      version: 1
    }]
  };
  const sources: SQLiteReleaseUpstreamSources = {
    sessions: { readSessionCatalog: () => catalog(controls.visibleA) },
    schedule: {
      readSchedule: () => parseSchedulePlacementState({
        schemaVersion: 1,
        scope,
        scheduleVersion: 3,
        occurrences: [...controls.occurrences].sort((left, right) =>
          `${left.startAt}:${left.endAt}:${left.id}` < `${right.startAt}:${right.endAt}:${right.id}`
            ? -1 : 1
        )
      })
    },
    engagements: { readEngagementSnapshot: () => engagements() },
    vocabulary: {
      readVocabulary: () => createProgramVocabularyState({
        scope,
        setVersion: 2,
        rooms: [{ id: roomId, name: 'Main Hall', status: 'active', version: 1, capacity: null }],
        formats: [{ id: formatId, name: 'Talk', status: 'active', version: 1 }]
      })
    },
    eventSettings: {
      readEventSettings: () => ({
        event: { id: eventId, version: 5 }
      }) as never
    },
    names: {
      readParticipantDisplayName: (_scope, personId) => controls.names.get(personId)
    },
    forms: {
      readCurrentPublishedFormVersionId: (_scope, requestedFormId) =>
        controls.publishedFormVersions.get(requestedFormId)
    }
  };
  return Object.freeze({
    sqlite,
    repository: new SQLiteReleaseRepository(sqlite, sources),
    controls
  });
}

function transaction<Result>(sqlite: Database, work: () => Result): Result {
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

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

function publishInput(expected: number | null): ReleasePlanningInput {
  return {
    action: 'publish_schedule',
    scope,
    actorUserId: userId,
    occurredAt: now,
    releaseId: uuid(),
    expectedCurrentReleaseNumber: expected
  };
}

function publishProgram(
  sqlite: Database,
  repository: SQLiteReleaseRepository,
  expected: number | null
) {
  const plan = planReleaseMutation({ planningInput: publishInput(expected), port: repository });
  if (!isProgramPlan(plan)) throw new Error('wrong plan');
  transaction(sqlite, () => repository.applyReleasePlan(plan));
  return plan;
}

function publishStyleSet(sqlite: Database, repository: SQLiteReleaseRepository) {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'style_set_publish',
      scope,
      actorUserId: userId,
      occurredAt: now,
      releaseId: uuid(),
      recipe: {
        name: 'Warm default', canvas: '#faf8f5', surface: '#ffffff',
        text: '#2a2522', action: '#b05a4f', radius: 6, controlHeight: 36
      },
      expectedCurrentStyleSetNumber: null
    },
    port: repository
  });
  if (!isStyleSetPlan(plan)) throw new Error('wrong plan');
  transaction(sqlite, () => repository.applyReleasePlan(plan));
  return plan.release;
}

function publishSurface(
  sqlite: Database,
  repository: SQLiteReleaseRepository,
  input: {
    readonly kind: 'schedule' | 'speakers' | 'apply';
    readonly styleSetReleaseId: string;
    readonly formRef?: { readonly formId: string; readonly formVersionId: string };
    readonly expectedSurfaceHeadVersion: number | null;
  }
) {
  const plan = planReleaseMutation({
    planningInput: {
      action: 'surface_publish',
      scope,
      actorUserId: userId,
      occurredAt: now,
      releaseId: uuid(),
      kind: input.kind,
      manifest: { schemaVersion: 1, heading: null, intro: null },
      styleSetReleaseId: input.styleSetReleaseId,
      formRef: input.formRef ?? null,
      expectedSurfaceHeadVersion: input.expectedSurfaceHeadVersion
    },
    port: repository
  });
  if (!isSurfacePublishPlan(plan)) throw new Error('wrong plan');
  transaction(sqlite, () => repository.applyReleasePlan(plan));
  return plan;
}

describe('SQLite release persistence', () => {
  test('publishes an immutable program release carrying the audited name copy', () => {
    const { sqlite, repository } = fixture();
    const plan = publishProgram(sqlite, repository, null);

    const current = repository.readCurrentProgramRelease(scope)!;
    expect(canonicalJsonText(current)).toBe(canonicalJsonText(plan.release));
    expect(current.sessions.map((session) => session.sessionId)).toEqual([sessionId]);
    expect(canonicalJsonText(current)).not.toContain('Collecting Panel');
    expect(current.nameDeclassifications).toEqual([
      { personId: personA, displayName: 'Ada Lovelace' }
    ]);
    expect(count(sqlite, 'program_release_names')).toBe(1);

    // Replaying the exact committed plan refuses: the chain fence moved.
    expect(() => transaction(sqlite, () => repository.applyReleasePlan(plan)))
      .toThrow(new ReleasePlanningError('stale_release_chain'));

    // Retention: releases and their name copies physically refuse mutation.
    expect(() => sqlite.query(`
      UPDATE program_releases SET released_by_user_id = ? WHERE id = ?
    `).run(userId, plan.release.id)).toThrow(/immutable/);
    expect(() => sqlite.query(`DELETE FROM program_releases WHERE id = ?`).run(plan.release.id))
      .toThrow(/immutable/);
    expect(() => sqlite.query(`
      UPDATE program_release_names SET display_name = 'Renamed' WHERE release_id = ?
    `).run(plan.release.id)).toThrow(/immutable/);
    expect(() => sqlite.query(`DELETE FROM program_release_names WHERE release_id = ?`)
      .run(plan.release.id)).toThrow(/immutable/);

    // The declassified-name columns carry ONLY what the audited copy
    // authorized: an unauthorized row is a physical refusal.
    expect(() => sqlite.query(`
      INSERT INTO program_release_names (workspace_id, event_id, release_id, person_id, display_name)
      VALUES (?, ?, ?, ?, 'Grace Hopper')
    `).run(workspaceId, eventId, plan.release.id, '019c1df7-86b5-769b-bba4-5f7097bfc502'))
      .toThrow(/not authorized/);
    expect(() => sqlite.query(`
      INSERT INTO program_release_names (workspace_id, event_id, release_id, person_id, display_name)
      VALUES (?, ?, ?, ?, 'Ada Renamed')
    `).run(workspaceId, eventId, plan.release.id, personA)).toThrow(/not authorized/);
  });

  test('a rolled-back unit of work leaves no release state behind', () => {
    const { sqlite, repository } = fixture();
    const plan = planReleaseMutation({ planningInput: publishInput(null), port: repository });
    sqlite.exec('BEGIN IMMEDIATE;');
    repository.applyReleasePlan(plan);
    expect(count(sqlite, 'program_releases')).toBe(1);
    sqlite.exec('ROLLBACK;');
    expect(count(sqlite, 'program_releases')).toBe(0);
    expect(count(sqlite, 'program_release_names')).toBe(0);
    expect(repository.readCurrentProgramRelease(scope)).toBeUndefined();
    // The identical plan still applies cleanly afterwards: nothing leaked.
    transaction(sqlite, () => repository.applyReleasePlan(plan));
    expect(repository.readCurrentProgramRelease(scope)?.id)
      .toBe(isProgramPlan(plan) ? plan.release.id : '');
  });

  test('program rollback restores content as a successor; surface rollback moves only the pointer', () => {
    const { sqlite, repository, controls } = fixture();
    const first = publishProgram(sqlite, repository, null);
    controls.names.set(personA, 'Ada King');
    const second = publishProgram(sqlite, repository, 1);
    expect(second.release.nameDeclassifications[0]!.displayName).toBe('Ada King');

    const rollbackPlan = planReleaseMutation({
      planningInput: {
        action: 'program_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        releaseId: uuid(),
        targetReleaseId: first.release.id,
        expectedCurrentReleaseNumber: 2
      },
      port: repository
    });
    transaction(sqlite, () => repository.applyReleasePlan(rollbackPlan));
    const restored = repository.readCurrentProgramRelease(scope)!;
    expect(restored.number).toBe(3);
    expect(restored.origin).toEqual({ kind: 'rollback', restoredFromReleaseId: first.release.id });
    expect(restored.nameDeclassifications).toEqual(first.release.nameDeclassifications);
    expect(repository.readProgramRelease(scope, second.release.id)).toBeDefined();

    const styleSet = publishStyleSet(sqlite, repository);
    const firstSurface = publishSurface(sqlite, repository, {
      kind: 'speakers', styleSetReleaseId: styleSet.id, expectedSurfaceHeadVersion: null
    });
    const secondSurface = publishSurface(sqlite, repository, {
      kind: 'speakers', styleSetReleaseId: styleSet.id, expectedSurfaceHeadVersion: 1
    });
    expect(repository.readSurfaceHead(scope, 'speakers')?.activeReleaseId)
      .toBe(secondSurface.release.id);

    const programBefore = repository.readCurrentProgramRelease(scope)!;
    const surfaceRollback = planReleaseMutation({
      planningInput: {
        action: 'surface_rollback',
        scope,
        actorUserId: userId,
        occurredAt: later,
        kind: 'speakers',
        targetReleaseId: firstSurface.release.id,
        expectedSurfaceHeadVersion: 2
      },
      port: repository
    });
    transaction(sqlite, () => repository.applyReleasePlan(surfaceRollback));
    const head = repository.readSurfaceHead(scope, 'speakers')!;
    expect(head.activeReleaseId).toBe(firstSurface.release.id);
    expect(head.version).toBe(3);
    // Presentation rollback never reverts program data.
    expect(canonicalJsonText(repository.readCurrentProgramRelease(scope)))
      .toBe(canonicalJsonText(programBefore));
    // Head versions physically advance by exactly one.
    expect(() => sqlite.query(`
      UPDATE surface_heads SET version = version + 2 WHERE kind = 'speakers'
    `).run()).toThrow(/advance by one/);
  });

  test('a stale surface head fence refuses instead of double-writing', () => {
    const { sqlite, repository } = fixture();
    const styleSet = publishStyleSet(sqlite, repository);
    publishSurface(sqlite, repository, {
      kind: 'schedule', styleSetReleaseId: styleSet.id, expectedSurfaceHeadVersion: null
    });
    expect(() => publishSurface(sqlite, repository, {
      kind: 'schedule', styleSetReleaseId: styleSet.id, expectedSurfaceHeadVersion: null
    })).toThrow(new ReleasePlanningError('stale_surface_head'));
  });

  test('an allowlist change persists on the head row and pointer moves carry it', () => {
    const { sqlite, repository } = fixture();
    const styleSet = publishStyleSet(sqlite, repository);
    const first = publishSurface(sqlite, repository, {
      kind: 'apply',
      styleSetReleaseId: styleSet.id,
      formRef: { formId, formVersionId: formVersion1 },
      expectedSurfaceHeadVersion: null
    });
    expect(repository.readSurfaceHead(scope, 'apply')?.allowedFrameOrigins).toEqual([]);
    const allowlistPlan = planReleaseMutation({
      planningInput: {
        action: 'surface_allowlist',
        scope,
        actorUserId: userId,
        occurredAt: later,
        kind: 'apply',
        allowedFrameOrigins: ['https://Conference.example.com/', 'https://www.example.org'],
        expectedSurfaceHeadVersion: 1
      },
      port: repository
    });
    const result = transaction(sqlite, () => repository.applyReleasePlan(allowlistPlan));
    expect(result.action).toBe('surface_allowlist');
    const head = repository.readSurfaceHead(scope, 'apply')!;
    expect(head.activeReleaseId).toBe(first.release.id);
    expect(head.version).toBe(2);
    expect(head.allowedFrameOrigins)
      .toEqual(['https://conference.example.com', 'https://www.example.org']);
    // Replaying the applied plan refuses on the moved head fence.
    expect(() => transaction(sqlite, () => repository.applyReleasePlan(allowlistPlan)))
      .toThrow(new ReleasePlanningError('stale_surface_head'));
    // A later publish carries the stored allowlist forward unchanged.
    const second = publishSurface(sqlite, repository, {
      kind: 'apply',
      styleSetReleaseId: styleSet.id,
      formRef: { formId, formVersionId: formVersion1 },
      expectedSurfaceHeadVersion: 2
    });
    expect(second.headAfter.allowedFrameOrigins)
      .toEqual(['https://conference.example.com', 'https://www.example.org']);
    expect(repository.readSurfaceHead(scope, 'apply')?.allowedFrameOrigins)
      .toEqual(['https://conference.example.com', 'https://www.example.org']);
    // A stored policy that is not an array is a physical refusal.
    expect(() => sqlite.query(`
      UPDATE surface_heads
         SET version = version + 1,
             head_json = json_set(head_json, '$.allowedFrameOrigins', 'https://x.example.com')
       WHERE kind = 'apply'
    `).run()).toThrow();
  });

  test('the form-republish successor collaboration applies atomically', () => {
    const { sqlite, repository, controls } = fixture();
    const styleSet = publishStyleSet(sqlite, repository);
    const applySurface = publishSurface(sqlite, repository, {
      kind: 'apply',
      styleSetReleaseId: styleSet.id,
      formRef: { formId, formVersionId: formVersion1 },
      expectedSurfaceHeadVersion: null
    });
    controls.publishedFormVersions.set(formId, formVersion2);
    const successorPlan = planReleaseSurfaceSuccessorFrom(repository, {
      scope, formId, formVersionId: formVersion2, actorUserId: userId, occurredAt: later
    });
    expect(successorPlan.successors).toHaveLength(1);

    sqlite.exec('BEGIN IMMEDIATE;');
    repository.applyReleaseSurfaceSuccessorPlan(successorPlan);
    sqlite.exec('ROLLBACK;');
    expect(repository.readSurfaceHead(scope, 'apply')?.activeReleaseId)
      .toBe(applySurface.release.id);

    const heads = transaction(sqlite, () =>
      repository.applyReleaseSurfaceSuccessorPlan(successorPlan)
    );
    expect(heads).toHaveLength(1);
    const successor = repository.readSurfaceRelease(scope, heads[0]!.activeReleaseId)!;
    if (successor.kind !== 'apply') throw new Error('wrong kind');
    expect(successor.formRef).toEqual({ formId, formVersionId: formVersion2 });
    expect(successor.predecessor?.releaseId).toBe(applySurface.release.id);
    // Replaying the applied successor plan refuses on the moved head.
    expect(() => transaction(sqlite, () =>
      repository.applyReleaseSurfaceSuccessorPlan(successorPlan)
    )).toThrow(new ReleasePlanningError('stale_surface_head'));
  });

  test('block-severity schedule conflicts surface as evidence and refuse publish', () => {
    const { repository, controls } = fixture();
    controls.occurrences.push({
      id: '019c1df7-86b5-769b-bba4-5f7097bfc902',
      sessionId: collectingId,
      roomId,
      startAt: '2026-11-01T09:30:00.000Z',
      endAt: '2026-11-01T10:30:00.000Z',
      version: 1
    });
    const conflicts = repository.readReleaseScheduleConflicts(scope);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe('block');
    expect(conflicts[0]!.roomId).toBe(roomId);
    expect(conflicts[0]!.occurrences.map((occurrence) => occurrence.occurrenceId)).toEqual([
      '019c1df7-86b5-769b-bba4-5f7097bfc901',
      '019c1df7-86b5-769b-bba4-5f7097bfc902'
    ]);
    let caught: unknown;
    try {
      planReleaseMutation({ planningInput: publishInput(null), port: repository });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleasePlanningError);
    expect((caught as ReleasePlanningError).code).toBe('schedule_conflicts_block');
  });

  test('an unresolvable participant name refuses the publish plan', () => {
    const { repository, controls } = fixture();
    controls.names.delete(personA);
    expect(() => planReleaseMutation({ planningInput: publishInput(null), port: repository }))
      .toThrow(new ReleasePlanningError('participant_name_unavailable'));
  });

  test('the intake form version pin source serves only the published head pointer', () => {
    const { sqlite } = fixture();
    installSQLiteIntakeSchema(sqlite);
    const source = createSQLiteIntakeFormVersionPinSource(sqlite);
    expect(source.readCurrentPublishedFormVersionId(scope, formId)).toBeUndefined();
    sqlite.query(`
      INSERT INTO intake_form_catalogs (workspace_id, event_id, catalog_version) VALUES (?, ?, 2)
    `).run(workspaceId, eventId);
    sqlite.query(`
      INSERT INTO intake_form_heads (
        workspace_id, event_id, form_id, head_version, status, current_published_version_id,
        head_json, head_digest_sha256, created_by_user_id, created_at_ms,
        updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, 3, 'open', ?, '{}', ?, ?, ?, ?, ?)
    `).run(
      workspaceId, eventId, formId, formVersion1, 'b'.repeat(64),
      userId, Date.parse(now), userId, Date.parse(now)
    );
    expect(source.readCurrentPublishedFormVersionId(scope, formId)).toBe(formVersion1);
  });

  test('served public projections follow the newest release and fail closed on absence', () => {
    const { sqlite, repository, controls } = fixture();
    // No release yet is a typed absence, never an empty page.
    expect(repository.readServedSchedule(scope)).toBeUndefined();
    expect(repository.readServedRoster(scope)).toBeUndefined();

    publishProgram(sqlite, repository, null);
    const schedule = repository.readServedSchedule(scope)!;
    const roster = repository.readServedRoster(scope)!;
    expect(schedule.releaseNumber).toBe(1);
    expect(schedule.sessions.map((session) => session.sessionId)).toEqual([sessionId]);
    expect(schedule.sessions[0]!.speakers).toEqual(['Ada Lovelace']);
    expect(schedule.rooms).toEqual([{ id: roomId, name: 'Main Hall' }]);
    expect(roster.speakers).toEqual([{
      name: 'Ada Lovelace',
      sessions: [{ sessionId, title: 'Opening Keynote' }]
    }]);
    for (const bytes of [canonicalJsonText(schedule), canonicalJsonText(roster)]) {
      expect(bytes).not.toContain('Collecting Panel');
      expect(bytes).not.toContain(collectingId);
      expect(bytes).not.toContain('personId');
      expect(bytes).not.toContain(personA);
      expect(bytes).not.toContain('email');
    }

    // Hiding the person and committing a successor removes them from what is
    // served immediately: read-only surfaces follow the newest release.
    controls.visibleA = false;
    publishProgram(sqlite, repository, 1);
    const successorSchedule = repository.readServedSchedule(scope)!;
    const successorRoster = repository.readServedRoster(scope)!;
    expect(successorSchedule.releaseNumber).toBe(2);
    expect(successorSchedule.sessions[0]!.speakers).toEqual([]);
    expect(successorRoster.speakers).toEqual([]);
    expect(canonicalJsonText(successorSchedule)).not.toContain('Ada Lovelace');
    expect(canonicalJsonText(successorRoster)).not.toContain('Ada Lovelace');
  });

  test('surface releases physically refuse a form pin on read-only kinds', () => {
    const { sqlite, repository } = fixture();
    const styleSet = publishStyleSet(sqlite, repository);
    const plan = planReleaseMutation({
      planningInput: {
        action: 'surface_publish',
        scope,
        actorUserId: userId,
        occurredAt: now,
        releaseId: uuid(),
        kind: 'schedule',
        manifest: { schemaVersion: 1, heading: null, intro: null },
        styleSetReleaseId: styleSet.id,
        formRef: null,
        expectedSurfaceHeadVersion: null
      },
      port: repository
    });
    if (!isSurfacePublishPlan(plan)) throw new Error('wrong plan');
    transaction(sqlite, () => repository.applyReleasePlan(plan));
    // Direct SQL cannot smuggle a form pin onto a read-only surface release.
    expect(() => sqlite.query(`
      INSERT INTO surface_releases (
        workspace_id, event_id, id, kind, number, predecessor_release_id,
        style_set_release_id, form_id, form_version_id, release_json, digest_sha256,
        released_by_user_id, released_at_ms
      ) VALUES (?, ?, ?, 'schedule', 9, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId, eventId, uuid(), styleSet.id, formId, formVersion1,
      canonicalJsonText({ any: true }), 'c'.repeat(64), userId, Date.parse(now)
    )).toThrow();
  });
});
