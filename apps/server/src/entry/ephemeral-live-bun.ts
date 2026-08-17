import { resolve } from 'node:path';
import { loadEphemeralLiveConfig } from '../config';
import {
  loadCommunicationsProviderConfig,
  loadMailSenderConfig
} from '../config/communications';
import { loadAirtableProviderConfig } from '../config/airtable';
import { createEphemeralLiveRuntime } from '../runtime/ephemeral-live';
import { startManagedBunRuntime } from '../runtime/bun-runtime-lifecycle';
import {
  createRuntimeRequestHandler,
  resolveBunListenerConfiguration
} from '../runtime/request-handler';
import { validateLiveBuildIdentity } from '../runtime/live-build-identity';

const config = loadEphemeralLiveConfig(Bun.env);
if (config.databaseDriver !== 'sqlite') {
  throw new Error('The ephemeral live entry currently requires the SQLite adapter.');
}

const buildDirectory = resolve(import.meta.dir, '../../../web/build-live');
const buildIdentity = validateLiveBuildIdentity(buildDirectory);
const listener = resolveBunListenerConfiguration(Bun.env);
const airtable = loadAirtableProviderConfig(Bun.env);
// The dev-only issued-link token oracle mounts only in development mode. The
// production composition therefore stays structurally oracle-free regardless
// of the separately configured internal bind address.
// Outbound email provider composition is entry-owned: the runtime itself
// defaults to the inert disabled posture, and `JOOEVENTS_EMAIL_PROVIDER_MODE`
// in the deployment env is the final, instantly reversible activation switch
// (unset or `disabled` composes the empty registry and the fake dispatcher).
const runtime = await createEphemeralLiveRuntime({
  config,
  devFixtures: listener.mode === 'development',
  communications: {
    provider: loadCommunicationsProviderConfig(Bun.env),
    mailSender: loadMailSenderConfig(Bun.env)
  },
  ...(airtable ? { airtable: { provider: airtable } } : {})
});
const fetch = createRuntimeRequestHandler({
  mode: listener.mode,
  backend: runtime.app.fetch,
  buildDirectory,
  buildIdentity,
  embedFraming: runtime.embedFraming
});

await startManagedBunRuntime({
  runtime,
  start: () => Bun.serve({
    hostname: listener.hostname,
    port: listener.port,
    development: listener.development,
    maxRequestBodySize: listener.maxRequestBodySize,
    fetch
  }),
  onSignalError: (error) => {
    process.exitCode = 1;
    console.error('[jooevents] ephemeral runtime shutdown failed', error);
  }
});
