import type { Database } from 'bun:sqlite';
import {
  templateArtifactMutationPlanSchema,
  templateArtifactScopeSchema,
  type TemplateArtifactMutationPlanDto,
  type TemplateArtifactScopeDto,
  type TemplateArtifactSnapshotDto
} from '@jooevents/contracts';
import {
  createInitialTemplateArtifact,
  parseTemplateArtifactRevision,
  parseTemplateArtifactSnapshot,
  validateTemplateArtifactMutation,
  type TemplateArtifactTransactionPort
} from '@jooevents/template-authoring';

export const TEMPLATE_AUTHORING_SQL = `
CREATE TABLE template_artifact_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  artifact_id TEXT NOT NULL CHECK(length(artifact_id) = 36),
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('message','surface','theme')),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  current_revision_number INTEGER NOT NULL CHECK(current_revision_number > 0),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY(workspace_id,event_id,artifact_id),
  UNIQUE(workspace_id,event_id,current_revision_id),
  CHECK(version = current_revision_number),
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,current_revision_id)
    REFERENCES template_artifact_revisions(workspace_id,event_id,revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE template_artifact_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  artifact_id TEXT NOT NULL CHECK(length(artifact_id) = 36),
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  predecessor_revision_id TEXT,
  predecessor_digest_sha256 TEXT,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('message','surface','theme')),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,revision_id),
  UNIQUE(workspace_id,event_id,artifact_id,revision_number),
  UNIQUE(workspace_id,event_id,artifact_id,digest_sha256,revision_number),
  CHECK((revision_number = 1) = (predecessor_revision_id IS NULL)),
  CHECK((predecessor_revision_id IS NULL) = (predecessor_digest_sha256 IS NULL)),
  CHECK(json_extract(revision_json, '$.artifactId') = artifact_id),
  CHECK(json_extract(revision_json, '$.revisionId') = revision_id),
  CHECK(json_extract(revision_json, '$.number') = revision_number),
  CHECK(json_extract(revision_json, '$.document.kind') = artifact_kind),
  CHECK(json_extract(revision_json, '$.digestSha256') = digest_sha256),
  FOREIGN KEY(workspace_id,event_id,artifact_id)
    REFERENCES template_artifact_heads(workspace_id,event_id,artifact_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,event_id,predecessor_revision_id)
    REFERENCES template_artifact_revisions(workspace_id,event_id,revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX template_artifact_heads_kind
  ON template_artifact_heads(workspace_id,event_id,artifact_kind,artifact_id);
CREATE INDEX template_artifact_revisions_history
  ON template_artifact_revisions(workspace_id,event_id,artifact_id,revision_number);

CREATE TRIGGER template_artifact_revisions_no_update
BEFORE UPDATE ON template_artifact_revisions
BEGIN SELECT RAISE(ABORT, 'template artifact revisions are immutable'); END;
CREATE TRIGGER template_artifact_revisions_no_delete
BEFORE DELETE ON template_artifact_revisions
BEGIN SELECT RAISE(ABORT, 'template artifact revisions are immutable'); END;
CREATE TRIGGER template_artifact_heads_scope_immutable
BEFORE UPDATE OF workspace_id,event_id,artifact_id,artifact_kind ON template_artifact_heads
BEGIN SELECT RAISE(ABORT, 'template artifact head identity is immutable'); END;
CREATE TRIGGER template_artifact_heads_advance_once
BEFORE UPDATE ON template_artifact_heads
WHEN NEW.version != OLD.version + 1
  OR NEW.current_revision_number != OLD.current_revision_number + 1
BEGIN SELECT RAISE(ABORT, 'template artifact heads advance exactly once'); END;
CREATE TRIGGER template_artifact_heads_no_delete
BEFORE DELETE ON template_artifact_heads
BEGIN SELECT RAISE(ABORT, 'template artifact heads are retained with the event'); END;
`;

export type SQLiteTemplateAuthoringErrorCode =
  | 'transaction_required'
  | 'artifact_conflict'
  | 'artifact_missing'
  | 'stale_revision'
  | 'data_corrupt';

export class SQLiteTemplateAuthoringError extends TypeError {
  constructor(readonly code: SQLiteTemplateAuthoringErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteTemplateAuthoringError';
  }
}

interface HeadRow {
  readonly workspace_id: string;
  readonly event_id: string;
  readonly artifact_id: string;
  readonly artifact_kind: 'message' | 'surface' | 'theme';
  readonly current_revision_id: string;
  readonly current_revision_number: number;
  readonly version: number;
}
interface RevisionRow {
  readonly revision_json: string;
}

function requireTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteTemplateAuthoringError('transaction_required');
}

export function installTemplateAuthoringSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteTemplateAuthoringError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(TEMPLATE_AUTHORING_SQL)).immediate();
}

export interface TemplateArtifactSeed {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly document: Parameters<typeof createInitialTemplateArtifact>[0]['document'];
  readonly note?: string;
}

export class SQLiteTemplateAuthoringRepository implements TemplateArtifactTransactionPort {
  constructor(private readonly sqlite: Database) {}

  private head(scope: TemplateArtifactScopeDto, artifactId: string): HeadRow | undefined {
    const rows = this.sqlite.query<HeadRow, [string, string, string]>(`
      SELECT workspace_id,event_id,artifact_id,artifact_kind,current_revision_id,
             current_revision_number,version
        FROM template_artifact_heads
       WHERE workspace_id=? AND event_id=? AND artifact_id=? LIMIT 2
    `).all(scope.workspaceId, scope.eventId, artifactId);
    if (rows.length > 1) throw new SQLiteTemplateAuthoringError('data_corrupt');
    return rows[0];
  }

  readArtifact(
    scopeInput: TemplateArtifactScopeDto,
    artifactId: string
  ): TemplateArtifactSnapshotDto | undefined {
    const scope = templateArtifactScopeSchema.parse(scopeInput);
    const head = this.head(scope, artifactId);
    if (!head) return undefined;
    const rows = this.sqlite.query<RevisionRow, [string, string, string]>(`
      SELECT revision_json FROM template_artifact_revisions
       WHERE workspace_id=? AND event_id=? AND artifact_id=?
       ORDER BY revision_number
    `).all(scope.workspaceId, scope.eventId, artifactId);
    try {
      const history = rows.map((row) => parseTemplateArtifactRevision(JSON.parse(row.revision_json)));
      const current = history.at(-1);
      if (!current) throw new TypeError('missing_revision');
      return parseTemplateArtifactSnapshot({
        head: {
          schemaVersion: 1,
          scope,
          artifactId: head.artifact_id,
          artifactKind: head.artifact_kind,
          currentRevisionId: head.current_revision_id,
          currentRevisionNumber: head.current_revision_number,
          version: head.version
        },
        current,
        history
      });
    } catch (error) {
      throw new SQLiteTemplateAuthoringError('data_corrupt', error);
    }
  }

  listArtifacts(
    scopeInput: TemplateArtifactScopeDto,
    kind?: 'message' | 'surface' | 'theme'
  ): readonly TemplateArtifactSnapshotDto[] {
    const scope = templateArtifactScopeSchema.parse(scopeInput);
    const rows = kind === undefined
      ? this.sqlite.query<{ artifact_id: string }, [string, string]>(`
          SELECT artifact_id FROM template_artifact_heads
           WHERE workspace_id=? AND event_id=? ORDER BY artifact_kind,artifact_id
        `).all(scope.workspaceId, scope.eventId)
      : this.sqlite.query<{ artifact_id: string }, [string, string, string]>(`
          SELECT artifact_id FROM template_artifact_heads
           WHERE workspace_id=? AND event_id=? AND artifact_kind=? ORDER BY artifact_id
        `).all(scope.workspaceId, scope.eventId, kind);
    return Object.freeze(rows.map((row) => {
      const snapshot = this.readArtifact(scope, row.artifact_id);
      if (!snapshot) throw new SQLiteTemplateAuthoringError('data_corrupt');
      return snapshot;
    }));
  }

  createArtifact(input: {
    readonly scope: TemplateArtifactScopeDto;
    readonly artifactId: string;
    readonly revisionId: string;
    readonly document: Parameters<typeof createInitialTemplateArtifact>[0]['document'];
    readonly createdByUserId: string;
    readonly createdAt: string;
    readonly note: string;
  }): TemplateArtifactSnapshotDto {
    requireTransaction(this.sqlite);
    const scope = templateArtifactScopeSchema.parse(input.scope);
    if (this.head(scope, input.artifactId) !== undefined) {
      throw new SQLiteTemplateAuthoringError('artifact_conflict');
    }
    const snapshot = createInitialTemplateArtifact({
      scope,
      artifactId: input.artifactId,
      revisionId: input.revisionId,
      document: input.document,
      createdByUserId: input.createdByUserId,
      createdAt: input.createdAt,
      note: input.note
    });
    const revision = snapshot.current;
    this.sqlite.query(`
      INSERT INTO template_artifact_heads (
        workspace_id,event_id,artifact_id,artifact_kind,current_revision_id,
        current_revision_number,version
      ) VALUES (?,?,?,?,?,1,1)
    `).run(
      scope.workspaceId, scope.eventId, snapshot.head.artifactId,
      snapshot.head.artifactKind, snapshot.head.currentRevisionId
    );
    this.sqlite.query(`
      INSERT INTO template_artifact_revisions (
        workspace_id,event_id,artifact_id,revision_id,revision_number,
        predecessor_revision_id,predecessor_digest_sha256,artifact_kind,
        revision_json,digest_sha256,created_at_ms
      ) VALUES (?,?,?,?,1,NULL,NULL,?,?,?,?)
    `).run(
      scope.workspaceId, scope.eventId, revision.artifactId, revision.revisionId,
      revision.document.kind, JSON.stringify(revision), revision.digestSha256,
      Date.parse(revision.createdAt)
    );
    return snapshot;
  }

  initializeCreatedEvent(input: {
    readonly scope: TemplateArtifactScopeDto;
    readonly createdByUserId: string;
    readonly createdAt: string;
    readonly artifacts: readonly TemplateArtifactSeed[];
  }): readonly TemplateArtifactSnapshotDto[] {
    requireTransaction(this.sqlite);
    const scope = templateArtifactScopeSchema.parse(input.scope);
    const ids = new Set(input.artifacts.map((entry) => entry.artifactId));
    if (ids.size !== input.artifacts.length || input.artifacts.length === 0) {
      throw new SQLiteTemplateAuthoringError('artifact_conflict');
    }
    const existing = this.listArtifacts(scope);
    if (existing.length > 0) {
      if (existing.length !== input.artifacts.length
          || existing.some((entry) => !ids.has(entry.head.artifactId))) {
        throw new SQLiteTemplateAuthoringError('artifact_conflict');
      }
      return existing;
    }
    const snapshots = input.artifacts.map((seed) => createInitialTemplateArtifact({
      scope,
      artifactId: seed.artifactId,
      revisionId: seed.revisionId,
      document: seed.document,
      createdByUserId: input.createdByUserId,
      createdAt: input.createdAt,
      ...(seed.note === undefined ? {} : { note: seed.note })
    }));
    for (const snapshot of snapshots) {
      const revision = snapshot.current;
      this.sqlite.query(`
        INSERT INTO template_artifact_heads (
          workspace_id,event_id,artifact_id,artifact_kind,current_revision_id,
          current_revision_number,version
        ) VALUES (?,?,?,?,?,?,?)
      `).run(
        scope.workspaceId, scope.eventId, snapshot.head.artifactId, snapshot.head.artifactKind,
        snapshot.head.currentRevisionId, 1, 1
      );
      this.sqlite.query(`
        INSERT INTO template_artifact_revisions (
          workspace_id,event_id,artifact_id,revision_id,revision_number,
          predecessor_revision_id,predecessor_digest_sha256,artifact_kind,
          revision_json,digest_sha256,created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        scope.workspaceId, scope.eventId, revision.artifactId, revision.revisionId,
        revision.number, null, null, revision.document.kind, JSON.stringify(revision),
        revision.digestSha256, Date.parse(revision.createdAt)
      );
    }
    return Object.freeze(snapshots);
  }

  applyMutation(rawPlan: TemplateArtifactMutationPlanDto): TemplateArtifactSnapshotDto {
    requireTransaction(this.sqlite);
    const plan = templateArtifactMutationPlanSchema.parse(rawPlan);
    const invalid = validateTemplateArtifactMutation({ plan, read: this });
    if (invalid === 'artifact_missing') throw new SQLiteTemplateAuthoringError('artifact_missing');
    if (invalid !== undefined) throw new SQLiteTemplateAuthoringError(
      invalid === 'stale_revision' ? 'stale_revision' : 'data_corrupt'
    );
    const after = plan.after;
    try {
      this.sqlite.query(`
        INSERT INTO template_artifact_revisions (
          workspace_id,event_id,artifact_id,revision_id,revision_number,
          predecessor_revision_id,predecessor_digest_sha256,artifact_kind,
          revision_json,digest_sha256,created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        plan.scope.workspaceId, plan.scope.eventId, plan.artifactId, after.revisionId,
        after.number, after.predecessor!.revisionId, after.predecessor!.digestSha256,
        after.document.kind, JSON.stringify(after), after.digestSha256, Date.parse(after.createdAt)
      );
      const updated = this.sqlite.query(`
        UPDATE template_artifact_heads
           SET current_revision_id=?,current_revision_number=?,version=version+1
         WHERE workspace_id=? AND event_id=? AND artifact_id=? AND version=?
      `).run(
        after.revisionId, after.number, plan.scope.workspaceId, plan.scope.eventId,
        plan.artifactId, plan.expectedHeadVersion
      );
      if (updated.changes !== 1) throw new SQLiteTemplateAuthoringError('stale_revision');
    } catch (error) {
      if (error instanceof SQLiteTemplateAuthoringError) throw error;
      throw new SQLiteTemplateAuthoringError('data_corrupt', error);
    }
    const result = this.readArtifact(plan.scope, plan.artifactId);
    if (!result) throw new SQLiteTemplateAuthoringError('data_corrupt');
    return result;
  }
}
