import type {
  AirtableBaseId,
  AirtableDataPort,
  AirtableFieldSchema,
  AirtableRecordId,
  AirtableTableSchema,
  AirtableWorkspaceId
} from '@jooevents/airtable';
import type {
  ManagedBaseManifest,
  ManagedProjectedRecord,
  ManagedSchemaBinding,
  SnapshotRecordLink
} from './manifest';
import { bindManagedSchema, projectSnapshotBatch, toAirtableCreateTables } from './manifest';

export type ManagedSchemaUpgradeAssessment =
  | Readonly<{ kind: 'ready'; binding: ManagedSchemaBinding }>
  | Readonly<{
      kind: 'add_field';
      tableKey: string;
      tableId: AirtableTableSchema['id'];
      fieldKey: string;
      field: ManagedBaseManifest['tables'][number]['fields'][number];
    }>
  | Readonly<{ kind: 'attention'; code: string; tableKey?: string; fieldKey?: string }>;

/**
 * Plans one additive change for a base already known to be managed by this
 * connection. It never adopts a merely same-named table and never changes or
 * removes an existing field.
 */
export function assessManagedSchemaUpgrade(input: Readonly<{
  manifest: ManagedBaseManifest;
  schema: import('@jooevents/airtable').AirtableBaseSchema;
}>): ManagedSchemaUpgradeAssessment {
  for (const expectedTable of input.manifest.tables) {
    const tables = input.schema.tables.filter((table) => table.name === expectedTable.name);
    if (tables.length !== 1) {
      return Object.freeze({
        kind: 'attention' as const,
        code: tables.length === 0 ? 'managed_table_missing' : 'managed_table_name_ambiguous',
        tableKey: expectedTable.key
      });
    }
    const table = tables[0]!;
    for (const [fieldIndex, expectedField] of expectedTable.fields.entries()) {
      const fields = table.fields.filter((field) => field.name === expectedField.name);
      if (fields.length > 1) {
        return Object.freeze({
          kind: 'attention' as const,
          code: 'managed_field_name_ambiguous',
          tableKey: expectedTable.key,
          fieldKey: expectedField.key
        });
      }
      if (fields.length === 0) {
        if (fieldIndex === 0) {
          return Object.freeze({
            kind: 'attention' as const,
            code: 'managed_primary_field_missing',
            tableKey: expectedTable.key,
            fieldKey: expectedField.key
          });
        }
        return Object.freeze({
          kind: 'add_field' as const,
          tableKey: expectedTable.key,
          tableId: table.id,
          fieldKey: expectedField.key,
          field: expectedField
        });
      }
      if (fields[0]!.type !== expectedField.type) {
        return Object.freeze({
          kind: 'attention' as const,
          code: 'managed_field_type_changed',
          tableKey: expectedTable.key,
          fieldKey: expectedField.key
        });
      }
    }
  }
  const bound = bindManagedSchema(input.manifest, input.schema);
  return bound.kind === 'bound'
    ? Object.freeze({ kind: 'ready' as const, binding: bound.binding })
    : Object.freeze({
        kind: 'attention' as const,
        code: `managed_schema_${bound.code}`,
        ...(bound.tableKey ? { tableKey: bound.tableKey } : {}),
        ...(bound.fieldKey ? { fieldKey: bound.fieldKey } : {})
      });
}

export type ManagedSchemaUpgradeStepResult =
  | Readonly<{ kind: 'advanced'; tableKey: string; fieldKey: string }>
  | Readonly<{ kind: 'ready'; binding: ManagedSchemaBinding }>
  | Readonly<{ kind: 'attention'; code: string; tableKey?: string; fieldKey?: string }>;

/** Re-reads before every additive step, making acceptance-unknown field creation resumable. */
export async function runManagedSchemaUpgradeStep(input: Readonly<{
  manifest: ManagedBaseManifest;
  baseId: import('@jooevents/airtable').AirtableBaseId;
  provider: AirtableDataPort;
}>): Promise<ManagedSchemaUpgradeStepResult> {
  const observed = await input.provider.getBaseSchema({ baseId: input.baseId });
  if (observed.kind === 'failure') {
    return Object.freeze({ kind: 'attention', code: `schema_upgrade_${observed.failure.code}` });
  }
  const assessment = assessManagedSchemaUpgrade({ manifest: input.manifest, schema: observed.value });
  if (assessment.kind !== 'add_field') return assessment;
  const created = await input.provider.createField({
    baseId: input.baseId,
    tableId: assessment.tableId,
    field: {
      name: assessment.field.name,
      type: assessment.field.type,
      ...(assessment.field.description ? { description: assessment.field.description } : {}),
      ...(assessment.field.options ? { options: assessment.field.options } : {})
    }
  });
  if (created.kind === 'success') {
    return Object.freeze({
      kind: 'advanced', tableKey: assessment.tableKey, fieldKey: assessment.fieldKey
    });
  }
  if (created.failure.retry !== 'reconcile_first') {
    return Object.freeze({
      kind: 'attention', code: `schema_upgrade_${created.failure.code}`,
      tableKey: assessment.tableKey, fieldKey: assessment.fieldKey
    });
  }
  const reconciled = await input.provider.getBaseSchema({ baseId: input.baseId });
  if (reconciled.kind === 'failure') {
    return Object.freeze({
      kind: 'attention', code: 'schema_upgrade_acceptance_unknown',
      tableKey: assessment.tableKey, fieldKey: assessment.fieldKey
    });
  }
  const matchingTable = reconciled.value.tables.find((table) => table.id === assessment.tableId);
  const matchingFields: readonly AirtableFieldSchema[] = matchingTable?.fields.filter((field) =>
    field.name === assessment.field.name && field.type === assessment.field.type
  ) ?? [];
  return matchingFields.length === 1
    ? Object.freeze({ kind: 'advanced', tableKey: assessment.tableKey, fieldKey: assessment.fieldKey })
    : Object.freeze({
        kind: 'attention', code: 'schema_upgrade_acceptance_unknown',
        tableKey: assessment.tableKey, fieldKey: assessment.fieldKey
      });
}

export type ManagedProvisioningPhase =
  | 'create_base'
  | 'inspect_base'
  | 'create_tables'
  | 'snapshot'
  | 'verify'
  | 'ready'
  | 'attention';

export interface ManagedProvisioningTableState {
  readonly tableKey: string;
  readonly snapshotCursor?: string;
  readonly snapshotComplete: boolean;
  readonly projectedCount: number;
  readonly verifyOffset?: string;
  readonly verifyComplete: boolean;
  readonly verifiedCount: number;
}

export interface ManagedProvisioningState {
  readonly connectionId: string;
  readonly manifestVersion: number;
  readonly manifestDigestSha256: string;
  readonly mode: 'create_base' | 'selected_base';
  readonly providerWorkspaceId?: AirtableWorkspaceId;
  readonly baseName?: string;
  readonly providerBaseId?: AirtableBaseId;
  readonly createdTableKeys: readonly string[];
  readonly phase: ManagedProvisioningPhase;
  readonly binding?: ManagedSchemaBinding;
  readonly tables: readonly ManagedProvisioningTableState[];
  readonly attentionCode?: string;
  readonly version: number;
}

export interface ManagedProvisioningClaim {
  readonly state: ManagedProvisioningState;
  readonly workerId: string;
  readonly leaseVersion: number;
}

export interface ManagedProvisioningRepository {
  claim(input: Readonly<{
    connectionId: string;
    workerId: string;
    nowMs: number;
    leaseMs: number;
  }>): Promise<ManagedProvisioningClaim | undefined>;
  complete(input: Readonly<{
    claim: ManagedProvisioningClaim;
    nextState: ManagedProvisioningState;
    links: readonly SnapshotRecordLink[];
    nowMs: number;
  }>): Promise<boolean>;
}

export interface ManagedSnapshotSource {
  listPage(input: Readonly<{
    connectionId: string;
    tableKey: string;
    cursor?: string;
    limit: 10;
  }>): Promise<Readonly<{
    records: readonly ManagedProjectedRecord[];
    nextCursor?: string;
  }>>;
}

export function createManagedProvisioningState(input: Readonly<{
  connectionId: string;
  providerWorkspaceId: AirtableWorkspaceId;
  baseName: string;
  manifest: ManagedBaseManifest;
}>): ManagedProvisioningState {
  if (!input.connectionId || input.connectionId.length > 256
    || input.baseName.trim() !== input.baseName || input.baseName.length < 1 || input.baseName.length > 255) {
    throw new TypeError('managed_provisioning_input_invalid');
  }
  return Object.freeze({
    connectionId: input.connectionId,
    manifestVersion: input.manifest.version,
    manifestDigestSha256: input.manifest.digestSha256,
    mode: 'create_base',
    providerWorkspaceId: input.providerWorkspaceId,
    baseName: input.baseName,
    phase: 'create_base',
    createdTableKeys: Object.freeze([]),
    tables: Object.freeze(input.manifest.tables.map((table) => Object.freeze({
      tableKey: table.key,
      snapshotComplete: false,
      projectedCount: 0,
      verifyComplete: false,
      verifiedCount: 0
    }))),
    version: 1
  });
}

export function createManagedSelectedBaseProvisioningState(input: Readonly<{
  connectionId: string;
  providerBaseId: AirtableBaseId;
  baseName?: string;
  manifest: ManagedBaseManifest;
}>): ManagedProvisioningState {
  if (!input.connectionId || input.connectionId.length > 256) {
    throw new TypeError('managed_provisioning_input_invalid');
  }
  return Object.freeze({
    connectionId: input.connectionId,
    manifestVersion: input.manifest.version,
    manifestDigestSha256: input.manifest.digestSha256,
    mode: 'selected_base',
    providerBaseId: input.providerBaseId,
    ...(input.baseName === undefined ? {} : { baseName: input.baseName }),
    phase: 'inspect_base',
    createdTableKeys: Object.freeze([]),
    tables: Object.freeze(input.manifest.tables.map((table) => Object.freeze({
      tableKey: table.key,
      snapshotComplete: false,
      projectedCount: 0,
      verifyComplete: false,
      verifiedCount: 0
    }))),
    version: 1
  });
}

function replaceTable(
  state: ManagedProvisioningState,
  tableKey: string,
  update: (table: ManagedProvisioningTableState) => ManagedProvisioningTableState
): readonly ManagedProvisioningTableState[] {
  return Object.freeze(state.tables.map((table) => table.tableKey === tableKey
    ? Object.freeze(update(table)) : table));
}

function advance(
  state: ManagedProvisioningState,
  patch: Partial<Omit<ManagedProvisioningState, 'version'>>
): ManagedProvisioningState {
  return Object.freeze({ ...state, ...patch, version: state.version + 1 });
}

function attention(state: ManagedProvisioningState, code: string): ManagedProvisioningState {
  return advance(state, { phase: 'attention', attentionCode: code });
}

function tableMatchesManagedDefinition(
  expected: ManagedBaseManifest['tables'][number],
  actual: AirtableTableSchema
): boolean {
  if (actual.name !== expected.name || actual.fields.length !== expected.fields.length
    || !actual.views.some((view) => view.type === 'grid')) return false;
  return expected.fields.every((field) => {
    const matches = actual.fields.filter((candidate) => candidate.name === field.name);
    return matches.length === 1 && matches[0]!.type === field.type;
  });
}

export type ManagedProvisioningStepResult =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'advanced'; phase: ManagedProvisioningPhase }>
  | Readonly<{ kind: 'ready'; baseId: ManagedSchemaBinding['baseId'] }>
  | Readonly<{ kind: 'attention'; code: string }>
  | Readonly<{ kind: 'stale' }>;

export async function runManagedProvisioningStep(input: Readonly<{
  connectionId: string;
  workerId: string;
  nowMs: number;
  leaseMs: number;
  manifest: ManagedBaseManifest;
  repository: ManagedProvisioningRepository;
  provider: AirtableDataPort;
  source: ManagedSnapshotSource;
}>): Promise<ManagedProvisioningStepResult> {
  const claim = await input.repository.claim({
    connectionId: input.connectionId,
    workerId: input.workerId,
    nowMs: input.nowMs,
    leaseMs: input.leaseMs
  });
  if (!claim) return Object.freeze({ kind: 'idle' });
  const state = claim.state;
  if (state.manifestVersion !== input.manifest.version
    || state.manifestDigestSha256 !== input.manifest.digestSha256) {
    const nextState = attention(state, 'manifest_changed');
    const fenced = await input.repository.complete({ claim, nextState, links: [], nowMs: input.nowMs });
    return fenced ? { kind: 'attention', code: 'manifest_changed' } : { kind: 'stale' };
  }
  if (state.phase === 'ready') return Object.freeze({ kind: 'ready', baseId: state.binding!.baseId });
  if (state.phase === 'attention') {
    return Object.freeze({ kind: 'attention', code: state.attentionCode ?? 'provisioning_attention' });
  }

  let nextState: ManagedProvisioningState;
  let links: readonly SnapshotRecordLink[] = [];
  if (state.phase === 'create_base') {
    const created = await input.provider.createBase({
      workspaceId: state.providerWorkspaceId!,
      name: state.baseName!,
      tables: toAirtableCreateTables(input.manifest)
    });
    if (created.kind === 'failure') {
      const code = created.failure.code === 'acceptance_unknown'
        ? 'base_creation_acceptance_unknown' : `base_creation_${created.failure.code}`;
      nextState = attention(state, code);
    } else {
      const bound = bindManagedSchema(input.manifest, created.value);
      nextState = bound.kind === 'drift'
        ? attention(state, `created_schema_${bound.code}`)
        : advance(state, {
          phase: 'snapshot',
          binding: bound.binding,
          createdTableKeys: Object.freeze(input.manifest.tables.map((table) => table.key))
        });
    }
  } else if (state.phase === 'inspect_base') {
    const schema = await input.provider.getBaseSchema({ baseId: state.providerBaseId! });
    if (schema.kind === 'failure') {
      nextState = attention(state, `base_inspection_${schema.failure.code}`);
    } else {
      const reservedNames = new Set(input.manifest.tables.map((table) => table.name));
      nextState = schema.value.tables.some((table) => reservedNames.has(table.name))
        ? attention(state, 'base_managed_table_name_conflict')
        : advance(state, { phase: 'create_tables' });
    }
  } else if (state.phase === 'create_tables') {
    const schema = await input.provider.getBaseSchema({ baseId: state.providerBaseId! });
    if (schema.kind === 'failure') {
      nextState = attention(state, `table_reconciliation_${schema.failure.code}`);
    } else {
      const pending = input.manifest.tables.find((table) => !state.createdTableKeys.includes(table.key));
      if (!pending) {
        const bound = bindManagedSchema(input.manifest, schema.value);
        nextState = bound.kind === 'drift'
          ? attention(state, `created_schema_${bound.code}`)
          : advance(state, { phase: 'snapshot', binding: bound.binding });
      } else {
        const matching = schema.value.tables.filter((table) => table.name === pending.name);
        if (matching.length > 1 || (matching.length === 1
          && !tableMatchesManagedDefinition(pending, matching[0]!))) {
          nextState = attention(state, 'base_managed_table_name_conflict');
        } else if (matching.length === 1) {
          nextState = advance(state, {
            createdTableKeys: Object.freeze([...state.createdTableKeys, pending.key])
          });
        } else {
          const createInput = toAirtableCreateTables(input.manifest)
            .find((table) => table.name === pending.name)!;
          const created = await input.provider.createTable({
            baseId: state.providerBaseId!,
            table: createInput
          });
          if (created.kind === 'failure') {
            nextState = attention(state, created.failure.code === 'acceptance_unknown'
              ? 'table_creation_acceptance_unknown' : `table_creation_${created.failure.code}`);
          } else if (!tableMatchesManagedDefinition(pending, created.value)) {
            nextState = attention(state, 'created_table_schema_mismatch');
          } else {
            nextState = advance(state, {
              createdTableKeys: Object.freeze([...state.createdTableKeys, pending.key])
            });
          }
        }
      }
    }
  } else if (state.phase === 'snapshot') {
    const table = state.tables.find((candidate) => !candidate.snapshotComplete);
    if (!table) {
      nextState = advance(state, { phase: 'verify' });
    } else {
      const page = await input.source.listPage({
        connectionId: state.connectionId,
        tableKey: table.tableKey,
        ...(table.snapshotCursor === undefined ? {} : { cursor: table.snapshotCursor }),
        limit: 10
      });
      if (page.records.length > 10 || (page.records.length === 0 && page.nextCursor !== undefined)) {
        nextState = attention(state, 'snapshot_source_invalid');
      } else if (page.records.length === 0) {
        nextState = advance(state, {
          tables: replaceTable(state, table.tableKey, (current) => ({
            ...current,
            snapshotComplete: true
          }))
        });
      } else {
        const batch = projectSnapshotBatch({
          manifest: input.manifest,
          binding: state.binding!,
          tableKey: table.tableKey,
          records: page.records,
          syncedAt: new Date(input.nowMs).toISOString()
        });
        const written = await input.provider.patchRecords({
          baseId: state.binding!.baseId,
          tableId: batch.tableId,
          mergeOnFieldId: batch.stableIdFieldId,
          records: batch.writes
        });
        if (written.kind === 'failure') {
          nextState = attention(state, written.failure.code === 'acceptance_unknown'
            ? 'snapshot_acceptance_unknown' : `snapshot_${written.failure.code}`);
        } else if (written.value.records.some((record) => record.kind === 'failed')) {
          nextState = attention(state, 'snapshot_partial_failure');
        } else {
          links = Object.freeze(written.value.records.map((disposition) => {
            const sourceRecord = page.records[disposition.requestIndex];
            if (disposition.kind === 'failed' || !sourceRecord) throw new TypeError('snapshot_result_invalid');
            return Object.freeze({
              tableKey: table.tableKey,
              subjectKey: sourceRecord.subjectKey,
              recordId: disposition.record.id
            });
          }));
          nextState = advance(state, {
            tables: replaceTable(state, table.tableKey, (current) => ({
              ...current,
              ...(page.nextCursor === undefined ? {} : { snapshotCursor: page.nextCursor }),
              snapshotComplete: page.nextCursor === undefined,
              projectedCount: current.projectedCount + page.records.length
            }))
          });
        }
      }
    }
  } else {
    const table = state.tables.find((candidate) => !candidate.verifyComplete);
    if (!table) {
      nextState = advance(state, { phase: 'ready' });
    } else {
      const boundTable = state.binding!.tables.find((candidate) => candidate.key === table.tableKey)!;
      const page = await input.provider.listRecords({
        baseId: state.binding!.baseId,
        tableId: boundTable.tableId,
        fieldIds: [boundTable.stableIdFieldId],
        pageSize: 100,
        ...(table.verifyOffset === undefined ? {} : { offset: table.verifyOffset })
      });
      if (page.kind === 'failure') {
        nextState = attention(state, `verify_${page.failure.code}`);
      } else {
        const seen = new Set<string>();
        let invalid = false;
        for (const record of page.value.records) {
          const subject = record.fields[boundTable.stableIdFieldId];
          if (typeof subject !== 'string' || !subject || seen.has(subject)) invalid = true;
          else seen.add(subject);
        }
        const verifiedCount = table.verifiedCount + page.value.records.length;
        const complete = page.value.offset === undefined;
        if (invalid || (complete && verifiedCount !== table.projectedCount)) {
          nextState = attention(state, invalid ? 'verify_identity_invalid' : 'verify_count_mismatch');
        } else {
          nextState = advance(state, {
            tables: replaceTable(state, table.tableKey, (current) => ({
              ...current,
              ...(page.value.offset === undefined ? {} : { verifyOffset: page.value.offset }),
              verifyComplete: complete,
              verifiedCount
            }))
          });
        }
      }
    }
  }

  const fenced = await input.repository.complete({ claim, nextState, links, nowMs: input.nowMs });
  if (!fenced) return Object.freeze({ kind: 'stale' });
  if (nextState.phase === 'attention') {
    return Object.freeze({ kind: 'attention', code: nextState.attentionCode! });
  }
  if (nextState.phase === 'ready') return Object.freeze({ kind: 'ready', baseId: nextState.binding!.baseId });
  return Object.freeze({ kind: 'advanced', phase: nextState.phase });
}
