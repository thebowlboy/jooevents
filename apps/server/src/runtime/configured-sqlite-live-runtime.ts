import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { openSQLite, type OpenSQLiteResult } from '@jooevents/persistence';
import type { Clock } from '@jooevents/kernel';
import type { ConfiguredServerConfig } from '../config';
import {
  createRetainedJoinedLiveRuntime,
  createRetainedJoinedLiveRuntimeForTesting,
  type EphemeralLiveRuntimeOptions,
  type RetainedJoinedLiveRuntime
} from './ephemeral-live';

export interface RetainedSQLiteDatabaseRuntime extends OpenSQLiteResult {
  close(): void;
}

export type ConfiguredSQLiteLiveRuntime =
  RetainedJoinedLiveRuntime<RetainedSQLiteDatabaseRuntime> & {
    readonly databasePath: string;
    readonly blobRootDirectory: string;
  };

type OptionalConfiguredIntegrations = Pick<
  EphemeralLiveRuntimeOptions,
  'communications' | 'airtable'
>;

function resolveContainedPath(input: {
  readonly dataDirectory: string;
  readonly candidate: string;
  readonly duty: string;
}): string {
  const candidate = resolve(input.dataDirectory, input.candidate);
  const fromData = relative(input.dataDirectory, candidate);
  if (fromData.length === 0 || fromData.startsWith('..') || isAbsolute(fromData)) {
    throw new Error(`${input.duty} must stay below JOOEVENTS_DATA_DIRECTORY`);
  }
  return candidate;
}

/**
 * Opens an existing retained SQLite installation and composes the complete
 * joined application. Startup validates storage before the caller binds a
 * listener; this function owns the opened database after handoff.
 */
async function createConfiguredSQLiteLiveRuntimeInternal(
  input: { readonly config: ConfiguredServerConfig } & OptionalConfiguredIntegrations & {
    readonly devFixtureClock?: Clock;
  },
  testFixtures: boolean
): Promise<ConfiguredSQLiteLiveRuntime> {
  const { config } = input;
  if (config.databaseDriver !== 'sqlite' || !config.databasePath || !config.dataDirectory
      || config.blobDriver !== 'filesystem') {
    throw new Error(
      'The configured SQLite live runtime requires SQLite and filesystem deployment adapters.'
    );
  }

  const dataDirectory = resolve(config.dataDirectory);
  const databasePath = resolveContainedPath({
    dataDirectory,
    candidate: config.databasePath,
    duty: 'JOOEVENTS_DATABASE_PATH'
  });
  const blobRootDirectory = resolveContainedPath({
    dataDirectory,
    candidate: 'blobs',
    duty: 'The filesystem blob root'
  });
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const dataDirectoryStat = lstatSync(dataDirectory);
  if (!dataDirectoryStat.isDirectory() || dataDirectoryStat.isSymbolicLink()) {
    throw new Error('JOOEVENTS_DATA_DIRECTORY must be a real directory, not a symbolic link.');
  }
  mkdirSync(blobRootDirectory, { recursive: true, mode: 0o700 });
  const blobRootStat = lstatSync(blobRootDirectory);
  const canonicalDataDirectory = realpathSync(dataDirectory);
  const canonicalBlobRoot = realpathSync(blobRootDirectory);
  const blobFromData = relative(canonicalDataDirectory, canonicalBlobRoot);
  if (!blobRootStat.isDirectory() || blobRootStat.isSymbolicLink()
      || blobFromData.length === 0 || blobFromData.startsWith('..')
      || isAbsolute(blobFromData)) {
    throw new Error('The filesystem blob root must be a real directory below the data directory.');
  }

  const opened = openSQLite(databasePath, { migrationPolicy: 'validate' });
  let closed = false;
  const database: RetainedSQLiteDatabaseRuntime = Object.freeze({
    sqlite: opened.sqlite,
    migration: opened.migration,
    close() {
      if (closed) return;
      opened.sqlite.close();
      closed = true;
    }
  });

  const composition = {
    config,
    database,
    blobRootDirectory,
    ...(input.communications === undefined
      ? {}
      : { communications: input.communications }),
    ...(input.airtable === undefined ? {} : { airtable: input.airtable })
  };
  const runtime = testFixtures
    ? await createRetainedJoinedLiveRuntimeForTesting({
        ...composition,
        devFixtures: true,
        ...(input.devFixtureClock ? { devFixtureClock: input.devFixtureClock } : {})
      })
    : await createRetainedJoinedLiveRuntime(composition);
  return Object.freeze({
    ...runtime,
    databasePath,
    blobRootDirectory
  });
}

export function createConfiguredSQLiteLiveRuntime(
  input: { readonly config: ConfiguredServerConfig } & OptionalConfiguredIntegrations
): Promise<ConfiguredSQLiteLiveRuntime> {
  return createConfiguredSQLiteLiveRuntimeInternal(input, false);
}

/** Test-only fixture surface; the production constructor above never enables it. */
export function createConfiguredSQLiteLiveRuntimeForTesting(
  input: { readonly config: ConfiguredServerConfig } & OptionalConfiguredIntegrations & {
    readonly devFixtureClock?: Clock;
  }
): Promise<ConfiguredSQLiteLiveRuntime> {
  return createConfiguredSQLiteLiveRuntimeInternal(input, true);
}
