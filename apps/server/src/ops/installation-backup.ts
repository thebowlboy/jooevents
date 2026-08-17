import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  createRetainedSQLiteBackup,
  createVerifiedRetainedSQLiteRestoreCandidate,
  statusSQLite,
  verifyRetainedSQLiteBackup,
  type RetainedSQLiteBackupDescriptor
} from '@jooevents/persistence';
import { loadConfig } from '../config';
import { loadCommunicationsProviderConfig, loadMailSenderConfig } from '../config/communications';
import { resolveBunListenerConfiguration } from '../runtime/request-handler';
import {
  readSingleMachineEnvironmentFile,
  renderSingleMachineService,
  verifySingleMachineRelease,
  type SingleMachineServiceKind
} from './single-machine';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const COPY_BUFFER_BYTES = 1024 * 1024;
const PLACEHOLDER = 'REPLACE_IN_FILE';
const LOCATION_KEYS = new Set([
  'JOOEVENTS_DATA_DIRECTORY',
  'JOOEVENTS_BACKUP_DIRECTORY',
  'JOOEVENTS_LOG_DIRECTORY'
]);
const EXPLICIT_SECRET_VALUE_KEYS = new Set([
  'JOOEVENTS_AUTH_SECRETS',
  'JOOEVENTS_REQUEST_HASH_KEYS',
  'JOOEVENTS_IDEMPOTENCY_KEYS',
  'JOOEVENTS_CLASSIFIED_PAYLOAD_KEYS',
  'JOOEVENTS_PERSISTENT_HMAC_KEYS',
  'JOOEVENTS_GOOGLE_CLIENT_SECRET',
  'JOOEVENTS_AIRTABLE_OAUTH_CLIENT_SECRET',
  'JOOEVENTS_AIRTABLE_SECRET_STORE_KEY',
  'JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN'
]);
const SAFE_OPAQUE_REFERENCE_KEYS = new Set([
  'JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_REFERENCE',
  'JOOEVENTS_CLOUDFLARE_EMAIL_API_TOKEN_SECRET_STORE'
]);

interface InstallationFileDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface InstallationBackupManifest {
  readonly formatVersion: 1;
  readonly kind: 'jooevents-single-machine-backup';
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly sqliteReleaseFloor: string;
  readonly database: RetainedSQLiteBackupDescriptor;
  readonly blobFiles: readonly InstallationFileDescriptor[];
  readonly blobDigestSha256: string;
  readonly configuration: {
    readonly values: Readonly<Record<string, string>>;
    readonly secretValueKeys: readonly string[];
  };
}

export interface InstallationBackupReceipt {
  readonly status: 'created' | 'verified';
  readonly backupSetPath: string;
  readonly databaseId: string;
  readonly sqliteReleaseFloor: string;
  readonly databaseSha256: string;
  readonly blobFiles: number;
  readonly blobBytes: number;
  readonly manifestSha256: string;
  readonly secretValueKeys: readonly string[];
}

export interface InstallationRestoreReceipt {
  readonly status: 'restored_for_rehearsal';
  readonly targetRoot: string;
  readonly databaseId: string;
  readonly sqliteReleaseFloor: string;
  readonly environmentFile: string;
  readonly serviceFile: string;
  readonly secretValueKeysRestoredOutOfBand: readonly string[];
  readonly nextAction: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertPositiveBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Installation backup requires a positive bounded byte ceiling.');
  }
}

function assertAbsoluteNormalized(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be an absolute normalized path.`);
  }
  return path;
}

function assertPrivateDirectory(path: string, label: string): string {
  assertAbsoluteNormalized(path, label);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must be a direct owner-only directory.`);
  }
  return path;
}

function assertDirectPrivateFile(path: string, label: string): void {
  assertAbsoluteNormalized(path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path
      || (stat.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must be a direct owner-only single-link file.`);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path: string, contents: string): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  fsyncDirectory(dirname(path));
}

function environmentText(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
      throw new TypeError('Restored environment data is not line-safe.');
    }
    return `${key}=${value}`;
  }).join('\n')}\n`;
}

function copyDirectFile(source: string, destination: string, maximumBytes: number): InstallationFileDescriptor {
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0
      || !Number.isSafeInteger(before.size)
      || before.size < 1 || before.size > maximumBytes) {
    throw new TypeError('Installation backup encountered an unsafe or oversized blob file.');
  }
  const input = openSync(source, constants.O_RDONLY | NOFOLLOW);
  const output = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, before.size));
  let copied = 0;
  try {
    const opened = fstatSync(input);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new TypeError('Installation backup blob identity changed before copy.');
    }
    while (copied < before.size) {
      const read = readSync(input, buffer, 0, Math.min(buffer.byteLength, before.size - copied), null);
      if (read === 0) throw new TypeError('Installation backup blob ended during copy.');
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) written += writeSync(output, buffer, written, read - written);
      copied += read;
    }
    if (readSync(input, buffer, 0, 1, null) !== 0) {
      throw new TypeError('Installation backup blob grew during copy.');
    }
    fsyncSync(output);
  } finally {
    closeSync(input);
    closeSync(output);
  }
  const after = lstatSync(source);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1) {
    throw new TypeError('Installation backup blob changed during copy.');
  }
  chmodSync(destination, 0o600);
  return Object.freeze({ path: '', bytes: copied, sha256: hash.digest('hex') });
}

function digestDirectFile(path: string, maximumBytes: number): InstallationFileDescriptor {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0
      || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maximumBytes) {
    throw new TypeError('Installation backup encountered an unsafe or oversized file.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, before.size));
  let bytes = 0;
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new TypeError('Installation backup file identity changed before verification.');
    }
    while (bytes < before.size) {
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, before.size - bytes), null);
      if (read === 0) throw new TypeError('Installation backup file ended during verification.');
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    if (readSync(descriptor, buffer, 0, 1, null) !== 0) {
      throw new TypeError('Installation backup file grew during verification.');
    }
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1) {
    throw new TypeError('Installation backup file changed during verification.');
  }
  return Object.freeze({ path: '', bytes, sha256: hash.digest('hex') });
}

function walkBlobFiles(root: string): readonly string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new TypeError('Blob backup encountered an unsafe directory.');
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const fromRoot = relative(root, path).split(sep).join('/');
      if (!fromRoot || fromRoot.startsWith('../') || fromRoot.includes('/../') || entry.name.includes('.partial-')) {
        throw new TypeError('Blob backup encountered an unsafe or incomplete path.');
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push(fromRoot);
      else throw new TypeError('Blob backup refuses links and special files.');
    }
  };
  visit(root);
  return Object.freeze(paths.sort());
}

function copyBlobSet(sourceRoot: string, destinationRoot: string, maximumBytes: number): readonly InstallationFileDescriptor[] {
  mkdirSync(destinationRoot, { mode: 0o700 });
  const descriptors: InstallationFileDescriptor[] = [];
  let total = 0;
  for (const path of walkBlobFiles(sourceRoot)) {
    const destination = join(destinationRoot, ...path.split('/'));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const copied = copyDirectFile(join(sourceRoot, ...path.split('/')), destination, maximumBytes - total);
    total += copied.bytes;
    descriptors.push(Object.freeze({ ...copied, path }));
  }
  fsyncDirectory(destinationRoot);
  return Object.freeze(descriptors);
}

function classifyConfiguration(environment: Readonly<Record<string, string>>): InstallationBackupManifest['configuration'] {
  const values: Record<string, string> = {};
  const secretValueKeys: string[] = [];
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (LOCATION_KEYS.has(key)) continue;
    if (key !== 'NODE_ENV' && !key.startsWith('JOOEVENTS_')) {
      throw new TypeError(`Environment key ${key} is outside the single-machine configuration namespace.`);
    }
    const suspicious = /(SECRET|TOKEN|KEYS?|PASSWORD|CREDENTIAL|DATABASE_URL)/.test(key);
    if (EXPLICIT_SECRET_VALUE_KEYS.has(key) || (suspicious && !SAFE_OPAQUE_REFERENCE_KEYS.has(key))) {
      if (value.length > 0) secretValueKeys.push(key);
      continue;
    }
    values[key] = value;
  }
  return Object.freeze({ values: Object.freeze(values), secretValueKeys: Object.freeze(secretValueKeys) });
}

function parseManifest(path: string): InstallationBackupManifest {
  assertDirectPrivateFile(path, 'Installation backup manifest');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstallationBackupManifest>;
  const files = value.blobFiles as readonly InstallationFileDescriptor[] | undefined;
  const configuration = value.configuration;
  const filesValid = Array.isArray(files) && files.every((file, index) =>
    typeof file === 'object' && file !== null && typeof file.path === 'string'
      && file.path.length > 0 && !file.path.startsWith('/') && !file.path.includes('\\')
      && file.path.split('/').every((segment: string) => segment.length > 0 && segment !== '.' && segment !== '..')
      && Number.isSafeInteger(file.bytes) && file.bytes > 0
      && typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256)
      && (index === 0 || files[index - 1]!.path < file.path));
  const values = configuration?.values;
  const secretKeys = configuration?.secretValueKeys;
  const configurationValid = typeof values === 'object' && values !== null && !Array.isArray(values)
    && Object.entries(values).every(([key, setting]) =>
      typeof setting === 'string' && (key === 'NODE_ENV' || key.startsWith('JOOEVENTS_'))
      && !LOCATION_KEYS.has(key) && !EXPLICIT_SECRET_VALUE_KEYS.has(key))
    && Array.isArray(secretKeys) && secretKeys.every((key, index) =>
      typeof key === 'string' && EXPLICIT_SECRET_VALUE_KEYS.has(key)
      && (index === 0 || secretKeys[index - 1]! < key));
  if (value.formatVersion !== 1 || value.kind !== 'jooevents-single-machine-backup'
      || typeof value.releaseId !== 'string' || typeof value.sourceRevision !== 'string'
      || !/^[0-9a-f]{40}$/.test(value.sourceRevision)
      || typeof value.sqliteReleaseFloor !== 'string' || !filesValid || !configurationValid
      || typeof value.blobDigestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.blobDigestSha256)
      || sha256(JSON.stringify(files)) !== value.blobDigestSha256
      || typeof value.database !== 'object' || value.database === null) {
    throw new TypeError('Installation backup manifest is malformed.');
  }
  return value as InstallationBackupManifest;
}

function receiptFrom(path: string, manifest: InstallationBackupManifest, status: InstallationBackupReceipt['status']): InstallationBackupReceipt {
  if (!manifest.database.databaseId) throw new TypeError('Installation backup requires a managed database identity.');
  const manifestBytes = readFileSync(join(path, 'backup-manifest.json'));
  return Object.freeze({
    status,
    backupSetPath: path,
    databaseId: manifest.database.databaseId,
    sqliteReleaseFloor: manifest.sqliteReleaseFloor,
    databaseSha256: manifest.database.sha256,
    blobFiles: manifest.blobFiles.length,
    blobBytes: manifest.blobFiles.reduce((sum, file) => sum + file.bytes, 0),
    manifestSha256: sha256(manifestBytes),
    secretValueKeys: manifest.configuration.secretValueKeys
  });
}

export function verifySingleMachineInstallationBackup(input: {
  readonly backupSetPath: string;
  readonly maximumBytes: number;
}): InstallationBackupReceipt {
  assertPositiveBound(input.maximumBytes);
  const root = assertPrivateDirectory(input.backupSetPath, 'Installation backup set');
  const manifest = parseManifest(join(root, 'backup-manifest.json'));
  verifyRetainedSQLiteBackup({
    backupPath: join(root, 'database.sqlite'),
    ...(manifest.database.databaseId ? { expectedDatabaseId: manifest.database.databaseId } : {}),
    expectedDatabaseClass: manifest.database.databaseClass,
    expectedDescriptor: manifest.database,
    maximumBytes: input.maximumBytes
  });
  const actualPaths = walkBlobFiles(join(root, 'blobs'));
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifest.blobFiles.map((file) => file.path))) {
    throw new TypeError('Installation backup blob inventory does not match its manifest.');
  }
  let total = manifest.database.bytes;
  for (const expected of manifest.blobFiles) {
    const path = join(root, 'blobs', ...expected.path.split('/'));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || stat.size !== expected.bytes) {
      throw new TypeError('Installation backup blob shape does not match its manifest.');
    }
    total += stat.size;
    const actual = digestDirectFile(path, input.maximumBytes - (total - stat.size));
    if (total > input.maximumBytes || actual.sha256 !== expected.sha256) {
      throw new TypeError('Installation backup blob bytes do not match their manifest or ceiling.');
    }
  }
  const rootEntries = readdirSync(root).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(['backup-manifest.json', 'blobs', 'database.sqlite'])) {
    throw new TypeError('Installation backup contains an undeclared top-level artifact.');
  }
  return receiptFrom(root, manifest, 'verified');
}

export function backupSingleMachineInstallation(input: {
  readonly releaseRoot: string;
  readonly environmentFile: string;
  readonly backupSetPath: string;
  readonly expectedDatabaseId: string;
  readonly maximumBytes: number;
  readonly allowRehearsal?: boolean;
}): InstallationBackupReceipt {
  assertPositiveBound(input.maximumBytes);
  const release = verifySingleMachineRelease(input.releaseRoot, input.allowRehearsal === true);
  const environment = readSingleMachineEnvironmentFile(input.environmentFile);
  const config = loadConfig(environment);
  if (config.databaseDriver !== 'sqlite' || config.blobDriver !== 'filesystem' || !config.dataDirectory || !config.databasePath) {
    throw new TypeError('Installation backup supports only the single-machine SQLite/filesystem composition.');
  }
  const dataDirectory = assertPrivateDirectory(config.dataDirectory, 'Data directory');
  const backupDirectory = assertPrivateDirectory(environment.JOOEVENTS_BACKUP_DIRECTORY!, 'Backup directory');
  const blobRoot = assertPrivateDirectory(join(dataDirectory, 'blobs'), 'Blob directory');
  const output = assertAbsoluteNormalized(input.backupSetPath, 'Installation backup destination');
  if (dirname(output) !== backupDirectory || existsSync(output)) {
    throw new TypeError('Installation backup destination must be an unused direct child of the configured backup directory.');
  }
  const databasePath = resolve(dataDirectory, config.databasePath);
  if (relative(dataDirectory, databasePath).startsWith('..')) throw new TypeError('Database path escapes the data directory.');
  const status = statusSQLite(databasePath);
  if (status.kind !== 'compatible' || status.migration.databaseClass !== 'frozen_release'
      || status.migration.databaseId !== input.expectedDatabaseId) {
    throw new TypeError('Installation backup source does not match the expected stopped frozen database.');
  }
  const staging = join(backupDirectory, `.partial-installation-backup-${randomBytes(16).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const database = createRetainedSQLiteBackup({
      databasePath,
      backupPath: join(staging, 'database.sqlite'),
      expectedDatabaseId: input.expectedDatabaseId,
      expectedDatabaseClass: 'frozen_release',
      maximumSerializeBytes: input.maximumBytes
    });
    const blobFiles = copyBlobSet(blobRoot, join(staging, 'blobs'), input.maximumBytes - database.bytes);
    const manifest: InstallationBackupManifest = Object.freeze({
      formatVersion: 1,
      kind: 'jooevents-single-machine-backup',
      releaseId: release.releaseId,
      sourceRevision: release.sourceRevision,
      sqliteReleaseFloor: release.sqliteReleaseFloor,
      database,
      blobFiles,
      blobDigestSha256: sha256(JSON.stringify(blobFiles)),
      configuration: classifyConfiguration(environment)
    });
    writeExclusive(join(staging, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fsyncDirectory(staging);
    renameSync(staging, output);
    fsyncDirectory(backupDirectory);
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
    throw error;
  }
  const verified = verifySingleMachineInstallationBackup({ backupSetPath: output, maximumBytes: input.maximumBytes });
  return Object.freeze({ ...verified, status: 'created' });
}

export function restoreSingleMachineInstallationForRehearsal(input: {
  readonly releaseRoot: string;
  readonly backupSetPath: string;
  readonly targetRoot: string;
  readonly secretEnvironmentFile: string;
  readonly baseUrl: string;
  readonly port: number;
  readonly bunExecutable: string;
  readonly serviceKind: SingleMachineServiceKind;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly maximumBytes: number;
  readonly allowRehearsal?: boolean;
}): InstallationRestoreReceipt {
  const release = verifySingleMachineRelease(input.releaseRoot, input.allowRehearsal === true);
  const backup = verifySingleMachineInstallationBackup({
    backupSetPath: input.backupSetPath,
    maximumBytes: input.maximumBytes
  });
  const manifest = parseManifest(join(input.backupSetPath, 'backup-manifest.json'));
  if (manifest.sqliteReleaseFloor !== release.sqliteReleaseFloor) {
    throw new TypeError('Restore target release does not support the backup SQLite floor.');
  }
  const target = assertAbsoluteNormalized(input.targetRoot, 'Restore target root');
  const parent = assertPrivateDirectory(dirname(target), 'Restore target parent');
  if (existsSync(target)) throw new TypeError('Restore rehearsal never replaces an existing target root.');
  const sourceSecrets = readSingleMachineEnvironmentFile(input.secretEnvironmentFile);
  const secretValues: Record<string, string> = {};
  for (const key of manifest.configuration.secretValueKeys) {
    const value = sourceSecrets[key];
    if (!value || value === PLACEHOLDER) throw new TypeError(`Restore requires secret value ${key} from the out-of-band environment file.`);
    secretValues[key] = value;
  }
  const baseUrl = new URL(input.baseUrl);
  if (baseUrl.origin !== input.baseUrl || !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new TypeError('Restore requires one canonical base origin and valid port.');
  }
  const staging = join(parent, `.partial-installation-restore-${randomBytes(16).toString('hex')}`);
  const finalData = join(target, 'data');
  const finalBackup = join(target, 'backups');
  const finalLogs = join(target, 'logs');
  const finalEnvironment = join(target, 'config', 'jooevents.env');
  const finalService = join(target, 'service', input.serviceKind === 'systemd' ? 'jooevents.service' : 'com.joocorp.jooevents.plist');
  const environment = Object.freeze({
    ...manifest.configuration.values,
    ...secretValues,
    NODE_ENV: 'production',
    JOOEVENTS_BASE_URL: input.baseUrl,
    JOOEVENTS_INTERNAL_HTTP_PORT: String(input.port),
    JOOEVENTS_GOOGLE_CALLBACK_VERIFIED: manifest.configuration.values.JOOEVENTS_BASE_URL === input.baseUrl
      ? manifest.configuration.values.JOOEVENTS_GOOGLE_CALLBACK_VERIFIED ?? 'false'
      : 'false',
    JOOEVENTS_DATA_DIRECTORY: finalData,
    JOOEVENTS_BACKUP_DIRECTORY: finalBackup,
    JOOEVENTS_LOG_DIRECTORY: finalLogs
  });
  loadConfig(environment);
  resolveBunListenerConfiguration(environment);
  loadCommunicationsProviderConfig(environment);
  loadMailSenderConfig(environment);
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const directory of ['data', 'data/blobs', 'backups', 'logs', 'config', 'service']) {
      mkdirSync(join(staging, ...directory.split('/')), { recursive: true, mode: 0o700 });
    }
    createVerifiedRetainedSQLiteRestoreCandidate({
      backupPath: join(input.backupSetPath, 'database.sqlite'),
      restoreCandidatePath: join(staging, 'data', 'jooevents.sqlite'),
      expectedDescriptor: manifest.database,
      maximumBytes: input.maximumBytes
    });
    for (const file of manifest.blobFiles) {
      const destination = join(staging, 'data', 'blobs', ...file.path.split('/'));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const copied = copyDirectFile(join(input.backupSetPath, 'blobs', ...file.path.split('/')), destination, file.bytes);
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) {
        throw new TypeError('Restored blob does not match the verified backup manifest.');
      }
    }
    writeExclusive(join(staging, 'config', 'jooevents.env'), environmentText(environment));
    const service = renderSingleMachineService({
      kind: input.serviceKind,
      releaseRoot: input.releaseRoot,
      environmentFile: finalEnvironment,
      dataDirectory: finalData,
      backupDirectory: finalBackup,
      logDirectory: finalLogs,
      bunExecutable: input.bunExecutable,
      ...(input.serviceUser ? { serviceUser: input.serviceUser } : {}),
      ...(input.serviceGroup ? { serviceGroup: input.serviceGroup } : {})
    });
    writeExclusive(join(staging, 'service', input.serviceKind === 'systemd' ? 'jooevents.service' : 'com.joocorp.jooevents.plist'), service);
    writeExclusive(join(staging, 'restore-receipt.json'), `${JSON.stringify({
      formatVersion: 1,
      kind: 'jooevents-restore-rehearsal',
      databaseId: backup.databaseId,
      sqliteReleaseFloor: backup.sqliteReleaseFloor,
      manifestSha256: backup.manifestSha256,
      secretValueKeysRestoredOutOfBand: manifest.configuration.secretValueKeys
    }, null, 2)}\n`);
    fsyncDirectory(staging);
    renameSync(staging, target);
    fsyncDirectory(parent);
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
    throw error;
  }
  const restoredStatus = statusSQLite(join(finalData, 'jooevents.sqlite'));
  if (restoredStatus.kind !== 'compatible' || restoredStatus.migration.databaseId !== backup.databaseId
      || restoredStatus.migration.databaseClass !== 'frozen_release') {
    throw new TypeError('Restored installation did not retain its frozen database identity.');
  }
  return Object.freeze({
    status: 'restored_for_rehearsal',
    targetRoot: target,
    databaseId: backup.databaseId,
    sqliteReleaseFloor: backup.sqliteReleaseFloor,
    environmentFile: finalEnvironment,
    serviceFile: finalService,
    secretValueKeysRestoredOutOfBand: manifest.configuration.secretValueKeys,
    nextAction: 'Start the restored copy on its isolated origin, then run the operator verify command.'
  });
}
