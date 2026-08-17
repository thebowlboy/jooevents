import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SQLITE_MIGRATION_MANIFEST } from '../packages/persistence/src/sqlite/migration-manifest';
import { renderCloudflareD1Migrations } from './prepare-cloudflare-application';

describe('Cloudflare D1 migration generation', () => {
  test('derives one runner migration and the exact canonical application chain', async () => {
    const generated = renderCloudflareD1Migrations();
    expect(generated).toHaveLength(SQLITE_MIGRATION_MANIFEST.migrations.length + 1);
    expect(generated[0]?.fileName).toBe('0000_jooevents_runner.sql');
    expect(generated[0]?.sql).toContain("'frozen_release'");

    for (const [index, canonical] of SQLITE_MIGRATION_MANIFEST.migrations.entries()) {
      const migration = generated[index + 1]!;
      const canonicalBytes = Bun.file(canonical.artifact).text();
      expect(migration.fileName).toBe(
        `${canonical.sequence.toString().padStart(4, '0')}_${canonical.migrationId}.sql`
      );
      expect(migration.sql).toContain(`'${canonical.migrationId}'`);
      expect(migration.sql).toContain(`'${canonical.checksumSha256}'`);
      expect(migration.sql).toContain(`'${canonical.expectedAfterApplicationFingerprint}'`);
      expect(createHash('sha256').update(await canonicalBytes).digest('hex'))
        .toBe(canonical.checksumSha256);
    }
    const rendered = generated.map((migration) => migration.sql).join('\n');
    expect(rendered).not.toMatch(/\bTEMP\s+TABLE/i);
    expect(rendered).not.toContain('temp.e2_');
  });

  test('does not embed an accepted legacy bridge in a fresh D1 database', () => {
    const sql = renderCloudflareD1Migrations().map((migration) => migration.sql).join('\n');
    expect(sql).not.toContain("'legacy_adoption',\n  '");
    expect(sql).not.toContain("'epoch_bridge',\n  '");
    expect(sql).not.toContain('e1_identity_access_to_e2_foundation');
    expect(sql.match(/INSERT INTO schema_migrations/g)).toHaveLength(
      SQLITE_MIGRATION_MANIFEST.migrations.length
    );
  });
});
