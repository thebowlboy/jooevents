import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  LIVE_BUILD_IDENTITY_FILENAME,
  liveBuildIdentityDigestPayload,
  liveBuildIdentitySchema,
  type LiveBuildIdentity,
  type LiveBuildIdentityFile
} from '@jooevents/contracts/live-build-identity';

const maximumMarkerBytes = 2 * 1024 * 1024;
const maximumFileBytes = 128 * 1024 * 1024;
const maximumClosureBytes = 512 * 1024 * 1024;
const forbiddenSampleEvidence = [
  'Mid-flight',
  'Decision crunch',
  'All clear',
  'je-scenario',
  'Nothing is a real event',
  'Every count, row, and name in this workspace comes from that scenario.'
] as const;

export class LiveBuildIdentityError extends Error {
  readonly code = 'live_build_identity_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'LiveBuildIdentityError';
  }
}

function invalid(message: string): never {
  throw new LiveBuildIdentityError(message);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function staysInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function exactRoot(buildDirectory: string): string {
  if (!isAbsolute(buildDirectory) || resolve(buildDirectory) !== buildDirectory) {
    return invalid('The live web build path must be absolute and normalized.');
  }
  try {
    const stat = lstatSync(buildDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(buildDirectory) !== buildDirectory) {
      return invalid('The live web build root must be a direct canonical directory.');
    }
    return buildDirectory;
  } catch (error) {
    if (error instanceof LiveBuildIdentityError) throw error;
    return invalid('The live web build root is unavailable.');
  }
}

function readDirectFile(
  root: string,
  descriptor: Pick<LiveBuildIdentityFile, 'path' | 'bytes'>,
  maximumBytes: number
): Buffer {
  const path = resolve(root, ...descriptor.path.split('/'));
  if (!staysInside(root, path)) return invalid('A live build identity path escaped its root.');

  let cursor = root;
  try {
    for (const segment of descriptor.path.split('/')) {
      cursor = join(cursor, segment);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) return invalid('A live build identity path contains a symbolic link.');
      if (cursor === path) {
        if (
          !stat.isFile() || stat.nlink !== 1 || realpathSync(cursor) !== cursor
          || stat.size !== descriptor.bytes || stat.size > maximumBytes
        ) {
          return invalid('A live build identity file no longer matches its recorded shape.');
        }
      } else if (!stat.isDirectory()) {
        return invalid('A live build identity parent is not a directory.');
      }
    }
    return readFileSync(path);
  } catch (error) {
    if (error instanceof LiveBuildIdentityError) throw error;
    return invalid('A live build identity file is missing or unreadable.');
  }
}

function markerBytes(root: string): Buffer {
  const path = LIVE_BUILD_IDENTITY_FILENAME;
  const resolved = resolve(root, path);
  let size: number;
  try {
    const stat = lstatSync(resolved);
    if (
      !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || realpathSync(resolved) !== resolved || stat.size > maximumMarkerBytes
    ) {
      return invalid('The live web build identity marker has an unsafe shape.');
    }
    size = stat.size;
  } catch (error) {
    if (error instanceof LiveBuildIdentityError) throw error;
    return invalid('The live web build identity marker is missing.');
  }
  return readDirectFile(root, { path, bytes: size }, maximumMarkerBytes);
}

function assertRequiredClosureFiles(identity: LiveBuildIdentity): void {
  const paths = new Set(identity.files.map((file) => file.path));
  if (
    ![
      'index.html',
      'sign-in.html',
      'auth/complete.html',
      'access/pending.html',
      'access/blocked.html',
      'app.html',
      'portal.html'
    ].every((path) => paths.has(path))
    || !identity.files.some((file) => /^_app\/immutable\/entry\/start\.[A-Za-z0-9_-]+\.js$/.test(file.path))
    || !identity.files.some((file) => /^_app\/immutable\/entry\/app\.[A-Za-z0-9_-]+\.js$/.test(file.path))
  ) {
    invalid('The live web build identity does not contain a complete application shell.');
  }
}

/** Verifies the exact application bytes approved by the live-build proof. */
export function validateLiveBuildIdentity(buildDirectory: string): LiveBuildIdentity {
  const root = exactRoot(buildDirectory);
  let candidate: unknown;
  try {
    candidate = JSON.parse(markerBytes(root).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof LiveBuildIdentityError) throw error;
    return invalid('The live web build identity marker is malformed.');
  }
  const parsed = liveBuildIdentitySchema.safeParse(candidate);
  if (!parsed.success) return invalid('The live web build identity marker is malformed or not live.');
  const identity = parsed.data;
  const expectedDigest = sha256(liveBuildIdentityDigestPayload(identity));
  if (identity.digestSha256 !== expectedDigest) {
    return invalid('The live web build identity digest is stale or invalid.');
  }
  assertRequiredClosureFiles(identity);

  let totalBytes = 0;
  for (const file of identity.files) {
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumClosureBytes || file.bytes > maximumFileBytes) {
      return invalid('The live web build dependency closure exceeds its size limit.');
    }
    const bytes = readDirectFile(root, file, maximumFileBytes);
    if (sha256(bytes) !== file.sha256) {
      return invalid('A live web build dependency is stale or has been changed.');
    }
    if (['.html', '.js', '.json'].includes(extname(file.path))) {
      const contents = bytes.toString('utf8');
      if (forbiddenSampleEvidence.some((value) => contents.includes(value))) {
        return invalid('The live web build dependency closure contains sample scenario data.');
      }
    }
  }

  return Object.freeze({
    ...identity,
    files: Object.freeze(identity.files.map((file) => Object.freeze({ ...file })))
  });
}
