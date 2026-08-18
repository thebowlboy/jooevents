import { openSQLite } from './database';
import type { SQLiteDatabaseClass } from './migration-runner';
import {
  createRetainedSQLiteBackup,
  createVerifiedRetainedSQLiteRestoreCandidate,
  verifyRetainedSQLiteBackup,
  type RetainedSQLiteDatabaseClass
} from './retained-backup';
import { statusSQLite } from './status';
import { promoteSQLiteReleaseFloorAtPath } from './release-floor';

function flag(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  jooevents-db status --database /absolute/path.sqlite',
    '  jooevents-db migrate --database /absolute/path.sqlite [--class retained_development|frozen_release]',
    '  jooevents-db promote-release --database /absolute/path.sqlite --expected-database-id ID [--release-floor sqlite-e2-s11]',
    '  jooevents-db backup --database /absolute/path.sqlite --backup /absolute/path.backup.sqlite [--expected-database-id ID] --class retained_development|frozen_release --max-bytes N',
    '  jooevents-db restore-rehearsal --backup /absolute/path.backup.sqlite --candidate /absolute/restored.sqlite [--expected-database-id ID] --expected-sha256 SHA256 --class retained_development|frozen_release --max-bytes N',
    ''
  ].join('\n'));
  process.exit(64);
}

export function runSQLiteCli(arguments_: readonly string[]): number {
  const [command] = arguments_;
  const databasePath = flag(arguments_, '--database');
  if (!command) usage();

  if (command === 'status') {
    if (!databasePath) usage();
    const status = statusSQLite(databasePath);
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return status.kind === 'compatible' || status.kind === 'missing' || status.kind === 'migration_required' ? 0 : 2;
  }

  if (command === 'migrate') {
    if (!databasePath) usage();
    const requestedClass = flag(arguments_, '--class');
    if (
      requestedClass !== undefined && requestedClass !== 'retained_development' &&
      requestedClass !== 'frozen_release'
    ) usage();
    const opened = openSQLite(databasePath, {
      migrationPolicy: 'apply',
      ...(requestedClass ? { databaseClass: requestedClass as SQLiteDatabaseClass } : {})
    });
    try {
      process.stdout.write(`${JSON.stringify(opened.migration)}\n`);
    } finally {
      opened.sqlite.close();
    }
    return 0;
  }

  if (command === 'promote-release') {
    const expectedDatabaseId = flag(arguments_, '--expected-database-id');
    const releaseFloorId = flag(arguments_, '--release-floor');
    if (!databasePath || !expectedDatabaseId || !/^[0-9a-f]{32}$/.test(expectedDatabaseId)) usage();
    const promoted = promoteSQLiteReleaseFloorAtPath({
      databasePath,
      expectedDatabaseId,
      ...(releaseFloorId ? { releaseFloorId } : {})
    });
    process.stdout.write(`${JSON.stringify(promoted)}\n`);
    return 0;
  }

  if (command === 'backup') {
    const backupPath = flag(arguments_, '--backup');
    const expectedDatabaseId = flag(arguments_, '--expected-database-id');
    const requestedClass = flag(arguments_, '--class');
    const maximumSerializeBytes = Number(flag(arguments_, '--max-bytes'));
    if (
      !databasePath || !backupPath ||
      (requestedClass !== 'retained_development' && requestedClass !== 'frozen_release') ||
      !Number.isSafeInteger(maximumSerializeBytes) || maximumSerializeBytes < 1
    ) usage();
    const descriptor = createRetainedSQLiteBackup({
      databasePath,
      backupPath,
      ...(expectedDatabaseId ? { expectedDatabaseId } : {}),
      expectedDatabaseClass: requestedClass,
      maximumSerializeBytes
    });
    process.stdout.write(`${JSON.stringify(descriptor)}\n`);
    return 0;
  }

  if (command === 'restore-rehearsal') {
    const backupPath = flag(arguments_, '--backup');
    const candidatePath = flag(arguments_, '--candidate');
    const expectedDatabaseId = flag(arguments_, '--expected-database-id');
    const expectedSha256 = flag(arguments_, '--expected-sha256');
    const requestedClass = flag(arguments_, '--class');
    const maximumBytes = Number(flag(arguments_, '--max-bytes'));
    if (
      !backupPath || !candidatePath ||
      !expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256) ||
      (requestedClass !== 'retained_development' && requestedClass !== 'frozen_release') ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    ) usage();
    const verified = verifyRetainedSQLiteBackup({
      backupPath,
      ...(expectedDatabaseId ? { expectedDatabaseId } : {}),
      expectedDatabaseClass: requestedClass as RetainedSQLiteDatabaseClass,
      maximumBytes
    });
    if (verified.sha256 !== expectedSha256) {
      throw new Error('The retained SQLite backup does not match the expected SHA-256 digest.');
    }
    const descriptor = createVerifiedRetainedSQLiteRestoreCandidate({
      backupPath,
      restoreCandidatePath: candidatePath,
      expectedDescriptor: verified,
      maximumBytes
    });
    process.stdout.write(`${JSON.stringify(descriptor)}\n`);
    return 0;
  }

  usage();
}

if (import.meta.main) process.exitCode = runSQLiteCli(process.argv.slice(2));
