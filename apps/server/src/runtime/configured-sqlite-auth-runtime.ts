import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createProvisioningService } from '@jooevents/application';
import {
  bootstrapEmptyInstall,
  createSQLiteProvisioningStore,
  openSQLite,
  type OpenSQLiteResult
} from '@jooevents/persistence';
import { createAuth, type JooEventsAuth } from '../auth/better-auth';
import { createSQLiteAuthPrincipalReader } from '../auth/principal-reader';
import type { ConfiguredServerConfig } from '../config';
import { createHttpApp } from '../http/app';

export interface ConfiguredSQLiteAuthRuntime {
  readonly database: OpenSQLiteResult;
  readonly databasePath: string;
  readonly auth: JooEventsAuth;
  readonly app: ReturnType<typeof createHttpApp>;
  readonly workspaceId: string;
  close(): void;
}

function closeAfterCompositionFailure(database: OpenSQLiteResult, error: unknown): never {
  try {
    database.sqlite.close();
  } catch (closeError) {
    throw new AggregateError(
      [error, closeError],
      'Configured SQLite auth runtime composition and cleanup both failed.'
    );
  }
  throw error;
}

/**
 * Opens only the retained epoch-1 authentication and admission composition.
 * Domain operations and disposable Foundation schemas are deliberately absent.
 */
export function createConfiguredSQLiteAuthRuntime(input: {
  readonly config: ConfiguredServerConfig;
}): ConfiguredSQLiteAuthRuntime {
  const { config } = input;
  if (config.databaseDriver !== 'sqlite' || !config.databasePath || !config.dataDirectory) {
    throw new Error('The configured SQLite auth runtime requires the SQLite deployment adapter.');
  }

  const dataDirectory = resolve(config.dataDirectory);
  const databasePath = resolve(dataDirectory, config.databasePath);
  const pathFromData = relative(dataDirectory, databasePath);
  if (pathFromData.startsWith('..') || isAbsolute(pathFromData)) {
    throw new Error('JOOEVENTS_DATABASE_PATH must stay inside JOOEVENTS_DATA_DIRECTORY');
  }
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

  const database = openSQLite(databasePath, { migrationPolicy: 'validate' });
  try {
    const bootstrap = bootstrapEmptyInstall({
      sqlite: database.sqlite,
      ownerEmail: config.bootstrapOwnerEmail,
      workspaceName: 'JooEvents',
      now: new Date().toISOString()
    });
    const auth = createAuth(config, database.db);
    const accessContext = createProvisioningService({
      principals: createSQLiteAuthPrincipalReader(database.sqlite),
      store: createSQLiteProvisioningStore(database.sqlite),
      admission: {
        mode: config.admissionMode,
        ...(config.googleHostedDomain ? { hostedDomain: config.googleHostedDomain } : {})
      }
    });
    const app = createHttpApp({
      auth,
      accessContext,
      workspaceId: bootstrap.workspaceId,
      baseUrl: config.baseUrl
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      database.sqlite.close();
      closed = true;
    };

    return Object.freeze({
      database,
      databasePath,
      auth,
      app,
      workspaceId: bootstrap.workspaceId,
      close
    });
  } catch (error) {
    return closeAfterCompositionFailure(database, error);
  }
}
