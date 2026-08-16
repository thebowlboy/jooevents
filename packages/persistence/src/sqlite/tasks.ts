import type { Database } from 'bun:sqlite';
import {
  taskAssignmentRestorePlanSchema,
  taskMutationPlanSchema,
  taskMutationResultSchema,
  type TaskAssignmentDto,
  type TaskAssignmentRestorePlanDto,
  type TaskBoardSnapshotDto,
  type TaskDefinitionCatalogDto,
  type TaskDefinitionSnapshotDto,
  type TaskEventDto,
  type TaskMutationPlanDto,
  type TaskMutationResultDto,
  type TaskScopeDto
} from '@jooevents/contracts';
import {
  createEmptyTaskCatalog,
  parseTaskAssignment,
  parseTaskBoard,
  parseTaskCatalog,
  parseTaskDefinition,
  parseTaskEvent,
  type ConfirmedTaskEngagement,
  type TaskMembershipSource,
  type TaskTransactionPort
} from '@jooevents/tasks';
import type { TaskEngagementReconciliationPlan } from '@jooevents/tasks';
import { canonicalJsonText } from '@jooevents/kernel';

/** This schema contributes to the accepted epoch-2 baseline and may also serve isolated fixtures. */
export const TASK_SQL = `
CREATE TABLE task_definition_catalogs (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  version INTEGER NOT NULL CHECK(version >= 2),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY(workspace_id,event_id),
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES event_spine_scope_roots(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_definition_heads (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  current_revision_id TEXT NOT NULL CHECK(length(current_revision_id) = 36),
  current_revision_number INTEGER NOT NULL CHECK(current_revision_number > 0),
  version INTEGER NOT NULL CHECK(version = current_revision_number),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,current_revision_id),
  FOREIGN KEY(workspace_id,event_id)
    REFERENCES task_definition_catalogs(workspace_id,event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,current_revision_id)
    REFERENCES task_definition_revisions(workspace_id,event_id,revision_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE TABLE task_definition_revisions (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  task_definition_id TEXT NOT NULL CHECK(length(task_definition_id) = 36),
  revision_id TEXT NOT NULL CHECK(length(revision_id) = 36),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  deadline_id TEXT NOT NULL CHECK(length(deadline_id) = 36),
  completion_mode TEXT NOT NULL CHECK(completion_mode IN (
    'acknowledge','file_upload','form','external_action'
  )),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('engagement','session','group')),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  revision_json TEXT NOT NULL CHECK(json_valid(revision_json)),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,revision_id),
  UNIQUE(workspace_id,event_id,task_definition_id,revision_number),
  CHECK(json_extract(revision_json,'$.taskDefinitionId') = task_definition_id),
  CHECK(json_extract(revision_json,'$.revisionId') = revision_id),
  CHECK(json_extract(revision_json,'$.number') = revision_number),
  CHECK(json_extract(revision_json,'$.deadline.reference.id') = deadline_id),
  CHECK(json_extract(revision_json,'$.completionMode') = completion_mode),
  CHECK(json_extract(revision_json,'$.subjectKind') = subject_kind),
  CHECK(json_extract(revision_json,'$.digestSha256') = digest_sha256),
  FOREIGN KEY(workspace_id,event_id,task_definition_id)
    REFERENCES task_definition_heads(workspace_id,event_id,id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,event_id,deadline_id)
    REFERENCES deadlines(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_assignments (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  task_definition_id TEXT NOT NULL CHECK(length(task_definition_id) = 36),
  task_definition_revision_id TEXT NOT NULL CHECK(length(task_definition_revision_id) = 36),
  engagement_id TEXT NOT NULL CHECK(length(engagement_id) = 36),
  person_id TEXT NOT NULL CHECK(length(person_id) = 36),
  state TEXT NOT NULL CHECK(state IN (
    'pending','received_pending_check','complete','waived','late_complete'
  )),
  version INTEGER NOT NULL CHECK(version > 0),
  assignment_json TEXT NOT NULL CHECK(json_valid(assignment_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,task_definition_id,engagement_id),
  CHECK(json_extract(assignment_json,'$.id') = id),
  CHECK(json_extract(assignment_json,'$.taskDefinitionId') = task_definition_id),
  CHECK(json_extract(assignment_json,'$.taskDefinitionRevisionId') = task_definition_revision_id),
  CHECK(json_extract(assignment_json,'$.engagementId') = engagement_id),
  CHECK(json_extract(assignment_json,'$.personId') = person_id),
  CHECK(json_extract(assignment_json,'$.state') = state),
  CHECK(json_extract(assignment_json,'$.version') = version),
  FOREIGN KEY(workspace_id,event_id,task_definition_id)
    REFERENCES task_definition_heads(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,task_definition_revision_id)
    REFERENCES task_definition_revisions(workspace_id,event_id,revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,event_id,engagement_id)
    REFERENCES engagement_heads(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE task_events (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  id TEXT NOT NULL CHECK(length(id) = 36),
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN (
    'assigned','fulfillment_received','fulfillment_accepted','waived','restored','extended','reminded'
  )),
  assignment_version INTEGER NOT NULL CHECK(assignment_version > 0),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(workspace_id,event_id,id),
  UNIQUE(workspace_id,event_id,assignment_id,assignment_version),
  CHECK(json_extract(event_json,'$.id') = id),
  CHECK(json_extract(event_json,'$.assignmentId') = assignment_id),
  CHECK(json_extract(event_json,'$.kind') = kind),
  CHECK(json_extract(event_json,'$.assignmentVersion') = assignment_version),
  FOREIGN KEY(workspace_id,event_id,assignment_id)
    REFERENCES task_assignments(workspace_id,event_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX task_assignments_definition
  ON task_assignments(workspace_id,event_id,task_definition_id,engagement_id);
CREATE INDEX task_assignments_engagement
  ON task_assignments(workspace_id,event_id,engagement_id,task_definition_id);
CREATE INDEX task_assignments_state
  ON task_assignments(workspace_id,event_id,state,id);
CREATE INDEX task_events_history
  ON task_events(workspace_id,event_id,assignment_id,assignment_version);

CREATE TRIGGER task_definition_revisions_no_update BEFORE UPDATE ON task_definition_revisions
BEGIN SELECT RAISE(ABORT, 'task definition revisions are immutable'); END;
CREATE TRIGGER task_definition_revisions_no_delete BEFORE DELETE ON task_definition_revisions
BEGIN SELECT RAISE(ABORT, 'task definition revisions are immutable'); END;
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
CREATE TRIGGER task_definition_heads_no_delete BEFORE DELETE ON task_definition_heads
BEGIN SELECT RAISE(ABORT, 'task definitions are retained'); END;
CREATE TRIGGER task_assignments_identity_immutable
BEFORE UPDATE OF workspace_id,event_id,id,task_definition_id,task_definition_revision_id,
  engagement_id,person_id ON task_assignments
BEGIN SELECT RAISE(ABORT, 'task assignment identity is immutable'); END;
`;

export type SQLiteTaskErrorCode =
  | 'transaction_required' | 'scope_corrupt' | 'data_corrupt' | 'stale_catalog'
  | 'definition_conflict' | 'assignment_conflict';

export class SQLiteTaskError extends TypeError {
  constructor(readonly code: SQLiteTaskErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteTaskError';
  }
}

interface CatalogRow { readonly version: number; readonly digest_sha256: string }
interface HeadRow {
  readonly id: string;
  readonly current_revision_id: string;
  readonly current_revision_number: number;
  readonly version: number;
}
interface JsonRow { readonly value_json: string }
interface ScopeRow { readonly event_id: string }
interface EngagementRow { readonly id: string; readonly person_id: string; readonly version: number }

export function installTaskSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteTaskError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(TASK_SQL)).immediate();
}

export class SQLiteTaskRepository implements TaskTransactionPort, TaskMembershipSource {
  constructor(private readonly sqlite: Database) {}

  readTaskCatalog(scope: TaskScopeDto): TaskDefinitionCatalogDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<CatalogRow, [string, string]>(`
      SELECT version,digest_sha256 FROM task_definition_catalogs
       WHERE workspace_id=? AND event_id=?
    `).get(scope.workspaceId, scope.eventId);
    const definitions = this.listDefinitions(scope);
    if (row === null) {
      if (definitions.length > 0) throw new SQLiteTaskError('data_corrupt');
      return createEmptyTaskCatalog(scope);
    }
    try {
      return parseTaskCatalog({
        schemaVersion: 1,
        scope,
        version: row.version,
        digestSha256: row.digest_sha256,
        definitions
      });
    } catch (error) {
      throw new SQLiteTaskError('data_corrupt', error);
    }
  }

  readTaskAssignment(scope: TaskScopeDto, assignmentId: string): TaskAssignmentDto | undefined {
    if (!this.scopeExists(scope)) return undefined;
    const row = this.sqlite.query<JsonRow, [string, string, string]>(`
      SELECT assignment_json AS value_json FROM task_assignments
       WHERE workspace_id=? AND event_id=? AND id=?
    `).get(scope.workspaceId, scope.eventId, assignmentId);
    if (row === null) return undefined;
    try {
      return parseTaskAssignment(JSON.parse(row.value_json));
    } catch (error) {
      throw new SQLiteTaskError('data_corrupt', error);
    }
  }

  readTaskBoard(scope: TaskScopeDto): TaskBoardSnapshotDto | undefined {
    const catalog = this.readTaskCatalog(scope);
    if (!catalog) return undefined;
    const assignments = this.sqlite.query<JsonRow, [string, string]>(`
      SELECT assignment_json AS value_json FROM task_assignments
       WHERE workspace_id=? AND event_id=? ORDER BY task_definition_id,engagement_id
    `).all(scope.workspaceId, scope.eventId).map((row) => {
      try { return parseTaskAssignment(JSON.parse(row.value_json)); }
      catch (error) { throw new SQLiteTaskError('data_corrupt', error); }
    });
    return parseTaskBoard({
      schemaVersion: 1,
      scope,
      catalogVersion: catalog.version,
      catalogDigestSha256: catalog.digestSha256,
      definitions: catalog.definitions,
      assignments
    });
  }

  readTaskEvent(
    scope: TaskScopeDto,
    assignmentId: string,
    assignmentVersion: number
  ): TaskEventDto | undefined {
    const row = this.sqlite.query<{ readonly value_json: string }, [string, string, string, number]>(`
      SELECT event_json AS value_json FROM task_events
       WHERE workspace_id=? AND event_id=? AND assignment_id=? AND assignment_version=?
       LIMIT 2
    `).get(scope.workspaceId, scope.eventId, assignmentId, assignmentVersion);
    if (row === null) return undefined;
    try { return parseTaskEvent(JSON.parse(row.value_json)); }
    catch (error) { throw new SQLiteTaskError('data_corrupt', error); }
  }

  listConfirmedTaskEngagements(scope: TaskScopeDto): readonly ConfirmedTaskEngagement[] {
    if (!this.scopeExists(scope)) return Object.freeze([]);
    return Object.freeze(this.sqlite.query<EngagementRow, [string, string]>(`
      SELECT id,person_id,version FROM engagement_heads
       WHERE workspace_id=? AND event_id=? AND state='confirmed'
       ORDER BY id COLLATE BINARY
    `).all(scope.workspaceId, scope.eventId).map((row) => Object.freeze({
      engagementId: row.id,
      personId: row.person_id,
      version: row.version,
      state: 'confirmed' as const
    })));
  }

  applyTaskPlan(
    planInput: TaskMutationPlanDto | TaskAssignmentRestorePlanDto
  ): TaskMutationResultDto {
    if (!this.sqlite.inTransaction) throw new SQLiteTaskError('transaction_required');
    if (planInput.action === 'restore_assignment') {
      const plan = taskAssignmentRestorePlanSchema.parse(planInput);
      this.updateAssignment(plan.scope, plan.expectedCurrent, plan.restore);
      this.insertEvent(plan.event);
      return taskMutationResultSchema.parse({ action: plan.action, assignment: plan.restore });
    }
    const plan = taskMutationPlanSchema.parse(planInput);
    if (plan.action === 'create_definition') {
      this.advanceCatalog(plan.input.scope, plan.catalog);
      this.insertDefinition(plan.definition);
      for (const assignment of plan.assignments) this.insertAssignment(assignment);
      for (const event of plan.events) this.insertEvent(event);
      return taskMutationResultSchema.parse({
        action: plan.action,
        definition: plan.definition,
        assignments: plan.assignments
      });
    }
    this.updateAssignment(plan.input.scope, plan.before, plan.after);
    this.insertEvent(plan.event);
    return taskMutationResultSchema.parse({ action: plan.action, assignment: plan.after });
  }

  applyEngagementReconciliation(plan: TaskEngagementReconciliationPlan): {
    readonly action: 'materialize' | 'waive';
    readonly assignmentIds: readonly string[];
  } {
    if (!this.sqlite.inTransaction) throw new SQLiteTaskError('transaction_required');
    const catalog = this.readTaskCatalog(plan.scope);
    if (!catalog || catalog.version !== plan.catalogVersion
        || catalog.digestSha256 !== plan.catalogDigestSha256) {
      throw new SQLiteTaskError('stale_catalog');
    }
    if (plan.action === 'materialize') {
      for (const assignment of plan.assignments) this.insertAssignment(assignment);
      for (const event of plan.events) this.insertEvent(event);
      return Object.freeze({
        action: plan.action,
        assignmentIds: Object.freeze(plan.assignments.map((entry) => entry.id))
      });
    }
    for (const row of plan.rows) {
      this.updateAssignment(plan.scope, row.before, row.after);
      this.insertEvent(row.event);
    }
    return Object.freeze({
      action: plan.action,
      assignmentIds: Object.freeze(plan.rows.map((entry) => entry.after.id))
    });
  }

  private listDefinitions(scope: TaskScopeDto): readonly TaskDefinitionSnapshotDto[] {
    const heads = this.sqlite.query<HeadRow, [string, string]>(`
      SELECT id,current_revision_id,current_revision_number,version
        FROM task_definition_heads WHERE workspace_id=? AND event_id=? ORDER BY id
    `).all(scope.workspaceId, scope.eventId);
    return Object.freeze(heads.map((head) => {
      const row = this.sqlite.query<JsonRow, [string, string, string]>(`
        SELECT revision_json AS value_json FROM task_definition_revisions
         WHERE workspace_id=? AND event_id=? AND revision_id=?
      `).get(scope.workspaceId, scope.eventId, head.current_revision_id);
      if (row === null) throw new SQLiteTaskError('data_corrupt');
      try {
        return parseTaskDefinition({
          head: {
            schemaVersion: 1,
            scope,
            id: head.id,
            currentRevisionId: head.current_revision_id,
            currentRevisionNumber: head.current_revision_number,
            version: head.version
          },
          current: JSON.parse(row.value_json)
        });
      } catch (error) {
        throw new SQLiteTaskError('data_corrupt', error);
      }
    }));
  }

  private advanceCatalog(
    scope: TaskScopeDto,
    catalog: Extract<TaskMutationPlanDto, { action: 'create_definition' }>['catalog']
  ): void {
    const current = this.sqlite.query<CatalogRow, [string, string]>(`
      SELECT version,digest_sha256 FROM task_definition_catalogs
       WHERE workspace_id=? AND event_id=?
    `).get(scope.workspaceId, scope.eventId);
    if (current === null && catalog.beforeVersion === 1) {
      changedOnce(this.sqlite.query<never, [string, string, number, string, string, string]>(`
        INSERT INTO task_definition_catalogs(workspace_id,event_id,version,digest_sha256)
        SELECT ?,?,?,? FROM event_spine_scope_roots WHERE workspace_id=? AND event_id=?
      `).run(
        scope.workspaceId, scope.eventId, catalog.afterVersion, catalog.afterDigestSha256,
        scope.workspaceId, scope.eventId
      ), 'stale_catalog');
      return;
    }
    if (!current || current.version !== catalog.beforeVersion
        || current.digest_sha256 !== catalog.beforeDigestSha256) {
      throw new SQLiteTaskError('stale_catalog');
    }
    changedOnce(this.sqlite.query<never, [number, string, string, string, number, string]>(`
      UPDATE task_definition_catalogs SET version=?,digest_sha256=?
       WHERE workspace_id=? AND event_id=? AND version=? AND digest_sha256=?
    `).run(
      catalog.afterVersion, catalog.afterDigestSha256,
      scope.workspaceId, scope.eventId, catalog.beforeVersion, catalog.beforeDigestSha256
    ), 'stale_catalog');
  }

  private insertDefinition(snapshot: TaskDefinitionSnapshotDto): void {
    const { head, current } = snapshot;
    try {
      this.sqlite.query(`
        INSERT INTO task_definition_heads(
          workspace_id,event_id,id,current_revision_id,current_revision_number,version
        ) VALUES (?,?,?,?,?,?)
      `).run(
        head.scope.workspaceId, head.scope.eventId, head.id,
        head.currentRevisionId, head.currentRevisionNumber, head.version
      );
      this.sqlite.query(`
        INSERT INTO task_definition_revisions(
          workspace_id,event_id,task_definition_id,revision_id,revision_number,
          deadline_id,completion_mode,subject_kind,required,revision_json,digest_sha256,created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        current.scope.workspaceId, current.scope.eventId, current.taskDefinitionId,
        current.revisionId, current.number, current.deadline.reference.id,
        current.completionMode, current.subjectKind, current.required ? 1 : 0,
        canonicalJsonText(current), current.digestSha256, Date.parse(current.createdAt)
      );
    } catch (error) {
      throw new SQLiteTaskError('definition_conflict', error);
    }
  }

  private insertAssignment(assignment: TaskAssignmentDto): void {
    try {
      this.sqlite.query(`
        INSERT INTO task_assignments(
          workspace_id,event_id,id,task_definition_id,task_definition_revision_id,
          engagement_id,person_id,state,version,assignment_json,updated_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        assignment.scope.workspaceId, assignment.scope.eventId, assignment.id,
        assignment.taskDefinitionId, assignment.taskDefinitionRevisionId,
        assignment.engagementId, assignment.personId, assignment.state, assignment.version,
        canonicalJsonText(assignment), Date.parse(assignment.updatedAt)
      );
    } catch (error) {
      throw new SQLiteTaskError('assignment_conflict', error);
    }
  }

  private updateAssignment(
    scope: TaskScopeDto,
    expected: TaskAssignmentDto,
    after: TaskAssignmentDto
  ): void {
    changedOnce(this.sqlite.query<never, [string, number, string, number, string, string, string, number, string]>(`
      UPDATE task_assignments SET state=?,version=?,assignment_json=?,updated_at_ms=?
       WHERE workspace_id=? AND event_id=? AND id=? AND version=? AND assignment_json=?
    `).run(
      after.state, after.version, canonicalJsonText(after), Date.parse(after.updatedAt),
      scope.workspaceId, scope.eventId, expected.id, expected.version, canonicalJsonText(expected)
    ), 'assignment_conflict');
  }

  private insertEvent(event: TaskEventDto): void {
    const value = parseTaskEvent(event);
    this.sqlite.query(`
      INSERT INTO task_events(
        workspace_id,event_id,id,assignment_id,kind,assignment_version,event_json,occurred_at_ms
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      value.scope.workspaceId, value.scope.eventId, value.id, value.assignmentId,
      value.kind, value.assignmentVersion, canonicalJsonText(value), Date.parse(value.occurredAt)
    );
  }

  private scopeExists(scope: TaskScopeDto): boolean {
    const rows = this.sqlite.query<ScopeRow, [string, string]>(`
      SELECT event_id FROM event_spine_scope_roots WHERE workspace_id=? AND event_id=? LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteTaskError('scope_corrupt');
    return rows.length === 1;
  }
}

function changedOnce(result: { readonly changes: number }, code: SQLiteTaskErrorCode): void {
  if (result.changes !== 1) throw new SQLiteTaskError(code);
}
