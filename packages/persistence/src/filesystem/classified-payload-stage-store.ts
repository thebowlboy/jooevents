import {
  ClassifiedPayloadStageError,
  createAuthenticatedPayloadStageDescriptor,
  createClassifiedPayloadDescriptor,
  createClassifiedPayloadProfileRef,
  createPayloadStageFence,
  createStageReconciliationCursor,
  createStageReconciliationPolicyRef,
  type AuthenticatedPayloadStageDescriptor,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfileKind,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type ClassifiedPayloadStageStore,
  type PayloadStageAdoptionResult,
  type PayloadStageInspection,
  type PayloadStageMarkResult,
  type PayloadStagePurgeResult,
  type PayloadStageReconciliationCandidate,
  type PayloadStageReconciliationPage,
  type StageReconciliationCursor,
  type StageReconciliationPolicyRef,
  type UnadoptedStageProof,
  type UnadoptedStageProofVerifier
} from '@jooevents/application';
import {
  canonicalJsonText,
  createPayloadRef,
  parseAggregateVersion,
  parseInstant,
  parsePayloadRefId,
  parsePayloadStageId,
  type PayloadRef,
  type PayloadStageId
} from '@jooevents/kernel';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  currentClassifiedStageProcessStartToken,
  observeClassifiedStageProcessIdentity
} from './classified-stage-process-identity';

type MaybePromise<Value> = Value | Promise<Value>;

/** Supplies retained profile state and fresh, caller-owned authentication-key bytes. */
export interface RetainedClassifiedPayloadProfileResolver {
  isRetainedProfile(profile: ClassifiedPayloadProfileRef): MaybePromise<boolean>;
  isRetainedReconciliationPolicy(policy: StageReconciliationPolicyRef): MaybePromise<boolean>;
  resolveDescriptorAuthenticationKey(
    profile: ClassifiedPayloadProfileRef<'descriptor_auth'>
  ): MaybePromise<Uint8Array | undefined>;
}

export interface LocalFilesystemClassifiedPayloadStageStoreOptions {
  /** Existing absolute private directory owned by the current process user. */
  readonly root: string;
  readonly profileResolver: RetainedClassifiedPayloadProfileResolver;
  /** Must be the verifier paired with the application cleanup authority. */
  readonly purgeProofVerifier: UnadoptedStageProofVerifier;
  readonly newStageId?: () => string;
}

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

interface StoredStageRecord {
  readonly formatVersion: 1;
  readonly stageId: PayloadStageId;
  readonly version: number;
  readonly fence: number;
  readonly expiresAt: string;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
  readonly classified: ClassifiedPayloadDescriptor;
  readonly state: 'staged' | 'adoption_pending' | 'adopted';
  readonly payloadRef?: PayloadRef;
}

interface StoredStageEnvelope {
  readonly record: StoredStageRecord;
  readonly metadataAuthenticationTag: string;
}

type StageLockOperation = 'adopt' | 'mark' | 'purge';

interface StoredStageLockBinding {
  readonly version: number;
  readonly fence: number;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
  readonly state: StoredStageRecord['state'];
  readonly payloadRefId?: string;
}

interface StoredStageLockOwner {
  readonly formatVersion: 2;
  readonly nonce: string;
  readonly stageId: PayloadStageId;
  readonly stageDirectoryIdentity: FileIdentity;
  readonly lockFileIdentity: FileIdentity;
  readonly authenticationProfile: ClassifiedPayloadProfileRef<'descriptor_auth'>;
  readonly operation: StageLockOperation;
  readonly previousLockNonce?: string;
  readonly requestedPayloadRefId?: string;
  readonly starting: StoredStageLockBinding;
  readonly pid: number;
  readonly processStartToken: string | null;
  readonly createdAt: number;
}

interface StoredStageLockEnvelope {
  readonly owner: StoredStageLockOwner;
  readonly ownerAuthenticationTag: string;
}

interface StoredStagePurgeMarker {
  readonly formatVersion: 1;
  readonly stageId: PayloadStageId;
  readonly stageDirectoryIdentity: FileIdentity;
  readonly quarantineNonce: string;
  readonly lockNonce: string;
  readonly authenticationProfile: ClassifiedPayloadProfileRef<'descriptor_auth'>;
  readonly starting: StoredStageLockBinding;
  readonly metadataAuthenticationTag: string;
}

interface StoredStagePurgeMarkerEnvelope {
  readonly marker: StoredStagePurgeMarker;
  readonly markerAuthenticationTag: string;
}

interface StageLockPurpose {
  readonly operation: StageLockOperation;
  readonly requestedPayloadRefId?: string;
}

interface HeldStageLock {
  readonly nonce: string;
  readonly identity: FileIdentity;
  readonly path: string;
  release(stageDirectory?: string): Promise<void>;
}

interface StageLockChainTip {
  readonly active?: {
    readonly path: string;
    readonly envelope: StoredStageLockEnvelope;
    readonly identity: FileIdentity;
  };
  readonly publicationPath: string;
  readonly previousLockNonce?: string;
}

const storeDirectoryName = '.jooevents-classified-payload-stages-v1';
const metadataFileName = 'metadata.json';
const payloadFileName = 'payload.bin';
const purgeMarkerFileName = 'purge.json';
const lockDirectoryName = '.lock';
const maximumMetadataBytes = 64 * 1024;
const maximumPageSize = 50;
const lockWaitMilliseconds = 2_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const uuidNamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const temporaryPutPattern = /^\.put-[0-9a-f]{32}$/;
const temporaryMetadataPattern = /^\.metadata-[0-9a-f]{32}\.tmp$/;
const temporaryPurgeMarkerPattern = /^\.purge-[0-9a-f]{32}\.tmp$/;
const pendingLockDirectoryPattern = /^\.lock-pending-([0-9a-f]{32})$/;
const reclaimedLockDirectoryPattern = /^\.lock-reclaimed-([0-9a-f]{32})$/;
const nextLockFilePattern = /^\.lock-next-([0-9a-f]{32})$/;
const purgedDirectoryPattern = /^\.purged-([0-9a-f-]{36})-([0-9a-f]{32})$/;
const purgeCleaningDirectoryPattern = /^\.purge-cleaning-([0-9a-f-]{36})-([0-9a-f]{32})$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const noncePattern = /^[0-9a-f]{32}$/;

function stageError(code: ConstructorParameters<typeof ClassifiedPayloadStageError>[0]): ClassifiedPayloadStageError {
  return new ClassifiedPayloadStageError(code);
}

function guardedError(error: unknown, fallback: ConstructorParameters<typeof ClassifiedPayloadStageError>[0]): ClassifiedPayloadStageError {
  return error instanceof ClassifiedPayloadStageError ? error : stageError(fallback);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function identityOf(stat: Stats): FileIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertPrivateOwnership(stat: Stats): void {
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw stageError('invalid_descriptor_auth');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw stageError('invalid_descriptor_auth');
    }
  }
}

function assertPrivateDirectory(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw stageError('invalid_descriptor_auth');
  assertPrivateOwnership(stat);
  if (realpathSync(path) !== path) throw stageError('invalid_descriptor_auth');
  return identityOf(stat);
}

function assertPrivateRegularFile(path: string, maximumBytes?: number): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw stageError('invalid_descriptor_auth');
  }
  assertPrivateOwnership(stat);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || (maximumBytes !== undefined && stat.size > maximumBytes)) {
    throw stageError('invalid_descriptor_auth');
  }
  return identityOf(stat);
}

function assertPrivateLockFile(path: string, maximumBytes?: number): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > 2) {
    throw stageError('invalid_descriptor_auth');
  }
  assertPrivateOwnership(stat);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || (maximumBytes !== undefined && stat.size > maximumBytes)) {
    throw stageError('invalid_descriptor_auth');
  }
  return identityOf(stat);
}

function openVerifiedRead(path: string, maximumBytes?: number): { readonly descriptor: number; readonly identity: FileIdentity } {
  const expected = assertPrivateRegularFile(path, maximumBytes);
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || !sameIdentity(expected, identityOf(stat))) {
      throw stageError('invalid_descriptor_auth');
    }
    assertPrivateOwnership(stat);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || (maximumBytes !== undefined && stat.size > maximumBytes)) {
      throw stageError('invalid_descriptor_auth');
    }
    return { descriptor, identity: expected };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readPrivateText(path: string, maximumBytes: number): string {
  const opened = openVerifiedRead(path, maximumBytes);
  try {
    return readFileSync(opened.descriptor, 'utf8');
  } finally {
    closeSync(opened.descriptor);
  }
}

function readPrivateLockText(path: string, maximumBytes: number): string {
  const expected = assertPrivateLockFile(path, maximumBytes);
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()
      || stat.nlink < 1
      || stat.nlink > 2
      || !sameIdentity(expected, identityOf(stat))) {
      throw stageError('invalid_descriptor_auth');
    }
    assertPrivateOwnership(stat);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes) {
      throw stageError('invalid_descriptor_auth');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusivePrivateFile(path: string, contents: string | Uint8Array): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  assertPrivateRegularFile(path);
}

function safeFsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

function safeUnlinkPrivateFile(path: string): void {
  if (!existsSync(path)) return;
  assertPrivateRegularFile(path);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function unlinkExactPrivateLockFile(path: string, expectedIdentity: FileIdentity): void {
  if (!existsSync(path)) return;
  const current = assertPrivateLockFile(path, 8_192);
  if (!sameIdentity(current, expectedIdentity)) throw stageError('invalid_descriptor_auth');
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function profileKey(profile: ClassifiedPayloadProfileRef): string {
  return `${profile.kind}:${profile.key}@${profile.version}`;
}

function policyKey(policy: StageReconciliationPolicyRef): string {
  return `${policy.key}@${policy.version}`;
}

function profilesOf(profiles: ClassifiedPayloadProfiles): readonly ClassifiedPayloadProfileRef[] {
  return [profiles.classification, profiles.schema, profiles.content, profiles.integrity, profiles.descriptorAuth];
}

function parseProfile<Kind extends ClassifiedPayloadProfileKind>(value: unknown, kind: Kind): ClassifiedPayloadProfileRef<Kind> {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['key', 'kind', 'version'])
    || value.kind !== kind
    || typeof value.key !== 'string'
    || typeof value.version !== 'number') throw stageError('invalid_descriptor_auth');
  try {
    return createClassifiedPayloadProfileRef(kind, value.key, value.version);
  } catch {
    throw stageError('invalid_descriptor_auth');
  }
}

function parseProfiles(value: unknown): ClassifiedPayloadProfiles {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['classification', 'content', 'descriptorAuth', 'integrity', 'schema'])) {
    throw stageError('invalid_descriptor_auth');
  }
  return Object.freeze({
    classification: parseProfile(value.classification, 'classification'),
    schema: parseProfile(value.schema, 'schema'),
    content: parseProfile(value.content, 'content'),
    integrity: parseProfile(value.integrity, 'integrity'),
    descriptorAuth: parseProfile(value.descriptorAuth, 'descriptor_auth')
  });
}

function parsePolicy(value: unknown): StageReconciliationPolicyRef {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['key', 'version'])
    || typeof value.key !== 'string'
    || typeof value.version !== 'number') throw stageError('invalid_descriptor_auth');
  try {
    return createStageReconciliationPolicyRef(value.key, value.version);
  } catch {
    throw stageError('invalid_descriptor_auth');
  }
}

function normalizeDescriptor(value: unknown): ClassifiedPayloadDescriptor {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['byteSize', 'contentType', 'integrityDigest', 'profiles', 'scopeBinding'])
    || typeof value.scopeBinding !== 'string'
    || typeof value.contentType !== 'string'
    || typeof value.byteSize !== 'number'
    || typeof value.integrityDigest !== 'string') throw stageError('descriptor_mismatch');
  try {
    return createClassifiedPayloadDescriptor({
      profiles: parseProfiles(value.profiles),
      scopeBinding: value.scopeBinding,
      contentType: value.contentType,
      byteSize: value.byteSize,
      integrityDigest: value.integrityDigest
    });
  } catch (error) {
    if (error instanceof ClassifiedPayloadStageError) throw error;
    throw stageError('descriptor_mismatch');
  }
}

function normalizeStageId(value: unknown): PayloadStageId {
  if (typeof value !== 'string' || !uuidNamePattern.test(value)) throw stageError('stage_not_found');
  try {
    return parsePayloadStageId(value);
  } catch {
    throw stageError('stage_not_found');
  }
}

function normalizeRecord(value: unknown): StoredStageRecord {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'classified', 'expiresAt', 'fence', 'formatVersion', 'reconciliationPolicy',
      'stageId', 'state', 'version'
    ], ['payloadRefId'])
    || value.formatVersion !== 1
    || typeof value.version !== 'number'
    || typeof value.fence !== 'number'
    || typeof value.expiresAt !== 'string'
    || (value.state !== 'staged' && value.state !== 'adoption_pending' && value.state !== 'adopted')) {
    throw stageError('invalid_descriptor_auth');
  }
  if ((value.state === 'staged') !== (value.payloadRefId === undefined)) {
    throw stageError('invalid_descriptor_auth');
  }
  try {
    const stageId = normalizeStageId(value.stageId);
    const version = Number(parseAggregateVersion(value.version));
    const fence = Number(createPayloadStageFence(value.fence));
    const expiresAt = parseInstant(value.expiresAt);
    const reconciliationPolicy = parsePolicy(value.reconciliationPolicy);
    const classified = normalizeDescriptor(value.classified);
    const payloadRef = value.payloadRefId === undefined
      ? undefined
      : createPayloadRef(parsePayloadRefId(value.payloadRefId));
    return Object.freeze({
      formatVersion: 1,
      stageId,
      version,
      fence,
      expiresAt,
      reconciliationPolicy,
      classified,
      state: value.state,
      ...(payloadRef ? { payloadRef } : {})
    });
  } catch (error) {
    if (error instanceof ClassifiedPayloadStageError) throw error;
    throw stageError('invalid_descriptor_auth');
  }
}

function diskRecord(record: StoredStageRecord) {
  return {
    classified: record.classified,
    expiresAt: record.expiresAt,
    fence: record.fence,
    formatVersion: record.formatVersion,
    ...(record.payloadRef ? { payloadRefId: record.payloadRef.id } : {}),
    reconciliationPolicy: record.reconciliationPolicy,
    stageId: record.stageId,
    state: record.state,
    version: record.version
  };
}

function stageLockBinding(record: StoredStageRecord): StoredStageLockBinding {
  return Object.freeze({
    version: record.version,
    fence: record.fence,
    reconciliationPolicy: record.reconciliationPolicy,
    state: record.state,
    ...(record.payloadRef ? { payloadRefId: record.payloadRef.id } : {})
  });
}

function diskStageLockOwner(owner: StoredStageLockOwner) {
  return {
    authenticationProfile: owner.authenticationProfile,
    createdAt: owner.createdAt,
    formatVersion: owner.formatVersion,
    lockFileIdentity: owner.lockFileIdentity,
    nonce: owner.nonce,
    operation: owner.operation,
    ...(owner.previousLockNonce ? { previousLockNonce: owner.previousLockNonce } : {}),
    pid: owner.pid,
    processStartToken: owner.processStartToken,
    ...(owner.requestedPayloadRefId ? { requestedPayloadRefId: owner.requestedPayloadRefId } : {}),
    stageDirectoryIdentity: owner.stageDirectoryIdentity,
    stageId: owner.stageId,
    starting: {
      fence: owner.starting.fence,
      ...(owner.starting.payloadRefId ? { payloadRefId: owner.starting.payloadRefId } : {}),
      reconciliationPolicy: owner.starting.reconciliationPolicy,
      state: owner.starting.state,
      version: owner.starting.version
    }
  };
}

function stageLockOwnerFrame(owner: StoredStageLockOwner): string {
  return canonicalJsonText([
    'jooevents.local-classified-stage-lock-owner',
    2,
    diskStageLockOwner(owner)
  ]);
}

function parseFileIdentity(value: unknown): FileIdentity {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['device', 'inode'])
    || typeof value.device !== 'string'
    || !/^\d+$/.test(value.device)
    || typeof value.inode !== 'string'
    || !/^\d+$/.test(value.inode)) throw stageError('invalid_descriptor_auth');
  return Object.freeze({ device: value.device, inode: value.inode });
}

function parseStageLockBinding(value: unknown): StoredStageLockBinding {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['fence', 'reconciliationPolicy', 'state', 'version'], ['payloadRefId'])
    || typeof value.version !== 'number'
    || typeof value.fence !== 'number'
    || (value.state !== 'staged' && value.state !== 'adoption_pending' && value.state !== 'adopted')
    || (value.payloadRefId !== undefined && typeof value.payloadRefId !== 'string')
    || (value.state === 'staged') !== (value.payloadRefId === undefined)) {
    throw stageError('invalid_descriptor_auth');
  }
  try {
    const version = Number(parseAggregateVersion(value.version));
    const fence = Number(createPayloadStageFence(value.fence));
    const reconciliationPolicy = parsePolicy(value.reconciliationPolicy);
    const payloadRefId = value.payloadRefId === undefined
      ? undefined
      : parsePayloadRefId(value.payloadRefId);
    return Object.freeze({
      version,
      fence,
      reconciliationPolicy,
      state: value.state,
      ...(payloadRefId ? { payloadRefId } : {})
    });
  } catch (error) {
    if (error instanceof ClassifiedPayloadStageError) throw error;
    throw stageError('invalid_descriptor_auth');
  }
}

function parseStageLockOwner(text: string): StoredStageLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw stageError('invalid_descriptor_auth');
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'authenticationProfile', 'createdAt', 'formatVersion', 'nonce', 'operation', 'pid', 'processStartToken',
      'lockFileIdentity', 'stageDirectoryIdentity', 'stageId', 'starting'
    ], ['previousLockNonce', 'requestedPayloadRefId'])
    || value.formatVersion !== 2
    || typeof value.nonce !== 'string'
    || !noncePattern.test(value.nonce)
    || (value.operation !== 'adopt' && value.operation !== 'mark' && value.operation !== 'purge')
    || !Number.isInteger(value.pid)
    || Number(value.pid) <= 0
    || (value.processStartToken !== null
      && (typeof value.processStartToken !== 'string' || !sha256Pattern.test(value.processStartToken)))
    || !Number.isSafeInteger(value.createdAt)
    || Number(value.createdAt) < 0
    || (value.requestedPayloadRefId !== undefined && typeof value.requestedPayloadRefId !== 'string')) {
    throw stageError('invalid_descriptor_auth');
  }
  try {
    const operation = value.operation;
    if (value.previousLockNonce !== undefined
      && (typeof value.previousLockNonce !== 'string' || !noncePattern.test(value.previousLockNonce))) {
      throw stageError('invalid_descriptor_auth');
    }
    const requestedPayloadRefId = value.requestedPayloadRefId === undefined
      ? undefined
      : parsePayloadRefId(value.requestedPayloadRefId);
    if ((operation === 'purge') !== (requestedPayloadRefId === undefined)) {
      throw stageError('invalid_descriptor_auth');
    }
    return Object.freeze({
      formatVersion: 2,
      nonce: value.nonce,
      stageId: normalizeStageId(value.stageId),
      stageDirectoryIdentity: parseFileIdentity(value.stageDirectoryIdentity),
      lockFileIdentity: parseFileIdentity(value.lockFileIdentity),
      authenticationProfile: parseProfile(value.authenticationProfile, 'descriptor_auth'),
      operation,
      ...(value.previousLockNonce ? { previousLockNonce: value.previousLockNonce } : {}),
      ...(requestedPayloadRefId ? { requestedPayloadRefId } : {}),
      starting: parseStageLockBinding(value.starting),
      pid: Number(value.pid),
      processStartToken: value.processStartToken,
      createdAt: Number(value.createdAt)
    });
  } catch (error) {
    if (error instanceof ClassifiedPayloadStageError) throw error;
    throw stageError('invalid_descriptor_auth');
  }
}

function parseStageLockEnvelope(text: string): StoredStageLockEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw stageError('invalid_descriptor_auth');
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['owner', 'ownerAuthenticationTag'])
    || typeof value.ownerAuthenticationTag !== 'string'
    || !sha256Pattern.test(value.ownerAuthenticationTag)) {
    throw stageError('invalid_descriptor_auth');
  }
  return Object.freeze({
    owner: parseStageLockOwner(canonicalJsonText(value.owner)),
    ownerAuthenticationTag: value.ownerAuthenticationTag
  });
}

function exactStageLockEnvelope(left: StoredStageLockEnvelope, right: StoredStageLockEnvelope): boolean {
  return exactStageLockOwner(left.owner, right.owner)
    && constantTimeHexEqual(left.ownerAuthenticationTag, right.ownerAuthenticationTag);
}

function diskStagePurgeMarker(marker: StoredStagePurgeMarker) {
  return {
    authenticationProfile: marker.authenticationProfile,
    formatVersion: marker.formatVersion,
    lockNonce: marker.lockNonce,
    metadataAuthenticationTag: marker.metadataAuthenticationTag,
    quarantineNonce: marker.quarantineNonce,
    stageDirectoryIdentity: marker.stageDirectoryIdentity,
    stageId: marker.stageId,
    starting: {
      fence: marker.starting.fence,
      reconciliationPolicy: marker.starting.reconciliationPolicy,
      state: marker.starting.state,
      version: marker.starting.version
    }
  };
}

function stagePurgeMarkerFrame(marker: StoredStagePurgeMarker): string {
  return canonicalJsonText([
    'jooevents.local-classified-stage-purge-marker',
    1,
    diskStagePurgeMarker(marker)
  ]);
}

function parseStagePurgeMarkerEnvelope(text: string): StoredStagePurgeMarkerEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw stageError('invalid_descriptor_auth');
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['marker', 'markerAuthenticationTag'])
    || typeof value.markerAuthenticationTag !== 'string'
    || !sha256Pattern.test(value.markerAuthenticationTag)
    || !isPlainRecord(value.marker)
    || !hasExactKeys(value.marker, [
      'authenticationProfile', 'formatVersion', 'lockNonce', 'metadataAuthenticationTag',
      'quarantineNonce', 'stageDirectoryIdentity', 'stageId', 'starting'
    ])
    || value.marker.formatVersion !== 1
    || typeof value.marker.lockNonce !== 'string'
    || !noncePattern.test(value.marker.lockNonce)
    || typeof value.marker.quarantineNonce !== 'string'
    || !noncePattern.test(value.marker.quarantineNonce)
    || typeof value.marker.metadataAuthenticationTag !== 'string'
    || !sha256Pattern.test(value.marker.metadataAuthenticationTag)) {
    throw stageError('invalid_descriptor_auth');
  }
  const starting = parseStageLockBinding(value.marker.starting);
  if (starting.state !== 'staged' || starting.payloadRefId !== undefined) {
    throw stageError('invalid_descriptor_auth');
  }
  return Object.freeze({
    marker: Object.freeze({
      formatVersion: 1,
      stageId: normalizeStageId(value.marker.stageId),
      stageDirectoryIdentity: parseFileIdentity(value.marker.stageDirectoryIdentity),
      quarantineNonce: value.marker.quarantineNonce,
      lockNonce: value.marker.lockNonce,
      authenticationProfile: parseProfile(value.marker.authenticationProfile, 'descriptor_auth'),
      starting,
      metadataAuthenticationTag: value.marker.metadataAuthenticationTag
    }),
    markerAuthenticationTag: value.markerAuthenticationTag
  });
}

function exactStageLockOwner(left: StoredStageLockOwner, right: StoredStageLockOwner): boolean {
  return canonicalJsonText(diskStageLockOwner(left)) === canonicalJsonText(diskStageLockOwner(right));
}

function exactStageLockBinding(left: StoredStageLockBinding, right: StoredStageLockBinding): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function parseEnvelope(text: string): StoredStageEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw stageError('invalid_descriptor_auth');
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['metadataAuthenticationTag', 'record'])
    || typeof value.metadataAuthenticationTag !== 'string'
    || !sha256Pattern.test(value.metadataAuthenticationTag)) {
    throw stageError('invalid_descriptor_auth');
  }
  return Object.freeze({
    record: normalizeRecord(value.record),
    metadataAuthenticationTag: value.metadataAuthenticationTag
  });
}

function metadataFrame(record: StoredStageRecord): string {
  return canonicalJsonText([
    'jooevents.local-classified-stage-metadata',
    1,
    diskRecord(record)
  ]);
}

function descriptorFrame(input: {
  readonly stageId: string;
  readonly version: number;
  readonly fence: number;
  readonly expiresAt: string;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
  readonly authenticationProfile: ClassifiedPayloadProfileRef<'descriptor_auth'>;
}): string {
  return canonicalJsonText([
    'jooevents.local-classified-stage-descriptor',
    1,
    input.stageId,
    input.version,
    input.fence,
    input.expiresAt,
    input.reconciliationPolicy.key,
    input.reconciliationPolicy.version,
    input.authenticationProfile.key,
    input.authenticationProfile.version
  ]);
}

function cursorFrame(stageId: string): string {
  return canonicalJsonText(['jooevents.local-classified-stage-cursor', 1, stageId]);
}

function exactDescriptor(left: ClassifiedPayloadDescriptor, right: ClassifiedPayloadDescriptor): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function exactPolicy(left: StageReconciliationPolicyRef, right: StageReconciliationPolicyRef): boolean {
  return policyKey(left) === policyKey(right);
}

function exactProfile(left: ClassifiedPayloadProfileRef, right: ClassifiedPayloadProfileRef): boolean {
  return profileKey(left) === profileKey(right);
}

function hmacHex(key: Uint8Array, frame: string): string {
  return createHmac('sha256', key).update(frame, 'utf8').digest('hex');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!sha256Pattern.test(left) || !sha256Pattern.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sha256File(path: string, expectedSize: number): string {
  const opened = openVerifiedRead(path);
  try {
    const before = fstatSync(opened.descriptor, { bigint: true });
    if (before.size !== BigInt(expectedSize)) throw stageError('descriptor_mismatch');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(opened.descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      total += count;
    }
    const after = fstatSync(opened.descriptor, { bigint: true });
    if (total !== expectedSize
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || String(before.dev) !== String(after.dev)
      || String(before.ino) !== String(after.ino)
      || after.nlink !== 1n) throw stageError('descriptor_mismatch');
    return hash.digest('hex');
  } finally {
    closeSync(opened.descriptor);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class LocalFilesystemClassifiedPayloadStageStore implements ClassifiedPayloadStageStore {
  readonly #root: string;
  readonly #rootIdentity: FileIdentity;
  readonly #stageRoot: string;
  readonly #stageRootIdentity: FileIdentity;
  readonly #profileResolver: RetainedClassifiedPayloadProfileResolver;
  readonly #purgeProofVerifier: UnadoptedStageProofVerifier;
  readonly #newStageId: () => string;

  constructor(options: LocalFilesystemClassifiedPayloadStageStoreOptions) {
    if (!options.purgeProofVerifier || typeof options.purgeProofVerifier.verifyAndConsume !== 'function') {
      throw new TypeError('classified_payload_stage_purge_verifier_required');
    }
    const verifyAndConsume = options.purgeProofVerifier.verifyAndConsume.bind(options.purgeProofVerifier);
    if (!isAbsolute(options.root) || resolve(options.root) !== options.root || basename(options.root).length === 0) {
      throw new TypeError('classified_payload_stage_root_unsafe');
    }
    let root: string;
    try {
      const requested = lstatSync(options.root);
      if (!requested.isDirectory() || requested.isSymbolicLink()) {
        throw new TypeError('classified_payload_stage_root_unsafe');
      }
      assertPrivateOwnership(requested);
      root = realpathSync(options.root);
      this.#rootIdentity = assertPrivateDirectory(root);
      this.#stageRoot = join(root, storeDirectoryName);
      if (!existsSync(this.#stageRoot)) {
        try {
          mkdirSync(this.#stageRoot, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        safeFsyncDirectory(root);
      }
      chmodSync(this.#stageRoot, 0o700);
      this.#stageRootIdentity = assertPrivateDirectory(this.#stageRoot);
      if (dirname(this.#stageRoot) !== root) throw new TypeError('classified_payload_stage_root_unsafe');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'classified_payload_stage_root_unsafe') throw error;
      throw new TypeError('classified_payload_stage_root_unsafe');
    }
    this.#root = root;
    this.#profileResolver = options.profileResolver;
    this.#purgeProofVerifier = Object.freeze({
      verifyAndConsume
    });
    this.#newStageId = options.newStageId ?? (() => crypto.randomUUID());
  }

  #assertRoot(): void {
    const root = assertPrivateDirectory(this.#root);
    const stageRoot = assertPrivateDirectory(this.#stageRoot);
    if (!sameIdentity(root, this.#rootIdentity)
      || !sameIdentity(stageRoot, this.#stageRootIdentity)
      || dirname(this.#stageRoot) !== this.#root) throw stageError('invalid_descriptor_auth');
  }

  #stageDirectory(stageId: unknown): { readonly stageId: PayloadStageId; readonly path: string } {
    const normalized = normalizeStageId(stageId);
    const path = join(this.#stageRoot, normalized);
    if (dirname(path) !== this.#stageRoot || basename(path) !== normalized) throw stageError('stage_not_found');
    return { stageId: normalized, path };
  }

  async #assertProfiles(descriptor: ClassifiedPayloadDescriptor): Promise<void> {
    for (const profile of profilesOf(descriptor.profiles)) {
      let retained = false;
      try {
        retained = await this.#profileResolver.isRetainedProfile(profile);
      } catch {
        throw stageError('unknown_profile');
      }
      if (!retained) throw stageError('unknown_profile');
    }
  }

  async #assertPolicy(policy: StageReconciliationPolicyRef): Promise<void> {
    let retained = false;
    try {
      retained = await this.#profileResolver.isRetainedReconciliationPolicy(policy);
    } catch {
      throw stageError('unknown_profile');
    }
    if (!retained) throw stageError('unknown_profile');
  }

  async #withAuthenticationKey<Value>(
    profile: ClassifiedPayloadProfileRef<'descriptor_auth'>,
    consume: (key: Uint8Array) => Value
  ): Promise<Value> {
    let resolved: Uint8Array | undefined;
    try {
      resolved = await this.#profileResolver.resolveDescriptorAuthenticationKey(profile);
    } catch {
      throw stageError('unknown_profile');
    }
    if (!(resolved instanceof Uint8Array) || resolved.byteLength < 16) throw stageError('unknown_profile');
    const owned = Uint8Array.from(resolved);
    try {
      return consume(owned);
    } finally {
      owned.fill(0);
    }
  }

  async #metadataTag(record: StoredStageRecord): Promise<string> {
    return this.#withAuthenticationKey(
      record.classified.profiles.descriptorAuth,
      (key) => hmacHex(key, metadataFrame(record))
    );
  }

  async #signedDescriptor(record: StoredStageRecord): Promise<AuthenticatedPayloadStageDescriptor> {
    const authenticationProfile = record.classified.profiles.descriptorAuth;
    const frame = descriptorFrame({
      stageId: record.stageId,
      version: record.version,
      fence: record.fence,
      expiresAt: record.expiresAt,
      reconciliationPolicy: record.reconciliationPolicy,
      authenticationProfile
    });
    const authenticationTag = await this.#withAuthenticationKey(
      authenticationProfile,
      (key) => hmacHex(key, frame)
    );
    return createAuthenticatedPayloadStageDescriptor({
      stageId: record.stageId,
      expectedVersion: record.version,
      fence: record.fence,
      expiresAt: record.expiresAt,
      reconciliationPolicy: record.reconciliationPolicy,
      authenticationProfile,
      authenticationTag
    });
  }

  async #verifySuppliedDescriptor(stage: AuthenticatedPayloadStageDescriptor): Promise<AuthenticatedPayloadStageDescriptor> {
    let normalized: AuthenticatedPayloadStageDescriptor;
    try {
      normalized = createAuthenticatedPayloadStageDescriptor({
        stageId: stage.stageId,
        expectedVersion: Number(stage.expectedVersion),
        fence: Number(stage.fence),
        expiresAt: stage.expiresAt,
        reconciliationPolicy: parsePolicy(stage.reconciliationPolicy),
        authenticationProfile: parseProfile(stage.authenticationProfile, 'descriptor_auth'),
        authenticationTag: stage.authenticationTag
      });
    } catch {
      throw stageError('invalid_descriptor_auth');
    }
    const frame = descriptorFrame({
      stageId: normalized.stageId,
      version: Number(normalized.expectedVersion),
      fence: Number(normalized.fence),
      expiresAt: normalized.expiresAt,
      reconciliationPolicy: normalized.reconciliationPolicy,
      authenticationProfile: normalized.authenticationProfile
    });
    const valid = await this.#withAuthenticationKey(
      normalized.authenticationProfile,
      (key) => constantTimeHexEqual(hmacHex(key, frame), normalized.authenticationTag)
    );
    if (!valid) throw stageError('invalid_descriptor_auth');
    return normalized;
  }

  #readStageLockEnvelopeStructure(
    lockFile: string,
    stageDirectory: string,
    expectedStageId: PayloadStageId,
    expectedFileName?: string
  ): { readonly envelope: StoredStageLockEnvelope; readonly identity: FileIdentity } {
    const identity = assertPrivateLockFile(lockFile, 8_192);
    const envelope = parseStageLockEnvelope(readPrivateLockText(lockFile, 8_192));
    const owner = envelope.owner;
    const stageIdentity = assertPrivateDirectory(stageDirectory);
    if (owner.stageId !== expectedStageId
      || !sameIdentity(owner.stageDirectoryIdentity, stageIdentity)
      || !sameIdentity(owner.lockFileIdentity, identity)) {
      throw stageError('invalid_descriptor_auth');
    }
    if (expectedFileName !== undefined) {
      const pending = pendingLockDirectoryPattern.exec(expectedFileName);
      const reclaimed = reclaimedLockDirectoryPattern.exec(expectedFileName);
      const next = nextLockFilePattern.exec(expectedFileName);
      if (pending && pending[1] !== owner.nonce) throw stageError('invalid_descriptor_auth');
      if (reclaimed && reclaimed[1] !== owner.nonce) throw stageError('invalid_descriptor_auth');
      if (next && next[1] !== owner.previousLockNonce) throw stageError('invalid_descriptor_auth');
      if (!pending && !reclaimed && !next) throw stageError('invalid_descriptor_auth');
    } else if (owner.previousLockNonce !== undefined) {
      throw stageError('invalid_descriptor_auth');
    }
    return Object.freeze({ envelope, identity });
  }

  async #readAuthenticatedStageLockOwner(
    lockFile: string,
    stageDirectory: string,
    expectedStageId: PayloadStageId,
    expectedFileName?: string
  ): Promise<{ readonly envelope: StoredStageLockEnvelope; readonly identity: FileIdentity }> {
    const read = this.#readStageLockEnvelopeStructure(
      lockFile,
      stageDirectory,
      expectedStageId,
      expectedFileName
    );
    const expectedTag = await this.#withAuthenticationKey(
      read.envelope.owner.authenticationProfile,
      (key) => hmacHex(key, stageLockOwnerFrame(read.envelope.owner))
    );
    if (!constantTimeHexEqual(expectedTag, read.envelope.ownerAuthenticationTag)) {
      throw stageError('invalid_descriptor_auth');
    }
    return read;
  }

  async #stageLockChainTip(
    stageDirectory: string,
    stageId: PayloadStageId
  ): Promise<StageLockChainTip> {
    const rootLock = join(stageDirectory, lockDirectoryName);
    const coordination = readdirSync(stageDirectory).filter((name) =>
      name === lockDirectoryName
      || reclaimedLockDirectoryPattern.test(name)
      || nextLockFilePattern.test(name)
    );
    if (!existsSync(rootLock)) {
      if (coordination.length > 0) throw stageError('invalid_descriptor_auth');
      return Object.freeze({ publicationPath: rootLock });
    }
    const expected = new Set<string>([lockDirectoryName]);
    const seen = new Set<string>();
    let currentPath = rootLock;
    let current = await this.#readAuthenticatedStageLockOwner(rootLock, stageDirectory, stageId);
    for (;;) {
      const nonce = current.envelope.owner.nonce;
      if (seen.has(nonce)) throw stageError('invalid_descriptor_auth');
      seen.add(nonce);
      const releasedName = `.lock-reclaimed-${nonce}`;
      const releasedPath = join(stageDirectory, releasedName);
      const successorName = `.lock-next-${nonce}`;
      const successorPath = join(stageDirectory, successorName);
      if (!existsSync(releasedPath)) {
        if (existsSync(successorPath)) throw stageError('invalid_descriptor_auth');
        if (coordination.some((name) => !expected.has(name))) {
          throw stageError('invalid_descriptor_auth');
        }
        return Object.freeze({
          active: Object.freeze({ path: currentPath, ...current }),
          publicationPath: successorPath,
          previousLockNonce: nonce
        });
      }
      expected.add(releasedName);
      const released = await this.#readAuthenticatedStageLockOwner(
        releasedPath,
        stageDirectory,
        stageId,
        releasedName
      );
      if (!sameIdentity(released.identity, current.identity)
        || !exactStageLockEnvelope(released.envelope, current.envelope)) {
        throw stageError('invalid_descriptor_auth');
      }
      if (!existsSync(successorPath)) {
        if (coordination.some((name) => !expected.has(name))) {
          throw stageError('invalid_descriptor_auth');
        }
        return Object.freeze({
          publicationPath: successorPath,
          previousLockNonce: nonce
        });
      }
      expected.add(successorName);
      currentPath = successorPath;
      current = await this.#readAuthenticatedStageLockOwner(
        successorPath,
        stageDirectory,
        stageId,
        successorName
      );
    }
  }

  #validateStageEntries(stageDirectory: string, stageId: PayloadStageId): void {
    const names = readdirSync(stageDirectory).sort();
    const coordinationNames = names.filter((name) =>
      name === lockDirectoryName
      || pendingLockDirectoryPattern.test(name)
      || reclaimedLockDirectoryPattern.test(name)
      || nextLockFilePattern.test(name)
    );
    const hasCoordination = coordinationNames.length > 0;
    for (const name of names) {
      if (name === metadataFileName || name === payloadFileName) continue;
      if (name === purgeMarkerFileName) {
        assertPrivateRegularFile(join(stageDirectory, name), maximumMetadataBytes);
        continue;
      }
      if (name === lockDirectoryName
        || reclaimedLockDirectoryPattern.test(name)
        || nextLockFilePattern.test(name)) {
        this.#readStageLockEnvelopeStructure(
          join(stageDirectory, name),
          stageDirectory,
          stageId,
          name === lockDirectoryName ? undefined : name
        );
        continue;
      }
      if (pendingLockDirectoryPattern.test(name)) {
        const pending = join(stageDirectory, name);
        assertPrivateLockFile(pending, 8_192);
        continue;
      }
      if (hasCoordination && (temporaryMetadataPattern.test(name) || temporaryPurgeMarkerPattern.test(name))) {
        assertPrivateRegularFile(join(stageDirectory, name), maximumMetadataBytes);
        continue;
      }
      throw stageError('invalid_descriptor_auth');
    }
    if (!names.includes(metadataFileName) || !names.includes(payloadFileName)) {
      throw stageError('invalid_descriptor_auth');
    }
  }

  async #loadRecord(stageIdInput: unknown): Promise<StoredStageRecord> {
    this.#assertRoot();
    const target = this.#stageDirectory(stageIdInput);
    if (!existsSync(target.path)) throw stageError('stage_not_found');
    return this.#loadRecordAt(target.path, target.stageId);
  }

  async #loadAuthenticatedRecordAt(
    stageDirectory: string,
    stageId: PayloadStageId
  ): Promise<StoredStageRecord> {
    this.#assertRoot();
    assertPrivateDirectory(stageDirectory);
    this.#validateStageEntries(stageDirectory, stageId);
    const envelope = parseEnvelope(readPrivateText(join(stageDirectory, metadataFileName), maximumMetadataBytes));
    if (envelope.record.stageId !== stageId) throw stageError('invalid_descriptor_auth');
    const expectedTag = await this.#metadataTag(envelope.record);
    if (!constantTimeHexEqual(expectedTag, envelope.metadataAuthenticationTag)) {
      throw stageError('invalid_descriptor_auth');
    }
    for (const name of readdirSync(stageDirectory).sort()) {
      if (name !== lockDirectoryName
        && !reclaimedLockDirectoryPattern.test(name)
        && !nextLockFilePattern.test(name)) continue;
      const lock = await this.#readAuthenticatedStageLockOwner(
        join(stageDirectory, name),
        stageDirectory,
        stageId,
        name === lockDirectoryName ? undefined : name
      );
      if (!exactProfile(
        lock.envelope.owner.authenticationProfile,
        envelope.record.classified.profiles.descriptorAuth
      )) throw stageError('invalid_descriptor_auth');
    }
    return envelope.record;
  }

  async #loadRecordAt(stageDirectory: string, stageId: PayloadStageId): Promise<StoredStageRecord> {
    const record = await this.#loadAuthenticatedRecordAt(stageDirectory, stageId);
    await this.#assertProfiles(record.classified);
    await this.#assertPolicy(record.reconciliationPolicy);
    const digest = sha256File(join(stageDirectory, payloadFileName), record.classified.byteSize);
    if (digest !== record.classified.integrityDigest) throw stageError('descriptor_mismatch');
    return record;
  }

  async #writeRecord(stageDirectory: string, record: StoredStageRecord): Promise<void> {
    assertPrivateDirectory(stageDirectory);
    const envelope = {
      record: diskRecord(record),
      metadataAuthenticationTag: await this.#metadataTag(record)
    };
    const text = `${canonicalJsonText(envelope)}\n`;
    if (Buffer.byteLength(text, 'utf8') > maximumMetadataBytes) throw stageError('invalid_descriptor_auth');
    const temporary = join(stageDirectory, `.metadata-${randomBytes(16).toString('hex')}.tmp`);
    try {
      writeExclusivePrivateFile(temporary, text);
      const current = join(stageDirectory, metadataFileName);
      if (existsSync(current)) assertPrivateRegularFile(current, maximumMetadataBytes);
      renameSync(temporary, current);
      assertPrivateRegularFile(current, maximumMetadataBytes);
      safeFsyncDirectory(stageDirectory);
    } catch (error) {
      try {
        safeUnlinkPrivateFile(temporary);
      } catch {
        // Preserve the original refusal and leave an owner-only artifact for inspection.
      }
      throw error;
    }
  }

  async #readAuthenticatedPurgeMarker(
    stageDirectory: string,
    stageId: PayloadStageId,
    expectedQuarantineNonce?: string,
    record?: StoredStageRecord
  ): Promise<StoredStagePurgeMarkerEnvelope> {
    const markerPath = join(stageDirectory, purgeMarkerFileName);
    const envelope = parseStagePurgeMarkerEnvelope(readPrivateText(markerPath, maximumMetadataBytes));
    const stageIdentity = assertPrivateDirectory(stageDirectory);
    if (envelope.marker.stageId !== stageId
      || !sameIdentity(envelope.marker.stageDirectoryIdentity, stageIdentity)
      || (expectedQuarantineNonce !== undefined
        && envelope.marker.quarantineNonce !== expectedQuarantineNonce)) {
      throw stageError('invalid_descriptor_auth');
    }
    const expectedTag = await this.#withAuthenticationKey(
      envelope.marker.authenticationProfile,
      (key) => hmacHex(key, stagePurgeMarkerFrame(envelope.marker))
    );
    if (!constantTimeHexEqual(expectedTag, envelope.markerAuthenticationTag)) {
      throw stageError('invalid_descriptor_auth');
    }
    if (record) {
      const expectedMetadataTag = await this.#metadataTag(record);
      if (!exactStageLockBinding(envelope.marker.starting, stageLockBinding(record))
        || !exactProfile(envelope.marker.authenticationProfile, record.classified.profiles.descriptorAuth)
        || !constantTimeHexEqual(envelope.marker.metadataAuthenticationTag, expectedMetadataTag)) {
        throw stageError('invalid_descriptor_auth');
      }
    }
    return envelope;
  }

  async #writePurgeMarker(
    stageDirectory: string,
    record: StoredStageRecord,
    lockNonce: string
  ): Promise<StoredStagePurgeMarkerEnvelope> {
    if (record.state !== 'staged' || record.payloadRef) throw stageError('stage_not_purgeable');
    const quarantineNonce = randomBytes(16).toString('hex');
    const marker: StoredStagePurgeMarker = Object.freeze({
      formatVersion: 1,
      stageId: record.stageId,
      stageDirectoryIdentity: assertPrivateDirectory(stageDirectory),
      quarantineNonce,
      lockNonce,
      authenticationProfile: record.classified.profiles.descriptorAuth,
      starting: stageLockBinding(record),
      metadataAuthenticationTag: await this.#metadataTag(record)
    });
    const markerAuthenticationTag = await this.#withAuthenticationKey(
      marker.authenticationProfile,
      (key) => hmacHex(key, stagePurgeMarkerFrame(marker))
    );
    const envelope: StoredStagePurgeMarkerEnvelope = Object.freeze({ marker, markerAuthenticationTag });
    const temporary = join(stageDirectory, `.purge-${randomBytes(16).toString('hex')}.tmp`);
    try {
      writeExclusivePrivateFile(temporary, `${canonicalJsonText({
        marker: diskStagePurgeMarker(marker),
        markerAuthenticationTag
      })}\n`);
      const current = join(stageDirectory, purgeMarkerFileName);
      if (existsSync(current)) throw stageError('invalid_descriptor_auth');
      renameSync(temporary, current);
      assertPrivateRegularFile(current, maximumMetadataBytes);
      safeFsyncDirectory(stageDirectory);
      return envelope;
    } catch (error) {
      try {
        safeUnlinkPrivateFile(temporary);
      } catch {
        // A non-authoritative private temporary remains recoverable with its dead lock.
      }
      throw error;
    }
  }

  #removeOwnedLockFile(
    lockFile: string,
    stageDirectory: string,
    expectedStageId: PayloadStageId,
    expectedEnvelope: StoredStageLockEnvelope,
    expectedIdentity: FileIdentity
  ): void {
    const current = this.#readStageLockEnvelopeStructure(
      lockFile,
      stageDirectory,
      expectedStageId,
      basename(lockFile) === lockDirectoryName ? undefined : basename(lockFile)
    );
    if (!sameIdentity(current.identity, expectedIdentity)
      || !exactStageLockEnvelope(current.envelope, expectedEnvelope)) {
      throw stageError('invalid_descriptor_auth');
    }
    unlinkExactPrivateLockFile(lockFile, expectedIdentity);
    safeFsyncDirectory(stageDirectory);
  }

  async #retireOwnedStageLock(
    lockFile: string,
    stageDirectory: string,
    expectedStageId: PayloadStageId,
    expectedEnvelope: StoredStageLockEnvelope,
    expectedIdentity: FileIdentity
  ): Promise<void> {
    const current = this.#readStageLockEnvelopeStructure(
      lockFile,
      stageDirectory,
      expectedStageId,
      basename(lockFile) === lockDirectoryName ? undefined : basename(lockFile)
    );
    if (!sameIdentity(current.identity, expectedIdentity)
      || !exactStageLockEnvelope(current.envelope, expectedEnvelope)) {
      throw stageError('invalid_descriptor_auth');
    }
    const retired = join(stageDirectory, `.lock-reclaimed-${expectedEnvelope.owner.nonce}`);
    if (!existsSync(retired)) {
      try {
        linkSync(lockFile, retired);
        safeFsyncDirectory(stageDirectory);
      } catch (error) {
        if (!existsSync(retired)) throw error;
      }
    }
    const retiredOwner = await this.#readAuthenticatedStageLockOwner(
      retired,
      stageDirectory,
      expectedStageId,
      basename(retired)
    );
    if (!sameIdentity(retiredOwner.identity, expectedIdentity)
      || !exactStageLockEnvelope(retiredOwner.envelope, expectedEnvelope)) {
      throw stageError('invalid_descriptor_auth');
    }
  }

  async #createPreparedStageLock(
    stageDirectory: string,
    stageId: PayloadStageId,
    starting: StoredStageRecord,
    purpose: StageLockPurpose,
    previousLockNonce?: string
  ): Promise<{
    readonly path: string;
    readonly envelope: StoredStageLockEnvelope;
    readonly identity: FileIdentity;
  }> {
    const nonce = randomBytes(16).toString('hex');
    const path = join(stageDirectory, `.lock-pending-${nonce}`);
    const stageDirectoryIdentity = assertPrivateDirectory(stageDirectory);
    const processStartToken = currentClassifiedStageProcessStartToken();
    if (!processStartToken) throw stageError('stale_stage_fence');
    const authenticationKey = await this.#withAuthenticationKey(
      starting.classified.profiles.descriptorAuth,
      (key) => Uint8Array.from(key)
    );
    let descriptor: number | undefined;
    let identity: FileIdentity | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
        0o600
      );
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1) throw stageError('invalid_descriptor_auth');
      assertPrivateOwnership(stat);
      identity = identityOf(stat);
      const owner: StoredStageLockOwner = Object.freeze({
        formatVersion: 2,
        nonce,
        stageId,
        stageDirectoryIdentity,
        lockFileIdentity: identity,
        authenticationProfile: starting.classified.profiles.descriptorAuth,
        operation: purpose.operation,
        ...(previousLockNonce ? { previousLockNonce } : {}),
        ...(purpose.requestedPayloadRefId
          ? { requestedPayloadRefId: parsePayloadRefId(purpose.requestedPayloadRefId) }
          : {}),
        starting: stageLockBinding(starting),
        pid: process.pid,
        processStartToken,
        createdAt: Date.now()
      });
      const ownerAuthenticationTag = hmacHex(authenticationKey, stageLockOwnerFrame(owner));
      const envelope: StoredStageLockEnvelope = Object.freeze({ owner, ownerAuthenticationTag });
      writeFileSync(
        descriptor,
        `${canonicalJsonText({
          owner: diskStageLockOwner(owner),
          ownerAuthenticationTag
        })}\n`
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(path, 0o600);
      const completed = assertPrivateLockFile(path, 8_192);
      if (!sameIdentity(completed, identity)) throw stageError('invalid_descriptor_auth');
      safeFsyncDirectory(stageDirectory);
      return Object.freeze({ path, envelope, identity });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (identity && existsSync(path)) {
        try {
          unlinkExactPrivateLockFile(path, identity);
          safeFsyncDirectory(stageDirectory);
        } catch {
          // Preserve the original refusal. A private, nonblocking pending file may remain.
        }
      }
      throw error;
    } finally {
      authenticationKey.fill(0);
    }
  }

  #ownerTransitionMatchesCurrent(owner: StoredStageLockOwner, current: StoredStageRecord): boolean {
    const currentBinding = stageLockBinding(current);
    if (!exactProfile(owner.authenticationProfile, current.classified.profiles.descriptorAuth)
      || !exactPolicy(owner.starting.reconciliationPolicy, current.reconciliationPolicy)) return false;
    if (exactStageLockBinding(owner.starting, currentBinding)) return true;
    if (owner.operation === 'adopt') {
      return owner.starting.state === 'staged'
        && owner.starting.payloadRefId === undefined
        && current.state === 'adoption_pending'
        && current.version === owner.starting.version + 1
        && current.fence === owner.starting.fence + 1
        && current.payloadRef?.id === owner.requestedPayloadRefId;
    }
    if (owner.operation === 'mark') {
      return owner.starting.state === 'adoption_pending'
        && owner.starting.payloadRefId === owner.requestedPayloadRefId
        && current.state === 'adopted'
        && current.version === owner.starting.version + 1
        && current.fence === owner.starting.fence
        && current.payloadRef?.id === owner.requestedPayloadRefId;
    }
    return false;
  }

  #recordedOwnerIsDefinitelyDead(owner: StoredStageLockOwner): boolean {
    if (!owner.processStartToken) return false;
    const observation = observeClassifiedStageProcessIdentity(owner.pid);
    return observation.kind === 'absent'
      || (observation.kind === 'present' && observation.startToken !== owner.processStartToken);
  }

  async #reclaimDeadStageLock(
    stageDirectory: string,
    stageId: PayloadStageId,
    expectedActive: NonNullable<StageLockChainTip['active']>,
    authenticatedMetadataOnly = false
  ): Promise<boolean> {
    const first = await this.#readAuthenticatedStageLockOwner(
      expectedActive.path,
      stageDirectory,
      stageId,
      basename(expectedActive.path) === lockDirectoryName ? undefined : basename(expectedActive.path)
    );
    if (!sameIdentity(first.identity, expectedActive.identity)
      || !exactStageLockEnvelope(first.envelope, expectedActive.envelope)) {
      return false;
    }
    const tombstone = join(stageDirectory, `.lock-reclaimed-${first.envelope.owner.nonce}`);
    if (existsSync(tombstone)) {
      const previous = await this.#readAuthenticatedStageLockOwner(
        tombstone,
        stageDirectory,
        stageId,
        basename(tombstone)
      );
      if (!sameIdentity(previous.identity, first.identity)
        || !exactStageLockEnvelope(previous.envelope, first.envelope)) {
        throw stageError('invalid_descriptor_auth');
      }
      return true;
    }
    if (!this.#recordedOwnerIsDefinitelyDead(first.envelope.owner)) return false;
    const current = authenticatedMetadataOnly
      ? await this.#loadAuthenticatedRecordAt(stageDirectory, stageId)
      : await this.#loadRecordAt(stageDirectory, stageId);
    if (!this.#ownerTransitionMatchesCurrent(first.envelope.owner, current)) {
      throw stageError('invalid_descriptor_auth');
    }
    if (existsSync(join(stageDirectory, purgeMarkerFileName))) {
      const marker = await this.#readAuthenticatedPurgeMarker(stageDirectory, stageId, undefined, current);
      if (first.envelope.owner.operation !== 'purge') {
        throw stageError('invalid_descriptor_auth');
      }
    }
    const second = await this.#readAuthenticatedStageLockOwner(
      expectedActive.path,
      stageDirectory,
      stageId,
      basename(expectedActive.path) === lockDirectoryName ? undefined : basename(expectedActive.path)
    );
    if (!sameIdentity(second.identity, first.identity)
      || !exactStageLockEnvelope(second.envelope, first.envelope)
      || !this.#recordedOwnerIsDefinitelyDead(second.envelope.owner)) {
      return false;
    }
    const rechecked = authenticatedMetadataOnly
      ? await this.#loadAuthenticatedRecordAt(stageDirectory, stageId)
      : await this.#loadRecordAt(stageDirectory, stageId);
    if (!this.#ownerTransitionMatchesCurrent(second.envelope.owner, rechecked)) {
      throw stageError('invalid_descriptor_auth');
    }
    const pending = join(stageDirectory, `.lock-pending-${second.envelope.owner.nonce}`);
    if (existsSync(pending)) {
      const prepared = await this.#readAuthenticatedStageLockOwner(
        pending,
        stageDirectory,
        stageId,
        basename(pending)
      );
      if (!sameIdentity(prepared.identity, second.identity)
        || !exactStageLockEnvelope(prepared.envelope, second.envelope)) {
        throw stageError('invalid_descriptor_auth');
      }
      this.#removeOwnedLockFile(
        pending,
        stageDirectory,
        stageId,
        prepared.envelope,
        prepared.identity
      );
    }
    await this.#retireOwnedStageLock(
      expectedActive.path,
      stageDirectory,
      stageId,
      second.envelope,
      second.identity
    );
    return true;
  }

  #removeAbandonedMetadataTemps(stageDirectory: string): void {
    let changed = false;
    for (const name of readdirSync(stageDirectory).sort()) {
      if (!temporaryMetadataPattern.test(name) && !temporaryPurgeMarkerPattern.test(name)) continue;
      safeUnlinkPrivateFile(join(stageDirectory, name));
      changed = true;
    }
    if (changed) safeFsyncDirectory(stageDirectory);
  }

  async #removeAbandonedLockArtifacts(
    stageDirectory: string,
    stageId: PayloadStageId,
    _activeNonce: string
  ): Promise<void> {
    let changed = false;
    for (const name of readdirSync(stageDirectory).sort()) {
      const pending = pendingLockDirectoryPattern.exec(name);
      if (pending) {
        const path = join(stageDirectory, name);
        try {
          const owner = await this.#readAuthenticatedStageLockOwner(path, stageDirectory, stageId, name);
          if (this.#recordedOwnerIsDefinitelyDead(owner.envelope.owner)) {
            this.#removeOwnedLockFile(path, stageDirectory, stageId, owner.envelope, owner.identity);
            changed = true;
          }
        } catch {
          // A partial or unverifiable unpublished contender never blocks the chain.
        }
        continue;
      }
    }
    if (changed) safeFsyncDirectory(stageDirectory);
  }

  async #acquireStageLock(
    stageDirectory: string,
    stageId: PayloadStageId,
    purpose: StageLockPurpose,
    authenticatedMetadataOnly = false
  ): Promise<HeldStageLock> {
    const deadline = Date.now() + lockWaitMilliseconds;
    for (;;) {
      const observed = authenticatedMetadataOnly
        ? await this.#loadAuthenticatedRecordAt(stageDirectory, stageId)
        : await this.#loadRecordAt(stageDirectory, stageId);
      if (purpose.operation !== 'purge' && existsSync(join(stageDirectory, purgeMarkerFileName))) {
        await this.#readAuthenticatedPurgeMarker(stageDirectory, stageId, undefined, observed);
        throw stageError('stage_not_purgeable');
      }
      const chain = await this.#stageLockChainTip(stageDirectory, stageId);
      if (chain.active) {
        const reclaimed = await this.#reclaimDeadStageLock(
          stageDirectory,
          stageId,
          chain.active,
          authenticatedMetadataOnly
        );
        if (!reclaimed && Date.now() >= deadline) throw stageError('stale_stage_fence');
        if (!reclaimed) await wait(5);
        continue;
      }
      const prepared = await this.#createPreparedStageLock(
        stageDirectory,
        stageId,
        observed,
        purpose,
        chain.previousLockNonce
      );
      const lockPath = chain.publicationPath;
      let published = false;
      try {
        try {
          // Every chain slot is immutable and single-use. Hard-link publication is
          // atomic no-replace, so a released predecessor can never suffer path ABA.
          linkSync(prepared.path, lockPath);
          published = true;
          safeFsyncDirectory(stageDirectory);
        } catch (error) {
          if (!existsSync(lockPath)) throw error;
        }
        if (!published) {
          if (existsSync(prepared.path)) {
            this.#removeOwnedLockFile(
              prepared.path,
              stageDirectory,
              stageId,
              prepared.envelope,
              prepared.identity
            );
          }
          if (Date.now() >= deadline) throw stageError('stale_stage_fence');
          await wait(5);
          continue;
        }
        const publishedLock = await this.#readAuthenticatedStageLockOwner(
          lockPath,
          stageDirectory,
          stageId,
          basename(lockPath) === lockDirectoryName ? undefined : basename(lockPath)
        );
        if (!sameIdentity(publishedLock.identity, prepared.identity)
          || !exactStageLockEnvelope(publishedLock.envelope, prepared.envelope)) {
          throw stageError('invalid_descriptor_auth');
        }
        this.#removeOwnedLockFile(
          prepared.path,
          stageDirectory,
          stageId,
          prepared.envelope,
          prepared.identity
        );
        const current = authenticatedMetadataOnly
          ? await this.#loadAuthenticatedRecordAt(stageDirectory, stageId)
          : await this.#loadRecordAt(stageDirectory, stageId);
        if (!exactStageLockBinding(stageLockBinding(observed), stageLockBinding(current))) {
          await this.#retireOwnedStageLock(
            lockPath,
            stageDirectory,
            stageId,
            prepared.envelope,
            prepared.identity
          );
          if (Date.now() >= deadline) throw stageError('stale_stage_fence');
          continue;
        }
        if (purpose.operation !== 'purge' && existsSync(join(stageDirectory, purgeMarkerFileName))) {
          await this.#readAuthenticatedPurgeMarker(stageDirectory, stageId, undefined, current);
          await this.#retireOwnedStageLock(
            lockPath,
            stageDirectory,
            stageId,
            prepared.envelope,
            prepared.identity
          );
          throw stageError('stage_not_purgeable');
        }
        this.#removeAbandonedMetadataTemps(stageDirectory);
        await this.#removeAbandonedLockArtifacts(
          stageDirectory,
          stageId,
          prepared.envelope.owner.nonce
        );
        return {
          nonce: prepared.envelope.owner.nonce,
          identity: prepared.identity,
          path: lockPath,
          release: async (currentStageDirectory = stageDirectory) => {
            const currentLockPath = join(currentStageDirectory, basename(lockPath));
            const currentOwner = this.#readStageLockEnvelopeStructure(
              currentLockPath,
              currentStageDirectory,
              stageId,
              basename(currentLockPath) === lockDirectoryName ? undefined : basename(currentLockPath)
            );
            if (!sameIdentity(currentOwner.identity, prepared.identity)
              || !exactStageLockEnvelope(currentOwner.envelope, prepared.envelope)
              || prepared.envelope.owner.pid !== process.pid) {
              throw stageError('invalid_descriptor_auth');
            }
            await this.#retireOwnedStageLock(
              currentLockPath,
              currentStageDirectory,
              stageId,
              prepared.envelope,
              prepared.identity
            );
          }
        };
      } catch (error) {
        try {
          if (existsSync(prepared.path)) {
            this.#removeOwnedLockFile(
              prepared.path,
              stageDirectory,
              stageId,
              prepared.envelope,
              prepared.identity
            );
          }
          if (published && existsSync(lockPath)) {
            await this.#retireOwnedStageLock(
              lockPath,
              stageDirectory,
              stageId,
              prepared.envelope,
              prepared.identity
            );
          }
        } catch {
          // Do not mask the original fail-closed refusal.
        }
        throw error;
      }
    }
  }

  async #withStageLock<Value>(
    stageId: PayloadStageId,
    purpose: StageLockPurpose,
    work: (record: StoredStageRecord) => Promise<Value>
  ): Promise<Value> {
    const target = this.#stageDirectory(stageId);
    if (!existsSync(target.path)) throw stageError('stage_not_found');
    assertPrivateDirectory(target.path);
    const lock = await this.#acquireStageLock(target.path, target.stageId, purpose);
    try {
      const record = await this.#loadRecordAt(target.path, stageId);
      return await work(record);
    } finally {
      await lock.release();
    }
  }

  #assertCurrent(record: StoredStageRecord, version: number, fence: number): void {
    if (record.version !== version) throw stageError('stale_stage_version');
    if (record.fence !== fence) throw stageError('stale_stage_fence');
  }

  #candidate(record: StoredStageRecord): PayloadStageReconciliationCandidate {
    return Object.freeze({
      stageId: record.stageId,
      expectedVersion: parseAggregateVersion(record.version),
      fence: createPayloadStageFence(record.fence),
      expiresAt: parseInstant(record.expiresAt),
      reconciliationPolicy: record.reconciliationPolicy
    });
  }

  async #inspection(record: StoredStageRecord): Promise<PayloadStageInspection> {
    return Object.freeze({
      stage: await this.#signedDescriptor(record),
      classified: record.classified,
      state: record.state,
      ...(record.payloadRef ? { payloadRef: record.payloadRef } : {})
    });
  }

  async #cursorFor(record: StoredStageRecord): Promise<StageReconciliationCursor> {
    const tag = await this.#withAuthenticationKey(
      record.classified.profiles.descriptorAuth,
      (key) => hmacHex(key, cursorFrame(record.stageId))
    );
    return createStageReconciliationCursor(`c1_${tag}`);
  }

  #purgedDirectory(stageId: PayloadStageId, quarantineNonce: string): string {
    return join(this.#stageRoot, `.purged-${stageId}-${quarantineNonce}`);
  }

  #purgeCleaningDirectory(stageId: PayloadStageId, quarantineNonce: string): string {
    return join(this.#stageRoot, `.purge-cleaning-${stageId}-${quarantineNonce}`);
  }

  async #finishPurgeCleaningDirectory(
    cleaningDirectory: string,
    stageId: PayloadStageId,
    quarantineNonce: string
  ): Promise<void> {
    if (!existsSync(cleaningDirectory)) return;
    const cleaningIdentity = assertPrivateDirectory(cleaningDirectory);
    const canonical = this.#stageDirectory(stageId).path;
    if (existsSync(canonical)) throw stageError('invalid_descriptor_auth');
    let names = readdirSync(cleaningDirectory).sort();
    if (names.length === 0) {
      try {
        rmdirSync(cleaningDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      safeFsyncDirectory(this.#stageRoot);
      return;
    }
    if (!names.includes(purgeMarkerFileName)) throw stageError('invalid_descriptor_auth');
    const marker = await this.#readAuthenticatedPurgeMarker(
      cleaningDirectory,
      stageId,
      quarantineNonce
    );
    if (!sameIdentity(marker.marker.stageDirectoryIdentity, cleaningIdentity)) {
      throw stageError('invalid_descriptor_auth');
    }
    for (const name of names) {
      if (name === purgeMarkerFileName || name === metadataFileName || name === payloadFileName) continue;
      if (temporaryMetadataPattern.test(name) || temporaryPurgeMarkerPattern.test(name)) {
        safeUnlinkPrivateFile(join(cleaningDirectory, name));
        continue;
      }
      if (pendingLockDirectoryPattern.test(name)) {
        const path = join(cleaningDirectory, name);
        const identity = assertPrivateLockFile(path, 8_192);
        unlinkExactPrivateLockFile(path, identity);
        continue;
      }
      if (name === lockDirectoryName
        || reclaimedLockDirectoryPattern.test(name)
        || nextLockFilePattern.test(name)) {
        const path = join(cleaningDirectory, name);
        const retired = await this.#readAuthenticatedStageLockOwner(
          path,
          cleaningDirectory,
          stageId,
          name === lockDirectoryName ? undefined : name
        );
        if (!sameIdentity(retired.envelope.owner.stageDirectoryIdentity, cleaningIdentity)) {
          throw stageError('invalid_descriptor_auth');
        }
        this.#removeOwnedLockFile(
          path,
          cleaningDirectory,
          stageId,
          retired.envelope,
          retired.identity
        );
        continue;
      }
      throw stageError('invalid_descriptor_auth');
    }
    safeUnlinkPrivateFile(join(cleaningDirectory, payloadFileName));
    safeUnlinkPrivateFile(join(cleaningDirectory, metadataFileName));
    safeFsyncDirectory(cleaningDirectory);
    // The authenticated marker is deliberately last. A crash before this point is
    // resumable; an empty recognized cleaning directory is safe to remove.
    safeUnlinkPrivateFile(join(cleaningDirectory, purgeMarkerFileName));
    safeFsyncDirectory(cleaningDirectory);
    try {
      rmdirSync(cleaningDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    safeFsyncDirectory(this.#stageRoot);
  }

  async #finishPurgedDirectory(
    purgedDirectory: string,
    stageId: PayloadStageId,
    quarantineNonce: string
  ): Promise<void> {
    const cleaningDirectory = this.#purgeCleaningDirectory(stageId, quarantineNonce);
    if (!existsSync(purgedDirectory)) {
      await this.#finishPurgeCleaningDirectory(cleaningDirectory, stageId, quarantineNonce);
      return;
    }
    const canonical = this.#stageDirectory(stageId).path;
    if (existsSync(canonical)) throw stageError('invalid_descriptor_auth');
    const record = await this.#loadAuthenticatedRecordAt(purgedDirectory, stageId);
    await this.#readAuthenticatedPurgeMarker(purgedDirectory, stageId, quarantineNonce, record);
    const lock = await this.#acquireStageLock(
      purgedDirectory,
      stageId,
      { operation: 'purge' },
      true
    );
    let moved = false;
    try {
      const rechecked = await this.#loadAuthenticatedRecordAt(purgedDirectory, stageId);
      await this.#readAuthenticatedPurgeMarker(purgedDirectory, stageId, quarantineNonce, rechecked);
      if (existsSync(cleaningDirectory)) throw stageError('invalid_descriptor_auth');
      renameSync(purgedDirectory, cleaningDirectory);
      moved = true;
      safeFsyncDirectory(this.#stageRoot);
    } finally {
      if (!moved) await lock.release(purgedDirectory);
    }
    await this.#finishPurgeCleaningDirectory(cleaningDirectory, stageId, quarantineNonce);
  }

  async #finishMarkedCanonicalStage(
    stageDirectory: string,
    stageId: PayloadStageId
  ): Promise<void> {
    const record = await this.#loadAuthenticatedRecordAt(stageDirectory, stageId);
    const marker = await this.#readAuthenticatedPurgeMarker(stageDirectory, stageId, undefined, record);
    const purgedDirectory = this.#purgedDirectory(stageId, marker.marker.quarantineNonce);
    const lock = await this.#acquireStageLock(
      stageDirectory,
      stageId,
      { operation: 'purge' },
      true
    );
    let moved = false;
    try {
      const rechecked = await this.#loadAuthenticatedRecordAt(stageDirectory, stageId);
      await this.#readAuthenticatedPurgeMarker(
        stageDirectory,
        stageId,
        marker.marker.quarantineNonce,
        rechecked
      );
      if (existsSync(purgedDirectory)) throw stageError('invalid_descriptor_auth');
      renameSync(stageDirectory, purgedDirectory);
      moved = true;
      safeFsyncDirectory(this.#stageRoot);
    } finally {
      await lock.release(moved ? purgedDirectory : stageDirectory);
    }
    await this.#finishPurgedDirectory(purgedDirectory, stageId, marker.marker.quarantineNonce);
  }

  async #finishNoncanonicalPurgeForStage(stageId: PayloadStageId): Promise<boolean> {
    let found = false;
    for (const name of readdirSync(this.#stageRoot).sort()) {
      const purged = purgedDirectoryPattern.exec(name);
      if (purged && purged[1] === stageId) {
        if (found) throw stageError('invalid_descriptor_auth');
        found = true;
        await this.#finishPurgedDirectory(join(this.#stageRoot, name), stageId, purged[2]!);
        continue;
      }
      const cleaning = purgeCleaningDirectoryPattern.exec(name);
      if (cleaning && cleaning[1] === stageId) {
        if (found) throw stageError('invalid_descriptor_auth');
        found = true;
        await this.#finishPurgeCleaningDirectory(join(this.#stageRoot, name), stageId, cleaning[2]!);
      }
    }
    return found;
  }

  async #records(): Promise<readonly StoredStageRecord[]> {
    this.#assertRoot();
    const records: StoredStageRecord[] = [];
    for (const name of readdirSync(this.#stageRoot).sort()) {
      const path = join(this.#stageRoot, name);
      if (uuidNamePattern.test(name)) {
        const stageId = normalizeStageId(name);
        if (existsSync(join(path, purgeMarkerFileName))) {
          await this.#finishMarkedCanonicalStage(path, stageId);
        } else {
          records.push(await this.#loadRecord(name));
        }
        continue;
      }
      const purged = purgedDirectoryPattern.exec(name);
      if (purged) {
        await this.#finishPurgedDirectory(path, normalizeStageId(purged[1]), purged[2]!);
        continue;
      }
      const cleaning = purgeCleaningDirectoryPattern.exec(name);
      if (cleaning) {
        await this.#finishPurgeCleaningDirectory(path, normalizeStageId(cleaning[1]), cleaning[2]!);
        continue;
      }
      if (temporaryPutPattern.test(name)) {
        assertPrivateDirectory(path);
        continue;
      }
      throw stageError('invalid_descriptor_auth');
    }
    return Object.freeze(records.sort((left, right) => left.stageId.localeCompare(right.stageId)));
  }

  async put(input: {
    readonly descriptor: ClassifiedPayloadDescriptor;
    readonly bytes: Uint8Array;
    readonly expiresAt: ReturnType<typeof parseInstant>;
    readonly reconciliationPolicy: StageReconciliationPolicyRef;
  }): Promise<AuthenticatedPayloadStageDescriptor> {
    try {
      this.#assertRoot();
      const descriptor = normalizeDescriptor(input.descriptor);
      const expiresAt = parseInstant(input.expiresAt);
      const reconciliationPolicy = parsePolicy(input.reconciliationPolicy);
      await this.#assertProfiles(descriptor);
      await this.#assertPolicy(reconciliationPolicy);
      if (!(input.bytes instanceof Uint8Array)
        || input.bytes.byteLength !== descriptor.byteSize
        || createHash('sha256').update(input.bytes).digest('hex') !== descriptor.integrityDigest) {
        throw stageError('descriptor_mismatch');
      }
      const stageId = normalizeStageId(this.#newStageId());
      const target = this.#stageDirectory(stageId);
      if (existsSync(target.path)) throw stageError('adoption_conflict');
      const temporary = join(this.#stageRoot, `.put-${randomBytes(16).toString('hex')}`);
      let committed = false;
      try {
        mkdirSync(temporary, { mode: 0o700 });
        chmodSync(temporary, 0o700);
        assertPrivateDirectory(temporary);
        writeExclusivePrivateFile(join(temporary, payloadFileName), Uint8Array.from(input.bytes));
        const record: StoredStageRecord = Object.freeze({
          formatVersion: 1,
          stageId,
          version: 1,
          fence: 1,
          expiresAt,
          reconciliationPolicy,
          classified: descriptor,
          state: 'staged'
        });
        await this.#writeRecord(temporary, record);
        this.#validateStageEntries(temporary, stageId);
        safeFsyncDirectory(temporary);
        if (existsSync(target.path)) throw stageError('adoption_conflict');
        renameSync(temporary, target.path);
        committed = true;
        assertPrivateDirectory(target.path);
        safeFsyncDirectory(this.#stageRoot);
        return await this.#signedDescriptor(record);
      } finally {
        if (!committed && existsSync(temporary)) {
          try {
            const names = readdirSync(temporary).sort();
            for (const name of names) {
              if (name !== metadataFileName && name !== payloadFileName && !temporaryMetadataPattern.test(name)) {
                throw stageError('invalid_descriptor_auth');
              }
              safeUnlinkPrivateFile(join(temporary, name));
            }
            rmdirSync(temporary);
            safeFsyncDirectory(this.#stageRoot);
          } catch {
            // An owner-only incomplete put remains undiscoverable until explicit recovery.
          }
        }
      }
    } catch (error) {
      throw guardedError(error, 'invalid_descriptor_auth');
    }
  }

  async inspect(input:
    | { readonly source: 'descriptor'; readonly stage: AuthenticatedPayloadStageDescriptor }
    | { readonly source: 'reconciliation'; readonly candidate: PayloadStageReconciliationCandidate }
  ): Promise<PayloadStageInspection> {
    try {
      if (input.source === 'descriptor') {
        const stage = await this.#verifySuppliedDescriptor(input.stage);
        const record = await this.#loadRecord(stage.stageId);
        if (!exactProfile(record.classified.profiles.descriptorAuth, stage.authenticationProfile)
          || record.expiresAt !== stage.expiresAt
          || !exactPolicy(record.reconciliationPolicy, stage.reconciliationPolicy)) {
          throw stageError('invalid_descriptor_auth');
        }
        this.#assertCurrent(record, Number(stage.expectedVersion), Number(stage.fence));
        return this.#inspection(record);
      }
      const candidate = this.#normalizeCandidate(input.candidate);
      const record = await this.#loadRecord(candidate.stageId);
      this.#assertCurrent(record, Number(candidate.expectedVersion), Number(candidate.fence));
      if (!exactPolicy(record.reconciliationPolicy, candidate.reconciliationPolicy)) {
        throw stageError('proof_mismatch');
      }
      return this.#inspection(record);
    } catch (error) {
      throw guardedError(error, 'invalid_descriptor_auth');
    }
  }

  async adopt(input: {
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly expectedDescriptor: ClassifiedPayloadDescriptor;
    readonly payloadRefId: ReturnType<typeof parsePayloadRefId>;
    readonly at: ReturnType<typeof parseInstant>;
  }): Promise<PayloadStageAdoptionResult> {
    try {
      const stage = await this.#verifySuppliedDescriptor(input.stage);
      const expectedDescriptor = normalizeDescriptor(input.expectedDescriptor);
      await this.#assertProfiles(expectedDescriptor);
      const payloadRef = createPayloadRef(parsePayloadRefId(input.payloadRefId));
      const at = parseInstant(input.at);
      const preflight = await this.#loadRecord(stage.stageId);
      if (!exactProfile(preflight.classified.profiles.descriptorAuth, stage.authenticationProfile)
        || preflight.expiresAt !== stage.expiresAt
        || !exactPolicy(preflight.reconciliationPolicy, stage.reconciliationPolicy)) {
        throw stageError('invalid_descriptor_auth');
      }
      if (!exactDescriptor(preflight.classified, expectedDescriptor)) throw stageError('descriptor_mismatch');
      if (preflight.state !== 'staged') {
        if (preflight.payloadRef?.id !== payloadRef.id) throw stageError('adoption_conflict');
        return Object.freeze({
          kind: 'replay' as const,
          payloadRef: preflight.payloadRef,
          continuation: await this.#signedDescriptor(preflight)
        });
      }
      this.#assertCurrent(preflight, Number(stage.expectedVersion), Number(stage.fence));
      if (at >= preflight.expiresAt) throw stageError('stage_expired');
      return await this.#withStageLock(stage.stageId, {
        operation: 'adopt',
        requestedPayloadRefId: payloadRef.id
      }, async (record) => {
        if (!exactProfile(record.classified.profiles.descriptorAuth, stage.authenticationProfile)
          || record.expiresAt !== stage.expiresAt
          || !exactPolicy(record.reconciliationPolicy, stage.reconciliationPolicy)) {
          throw stageError('invalid_descriptor_auth');
        }
        if (!exactDescriptor(record.classified, expectedDescriptor)) throw stageError('descriptor_mismatch');
        if (record.state !== 'staged') {
          if (record.payloadRef?.id !== payloadRef.id) throw stageError('adoption_conflict');
          return Object.freeze({
            kind: 'replay' as const,
            payloadRef: record.payloadRef,
            continuation: await this.#signedDescriptor(record)
          });
        }
        this.#assertCurrent(record, Number(stage.expectedVersion), Number(stage.fence));
        if (at >= record.expiresAt) throw stageError('stage_expired');
        const next: StoredStageRecord = Object.freeze({
          ...record,
          version: record.version + 1,
          fence: record.fence + 1,
          state: 'adoption_pending',
          payloadRef
        });
        await this.#writeRecord(this.#stageDirectory(record.stageId).path, next);
        return Object.freeze({
          kind: 'adopted' as const,
          payloadRef,
          continuation: await this.#signedDescriptor(next)
        });
      });
    } catch (error) {
      throw guardedError(error, 'invalid_descriptor_auth');
    }
  }

  async markAdopted(input: {
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly payloadRef: PayloadRef;
  }): Promise<PayloadStageMarkResult> {
    try {
      const stage = await this.#verifySuppliedDescriptor(input.stage);
      const payloadRef = createPayloadRef(parsePayloadRefId(input.payloadRef.id));
      const preflight = await this.#loadRecord(stage.stageId);
      if (!exactProfile(preflight.classified.profiles.descriptorAuth, stage.authenticationProfile)
        || preflight.expiresAt !== stage.expiresAt
        || !exactPolicy(preflight.reconciliationPolicy, stage.reconciliationPolicy)) {
        throw stageError('invalid_descriptor_auth');
      }
      if (preflight.state === 'adopted') {
        if (preflight.payloadRef?.id !== payloadRef.id) throw stageError('adoption_conflict');
        return Object.freeze({ kind: 'replay' as const, payloadRef: preflight.payloadRef });
      }
      this.#assertCurrent(preflight, Number(stage.expectedVersion), Number(stage.fence));
      if (preflight.state !== 'adoption_pending' || preflight.payloadRef?.id !== payloadRef.id) {
        throw stageError('adoption_conflict');
      }
      return await this.#withStageLock(stage.stageId, {
        operation: 'mark',
        requestedPayloadRefId: payloadRef.id
      }, async (record) => {
        if (!exactProfile(record.classified.profiles.descriptorAuth, stage.authenticationProfile)
          || record.expiresAt !== stage.expiresAt
          || !exactPolicy(record.reconciliationPolicy, stage.reconciliationPolicy)) {
          throw stageError('invalid_descriptor_auth');
        }
        if (record.state === 'adopted') {
          if (record.payloadRef?.id !== payloadRef.id) throw stageError('adoption_conflict');
          return Object.freeze({ kind: 'replay' as const, payloadRef: record.payloadRef });
        }
        this.#assertCurrent(record, Number(stage.expectedVersion), Number(stage.fence));
        if (record.state !== 'adoption_pending' || record.payloadRef?.id !== payloadRef.id) {
          throw stageError('adoption_conflict');
        }
        const next: StoredStageRecord = Object.freeze({ ...record, version: record.version + 1, state: 'adopted' });
        await this.#writeRecord(this.#stageDirectory(record.stageId).path, next);
        return Object.freeze({ kind: 'marked' as const, payloadRef });
      });
    } catch (error) {
      throw guardedError(error, 'invalid_descriptor_auth');
    }
  }

  async purge(input: {
    readonly candidate: PayloadStageReconciliationCandidate;
    readonly proof: UnadoptedStageProof;
  }): Promise<PayloadStagePurgeResult> {
    try {
      const candidate = this.#normalizeCandidate(input.candidate);
      const target = this.#stageDirectory(candidate.stageId);
      if (!existsSync(target.path)) {
        if (await this.#finishNoncanonicalPurgeForStage(target.stageId)) {
          return Object.freeze({ kind: 'purged', stageId: candidate.stageId });
        }
        throw stageError('stage_not_found');
      }
      const lock = await this.#acquireStageLock(target.path, target.stageId, { operation: 'purge' });
      let movedTo: string | undefined;
      let moved = false;
      let quarantineNonce: string | undefined;
      try {
        const record = await this.#loadRecordAt(target.path, candidate.stageId);
        this.#assertCurrent(record, Number(candidate.expectedVersion), Number(candidate.fence));
        if (!exactPolicy(record.reconciliationPolicy, candidate.reconciliationPolicy)) {
          throw stageError('proof_mismatch');
        }
        if (record.state !== 'staged') throw stageError('stage_not_purgeable');
        let marker: StoredStagePurgeMarkerEnvelope;
        if (existsSync(join(target.path, purgeMarkerFileName))) {
          marker = await this.#readAuthenticatedPurgeMarker(target.path, target.stageId, undefined, record);
        } else {
          const verification = await this.#purgeProofVerifier.verifyAndConsume({
            candidate: this.#candidate(record),
            proof: input.proof
          });
          if (verification.kind === 'adopted') throw stageError('canonical_stage_adopted');
          if (verification.kind === 'uncertain') {
            throw stageError('canonical_stage_ownership_uncertain');
          }
          marker = await this.#writePurgeMarker(target.path, record, lock.nonce);
        }
        marker = await this.#readAuthenticatedPurgeMarker(
          target.path,
          target.stageId,
          marker.marker.quarantineNonce,
          record
        );
        quarantineNonce = marker.marker.quarantineNonce;
        movedTo = this.#purgedDirectory(target.stageId, quarantineNonce);
        if (existsSync(movedTo)) throw stageError('invalid_descriptor_auth');
        renameSync(target.path, movedTo);
        moved = true;
        safeFsyncDirectory(this.#stageRoot);
      } finally {
        await lock.release(moved && movedTo ? movedTo : target.path);
      }
      if (!movedTo || !quarantineNonce) throw stageError('invalid_descriptor_auth');
      // Cleanup is a restartable phase after the durable quarantine boundary. Yield
      // once so cancellation or process termination cannot be mistaken for an atomic
      // continuation of the proof-consuming step.
      await wait(2);
      await this.#finishPurgedDirectory(movedTo, target.stageId, quarantineNonce);
      await this.#finishPurgeCleaningDirectory(
        this.#purgeCleaningDirectory(target.stageId, quarantineNonce),
        target.stageId,
        quarantineNonce
      );
      if (existsSync(movedTo)
        || existsSync(this.#purgeCleaningDirectory(target.stageId, quarantineNonce))) {
        throw stageError('invalid_descriptor_auth');
      }
      return Object.freeze({ kind: 'purged', stageId: candidate.stageId });
    } catch (error) {
      throw guardedError(error, 'invalid_descriptor_auth');
    }
  }

  async listReconciliationCandidates(input: {
    readonly cursor?: StageReconciliationCursor;
    readonly limit: number;
  }): Promise<PayloadStageReconciliationPage> {
    try {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > maximumPageSize) {
        throw stageError('invalid_limit');
      }
      const records = await this.#records();
      let after: string | undefined;
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== 'string' || !/^c1_[0-9a-f]{64}$/.test(input.cursor)) {
          throw stageError('invalid_cursor');
        }
        for (const record of records) {
          if (await this.#cursorFor(record) === input.cursor) {
            after = record.stageId;
            break;
          }
        }
        if (!after) throw stageError('invalid_cursor');
      }
      const eligible = records.filter((record) =>
        record.state !== 'adopted' && (after === undefined || record.stageId > after)
      );
      const selected = eligible.slice(0, input.limit);
      const hasMore = eligible.length > selected.length;
      const last = selected.at(-1);
      return Object.freeze({
        candidates: Object.freeze(selected.map((record) => this.#candidate(record))),
        ...(hasMore && last ? { nextCursor: await this.#cursorFor(last) } : {})
      });
    } catch (error) {
      throw guardedError(error, 'invalid_cursor');
    }
  }

  #normalizeCandidate(candidate: PayloadStageReconciliationCandidate): PayloadStageReconciliationCandidate {
    if (!isPlainRecord(candidate)
      || !hasExactKeys(candidate, ['expectedVersion', 'expiresAt', 'fence', 'reconciliationPolicy', 'stageId'])) {
      throw stageError('invalid_descriptor_auth');
    }
    try {
      return Object.freeze({
        stageId: normalizeStageId(candidate.stageId),
        expectedVersion: parseAggregateVersion(Number(candidate.expectedVersion)),
        fence: createPayloadStageFence(Number(candidate.fence)),
        expiresAt: parseInstant(candidate.expiresAt),
        reconciliationPolicy: parsePolicy(candidate.reconciliationPolicy)
      });
    } catch (error) {
      if (error instanceof ClassifiedPayloadStageError) throw error;
      throw stageError('invalid_descriptor_auth');
    }
  }

}
