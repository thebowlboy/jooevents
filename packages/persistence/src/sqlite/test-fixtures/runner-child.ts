import { Database } from 'bun:sqlite';
import { openSQLite } from '../database';
import {
  rebuildEphemeralSQLite,
  recoverEphemeralSQLiteRebuild,
  type EphemeralRebuildFaultPoint,
  type EphemeralRecoveryFaultPoint
} from '../ephemeral-rebuild';
import { acquireSQLiteOwner, canonicalSQLiteTarget } from '../file-ownership';
import { SQLITE_MIGRATION_MANIFEST } from '../migration-manifest';
import { loadSQLiteFoundationArtifacts, migrateOrValidateSQLite, type SQLiteMigrationFaultPoint } from '../migration-runner';

const [command, databasePath, argument, fourth, fifth] = process.argv.slice(2);

if (command === 'open' && databasePath) {
  const opened = openSQLite(databasePath, {
    migrationPolicy: 'apply',
    databaseClass: 'retained_development'
  });
  process.stdout.write(`${JSON.stringify(opened.migration)}\n`);
  if (argument) await Bun.sleep(Number(argument));
  opened.sqlite.close();
} else if (command === 'crash' && databasePath && argument) {
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrateOrValidateSQLite({
    database,
    artifacts: loadSQLiteFoundationArtifacts(),
    policy: 'apply',
    databaseClass: 'retained_development',
    isMemory: false,
    fault(point) {
      if (point === argument as SQLiteMigrationFaultPoint) process.exit(73);
    }
  });
  database.close();
  process.exit(0);
} else if (command === 'leak-owner' && databasePath) {
  openSQLite(databasePath);
  process.exit(74);
} else if (command === 'crash-rebuild' && databasePath && argument && fourth && fifth) {
  rebuildEphemeralSQLite({
    databasePath,
    recoveryDirectory: argument,
    expectedDatabaseId: fourth,
    fault(point) {
      if (point === fifth as EphemeralRebuildFaultPoint) process.exit(75);
    }
  });
  process.exit(0);
} else if (command === 'crash-adoption' && databasePath && argument) {
  const canonical = canonicalSQLiteTarget(databasePath);
  acquireSQLiteOwner({
    canonicalDatabasePath: canonical,
    kind: 'pending-adoption',
    sourceFingerprint: SQLITE_MIGRATION_MANIFEST.predecessor.expectedApplicationFingerprint
  });
  const database = new Database(canonical, { create: false, strict: true });
  database.exec('PRAGMA foreign_keys = ON;');
  migrateOrValidateSQLite({
    database,
    artifacts: loadSQLiteFoundationArtifacts(),
    policy: 'apply',
    databaseClass: 'retained_development',
    isMemory: false,
    fault(point) {
      if (point === argument as SQLiteMigrationFaultPoint) process.exit(76);
    }
  });
  process.exit(0);
} else if (command === 'crash-recovery' && databasePath && argument && fourth) {
  recoverEphemeralSQLiteRebuild({
    databasePath,
    action: argument as 'restore' | 'complete',
    fault(point) {
      if (point === fourth as EphemeralRecoveryFaultPoint) process.exit(77);
    }
  });
  process.exit(0);
} else {
  process.stderr.write('Unknown runner-child command.\n');
  process.exit(64);
}
