import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIVE_BUILD_IDENTITY_FILENAME } from '../packages/contracts/src/live-build-identity';
import { SQLITE_MIGRATION_MANIFEST } from '../packages/persistence/src/sqlite/migration-manifest';
import { validateLiveBuildIdentity } from '../apps/server/src/runtime/live-build-identity';

const FORBIDDEN_RELEASE_PATHS = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(?:AGENTS|CLAUDE)\.md$/,
  /(^|\/)node_modules(?:\/|$)/,
  /^apps\/web\/build(?:-live)?(?:\/|$)/,
  /^apps\/web\/static\/reviews(?:\/|$)/,
  /^apps\/web\/tests\/private(?:\/|$)/,
  /^skills(?:\/|$)/
] as const;

export interface SingleMachineReleaseManifest {
  readonly formatVersion: 1;
  readonly kind: 'jooevents-single-machine';
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly sourceDirty: boolean;
  readonly bunVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly sqliteReleaseFloor: string;
  readonly liveBuildDigestSha256: string;
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly sourceDigestSha256: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalSourceDigest(
  files: SingleMachineReleaseManifest['sourceFiles']
): string {
  return sha256(JSON.stringify(files));
}

function command(arguments_: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...arguments_], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`${arguments_[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.toString();
}

function staysInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

export function assertPublishableReleasePath(path: string): void {
  if (
    path.length === 0 || path.startsWith('/') || path.includes('\\') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Release source path is invalid: ${path}`);
  }
  if (FORBIDDEN_RELEASE_PATHS.some((pattern) => pattern.test(path))) {
    throw new TypeError(`Release source path is forbidden: ${path}`);
  }
}

function directRepositoryRoot(path: string): string {
  const root = realpathSync(resolve(path));
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !existsSync(join(root, '.git'))) {
    throw new TypeError('A single-machine release must be built from a direct public Git worktree.');
  }
  return root;
}

function directOutputParent(path: string): string {
  const requested = resolve(path);
  if (!isAbsolute(path) || requested !== path || existsSync(requested)) {
    throw new TypeError('Release output must be an absent, absolute, normalized path.');
  }
  const parent = realpathSync(dirname(requested));
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError('Release output parent must be a direct existing directory.');
  }
  return parent;
}

function publishablePaths(root: string): readonly string[] {
  const output = command([
    'git', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'
  ], root);
  const paths = output.split('\0').filter(Boolean)
    .filter((path) => existsSync(resolve(root, ...path.split('/'))))
    .sort();
  for (const path of paths) assertPublishableReleasePath(path);
  return Object.freeze(paths);
}

function copyDirectFile(input: {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly relativePath: string;
}): SingleMachineReleaseManifest['sourceFiles'][number] {
  assertPublishableReleasePath(input.relativePath);
  const source = resolve(input.sourceRoot, ...input.relativePath.split('/'));
  const destination = resolve(input.destinationRoot, ...input.relativePath.split('/'));
  if (!staysInside(input.sourceRoot, source) || !staysInside(input.destinationRoot, destination)) {
    throw new TypeError(`Release file escaped its root: ${input.relativePath}`);
  }
  let cursor = input.sourceRoot;
  for (const segment of input.relativePath.split('/')) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new TypeError(`Release source contains a symlink: ${input.relativePath}`);
    if (cursor === source) {
      if (!stat.isFile() || stat.nlink !== 1 || realpathSync(cursor) !== cursor) {
        throw new TypeError(`Release source is not a direct file: ${input.relativePath}`);
      }
    } else if (!stat.isDirectory()) {
      throw new TypeError(`Release source parent is not a directory: ${input.relativePath}`);
    }
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination);
  const sourceMode = lstatSync(source).mode;
  chmodSync(destination, (sourceMode & 0o111) === 0 ? 0o644 : 0o755);
  const bytes = readFileSync(destination);
  return Object.freeze({ path: input.relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function copyLiveBuild(input: {
  readonly repositoryRoot: string;
  readonly destinationRoot: string;
}): {
  readonly digestSha256: string;
  readonly files: readonly SingleMachineReleaseManifest['sourceFiles'][number][];
} {
  const sourceRoot = resolve(input.repositoryRoot, 'apps/web/build-live');
  const identity = validateLiveBuildIdentity(sourceRoot);
  const paths = [LIVE_BUILD_IDENTITY_FILENAME, ...identity.files.map((file) => file.path)].sort();
  const files = paths.map((path) => copyDirectFile({
    sourceRoot,
    destinationRoot: resolve(input.destinationRoot, 'apps/web/build-live'),
    relativePath: path
  })).map((file) => Object.freeze({ ...file, path: `apps/web/build-live/${file.path}` }));
  return Object.freeze({ digestSha256: identity.digestSha256, files: Object.freeze(files) });
}

function sourceState(root: string): { readonly revision: string; readonly dirty: boolean } {
  const revision = command(['git', '-C', root, 'rev-parse', 'HEAD'], root).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new TypeError('Public source revision is invalid.');
  const dirty = command(['git', '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], root).length > 0;
  return Object.freeze({ revision, dirty });
}

export async function buildSingleMachineRelease(input: {
  readonly repositoryRoot: string;
  readonly outputDirectory: string;
  readonly releaseId: string;
  readonly allowDirty?: boolean;
}): Promise<SingleMachineReleaseManifest> {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(input.releaseId)) {
    throw new TypeError('Release ID must be 1-80 lowercase letters, digits, dots, underscores, or hyphens.');
  }
  const root = directRepositoryRoot(input.repositoryRoot);
  const output = resolve(input.outputDirectory);
  const outputParent = directOutputParent(output);
  const state = sourceState(root);
  if (state.dirty && input.allowDirty !== true) {
    throw new TypeError('A supported release bundle requires a clean public worktree. Use --allow-dirty only for a rehearsal.');
  }

  command(['bun', 'run', 'check:public-boundary'], root);
  command(['bun', 'run', '--cwd', 'apps/web', 'build:live'], root);

  const staging = mkdtempSync(join(outputParent, `.${basename(output)}.staging-`));
  try {
    const sourceFiles = publishablePaths(root).map((path) => copyDirectFile({
      sourceRoot: root,
      destinationRoot: staging,
      relativePath: path
    }));
    const liveBuild = copyLiveBuild({ repositoryRoot: root, destinationRoot: staging });
    command(['bun', 'install', '--production', '--frozen-lockfile', '--ignore-scripts'], staging);

    const files = Object.freeze([...sourceFiles, ...liveBuild.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ));
    const floor = SQLITE_MIGRATION_MANIFEST.releaseFloors.at(-1)!;
    const manifest: SingleMachineReleaseManifest = Object.freeze({
      formatVersion: 1,
      kind: 'jooevents-single-machine',
      releaseId: input.releaseId,
      sourceRevision: state.revision,
      sourceDirty: state.dirty,
      bunVersion: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      sqliteReleaseFloor: floor.releaseFloorId,
      liveBuildDigestSha256: liveBuild.digestSha256,
      sourceFiles: files,
      sourceDigestSha256: canonicalSourceDigest(files)
    });
    writeFileSync(
      join(staging, 'jooevents-release.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o644 }
    );
    renameSync(staging, output);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function flag(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const outputDirectory = flag(arguments_, '--output');
  const releaseId = flag(arguments_, '--release-id');
  if (!outputDirectory || !releaseId || !isAbsolute(outputDirectory)) {
    process.stderr.write(
      'Usage: bun scripts/build-single-machine-release.ts --output /absolute/absent/path --release-id ID [--allow-dirty]\n'
    );
    process.exit(64);
  }
  const manifest = await buildSingleMachineRelease({
    repositoryRoot: resolve(import.meta.dir, '..'),
    outputDirectory,
    releaseId,
    allowDirty: arguments_.includes('--allow-dirty')
  });
  process.stdout.write(`${JSON.stringify({
    status: 'built',
    outputDirectory,
    releaseId: manifest.releaseId,
    sourceRevision: manifest.sourceRevision,
    sourceDirty: manifest.sourceDirty,
    sourceDigestSha256: manifest.sourceDigestSha256,
    sqliteReleaseFloor: manifest.sqliteReleaseFloor,
    liveBuildDigestSha256: manifest.liveBuildDigestSha256
  })}\n`);
}
