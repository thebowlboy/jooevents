import type { Database } from 'bun:sqlite';
import {
  canonicalJsonText,
  encodeCanonicalJson,
  parseAggregateVersion,
  parseInstant,
  parseUserId,
  type Instant,
  type UserId
} from '@jooevents/kernel';
import {
  ProgramVocabularyPlanningError,
  type ProgramReferenceContributionPlan,
  type ProgramReferenceContributorSnapshot,
  type ProgramVocabularyState
} from '@jooevents/program';
import type {
  SchedulePlacementPlanDto,
  SchedulePlacementResult
} from '@jooevents/contracts';
import type {
  SQLiteProgramVocabularyContributorAdapter,
  SQLiteProgramVocabularyContributorResolution,
  SQLiteProgramVocabularyRepository
} from './program-vocabulary';
import {
  applySchedulePlacementPlan,
  compareScheduleOccurrences,
  parseScheduleOccurrenceId,
  parseSchedulePlacementOccurrence,
  parseSchedulePlacementScope,
  parseSchedulePlacementState,
  parseScheduleSessionId,
  projectSchedulePlacementOccurrence,
  resolvePlaceableSession,
  type PlaceableSessionIdentity,
  type PlaceableSessionIdentityPort,
  type ProgrammedSessionIdentity,
  type SchedulePlacementScope,
  type SchedulePlacementState,
  type SchedulePlacementTransactionRepository
} from '@jooevents/schedule';
import { createHash } from 'node:crypto';

export const SCHEDULE_PLACEMENT_SQL = `
CREATE TABLE schedule_placement_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  schedule_version INTEGER NOT NULL CHECK(schedule_version >= 2),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE schedule_occurrences (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  room_id TEXT NOT NULL CHECK(length(room_id) = 36),
  start_at_ms INTEGER NOT NULL CHECK(start_at_ms BETWEEN 0 AND 8640000000000000),
  end_at_ms INTEGER NOT NULL CHECK(end_at_ms BETWEEN 0 AND 8640000000000000),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  CHECK(start_at_ms < end_at_ms),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES schedule_placement_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, room_id)
    REFERENCES program_vocabulary_rooms(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX schedule_occurrences_range
  ON schedule_occurrences(workspace_id, event_id, start_at_ms, end_at_ms, id);
CREATE INDEX schedule_occurrences_room_overlap
  ON schedule_occurrences(workspace_id, event_id, room_id, start_at_ms, end_at_ms, id);

CREATE TRIGGER schedule_placement_sets_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON schedule_placement_sets
BEGIN
  SELECT RAISE(ABORT, 'schedule scope is immutable');
END;

CREATE TRIGGER schedule_occurrences_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id, session_id ON schedule_occurrences
BEGIN
  SELECT RAISE(ABORT, 'schedule occurrence identity is immutable');
END;
`;

export const SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR = Object.freeze({
  key: 'schedule.occurrences',
  version: 1
});

export interface SchedulePlacementMutationAttribution {
  readonly actorUserId: UserId;
  readonly occurredAt: Instant;
}

export class SQLiteSchedulePlacementError extends Error {
  constructor(readonly code:
    | 'transaction_required'
    | 'scope_corrupt'
    | 'data_corrupt'
    | 'stale_schedule'
    | 'stale_occurrence'
    | 'stale_reference'
  , cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteSchedulePlacementError';
  }
}

interface SetRow { readonly schedule_version: number }
interface EventRootRow { readonly event_id: string }
interface OccurrenceRow {
  readonly id: string;
  readonly session_id: string;
  readonly room_id: string;
  readonly start_at_ms: number;
  readonly end_at_ms: number;
  readonly version: number;
}

export function installSchedulePlacementSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteSchedulePlacementError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SCHEDULE_PLACEMENT_SQL);
}

export class SQLiteSchedulePlacementRepository implements SchedulePlacementTransactionRepository {
  constructor(
    private readonly sqlite: Database,
    private readonly sessions: PlaceableSessionIdentityPort,
    private readonly vocabulary: SQLiteProgramVocabularyRepository,
    private readonly attribution: () => SchedulePlacementMutationAttribution
  ) {}

  readSchedule(scopeInput: SchedulePlacementScope): SchedulePlacementState | undefined {
    const scope = parseSchedulePlacementScope(scopeInput);
    const roots = this.sqlite.query<EventRootRow, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (roots.length > 1) throw new SQLiteSchedulePlacementError('scope_corrupt');
    if (roots.length === 0) return undefined;
    const sets = this.sqlite.query<SetRow, [string, string]>(`
      SELECT schedule_version FROM schedule_placement_sets
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (sets.length > 1) throw new SQLiteSchedulePlacementError('data_corrupt');
    const occurrences = this.readOccurrenceRows(scope);
    if (!sets[0] && occurrences.length > 0) throw new SQLiteSchedulePlacementError('data_corrupt');
    return parseSchedulePlacementState({
      schemaVersion: 1,
      scope,
      scheduleVersion: sets[0]?.schedule_version ?? 1,
      occurrences: occurrences.map(parseOccurrenceRow)
    });
  }

  readOccurrenceRange(input: {
    readonly scope: SchedulePlacementScope;
    readonly startAt: Instant;
    readonly endAt: Instant;
    readonly limit: number;
  }): readonly ReturnType<typeof parseSchedulePlacementOccurrence>[] {
    const scope = parseSchedulePlacementScope(input.scope);
    const startAt = parseInstant(input.startAt);
    const endAt = parseInstant(input.endAt);
    if (startAt >= endAt || !Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 2_000) {
      throw new SQLiteSchedulePlacementError('data_corrupt');
    }
    return Object.freeze(this.sqlite.query<OccurrenceRow, [string, string, number, number, number]>(`
      SELECT id, session_id, room_id, start_at_ms, end_at_ms, version
        FROM schedule_occurrences
       WHERE workspace_id = ? AND event_id = ?
         AND start_at_ms < ? AND ? < end_at_ms
       ORDER BY start_at_ms, end_at_ms, id COLLATE BINARY
       LIMIT ?
    `).all(scope.workspaceId, scope.eventId, Date.parse(endAt), Date.parse(startAt), input.limit)
      .map(parseOccurrenceRow));
  }

  readProgrammedSession(
    scope: SchedulePlacementScope,
    sessionId: ReturnType<typeof parseScheduleSessionId>
  ): ProgrammedSessionIdentity | undefined {
    const session = this.readPlaceableSession(scope, sessionId);
    return session?.lifecycle === 'programmed'
      ? Object.freeze({
          scope: session.scope,
          id: session.id,
          lifecycle: 'programmed' as const,
          trackId: session.trackId ?? null
        })
      : undefined;
  }

  readPlaceableSession(
    scope: SchedulePlacementScope,
    sessionId: ReturnType<typeof parseScheduleSessionId>
  ): PlaceableSessionIdentity | undefined {
    return resolvePlaceableSession(
      this.sessions,
      parseSchedulePlacementScope(scope),
      parseScheduleSessionId(sessionId)
    );
  }

  readVocabulary(scope: SchedulePlacementScope) {
    return this.vocabulary.readVocabulary(parseSchedulePlacementScope(scope));
  }

  applyPlacementPlan(plan: SchedulePlacementPlanDto): SchedulePlacementResult {
    if (!this.sqlite.inTransaction) throw new SQLiteSchedulePlacementError('transaction_required');
    const scope = parseSchedulePlacementScope(plan.input.scope);
    const state = this.readSchedule(scope);
    const vocabulary = this.readVocabulary(scope);
    if (!state || !vocabulary) throw new SQLiteSchedulePlacementError('scope_corrupt');
    const applied = applySchedulePlacementPlan({ state, sessions: this, vocabulary, plan });
    const attribution = parseAttribution(this.attribution());

    if (plan.scheduleVersion.before === 1) {
      changedExactlyOnce(this.sqlite.query<never, [string, string, number, string, number, string, string, string, string]>(`
        INSERT INTO schedule_placement_sets (
          workspace_id, event_id, schedule_version, updated_by_user_id, updated_at_ms
        ) SELECT ?, ?, ?, ?, ?
          FROM event_spine_scope_roots
         WHERE workspace_id = ? AND event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM schedule_placement_sets WHERE workspace_id = ? AND event_id = ?
           )
      `).run(
        scope.workspaceId, scope.eventId, plan.scheduleVersion.after,
        attribution.actorUserId, attribution.occurredAtMs,
        scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId
      ), 'stale_schedule');
    }

    if (plan.input.action === 'place') {
      const after = plan.after!;
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string, number, number, number, string, number]>(`
        INSERT INTO schedule_occurrences (
          workspace_id, event_id, id, session_id, room_id,
          start_at_ms, end_at_ms, version, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.workspaceId, scope.eventId, after.id, after.sessionId, after.roomId,
        Date.parse(after.startAt), Date.parse(after.endAt), after.version,
        attribution.actorUserId, attribution.occurredAtMs
      ), 'stale_occurrence');
    } else if (plan.input.action === 'move') {
      const before = plan.before!;
      const after = plan.after!;
      changedExactlyOnce(this.sqlite.query<never, [string, number, number, number, string, number, string, string, string, string, number, number, number]>(`
        UPDATE schedule_occurrences
           SET room_id = ?, start_at_ms = ?, end_at_ms = ?, version = ?,
               updated_by_user_id = ?, updated_at_ms = ?
         WHERE workspace_id = ? AND event_id = ? AND id = ?
           AND room_id = ? AND start_at_ms = ? AND end_at_ms = ? AND version = ?
      `).run(
        after.roomId, Date.parse(after.startAt), Date.parse(after.endAt), after.version,
        attribution.actorUserId, attribution.occurredAtMs,
        scope.workspaceId, scope.eventId, before.id, before.roomId,
        Date.parse(before.startAt), Date.parse(before.endAt), before.version
      ), 'stale_occurrence');
    } else {
      const before = plan.before!;
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, number, number, number]>(`
        DELETE FROM schedule_occurrences
         WHERE workspace_id = ? AND event_id = ? AND id = ?
           AND room_id = ? AND start_at_ms = ? AND end_at_ms = ? AND version = ?
      `).run(
        scope.workspaceId, scope.eventId, before.id, before.roomId,
        Date.parse(before.startAt), Date.parse(before.endAt), before.version
      ), 'stale_occurrence');
    }

    if (plan.scheduleVersion.before !== 1) {
      changedExactlyOnce(this.sqlite.query<never, [number, string, number, string, string, number]>(`
        UPDATE schedule_placement_sets
           SET schedule_version = ?, updated_by_user_id = ?, updated_at_ms = ?
         WHERE workspace_id = ? AND event_id = ? AND schedule_version = ?
      `).run(
        plan.scheduleVersion.after, attribution.actorUserId, attribution.occurredAtMs,
        scope.workspaceId, scope.eventId, plan.scheduleVersion.before
      ), 'stale_schedule');
    }
    if (canonicalJsonText(this.readSchedule(scope)) !== canonicalJsonText(applied.state)) {
      throw new SQLiteSchedulePlacementError('data_corrupt');
    }
    return applied.result;
  }

  private readOccurrenceRows(scope: SchedulePlacementScope): readonly OccurrenceRow[] {
    return this.sqlite.query<OccurrenceRow, [string, string]>(`
      SELECT id, session_id, room_id, start_at_ms, end_at_ms, version
        FROM schedule_occurrences
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY start_at_ms, end_at_ms, id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId);
  }
}

export function createSQLiteScheduleRoomReferenceAdapter(input: {
  readonly sqlite: Database;
  readonly attribution: () => SchedulePlacementMutationAttribution;
}): SQLiteProgramVocabularyContributorAdapter {
  return Object.freeze({
    contributor: SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
    read({ scope }: {
      readonly sqlite: Database;
      readonly scope: ProgramVocabularyState['scope'];
    }): SQLiteProgramVocabularyContributorResolution {
      return readScheduleReferenceSnapshot(input.sqlite, scope);
    },
    applyRepoints({ scope, contribution }: {
      readonly sqlite: Database;
      readonly scope: ProgramVocabularyState['scope'];
      readonly contribution: ProgramReferenceContributionPlan;
    }): void {
      if (!input.sqlite.inTransaction) throw new SQLiteSchedulePlacementError('transaction_required');
      const scheduleScope = parseSchedulePlacementScope(scope);
      if (contribution.contributor.key !== SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR.key
          || contribution.contributor.version !== SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR.version
          || contribution.historicalPins.length !== 0) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      const current = readScheduleReferenceSnapshot(input.sqlite, scope);
      if (current.kind !== 'available') throw new ProgramVocabularyPlanningError('stale_reference');
      const snapshot = current.snapshot as ProgramReferenceContributorSnapshot;
      if (snapshot.guard.id !== contribution.guard.id
          || snapshot.guard.version !== contribution.guard.version
          || snapshot.guard.digest !== contribution.guard.digest) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      const byKey = new Map(snapshot.references.map((reference) => [reference.referenceKey, reference]));
      if (contribution.liveRepoints.length === 0) return;
      const attribution = parseAttribution(input.attribution());
      for (const repoint of contribution.liveRepoints) {
        const currentReference = byKey.get(repoint.referenceKey);
        if (!currentReference || currentReference.mode !== 'current'
            || currentReference.version !== repoint.expectedVersion
            || currentReference.item.kind !== 'room'
            || repoint.from.kind !== 'room' || repoint.to.kind !== 'room'
            || currentReference.item.id !== repoint.from.id
            || currentReference.destination.kind !== 'schedule.occurrence'
            || currentReference.destination.id !== repoint.destination.id) {
          throw new ProgramVocabularyPlanningError('stale_reference');
        }
        changedExactlyOnce(input.sqlite.query<never, [string, number, string, number, string, string, string, string, number, string]>(`
          UPDATE schedule_occurrences
             SET room_id = ?, version = ?, updated_by_user_id = ?, updated_at_ms = ?
           WHERE workspace_id = ? AND event_id = ? AND id = ?
             AND room_id = ? AND version = ? AND id = ?
        `).run(
          repoint.to.id, repoint.expectedVersion + 1,
          attribution.actorUserId, attribution.occurredAtMs,
          scheduleScope.workspaceId, scheduleScope.eventId, repoint.destination.id,
          repoint.from.id, repoint.expectedVersion, repoint.destination.id
        ), 'stale_reference');
      }
      changedExactlyOnce(input.sqlite.query<never, [number, string, number, string, string, number]>(`
        UPDATE schedule_placement_sets
           SET schedule_version = ?, updated_by_user_id = ?, updated_at_ms = ?
         WHERE workspace_id = ? AND event_id = ? AND schedule_version = ?
      `).run(
        contribution.guard.version + 1,
        attribution.actorUserId, attribution.occurredAtMs,
        scheduleScope.workspaceId, scheduleScope.eventId, contribution.guard.version
      ), 'stale_reference');
    }
  });
}

function readScheduleReferenceSnapshot(
  sqlite: Database,
  scope: ProgramVocabularyState['scope']
): SQLiteProgramVocabularyContributorResolution {
  const scheduleScope = parseSchedulePlacementScope(scope);
  const set = sqlite.query<SetRow, [string, string]>(`
    SELECT schedule_version FROM schedule_placement_sets
     WHERE workspace_id = ? AND event_id = ? LIMIT 2
  `).all(scheduleScope.workspaceId, scheduleScope.eventId);
  if (set.length > 1) throw new SQLiteSchedulePlacementError('data_corrupt');
  const rows = sqlite.query<OccurrenceRow, [string, string]>(`
    SELECT id, session_id, room_id, start_at_ms, end_at_ms, version
      FROM schedule_occurrences
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY id COLLATE BINARY
  `).all(scheduleScope.workspaceId, scheduleScope.eventId);
  if (!set[0] && rows.length > 0) throw new SQLiteSchedulePlacementError('data_corrupt');
  const guardVersion = parseAggregateVersion(set[0]?.schedule_version ?? 1);
  const references = rows.map((row) => ({
    referenceKey: referenceKey(row.id),
    version: parseAggregateVersion(row.version),
    item: { kind: 'room' as const, id: row.room_id },
    mode: 'current' as const,
    destination: { kind: 'schedule.occurrence', id: row.id }
  }));
  const contributor = SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR;
  const snapshot: ProgramReferenceContributorSnapshot = {
    contributor,
    scope: scheduleScope,
    guard: {
      id: 'program_reference:schedule.occurrences',
      version: guardVersion,
      digest: referenceDigest(contributor, guardVersion, references)
    },
    references
  };
  return { kind: 'available', snapshot };
}

function parseOccurrenceRow(row: OccurrenceRow) {
  if (!Number.isSafeInteger(row.start_at_ms) || !Number.isSafeInteger(row.end_at_ms)
      || !Number.isSafeInteger(row.version)) throw new SQLiteSchedulePlacementError('data_corrupt');
  return parseSchedulePlacementOccurrence({
    id: parseScheduleOccurrenceId(row.id),
    sessionId: parseScheduleSessionId(row.session_id),
    roomId: row.room_id,
    startAt: new Date(row.start_at_ms).toISOString(),
    endAt: new Date(row.end_at_ms).toISOString(),
    version: row.version
  });
}

function parseAttribution(input: SchedulePlacementMutationAttribution) {
  const actorUserId = parseUserId(input.actorUserId);
  const occurredAt = parseInstant(input.occurredAt);
  return { actorUserId, occurredAt, occurredAtMs: Date.parse(occurredAt) };
}

function changedExactlyOnce(
  result: { readonly changes: number },
  code: SQLiteSchedulePlacementError['code']
): void {
  if (result.changes !== 1) throw new SQLiteSchedulePlacementError(code);
}

function referenceKey(occurrenceId: string): string {
  return `schedule_occurrence:${occurrenceId}:room`;
}

function referenceDigest(
  contributor: typeof SCHEDULE_PLACEMENT_ROOM_CONTRIBUTOR,
  guardVersion: number,
  references: readonly unknown[]
): string {
  return createHash('sha256')
    .update(encodeCanonicalJson({ contributor, guardVersion, references }))
    .digest('hex');
}
