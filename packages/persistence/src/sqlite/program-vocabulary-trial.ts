import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import {
  applyPreparedChangeset,
  markChangesetCommitted,
  planChangesetOperation,
  prepareChangesetCommit,
  validateExactCommit,
  type ApprovalReceipt,
  type ChangesetApplyContribution,
  type ChangesetDefinitionRegistry,
  type ChangesetHead,
  type ChangesetPlanningSnapshot,
  type ChangesetCommitTransaction,
  type CommitValidationInput,
  type CommitRefusal,
  type CommittedChangesetSource,
  type CompensationLineage,
  type FrozenChangesetOperation
} from '@jooevents/changesets';
import {
  programVocabularyScopeSchema,
  type ProgramVocabularyChangeResult,
  type ProgramVocabularyScopeDto,
  type StructuredOutcome
} from '@jooevents/contracts';
import {
  canonicalJsonText,
  encodeCanonicalJson,
  type OperationReceiptId
} from '@jooevents/kernel';
import {
  PROGRAM_VOCABULARY_CHANGESET_KIND,
  PROGRAM_VOCABULARY_CHANGESET_VERSION,
  applyProgramReferenceRepoints,
  applyProgramVocabularyPlan,
  createProgramVocabularyValidationView,
  createProgramVocabularyState,
  mergeReferenceCounts,
  plannedProgramVocabularyItem,
  programVocabularyAggregateId,
  programVocabularyItems,
  programVocabularyReadPort,
  programVocabularySetDigest,
  programVocabularySetGuardId,
  programVocabularyValidationPort,
  programVocabularyTransactionPort,
  validateProgramVocabularyPlan,
  type CompleteProgramReferenceSnapshot,
  type PlannedProgramVocabularyItem,
  type ProgramReferenceContributorRef,
  type ProgramReferenceContributorRegistry,
  type ProgramVocabularyAuthorInput,
  type ProgramVocabularyMutationPlan,
  type ProgramVocabularyPlanningErrorCode,
  type ProgramVocabularyReadPort,
  type ProgramVocabularyState,
  type ProgramVocabularyTransactionPort,
  ProgramVocabularyPlanningError
} from '@jooevents/program';

/** Test-only schema used to exercise the Program Vocabulary SQLite adapter. */
export const PROGRAM_VOCABULARY_TRIAL_SQL = `
CREATE TABLE program_vocabulary_trial_sets (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  set_version INTEGER NOT NULL CHECK(set_version > 0),
  PRIMARY KEY (workspace_id, event_id)
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_trial_rooms (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  capacity INTEGER CHECK(capacity IS NULL OR capacity > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_trial_tracks (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_trial_formats (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY (workspace_id, event_id, id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER program_vocabulary_trial_rooms_distinct_id
BEFORE INSERT ON program_vocabulary_trial_rooms
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_trial_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_trial_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_trial_tracks_distinct_id
BEFORE INSERT ON program_vocabulary_trial_tracks
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_trial_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_trial_formats
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

CREATE TRIGGER program_vocabulary_trial_formats_distinct_id
BEFORE INSERT ON program_vocabulary_trial_formats
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_trial_rooms
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
) OR EXISTS (
  SELECT 1 FROM program_vocabulary_trial_tracks
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary ids must be distinct across kinds');
END;

/* This reference owner is a disposable test double, not a generic product table. */
CREATE TABLE program_vocabulary_trial_test_contributors (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  contributor_key TEXT NOT NULL CHECK(length(contributor_key) BETWEEN 1 AND 160),
  contributor_version INTEGER NOT NULL CHECK(contributor_version > 0),
  guard_id TEXT NOT NULL CHECK(guard_id GLOB 'program_reference:*'),
  guard_version INTEGER NOT NULL CHECK(guard_version > 0),
  guard_digest TEXT NOT NULL CHECK(length(guard_digest) = 64 AND guard_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id, contributor_key, contributor_version),
  UNIQUE (workspace_id, event_id, guard_id),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE program_vocabulary_trial_test_references (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  contributor_key TEXT NOT NULL,
  contributor_version INTEGER NOT NULL,
  reference_key TEXT NOT NULL CHECK(length(reference_key) BETWEEN 1 AND 300),
  reference_version INTEGER NOT NULL CHECK(reference_version > 0),
  item_kind TEXT NOT NULL CHECK(item_kind IN ('room', 'track', 'format')),
  item_id TEXT NOT NULL CHECK(length(item_id) = 36),
  reference_mode TEXT NOT NULL CHECK(reference_mode IN ('current', 'historical')),
  destination_kind TEXT NOT NULL CHECK(length(destination_kind) BETWEEN 1 AND 160),
  destination_id TEXT NOT NULL CHECK(length(destination_id) BETWEEN 1 AND 300),
  PRIMARY KEY (
    workspace_id, event_id, contributor_key, contributor_version, reference_key
  ),
  FOREIGN KEY (workspace_id, event_id, contributor_key, contributor_version)
    REFERENCES program_vocabulary_trial_test_contributors(
      workspace_id, event_id, contributor_key, contributor_version
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER program_vocabulary_trial_test_reference_target_insert
BEFORE INSERT ON program_vocabulary_trial_test_references
WHEN
  (NEW.item_kind = 'room' AND NOT EXISTS (
    SELECT 1 FROM program_vocabulary_trial_rooms
     WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.item_id
  )) OR
  (NEW.item_kind = 'track' AND NOT EXISTS (
    SELECT 1 FROM program_vocabulary_trial_tracks
     WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.item_id
  )) OR
  (NEW.item_kind = 'format' AND NOT EXISTS (
    SELECT 1 FROM program_vocabulary_trial_formats
     WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.item_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'program reference target is missing');
END;

CREATE TRIGGER program_vocabulary_trial_test_reference_target_update
BEFORE UPDATE OF item_kind, item_id, workspace_id, event_id
ON program_vocabulary_trial_test_references
WHEN
  (NEW.item_kind = 'room' AND NOT EXISTS (
    SELECT 1 FROM program_vocabulary_trial_rooms
     WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.item_id
  )) OR
  (NEW.item_kind = 'track' AND NOT EXISTS (
    SELECT 1 FROM program_vocabulary_trial_tracks
     WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.item_id
  )) OR
  (NEW.item_kind = 'format' AND NOT EXISTS (
    SELECT 1 FROM program_vocabulary_trial_formats
     WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND id = NEW.item_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'program reference target is missing');
END;

CREATE TRIGGER program_vocabulary_trial_rooms_referenced_delete
BEFORE DELETE ON program_vocabulary_trial_rooms
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_trial_test_references
   WHERE workspace_id = OLD.workspace_id AND event_id = OLD.event_id
     AND item_kind = 'room' AND item_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'referenced program vocabulary item cannot be deleted');
END;

CREATE TRIGGER program_vocabulary_trial_tracks_referenced_delete
BEFORE DELETE ON program_vocabulary_trial_tracks
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_trial_test_references
   WHERE workspace_id = OLD.workspace_id AND event_id = OLD.event_id
     AND item_kind = 'track' AND item_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'referenced program vocabulary item cannot be deleted');
END;

CREATE TRIGGER program_vocabulary_trial_formats_referenced_delete
BEFORE DELETE ON program_vocabulary_trial_formats
WHEN EXISTS (
  SELECT 1 FROM program_vocabulary_trial_test_references
   WHERE workspace_id = OLD.workspace_id AND event_id = OLD.event_id
     AND item_kind = 'format' AND item_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'referenced program vocabulary item cannot be deleted');
END;

/* Test-only evidence used to verify atomic state and timeline writes. */
CREATE TABLE program_vocabulary_trial_commit_evidence (
  change_evidence_id TEXT PRIMARY KEY CHECK(length(change_evidence_id) BETWEEN 1 AND 300),
  receipt_evidence_id TEXT NOT NULL UNIQUE CHECK(length(receipt_evidence_id) BETWEEN 1 AND 300),
  fact_evidence_id TEXT NOT NULL UNIQUE CHECK(length(fact_evidence_id) BETWEEN 1 AND 300),
  revision_id TEXT NOT NULL CHECK(length(revision_id) BETWEEN 1 AND 300),
  revision_digest TEXT NOT NULL CHECK(length(revision_digest) = 64 AND revision_digest NOT GLOB '*[^0-9a-f]*'),
  operation_kind TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  fact_kind TEXT NOT NULL,
  fact_version INTEGER NOT NULL CHECK(fact_version > 0),
  fact_payload_json TEXT NOT NULL CHECK(json_valid(fact_payload_json)),
  UNIQUE (change_evidence_id, receipt_evidence_id, fact_evidence_id)
);

CREATE TABLE program_vocabulary_trial_timeline_spine (
  timeline_id TEXT PRIMARY KEY CHECK(length(timeline_id) BETWEEN 1 AND 300),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  change_evidence_id TEXT NOT NULL,
  receipt_evidence_id TEXT NOT NULL,
  fact_evidence_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES program_vocabulary_trial_sets(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (change_evidence_id, receipt_evidence_id, fact_evidence_id)
    REFERENCES program_vocabulary_trial_commit_evidence(
      change_evidence_id, receipt_evidence_id, fact_evidence_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER program_vocabulary_trial_commit_evidence_no_update
BEFORE UPDATE ON program_vocabulary_trial_commit_evidence
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary trial commit evidence is immutable');
END;

CREATE TRIGGER program_vocabulary_trial_commit_evidence_no_delete
BEFORE DELETE ON program_vocabulary_trial_commit_evidence
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary trial commit evidence is immutable');
END;

CREATE TRIGGER program_vocabulary_trial_timeline_spine_no_update
BEFORE UPDATE ON program_vocabulary_trial_timeline_spine
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary trial timeline is immutable');
END;

CREATE TRIGGER program_vocabulary_trial_timeline_spine_no_delete
BEFORE DELETE ON program_vocabulary_trial_timeline_spine
BEGIN
  SELECT RAISE(ABORT, 'program vocabulary trial timeline is immutable');
END;
`;

interface SetRow {
  readonly set_version: number;
}

interface RoomRow {
  readonly id: string;
  readonly name: string;
  readonly capacity: number | null;
  readonly status: 'active' | 'retired';
  readonly version: number;
}

interface NamedItemRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'retired';
  readonly version: number;
}

interface ContributorRow {
  readonly contributor_key: string;
  readonly contributor_version: number;
  readonly guard_id: string;
  readonly guard_version: number;
  readonly guard_digest: string;
}

interface ReferenceRow {
  readonly reference_key: string;
  readonly reference_version: number;
  readonly item_kind: 'room' | 'track' | 'format';
  readonly item_id: string;
  readonly reference_mode: 'current' | 'historical';
  readonly destination_kind: string;
  readonly destination_id: string;
}

const itemTables = Object.freeze({
  room: 'program_vocabulary_trial_rooms',
  track: 'program_vocabulary_trial_tracks',
  format: 'program_vocabulary_trial_formats'
});
const trialStoreDatabases = new WeakMap<object, Database>();

function databaseFor(store: object): Database {
  const sqlite = trialStoreDatabases.get(store);
  if (!sqlite) throw new TypeError('unknown_program_vocabulary_trial_store');
  return sqlite;
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

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

function samePlannedItem(left: PlannedProgramVocabularyItem, right: PlannedProgramVocabularyItem): boolean {
  return canonicalDigest(left) === canonicalDigest(right);
}

export function installProgramVocabularyTrialSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_trial_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(PROGRAM_VOCABULARY_TRIAL_SQL);
}

export class SQLiteProgramVocabularyTrialStore
implements ProgramVocabularyReadPort, ProgramVocabularyTransactionPort {
  constructor(
    sqlite: Database,
    readonly referenceRegistry: ProgramReferenceContributorRegistry
  ) {
    trialStoreDatabases.set(this, sqlite);
  }

  readVocabulary(scope: ProgramVocabularyScopeDto): ProgramVocabularyState | undefined {
    const parsedScope = programVocabularyScopeSchema.parse(scope);
    const sqlite = databaseFor(this);
    const set = sqlite.query<SetRow, [string, string]>(`
      SELECT set_version
        FROM program_vocabulary_trial_sets
       WHERE workspace_id = ? AND event_id = ?
    `).get(parsedScope.workspaceId, parsedScope.eventId);
    if (!set) return undefined;
    const rooms = sqlite.query<RoomRow, [string, string]>(`
      SELECT id, name, capacity, status, version
        FROM program_vocabulary_trial_rooms
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY id
    `).all(parsedScope.workspaceId, parsedScope.eventId);
    const tracks = sqlite.query<NamedItemRow, [string, string]>(`
      SELECT id, name, status, version
        FROM program_vocabulary_trial_tracks
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY id
    `).all(parsedScope.workspaceId, parsedScope.eventId);
    const formats = sqlite.query<NamedItemRow, [string, string]>(`
      SELECT id, name, status, version
        FROM program_vocabulary_trial_formats
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY id
    `).all(parsedScope.workspaceId, parsedScope.eventId);
    return createProgramVocabularyState({
      scope: parsedScope,
      setVersion: set.set_version,
      rooms: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        capacity: room.capacity,
        status: room.status,
        version: room.version
      })),
      tracks: tracks.map((track) => ({ ...track })),
      formats: formats.map((format) => ({ ...format }))
    });
  }

  readContributor(
    contributor: ProgramReferenceContributorRef,
    scope: ProgramVocabularyState['scope']
  ): unknown {
    const sqlite = databaseFor(this);
    const row = sqlite.query<ContributorRow, [string, string, string, number]>(`
      SELECT contributor_key, contributor_version, guard_id, guard_version, guard_digest
        FROM program_vocabulary_trial_test_contributors
       WHERE workspace_id = ? AND event_id = ?
         AND contributor_key = ? AND contributor_version = ?
    `).get(scope.workspaceId, scope.eventId, contributor.key, contributor.version);
    if (!row) return undefined;
    const references = sqlite.query<ReferenceRow, [string, string, string, number]>(`
      SELECT reference_key, reference_version, item_kind, item_id,
             reference_mode, destination_kind, destination_id
        FROM program_vocabulary_trial_test_references
       WHERE workspace_id = ? AND event_id = ?
         AND contributor_key = ? AND contributor_version = ?
       ORDER BY reference_key
    `).all(scope.workspaceId, scope.eventId, contributor.key, contributor.version);
    return {
      contributor: { key: row.contributor_key, version: row.contributor_version },
      scope: { workspaceId: scope.workspaceId, eventId: scope.eventId },
      guard: {
        id: row.guard_id,
        version: row.guard_version,
        digest: row.guard_digest
      },
      references: references.map((reference) => ({
        referenceKey: reference.reference_key,
        version: reference.reference_version,
        item: { kind: reference.item_kind, id: reference.item_id },
        mode: reference.reference_mode,
        destination: {
          kind: reference.destination_kind,
          id: reference.destination_id
        }
      }))
    };
  }

  planningSnapshot(): ChangesetPlanningSnapshot {
    const store = this;
    const readPort = createProgramVocabularyValidationView(store);
    return Object.freeze({
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        if (key.key !== programVocabularyReadPort.key || key.version !== programVocabularyReadPort.version) {
          throw new TypeError('undeclared_program_vocabulary_trial_read_port');
        }
        return readPort as unknown as Port;
      }
    }) as ChangesetPlanningSnapshot;
  }

  transactionPort(): ChangesetCommitTransaction {
    if (!databaseFor(this).inTransaction) throw new TypeError('program_vocabulary_trial_transaction_required');
    const store = this;
    const validationPort = createProgramVocabularyValidationView(store);
    return Object.freeze({
      getPort<Port>(key: { readonly key: string; readonly version: number }): Port {
        const isValidation = key.key === programVocabularyValidationPort.key
          && key.version === programVocabularyValidationPort.version;
        const isTransaction = key.key === programVocabularyTransactionPort.key
          && key.version === programVocabularyTransactionPort.version;
        if (!isValidation && !isTransaction) {
          throw new TypeError('undeclared_program_vocabulary_trial_transaction_port');
        }
        return (isValidation ? validationPort : store) as unknown as Port;
      }
    }) as ChangesetCommitTransaction;
  }

  applyVocabularyPlan(plan: ProgramVocabularyMutationPlan): ProgramVocabularyChangeResult {
    const sqlite = databaseFor(this);
    if (!sqlite.inTransaction) throw new TypeError('program_vocabulary_trial_transaction_required');
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

    if (plan.action === 'create') this.insertItem(plan.after, plan.scope);
    else if (plan.action === 'delete') this.deleteItem(plan.before, plan.scope);
    else if (plan.action === 'merge' || plan.action === 'merge_compensation') {
      if (!samePlannedItem(plan.sourceBefore, plan.sourceAfter)) {
        this.updateItem(plan.sourceBefore, plan.sourceAfter, plan.scope);
      }
      this.applyReferenceRepoints(state, plan);
    } else {
      this.updateItem(plan.before, plan.after, plan.scope);
    }

    changedExactlyOnce(sqlite.query<never, [number, string, string, number]>(`
      UPDATE program_vocabulary_trial_sets
         SET set_version = ?
       WHERE workspace_id = ? AND event_id = ? AND set_version = ?
    `).run(nextState.setVersion, plan.scope.workspaceId, plan.scope.eventId, plan.expectedSetVersion), 'stale_set');

    const subject = affected(plan);
    const liveRepoints = plan.action === 'merge' || plan.action === 'merge_compensation'
      ? mergeReferenceCounts(plan).liveRepoints
      : 0;
    return {
      action: plan.action,
      kind: subject.kind,
      affectedIds: [...subject.ids],
      setVersion: nextState.setVersion,
      liveRepoints
    };
  }

  private insertItem(item: PlannedProgramVocabularyItem, scope: ProgramVocabularyScopeDto): void {
    const sqlite = databaseFor(this);
    if (item.kind === 'room') {
      changedExactlyOnce(sqlite.query<never, [string, string, string, string, number | null, string, number]>(`
        INSERT INTO program_vocabulary_trial_rooms (
          workspace_id, event_id, id, name, capacity, status, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(scope.workspaceId, scope.eventId, item.id, item.name, item.capacity, item.status, item.version), 'item_exists');
      return;
    }
    const table = itemTables[item.kind];
    changedExactlyOnce(sqlite.query<never, [string, string, string, string, string, number]>(`
      INSERT INTO ${table} (workspace_id, event_id, id, name, status, version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scope.workspaceId, scope.eventId, item.id, item.name, item.status, item.version), 'item_exists');
  }

  private updateItem(
    before: PlannedProgramVocabularyItem,
    after: PlannedProgramVocabularyItem,
    scope: ProgramVocabularyScopeDto
  ): void {
    const sqlite = databaseFor(this);
    if (before.kind !== after.kind || before.id !== after.id) {
      throw new ProgramVocabularyPlanningError('stale_item');
    }
    if (before.kind === 'room' && after.kind === 'room') {
      changedExactlyOnce(sqlite.query<never, [string, number | null, string, number, string, string, string, number, string, string, number | null]>(`
        UPDATE program_vocabulary_trial_rooms
           SET name = ?, capacity = ?, status = ?, version = ?
         WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
           AND name = ? AND status = ? AND capacity IS ?
      `).run(
        after.name, after.capacity, after.status, after.version,
        scope.workspaceId, scope.eventId, before.id, before.version,
        before.name, before.status, before.capacity
      ), 'stale_item');
      return;
    }
    const table = itemTables[before.kind];
    changedExactlyOnce(sqlite.query<never, [string, string, number, string, string, string, number, string, string]>(`
      UPDATE ${table}
         SET name = ?, status = ?, version = ?
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
         AND name = ? AND status = ?
    `).run(
      after.name, after.status, after.version,
      scope.workspaceId, scope.eventId, before.id, before.version,
      before.name, before.status
    ), 'stale_item');
  }

  private deleteItem(item: PlannedProgramVocabularyItem, scope: ProgramVocabularyScopeDto): void {
    const sqlite = databaseFor(this);
    const table = itemTables[item.kind];
    if (item.kind === 'room') {
      changedExactlyOnce(sqlite.query<never, [string, string, string, number, string, string, number | null]>(`
        DELETE FROM ${table}
         WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
           AND name = ? AND status = ? AND capacity IS ?
      `).run(
        scope.workspaceId, scope.eventId, item.id, item.version,
        item.name, item.status, item.capacity
      ), 'stale_item');
      return;
    }
    changedExactlyOnce(sqlite.query<never, [string, string, string, number, string, string]>(`
      DELETE FROM ${table}
       WHERE workspace_id = ? AND event_id = ? AND id = ? AND version = ?
         AND name = ? AND status = ?
    `).run(
      scope.workspaceId, scope.eventId, item.id, item.version,
      item.name, item.status
    ), 'stale_item');
  }

  private applyReferenceRepoints(
    state: ProgramVocabularyState,
    plan: Extract<ProgramVocabularyMutationPlan, { readonly action: 'merge' | 'merge_compensation' }>
  ): void {
    const sqlite = databaseFor(this);
    const current = this.referenceRegistry.capture(state.scope, this);
    const next = applyProgramReferenceRepoints(current, plan);
    for (const plannedContributor of plan.references) {
      if (plannedContributor.liveRepoints.length === 0) continue;
      const nextContributor = next.contributors.find((entry) =>
        entry.contributor.key === plannedContributor.contributor.key
        && entry.contributor.version === plannedContributor.contributor.version
      );
      if (!nextContributor) throw new ProgramVocabularyPlanningError('stale_reference');
      for (const repoint of plannedContributor.liveRepoints) {
        changedExactlyOnce(sqlite.query<never, [string, string, number, string, string, string, number, string, number, string, string]>(`
          UPDATE program_vocabulary_trial_test_references
             SET item_kind = ?, item_id = ?, reference_version = ?
           WHERE workspace_id = ? AND event_id = ?
             AND contributor_key = ? AND contributor_version = ?
             AND reference_key = ? AND reference_version = ?
             AND reference_mode = 'current' AND item_kind = ? AND item_id = ?
        `).run(
          repoint.to.kind,
          repoint.to.id,
          repoint.expectedVersion + 1,
          plan.scope.workspaceId,
          plan.scope.eventId,
          plannedContributor.contributor.key,
          plannedContributor.contributor.version,
          repoint.referenceKey,
          repoint.expectedVersion,
          repoint.from.kind,
          repoint.from.id
        ), 'stale_reference');
      }
      changedExactlyOnce(sqlite.query<never, [number, string, string, string, string, number, string, number, string]>(`
        UPDATE program_vocabulary_trial_test_contributors
           SET guard_version = ?, guard_digest = ?
         WHERE workspace_id = ? AND event_id = ?
           AND contributor_key = ? AND contributor_version = ?
           AND guard_id = ? AND guard_version = ? AND guard_digest = ?
      `).run(
        nextContributor.guard.version,
        nextContributor.guard.digest,
        plan.scope.workspaceId,
        plan.scope.eventId,
        plannedContributor.contributor.key,
        plannedContributor.contributor.version,
        plannedContributor.guard.id,
        plannedContributor.guard.version,
        plannedContributor.guard.digest
      ), 'stale_reference');
    }
  }
}

export async function planProgramVocabularyTrialOperation(input: {
  readonly store: SQLiteProgramVocabularyTrialStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly authorInput: ProgramVocabularyAuthorInput;
  readonly dependencyGroup?: string;
  readonly compensationLineage?: CompensationLineage;
}): Promise<FrozenChangesetOperation> {
  const sqlite = databaseFor(input.store);
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_trial_nested_snapshot');
  sqlite.exec('BEGIN DEFERRED;');
  try {
    const operation = await planChangesetOperation({
      registry: input.registry,
      kind: PROGRAM_VOCABULARY_CHANGESET_KIND,
      version: PROGRAM_VOCABULARY_CHANGESET_VERSION,
      authorInput: input.authorInput,
      dependencyGroup: input.dependencyGroup ?? 'program_vocabulary',
      snapshot: input.store.planningSnapshot(),
      ...(input.compensationLineage === undefined
        ? {}
        : { compensationLineage: input.compensationLineage })
    });
    sqlite.exec('COMMIT;');
    return operation;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

export type ProgramVocabularyTrialFailurePoint =
  | 'after_apply'
  | 'after_evidence'
  | 'after_timeline';

export interface ProgramVocabularyTrialCommitEvidence {
  readonly changeEvidenceId: string;
  readonly receiptEvidenceId: OperationReceiptId;
  readonly factEvidenceId: string;
  readonly timelineId: string;
  readonly occurredAtMs: number;
}

export interface ProgramVocabularyTrialExactCommitInput {
  readonly expectedHeadVersion: number;
  readonly expectedRevisionDigest: string;
  readonly now: string;
  readonly approvalRequirement: 'none' | 'distinct_current_human';
  readonly approval?: ApprovalReceipt;
  readonly approverCurrentlyAuthorized?: boolean;
}

export type ProgramVocabularyTrialCommitResult =
  | {
      readonly kind: 'applied';
      readonly contributions: readonly ChangesetApplyContribution<unknown>[];
      readonly committedHead: ChangesetHead;
      readonly committedSource: CommittedChangesetSource;
    }
  | {
      readonly kind: 'outcome';
      readonly outcome: StructuredOutcome;
    }
  | {
      readonly kind: 'commit_refused';
      readonly refusal: CommitRefusal;
    };

function operationScope(operation: FrozenChangesetOperation): ProgramVocabularyScopeDto {
  if (operation.kind !== PROGRAM_VOCABULARY_CHANGESET_KIND
      || operation.version !== PROGRAM_VOCABULARY_CHANGESET_VERSION
      || operation.plan === null || typeof operation.plan !== 'object'
      || Array.isArray(operation.plan)) {
    throw new TypeError('invalid_program_vocabulary_trial_operation');
  }
  const mutation = (operation.plan as Record<string, unknown>).mutation;
  if (mutation === null || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw new TypeError('invalid_program_vocabulary_trial_operation');
  }
  return programVocabularyScopeSchema.parse((mutation as Record<string, unknown>).scope);
}

function assertEvidence(evidence: ProgramVocabularyTrialCommitEvidence): void {
  const ids = [
    evidence.changeEvidenceId,
    evidence.receiptEvidenceId,
    evidence.factEvidenceId,
    evidence.timelineId
  ];
  if (ids.some((id) => id.length === 0 || id.length > 300)) {
    throw new TypeError('invalid_program_vocabulary_trial_evidence_id');
  }
  if (!Number.isSafeInteger(evidence.occurredAtMs) || evidence.occurredAtMs < 0) {
    throw new TypeError('invalid_program_vocabulary_trial_occurred_at');
  }
}

function currentExactCommitBasis(
  store: SQLiteProgramVocabularyTrialStore,
  head: ChangesetHead
): {
  readonly operation: FrozenChangesetOperation;
  readonly revision: ChangesetHead['revisions'][number];
  readonly scope: ProgramVocabularyScopeDto;
  readonly aggregateVersions: ReadonlyMap<string, number>;
  readonly guardVersions: ReadonlyMap<string, number>;
  readonly guardDigests: ReadonlyMap<string, string>;
} {
  const revision = head.revisions.at(-1);
  const operation = revision?.operations[0];
  if (!revision || revision.operations.length !== 1 || !operation) {
    throw new TypeError('program_vocabulary_trial_requires_one_operation');
  }
  const scope = operationScope(operation);
  if (head.workspaceId !== scope.workspaceId || head.eventId !== scope.eventId) {
    throw new TypeError('program_vocabulary_trial_head_scope_mismatch');
  }
  const state = store.readVocabulary(scope);
  if (!state) throw new ProgramVocabularyPlanningError('wrong_scope');
  const aggregateVersions = new Map<string, number>();
  for (const item of programVocabularyItems(state)) {
    aggregateVersions.set(
      programVocabularyAggregateId(plannedProgramVocabularyItem(item)),
      item.version
    );
  }
  const guardDigests = new Map<string, string>([[
    programVocabularySetGuardId(scope.eventId),
    programVocabularySetDigest(state)
  ]]);
  const guardVersions = new Map<string, number>([[
    programVocabularySetGuardId(scope.eventId),
    state.setVersion
  ]]);
  if (operation.guardRefs.some((guard) => guard.id.startsWith('program_reference:'))) {
    const references = store.referenceRegistry.capture(state.scope, store);
    for (const contribution of references.contributors) {
      guardVersions.set(contribution.guard.id, contribution.guard.version);
      guardDigests.set(contribution.guard.id, contribution.guard.digest);
    }
  }
  return { operation, revision, scope, aggregateVersions, guardVersions, guardDigests };
}

function injectFailure(point: ProgramVocabularyTrialFailurePoint | undefined, at: ProgramVocabularyTrialFailurePoint): void {
  if (point === at) throw new Error(`injected_program_vocabulary_trial_failure:${at}`);
}

function exactValidationInput(
  exact: ProgramVocabularyTrialExactCommitInput,
  currentAggregateVersions: ReadonlyMap<string, number>,
  currentGuardVersions: ReadonlyMap<string, number>,
  currentGuardDigests: ReadonlyMap<string, string>
): CommitValidationInput {
  return {
    expectedHeadVersion: exact.expectedHeadVersion,
    expectedRevisionDigest: exact.expectedRevisionDigest,
    currentAggregateVersions,
    currentGuardVersions,
    currentGuardDigests,
    now: exact.now,
    approvalRequirement: exact.approvalRequirement,
    ...(exact.approval === undefined ? {} : { approval: exact.approval }),
    ...(exact.approverCurrentlyAuthorized === undefined
      ? {}
      : { approverCurrentlyAuthorized: exact.approverCurrentlyAuthorized })
  };
}

export async function executeProgramVocabularyTrialCommit(input: {
  readonly store: SQLiteProgramVocabularyTrialStore;
  readonly registry: ChangesetDefinitionRegistry;
  readonly proposedHead: ChangesetHead;
  readonly exactCommit: ProgramVocabularyTrialExactCommitInput;
  readonly evidence: ProgramVocabularyTrialCommitEvidence;
  readonly failAt?: ProgramVocabularyTrialFailurePoint;
}): Promise<ProgramVocabularyTrialCommitResult> {
  const sqlite = databaseFor(input.store);
  if (sqlite.inTransaction) throw new TypeError('program_vocabulary_trial_nested_commit');
  assertEvidence(input.evidence);
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const integrity = validateExactCommit(
      input.proposedHead,
      exactValidationInput(input.exactCommit, new Map(), new Map(), new Map())
    );
    if (integrity.kind === 'refused'
        && integrity.refusal.kind !== 'base_version_changed'
        && integrity.refusal.kind !== 'guard_changed') {
      sqlite.exec('ROLLBACK;');
      return { kind: 'commit_refused', refusal: integrity.refusal };
    }
    const basis = currentExactCommitBasis(input.store, input.proposedHead);
    const exact = validateExactCommit(
      input.proposedHead,
      exactValidationInput(
        input.exactCommit,
        basis.aggregateVersions,
        basis.guardVersions,
        basis.guardDigests
      )
    );
    if (exact.kind === 'refused') {
      sqlite.exec('ROLLBACK;');
      return { kind: 'commit_refused', refusal: exact.refusal };
    }
    const prepared = await prepareChangesetCommit({
      registry: input.registry,
      authorization: exact.authorization,
      transaction: input.store.transactionPort()
    });
    if (prepared.kind === 'outcome') {
      sqlite.exec('ROLLBACK;');
      return prepared;
    }
    const contributions = await applyPreparedChangeset(prepared.prepared);
    injectFailure(input.failAt, 'after_apply');
    const contribution = contributions[0];
    const fact = contribution?.facts[0];
    if (contributions.length !== 1 || !contribution || contribution.facts.length !== 1
        || !fact || contribution.effects.length !== 0) {
      throw new TypeError('unexpected_program_vocabulary_trial_contribution');
    }
    const committed = markChangesetCommitted(
      input.proposedHead,
      exact.authorization,
      input.evidence.receiptEvidenceId
    );
    sqlite.query<never, [string, string, string, string, string, string, number, string, string, number, string]>(`
      INSERT INTO program_vocabulary_trial_commit_evidence (
        change_evidence_id, receipt_evidence_id, fact_evidence_id,
        revision_id, revision_digest, operation_kind, operation_version,
        result_json, fact_kind, fact_version, fact_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.evidence.changeEvidenceId,
      input.evidence.receiptEvidenceId,
      input.evidence.factEvidenceId,
      basis.revision.id,
      basis.revision.digest,
      basis.operation.kind,
      basis.operation.version,
      canonicalJsonText(contribution.result),
      fact.kind,
      fact.version,
      canonicalJsonText(fact.payload)
    );
    injectFailure(input.failAt, 'after_evidence');
    sqlite.query<never, [string, number, string, string, string, string, string]>(`
      INSERT INTO program_vocabulary_trial_timeline_spine (
        timeline_id, occurred_at_ms, workspace_id, event_id,
        change_evidence_id, receipt_evidence_id, fact_evidence_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.evidence.timelineId,
      input.evidence.occurredAtMs,
      basis.scope.workspaceId,
      basis.scope.eventId,
      input.evidence.changeEvidenceId,
      input.evidence.receiptEvidenceId,
      input.evidence.factEvidenceId
    );
    injectFailure(input.failAt, 'after_timeline');
    sqlite.exec('COMMIT;');
    return {
      kind: 'applied',
      contributions,
      committedHead: committed.head,
      committedSource: committed.source
    };
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

export function captureProgramVocabularyTrialReferences(
  store: SQLiteProgramVocabularyTrialStore,
  scope: ProgramVocabularyScopeDto
): CompleteProgramReferenceSnapshot {
  const state = store.readVocabulary(scope);
  if (!state) throw new ProgramVocabularyPlanningError('wrong_scope');
  return store.referenceRegistry.capture(state.scope, store);
}
