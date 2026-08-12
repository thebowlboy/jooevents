import { openSQLite } from './database';
import type { SQLiteDatabaseClass } from './migration-runner';
import { statusSQLite } from './status';

function flag(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  jooevents-db status --database /absolute/path.sqlite',
    '  jooevents-db migrate --database /absolute/path.sqlite [--class retained_development|frozen_release]',
    ''
  ].join('\n'));
  process.exit(64);
}

export function runSQLiteCli(arguments_: readonly string[]): number {
  const [command] = arguments_;
  const databasePath = flag(arguments_, '--database');
  if (!command || !databasePath) usage();

  if (command === 'status') {
    const status = statusSQLite(databasePath);
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return status.kind === 'compatible' || status.kind === 'missing' || status.kind === 'migration_required' ? 0 : 2;
  }

  if (command === 'migrate') {
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

  usage();
}

if (import.meta.main) process.exitCode = runSQLiteCli(process.argv.slice(2));
