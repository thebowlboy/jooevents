import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSQLite, type OpenSQLiteResult } from './database';
import { SQLiteFoundationError } from './foundation-errors';
import {
  acquireSQLiteExclusiveLock,
  acquireSQLiteOwner,
  canonicalSQLiteTarget,
  listSQLiteOwners,
  recoverStaleSQLiteOwner,
  sqliteCoordinationPaths
} from './file-ownership';
import { SQLITE_MIGRATION_MANIFEST } from './migration-manifest';
import { statusSQLite } from './status';
import { observeProcessIdentity } from './process-identity';

const childFixture = fileURLToPath(new URL('./test-fixtures/runner-child.ts', import.meta.url));
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
const directories: string[] = [];
const opened: OpenSQLiteResult[] = [];

afterEach(() => {
  while (opened.length) opened.pop()?.sqlite.close();
  while (directories.length) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function pathFor(name = 'database.sqlite'): string {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-ownership-'));
  directories.push(directory);
  return join(directory, name);
}

function child(arguments_: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, [childFixture, ...arguments_], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    process_.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    process_.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    process_.on('error', reject);
    process_.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function foundationError(work: () => unknown, code: SQLiteFoundationError['code']): SQLiteFoundationError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SQLiteFoundationError);
    expect((error as SQLiteFoundationError).code).toBe(code);
    return error as SQLiteFoundationError;
  }
  throw new Error(`Expected ${code}`);
}

describe('file-backed SQLite lifetime ownership', () => {
  test('records a stable process-start identity when the host exposes one', () => {
    const observation = observeProcessIdentity(process.pid);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(observation).toMatchObject({ kind: 'present' });
    } else {
      expect(['present', 'unavailable']).toContain(observation.kind);
    }
  });

  test('ordinary owners live exactly as long as their SQLite connections', () => {
    const path = pathFor();
    const first = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    const canonical = canonicalSQLiteTarget(path);
    expect(listSQLiteOwners(canonical)).toHaveLength(1);
    expect(listSQLiteOwners(canonical)[0]).toMatchObject({ kind: 'ordinary', databaseId: first.migration.databaseId });

    const second = openSQLite(path);
    expect(listSQLiteOwners(canonical)).toHaveLength(2);
    first.sqlite.close();
    expect(listSQLiteOwners(canonical)).toHaveLength(1);
    second.sqlite.close();
    expect(listSQLiteOwners(canonical)).toEqual([]);
  });

  test('explicit cleanup cannot remove a live process-instance owner', () => {
    const path = pathFor();
    const live = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    const canonical = canonicalSQLiteTarget(path);
    const [owner] = listSQLiteOwners(canonical);
    foundationError(() => recoverStaleSQLiteOwner(canonical, owner!.ownerId), 'database_busy');
    expect(listSQLiteOwners(canonical)).toHaveLength(1);
    live.sqlite.close();
  });

  test('a pending adoption owner excludes a second adopter', () => {
    const path = pathFor();
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.predecessor.artifact, 'utf8'));
    legacy.close();
    const canonical = canonicalSQLiteTarget(path);
    const pending = acquireSQLiteOwner({
      canonicalDatabasePath: canonical,
      kind: 'pending-adoption',
      sourceFingerprint: SQLITE_MIGRATION_MANIFEST.predecessor.expectedApplicationFingerprint
    });
    foundationError(() => openSQLite(path, { migrationPolicy: 'apply' }), 'database_busy');
    pending.release();
    expect(existsSync(sqliteCoordinationPaths(canonical).migrationLock)).toBe(false);
  });

  test('a dead process leaves one exact recoverable owner record', async () => {
    const path = pathFor();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    const leaked = await child(['leak-owner', path]);
    expect(leaked.code).toBe(74);
    const canonical = canonicalSQLiteTarget(path);
    const owners = listSQLiteOwners(canonical);
    expect(owners).toHaveLength(1);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(owners[0]?.processStartToken).toMatch(/^[0-9a-f]{64}$/);
    }
    recoverStaleSQLiteOwner(canonical, owners[0]!.ownerId);
    expect(listSQLiteOwners(canonical)).toEqual([]);
  });

  test('stale-owner cleanup fails closed without a recorded process-start identity', async () => {
    const path = pathFor();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    expect((await child(['leak-owner', path])).code).toBe(74);
    const canonical = canonicalSQLiteTarget(path);
    const [stale] = listSQLiteOwners(canonical);
    const recordPath = join(sqliteCoordinationPaths(canonical).owners, `${stale!.ownerId}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    record.processStartToken = null;
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`, 'utf8');
    foundationError(() => recoverStaleSQLiteOwner(canonical, stale!.ownerId), 'database_busy');
    expect(existsSync(recordPath)).toBe(true);
  });

  test('stale-owner recovery refuses a replacement at the same path', async () => {
    const path = pathFor();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    expect((await child(['leak-owner', path])).code).toBe(74);
    const canonical = canonicalSQLiteTarget(path);
    const [stale] = listSQLiteOwners(canonical);
    renameSync(canonical, `${canonical}.replaced`);
    const replacement = new Database(canonical, { create: true, strict: true });
    replacement.close();
    foundationError(() => recoverStaleSQLiteOwner(canonical, stale!.ownerId), 'database_path_unsafe');
    expect(listSQLiteOwners(canonical)).toHaveLength(1);
  });

  for (const scenario of [
    { point: 'after_schema_before_receipt', expectedOpen: 'bridged' },
    { point: 'after_commit_before_return', expectedOpen: 'current' }
  ] as const) {
    test(`recovers a dead pending adopter at ${scenario.point} without guessing state`, async () => {
      const path = pathFor();
      const legacy = new Database(path, { create: true, strict: true });
      legacy.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.predecessor.artifact, 'utf8'));
      legacy.close();
      expect((await child(['crash-adoption', path, scenario.point])).code).toBe(76);
      const canonical = canonicalSQLiteTarget(path);
      const [stale] = listSQLiteOwners(canonical);
      expect(stale).toMatchObject({ kind: 'pending-adoption' });
      recoverStaleSQLiteOwner(canonical, stale!.ownerId);
      expect(listSQLiteOwners(canonical)).toEqual([]);

      const reopened = scenario.expectedOpen === 'bridged'
        ? openSQLite(path, { migrationPolicy: 'apply' })
        : openSQLite(path);
      opened.push(reopened);
      expect(reopened.migration.status).toBe(scenario.expectedOpen);
    });
  }

  test('two independent migrators converge on one receipt', async () => {
    const path = pathFor();
    const [left, right] = await Promise.all([
      child(['open', path, '40']),
      child(['open', path, '40'])
    ]);
    expect(left.code).toBe(0);
    expect(right.code).toBe(0);
    const states = [JSON.parse(left.stdout), JSON.parse(right.stdout)].map((value) => value.status).sort();
    expect(states).toEqual(['applied', 'current']);

    const verified = openSQLite(path);
    opened.push(verified);
    expect(verified.sqlite.query<{ count: number }, []>('select count(*) as count from schema_migrations').get()?.count).toBe(1);
  });
});

describe('read-only SQLite status and CLI', () => {
  function walFixture(): { path: string; writer: Database } {
    const path = pathFor();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    const writer = new Database(path, { create: false, strict: true });
    writer.exec('PRAGMA journal_mode = WAL;');
    const now = Date.parse('2026-08-11T00:00:00.000Z');
    writer.query(`insert into workspaces (id, name, state, created_at, updated_at, version)
      values ('workspace_wal_base', 'WAL fixture', 'active', ?, ?, 1)`).run(now, now);
    expect(existsSync(`${canonicalSQLiteTarget(path)}-wal`)).toBe(true);
    expect(existsSync(`${canonicalSQLiteTarget(path)}-shm`)).toBe(true);
    return { path, writer };
  }

  test('missing and legacy status create no database or coordination files', () => {
    const missing = pathFor();
    expect(statusSQLite(missing)).toMatchObject({ kind: 'missing' });
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(`${missing}.jooevents-owners`)).toBe(false);

    const legacyPath = pathFor();
    const legacy = new Database(legacyPath, { create: true, strict: true });
    legacy.exec(readFileSync(SQLITE_MIGRATION_MANIFEST.migrations[0].artifact, 'utf8'));
    legacy.close();
    expect(statusSQLite(legacyPath)).toMatchObject({ kind: 'migration_required' });
    const canonical = canonicalSQLiteTarget(legacyPath);
    expect(existsSync(sqliteCoordinationPaths(canonical).owners)).toBe(false);
  });

  test('current, drifted, and locked databases have distinct diagnostic outcomes', () => {
    const path = pathFor();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    expect(statusSQLite(path)).toMatchObject({ kind: 'compatible' });

    const canonical = canonicalSQLiteTarget(path);
    const lock = acquireSQLiteExclusiveLock(canonical, 'migration');
    expect(statusSQLite(path)).toMatchObject({ kind: 'unstable' });
    lock.release();

    const drifted = new Database(path, { create: false, strict: true });
    drifted.exec('CREATE TABLE status_drift (id TEXT PRIMARY KEY);');
    drifted.close();
    expect(statusSQLite(path)).toMatchObject({ kind: 'incompatible', code: 'schema_drift' });
  });

  test('a stable pre-existing WAL/SHM pair remains diagnosable without creating artifacts', () => {
    const { path, writer } = walFixture();
    try {
      expect(statusSQLite(path)).toMatchObject({ kind: 'compatible' });
    } finally {
      writer.close();
    }
  });

  test('a concurrent committed WAL write changes data_version and returns unstable', () => {
    const { path, writer } = walFixture();
    try {
      const now = Date.parse('2026-08-11T00:00:01.000Z');
      const status = statusSQLite(path, {
        testOnlyProbe(point) {
          if (point === 'before_final_data_version') {
            writer.query(`insert into workspaces (id, name, state, created_at, updated_at, version)
              values ('workspace_wal_race', 'Concurrent commit', 'active', ?, ?, 1)`).run(now, now);
          }
        }
      });
      expect(status).toMatchObject({ kind: 'unstable' });
    } finally {
      writer.close();
    }
  });

  test('main-file identity replacement during status returns unstable', () => {
    const path = pathFor();
    const created = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
    created.sqlite.close();
    const canonical = canonicalSQLiteTarget(path);
    const moved = `${canonical}.status-original`;
    const status = statusSQLite(path, {
      testOnlyProbe(point) {
        if (point === 'after_connection_close') {
          renameSync(canonical, moved);
          copyFileSync(moved, canonical);
        }
      }
    });
    expect(status).toMatchObject({ kind: 'unstable' });
  });

  test('in-place WAL timestamp mutation during status returns unstable', () => {
    const { path, writer } = walFixture();
    try {
      const wal = `${canonicalSQLiteTarget(path)}-wal`;
      const status = statusSQLite(path, {
        testOnlyProbe(point) {
          if (point === 'after_connection_close') {
            const stat = statSync(wal);
            utimesSync(wal, stat.atime, new Date(stat.mtimeMs + 2_000));
          }
        }
      });
      expect(status).toMatchObject({ kind: 'unstable' });
    } finally {
      writer.close();
    }
  });

  test('in-place SHM timestamp mutation after read coordination returns unstable', () => {
    const { path, writer } = walFixture();
    try {
      const shm = `${canonicalSQLiteTarget(path)}-shm`;
      const status = statusSQLite(path, {
        testOnlyProbe(point) {
          if (point === 'after_connection_close') {
            const stat = statSync(shm);
            utimesSync(shm, stat.atime, new Date(stat.mtimeMs + 2_000));
          }
        }
      });
      expect(status).toMatchObject({ kind: 'unstable' });
    } finally {
      writer.close();
    }
  });

  for (const sidecar of ['wal', 'shm'] as const) {
    test(`${sidecar.toUpperCase()} inode replacement during status returns unstable`, () => {
      const { path, writer } = walFixture();
      try {
        const target = `${canonicalSQLiteTarget(path)}-${sidecar}`;
        const moved = `${target}.status-original`;
        const status = statusSQLite(path, {
          testOnlyProbe(point) {
            if (point === 'after_connection_close') {
              renameSync(target, moved);
              copyFileSync(moved, target);
            }
          }
        });
        expect(status).toMatchObject({ kind: 'unstable' });
      } finally {
        writer.close();
      }
    });
  }

  test('a WAL whose SHM companion disappears is an unstable refusal', () => {
    const { path, writer } = walFixture();
    const shm = `${canonicalSQLiteTarget(path)}-shm`;
    renameSync(shm, `${shm}.missing`);
    try {
      expect(statusSQLite(path)).toMatchObject({ kind: 'unstable' });
    } finally {
      writer.close();
    }
  });

  test('the public CLI reports status without prose or private paths', () => {
    const path = pathFor();
    const migrated = Bun.spawnSync([
      process.execPath,
      cli,
      'migrate',
      '--database',
      path,
      '--class',
      'retained_development'
    ]);
    expect(migrated.exitCode).toBe(0);
    expect(JSON.parse(migrated.stdout.toString())).toMatchObject({ status: 'applied' });
    const status = Bun.spawnSync([process.execPath, cli, 'status', '--database', path]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString())).toMatchObject({ kind: 'compatible' });
  });
});

describe('SQLite migration process termination', () => {
  for (const point of ['after_schema_before_receipt', 'after_receipt_before_commit'] as const) {
    test(`${point} rolls schema and receipt back together`, async () => {
      const path = pathFor();
      const crashed = await child(['crash', path, point]);
      expect(crashed.code).toBe(73);
      const recovered = openSQLite(path, { migrationPolicy: 'apply', databaseClass: 'retained_development' });
      opened.push(recovered);
      expect(recovered.migration.status).toBe('applied');
      expect(recovered.sqlite.query<{ count: number }, []>('select count(*) as count from schema_migrations').get()?.count).toBe(1);
    });
  }

  test('a process loss after commit retains exactly one complete receipt', async () => {
    const path = pathFor();
    const crashed = await child(['crash', path, 'after_commit_before_return']);
    expect(crashed.code).toBe(73);
    const recovered = openSQLite(path);
    opened.push(recovered);
    expect(recovered.migration.status).toBe('current');
    expect(recovered.sqlite.query<{ count: number }, []>('select count(*) as count from schema_migrations').get()?.count).toBe(1);
  });
});
