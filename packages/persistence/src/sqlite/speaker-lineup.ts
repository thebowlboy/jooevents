import type { Database } from 'bun:sqlite';
import {
  speakerLineupMutationPlanSchema,
  type SpeakerLineupCategoryDto,
  type SpeakerLineupEntryDto,
  type SpeakerLineupMutationPlanDto,
  type SpeakerLineupSnapshotDto
} from '@jooevents/contracts';
import {
  createSpeakerLineupSnapshot,
  parseSpeakerLineupSnapshot,
  type SpeakerLineupReadPort
} from '@jooevents/engagement';

/** Current-state schema for isolated repository fixtures; production installs it through migration 0009. */
export const SQLITE_SPEAKER_LINEUP_SQL = `
CREATE TABLE speaker_lineup_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE speaker_lineup_categories (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 32 AND name = trim(name)),
  accent TEXT NOT NULL CHECK(accent IN ('lavender', 'sea', 'neutral')),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  position INTEGER NOT NULL CHECK(position >= 0),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, position),
  UNIQUE (workspace_id, event_id, name COLLATE NOCASE),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES speaker_lineup_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE speaker_lineup_entries (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  position INTEGER NOT NULL CHECK(position >= 0),
  category_id TEXT,
  publicly_visible INTEGER NOT NULL CHECK(publicly_visible IN (0, 1)),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, person_id),
  UNIQUE (workspace_id, event_id, position),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES speaker_lineup_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, category_id)
    REFERENCES speaker_lineup_categories(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX speaker_lineup_entries_category
  ON speaker_lineup_entries(workspace_id, event_id, category_id, position, person_id);
CREATE TRIGGER speaker_lineup_sets_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON speaker_lineup_sets
BEGIN SELECT RAISE(ABORT, 'speaker lineup scope is immutable'); END;
CREATE TRIGGER speaker_lineup_sets_version_monotonic
BEFORE UPDATE OF version ON speaker_lineup_sets
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'speaker lineup version must advance once'); END;
CREATE TRIGGER speaker_lineup_categories_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON speaker_lineup_categories
BEGIN SELECT RAISE(ABORT, 'speaker lineup category identity is immutable'); END;
CREATE TRIGGER speaker_lineup_categories_version_monotonic
BEFORE UPDATE OF version ON speaker_lineup_categories
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'speaker lineup category version must advance once'); END;
CREATE TRIGGER speaker_lineup_categories_no_delete
BEFORE DELETE ON speaker_lineup_categories
BEGIN SELECT RAISE(ABORT, 'speaker lineup categories are retained'); END;
CREATE TRIGGER speaker_lineup_entries_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, person_id ON speaker_lineup_entries
BEGIN SELECT RAISE(ABORT, 'speaker lineup entry identity is immutable'); END;
CREATE TRIGGER speaker_lineup_entries_version_monotonic
BEFORE UPDATE OF version ON speaker_lineup_entries
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'speaker lineup entry version must advance once'); END;
CREATE TRIGGER event_spine_scope_roots_create_speaker_lineup
AFTER INSERT ON event_spine_scope_roots
BEGIN
  INSERT INTO speaker_lineup_sets(workspace_id, event_id, version)
  VALUES (NEW.workspace_id, NEW.event_id, 1);
END;
`;

type Scope = SpeakerLineupSnapshotDto['scope'];
interface SetRow { readonly version: number }
interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly accent: SpeakerLineupCategoryDto['accent'];
  readonly status: SpeakerLineupCategoryDto['status'];
  readonly position: number;
  readonly version: number;
}
interface EntryRow {
  readonly person_id: string;
  readonly position: number;
  readonly category_id: string | null;
  readonly publicly_visible: number;
  readonly version: number;
}
interface CountRow { readonly count: number }
interface PositionRow { readonly position: number }

export type SQLiteSpeakerLineupErrorCode =
  | 'transaction_required'
  | 'data_corrupt'
  | 'stale_lineup';

export class SQLiteSpeakerLineupError extends Error {
  constructor(readonly code: SQLiteSpeakerLineupErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteSpeakerLineupError';
  }
}

export function installSpeakerLineupSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteSpeakerLineupError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_SPEAKER_LINEUP_SQL);
}

/** Canonical event/person lineup persistence on the caller-owned SQLite handle. */
export class SQLiteSpeakerLineupRepository implements SpeakerLineupReadPort {
  constructor(private readonly sqlite: Database) {}

  readSpeakerLineupSnapshot(scope: Scope): SpeakerLineupSnapshotDto | undefined {
    const sets = this.sqlite.query<SetRow, [string, string]>(`
      SELECT version FROM speaker_lineup_sets
       WHERE workspace_id = ? AND event_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (sets.length === 0) return undefined;
    if (sets.length !== 1) throw new SQLiteSpeakerLineupError('data_corrupt');
    const categories = this.sqlite.query<CategoryRow, [string, string]>(`
      SELECT id,name,accent,status,position,version
        FROM speaker_lineup_categories
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY position,id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId).map((row) => ({ ...row }));
    const entries = this.sqlite.query<EntryRow, [string, string]>(`
      SELECT person_id,position,category_id,publicly_visible,version
        FROM speaker_lineup_entries
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY position,person_id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId).map((row) => ({
      personId: row.person_id,
      position: row.position,
      categoryId: row.category_id,
      publiclyVisible: row.publicly_visible === 1,
      version: row.version
    }));
    try {
      return createSpeakerLineupSnapshot({
        scope,
        version: sets[0]!.version,
        categories,
        entries
      });
    } catch (error) {
      throw new SQLiteSpeakerLineupError('data_corrupt', error);
    }
  }

  applySpeakerLineupPlan(planInput: SpeakerLineupMutationPlanDto): SpeakerLineupSnapshotDto {
    this.requireTransaction();
    const plan = speakerLineupMutationPlanSchema.parse(planInput);
    const current = this.readSpeakerLineupSnapshot(plan.input.scope);
    if (!current || current.version !== plan.before.version
        || current.digestSha256 !== plan.before.digestSha256) {
      throw new SQLiteSpeakerLineupError('stale_lineup');
    }
    const wire = plan.input.authorInput;
    if (wire.action === 'add_category') {
      const category = plan.after.categories.find((entry) =>
        !plan.before.categories.some((before) => before.id === entry.id));
      if (!category) throw new SQLiteSpeakerLineupError('data_corrupt');
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string, string, number, number]>(`
        INSERT INTO speaker_lineup_categories(
          workspace_id,event_id,id,name,accent,status,position,version
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        plan.input.scope.workspaceId, plan.input.scope.eventId, category.id, category.name,
        category.accent, category.status, category.position, category.version
      ));
    } else if (wire.action === 'reorder') {
      this.applyOrder(plan.input.scope, plan.before.entries, plan.after.entries);
    } else {
      const before = plan.before.entries.find((entry) => entry.personId === wire.personId);
      const after = plan.after.entries.find((entry) => entry.personId === wire.personId);
      if (!before || !after) throw new SQLiteSpeakerLineupError('data_corrupt');
      changedExactlyOnce(this.sqlite.query<never, [number, string | null, number, string, string, string, number, number, string | null, number]>(`
        UPDATE speaker_lineup_entries
           SET publicly_visible = ?, category_id = ?, version = ?
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
           AND position = ? AND publicly_visible = ? AND category_id IS ? AND version = ?
      `).run(
        after.publiclyVisible ? 1 : 0, after.categoryId, after.version,
        plan.input.scope.workspaceId, plan.input.scope.eventId, before.personId,
        before.position, before.publiclyVisible ? 1 : 0, before.categoryId, before.version
      ));
    }
    this.advanceSet(plan.input.scope, plan.before.version, plan.after.version);
    const saved = this.readSpeakerLineupSnapshot(plan.input.scope);
    if (!saved || saved.digestSha256 !== plan.after.digestSha256) {
      throw new SQLiteSpeakerLineupError('data_corrupt');
    }
    return parseSpeakerLineupSnapshot(saved);
  }

  /** Acceptance collaboration: append every missing person once and advance the set once. */
  ensureEntries(scope: Scope, personIds: readonly string[]): void {
    this.requireTransaction();
    const unique = [...new Set(personIds)].sort();
    if (unique.length === 0) return;
    const missing = unique.filter((personId) => !this.entryExists(scope, personId));
    if (missing.length === 0) return;
    const set = this.readSpeakerLineupSnapshot(scope);
    if (!set) throw new SQLiteSpeakerLineupError('data_corrupt');
    let position = set.entries.length;
    for (const personId of missing) {
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, number]>(`
        INSERT INTO speaker_lineup_entries(
          workspace_id,event_id,person_id,position,category_id,publicly_visible,version
        ) VALUES (?,?,?,?,NULL,1,1)
      `).run(scope.workspaceId, scope.eventId, personId, position++));
    }
    this.advanceSet(scope, set.version, set.version + 1);
  }

  /** Acceptance compensation: remove only people with no remaining engagement, then densify. */
  removeOrphanedEntries(scope: Scope, personIds: readonly string[]): void {
    this.requireTransaction();
    const unique = [...new Set(personIds)].sort();
    const removable = unique.filter((personId) => {
      const count = this.sqlite.query<CountRow, [string, string, string]>(`
        SELECT count(*) AS count FROM engagement_heads
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
      `).get(scope.workspaceId, scope.eventId, personId)?.count ?? 0;
      return count === 0 && this.entryExists(scope, personId);
    });
    if (removable.length === 0) return;
    const set = this.readSpeakerLineupSnapshot(scope);
    if (!set) throw new SQLiteSpeakerLineupError('data_corrupt');
    for (const personId of removable) {
      changedExactlyOnce(this.sqlite.query<never, [string, string, string]>(`
        DELETE FROM speaker_lineup_entries
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
      `).run(scope.workspaceId, scope.eventId, personId));
    }
    const remaining = set.entries.filter((entry) => !removable.includes(entry.personId));
    this.rewriteDensePositions(scope, remaining);
    this.advanceSet(scope, set.version, set.version + 1);
  }

  private applyOrder(
    scope: Scope,
    before: readonly SpeakerLineupEntryDto[],
    after: readonly SpeakerLineupEntryDto[]
  ): void {
    const offset = before.length;
    if (offset === 0) return;
    const shifted = this.sqlite.query<never, [number, string, string]>(`
      UPDATE speaker_lineup_entries SET position = position + ?
       WHERE workspace_id = ? AND event_id = ?
    `).run(offset, scope.workspaceId, scope.eventId);
    if (shifted.changes !== before.length) throw new SQLiteSpeakerLineupError('stale_lineup');
    const beforeByPerson = new Map(before.map((entry) => [entry.personId, entry]));
    for (const next of after) {
      const previous = beforeByPerson.get(next.personId);
      if (!previous) throw new SQLiteSpeakerLineupError('data_corrupt');
      if (next.version === previous.version) {
        changedExactlyOnce(this.sqlite.query<never, [number, string, string, string, number, number]>(`
          UPDATE speaker_lineup_entries SET position = ?
           WHERE workspace_id = ? AND event_id = ? AND person_id = ?
             AND position = ? AND version = ?
        `).run(
          next.position, scope.workspaceId, scope.eventId, next.personId,
          previous.position + offset, previous.version
        ));
      } else {
        changedExactlyOnce(this.sqlite.query<never, [number, number, string, string, string, number, number]>(`
          UPDATE speaker_lineup_entries SET position = ?, version = ?
           WHERE workspace_id = ? AND event_id = ? AND person_id = ?
             AND position = ? AND version = ?
        `).run(
          next.position, next.version, scope.workspaceId, scope.eventId, next.personId,
          previous.position + offset, previous.version
        ));
      }
    }
  }

  private rewriteDensePositions(scope: Scope, entries: readonly SpeakerLineupEntryDto[]): void {
    if (entries.length === 0) return;
    const offset = entries.length + 1;
    this.sqlite.query<never, [number, string, string]>(`
      UPDATE speaker_lineup_entries SET position = position + ?
       WHERE workspace_id = ? AND event_id = ?
    `).run(offset, scope.workspaceId, scope.eventId);
    entries.forEach((entry, position) => {
      if (position === entry.position) {
        changedExactlyOnce(this.sqlite.query<never, [number, string, string, string]>(`
          UPDATE speaker_lineup_entries SET position = ?
           WHERE workspace_id = ? AND event_id = ? AND person_id = ?
        `).run(position, scope.workspaceId, scope.eventId, entry.personId));
      } else {
        changedExactlyOnce(this.sqlite.query<never, [number, string, string, string]>(`
          UPDATE speaker_lineup_entries SET position = ?, version = version + 1
           WHERE workspace_id = ? AND event_id = ? AND person_id = ?
        `).run(position, scope.workspaceId, scope.eventId, entry.personId));
      }
    });
  }

  private entryExists(scope: Scope, personId: string): boolean {
    const rows = this.sqlite.query<PositionRow, [string, string, string]>(`
      SELECT position FROM speaker_lineup_entries
       WHERE workspace_id = ? AND event_id = ? AND person_id = ? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, personId);
    if (rows.length > 1) throw new SQLiteSpeakerLineupError('data_corrupt');
    return rows.length === 1;
  }

  private advanceSet(scope: Scope, before: number, after: number): void {
    changedExactlyOnce(this.sqlite.query<never, [number, string, string, number]>(`
      UPDATE speaker_lineup_sets SET version = ?
       WHERE workspace_id = ? AND event_id = ? AND version = ?
    `).run(after, scope.workspaceId, scope.eventId, before));
  }

  private requireTransaction(): void {
    if (!this.sqlite.inTransaction) throw new SQLiteSpeakerLineupError('transaction_required');
  }
}

function changedExactlyOnce(result: { readonly changes: number }): void {
  if (result.changes !== 1) throw new SQLiteSpeakerLineupError('stale_lineup');
}
