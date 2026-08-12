import type { Database } from 'bun:sqlite';
import { sha256Hex } from './migration-artifact';

const RUNNER_RELATIONS = new Set([
  'database_instance_metadata',
  'schema_epoch_transitions',
  'schema_migrations'
]);

export type SQLiteSchemaScope = 'application' | 'runner' | 'full';

export interface SQLiteSchemaColumnSnapshot {
  readonly ordinal: number;
  readonly name: string;
  readonly declaredType: string;
  readonly notNull: boolean;
  readonly defaultSql: string | null;
  readonly primaryKeyOrdinal: number;
  readonly hidden: number;
}

export interface SQLiteForeignKeySnapshot {
  readonly id: number;
  readonly ordinal: number;
  readonly targetRelation: string;
  readonly fromColumn: string | null;
  readonly toColumn: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface SQLiteIndexTermSnapshot {
  readonly ordinal: number;
  readonly columnId: number;
  readonly columnName: string | null;
  readonly descending: boolean;
  readonly collation: string | null;
  readonly key: boolean;
}

export interface SQLiteIndexSnapshot {
  readonly name: string;
  readonly unique: boolean;
  readonly origin: string;
  readonly partial: boolean;
  readonly definitionSql: string | null;
  readonly terms: readonly SQLiteIndexTermSnapshot[];
}

export interface SQLiteRelationSnapshot {
  readonly schema: string;
  readonly name: string;
  readonly kind: string;
  readonly columnCount: number;
  readonly withoutRowId: boolean;
  readonly strict: boolean;
  readonly definitionSql: string | null;
  readonly columns: readonly SQLiteSchemaColumnSnapshot[];
  readonly foreignKeys: readonly SQLiteForeignKeySnapshot[];
  readonly indexes: readonly SQLiteIndexSnapshot[];
}

export interface SQLiteTriggerSnapshot {
  readonly schema: string;
  readonly name: string;
  readonly targetRelation: string;
  readonly definitionSql: string;
}

export interface SQLiteSchemaSnapshot {
  readonly formatVersion: 1;
  readonly dialect: 'sqlite';
  readonly scope: SQLiteSchemaScope;
  readonly relations: readonly SQLiteRelationSnapshot[];
  readonly triggers: readonly SQLiteTriggerSnapshot[];
}

interface TableListRow {
  readonly schema: string;
  readonly name: string;
  readonly type: string;
  readonly ncol: number;
  readonly wr: number;
  readonly strict: number;
}

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

interface ColumnRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
  readonly hidden: number;
}

interface ForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
}

interface IndexListRow {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

interface IndexInfoRow {
  readonly seqno: number;
  readonly cid: number;
  readonly name: string | null;
  readonly desc: number;
  readonly coll: string | null;
  readonly key: number;
}

function quotePragmaName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * SQLite preserves the submitted definition in sqlite_schema. Keeping that exact
 * token stream (apart from line-ending and edge whitespace normalization) makes
 * checks, collations, generated expressions, predicates, triggers, and views part of
 * the fingerprint even when a PRAGMA does not expose them structurally.
 */
export function canonicalizeSQLiteDefinition(sql: string | null): string | null {
  if (sql === null) return null;
  return sql.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
}

function isRunnerObject(name: string, targetRelation?: string): boolean {
  return RUNNER_RELATIONS.has(name) || (targetRelation !== undefined && RUNNER_RELATIONS.has(targetRelation));
}

function includesObject(scope: SQLiteSchemaScope, name: string, targetRelation?: string): boolean {
  const runner = isRunnerObject(name, targetRelation);
  return scope === 'full' || (scope === 'runner' ? runner : !runner);
}

function schemaDefinitions(database: Database): Map<string, SchemaRow> {
  const rows = database.query<SchemaRow, []>(`
    select type, name, tbl_name, sql
      from sqlite_schema
     where type in ('table', 'index', 'trigger', 'view')
       and name not like 'sqlite_%'
  `).all();
  return new Map(rows.map((row) => [`${row.type}:${row.name}`, row]));
}

export function captureSQLiteSchema(
  database: Database,
  scope: SQLiteSchemaScope = 'full'
): SQLiteSchemaSnapshot {
  const definitions = schemaDefinitions(database);
  const tableRows = database.query<TableListRow, []>('PRAGMA table_list').all()
    .filter((row) => row.schema === 'main' && !row.name.startsWith('sqlite_'))
    .filter((row) => includesObject(scope, row.name))
    .sort((left, right) => compareText(left.name, right.name));

  const relations: SQLiteRelationSnapshot[] = tableRows.map((table) => {
    const definitionKind = table.type === 'view' ? 'view' : 'table';
    const definition = definitions.get(`${definitionKind}:${table.name}`);
    const columns = database.query<ColumnRow, []>(`PRAGMA table_xinfo(${quotePragmaName(table.name)})`).all()
      .sort((left, right) => left.cid - right.cid)
      .map((column) => ({
        ordinal: column.cid,
        name: column.name,
        declaredType: column.type,
        notNull: column.notnull === 1,
        defaultSql: canonicalizeSQLiteDefinition(column.dflt_value),
        primaryKeyOrdinal: column.pk,
        hidden: column.hidden
      }));
    const foreignKeys = database.query<ForeignKeyRow, []>(`PRAGMA foreign_key_list(${quotePragmaName(table.name)})`).all()
      .sort((left, right) => left.id - right.id || left.seq - right.seq)
      .map((foreignKey) => ({
        id: foreignKey.id,
        ordinal: foreignKey.seq,
        targetRelation: foreignKey.table,
        fromColumn: foreignKey.from,
        toColumn: foreignKey.to,
        onUpdate: foreignKey.on_update,
        onDelete: foreignKey.on_delete,
        match: foreignKey.match
      }));
    const indexes = database.query<IndexListRow, []>(`PRAGMA index_list(${quotePragmaName(table.name)})`).all()
      .sort((left, right) => compareText(left.name, right.name))
      .map((index) => ({
        name: index.name,
        unique: index.unique === 1,
        origin: index.origin,
        partial: index.partial === 1,
        definitionSql: canonicalizeSQLiteDefinition(definitions.get(`index:${index.name}`)?.sql ?? null),
        terms: database.query<IndexInfoRow, []>(`PRAGMA index_xinfo(${quotePragmaName(index.name)})`).all()
          .sort((left, right) => left.seqno - right.seqno)
          .map((term) => ({
            ordinal: term.seqno,
            columnId: term.cid,
            columnName: term.name,
            descending: term.desc === 1,
            collation: term.coll,
            key: term.key === 1
          }))
      }));

    return {
      schema: table.schema,
      name: table.name,
      kind: table.type,
      columnCount: table.ncol,
      withoutRowId: table.wr === 1,
      strict: table.strict === 1,
      definitionSql: canonicalizeSQLiteDefinition(definition?.sql ?? null),
      columns,
      foreignKeys,
      indexes
    };
  });

  const triggers = [...definitions.values()]
    .filter((row) => row.type === 'trigger' && includesObject(scope, row.name, row.tbl_name))
    .sort((left, right) => compareText(left.name, right.name))
    .map((trigger) => ({
      schema: 'main',
      name: trigger.name,
      targetRelation: trigger.tbl_name,
      definitionSql: canonicalizeSQLiteDefinition(trigger.sql) ?? ''
    }));

  return { formatVersion: 1, dialect: 'sqlite', scope, relations, triggers };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
  }
  return value;
}

export function canonicalSchemaJson(snapshot: SQLiteSchemaSnapshot): string {
  return JSON.stringify(canonicalValue(snapshot));
}

export function fingerprintSQLiteSchema(snapshot: SQLiteSchemaSnapshot): string {
  return sha256Hex(canonicalSchemaJson(snapshot));
}

function boundedValue(value: unknown): string {
  const rendered = JSON.stringify(value) ?? String(value);
  return rendered.length <= 160 ? rendered : `${rendered.slice(0, 157)}...`;
}

export function diffSQLiteSchemas(
  expected: SQLiteSchemaSnapshot,
  actual: SQLiteSchemaSnapshot,
  limit = 32
): readonly string[] {
  const differences: string[] = [];

  function namedEntries(values: readonly unknown[]): Map<string, unknown> | undefined {
    const entries = values.map((value) => {
      if (value === null || typeof value !== 'object') return undefined;
      const name = (value as Record<string, unknown>).name;
      return typeof name === 'string' ? [name, value] as const : undefined;
    });
    if (entries.some((entry) => entry === undefined)) return undefined;
    const map = new Map(entries as readonly (readonly [string, unknown])[]);
    return map.size === values.length ? map : undefined;
  }

  function compare(left: unknown, right: unknown, path: string): void {
    if (differences.length >= limit || Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const leftNamed = namedEntries(left);
      const rightNamed = namedEntries(right);
      if (leftNamed && rightNamed && (left.length > 0 || right.length > 0)) {
        const names = [...new Set([...leftNamed.keys(), ...rightNamed.keys()])].sort(compareText);
        for (const name of names) {
          compare(leftNamed.get(name), rightNamed.get(name), `${path}/${encodeURIComponent(name)}`);
        }
        return;
      }
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length && differences.length < limit; index += 1) {
        compare(left[index], right[index], `${path}/${index}`);
      }
      return;
    }
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
      for (const key of keys) compare(leftRecord[key], rightRecord[key], `${path}/${key}`);
      return;
    }
    differences.push(`${path || '/'}: expected ${boundedValue(left)}, received ${boundedValue(right)}`);
  }

  compare(expected, actual, '');
  return differences;
}

export const SQLITE_RUNNER_RELATIONS = [...RUNNER_RELATIONS].sort();
