import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngagementHeadDto, SessionHeadDto } from '@jooevents/contracts';
import { createCalendarCommitmentFactContributor } from '@jooevents/calendar-operations';
import { calendarCommitmentFactSchema, type CalendarCommitmentFact } from '@jooevents/contracts/calendar';
import type { SchedulePlacementOccurrenceDto } from '@jooevents/contracts/schedule-placement';
import { canonicalJsonText } from '@jooevents/kernel';
import { openSQLite, type OpenSQLiteResult } from './database';
import {
  CALENDAR_CANONICAL_STATE_ADAPTER_AVAILABILITY,
  SQLITE_CALENDAR_COMMITMENT_FACT_CONTRIBUTOR,
  SQLiteCalendarCanonicalStateError,
  SQLiteCalendarCanonicalStateRepository
} from './calendar-canonical-state';
import { createSQLiteOperationFeatureContributionAdapterRegistry } from './operation-feature-contribution-registry';

const W = '10000000-0000-4000-8000-000000000001';
const E = '10000000-0000-4000-8000-000000000002';
const S = '10000000-0000-4000-8000-000000000003';
const P = '10000000-0000-4000-8000-000000000004';
const G = '10000000-0000-4000-8000-000000000005';
const O = '10000000-0000-4000-8000-000000000006';
const R = '10000000-0000-4000-8000-000000000008';
const F = '10000000-0000-4000-8000-000000000009';
const U = '10000000-0000-4000-8000-000000000010';
const D = 'a'.repeat(64);
const AT = '2026-08-18T01:02:00.000Z';
const opened: OpenSQLiteResult[] = [];
const temporaryRoots: string[] = [];

function session(): SessionHeadDto {
  return {
    schemaVersion: 1, scope: { workspaceId: W, eventId: E }, id: S,
    title: 'Practical systems', plannedDurationMinutes: 45, lifecycle: 'programmed',
    programTarget: {
      setVersion: 1, setDigestSha256: D,
      format: { kind: 'format', id: F, name: 'Talk', status: 'active', version: 1 }, track: null
    },
    roster: {
      version: 1, digestSha256: D,
      participants: [{
        personId: P, role: 'speaker', position: 0, publiclyVisible: true,
        source: { kind: 'submission', id: 'submission-1', version: 1 }
      }]
    },
    version: 1, digestSha256: D, createdByUserId: U, createdAt: '2026-08-18T01:00:00.000Z',
    updatedByUserId: U, updatedAt: '2026-08-18T01:00:00.000Z'
  };
}

function engagement(): EngagementHeadDto {
  return {
    schemaVersion: 1, id: G, scope: { workspaceId: W, eventId: E }, sessionId: S,
    personId: P, submissionId: null, seededByDecision: null, state: 'confirmed',
    invitedAt: '2026-08-18T01:00:00.000Z', respondBy: null,
    confirmation: {
      attribution: 'self', personId: P, recordedByUserId: null,
      confirmedAt: '2026-08-18T01:01:00.000Z'
    },
    cancellationRequest: null, cancelledAt: null,
    source: { kind: 'session', id: S, version: 1 }, version: 2
  };
}

function occurrence(): SchedulePlacementOccurrenceDto {
  return {
    id: O, sessionId: S, roomId: R,
    startAt: '2026-09-01T02:00:00.000Z', endAt: '2026-09-01T02:45:00.000Z', version: 1
  };
}

function operationId(number: number): string {
  return `20000000-0000-7000-8000-${String(number).padStart(12, '0')}`;
}

function seedOperation(runtime: OpenSQLiteResult, id: string): void {
  const result = canonicalJsonText({
    kind: 'success', data: {},
    receipt: { id, operationName: 'calendar.fixture', operationVersion: 1 }
  });
  runtime.sqlite.query(`
    INSERT INTO operation_log (
      id,operation_name,operation_version,registry_digest_sha256,surface,actor_json,
      authority_principal_key,workspace_id,event_id,subjects_json,summary,occurred_at_ms,
      correlation_id,scope_partition_key,idempotency_verifier_profile_key,
      idempotency_verifier_profile_version,idempotency_key_verifier,request_hash,result_json
    ) VALUES (?,'calendar.fixture',1,?,'application_job',?, ?,?,?,?,
      'Calendar fixture operation',?,?,?,'calendar.fixture',1,?,?,?)
  `).run(
    id, '1'.repeat(64), canonicalJsonText({ kind: 'system_job', job: 'calendar.fixture' }),
    'system_job:calendar.fixture', W, E,
    canonicalJsonText([{ kind: 'event', id: E }]), Date.parse(AT), operationId(999),
    '2'.repeat(64), id.replaceAll('-', '').padEnd(64, '3').slice(0, 64), '4'.repeat(64), result
  );
}

function runtime(path = ':memory:'): OpenSQLiteResult {
  const result = path === ':memory:'
    ? openSQLite(path)
    : openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
  opened.push(result);
  result.sqlite.exec('BEGIN IMMEDIATE;');
  result.sqlite.query(`INSERT INTO workspaces(id,name,state,created_at,updated_at,version)
    VALUES (?,'Calendar workspace','active',0,0,1)`).run(W);
  result.sqlite.query(`INSERT INTO users(id,status,display_name,created_at,updated_at,version)
    VALUES (?,'active','Calendar owner',0,0,1)`).run(U);
  result.sqlite.query(`INSERT INTO event_spine_workspace_sets(workspace_id,version,current_event_id)
    VALUES (?,1,NULL)`).run(W);
  result.sqlite.query(`INSERT INTO event_spine_heads(
    workspace_id,id,name,timezone,start_date,end_date,version,created_by_user_id,created_at_ms,create_plan_digest_sha256
  ) VALUES (?,?,'Calendar event','UTC','2026-09-01','2026-09-02',1,?,0,?)`).run(W, E, U, D);
  result.sqlite.query('INSERT INTO event_spine_scope_roots(workspace_id,event_id) VALUES (?,?)').run(W, E);
  result.sqlite.exec('COMMIT;');
  return result;
}

function fact(operationLogId: string, ordinal: number, payload: CalendarCommitmentFact['fact']): CalendarCommitmentFact {
  return calendarCommitmentFactSchema.parse({
    schemaVersion: 1, source: { operationLogId, ordinal }, scope: { workspaceId: W, eventId: E },
    occurredAt: AT, fact: payload
  });
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.sqlite.close();
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true });
});

describe('SQLite calendar canonical state', () => {
  test('advertises SQLite only while D1 has no equivalent schema or adapter', () => {
    expect(CALENDAR_CANONICAL_STATE_ADAPTER_AVAILABILITY).toEqual({
      sqlite: 'available', d1: 'unavailable'
    });
  });

  test('joins a schedule operation contribution through durable intake to a reloaded commitment with release disabled', () => {
    const target = runtime();
    const repository = new SQLiteCalendarCanonicalStateRepository(target.sqlite);
    const sourceLogId = operationId(30);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, sourceLogId);
    for (const item of [
      fact(sourceLogId, 0, { kind: 'session_changed', version: 1, data: { sessionId: S, session: session() } }),
      fact(sourceLogId, 1, { kind: 'room_changed', version: 1, data: { action: 'create', roomId: R, name: 'Room A', version: 1 } }),
      fact(sourceLogId, 2, { kind: 'engagement_changed', version: 1, data: { engagement: engagement() } })
    ]) repository.appendFact(item);
    target.sqlite.exec('COMMIT;');

    const placementLogId = operationId(31);
    const batch = createCalendarCommitmentFactContributor().contribute({
      operation: { name: 'schedule.placement', version: 1 },
      businessInput: {
        action: 'place', expectedScheduleVersion: 1, sessionId: S, roomId: R,
        startAt: occurrence().startAt, endAt: occurrence().endAt
      },
      canonicalResult: {
        kind: 'success', data: { action: 'place', scheduleVersion: 2, occurrence: occurrence() }
      },
      scope: { workspaceId: W, eventId: E, subjects: [], resolutionEvidenceIds: [] },
      occurredAt: AT
    } as never)!;
    const adapters = createSQLiteOperationFeatureContributionAdapterRegistry([{
      contributor: SQLITE_CALENDAR_COMMITMENT_FACT_CONTRIBUTOR,
      adapter: repository.createContributionAdapter()
    }]);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, placementLogId);
    adapters.apply({
      contributor: SQLITE_CALENDAR_COMMITMENT_FACT_CONTRIBUTOR,
      operationLogId: placementLogId,
      value: batch
    });
    target.sqlite.exec('COMMIT;');
    expect(repository.projectNextBatch({ workspaceId: W, eventId: E })).toMatchObject({
      processed: 4, remaining: 0
    });
    const reloaded = new SQLiteCalendarCanonicalStateRepository(target.sqlite)
      .readCommitments({ workspaceId: W, eventId: E }, P);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ occurrenceId: O, lifecycle: 'deliverable', sequence: 0 });
    expect(target.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM calendar_notice_generations
       WHERE communication_release_id IS NOT NULL
    `).get()).toEqual({ count: 0 });
    expect(target.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM communication_outbound_delivery_heads
    `).get()).toEqual({ count: 0 });
  });

  test('appends atomically, replays exactly, projects bounded batches, and reloads one stable commitment', () => {
    const target = runtime();
    const repository = new SQLiteCalendarCanonicalStateRepository(target.sqlite);
    const logId = operationId(1);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, logId);
    const facts = [
      fact(logId, 0, { kind: 'session_changed', version: 1, data: { sessionId: S, session: session() } }),
      fact(logId, 1, { kind: 'room_changed', version: 1, data: { action: 'create', roomId: R, name: 'Room A', version: 1 } }),
      fact(logId, 2, { kind: 'engagement_changed', version: 1, data: { engagement: engagement() } }),
      fact(logId, 3, { kind: 'occurrence_changed', version: 1, data: { action: 'place', occurrenceId: O, occurrence: occurrence() } })
    ];
    for (const item of facts) expect(repository.appendFact(item).replay).toBe(false);
    expect(repository.appendFact(facts[0]!).replay).toBe(true);
    expect(() => repository.appendFact({
      ...facts[0]!, occurredAt: '2026-08-18T01:03:00.000Z'
    })).toThrow(SQLiteCalendarCanonicalStateError);
    target.sqlite.exec('COMMIT;');

    expect(repository.projectNextBatch({ workspaceId: W, eventId: E }, 2)).toMatchObject({
      processed: 2, fromIntakePosition: 0, remaining: 2
    });
    expect(repository.readCommitments({ workspaceId: W, eventId: E })).toHaveLength(0);
    expect(repository.projectNextBatch({ workspaceId: W, eventId: E }, 2)).toMatchObject({
      processed: 2, remaining: 0
    });
    const commitments = repository.readCommitments({ workspaceId: W, eventId: E }, P);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({
      personId: P, sessionId: S, occurrenceId: O, sequence: 0,
      lifecycle: 'deliverable', roomName: 'Room A'
    });
    expect(repository.projectNextBatch({ workspaceId: W, eventId: E }, 100).processed).toBe(0);
    expect(repository.readCommitments({ workspaceId: W, eventId: E })[0]?.uid).toBe(commitments[0]?.uid);
    expect(target.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM calendar_notice_generations
    `).get()).toEqual({ count: 1 });
    expect(target.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('restarts from the durable cursor and fences a concurrent projection writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'jooevents-calendar-cursor-'));
    temporaryRoots.push(root);
    const path = join(root, 'calendar.sqlite');
    const target = runtime(path);
    const repository = new SQLiteCalendarCanonicalStateRepository(target.sqlite);
    const logId = operationId(31);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, logId);
    for (const item of [
      fact(logId, 0, { kind: 'session_changed', version: 1, data: { sessionId: S, session: session() } }),
      fact(logId, 1, { kind: 'room_changed', version: 1, data: { action: 'create', roomId: R, name: 'Room A', version: 1 } }),
      fact(logId, 2, { kind: 'engagement_changed', version: 1, data: { engagement: engagement() } }),
      fact(logId, 3, { kind: 'occurrence_changed', version: 1, data: { action: 'place', occurrenceId: O, occurrence: occurrence() } })
    ]) repository.appendFact(item);
    target.sqlite.exec('COMMIT;');
    expect(repository.projectNextBatch({ workspaceId: W, eventId: E }, 2)).toMatchObject({
      processed: 2, fromIntakePosition: 0, remaining: 2
    });

    target.sqlite.close();
    opened.splice(opened.indexOf(target), 1);
    const restarted = openSQLite(path, { migrationPolicy: 'validate' });
    opened.push(restarted);
    restarted.sqlite.exec('PRAGMA busy_timeout=0;');
    const restartedRepository = new SQLiteCalendarCanonicalStateRepository(restarted.sqlite);
    const contender = new Database(path, { strict: true });
    contender.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
    try {
      expect(() => restartedRepository.projectNextBatch({ workspaceId: W, eventId: E }, 2))
        .toThrow('cursor_busy');
      expect(restarted.sqlite.query<{ last_intake_position: number }, []>(`
        SELECT last_intake_position FROM calendar_commitment_cursors
      `).get()).toEqual({ last_intake_position: 2 });
    } finally {
      contender.exec('ROLLBACK;');
      contender.close();
    }
    expect(restartedRepository.projectNextBatch({ workspaceId: W, eventId: E }, 2)).toMatchObject({
      processed: 2, fromIntakePosition: 2, remaining: 0
    });
    expect(restartedRepository.readCommitments({ workspaceId: W, eventId: E }, P))
      .toHaveLength(1);
  });

  test('rolls a poison fact back and exposes a named counted attention destination', () => {
    const target = runtime();
    const repository = new SQLiteCalendarCanonicalStateRepository(target.sqlite);
    const logId = operationId(2);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, logId);
    repository.appendFact(fact(logId, 0, {
      kind: 'occurrence_changed', version: 1,
      data: { action: 'unplace', occurrenceId: O, occurrence: null }
    }));
    target.sqlite.exec('COMMIT;');
    expect(() => repository.projectNextBatch({ workspaceId: W, eventId: E }))
      .toThrow('projection_poisoned');
    expect(repository.listAttentionItems({ workspaceId: W, eventId: E })).toEqual([{
      code: 'calendar_projection_poison_fact', count: 1,
      destination: '/communications/calendar/projection-attention'
    }]);
    expect(target.sqlite.query<{ last_intake_position: number }, []>(`
      SELECT last_intake_position FROM calendar_commitment_cursors
    `).get()).toEqual({ last_intake_position: 0 });
    expect(target.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM calendar_commitment_source_heads
    `).get()).toEqual({ count: 0 });
    repository.markCursorStalled({ workspaceId: W, eventId: E }, '2026-08-18T02:00:00.000Z');
    expect(repository.listAttentionItems({ workspaceId: W, eventId: E })).toEqual([{
      code: 'calendar_projection_stalled_cursor', count: 1,
      destination: '/communications/calendar/projection-attention'
    }]);
  });

  test('keeps sparse preference defaults and feed lookup fail-closed across rotate and revoke', () => {
    const target = runtime();
    const repository = new SQLiteCalendarCanonicalStateRepository(target.sqlite);
    expect(repository.effectivePreference({ workspaceId: W, eventId: E }, P)).toEqual({
      mode: 'invite_primary', deadlineOptIn: false, version: 0
    });
    const logId = operationId(3);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, logId);
    repository.changePreference({
      scope: { workspaceId: W, eventId: E }, personId: P, mode: 'feed_primary',
      deadlineOptIn: true, expectedVersion: 0, operationLogId: logId, occurredAt: AT
    });
    const feedId = operationId(4);
    repository.issueFeed({
      scope: { workspaceId: W, eventId: E }, personId: P, feedId,
      lookupProfile: 'calendar.feed-token', lookupVersion: 1,
      lookupKeyedSha256: '5'.repeat(64), occurredAt: AT
    });
    target.sqlite.exec('COMMIT;');
    expect(repository.effectivePreference({ workspaceId: W, eventId: E }, P)).toEqual({
      mode: 'feed_primary', deadlineOptIn: true, version: 1
    });
    expect(repository.lookupFeed(W, 'calendar.feed-token', 1, '5'.repeat(64))).toMatchObject({ feedId });
    expect(repository.lookupFeed(E, 'calendar.feed-token', 1, '5'.repeat(64))).toBeUndefined();
    expect(JSON.stringify(target.sqlite.query('SELECT * FROM calendar_feeds').all())).not.toContain('raw-token');

    target.sqlite.exec('BEGIN IMMEDIATE;');
    repository.rotateFeed({
      feedId, expectedVersion: 1, lookupProfile: 'calendar.feed-token', lookupVersion: 1,
      lookupKeyedSha256: '6'.repeat(64), occurredAt: '2026-08-18T02:00:00.000Z'
    });
    target.sqlite.exec('COMMIT;');
    expect(repository.lookupFeed(W, 'calendar.feed-token', 1, '5'.repeat(64))).toBeUndefined();
    expect(repository.lookupFeed(W, 'calendar.feed-token', 1, '6'.repeat(64))).toMatchObject({ version: 2 });
    target.sqlite.exec('BEGIN IMMEDIATE;');
    repository.revokeFeed(feedId, 2, '2026-08-18T03:00:00.000Z');
    target.sqlite.exec('COMMIT;');
    expect(repository.lookupFeed(W, 'calendar.feed-token', 1, '6'.repeat(64))).toBeUndefined();
  });

  test('keeps generation boundaries fixed and makes hold, seal, release, and next-generation transitions fenced', () => {
    const target = runtime();
    const repository = new SQLiteCalendarCanonicalStateRepository(target.sqlite);
    const logId = operationId(10);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, logId);
    for (const item of [
      fact(logId, 0, { kind: 'session_changed', version: 1, data: { sessionId: S, session: session() } }),
      fact(logId, 1, { kind: 'room_changed', version: 1, data: { action: 'create', roomId: R, name: 'Room A', version: 1 } }),
      fact(logId, 2, { kind: 'engagement_changed', version: 1, data: { engagement: engagement() } }),
      fact(logId, 3, { kind: 'occurrence_changed', version: 1, data: { action: 'place', occurrenceId: O, occurrence: occurrence() } })
    ]) repository.appendFact(item);
    target.sqlite.exec('COMMIT;');
    repository.projectNextBatch({ workspaceId: W, eventId: E });
    const generation = target.sqlite.query<{
      generation_id: string; seal_at_ms: number; version: number;
    }, []>('SELECT generation_id,seal_at_ms,version FROM calendar_notice_generations').get()!;
    target.sqlite.exec('BEGIN IMMEDIATE;');
    expect(() => target.sqlite.query(`
      UPDATE calendar_notice_generations SET seal_at_ms=seal_at_ms+1,version=version+1
       WHERE generation_id=?
    `).run(generation.generation_id)).toThrow('boundary');
    target.sqlite.exec('ROLLBACK;');
    expect(target.sqlite.query<{ seal_at_ms: number }, [string]>(`
      SELECT seal_at_ms FROM calendar_notice_generations WHERE generation_id=?
    `).get(generation.generation_id)).toEqual({ seal_at_ms: generation.seal_at_ms });

    target.sqlite.exec('BEGIN IMMEDIATE;');
    repository.setGenerationHold(generation.generation_id, 1, true);
    repository.sealGeneration({
      generationId: generation.generation_id, expectedVersion: 2,
      reason: 'manual_release', sealedAt: '2026-08-18T02:00:00.000Z'
    });
    repository.releaseGeneration(generation.generation_id, 3, operationId(11));
    repository.releaseGeneration(generation.generation_id, 4, operationId(11));
    target.sqlite.exec('COMMIT;');
    expect(target.sqlite.query<{
      state: string; held: number; version: number; communication_release_id: string;
    }, [string]>(`
      SELECT state,held,version,communication_release_id FROM calendar_notice_generations
       WHERE generation_id=?
    `).get(generation.generation_id)).toEqual({
      state: 'released', held: 1, version: 4, communication_release_id: operationId(11)
    });

    const laterLogId = operationId(12);
    target.sqlite.exec('BEGIN IMMEDIATE;');
    seedOperation(target, laterLogId);
    const laterSession = {
      ...session(), title: 'Practical systems — updated', version: 2,
      updatedAt: '2026-08-18T03:00:00.000Z'
    };
    repository.appendFact(fact(laterLogId, 0, {
      kind: 'session_changed', version: 1, data: { sessionId: S, session: laterSession }
    }));
    target.sqlite.exec('COMMIT;');
    repository.projectNextBatch({ workspaceId: W, eventId: E });
    expect(target.sqlite.query<{ state: string; generation_number: number }, []>(`
      SELECT state,generation_number FROM calendar_notice_generations ORDER BY generation_number
    `).all()).toEqual([
      { state: 'released', generation_number: 1 }, { state: 'open', generation_number: 2 }
    ]);
  });

  test('pins indexed access paths for all calendar state capabilities', () => {
    const target = runtime();
    const detail = (sql: string) => target.sqlite.query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN ${sql}`
    ).all().map((row) => row.detail).join('\n');
    expect(detail(`SELECT * FROM calendar_commitment_facts
      WHERE workspace_id='${W}' AND event_id='${E}' AND intake_position>0 ORDER BY intake_position LIMIT 100`))
      .toContain('calendar_commitment_facts_pending');
    expect(detail(`SELECT * FROM calendar_commitment_source_heads INDEXED BY calendar_commitment_source_heads_session
      WHERE workspace_id='${W}' AND event_id='${E}' AND session_id='${S}'`))
      .toContain('calendar_commitment_source_heads_session');
    expect(detail(`SELECT * FROM calendar_commitments
      WHERE workspace_id='${W}' AND event_id='${E}' AND person_id='${P}' ORDER BY start_at_ms,commitment_id`))
      .toContain('calendar_commitments_person_calendar');
    expect(detail(`SELECT * FROM calendar_notice_generations
      WHERE workspace_id='${W}' AND event_id='${E}' AND state='open' AND held=0 AND seal_at_ms<=0
      ORDER BY seal_at_ms,generation_id`)).toContain('calendar_notice_generations_due');
    expect(detail(`SELECT * FROM calendar_feeds
      WHERE workspace_id='${W}' AND lookup_profile='calendar.feed-token'
        AND lookup_version=1 AND lookup_keyed_sha256='${'7'.repeat(64)}'`)).toContain('SEARCH calendar_feeds');
  });
});
