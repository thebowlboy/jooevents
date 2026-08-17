import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SQLITE_MIGRATION_MANIFEST } from '../packages/persistence/src/sqlite/migration-manifest';
import { renderCloudflareD1Migrations } from './prepare-cloudflare-application';

describe('Cloudflare D1 migration generation', () => {
  test('derives one runner migration and the exact canonical application chain', async () => {
    const generated = renderCloudflareD1Migrations();
    expect(generated).toHaveLength(SQLITE_MIGRATION_MANIFEST.migrations.length + 3);
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
    const runtime = generated.at(-2)!;
    expect(runtime.fileName).toBe('1000_d1_runtime_v1.sql');
    expect(runtime.sql).toContain('d1_operation_batch_guards');
    expect(runtime.sql).toContain("RAISE(ABORT, 'jooevents_d1_guard_conflict')");
    const fileTransfers = generated.at(-1)!;
    expect(fileTransfers.fileName).toBe('1001_d1_file_transfer_attempts_v1.sql');
    expect(fileTransfers.sql).toContain('d1_file_upload_transfer_attempts');
    expect(fileTransfers.sql).toContain('d1_file_upload_one_effective_transfer');
    expect(fileTransfers.sql).toContain('d1_file_upload_transfer_one_resolution');
    const rendered = generated.map((migration) => migration.sql).join('\n');
    expect(rendered).not.toMatch(/\bTEMP\s+TABLE/i);
    expect(rendered).not.toContain('temp.e2_');
    expect(rendered).not.toContain("token_hint GLOB 'joak1_");
    expect(rendered).not.toContain("token_hint GLOB 'jooak1_");
    expect(rendered).toContain("instr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', substr(token_hint, 8, 1)) > 0");
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
