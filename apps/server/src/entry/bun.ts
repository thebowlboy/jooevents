import { resolve } from 'node:path';
import { loadConfig } from '../config';
import { loadAirtableProviderConfig } from '../config/airtable';
import {
  loadCommunicationsProviderConfig,
  loadMailSenderConfig
} from '../config/communications';
import { startManagedBunRuntime } from '../runtime/bun-runtime-lifecycle';
import { createConfiguredSQLiteLiveRuntime } from '../runtime/configured-sqlite-live-runtime';
import { validateLiveBuildIdentity } from '../runtime/live-build-identity';
import { createRuntimeRequestHandler, resolveBunListenerConfiguration } from '../runtime/request-handler';

const listener = resolveBunListenerConfiguration(Bun.env);
const buildDirectory = resolve(
  import.meta.dir,
  listener.mode === 'production' ? '../../../web/build-live' : '../../../web/build'
);
const buildIdentity = listener.mode === 'production'
  ? validateLiveBuildIdentity(buildDirectory)
  : undefined;
const config = loadConfig(Bun.env);
const airtable = loadAirtableProviderConfig(Bun.env);
const runtime = await createConfiguredSQLiteLiveRuntime({
  config,
  communications: {
    provider: loadCommunicationsProviderConfig(Bun.env),
    mailSender: loadMailSenderConfig(Bun.env)
  },
  ...(airtable ? { airtable: { provider: airtable } } : {})
});

await startManagedBunRuntime({
  runtime,
  start: () => {
    const fetch = createRuntimeRequestHandler({
      mode: listener.mode,
      backend: runtime.app.fetch,
      buildDirectory,
      ...(buildIdentity ? { buildIdentity } : {}),
      embedFraming: runtime.embedFraming,
      disallowCrawling: config.reviewEntryMode === 'organizer'
    });
    return Bun.serve({
      hostname: listener.hostname,
      port: listener.port,
      development: listener.development,
      maxRequestBodySize: listener.maxRequestBodySize,
      fetch
    });
  },
  onSignalError: () => {
    process.exitCode = 1;
    console.error('JooEvents shutdown failed.');
  }
});
