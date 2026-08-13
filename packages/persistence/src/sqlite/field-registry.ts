import type { Database } from 'bun:sqlite';
import {
  fieldRegistryScopeSchema,
  type FieldRegistryChangeResult,
  type FieldRegistryOptionSource,
  type FieldRegistryScopeDto,
  type FieldRegistrySnapshotDto
} from '@jooevents/contracts';
import type {
  EventDependencyContributorRef,
  EventDependencyScope,
  EventDependencySnapshotSource
} from '@jooevents/event';
import {
  FieldRegistryPlanningError,
  applyFieldRegistryMutationPlan,
  createCanonicalFieldRegistryBaseline,
  fieldRegistryAggregateId,
  fieldRegistryStateDigest,
  parseFieldRegistryState,
  projectFieldRegistrySnapshot,
  validateFieldRegistryMutationPlan,
  type CanonicalFieldRegistryBaselineIds,
  type FieldRegistryFormReference,
  type FieldRegistryFormReferenceResolver,
  type FieldRegistryLiveOption,
  type FieldRegistryLiveOptionSource,
  type FieldRegistryMutationPlan,
  type FieldRegistryReadPort,
  type FieldRegistryState,
  type FieldRegistryTransactionPort
} from '@jooevents/field-registry';
import { canonicalJsonSha256 } from '@jooevents/changesets';
import { canonicalJsonText } from '@jooevents/kernel';

/** Additive schema installed only in an explicitly disposable SQLite runtime. */
export const FIELD_REGISTRY_SQL = `
CREATE TABLE field_registry_aggregates (
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT NOT NULL CHECK(length(event_id) = 36),
  registry_version INTEGER NOT NULL CHECK(registry_version > 0),
  state_json TEXT NOT NULL CHECK(
    json_valid(state_json)
    AND json_extract(state_json, '$.scope.workspaceId') = workspace_id
    AND json_extract(state_json, '$.scope.eventId') = event_id
    AND json_extract(state_json, '$.version') = registry_version
  ),
  state_digest_sha256 TEXT NOT NULL CHECK(
    length(state_digest_sha256) = 64
    AND state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  baseline_digest_sha256 TEXT NOT NULL CHECK(
    length(baseline_digest_sha256) = 64
    AND baseline_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (registry_version > 1 OR baseline_digest_sha256 = state_digest_sha256)
  ),
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, event_id, registry_version, state_digest_sha256),
  FOREIGN KEY (workspace_id, event_id)
    REFERENCES event_spine_scope_roots(workspace_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER field_registry_scope_immutable
BEFORE UPDATE OF workspace_id, event_id ON field_registry_aggregates
BEGIN SELECT RAISE(ABORT, 'field registry scope is immutable'); END;

CREATE TRIGGER field_registry_baseline_immutable
BEFORE UPDATE OF baseline_digest_sha256 ON field_registry_aggregates
BEGIN SELECT RAISE(ABORT, 'field registry baseline is immutable'); END;

CREATE TRIGGER field_registry_version_monotonic
BEFORE UPDATE ON field_registry_aggregates
WHEN NEW.registry_version != OLD.registry_version + 1
BEGIN SELECT RAISE(ABORT, 'field registry version must advance exactly once'); END;
`;

interface AggregateRow {
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly registry_version: unknown;
  readonly state_json: unknown;
  readonly state_digest_sha256: unknown;
  readonly baseline_digest_sha256: unknown;
}

interface ParsedAggregate {
  readonly state: FieldRegistryState;
  readonly currentDigestSha256: string;
  readonly baselineDigestSha256: string;
}

interface FormHeadRow {
  readonly form_id: unknown;
  readonly head_version: unknown;
}

interface VocabularyRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly status: unknown;
  readonly version: unknown;
}

export class SQLiteFieldRegistryError extends Error {
  constructor(readonly code:
    | 'transaction_required'
    | 'event_scope_missing'
    | 'field_registry_exists'
    | 'field_registry_data_corrupt'
  , cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'SQLiteFieldRegistryError';
  }
}

function parseRow(row: AggregateRow): ParsedAggregate {
  try {
    if (typeof row.state_json !== 'string'
        || typeof row.state_digest_sha256 !== 'string'
        || typeof row.baseline_digest_sha256 !== 'string'
        || typeof row.workspace_id !== 'string'
        || typeof row.event_id !== 'string'
        || typeof row.registry_version !== 'number'
        || !Number.isSafeInteger(row.registry_version)) {
      throw new TypeError('field_registry_columns_invalid');
    }
    const state = parseFieldRegistryState(JSON.parse(row.state_json));
    if (canonicalJsonText(state) !== row.state_json
        || fieldRegistryStateDigest(state) !== row.state_digest_sha256
        || state.scope.workspaceId !== row.workspace_id
        || state.scope.eventId !== row.event_id
        || state.version !== row.registry_version
        || !/^[a-f0-9]{64}$/.test(row.baseline_digest_sha256)
        || (state.version === 1 && row.baseline_digest_sha256 !== row.state_digest_sha256)) {
      throw new TypeError('field_registry_columns_mismatch');
    }
    return Object.freeze({
      state,
      currentDigestSha256: row.state_digest_sha256,
      baselineDigestSha256: row.baseline_digest_sha256
    });
  } catch (error) {
    if (error instanceof SQLiteFieldRegistryError) throw error;
    throw new SQLiteFieldRegistryError('field_registry_data_corrupt', error);
  }
}

export function installFieldRegistrySchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new SQLiteFieldRegistryError('transaction_required');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.transaction(() => sqlite.exec(FIELD_REGISTRY_SQL)).immediate();
}

/**
 * Seeds the canonical registry exactly once when an event is created. Callers own
 * the surrounding event transaction and deterministic application UUID factory.
 */
export function initializeCanonicalFieldRegistry(input: {
  readonly sqlite: Database;
  readonly scope: FieldRegistryScopeDto;
  readonly ids: CanonicalFieldRegistryBaselineIds;
}): FieldRegistryState {
  if (!input.sqlite.inTransaction) throw new SQLiteFieldRegistryError('transaction_required');
  const scope = fieldRegistryScopeSchema.parse(input.scope);
  const root = input.sqlite.query<{ readonly event_id: unknown }, [string, string]>(`
    SELECT event_id FROM event_spine_scope_roots
     WHERE workspace_id = ? AND event_id = ?
  `).get(scope.workspaceId, scope.eventId);
  if (!root || root.event_id !== scope.eventId) {
    throw new SQLiteFieldRegistryError('event_scope_missing');
  }
  const state = createCanonicalFieldRegistryBaseline({ scope, ids: input.ids });
  const stateDigestSha256 = fieldRegistryStateDigest(state);
  const result = input.sqlite.query<never, [string, string, number, string, string, string]>(`
    INSERT OR IGNORE INTO field_registry_aggregates (
      workspace_id, event_id, registry_version, state_json,
      state_digest_sha256, baseline_digest_sha256
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    scope.workspaceId,
    scope.eventId,
    state.version,
    canonicalJsonText(state),
    stateDigestSha256,
    stateDigestSha256
  );
  if (result.changes !== 1) throw new SQLiteFieldRegistryError('field_registry_exists');
  return state;
}

/**
 * Narrow Event-create collaborator. The captured SQLite handle and transaction
 * requirement make baseline creation part of the caller's existing Event UoW.
 */
export interface SQLiteFieldRegistryEventInitializer {
  initializeCreatedEvent(scope: FieldRegistryScopeDto): FieldRegistryState;
}

export function createSQLiteFieldRegistryEventInitializer(input: {
  readonly sqlite: Database;
  readonly ids: CanonicalFieldRegistryBaselineIds;
}): SQLiteFieldRegistryEventInitializer {
  if (typeof input.ids.newFieldId !== 'function' || typeof input.ids.newChoiceId !== 'function') {
    throw new TypeError('field_registry_baseline_ids_invalid');
  }
  const ids = Object.freeze({
    newFieldId: input.ids.newFieldId.bind(input.ids),
    newChoiceId: input.ids.newChoiceId.bind(input.ids)
  });
  return Object.freeze({
    initializeCreatedEvent(scope: FieldRegistryScopeDto) {
      return initializeCanonicalFieldRegistry({ sqlite: input.sqlite, scope, ids });
    }
  });
}

export const FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR = Object.freeze({
  key: 'field_registry.event_dependencies',
  version: 1
}) satisfies EventDependencyContributorRef;

function dependencyGuardDigest(input: {
  readonly baselineDigestSha256: string | null;
  readonly currentDigestSha256: string | null;
}): string {
  return canonicalJsonSha256({ schemaVersion: 1, ...input });
}

/**
 * Event creation preflight sees an absent, nonblocking contributor before the
 * Event root exists. Once the root exists, a missing registry fails closed.
 * The untouched canonical baseline is structural; any later registry version
 * is meaningful dependent state and blocks exact Event-create compensation.
 */
export class SQLiteFieldRegistryEventDependencySource
implements EventDependencySnapshotSource {
  constructor(private readonly sqlite: Database) {}

  readContributor(
    contributor: EventDependencyContributorRef,
    scopeInput: EventDependencyScope
  ): unknown {
    if (contributor.key !== FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR.key
        || contributor.version !== FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR.version) {
      return undefined;
    }
    const scope = fieldRegistryScopeSchema.parse(scopeInput);
    const rows = this.sqlite.query<AggregateRow, [string, string]>(`
      SELECT workspace_id, event_id, registry_version, state_json,
             state_digest_sha256, baseline_digest_sha256
        FROM field_registry_aggregates
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteFieldRegistryError('field_registry_data_corrupt');
    const aggregate = rows[0] ? parseRow(rows[0]) : undefined;
    if (!aggregate) {
      const roots = this.sqlite.query<{ readonly event_id: unknown }, [string, string]>(`
        SELECT event_id FROM event_spine_scope_roots
         WHERE workspace_id = ? AND event_id = ?
         ORDER BY workspace_id, event_id LIMIT 2
      `).all(scope.workspaceId, scope.eventId);
      if (roots.length !== 0) return undefined;
      return Object.freeze({
        contributor: FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR,
        scope,
        guard: Object.freeze({
          id: `event_dependency:field_registry:${scope.eventId}`,
          version: 1,
          digest: dependencyGuardDigest({
            baselineDigestSha256: null,
            currentDigestSha256: null
          })
        }),
        dependencies: Object.freeze([])
      });
    }
    const untouchedBaseline = aggregate.state.version === 1
      && aggregate.currentDigestSha256 === aggregate.baselineDigestSha256;
    return Object.freeze({
      contributor: FIELD_REGISTRY_EVENT_DEPENDENCY_CONTRIBUTOR,
      scope,
      guard: Object.freeze({
        id: `event_dependency:field_registry:${scope.eventId}`,
        version: aggregate.state.version,
        digest: dependencyGuardDigest({
          baselineDigestSha256: aggregate.baselineDigestSha256,
          currentDigestSha256: aggregate.currentDigestSha256
        })
      }),
      dependencies: Object.freeze(untouchedBaseline ? [] : [{
        referenceKey: `field_registry:${scope.eventId}`,
        version: aggregate.state.version,
        destination: Object.freeze({
          kind: 'field_registry',
          id: fieldRegistryAggregateId(scope.eventId)
        })
      }])
    });
  }
}

export class SQLiteIntakeFieldRegistryFormReferenceResolver
implements FieldRegistryFormReferenceResolver {
  constructor(private readonly sqlite: Database) {}

  resolveFormReference(
    scopeInput: FieldRegistryScopeDto,
    formId: string
  ): FieldRegistryFormReference | undefined {
    const scope = fieldRegistryScopeSchema.parse(scopeInput);
    const row = this.sqlite.query<FormHeadRow, [string, string, string]>(`
      SELECT form_id, head_version FROM intake_form_heads
       WHERE workspace_id = ? AND event_id = ? AND form_id = ?
    `).get(scope.workspaceId, scope.eventId, formId);
    if (!row) return undefined;
    if (row.form_id !== formId || typeof row.head_version !== 'number'
        || !Number.isSafeInteger(row.head_version) || row.head_version <= 0) {
      throw new SQLiteFieldRegistryError('field_registry_data_corrupt');
    }
    return Object.freeze({ id: formId, version: row.head_version });
  }
}

/** Resolves option-source references at read time; values are never copied into fields. */
export class SQLiteProgramVocabularyFieldOptionSource
implements FieldRegistryLiveOptionSource {
  constructor(private readonly sqlite: Database) {}

  readLiveOptions(
    scopeInput: FieldRegistryScopeDto,
    source: FieldRegistryOptionSource
  ): readonly FieldRegistryLiveOption[] {
    const scope = fieldRegistryScopeSchema.parse(scopeInput);
    const table = source === 'tracks' ? 'program_vocabulary_tracks' : 'program_vocabulary_formats';
    try {
      return this.sqlite.query<VocabularyRow, [string, string]>(`
        SELECT id, name, status, version FROM ${table}
         WHERE workspace_id = ? AND event_id = ?
         ORDER BY id COLLATE BINARY
      `).all(scope.workspaceId, scope.eventId).map((row) => {
        if (typeof row.id !== 'string' || typeof row.name !== 'string'
            || (row.status !== 'active' && row.status !== 'retired')
            || typeof row.version !== 'number' || !Number.isSafeInteger(row.version)
            || row.version <= 0) {
          throw new TypeError('program_vocabulary_option_invalid');
        }
        return Object.freeze({
          id: row.id,
          label: row.name,
          status: row.status,
          version: row.version
        });
      });
    } catch (error) {
      if (error instanceof SQLiteFieldRegistryError) throw error;
      throw new SQLiteFieldRegistryError('field_registry_data_corrupt', error);
    }
  }
}

export class SQLiteFieldRegistryRepository
implements FieldRegistryReadPort, FieldRegistryTransactionPort {
  constructor(
    private readonly sqlite: Database,
    readonly formReferences: FieldRegistryFormReferenceResolver
  ) {}

  resolveFormReference(scope: FieldRegistryScopeDto, formId: string) {
    return this.formReferences.resolveFormReference(scope, formId);
  }

  readFieldRegistry(scopeInput: FieldRegistryScopeDto): FieldRegistryState | undefined {
    const scope = fieldRegistryScopeSchema.parse(scopeInput);
    const rows = this.sqlite.query<AggregateRow, [string, string]>(`
      SELECT workspace_id, event_id, registry_version, state_json, state_digest_sha256
             , baseline_digest_sha256
        FROM field_registry_aggregates
       WHERE workspace_id = ? AND event_id = ?
       ORDER BY workspace_id, event_id LIMIT 2
    `).all(scope.workspaceId, scope.eventId);
    if (rows.length > 1) throw new SQLiteFieldRegistryError('field_registry_data_corrupt');
    return rows[0] ? parseRow(rows[0]).state : undefined;
  }

  applyFieldRegistryPlan(plan: FieldRegistryMutationPlan): FieldRegistryChangeResult {
    if (!this.sqlite.inTransaction) throw new SQLiteFieldRegistryError('transaction_required');
    const current = this.readFieldRegistry(plan.scope);
    if (!current) throw new FieldRegistryPlanningError('wrong_scope');
    const refusal = validateFieldRegistryMutationPlan({
      state: current,
      plan,
      formReferences: this
    });
    if (refusal) throw new FieldRegistryPlanningError(refusal);
    const applied = applyFieldRegistryMutationPlan({
      state: current,
      plan,
      formReferences: this
    });
    const result = this.sqlite.query<never, [number, string, string, string, string, number, string]>(`
      UPDATE field_registry_aggregates
         SET registry_version = ?, state_json = ?, state_digest_sha256 = ?
       WHERE workspace_id = ? AND event_id = ?
         AND registry_version = ? AND state_digest_sha256 = ?
    `).run(
      applied.state.version,
      canonicalJsonText(applied.state),
      fieldRegistryStateDigest(applied.state),
      plan.scope.workspaceId,
      plan.scope.eventId,
      current.version,
      fieldRegistryStateDigest(current)
    );
    if (result.changes !== 1) throw new FieldRegistryPlanningError('stale_registry');
    return applied.result;
  }
}

export class SQLiteFieldRegistrySnapshotSource {
  constructor(
    readonly repository: SQLiteFieldRegistryRepository,
    readonly optionSource: FieldRegistryLiveOptionSource
  ) {}

  readSnapshot(scope: FieldRegistryScopeDto): FieldRegistrySnapshotDto | undefined {
    const state = this.repository.readFieldRegistry(scope);
    return state ? projectFieldRegistrySnapshot({ state, optionSource: this.optionSource }) : undefined;
  }
}
