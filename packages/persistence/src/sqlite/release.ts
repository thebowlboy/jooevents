import type { Database } from 'bun:sqlite';
import {
  releaseSurfaceSuccessorPlanSchema,
  schedulePlacementSnapshotSchema,
  type EngagementSnapshotDto,
  type ReleaseMutationPlanDto,
  type ReleaseMutationResultDto,
  type ReleaseScheduleConflictDto,
  type ReleaseScopeDto,
  type ReleaseSurfaceSuccessorPlanDto,
  type SchedulePlacementSnapshotDto,
  type ServedPublicRosterDto,
  type ServedPublicScheduleDto,
  type SessionCatalogDto,
  type SurfaceHeadDto,
  type SurfaceKind
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import { programVocabularySetDigest } from '@jooevents/program';
import {
  overlappingRoomOccurrences,
  projectSchedulePlacementState,
  type SchedulePlacementState
} from '@jooevents/schedule';
import {
  isProgramPlan,
  isStyleSetPlan,
  isSurfacePublishPlan,
  parseProgramRelease,
  parseReleaseMutationPlan,
  parseStyleSetRelease,
  parseSurfaceHead,
  parseSurfaceRelease,
  planReleaseSurfaceSuccessorFrom,
  projectServedPublicRoster,
  projectServedPublicSchedule,
  releaseMutationResultFromPlan,
  releaseSurfaceSuccessorGuardRef,
  validateReleaseMutationPlan,
  validateReleaseSurfaceSuccessorFrom,
  ReleasePlanningError,
  type ProgramRelease,
  type ReleaseChangesetTransactionPort,
  type ReleaseSurfaceSuccessorReadPort,
  type ReleaseSurfaceSuccessorTransactionPort,
  type ReleaseVocabularyEvidence,
  type StyleSetRelease,
  type SurfaceRelease
} from '@jooevents/release';
import type {
  FormSurfaceSuccessorPlanningPort,
  FormSurfaceSuccessorTransactionPort,
  FormSurfaceSuccessorValidationPort
} from '@jooevents/intake';
import type { SQLiteEventSettingsRepository } from './event-settings';
import { SQLiteEngagementRepository } from './engagement';
import type { SQLiteProgramVocabularyRepository } from './program-vocabulary';
import type { SQLiteSessionRepository } from './session';

/**
 * Additive schema installed only in an explicitly disposable SQLite runtime.
 * Every release row is immutable retained evidence: the `*_no_update` /
 * `*_no_delete` retention triggers make UPDATE and DELETE physical refusals,
 * so rollback can only ever be another release or a head-pointer move. The
 * `program_release_names` rows are the audited declassification copy — they
 * carry ONLY what the release's own `nameDeclassifications` record authorized,
 * verified row-for-row by the repository inside the writing transaction.
 */
export const SQLITE_RELEASE_SQL = `
CREATE TABLE program_releases (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number > 0),
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('publish', 'rollback')),
  restored_from_release_id TEXT CHECK(
    restored_from_release_id IS NULL OR length(restored_from_release_id) = 36
  ),
  predecessor_release_id TEXT CHECK(
    predecessor_release_id IS NULL OR length(predecessor_release_id) = 36
  ),
  predecessor_digest_sha256 TEXT CHECK(
    predecessor_digest_sha256 IS NULL OR (
      length(predecessor_digest_sha256) = 64
      AND predecessor_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  release_json TEXT NOT NULL CHECK(json_valid(release_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  released_by_user_id TEXT NOT NULL CHECK(length(released_by_user_id) = 36),
  released_at_ms INTEGER NOT NULL CHECK(released_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, number),
  UNIQUE (workspace_id, event_id, predecessor_release_id),
  CHECK((origin_kind = 'rollback') = (restored_from_release_id IS NOT NULL)),
  CHECK((number = 1) = (predecessor_release_id IS NULL)),
  CHECK((predecessor_release_id IS NULL) = (predecessor_digest_sha256 IS NULL)),
  CHECK(restored_from_release_id IS NULL OR restored_from_release_id <> id),
  CHECK(predecessor_release_id IS NULL OR predecessor_release_id <> id),
  CHECK(json_extract(release_json, '$.id') = id),
  CHECK(json_extract(release_json, '$.number') = number),
  CHECK(json_extract(release_json, '$.origin.kind') = origin_kind),
  CHECK(json_extract(release_json, '$.digestSha256') = digest_sha256),
  CHECK(json_extract(release_json, '$.releasedByUserId') = released_by_user_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, predecessor_release_id)
    REFERENCES program_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, restored_from_release_id)
    REFERENCES program_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (released_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX program_releases_chain
  ON program_releases(workspace_id, event_id, number);

CREATE TABLE program_release_names (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  release_id TEXT NOT NULL CHECK(length(release_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  display_name TEXT NOT NULL CHECK(
    length(display_name) BETWEEN 1 AND 300 AND display_name = trim(display_name)
  ),
  PRIMARY KEY (workspace_id, event_id, release_id, person_id),
  FOREIGN KEY (workspace_id, event_id, release_id)
    REFERENCES program_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE style_set_releases (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  number INTEGER NOT NULL CHECK(number > 0),
  predecessor_release_id TEXT CHECK(
    predecessor_release_id IS NULL OR length(predecessor_release_id) = 36
  ),
  release_json TEXT NOT NULL CHECK(json_valid(release_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  released_by_user_id TEXT NOT NULL CHECK(length(released_by_user_id) = 36),
  released_at_ms INTEGER NOT NULL CHECK(released_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, number),
  CHECK((number = 1) = (predecessor_release_id IS NULL)),
  CHECK(json_extract(release_json, '$.id') = id),
  CHECK(json_extract(release_json, '$.number') = number),
  CHECK(json_extract(release_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, predecessor_release_id)
    REFERENCES style_set_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (released_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE surface_releases (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('schedule', 'speakers', 'apply')),
  number INTEGER NOT NULL CHECK(number > 0),
  predecessor_release_id TEXT CHECK(
    predecessor_release_id IS NULL OR length(predecessor_release_id) = 36
  ),
  style_set_release_id TEXT NOT NULL CHECK(length(style_set_release_id) = 36),
  form_id TEXT CHECK(form_id IS NULL OR length(form_id) = 36),
  form_version_id TEXT CHECK(form_version_id IS NULL OR length(form_version_id) = 36),
  release_json TEXT NOT NULL CHECK(json_valid(release_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  released_by_user_id TEXT NOT NULL CHECK(length(released_by_user_id) = 36),
  released_at_ms INTEGER NOT NULL CHECK(released_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, kind, number),
  CHECK((kind = 'apply') = (form_id IS NOT NULL)),
  CHECK((form_id IS NULL) = (form_version_id IS NULL)),
  CHECK(json_extract(release_json, '$.id') = id),
  CHECK(json_extract(release_json, '$.kind') = kind),
  CHECK(json_extract(release_json, '$.number') = number),
  CHECK(json_extract(release_json, '$.styleSetReleaseId') = style_set_release_id),
  CHECK(json_extract(release_json, '$.formRef.formVersionId') IS form_version_id),
  CHECK(json_extract(release_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, predecessor_release_id)
    REFERENCES surface_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, style_set_release_id)
    REFERENCES style_set_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (released_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE surface_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('schedule', 'speakers', 'apply')),
  active_release_id TEXT NOT NULL CHECK(length(active_release_id) = 36),
  version INTEGER NOT NULL CHECK(version > 0),
  head_json TEXT NOT NULL CHECK(json_valid(head_json)),
  updated_by_user_id TEXT NOT NULL CHECK(length(updated_by_user_id) = 36),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (workspace_id, event_id, kind),
  CHECK(json_extract(head_json, '$.kind') = kind),
  CHECK(json_extract(head_json, '$.activeReleaseId') = active_release_id),
  CHECK(json_extract(head_json, '$.version') = version),
  CHECK(json_type(head_json, '$.allowedFrameOrigins') = 'array'),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, event_id, active_release_id)
    REFERENCES surface_releases(workspace_id, event_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER program_releases_no_update
BEFORE UPDATE ON program_releases
BEGIN SELECT RAISE(ABORT, 'program releases are immutable'); END;
CREATE TRIGGER program_releases_no_delete
BEFORE DELETE ON program_releases
BEGIN SELECT RAISE(ABORT, 'program releases are immutable'); END;
CREATE TRIGGER program_release_names_no_update
BEFORE UPDATE ON program_release_names
BEGIN SELECT RAISE(ABORT, 'released names are immutable'); END;
CREATE TRIGGER program_release_names_no_delete
BEFORE DELETE ON program_release_names
BEGIN SELECT RAISE(ABORT, 'released names are immutable'); END;
CREATE TRIGGER program_release_names_authorized_only
BEFORE INSERT ON program_release_names
WHEN NOT EXISTS (
  SELECT 1
    FROM program_releases releases, json_each(releases.release_json, '$.nameDeclassifications') entry
   WHERE releases.workspace_id = NEW.workspace_id
     AND releases.event_id = NEW.event_id
     AND releases.id = NEW.release_id
     AND json_extract(entry.value, '$.personId') = NEW.person_id
     AND json_extract(entry.value, '$.displayName') = NEW.display_name
)
BEGIN SELECT RAISE(ABORT, 'released name copy is not authorized by its release'); END;
CREATE TRIGGER style_set_releases_no_update
BEFORE UPDATE ON style_set_releases
BEGIN SELECT RAISE(ABORT, 'style set releases are immutable'); END;
CREATE TRIGGER style_set_releases_no_delete
BEFORE DELETE ON style_set_releases
BEGIN SELECT RAISE(ABORT, 'style set releases are immutable'); END;
CREATE TRIGGER surface_releases_no_update
BEFORE UPDATE ON surface_releases
BEGIN SELECT RAISE(ABORT, 'surface releases are immutable'); END;
CREATE TRIGGER surface_releases_no_delete
BEFORE DELETE ON surface_releases
BEGIN SELECT RAISE(ABORT, 'surface releases are immutable'); END;
CREATE TRIGGER surface_heads_identity_immutable
BEFORE UPDATE OF workspace_id, event_id, kind ON surface_heads
BEGIN SELECT RAISE(ABORT, 'surface head identity is immutable'); END;
CREATE TRIGGER surface_heads_version_monotonic
BEFORE UPDATE ON surface_heads
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'surface head versions advance by one'); END;
CREATE TRIGGER surface_heads_no_delete
BEFORE DELETE ON surface_heads
BEGIN SELECT RAISE(ABORT, 'surface heads are never deleted'); END;
`;

export type SQLiteReleaseErrorCode =
  | 'transaction_required'
  | 'scope_corrupt'
  | 'data_corrupt'
  | 'stale_release_chain'
  | 'stale_surface_head'
  | 'release_exists'
  | 'name_copy_incoherent';

export class SQLiteReleaseError extends Error {
  constructor(readonly code: SQLiteReleaseErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteReleaseError';
  }
}

export function installReleaseSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteReleaseError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_RELEASE_SQL);
}

/**
 * The governed declassification source: resolves one person's display name
 * (never contact data) for the audited release copy. Composition wires it to
 * the classified intake projection; the release repository never joins the
 * classified store itself.
 */
export interface SQLiteReleaseParticipantNameSource {
  readParticipantDisplayName(scope: ReleaseScopeDto, personId: string): string | undefined;
}

/** Resolves a form's current published version for the submission-surface pin. */
export interface SQLiteReleasePublishedFormVersionSource {
  readCurrentPublishedFormVersionId(scope: ReleaseScopeDto, formId: string): string | undefined;
}

/** SQL-backed pin source over the intake form heads this database already owns. */
export function createSQLiteIntakeFormVersionPinSource(
  sqlite: Database
): SQLiteReleasePublishedFormVersionSource {
  return Object.freeze({
    readCurrentPublishedFormVersionId(scope: ReleaseScopeDto, formId: string) {
      const rows = sqlite.query<{ readonly current_published_version_id: string | null }, [
        string, string, string
      ]>(`
        SELECT current_published_version_id FROM intake_form_heads
         WHERE workspace_id = ? AND event_id = ? AND form_id = ?
         LIMIT 2
      `).all(scope.workspaceId, scope.eventId, formId);
      if (rows.length > 1) throw new SQLiteReleaseError('data_corrupt');
      return rows[0]?.current_published_version_id ?? undefined;
    }
  });
}

export interface SQLiteReleaseUpstreamSources {
  readonly sessions: Pick<SQLiteSessionRepository, 'readSessionCatalog'>;
  readonly schedule: {
    readSchedule(scope: ReleaseScopeDto): SchedulePlacementState | undefined;
  };
  readonly engagements: Pick<SQLiteEngagementRepository, 'readEngagementSnapshot'>;
  readonly vocabulary: Pick<SQLiteProgramVocabularyRepository, 'readVocabulary'>;
  readonly eventSettings: Pick<SQLiteEventSettingsRepository, 'readEventSettings'>;
  readonly names: SQLiteReleaseParticipantNameSource;
  readonly forms: SQLiteReleasePublishedFormVersionSource;
}

interface ReleaseRow { readonly release_json: string }
interface HeadRow { readonly head_json: string }
interface NameRow { readonly person_id: string; readonly display_name: string }
interface ScopeRow { readonly event_id: string }

/**
 * Canonical release persistence: the release changeset transaction port and
 * the intake-hosted successor collaboration port on one caller-owned handle.
 * Reads serve release content only; the confirmed-and-visible join was
 * enforced at materialization, and every apply revalidates its plan against
 * current state through the release domain before touching a row.
 */
export class SQLiteReleaseRepository
implements ReleaseChangesetTransactionPort, ReleaseSurfaceSuccessorTransactionPort {
  constructor(
    private readonly sqlite: Database,
    private readonly sources: SQLiteReleaseUpstreamSources
  ) {}

  readCurrentProgramRelease(scope: ReleaseScopeDto): ProgramRelease | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<ReleaseRow, [string, string]>(`
      SELECT release_json FROM program_releases
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY number DESC LIMIT 1
    `).get(scope.workspaceId, scope.eventId);
    return row === null ? undefined : this.parseProgramRow(row);
  }

  readProgramRelease(scope: ReleaseScopeDto, releaseId: string): ProgramRelease | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<ReleaseRow, [string, string, string]>(`
      SELECT release_json FROM program_releases
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, releaseId);
    return row === null ? undefined : this.parseProgramRow(row);
  }

  /**
   * The public schedule as served: a named projection over the newest
   * published program release only. Read-only surfaces follow the newest
   * release with no pointer to move, and absence is a typed not-published
   * state — never an empty page. The projection re-verifies the release digest
   * and strips person identifiers; nothing here re-derives from live operator
   * state or joins the classified store.
   */
  readServedSchedule(scope: ReleaseScopeDto): ServedPublicScheduleDto | undefined {
    const release = this.readCurrentProgramRelease(scope);
    return release === undefined ? undefined : projectServedPublicSchedule(release);
  }

  /** The public speakers page as served; same serving rules as the schedule. */
  readServedRoster(scope: ReleaseScopeDto): ServedPublicRosterDto | undefined {
    const release = this.readCurrentProgramRelease(scope);
    return release === undefined ? undefined : projectServedPublicRoster(release);
  }

  readCurrentStyleSetRelease(scope: ReleaseScopeDto): StyleSetRelease | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<ReleaseRow, [string, string]>(`
      SELECT release_json FROM style_set_releases
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY number DESC LIMIT 1
    `).get(scope.workspaceId, scope.eventId);
    return row === null ? undefined : this.parseStyleSetRow(row);
  }

  readStyleSetRelease(scope: ReleaseScopeDto, releaseId: string): StyleSetRelease | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<ReleaseRow, [string, string, string]>(`
      SELECT release_json FROM style_set_releases
       WHERE workspace_id = ? AND event_id = ? AND id = ?
    `).get(scope.workspaceId, scope.eventId, releaseId);
    return row === null ? undefined : this.parseStyleSetRow(row);
  }

  readSurfaceHead(scope: ReleaseScopeDto, kind: SurfaceKind): SurfaceHeadDto | undefined {
    return readSurfaceHeadRow(this.sqlite, scope, kind);
  }

  readSurfaceRelease(scope: ReleaseScopeDto, releaseId: string): SurfaceRelease | undefined {
    return readSurfaceReleaseRow(this.sqlite, scope, releaseId);
  }

  listFormSurfaceHeads(scope: ReleaseScopeDto): readonly SurfaceHeadDto[] {
    return listApplySurfaceHeadRows(this.sqlite, scope);
  }

  readReleaseSessionCatalog(scope: ReleaseScopeDto): SessionCatalogDto | undefined {
    return this.sources.sessions.readSessionCatalog(scope);
  }

  readReleaseSchedule(scope: ReleaseScopeDto): SchedulePlacementSnapshotDto | undefined {
    const state = this.sources.schedule.readSchedule(scope);
    if (!state) return undefined;
    try {
      return schedulePlacementSnapshotSchema.parse(projectSchedulePlacementState(state));
    } catch (error) {
      throw new SQLiteReleaseError('data_corrupt', error);
    }
  }

  readReleaseEngagementSnapshot(scope: ReleaseScopeDto): EngagementSnapshotDto | undefined {
    return this.sources.engagements.readEngagementSnapshot(scope);
  }

  readReleaseVocabulary(scope: ReleaseScopeDto): ReleaseVocabularyEvidence | undefined {
    const state = this.sources.vocabulary.readVocabulary(scope);
    if (!state) return undefined;
    return Object.freeze({
      scope,
      setVersion: state.setVersion,
      setDigestSha256: programVocabularySetDigest(state),
      rooms: Object.freeze(
        [...state.rooms]
          .sort((left, right) => left.id < right.id ? -1 : 1)
          .map((room) => Object.freeze({ id: room.id, name: room.name }))
      )
    });
  }

  readReleaseEventSettingsVersion(scope: ReleaseScopeDto): number | undefined {
    const state = this.sources.eventSettings.readEventSettings(scope);
    return state?.event.id === scope.eventId ? state.event.version : undefined;
  }

  /**
   * Block-severity conflict sweep over the current schedule through the
   * schedule domain's own overlap physics: one entry per room whose
   * occurrences overlap. Any entry refuses `publish_schedule`.
   */
  readReleaseScheduleConflicts(scope: ReleaseScopeDto): readonly ReleaseScheduleConflictDto[] {
    const state = this.sources.schedule.readSchedule(scope);
    if (!state) return Object.freeze([]);
    const overlappingByRoom = new Map<string, Map<string, SchedulePlacementState['occurrences'][number]>>();
    for (const occurrence of state.occurrences) {
      const overlaps = overlappingRoomOccurrences({
        state,
        roomId: occurrence.roomId,
        startAt: occurrence.startAt,
        endAt: occurrence.endAt,
        excludingOccurrenceId: occurrence.id
      });
      if (overlaps.length === 0) continue;
      const room = overlappingByRoom.get(occurrence.roomId) ?? new Map();
      room.set(occurrence.id, occurrence);
      for (const overlap of overlaps) room.set(overlap.id, overlap);
      overlappingByRoom.set(occurrence.roomId, room);
    }
    return Object.freeze([...overlappingByRoom.keys()].sort().map((roomId) => ({
      severity: 'block' as const,
      roomId,
      occurrences: [...overlappingByRoom.get(roomId)!.values()]
        .sort((left, right) =>
          `${left.startAt}:${left.endAt}:${left.id}` < `${right.startAt}:${right.endAt}:${right.id}`
            ? -1 : 1
        )
        .map((occurrence) => ({
          occurrenceId: occurrence.id as string,
          sessionId: occurrence.sessionId as string,
          startAt: occurrence.startAt as string,
          endAt: occurrence.endAt as string
        }))
    })));
  }

  readReleaseParticipantDisplayName(scope: ReleaseScopeDto, personId: string): string | undefined {
    return this.sources.names.readParticipantDisplayName(scope, personId);
  }

  readReleasePublishedFormVersionId(scope: ReleaseScopeDto, formId: string): string | undefined {
    return this.sources.forms.readCurrentPublishedFormVersionId(scope, formId);
  }

  applyReleasePlan(planInput: ReleaseMutationPlanDto): ReleaseMutationResultDto {
    if (!this.sqlite.inTransaction) throw new SQLiteReleaseError('transaction_required');
    const plan = parseReleaseMutationPlan(planInput);
    const refusal = validateReleaseMutationPlan({ plan, port: this });
    if (refusal) throw new ReleasePlanningError(refusal);
    if (isProgramPlan(plan)) {
      this.insertProgramRelease(plan.release);
    } else if (isStyleSetPlan(plan)) {
      this.insertStyleSetRelease(plan.release);
    } else if (isSurfacePublishPlan(plan)) {
      this.insertSurfaceRelease(plan.release);
      this.writeSurfaceHead(plan.headBefore, plan.headAfter);
    } else {
      this.writeSurfaceHead(plan.headBefore, plan.headAfter);
    }
    return releaseMutationResultFromPlan(plan);
  }

  applyReleaseSurfaceSuccessorPlan(
    planInput: ReleaseSurfaceSuccessorPlanDto
  ): readonly SurfaceHeadDto[] {
    return applySurfaceSuccessorPlanRows(this.sqlite, this, planInput);
  }

  private insertProgramRelease(release: ProgramRelease): void {
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, number, string, string | null, string | null, string | null,
      string, string, string, number
    ]>(`
      INSERT INTO program_releases (
        workspace_id, event_id, id, number, origin_kind, restored_from_release_id,
        predecessor_release_id, predecessor_digest_sha256, release_json, digest_sha256,
        released_by_user_id, released_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      release.scope.workspaceId, release.scope.eventId, release.id, release.number,
      release.origin.kind,
      release.origin.kind === 'rollback' ? release.origin.restoredFromReleaseId : null,
      release.predecessor?.releaseId ?? null, release.predecessor?.digestSha256 ?? null,
      canonicalJsonText(release), release.digestSha256,
      release.releasedByUserId, Date.parse(release.releasedAt)
    ), 'release_exists');
    for (const entry of release.nameDeclassifications) {
      changedExactlyOnce(this.sqlite.query<never, [string, string, string, string, string]>(`
        INSERT INTO program_release_names (
          workspace_id, event_id, release_id, person_id, display_name
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        release.scope.workspaceId, release.scope.eventId, release.id,
        entry.personId, entry.displayName
      ), 'name_copy_incoherent');
    }
    // The declassified-name rows carry ONLY what the audited copy authorized:
    // re-read and require row-for-row parity with the release's own record.
    const written = this.sqlite.query<NameRow, [string, string, string]>(`
      SELECT person_id, display_name FROM program_release_names
       WHERE workspace_id = ? AND event_id = ? AND release_id = ?
       ORDER BY person_id COLLATE BINARY
    `).all(release.scope.workspaceId, release.scope.eventId, release.id);
    const parity = written.length === release.nameDeclassifications.length
      && written.every((row, index) =>
        row.person_id === release.nameDeclassifications[index]!.personId
        && row.display_name === release.nameDeclassifications[index]!.displayName);
    if (!parity) throw new SQLiteReleaseError('name_copy_incoherent');
  }

  private insertStyleSetRelease(release: StyleSetRelease): void {
    changedExactlyOnce(this.sqlite.query<never, [
      string, string, string, number, string | null, string, string, string, number
    ]>(`
      INSERT INTO style_set_releases (
        workspace_id, event_id, id, number, predecessor_release_id,
        release_json, digest_sha256, released_by_user_id, released_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      release.scope.workspaceId, release.scope.eventId, release.id, release.number,
      release.predecessor?.releaseId ?? null, canonicalJsonText(release), release.digestSha256,
      release.releasedByUserId, Date.parse(release.releasedAt)
    ), 'release_exists');
  }

  private insertSurfaceRelease(release: SurfaceRelease): void {
    insertSurfaceReleaseRow(this.sqlite, release);
  }

  private writeSurfaceHead(before: SurfaceHeadDto | null, after: SurfaceHeadDto): void {
    writeSurfaceHeadRow(this.sqlite, before, after);
  }

  private parseProgramRow(row: ReleaseRow): ProgramRelease {
    try {
      return parseProgramRelease(JSON.parse(row.release_json));
    } catch (error) {
      throw new SQLiteReleaseError('data_corrupt', error);
    }
  }

  private parseStyleSetRow(row: ReleaseRow): StyleSetRelease {
    try {
      return parseStyleSetRelease(JSON.parse(row.release_json));
    } catch (error) {
      throw new SQLiteReleaseError('data_corrupt', error);
    }
  }

  private scopeExists(scope: ReleaseScopeDto): boolean {
    return releaseScopeExists(this.sqlite, scope);
  }
}

/**
 * Lean release read/write surface for the intake-hosted form-republish
 * successor collaboration: exactly the apply-surface reads the successor seam
 * consumes, without the upstream materialization sources a full repository
 * needs. Shares the repository's row helpers so both write identical bytes.
 */
export class SQLiteReleaseSurfaceSuccessorStore implements ReleaseSurfaceSuccessorReadPort {
  constructor(private readonly sqlite: Database) {}

  readSurfaceHead(scope: ReleaseScopeDto, kind: SurfaceKind): SurfaceHeadDto | undefined {
    return readSurfaceHeadRow(this.sqlite, scope, kind);
  }

  readSurfaceRelease(scope: ReleaseScopeDto, releaseId: string): SurfaceRelease | undefined {
    return readSurfaceReleaseRow(this.sqlite, scope, releaseId);
  }

  listFormSurfaceHeads(scope: ReleaseScopeDto): readonly SurfaceHeadDto[] {
    return listApplySurfaceHeadRows(this.sqlite, scope);
  }

  applyReleaseSurfaceSuccessorPlan(
    planInput: ReleaseSurfaceSuccessorPlanDto
  ): readonly SurfaceHeadDto[] {
    return applySurfaceSuccessorPlanRows(this.sqlite, this, planInput);
  }
}

/**
 * The composed successor collaboration the intake form draft and changeset
 * effect domains host: plans, revalidates, and applies successor apply-surface
 * releases through the release domain's own functions over this database's
 * release tables. Planning also returns the apply-surface-head guard so the
 * hosting changeset fences concurrent surface publishes, absence included.
 */
export function createSQLiteFormSurfaceSuccessorCollaboration(
  sqlite: Database
): FormSurfaceSuccessorPlanningPort
  & FormSurfaceSuccessorValidationPort
  & FormSurfaceSuccessorTransactionPort {
  const store = new SQLiteReleaseSurfaceSuccessorStore(sqlite);
  return Object.freeze({
    planFormSurfaceSuccessors(input: Parameters<
      FormSurfaceSuccessorPlanningPort['planFormSurfaceSuccessors']
    >[0]) {
      const plan = planReleaseSurfaceSuccessorFrom(store, input);
      return Object.freeze({
        plan,
        guardRefs: Object.freeze([releaseSurfaceSuccessorGuardRef(store, plan.input.scope)])
      });
    },
    validateFormSurfaceSuccessors(plan: ReleaseSurfaceSuccessorPlanDto) {
      const validation = validateReleaseSurfaceSuccessorFrom(
        store, releaseSurfaceSuccessorPlanSchema.parse(plan)
      );
      return validation.kind === 'ready'
        ? Object.freeze({ kind: 'ready' as const })
        : Object.freeze({ kind: 'refused' as const });
    },
    applyFormSurfaceSuccessors(plan: ReleaseSurfaceSuccessorPlanDto) {
      return applySurfaceSuccessorPlanRows(sqlite, store, plan);
    }
  });
}

function readSurfaceHeadRow(
  sqlite: Database,
  scope: ReleaseScopeDto,
  kind: SurfaceKind
): SurfaceHeadDto | undefined {
  if (!releaseScopeExists(sqlite, scope)) return undefined;
  const row = sqlite.query<HeadRow, [string, string, string]>(`
    SELECT head_json FROM surface_heads
     WHERE workspace_id = ? AND event_id = ? AND kind = ?
  `).get(scope.workspaceId, scope.eventId, kind);
  if (row === null) return undefined;
  try {
    return parseSurfaceHead(JSON.parse(row.head_json));
  } catch (error) {
    throw new SQLiteReleaseError('data_corrupt', error);
  }
}

function readSurfaceReleaseRow(
  sqlite: Database,
  scope: ReleaseScopeDto,
  releaseId: string
): SurfaceRelease | undefined {
  if (!releaseScopeExists(sqlite, scope)) return undefined;
  const row = sqlite.query<ReleaseRow, [string, string, string]>(`
    SELECT release_json FROM surface_releases
     WHERE workspace_id = ? AND event_id = ? AND id = ?
  `).get(scope.workspaceId, scope.eventId, releaseId);
  if (row === null) return undefined;
  try {
    return parseSurfaceRelease(JSON.parse(row.release_json));
  } catch (error) {
    throw new SQLiteReleaseError('data_corrupt', error);
  }
}

function listApplySurfaceHeadRows(
  sqlite: Database,
  scope: ReleaseScopeDto
): readonly SurfaceHeadDto[] {
  if (!releaseScopeExists(sqlite, scope)) return Object.freeze([]);
  const rows = sqlite.query<HeadRow, [string, string]>(`
    SELECT head_json FROM surface_heads
     WHERE workspace_id = ? AND event_id = ? AND kind = 'apply'
     ORDER BY kind
  `).all(scope.workspaceId, scope.eventId);
  try {
    return Object.freeze(rows.map((row) => parseSurfaceHead(JSON.parse(row.head_json))));
  } catch (error) {
    throw new SQLiteReleaseError('data_corrupt', error);
  }
}

function insertSurfaceReleaseRow(sqlite: Database, release: SurfaceRelease): void {
  changedExactlyOnce(sqlite.query<never, [
    string, string, string, string, number, string | null, string, string | null,
    string | null, string, string, string, number
  ]>(`
    INSERT INTO surface_releases (
      workspace_id, event_id, id, kind, number, predecessor_release_id,
      style_set_release_id, form_id, form_version_id, release_json, digest_sha256,
      released_by_user_id, released_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    release.scope.workspaceId, release.scope.eventId, release.id, release.kind,
    release.number, release.predecessor?.releaseId ?? null, release.styleSetReleaseId,
    release.kind === 'apply' ? release.formRef.formId : null,
    release.kind === 'apply' ? release.formRef.formVersionId : null,
    canonicalJsonText(release), release.digestSha256,
    release.releasedByUserId, Date.parse(release.releasedAt)
  ), 'release_exists');
}

function writeSurfaceHeadRow(
  sqlite: Database,
  before: SurfaceHeadDto | null,
  after: SurfaceHeadDto
): void {
  if (before === null) {
    changedExactlyOnce(sqlite.query<never, [
      string, string, string, string, number, string, string, number, string, string, string
    ]>(`
      INSERT INTO surface_heads (
        workspace_id, event_id, kind, active_release_id, version, head_json,
        updated_by_user_id, updated_at_ms
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM surface_heads WHERE workspace_id = ? AND event_id = ? AND kind = ?
        )
    `).run(
      after.scope.workspaceId, after.scope.eventId, after.kind, after.activeReleaseId,
      after.version, canonicalJsonText(after), after.updatedByUserId,
      Date.parse(after.updatedAt),
      after.scope.workspaceId, after.scope.eventId, after.kind
    ), 'stale_surface_head');
    return;
  }
  changedExactlyOnce(sqlite.query<never, [
    string, number, string, string, number, string, string, string, number, string
  ]>(`
    UPDATE surface_heads
       SET active_release_id = ?, version = ?, head_json = ?,
           updated_by_user_id = ?, updated_at_ms = ?
     WHERE workspace_id = ? AND event_id = ? AND kind = ?
       AND version = ? AND active_release_id = ?
  `).run(
    after.activeReleaseId, after.version, canonicalJsonText(after),
    after.updatedByUserId, Date.parse(after.updatedAt),
    before.scope.workspaceId, before.scope.eventId, before.kind,
    before.version, before.activeReleaseId
  ), 'stale_surface_head');
}

function applySurfaceSuccessorPlanRows(
  sqlite: Database,
  port: ReleaseSurfaceSuccessorReadPort,
  planInput: ReleaseSurfaceSuccessorPlanDto
): readonly SurfaceHeadDto[] {
  if (!sqlite.inTransaction) throw new SQLiteReleaseError('transaction_required');
  const plan = releaseSurfaceSuccessorPlanSchema.parse(planInput);
  const validation = validateReleaseSurfaceSuccessorFrom(port, plan);
  if (validation.kind !== 'ready') throw new ReleasePlanningError(validation.code);
  const heads: SurfaceHeadDto[] = [];
  for (const successor of plan.successors) {
    insertSurfaceReleaseRow(sqlite, parseSurfaceRelease(successor.release));
    writeSurfaceHeadRow(sqlite, successor.headBefore, successor.headAfter);
    heads.push(successor.headAfter);
  }
  return Object.freeze(heads);
}

function releaseScopeExists(sqlite: Database, scope: ReleaseScopeDto): boolean {
  const rows = sqlite.query<ScopeRow, [string, string]>(`
    SELECT event_id FROM event_spine_scope_roots
     WHERE workspace_id = ? AND event_id = ?
     ORDER BY workspace_id, event_id LIMIT 2
  `).all(scope.workspaceId, scope.eventId);
  if (rows.length > 1) throw new SQLiteReleaseError('scope_corrupt');
  return rows.length === 1;
}

function changedExactlyOnce(
  result: { readonly changes: number },
  code: SQLiteReleaseErrorCode
): void {
  if (result.changes !== 1) throw new SQLiteReleaseError(code);
}
