import { describe, expect, test } from 'bun:test';
import { assertPublishableReleasePath } from './build-single-machine-release';

describe('single-machine release source boundary', () => {
  test('accepts ordinary public product paths', () => {
    for (const path of [
      'README.md',
      'apps/server/src/entry/bun.ts',
      'packages/persistence/migrations/sqlite/e2_0006_airtable_sync.sql',
      'docs/operator/backup.md'
    ]) expect(() => assertPublishableReleasePath(path)).not.toThrow();
  });

  test('refuses private mounts, generated builds, dependencies, secrets, and path escapes', () => {
    for (const path of [
      'AGENTS.md',
      'CLAUDE.md',
      '.env',
      'apps/server/.env.production',
      'apps/web/build/index.html',
      'apps/web/build-live/index.html',
      'apps/web/static/reviews/report.html',
      'apps/web/tests/private/release.test.ts',
      'node_modules/zod/index.js',
      'skills/internal/SKILL.md',
      '../private/docs/plan.md',
      '/tmp/product.ts',
      'apps\\server\\entry.ts'
    ]) expect(() => assertPublishableReleasePath(path)).toThrow();
  });
});
