import { resolve } from 'node:path';
import { loadConfig } from '../config';
import { startManagedBunRuntime } from '../runtime/bun-runtime-lifecycle';
import { createConfiguredSQLiteAuthRuntime } from '../runtime/configured-sqlite-auth-runtime';
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
const runtime = createConfiguredSQLiteAuthRuntime({ config });

await startManagedBunRuntime({
  runtime,
  start: () => {
    const fetch = createRuntimeRequestHandler({
      mode: listener.mode,
      backend: runtime.app.fetch,
      buildDirectory,
      ...(buildIdentity ? { buildIdentity } : {})
    });
    return Bun.serve({
      hostname: listener.hostname,
      port: listener.port,
      development: listener.development,
      fetch
    });
  },
  onSignalError: () => {
    process.exitCode = 1;
    console.error('JooEvents shutdown failed.');
  }
});
