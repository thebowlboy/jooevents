import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteFoundationError } from './foundation-errors';
import {
  decodeSQLiteArtifact,
  readVerifiedSQLiteArtifact,
  sha256Hex
} from './migration-artifact';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import {
  canonicalSchemaJson,
  captureSQLiteSchema,
  diffSQLiteSchemas,
  fingerprintSQLiteSchema
} from './schema-snapshot';

const temporaryDirectories: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function database(): Database {
  const opened = new Database(':memory:', { create: true, strict: true });
  databases.push(opened);
  return opened;
}

function expectFoundationError(work: () => unknown, code: SQLiteFoundationError['code']): SQLiteFoundationError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return error as SQLiteFoundationError;
  }
  throw new Error(`Expected ${code}`);
}

describe('SQLite artifact verification', () => {
  test('the manifest freezes the exact epoch-1 and runner-bootstrap bytes', () => {
    const predecessor = readVerifiedSQLiteArtifact(
      SQLITE_MIGRATION_MANIFEST.migrations[0].artifact,
      SQLITE_MIGRATION_MANIFEST.migrations[0].checksumSha256
    );
    const bootstrap = readVerifiedSQLiteArtifact(
      SQLITE_MIGRATION_MANIFEST.bootstrap.artifact,
      SQLITE_MIGRATION_MANIFEST.bootstrap.checksumSha256
    );

    expect(predecessor.checksumSha256).toBe('7bcc91ff77f3cb57b6d553dbf73546ec1d2972da24840d238d12323b7f50305c');
    expect(bootstrap.checksumSha256).toBe('55548c37be3531717439c32b9ea00caa5eaa186c9ae3de54ad5ff7baa54f62e3');
    expect(predecessor.bytes.byteLength).toBe(11_340);
  });

  test('one changed byte refuses before SQL execution', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-artifact-'));
    temporaryDirectories.push(directory);
    const artifact = join(directory, 'changed.sql');
    writeFileSync(artifact, 'select 2;\n');

    const error = expectFoundationError(
      () => readVerifiedSQLiteArtifact(artifact, sha256Hex('select 1;\n')),
      'artifact_checksum_mismatch'
    );
    expect(error.details.actualChecksumSha256).not.toBe(error.details.expectedChecksumSha256);
  });

  test('BOM, NUL, and malformed UTF-8 are closed encoding failures', () => {
    expectFoundationError(() => decodeSQLiteArtifact(Uint8Array.of(0xef, 0xbb, 0xbf, 0x53)), 'artifact_invalid_encoding');
    expectFoundationError(() => decodeSQLiteArtifact(Uint8Array.of(0x53, 0x00, 0x3b)), 'artifact_invalid_encoding');
    expectFoundationError(() => decodeSQLiteArtifact(Uint8Array.of(0xc3, 0x28)), 'artifact_invalid_encoding');
  });
});

describe('SQLite semantic schema snapshot', () => {
  test('is byte-repeatable and captures definition-only semantics', () => {
    const sqlite = database();
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
      CREATE TABLE item (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent(id) ON UPDATE RESTRICT ON DELETE CASCADE,
        label TEXT COLLATE NOCASE NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        doubled INTEGER GENERATED ALWAYS AS (quantity * 2) STORED
      ) STRICT;
      CREATE INDEX item_expression_idx
        ON item (lower(label) COLLATE NOCASE DESC)
        WHERE quantity > 0;
      CREATE VIEW positive_items AS SELECT id, doubled FROM item WHERE quantity > 0;
      CREATE TRIGGER item_quantity_guard
      BEFORE UPDATE OF quantity ON item
      WHEN NEW.quantity < OLD.quantity
      BEGIN
        SELECT RAISE(ABORT, 'quantity cannot decrease');
      END;
    `);

    const first = captureSQLiteSchema(sqlite);
    const second = captureSQLiteSchema(sqlite);
    expect(canonicalSchemaJson(first)).toBe(canonicalSchemaJson(second));
    expect(fingerprintSQLiteSchema(first)).toBe(fingerprintSQLiteSchema(second));

    const item = first.relations.find((relation) => relation.name === 'item');
    expect(item).toMatchObject({ strict: true, withoutRowId: false });
    expect(item?.definitionSql).toContain('GENERATED ALWAYS AS');
    expect(item?.columns.find((column) => column.name === 'doubled')?.hidden).toBe(3);
    expect(item?.foreignKeys[0]).toMatchObject({ onUpdate: 'RESTRICT', onDelete: 'CASCADE' });
    expect(item?.indexes.find((index) => index.name === 'item_expression_idx')).toMatchObject({ partial: true });
    expect(first.triggers[0]?.definitionSql).toContain('quantity cannot decrease');
  });

  test('reports an object-addressed difference for a changed constraint', () => {
    const expectedDatabase = database();
    const actualDatabase = database();
    expectedDatabase.exec('CREATE TABLE amounts (id TEXT PRIMARY KEY, value INTEGER CHECK (value >= 0));');
    actualDatabase.exec('CREATE TABLE amounts (id TEXT PRIMARY KEY, value INTEGER CHECK (value > 0));');
    const expected = captureSQLiteSchema(expectedDatabase);
    const actual = captureSQLiteSchema(actualDatabase);

    expect(fingerprintSQLiteSchema(actual)).not.toBe(fingerprintSQLiteSchema(expected));
    expect(diffSQLiteSchemas(expected, actual).some((difference) =>
      difference.includes('/relations/amounts/definitionSql')
    )).toBe(true);
  });
});
