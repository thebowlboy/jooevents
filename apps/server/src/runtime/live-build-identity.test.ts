import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIVE_BUILD_IDENTITY_FILENAME,
  LIVE_BUILD_IDENTITY_SCOPE,
  liveBuildIdentityBodySchema,
  liveBuildIdentityDigestPayload,
  liveBuildIdentitySchema,
  type LiveBuildIdentity
} from '@jooevents/contracts/live-build-identity';
import { LiveBuildIdentityError, validateLiveBuildIdentity } from './live-build-identity';

let buildDirectory = '';
const closurePaths = [
  '_app/immutable/entry/app.runtime.js',
  '_app/immutable/entry/start.runtime.js',
  'access/blocked.html',
  'access/pending.html',
  'app.html',
  'auth/complete.html',
  'index.html',
  'portal.html',
  'sign-in.html'
] as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function write(relativePath: string, contents = relativePath): void {
  const path = join(buildDirectory, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function currentIdentity(): LiveBuildIdentity {
  const files = closurePaths.map((path) => {
    const bytes = readFileSync(join(buildDirectory, path));
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  const body = liveBuildIdentityBodySchema.parse({
    formatVersion: 1,
    kind: 'live',
    scope: LIVE_BUILD_IDENTITY_SCOPE,
    files
  });
  return liveBuildIdentitySchema.parse({
    ...body,
    digestSha256: sha256(liveBuildIdentityDigestPayload(body))
  });
}

function writeIdentity(identity = currentIdentity()): void {
  write(LIVE_BUILD_IDENTITY_FILENAME, `${JSON.stringify(identity)}\n`);
}

beforeEach(() => {
  buildDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'jooevents-live-build-runtime-test-')));
  for (const path of closurePaths) write(path);
  writeIdentity();
});

afterEach(() => {
  if (buildDirectory) rmSync(buildDirectory, { recursive: true });
  buildDirectory = '';
});

describe('live build startup identity', () => {
  test('accepts the exact deterministic live application dependency closure', () => {
    const expected = currentIdentity();
    expect(validateLiveBuildIdentity(buildDirectory)).toEqual(expected);
  });

  test('rejects a missing, malformed, non-live, or stale marker', () => {
    unlinkSync(join(buildDirectory, LIVE_BUILD_IDENTITY_FILENAME));
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow(LiveBuildIdentityError);

    write(LIVE_BUILD_IDENTITY_FILENAME, '{');
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow('malformed');

    write(LIVE_BUILD_IDENTITY_FILENAME, JSON.stringify({ formatVersion: 1, kind: 'sample' }));
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow('not live');

    const identity = currentIdentity();
    writeIdentity({ ...identity, digestSha256: `${identity.digestSha256.slice(0, 63)}0` });
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow('digest');
  });

  test('rejects missing, changed, and correctly re-hashed sample dependencies', () => {
    unlinkSync(join(buildDirectory, '_app/immutable/entry/start.runtime.js'));
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow('missing');

    write('_app/immutable/entry/start.runtime.js');
    writeIdentity();
    write('app.html', 'tampered');
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow('has been changed');

    write('app.html');
    writeIdentity();
    write('app.html', 'changed after proof');
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow('recorded shape');

    write('app.html', 'Mid-flight');
    writeIdentity();
    expect(() => validateLiveBuildIdentity(buildDirectory)).toThrow('sample scenario data');
  });
});
