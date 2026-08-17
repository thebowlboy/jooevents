import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  createRetainedSQLiteBackup,
  openSQLite,
  SQLITE_MIGRATION_MANIFEST,
  statusSQLite
} from '@jooevents/persistence';
import { loadConfig } from '../config';
import { loadCommunicationsProviderConfig, loadMailSenderConfig } from '../config/communications';
import { validateLiveBuildIdentity } from '../runtime/live-build-identity';
import { resolveBunListenerConfiguration } from '../runtime/request-handler';

const MINIMUM_BUN_VERSION = [1, 3, 6] as const;
const PLACEHOLDER = 'REPLACE_IN_FILE';

export type SingleMachineServiceKind = 'systemd' | 'launchd';

export interface SingleMachineInstallResult {
  readonly status: 'installed' | 'already_installed';
  readonly databaseStatus: 'created' | 'current';
  readonly environmentFile: string;
  readonly serviceFile: string;
  readonly callbackUrl: string;
  readonly nextAction: string | null;
}

export interface DoctorCheck {
  readonly id: string;
  readonly status: 'passed' | 'failed' | 'action_required';
  readonly summary: string;
  readonly detail?: string;
}

export interface SingleMachineDoctorReport {
  readonly status: 'passed' | 'action_required' | 'failed';
  readonly releaseId: string | null;
  readonly sqliteReleaseFloor: string;
  /** Stable non-secret safety pin required by backup and upgrade commands. */
  readonly databaseId: string | null;
  readonly checks: readonly DoctorCheck[];
}

export interface SingleMachineUpgradeResult {
  readonly status: 'upgraded' | 'already_current';
  readonly databaseId: string;
  readonly migrationId: string;
  readonly sqliteReleaseFloor: string;
  readonly backupPath: string;
  readonly backupSha256: string;
}

export interface SingleMachineReleaseIdentity {
  readonly releaseId: string;
  readonly sqliteReleaseFloor: string;
  readonly sourceRevision: string;
}

interface ReleaseManifest {
  readonly formatVersion: number;
  readonly kind: string;
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly sourceDirty: boolean;
  readonly bunVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly sqliteReleaseFloor: string;
  readonly liveBuildDigestSha256: string;
  readonly sourceFiles: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
  readonly sourceDigestSha256: string;
}

interface ReleaseManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function floorId(): string {
  return SQLITE_MIGRATION_MANIFEST.releaseFloors.at(-1)!.releaseFloorId;
}

function resolveDataChild(dataDirectory: string, candidate: string, label: string): string {
  const path = resolve(dataDirectory, candidate);
  const fromData = relative(dataDirectory, path);
  if (fromData.length === 0 || fromData.startsWith('..') || isAbsolute(fromData)) {
    throw new TypeError(`${label} must stay below the data directory.`);
  }
  return path;
}

function assertAbsoluteNormalized(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new TypeError(`${label} must be an absolute normalized path.`);
  return path;
}

function assertPrivateDirectory(path: string, label: string, create: boolean): string {
  assertAbsoluteNormalized(path, label);
  if (!existsSync(path)) {
    if (!create) throw new TypeError(`${label} does not exist.`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must be a direct owner-only directory.`);
  }
  return path;
}

function assertDirectDirectory(path: string, label: string): string {
  assertAbsoluteNormalized(path, label);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new TypeError(`${label} must be a direct directory.`);
  }
  return path;
}

function assertPrivateFile(path: string, label: string): void {
  assertAbsoluteNormalized(path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path
      || (stat.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must be a direct owner-only file.`);
  }
}

function chmodOwnerOnlyFileIfPresent(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) {
    throw new TypeError('A generated SQLite file is not a direct single-link file.');
  }
  chmodSync(path, 0o600);
}

function writeExclusive(path: string, contents: string, mode: number, privateParent = true): void {
  assertAbsoluteNormalized(path, 'Output file');
  if (privateParent) assertPrivateDirectory(resolve(path, '..'), 'Output parent', false);
  else assertDirectDirectory(resolve(path, '..'), 'Output parent');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, mode);
  try {
    writeFileSync(descriptor, contents, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
}

function environmentText(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
      throw new TypeError('Generated environment data is not line-safe.');
    }
    return `${key}=${value}`;
  }).join('\n')}\n`;
}

export function readSingleMachineEnvironmentFile(path: string): Readonly<Record<string, string>> {
  assertPrivateFile(path, 'Environment file');
  const environment: Record<string, string> = {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (separator <= 0 || !/^[A-Z][A-Z0-9_]*$/.test(key) || environment[key] !== undefined) {
      throw new TypeError(`Environment file line ${index + 1} is invalid.`);
    }
    environment[key] = value;
  }
  return Object.freeze(environment);
}

function generatedEnvironment(input: {
  readonly dataDirectory: string;
  readonly backupDirectory: string;
  readonly logDirectory: string;
  readonly baseUrl: string;
  readonly ownerEmail: string;
  readonly googleClientId: string;
  readonly admissionMode: 'pending' | 'workspace_domain' | 'reservation_only';
  readonly googleHostedDomain?: string;
  readonly port: number;
}): Readonly<Record<string, string>> {
  const key = () => randomBytes(32).toString('base64url');
  return Object.freeze({
    NODE_ENV: 'production',
    JOOEVENTS_INTERNAL_HTTP_PORT: String(input.port),
    JOOEVENTS_BASE_URL: input.baseUrl,
    JOOEVENTS_TRUSTED_ORIGINS: '',
    JOOEVENTS_AUTH_SECRETS: `1:${randomBytes(48).toString('base64url')}`,
    JOOEVENTS_REQUEST_HASH_KEYS: `1:${key()}`,
    JOOEVENTS_IDEMPOTENCY_KEYS: `1:${key()}`,
    JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS: `1:${key()}`,
    JOOEVENTS_PERSISTENT_HMAC_KEYS: `1:${key()}`,
    JOOEVENTS_GOOGLE_CLIENT_ID: input.googleClientId,
    JOOEVENTS_GOOGLE_CLIENT_SECRET: PLACEHOLDER,
    JOOEVENTS_GOOGLE_CALLBACK_VERIFIED: 'false',
    JOOEVENTS_ADMISSION_MODE: input.admissionMode,
    ...(input.googleHostedDomain ? { JOOEVENTS_GOOGLE_HOSTED_DOMAIN: input.googleHostedDomain } : {}),
    JOOEVENTS_BOOTSTRAP_OWNER_EMAIL: input.ownerEmail,
    JOOEVENTS_DATABASE_DRIVER: 'sqlite',
    JOOEVENTS_DATABASE_PATH: 'jooevents.sqlite',
    JOOEVENTS_BLOB_DRIVER: 'filesystem',
    JOOEVENTS_DATA_DIRECTORY: input.dataDirectory,
    JOOEVENTS_EMAIL_PROVIDER_MODE: 'disabled',
    JOOEVENTS_BACKUP_DIRECTORY: input.backupDirectory,
    JOOEVENTS_LOG_DIRECTORY: input.logDirectory
  });
}

function quoteSystemd(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function renderSingleMachineService(input: {
  readonly kind: SingleMachineServiceKind;
  readonly releaseRoot: string;
  readonly environmentFile: string;
  readonly dataDirectory: string;
  readonly backupDirectory: string;
  readonly logDirectory: string;
  readonly bunExecutable: string;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
}): string {
  const entry = join(input.releaseRoot, 'apps/server/src/entry/bun.ts');
  const safeServiceIdentity = input.serviceUser !== undefined
    && input.serviceGroup !== undefined
    && /^[a-z_][a-z0-9_-]*$/i.test(input.serviceUser)
    && /^[a-z_][a-z0-9_-]*$/i.test(input.serviceGroup);
  if (input.kind === 'systemd') {
    if (!safeServiceIdentity) {
      throw new TypeError('systemd service generation requires safe user and group names.');
    }
    return [
      '[Unit]',
      'Description=JooEvents single-machine service',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `User=${input.serviceUser}`,
      `Group=${input.serviceGroup}`,
      `WorkingDirectory=${quoteSystemd(input.releaseRoot)}`,
      `EnvironmentFile=${quoteSystemd(input.environmentFile)}`,
      `ExecStart=${quoteSystemd(input.bunExecutable)} ${quoteSystemd(entry)}`,
      'Restart=on-failure',
      'RestartSec=5s',
      'TimeoutStopSec=45s',
      'KillSignal=SIGTERM',
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'LimitNOFILE=65536',
      'TasksMax=512',
      'MemoryMax=2G',
      `ReadWritePaths=${quoteSystemd(input.dataDirectory)} ${quoteSystemd(input.backupDirectory)} ${quoteSystemd(input.logDirectory)}`,
      'UMask=0077',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      ''
    ].join('\n');
  }
  if ((input.serviceUser === undefined) !== (input.serviceGroup === undefined)
      || ((input.serviceUser !== undefined || input.serviceGroup !== undefined)
        && !safeServiceIdentity)) {
    throw new TypeError('launchd service identity requires safe paired user and group names.');
  }
  const arguments_ = [input.bunExecutable, `--env-file=${input.environmentFile}`, entry];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>Label</key><string>com.joocorp.jooevents</string>',
    '<key>ProgramArguments</key><array>',
    ...arguments_.map((argument) => `<string>${xml(argument)}</string>`),
    '</array>',
    ...(safeServiceIdentity ? [
      `<key>UserName</key><string>${xml(input.serviceUser!)}</string>`,
      `<key>GroupName</key><string>${xml(input.serviceGroup!)}</string>`
    ] : []),
    `<key>WorkingDirectory</key><string>${xml(input.releaseRoot)}</string>`,
    '<key>Umask</key><integer>63</integer>',
    '<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>65536</integer></dict>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>5</integer>',
    `<key>StandardOutPath</key><string>${xml(join(input.logDirectory, 'jooevents.log'))}</string>`,
    `<key>StandardErrorPath</key><string>${xml(join(input.logDirectory, 'jooevents-error.log'))}</string>`,
    '</dict></plist>',
    ''
  ].join('\n');
}

function environmentMatchesInstall(environment: Readonly<Record<string, string>>, input: {
  readonly dataDirectory: string;
  readonly backupDirectory: string;
  readonly logDirectory: string;
  readonly baseUrl: string;
  readonly ownerEmail: string;
  readonly googleClientId: string;
  readonly admissionMode: string;
  readonly googleHostedDomain?: string;
  readonly port: number;
}): boolean {
  return environment.NODE_ENV === 'production'
    && environment.JOOEVENTS_DATA_DIRECTORY === input.dataDirectory
    && environment.JOOEVENTS_BACKUP_DIRECTORY === input.backupDirectory
    && environment.JOOEVENTS_LOG_DIRECTORY === input.logDirectory
    && environment.JOOEVENTS_BASE_URL === input.baseUrl
    && environment.JOOEVENTS_BOOTSTRAP_OWNER_EMAIL === input.ownerEmail
    && environment.JOOEVENTS_GOOGLE_CLIENT_ID === input.googleClientId
    && environment.JOOEVENTS_ADMISSION_MODE === input.admissionMode
    && environment.JOOEVENTS_GOOGLE_HOSTED_DOMAIN === input.googleHostedDomain
    && environment.JOOEVENTS_INTERNAL_HTTP_PORT === String(input.port)
    && environment.JOOEVENTS_DATABASE_DRIVER === 'sqlite'
    && environment.JOOEVENTS_DATABASE_PATH === 'jooevents.sqlite'
    && environment.JOOEVENTS_BLOB_DRIVER === 'filesystem';
}

export function installSingleMachine(input: {
  readonly releaseRoot: string;
  readonly dataDirectory: string;
  readonly backupDirectory: string;
  readonly logDirectory: string;
  readonly environmentFile: string;
  readonly serviceFile: string;
  readonly serviceKind: SingleMachineServiceKind;
  readonly bunExecutable: string;
  readonly baseUrl: string;
  readonly ownerEmail: string;
  readonly googleClientId: string;
  readonly admissionMode: 'pending' | 'workspace_domain' | 'reservation_only';
  readonly googleHostedDomain?: string;
  readonly port: number;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly allowRehearsal?: boolean;
}): SingleMachineInstallResult {
  const releaseRoot = realpathSync(assertAbsoluteNormalized(input.releaseRoot, 'Release root'));
  const release = checkReleaseManifest(releaseRoot, input.allowRehearsal === true);
  if (release.checks.some((check) => check.status === 'failed')) {
    throw new TypeError('The release bundle failed its source and live-build integrity checks.');
  }
  const dataDirectory = assertPrivateDirectory(input.dataDirectory, 'Data directory', true);
  const backupDirectory = assertPrivateDirectory(input.backupDirectory, 'Backup directory', true);
  const logDirectory = assertPrivateDirectory(input.logDirectory, 'Log directory', true);
  if (new Set([dataDirectory, backupDirectory, logDirectory]).size !== 3) {
    throw new TypeError('Data, backup, and log directories must be distinct.');
  }
  assertPrivateDirectory(resolve(input.environmentFile, '..'), 'Environment-file parent', false);
  assertDirectDirectory(resolve(input.serviceFile, '..'), 'Service-file parent');
  const baseUrl = new URL(input.baseUrl);
  if (baseUrl.origin !== input.baseUrl) throw new TypeError('Base URL must be one canonical origin.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new TypeError('Port is invalid.');

  const desiredEnvironment = generatedEnvironment({
    dataDirectory,
    backupDirectory,
    logDirectory,
    baseUrl: input.baseUrl,
    ownerEmail: input.ownerEmail,
    googleClientId: input.googleClientId,
    admissionMode: input.admissionMode,
    ...(input.googleHostedDomain ? { googleHostedDomain: input.googleHostedDomain } : {}),
    port: input.port
  });
  loadConfig(desiredEnvironment);
  resolveBunListenerConfiguration(desiredEnvironment);
  loadCommunicationsProviderConfig(desiredEnvironment);
  loadMailSenderConfig(desiredEnvironment);
  const service = renderSingleMachineService({
    kind: input.serviceKind,
    releaseRoot,
    environmentFile: input.environmentFile,
    dataDirectory,
    backupDirectory,
    logDirectory,
    bunExecutable: input.bunExecutable,
    ...(input.serviceUser ? { serviceUser: input.serviceUser } : {}),
    ...(input.serviceGroup ? { serviceGroup: input.serviceGroup } : {})
  });
  let existing = false;
  if (existsSync(input.environmentFile)) {
    const environment = readSingleMachineEnvironmentFile(input.environmentFile);
    if (!environmentMatchesInstall(environment, input)) {
      throw new TypeError('The existing environment file belongs to a different installation request.');
    }
    existing = true;
  } else {
    writeExclusive(input.environmentFile, environmentText(desiredEnvironment), 0o600);
  }

  const blobDirectory = join(dataDirectory, 'blobs');
  assertPrivateDirectory(blobDirectory, 'Blob directory', true);
  const databasePath = join(dataDirectory, 'jooevents.sqlite');
  let databaseStatus: SingleMachineInstallResult['databaseStatus'];
  if (existsSync(databasePath)) {
    const status = statusSQLite(databasePath);
    const floor = SQLITE_MIGRATION_MANIFEST.releaseFloors.at(-1)!;
    if (status.kind !== 'compatible' || status.migration.databaseClass !== 'frozen_release'
        || status.migration.migrationId !== floor.terminalMigration.migrationId) {
      throw new TypeError('The existing database is not at the supported frozen release floor.');
    }
    databaseStatus = 'current';
  } else {
    const created = openSQLite(databasePath, { migrationPolicy: 'apply', databaseClass: 'frozen_release' });
    try {
      databaseStatus = 'created';
    } finally {
      created.sqlite.close();
    }
  }
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    chmodOwnerOnlyFileIfPresent(path);
  }

  if (existsSync(input.serviceFile)) {
    const stat = lstatSync(input.serviceFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || readFileSync(input.serviceFile, 'utf8') !== service) {
      throw new TypeError('The existing service file differs from the requested installation.');
    }
  } else {
    writeExclusive(input.serviceFile, service, input.serviceKind === 'systemd' ? 0o644 : 0o600, false);
  }

  return Object.freeze({
    status: existing && databaseStatus === 'current' ? 'already_installed' : 'installed',
    databaseStatus,
    environmentFile: input.environmentFile,
    serviceFile: input.serviceFile,
    callbackUrl: `${input.baseUrl}/api/auth/callback/google`,
    nextAction: readSingleMachineEnvironmentFile(input.environmentFile).JOOEVENTS_GOOGLE_CLIENT_SECRET === PLACEHOLDER
      ? 'Set JOOEVENTS_GOOGLE_CLIENT_SECRET directly in the owner-only environment file.'
      : null
  });
}

function readReleaseManifest(releaseRoot: string): ReleaseManifest {
  const path = join(releaseRoot, 'jooevents-release.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) {
    throw new TypeError('Release manifest must be a direct single-link file.');
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReleaseManifest>;
  const sourceFiles = value.sourceFiles as readonly ReleaseManifestFile[] | undefined;
  const sourceFilesValid = Array.isArray(sourceFiles) && sourceFiles.every((file, index, files) =>
    typeof file === 'object' && file !== null &&
    typeof file.path === 'string' && file.path.length >= 1 && !file.path.startsWith('/') && !file.path.includes('\\') &&
    file.path.split('/').every((segment: string) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    Number.isSafeInteger(file.bytes) && file.bytes >= 0 &&
    typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256) &&
    (index === 0 || files[index - 1]!.path < file.path)
  );
  if (
    value.formatVersion !== 1 || value.kind !== 'jooevents-single-machine' ||
    typeof value.releaseId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.releaseId) ||
    typeof value.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(value.sourceRevision) ||
    typeof value.sourceDirty !== 'boolean' || typeof value.bunVersion !== 'string' ||
    typeof value.platform !== 'string' || typeof value.architecture !== 'string' ||
    typeof value.sqliteReleaseFloor !== 'string' || typeof value.liveBuildDigestSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.liveBuildDigestSha256) ||
    !sourceFilesValid || typeof value.sourceDigestSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.sourceDigestSha256)
  ) throw new TypeError('Release manifest is malformed.');
  return value as ReleaseManifest;
}

function checkReleaseManifest(releaseRoot: string, allowRehearsal: boolean): {
  readonly manifest: ReleaseManifest;
  readonly checks: readonly DoctorCheck[];
} {
  const checks: DoctorCheck[] = [];
  const manifest = readReleaseManifest(releaseRoot);
  const digest = sha256(JSON.stringify(manifest.sourceFiles));
  checks.push({
    id: 'release.manifest',
    status: manifest.sqliteReleaseFloor === floorId() && digest === manifest.sourceDigestSha256
      && /^[0-9a-f]{40}$/.test(manifest.sourceRevision) ? 'passed' : 'failed',
    summary: 'Release manifest and SQLite floor are internally consistent.'
  });
  checks.push({
    id: 'release.clean_source',
    status: !manifest.sourceDirty || allowRehearsal ? 'passed' : 'failed',
    summary: manifest.sourceDirty ? 'The bundle is explicitly marked as a working-tree rehearsal.' : 'The bundle came from a clean public source tree.'
  });
  const changed = manifest.sourceFiles.find((file) => {
    const path = resolve(releaseRoot, ...file.path.split('/'));
    if (!path.startsWith(`${releaseRoot}${sep}`) || !existsSync(path)) return true;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return true;
    const bytes = readFileSync(path);
    return bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256;
  });
  checks.push({
    id: 'release.source_bytes',
    status: changed ? 'failed' : 'passed',
    summary: changed ? 'A release source file is missing or changed.' : 'Every release source file matches its recorded digest.',
    ...(changed ? { detail: changed.path } : {})
  });
  const live = validateLiveBuildIdentity(join(releaseRoot, 'apps/web/build-live'));
  checks.push({
    id: 'release.live_build',
    status: live.digestSha256 === manifest.liveBuildDigestSha256 ? 'passed' : 'failed',
    summary: 'The production web dependency closure matches its release identity.'
  });
  return Object.freeze({ manifest, checks: Object.freeze(checks) });
}

export function verifySingleMachineRelease(
  releaseRootInput: string,
  allowRehearsal = false
): SingleMachineReleaseIdentity {
  const releaseRoot = realpathSync(assertAbsoluteNormalized(releaseRootInput, 'Release root'));
  const release = checkReleaseManifest(releaseRoot, allowRehearsal);
  if (release.checks.some((check) => check.status === 'failed')) {
    throw new TypeError('The release bundle failed its source and live-build integrity checks.');
  }
  return Object.freeze({
    releaseId: release.manifest.releaseId,
    sqliteReleaseFloor: release.manifest.sqliteReleaseFloor,
    sourceRevision: release.manifest.sourceRevision
  });
}

function versionAtLeast(version: string, floor: readonly number[]): boolean {
  const values = version.split('.').map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return false;
  for (let index = 0; index < floor.length; index += 1) {
    if ((values[index] ?? 0) > floor[index]!) return true;
    if ((values[index] ?? 0) < floor[index]!) return false;
  }
  return true;
}

function finalStatus(checks: readonly DoctorCheck[]): SingleMachineDoctorReport['status'] {
  return checks.some((check) => check.status === 'failed')
    ? 'failed'
    : checks.some((check) => check.status === 'action_required')
      ? 'action_required'
      : 'passed';
}

export function doctorSingleMachine(input: {
  readonly releaseRoot: string;
  readonly environmentFile: string;
  readonly allowRehearsal?: boolean;
}): SingleMachineDoctorReport {
  const releaseRoot = realpathSync(assertAbsoluteNormalized(input.releaseRoot, 'Release root'));
  const release = checkReleaseManifest(releaseRoot, input.allowRehearsal === true);
  const checks = [...release.checks];
  checks.push({
    id: 'runtime.bun',
    status: versionAtLeast(Bun.version, MINIMUM_BUN_VERSION) ? 'passed' : 'failed',
    summary: `Bun ${Bun.version} satisfies the supported runtime floor.`
  });
  checks.push({
    id: 'runtime.platform',
    status: ['linux', 'darwin'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)
      && release.manifest.platform === process.platform && release.manifest.architecture === process.arch
      ? 'passed' : 'failed',
    summary: `${process.platform}/${process.arch} matches the platform-specific release artifact.`
  });

  const environment = readSingleMachineEnvironmentFile(input.environmentFile);
  let databaseId: string | null = null;
  const placeholders = Object.entries(environment).filter(([, value]) => value === PLACEHOLDER).map(([key]) => key);
  checks.push({
    id: 'configuration.secrets',
    status: placeholders.length === 0 ? 'passed' : 'action_required',
    summary: placeholders.length === 0 ? 'Required secret names are populated.' : 'Required secret values still need local entry.',
    ...(placeholders.length > 0 ? { detail: placeholders.join(', ') } : {})
  });

  try {
    const config = loadConfig(environment);
    resolveBunListenerConfiguration(environment);
    loadCommunicationsProviderConfig(environment);
    loadMailSenderConfig(environment);
    checks.push({ id: 'configuration.contract', status: 'passed', summary: 'The complete retained runtime configuration is valid.' });
    const dataDirectory = assertPrivateDirectory(config.dataDirectory!, 'Data directory', false);
    assertPrivateDirectory(join(dataDirectory, 'blobs'), 'Blob directory', false);
    const backupDirectory = assertPrivateDirectory(environment.JOOEVENTS_BACKUP_DIRECTORY!, 'Backup directory', false);
    const logDirectory = assertPrivateDirectory(environment.JOOEVENTS_LOG_DIRECTORY!, 'Log directory', false);
    const availableBytes = statfsSync(backupDirectory).bavail * statfsSync(backupDirectory).bsize;
    checks.push({
      id: 'storage.directories',
      status: dataDirectory !== backupDirectory && dataDirectory !== logDirectory && backupDirectory !== logDirectory
        && availableBytes >= 64 * 1024 * 1024 ? 'passed' : 'failed',
      summary: 'Data, blob, backup, and log directories are private and distinct.'
    });
    const status = statusSQLite(resolveDataChild(dataDirectory, config.databasePath!, 'Database path'));
    databaseId = status.kind === 'compatible' ? status.migration.databaseId ?? null : null;
    const terminal = SQLITE_MIGRATION_MANIFEST.releaseFloors.at(-1)!.terminalMigration;
    checks.push({
      id: 'storage.database',
      status: status.kind === 'compatible' && status.migration.databaseClass === 'frozen_release'
        && status.migration.migrationId === terminal.migrationId ? 'passed' : 'failed',
      summary: 'The SQLite database is at the supported frozen release floor.'
    });
    checks.push({
      id: 'auth.google_callback',
      status: placeholders.includes('JOOEVENTS_GOOGLE_CLIENT_SECRET')
        || environment.JOOEVENTS_GOOGLE_CALLBACK_VERIFIED !== 'true' ? 'action_required' : 'passed',
      summary: environment.JOOEVENTS_GOOGLE_CALLBACK_VERIFIED === 'true'
        ? 'Google callback configuration is locally recorded as provider-verified.'
        : 'Google callback configuration needs provider-console confirmation.',
      detail: `${config.baseUrl}/api/auth/callback/google`
    });
    checks.push({
      id: 'email.provider',
      status: environment.JOOEVENTS_EMAIL_PROVIDER_MODE === 'disabled' ? 'passed' : 'action_required',
      summary: environment.JOOEVENTS_EMAIL_PROVIDER_MODE === 'disabled'
        ? 'Outbound email is explicitly disabled.'
        : 'Configured outbound email requires its provider readiness probe.'
    });
  } catch (error) {
    checks.push({
      id: 'configuration.contract',
      status: placeholders.length > 0 ? 'action_required' : 'failed',
      summary: 'The retained runtime configuration is not ready.',
      detail: error instanceof Error ? error.message.replaceAll(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]') : 'Unknown configuration failure.'
    });
  }

  return Object.freeze({
    status: finalStatus(checks),
    releaseId: release.manifest.releaseId,
    sqliteReleaseFloor: floorId(),
    databaseId,
    checks: Object.freeze(checks)
  });
}

export async function verifyRunningSingleMachine(input: {
  readonly releaseRoot: string;
  readonly environmentFile: string;
  readonly allowRehearsal?: boolean;
}): Promise<SingleMachineDoctorReport> {
  const doctor = doctorSingleMachine(input);
  const environment = readSingleMachineEnvironmentFile(input.environmentFile);
  const listener = resolveBunListenerConfiguration(environment);
  const origin = `http://127.0.0.1:${listener.port}`;
  const checks = [...doctor.checks];
  try {
    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
    const body = await health.json() as {
      readonly ok?: boolean;
      readonly background?: { readonly state?: string };
    };
    checks.push({
      id: 'runtime.health',
      status: health.status === 200 && body.ok === true && body.background?.state === 'running' ? 'passed' : 'failed',
      summary: 'The running service reports healthy retained storage and background work.'
    });
    const root = await fetch(`${origin}/`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
      signal: AbortSignal.timeout(5_000)
    });
    checks.push({
      id: 'runtime.static_application',
      status: root.status === 200 && root.headers.get('content-type')?.startsWith('text/html') ? 'passed' : 'failed',
      summary: 'The running service serves the verified live application shell.'
    });
    const reserved = await fetch(`${origin}/api/__jooevents_doctor_not_found__`, {
      signal: AbortSignal.timeout(5_000)
    });
    checks.push({
      id: 'runtime.reserved_routes',
      status: reserved.status === 404 && reserved.headers.get('content-type')?.startsWith('application/json')
        ? 'passed' : 'failed',
      summary: 'Reserved backend paths stay outside the SPA fallback.'
    });
  } catch (error) {
    checks.push({
      id: 'runtime.health',
      status: 'failed',
      summary: 'The running service could not be verified on its internal listener.',
      detail: error instanceof Error ? error.message : 'Unknown health failure.'
    });
  }
  return Object.freeze({
    ...doctor,
    status: finalStatus(checks),
    checks: Object.freeze(checks)
  });
}

export function upgradeSingleMachine(input: {
  readonly releaseRoot: string;
  readonly environmentFile: string;
  readonly expectedDatabaseId: string;
  readonly maximumBackupBytes: number;
  readonly allowRehearsal?: boolean;
}): SingleMachineUpgradeResult {
  const releaseRoot = realpathSync(assertAbsoluteNormalized(input.releaseRoot, 'Release root'));
  const release = checkReleaseManifest(releaseRoot, input.allowRehearsal === true);
  if (release.checks.some((check) => check.status === 'failed')) {
    throw new TypeError('The target release bundle failed integrity checks.');
  }
  if (!/^[0-9a-f]{32}$/.test(input.expectedDatabaseId)) {
    throw new TypeError('Upgrade requires the exact opaque database ID.');
  }
  if (!Number.isSafeInteger(input.maximumBackupBytes) || input.maximumBackupBytes < 1) {
    throw new TypeError('Upgrade requires a positive bounded backup size.');
  }
  const environment = readSingleMachineEnvironmentFile(input.environmentFile);
  const config = loadConfig(environment);
  const dataDirectory = assertPrivateDirectory(config.dataDirectory!, 'Data directory', false);
  const backupDirectory = assertPrivateDirectory(environment.JOOEVENTS_BACKUP_DIRECTORY!, 'Backup directory', false);
  const databasePath = resolveDataChild(dataDirectory, config.databasePath!, 'Database path');
  const before = statusSQLite(databasePath);
  if (before.kind !== 'compatible' || before.migration.databaseClass !== 'frozen_release'
      || before.migration.databaseId !== input.expectedDatabaseId) {
    throw new TypeError('The stopped upgrade target does not match the expected frozen database.');
  }
  const backupPath = join(
    backupDirectory,
    `pre-upgrade-${input.expectedDatabaseId}-${Date.now()}.sqlite`
  );
  const backup = createRetainedSQLiteBackup({
    databasePath,
    backupPath,
    expectedDatabaseId: input.expectedDatabaseId,
    expectedDatabaseClass: 'frozen_release',
    maximumSerializeBytes: input.maximumBackupBytes
  });
  const opened = openSQLite(databasePath, { migrationPolicy: 'apply' });
  let migrationId: string;
  try {
    const terminal = SQLITE_MIGRATION_MANIFEST.releaseFloors.at(-1)!.terminalMigration;
    if (opened.migration.databaseClass !== 'frozen_release'
        || opened.migration.databaseId !== input.expectedDatabaseId
        || opened.migration.migrationId !== terminal.migrationId) {
      throw new TypeError('The upgraded database did not reach the target frozen release floor.');
    }
    migrationId = opened.migration.migrationId!;
  } finally {
    opened.sqlite.close();
  }
  return Object.freeze({
    status: before.migration.migrationId === migrationId ? 'already_current' : 'upgraded',
    databaseId: input.expectedDatabaseId,
    migrationId,
    sqliteReleaseFloor: release.manifest.sqliteReleaseFloor,
    backupPath,
    backupSha256: backup.sha256
  });
}
