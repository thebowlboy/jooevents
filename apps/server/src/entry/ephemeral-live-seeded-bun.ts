import { resolve } from 'node:path';
import { loadEphemeralLiveConfig } from '../config';
import {
  loadCommunicationsProviderConfig,
  loadMailSenderConfig
} from '../config/communications';
import { createEphemeralLiveRuntime } from '../runtime/ephemeral-live';
import {
  createRuntimeRequestHandler,
  resolveBunListenerConfiguration
} from '../runtime/request-handler';
import { validateLiveBuildIdentity } from '../runtime/live-build-identity';
import { seedJooConPlayground } from './joocon-playground-seed';

const config = loadEphemeralLiveConfig(Bun.env);
if (config.databaseDriver !== 'sqlite') {
  throw new Error('The seeded ephemeral live entry currently requires the SQLite adapter.');
}

const buildDirectory = resolve(import.meta.dir, '../../../web/build-live');
const buildIdentity = validateLiveBuildIdentity(buildDirectory);
const listener = resolveBunListenerConfiguration(Bun.env);
// Identical listener/runtime composition to the empty ephemeral live entry:
// the dev-only issued-link token oracle mounts only in development mode, which
// binds loopback (127.0.0.1). Production mode binds 0.0.0.0, so the oracle is
// structurally absent beyond loopback.
const runtime = await createEphemeralLiveRuntime({
  config,
  devFixtures: listener.mode === 'development',
  communications: {
    provider: loadCommunicationsProviderConfig(Bun.env),
    mailSender: loadMailSenderConfig(Bun.env)
  }
});

// The playground is filled before the first request is served, so no client
// ever observes a half-seeded workspace. A failed seed closes the runtime and
// exits rather than serving a silently incomplete world.
const speakerEmailOverride = Bun.env.JOOEVENTS_PLAYGROUND_SPEAKER_EMAIL?.trim() || undefined;
let summary;
try {
  summary = await seedJooConPlayground({
    runtime,
    config,
    ...(speakerEmailOverride ? { speakerEmailOverride } : {})
  });
} catch (error) {
  runtime.close();
  throw error;
}
console.log(`[jooevents] seeded playground ${JSON.stringify(summary)}`);
if (speakerEmailOverride) {
  console.log("[jooevents] playground speaker email override active for submission 'okonkwo'");
}
if (!summary.bootstrapOwnerReservationOpen) {
  runtime.close();
  throw new Error(
    'The bootstrap owner access reservation was consumed by the seed; the human owner could no longer be admitted.'
  );
}

const fetch = createRuntimeRequestHandler({
  mode: listener.mode,
  backend: runtime.app.fetch,
  buildDirectory,
  buildIdentity,
  embedFraming: runtime.embedFraming
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
