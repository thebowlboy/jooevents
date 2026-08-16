import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  SQLITE_BETTER_AUTH_SCHEMA,
  authAccounts,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications
} from './better-auth-schema';
import type { SQLiteRelationSnapshot, SQLiteSchemaSnapshot } from './schema-snapshot';

const CHECKPOINT = new URL(
  '../../migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.schema.json',
  import.meta.url
);

function sortedGroups(groups: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return groups.map((group) => [...group]).sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
}

function indexColumnName(column: unknown): string {
  if (column !== null && typeof column === 'object' && 'name' in column) {
    const name = (column as { readonly name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  throw new TypeError('better_auth_projection_expression_index_not_supported');
}

function mappedContract(table: SQLiteTable) {
  const config = getTableConfig(table);
  const inlineUnique = config.columns
    .filter((column) => column.isUnique)
    .map((column) => [column.name]);
  const compositeUnique = config.uniqueConstraints.map((constraint) =>
    constraint.columns.map((column) => column.name)
  );
  return {
    name: getTableName(table),
    columns: config.columns.map((column) => ({
      name: column.name,
      declaredType: column.getSQLType().toUpperCase(),
      // SQLite reports an inline non-integer PRIMARY KEY through the key ordinal,
      // not PRAGMA table_xinfo.notnull. Preserve that physical distinction.
      notNull: column.primary ? false : column.notNull,
      defaultSql: column.default === undefined ? null : String(column.default),
      primaryKeyOrdinal: column.primary ? 1 : 0
    })),
    primaryKey: config.columns.filter((column) => column.primary).map((column) => column.name),
    uniqueGroups: sortedGroups([...inlineUnique, ...compositeUnique]),
    indexes: config.indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique,
      columns: index.config.columns.map(indexColumnName)
    })).sort((left, right) => left.name.localeCompare(right.name)),
    foreignKeys: config.foreignKeys.flatMap((foreignKey) => {
      const reference = foreignKey.reference();
      return reference.columns.map((column, index) => ({
        fromColumn: column.name,
        targetRelation: getTableName(reference.foreignTable),
        toColumn: reference.foreignColumns[index]?.name ?? null,
        onUpdate: (foreignKey.onUpdate ?? 'no action').toUpperCase(),
        onDelete: (foreignKey.onDelete ?? 'no action').toUpperCase()
      }));
    }).sort((left, right) => left.fromColumn.localeCompare(right.fromColumn))
  };
}

function checkpointContract(relation: SQLiteRelationSnapshot) {
  return {
    name: relation.name,
    columns: relation.columns.map((column) => ({
      name: column.name,
      declaredType: column.declaredType,
      notNull: column.notNull,
      defaultSql: column.defaultSql,
      primaryKeyOrdinal: column.primaryKeyOrdinal
    })),
    primaryKey: relation.columns
      .filter((column) => column.primaryKeyOrdinal > 0)
      .sort((left, right) => left.primaryKeyOrdinal - right.primaryKeyOrdinal)
      .map((column) => column.name),
    uniqueGroups: sortedGroups(relation.indexes
      .filter((index) => index.origin === 'u')
      .map((index) => index.terms.filter((term) => term.key).map((term) => term.columnName ?? ''))),
    indexes: relation.indexes
      .filter((index) => index.origin === 'c')
      .map((index) => ({
        name: index.name,
        unique: index.unique,
        columns: index.terms.filter((term) => term.key).map((term) => term.columnName ?? '')
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    foreignKeys: relation.foreignKeys.map((foreignKey) => ({
      fromColumn: foreignKey.fromColumn ?? '',
      targetRelation: foreignKey.targetRelation,
      toColumn: foreignKey.toColumn,
      onUpdate: foreignKey.onUpdate,
      onDelete: foreignKey.onDelete
    })).sort((left, right) => left.fromColumn.localeCompare(right.fromColumn))
  };
}

describe('Better Auth Drizzle projection', () => {
  test('is exactly the five accepted authentication tables', () => {
    expect(Object.keys(SQLITE_BETTER_AUTH_SCHEMA)).toEqual([
      'auth_users',
      'auth_accounts',
      'auth_sessions',
      'auth_verifications',
      'auth_rate_limits'
    ]);
  });

  test('matches the canonical checkpoint subset', () => {
    const checkpoint = JSON.parse(readFileSync(CHECKPOINT, 'utf8')) as SQLiteSchemaSnapshot;
    const tables = [authUsers, authAccounts, authSessions, authVerifications, authRateLimits];
    const acceptedNames = new Set<string>(tables.map((table) => getTableName(table)));
    const accepted = checkpoint.relations.filter((relation) => acceptedNames.has(relation.name));

    expect(accepted).toHaveLength(5);
    for (const table of tables) {
      const name = getTableName(table);
      const relation = accepted.find((candidate) => candidate.name === name);
      expect(relation, `checkpoint relation ${name}`).toBeDefined();
      expect(mappedContract(table)).toEqual(checkpointContract(relation!));
    }
  });
});
