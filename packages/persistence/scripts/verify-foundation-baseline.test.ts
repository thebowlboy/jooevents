import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { verifyFoundationBaseline } from './verify-foundation-baseline';

const acceptedArtifacts = [
  '../migrations/sqlite/schema_migrations.sql',
  '../migrations/sqlite/0001_identity_access.sql',
  '../migrations/sqlite/e1_identity_access_to_e2_foundation.sql',
  '../migrations/sqlite/e2_0001_jooevents_foundation.sql',
  '../migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.schema.json',
  '../migrations/sqlite/checkpoints/e2_0001_jooevents_foundation.receipt.json'
].map((path) => new URL(path, import.meta.url));

test('the Foundation baseline verifier leaves every accepted artifact byte unchanged', () => {
  const before = acceptedArtifacts.map((path) => readFileSync(path));
  const result = verifyFoundationBaseline();
  const after = acceptedArtifacts.map((path) => readFileSync(path));

  expect(result.sourceArtifactCount).toBe(52);
  expect(result.freshApplicationFingerprint).toBe(result.authoringApplicationFingerprint);
  expect(result.freshApplicationFingerprint).toBe(result.bridgedApplicationFingerprint);
  expect(result.freshFullFingerprint).toBe(result.bridgedFullFingerprint);
  expect(after).toEqual(before);
});
