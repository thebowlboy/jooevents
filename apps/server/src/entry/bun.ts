import { mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createProvisioningService } from '@jooevents/application';
import { bootstrapEmptyInstall, createSQLiteProvisioningStore, openSQLite } from '@jooevents/persistence';
import { createAuth } from '../auth/better-auth';
import { createSQLiteAuthPrincipalReader } from '../auth/principal-reader';
import { loadConfig } from '../config';
import { createHttpApp } from '../http/app';

const config = loadConfig(Bun.env);
if (config.databaseDriver !== 'sqlite' || !config.databasePath || !config.dataDirectory) {
  throw new Error('The Bun entry currently requires the SQLite deployment adapter.');
}

const dataDirectory = resolve(config.dataDirectory);
const databasePath = resolve(dataDirectory, config.databasePath);
const pathFromData = relative(dataDirectory, databasePath);
if (pathFromData.startsWith('..') || isAbsolute(pathFromData)) throw new Error('JOOEVENTS_DATABASE_PATH must stay inside JOOEVENTS_DATA_DIRECTORY');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

const opened = openSQLite(databasePath);
const bootstrap = bootstrapEmptyInstall({
  sqlite: opened.sqlite,
  ownerEmail: config.bootstrapOwnerEmail,
  workspaceName: 'JooEvents',
  now: new Date().toISOString()
});
const auth = createAuth(config, opened.db);
const accessContext = createProvisioningService({
  principals: createSQLiteAuthPrincipalReader(opened.sqlite, config),
  store: createSQLiteProvisioningStore(opened.sqlite),
  admission: {
    mode: config.admissionMode,
    ...(config.googleHostedDomain ? { hostedDomain: config.googleHostedDomain } : {})
  }
});
const app = createHttpApp({ auth, accessContext, workspaceId: bootstrap.workspaceId, baseUrl: config.baseUrl });

const internalPort = Bun.env.JOOEVENTS_INTERNAL_HTTP_PORT ? Number(Bun.env.JOOEVENTS_INTERNAL_HTTP_PORT) : 5176;
if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65_535) throw new Error('JOOEVENTS_INTERNAL_HTTP_PORT must be a valid TCP port');

Bun.serve({
  hostname: Bun.env.JOOEVENTS_INTERNAL_HTTP_PORT ? '127.0.0.1' : '0.0.0.0',
  port: internalPort,
  development: Bun.env.NODE_ENV !== 'production',
  fetch: app.fetch
});
