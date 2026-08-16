import type { Database } from 'bun:sqlite';
import {
  applyProgramVocabularyPlan,
  applyProgramReferenceRepoints,
  captureRegisteredProgramReferences,
  mergeReferenceCounts,
  parseProgramVocabularyMutationPlan,
  parseProgramVocabularyState,
  validateProgramVocabularyPlan,
  type ProgramReferenceContributionPlan,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorRegistry,
  type ProgramReferenceSnapshotSource,
  type PlannedProgramVocabularyItem,
  type ProgramVocabularyMutationPlan,
  type ProgramVocabularyPlanningErrorCode,
  type ProgramVocabularyReadPort,
  type ProgramVocabularyState,
  type ProgramVocabularyTransactionPort,
  ProgramVocabularyPlanningError
} from '@jooevents/program';
import {
  programVocabularyScopeSchema,
  type ProgramVocabularyChangeResult,
  type ProgramVocabularyKind,
  type ProgramVocabularyScopeDto
} from '@jooevents/contracts';
import {
  parseInstant,
  parseUserId,
  canonicalJsonText,
  type Instant,
  type UserId
} from '@jooevents/kernel';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const PROGRAM_VOCABULARY_SQL = `
CREATE TABLE program_vocabulary_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  set_version INTEGER NOT NULL CHECK(set_version >= 2),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_rooms (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  capacity INTEGER CHECK(capacity IS NULL OR capacity > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_tracks (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE program_vocabulary_formats (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  created_by_user_id TEXT NOT NULL CHECK(length(created_by_user_id) = 36),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX program_vocabulary_rooms_read
  ON program_vocabulary_rooms(workspace_id, event_id, id);
CREATE INDEX program_vocabulary_tracks_read
  ON program_vocabulary_tracks(workspace_id, event_id, id);
CREATE INDEX program_vocabulary_formats_read
  ON program_vocabulary_formats(workspace_id, event_id, id);

CREATE TRIGGER program_vocabulary_sets_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON program_vocabulary_sets
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary scope is immutable');
END;

CREATE TRIGGER program_vocabulary_sets_attribution_guard
BEFORE UPDATE ON program_vocabulary_sets
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_rooms_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_rooms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary identity is immutable');
END;

CREATE TRIGGER program_vocabulary_rooms_attribution_guard
BEFORE UPDATE ON program_vocabulary_rooms
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_tracks_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_tracks
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary identity is immutable');
END;

CREATE TRIGGER program_vocabulary_tracks_attribution_guard
BEFORE UPDATE ON program_vocabulary_tracks
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_formats_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_formats
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary identity is immutable');
END;

CREATE TRIGGER program_vocabulary_formats_attribution_guard
BEFORE UPDATE ON program_vocabulary_formats
WHEN NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at_ms != OLD.created_at_ms
  OR NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary attribution is invalid');
END;

CREATE TRIGGER program_vocabulary_rooms_distinct_id_insert
BEFORE INSERT ON program_vocabulary_rooms
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_tracks_distinct_id_insert
BEFORE INSERT ON program_vocabulary_tracks
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_formats_distinct_id_insert
BEFORE INSERT ON program_vocabulary_formats
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_rooms_distinct_id_update
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_rooms
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_tracks_distinct_id_update
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_tracks
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_formats_distinct_id_update
BEFORE UPDATE OF workspace_id, event_id, id ON program_vocabulary_formats
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;
`;

const READ_EVENT_ROOT_SQL = `
  SELECT workspace_id, event_id
    FROM event_spine_scope_roots
   WHERE workspace_id = ? AND event_id = ?
   ORDER BY workspace_id, event_id
   LIMIT 2
`;

const READ_SET_SQL = `
  SELECT set_version
    FROM program_vocabulary_sets
   WHERE workspace_id = ? AND event_id = ?
   ORDER BY workspace_id, event_id
   LIMIT 2
`;

const READ_ROOMS_SQL = `
  SELECT id, name, capacity, status, version
    FROM program_vocabulary_rooms
   WHERE workspace_id = ? AND event_id = ?
   ORDER BY id COLLATE BINARY
`;

const READ_TRACKS_SQL = `
  SELECT id, name, status, version
    FROM program_vocabulary_tracks
   WHERE workspace_id = ? AND event_id = ?
   ORDER BY id COLLATE BINARY
`;

const READ_FORMATS_SQL = `
  SELECT id, name, status, version
    FROM program_vocabulary_formats
   WHERE workspace_id = ? AND event_id = ?
   ORDER BY id COLLATE BINARY
`;

type SQLiteValue = string | number | bigint | Uint8Array | null;

interface SetRow { readonly set_version: SQLiteValue }
interface EventRootRow { readonly workspace_id: SQLiteValue; readonly event_id: SQLiteValue }
interface NamedItemRow {
  readonly id: SQLiteValue;
  readonly name: SQLiteValue;
  readonly status: SQLiteValue;
  readonly version: SQLiteValue;
}
interface RoomRow extends NamedItemRow { readonly capacity: SQLiteValue }

export type SQLiteProgramVocabularyContributorResolution =
  | { readonly kind: 'available'; readonly snapshot: unknown }
  | { readonly kind: 'missing' };

export interface SQLiteProgramVocabularyContributorAdapter {
  readonly contributor: ProgramReferenceContributorRef;
  /** Must synchronously read only from the supplied current SQLite handle. */
  read(input: {
    readonly sqlite: Database;
    readonly scope: ProgramVocabularyState['scope'];
  }): SQLiteProgramVocabularyContributorResolution;
  /** Must synchronously apply only this exact contributor's frozen repoints. */
  applyRepoints(input: {
    readonly sqlite: Database;
    readonly scope: ProgramVocabularyState['scope'];
    readonly contribution: ProgramReferenceContributionPlan;
    readonly attribution: ProgramVocabularyMutationAttribution;
  }): void;
}

export interface SQLiteProgramVocabularyContributorAdapterRegistry {
  readonly adapters: readonly SQLiteProgramVocabularyContributorAdapter[];
  readonly source: ProgramReferenceSnapshotSource;
  applyRepoints(input: {
    readonly scope: ProgramVocabularyState['scope'];
    readonly contributions: readonly ProgramReferenceContributionPlan[];
    readonly attribution: ProgramVocabularyMutationAttribution;
  }): void;
}

const sealedContributorRegistries = new WeakMap<
  SQLiteProgramVocabularyContributorAdapterRegistry,
  Database
>();

export interface ProgramVocabularyMutationAttribution {
  readonly actorUserId: UserId;
  readonly occurredAt: Instant;
}

export class SQLiteProgramVocabularyError extends Error {
  constructor(readonly code:
    | 'transaction_required'
    | 'event_scope_corrupt'
    | 'program_vocabulary_data_corrupt'
    | 'contributor_registry_invalid'
    | 'contributor_missing'
    | 'contributor_failed'
  , cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteProgramVocabularyError';
  }
}

function parsePositiveInteger(value: SQLiteValue, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SQLiteProgramVocabularyError('program_vocabulary_data_corrupt', new TypeError(field));
  }
  return value;
}

function parseText(value: SQLiteValue, field: string): string {
  if (typeof value !== 'string') {
    throw new SQLiteProgramVocabularyError('program_vocabulary_data_corrupt', new TypeError(field));
  }
  return value;
}

function oneOrNone<Row>(rows: readonly Row[], code: SQLiteProgramVocabularyError['code']): Row | undefined {
  if (rows.length > 1) throw new SQLiteProgramVocabularyError(code);
  return rows[0];
}

function contributorIdentity(value: ProgramReferenceContributorRef): string {
  return `${value.key}\u0000${value.version}`;
}

function parseContributor(value: ProgramReferenceContributorRef): ProgramReferenceContributorRef {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value.key)
      || !Number.isSafeInteger(value.version)
      || value.version <= 0) {
    throw new SQLiteProgramVocabularyError('contributor_registry_invalid');
  }
  return Object.freeze({ key: value.key, version: value.version });
}

/** Seals exact authenticated contributor adapters over one caller-owned SQLite handle. */
export function createSQLiteProgramVocabularyContributorAdapterRegistry(input: {
  readonly sqlite: Database;
  readonly expected: readonly ProgramReferenceContributorRef[];
  readonly adapters: readonly SQLiteProgramVocabularyContributorAdapter[];
}): SQLiteProgramVocabularyContributorAdapterRegistry {
  const expected = new Map(input.expected.map((raw) => {
    const parsed = parseContributor(raw);
    return [parsed.key, parsed] as const;
  }));
  if (expected.size !== input.expected.length) {
    throw new SQLiteProgramVocabularyError('contributor_registry_invalid');
  }
  const byKey = new Map<string, SQLiteProgramVocabularyContributorAdapter>();
  for (const candidate of input.adapters) {
    const contributor = parseContributor(candidate.contributor);
    const expectedContributor = expected.get(contributor.key);
    if (!expectedContributor
        || expectedContributor.version !== contributor.version
        || byKey.has(contributor.key)) {
      throw new SQLiteProgramVocabularyError('contributor_registry_invalid');
    }
    if (candidate.read.constructor.name === 'AsyncFunction'
        || candidate.applyRepoints.constructor.name === 'AsyncFunction') {
      throw new SQLiteProgramVocabularyError('contributor_registry_invalid');
    }
    byKey.set(contributor.key, Object.freeze({
      contributor,
      read: candidate.read.bind(candidate),
      applyRepoints: candidate.applyRepoints.bind(candidate)
    }));
  }
  if (byKey.size !== expected.size) {
    throw new SQLiteProgramVocabularyError('contributor_registry_invalid');
  }
  const adapters = Object.freeze([...byKey.values()].sort((left, right) => {
    const leftIdentity = contributorIdentity(left.contributor);
    const rightIdentity = contributorIdentity(right.contributor);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  }));
  const source: ProgramReferenceSnapshotSource = Object.freeze({
    readContributor(
      contributor: ProgramReferenceContributorRef,
      scope: ProgramVocabularyState['scope']
    ): unknown {
      const adapter = byKey.get(contributor.key);
      if (!adapter || adapter.contributor.version !== contributor.version) return undefined;
      let resolution: SQLiteProgramVocabularyContributorResolution;
      try {
        resolution = adapter.read({ sqlite: input.sqlite, scope });
      } catch (error) {
        throw new SQLiteProgramVocabularyError('contributor_failed', error);
      }
      if ((resolution as unknown) instanceof Promise) {
        throw new SQLiteProgramVocabularyError('contributor_failed');
      }
      if (resolution.kind === 'missing') return undefined;
      if (resolution.kind !== 'available') {
        throw new SQLiteProgramVocabularyError('contributor_failed');
      }
      return resolution.snapshot;
    }
  });
  const registry: SQLiteProgramVocabularyContributorAdapterRegistry = Object.freeze({
    adapters,
    source,
    applyRepoints({ scope, contributions, attribution }: {
      readonly scope: ProgramVocabularyState['scope'];
      readonly contributions: readonly ProgramReferenceContributionPlan[];
      readonly attribution: ProgramVocabularyMutationAttribution;
    }): void {
      if (!input.sqlite.inTransaction) {
        throw new SQLiteProgramVocabularyError('transaction_required');
      }
      const contributionByKey = new Map<string, ProgramReferenceContributionPlan>(
        contributions.map((contribution): readonly [string, ProgramReferenceContributionPlan] => [
        contributorIdentity(contribution.contributor), contribution
        ])
      );
      if (contributionByKey.size !== contributions.length
          || contributionByKey.size !== adapters.length) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
      for (const adapter of adapters) {
        const contribution = contributionByKey.get(contributorIdentity(adapter.contributor));
        if (!contribution) throw new ProgramVocabularyPlanningError('stale_reference');
        try {
          const result: unknown = adapter.applyRepoints({
            sqlite: input.sqlite,
            scope,
            contribution,
            attribution
          });
          if (result instanceof Promise) throw new SQLiteProgramVocabularyError('contributor_failed');
        } catch (error) {
          if (error instanceof ProgramVocabularyPlanningError
              || error instanceof SQLiteProgramVocabularyError) throw error;
          throw new SQLiteProgramVocabularyError('contributor_failed', error);
        }
      }
    }
  });
  sealedContributorRegistries.set(registry, input.sqlite);
  return registry;
}

export function installProgramVocabularySchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteProgramVocabularyError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(PROGRAM_VOCABULARY_SQL);
}

const itemTables: Readonly<Record<ProgramVocabularyKind, string>> = Object.freeze({
  room: 'program_vocabulary_rooms',
  track: 'program_vocabulary_tracks',
  format: 'program_vocabulary_formats'
});

function changedExactlyOnce(
  result: { readonly changes: number },
  refusal: ProgramVocabularyPlanningErrorCode
): void {
  if (result.changes !== 1) throw new ProgramVocabularyPlanningError(refusal);
}

function affected(plan: ProgramVocabularyMutationPlan): {
  readonly kind: ProgramVocabularyChangeResult['kind'];
  readonly ids: readonly string[];
} {
  if (plan.action === 'create') return { kind: plan.after.kind, ids: [plan.after.id] };
  if (plan.action === 'merge' || plan.action === 'merge_compensation') {
    return { kind: plan.sourceBefore.kind, ids: [plan.sourceBefore.id, plan.target.id] };
  }
  return { kind: plan.before.kind, ids: [plan.before.id] };
}

function sameItem(left: unknown, right: unknown): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function sameReferenceSnapshot(
  left: ReturnType<typeof captureRegisteredProgramReferences>,
  right: ReturnType<typeof captureRegisteredProgramReferences>
): boolean {
  return left.registryDigestSha256 === right.registryDigestSha256
    && canonicalJsonText(left.contributors) === canonicalJsonText(right.contributors);
}

export class SQLiteProgramVocabularyRepository
implements ProgramVocabularyReadPort, ProgramVocabularyTransactionPort {
  constructor(
    private readonly sqlite: Database,
    readonly referenceRegistry: ProgramReferenceContributorRegistry,
    readonly contributors: SQLiteProgramVocabularyContributorAdapterRegistry,
    private readonly attribution: () => ProgramVocabularyMutationAttribution
  ) {
    if (sealedContributorRegistries.get(contributors) !== sqlite) {
      throw new SQLiteProgramVocabularyError('contributor_registry_invalid');
    }
    if (referenceRegistry.contributors.length !== contributors.adapters.length
        || referenceRegistry.contributors.some((contributor, index) => {
          const adapter = contributors.adapters[index];
          return adapter === undefined
            || contributor.key !== adapter.contributor.key
            || contributor.version !== adapter.contributor.version;
        })) {
      throw new SQLiteProgramVocabularyError('contributor_registry_invalid');
    }
  }

  readVocabulary(scopeInput: ProgramVocabularyScopeDto): ProgramVocabularyState | undefined {
    const scope = programVocabularyScopeSchema.parse(scopeInput);
    const eventRoot = oneOrNone(this.sqlite.query<EventRootRow, [string, string]>(
      READ_EVENT_ROOT_SQL
    ).all(scope.workspaceId, scope.eventId), 'event_scope_corrupt');
    if (!eventRoot) return undefined;
    if (eventRoot.workspace_id !== scope.workspaceId || eventRoot.event_id !== scope.eventId) {
      throw new SQLiteProgramVocabularyError('event_scope_corrupt');
    }
    const set = oneOrNone(this.sqlite.query<SetRow, [string, string]>(
      READ_SET_SQL
    ).all(scope.workspaceId, scope.eventId), 'program_vocabulary_data_corrupt');
    if (!set) {
      return parseProgramVocabularyState({
        scope,
        setVersion: 1,
        rooms: [],
        tracks: [],
        formats: []
      });
    }
    try {
      return parseProgramVocabularyState({
        scope,
        setVersion: parsePositiveInteger(set.set_version, 'program_vocabulary_sets.set_version'),
        rooms: this.sqlite.query<RoomRow, [string, string]>(READ_ROOMS_SQL)
          .all(scope.workspaceId, scope.eventId)
          .map((row) => ({
            id: parseText(row.id, 'program_vocabulary_rooms.id'),
            name: parseText(row.name, 'program_vocabulary_rooms.name'),
            capacity: row.capacity === null
              ? null
              : parsePositiveInteger(row.capacity, 'program_vocabulary_rooms.capacity'),
            status: parseText(row.status, 'program_vocabulary_rooms.status'),
            version: parsePositiveInteger(row.version, 'program_vocabulary_rooms.version')
          })),
        tracks: this.sqlite.query<NamedItemRow, [string, string]>(READ_TRACKS_SQL)
          .all(scope.workspaceId, scope.eventId)
          .map((row) => ({
            id: parseText(row.id, 'program_vocabulary_tracks.id'),
            name: parseText(row.name, 'program_vocabulary_tracks.name'),
            status: parseText(row.status, 'program_vocabulary_tracks.status'),
            version: parsePositiveInteger(row.version, 'program_vocabulary_tracks.version')
          })),
        formats: this.sqlite.query<NamedItemRow, [string, string]>(READ_FORMATS_SQL)
          .all(scope.workspaceId, scope.eventId)
          .map((row) => ({
            id: parseText(row.id, 'program_vocabulary_formats.id'),
            name: parseText(row.name, 'program_vocabulary_formats.name'),
            status: parseText(row.status, 'program_vocabulary_formats.status'),
            version: parsePositiveInteger(row.version, 'program_vocabulary_formats.version')
          }))
      });
    } catch (error) {
      if (error instanceof SQLiteProgramVocabularyError) throw error;
      throw new SQLiteProgramVocabularyError('program_vocabulary_data_corrupt', error);
    }
  }

  readContributor(
    contributor: ProgramReferenceContributorRef,
    scope: ProgramVocabularyState['scope']
  ): unknown {
    return this.contributors.source.readContributor(contributor, scope);
  }

  applyVocabularyPlan(planInput: ProgramVocabularyMutationPlan): ProgramVocabularyChangeResult {
    if (!this.sqlite.inTransaction) throw new SQLiteProgramVocabularyError('transaction_required');
    const plan = parseProgramVocabularyMutationPlan(planInput);
    const state = this.readVocabulary(plan.scope);
    if (!state) throw new ProgramVocabularyPlanningError('wrong_scope');
    const refusal = validateProgramVocabularyPlan(
      state,
      plan,
      this.referenceRegistry,
      this
    );
    if (refusal) throw new ProgramVocabularyPlanningError(refusal);
    const nextState = applyProgramVocabularyPlan(state, plan);
    const attribution = this.currentAttribution();

    if (plan.expectedSetVersion === 1) {
      changedExactlyOnce(this.sqlite.query<never, [
        string, string, number, string, number, string, number,
        string, string, string, string
      ]>(`
        INSERT INTO program_vocabulary_sets (
          workspace_id, event_id, set_version, created_by_user_id,
          created_at_ms, updated_by_user_id, updated_at_ms
        ) SELECT ?, ?, ?, ?, ?, ?, ?
          FROM event_spine_scope_roots
         WHERE workspace_id = ? AND event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM program_vocabulary_sets
              WHERE workspace_id = ? AND event_id = ?
           )
      `).run(
        plan.scope.workspaceId,
        plan.scope.eventId,
        nextState.setVersion,
        attribution.actorUserId,
        attribution.occurredAtMs,
        attribution.actorUserId,
        attribution.occurredAtMs,
        plan.scope.workspaceId,
        plan.scope.eventId,
        plan.scope.workspaceId,
        plan.scope.eventId
      ), 'stale_set');
    }

    if (plan.action === 'create') this.insertItem(plan.after, plan.scope, attribution);
    else if (plan.action === 'delete') this.deleteItem(plan.before, plan.scope);
    else if (plan.action === 'merge' || plan.action === 'merge_compensation') {
      if (!sameItem(plan.sourceBefore, plan.sourceAfter)) {
        this.updateItem(plan.sourceBefore, plan.sourceAfter, plan.scope, attribution);
      }
      const beforeReferences = captureRegisteredProgramReferences({
        scope: state.scope,
        registry: this.referenceRegistry,
        source: this
      });
      const expectedReferences = applyProgramReferenceRepoints(beforeReferences, plan);
      this.contributors.applyRepoints({
        scope: state.scope,
        contributions: plan.references,
        attribution
      });
      const afterReferences = captureRegisteredProgramReferences({
        scope: state.scope,
        registry: this.referenceRegistry,
        source: this
      });
      if (!sameReferenceSnapshot(afterReferences, expectedReferences)) {
        throw new ProgramVocabularyPlanningError('stale_reference');
      }
    } else {
      this.updateItem(plan.before, plan.after, plan.scope, attribution);
    }

    if (plan.expectedSetVersion !== 1) {
      changedExactlyOnce(this.sqlite.query<never, [number, string, number, string, string, number]>(`
        UPDATE program_vocabulary_sets
           SET set_version = ?, updated_by_user_id = ?, updated_at_ms = ?
         WHERE workspace_id = ? AND event_id = ? AND set_version = ?
      `).run(
        nextState.setVersion,
        attribution.actorUserId,
        attribution.occurredAtMs,
        plan.scope.workspaceId,
        plan.scope.eventId,
        plan.expectedSetVersion
      ), 'stale_set');
    }

    const subject = affected(plan);
    return Object.freeze({
      action: plan.action,
      kind: subject.kind,
      affectedIds: [...subject.ids],
      setVersion: nextState.setVersion,
      liveRepoints: plan.action === 'merge' || plan.action === 'merge_compensation'
        ? mergeReferenceCounts(plan).liveRepoints
        : 0
    });
  }

  private currentAttribution(): {
    readonly actorUserId: UserId;
    readonly occurredAt: Instant;
    readonly occurredAtMs: number;
  } {
    const raw = this.attribution();
    if (raw instanceof Promise) throw new SQLiteProgramVocabularyError('program_vocabulary_data_corrupt');
    const actorUserId = parseUserId(raw.actorUserId);
    const occurredAt = parseInstant(raw.occurredAt);
    return Object.freeze({ actorUserId, occurredAt, occurredAtMs: Date.parse(occurredAt) });
  }

  private insertItem(
    item: PlannedProgramVocabularyItem,
    scope: ProgramVocabularyScopeDto,
    attribution: ReturnType<SQLiteProgramVocabularyRepository['currentAttribution']>
  ): void {
    if (item.kind === 'room') {
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, number | null, string, number, string, number, string, number]>(`
        INSERT INTO program_vocabulary_rooms (
          workspace_id, event_id, id, name, capacity, status, version,
          created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.workspaceId, scope.eventId, item.id, item.name, item.capacity,
        item.status, item.version, attribution.actorUserId, attribution.occurredAtMs,
        attribution.actorUserId, attribution.occurredAtMs
      ), 'item_exists');
      return;
    }
    const table = itemTables[item.kind];
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string, number, string, number, string, number]>(`
      INSERT INTO ${table} (
        workspace_id, event_id, id, name, status, version,
        created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.workspaceId, scope.eventId, item.id, item.name, item.status, item.version,
      attribution.actorUserId, attribution.occurredAtMs,
      attribution.actorUserId, attribution.occurredAtMs
    ), 'item_exists');
  }

  private updateItem(
    before: PlannedProgramVocabularyItem,
    after: PlannedProgramVocabularyItem,
    scope: ProgramVocabularyScopeDto,
    attribution: ReturnType<SQLiteProgramVocabularyRepository['currentAttribution']>
  ): void {
    if (before.kind !== after.kind || before.id !== after.id) {
      throw new ProgramVocabularyPlanningError('stale_item');
    }
    if (before.kind === 'room' && after.kind === 'room') {
      changedExactlyOnce(this.sqlite.query<never, [string, number | null, string, number, string, number, string, string, string, number, string, string, number | null]>(`
        UPDATE program_vocabulary_rooms
           SET name = ?, capacity = ?, status = ?, version = ?,
               updated_by_user_id = ?, updated_at_ms = ?
         WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
           AND name = ? AND status = ? AND capacity IS ?
      `).run(
        after.name, after.capacity, after.status, after.version,
        attribution.actorUserId, attribution.occurredAtMs,
        scope.workspaceId, scope.eventId, before.id, before.version,
        before.name, before.status, before.capacity
      ), 'stale_item');
      return;
    }
    const table = itemTables[before.kind];
    changedExactlyOnce(this.sqlite.query<never, [string, string, number, string, number, string, string, string, number, string, string]>(`
      UPDATE ${table}
         SET name = ?, status = ?, version = ?,
             updated_by_user_id = ?, updated_at_ms = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
         AND name = ? AND status = ?
    `).run(
      after.name, after.status, after.version,
      attribution.actorUserId, attribution.occurredAtMs,
      scope.workspaceId, scope.eventId, before.id, before.version,
      before.name, before.status
    ), 'stale_item');
  }

  private deleteItem(item: PlannedProgramVocabularyItem, scope: ProgramVocabularyScopeDto): void {
    const table = itemTables[item.kind];
    if (item.kind === 'room') {
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, number, string, string, number | null]>(`
        DELETE FROM ${table}
         WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
           AND name = ? AND status = ? AND capacity IS ?
      `).run(
        scope.workspaceId, scope.eventId, item.id, item.version,
        item.name, item.status, item.capacity
      ), 'stale_item');
      return;
    }
    changedExactlyOnce(this.sqlite.query<never, [string, string, string, number, string, string]>(`
      DELETE FROM ${table}
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
         AND name = ? AND status = ?
    `).run(
      scope.workspaceId, scope.eventId, item.id, item.version,
      item.name, item.status
    ), 'stale_item');
  }
}
