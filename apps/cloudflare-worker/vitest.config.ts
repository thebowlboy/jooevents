import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repositoryRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: resolve(repositoryRoot, 'wrangler.application.jsonc') },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(resolve(
            repositoryRoot,
            'apps/cloudflare-worker/.generated/migrations'
          ))
        }
      }
    }))
  ],
  test: {
    include: ['test/**/*.workerd.ts'],
    setupFiles: ['./test/apply-migrations.ts']
  }
});
