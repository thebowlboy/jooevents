import { resolve } from 'node:path';
import { loadEphemeralLiveConfig } from '../config';
import { createEphemeralLiveRuntime } from '../runtime/ephemeral-live';
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
const runtime = await createEphemeralLiveRuntime({ config });
const listener = resolveBunListenerConfiguration(Bun.env);
const fetch = createRuntimeRequestHandler({
  mode: listener.mode,
  backend: runtime.app.fetch,
  buildDirectory,
  buildIdentity
});

const server = Bun.serve({
  hostname: listener.hostname,
  port: listener.port,
  development: listener.development,
  fetch
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.stop();
  runtime.close();
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
