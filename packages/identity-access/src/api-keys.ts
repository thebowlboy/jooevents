import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyId, EventId, UserId, WorkspaceId } from '@jooevents/kernel';
import { parseApiKeyId, parseEventId, parseInstant, parseUserId, parseWorkspaceId } from '@jooevents/kernel';
import { PERMISSIONS, type PermissionId } from './permissions';

const API_KEY_PREFIX = 'jooak1_';
const API_KEY_BODY = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const permissionIds = new Set<string>(PERMISSIONS.map((permission) => permission.id));

export const API_KEY_DEFAULT_TTL_DAYS = 90;
export const API_KEY_DEFAULT_MAX_TTL_DAYS = 365;
export const API_KEY_DEFAULT_ROTATION_GRACE_HOURS = 168;

export type ApiKeyStanding = 'active' | 'revoked';
export type ApiKeyRevokeReason = 'rotated' | 'owner_request' | 'admin_request' | 'security';

export interface ApiKeyPolicy {
  readonly defaultTtlDays: number;
  readonly maximumTtlDays: number;
  readonly rotationGraceHours: number;
}

export const API_KEY_DEFAULT_POLICY: ApiKeyPolicy = Object.freeze({
  defaultTtlDays: API_KEY_DEFAULT_TTL_DAYS,
  maximumTtlDays: API_KEY_DEFAULT_MAX_TTL_DAYS,
  rotationGraceHours: API_KEY_DEFAULT_ROTATION_GRACE_HOURS
});

export function parseApiKeyPolicy(candidate: ApiKeyPolicy): ApiKeyPolicy {
  if (
    !Number.isSafeInteger(candidate.defaultTtlDays)
    || !Number.isSafeInteger(candidate.maximumTtlDays)
    || !Number.isSafeInteger(candidate.rotationGraceHours)
    || candidate.defaultTtlDays < 1
    || candidate.maximumTtlDays < candidate.defaultTtlDays
    || candidate.maximumTtlDays > 3_650
    || candidate.rotationGraceHours < 0
    || candidate.rotationGraceHours > 24 * 90
  ) {
    throw new TypeError('api_key_policy_invalid');
  }
  return Object.freeze({ ...candidate });
}

export interface ApiKeyTokenSource {
  randomBytes(size: number): Uint8Array;
}

const defaultTokenSource: ApiKeyTokenSource = Object.freeze({
  randomBytes(size: number): Uint8Array {
    return new Uint8Array(randomBytes(size));
  }
});

export interface MintedApiKeySecret {
  readonly secret: string;
  readonly tokenHashSha256: string;
  readonly tokenHint: string;
}

export function isWellFormedApiKey(candidate: string): boolean {
  return candidate.startsWith(API_KEY_PREFIX)
    && API_KEY_BODY.test(candidate.slice(API_KEY_PREFIX.length));
}

export function hashApiKey(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function apiKeyHashEquals(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function mintApiKey(source: ApiKeyTokenSource = defaultTokenSource): MintedApiKeySecret {
  const bytes = source.randomBytes(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new TypeError('api_key_random_source_invalid');
  }
  const secret = `${API_KEY_PREFIX}${Buffer.from(bytes).toString('base64url')}`;
  if (!isWellFormedApiKey(secret)) throw new TypeError('api_key_mint_invalid');
  return Object.freeze({
    secret,
    tokenHashSha256: hashApiKey(secret),
    tokenHint: secret.slice(0, API_KEY_PREFIX.length + 4)
  });
}

export interface ApiKeyRecord {
  readonly apiKeyId: ApiKeyId;
  readonly workspaceId: WorkspaceId;
  readonly ownerUserId: UserId;
  readonly displayName: string;
  readonly tokenHashSha256: string;
  readonly tokenHint: string;
  readonly mayRead: boolean;
  readonly maySubmitPlans: boolean;
  readonly permissionIds: readonly PermissionId[];
  /** Empty means every event the owner can currently reach. */
  readonly eventIds: readonly EventId[];
  readonly createdAt: string;
  /** `null` means this key has no time-based expiry. */
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly standing: ApiKeyStanding;
  readonly revokedAt: string | null;
  readonly revokedByUserId: UserId | null;
  readonly revokeReason: ApiKeyRevokeReason | null;
  readonly rotationSuccessorId: ApiKeyId | null;
  readonly version: number;
}

export interface NewApiKeyRecord {
  readonly apiKeyId: ApiKeyId;
  readonly workspaceId: WorkspaceId;
  readonly ownerUserId: UserId;
  readonly displayName: string;
  readonly tokenHashSha256: string;
  readonly tokenHint: string;
  readonly mayRead: boolean;
  readonly maySubmitPlans: boolean;
  readonly permissionIds: readonly PermissionId[];
  readonly eventIds: readonly EventId[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

function canonicalPermissionIds(values: readonly string[]): readonly PermissionId[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > PERMISSIONS.length) {
    throw new TypeError('api_key_permissions_invalid');
  }
  const canonical = [...values].sort();
  if (new Set(canonical).size !== canonical.length
      || canonical.some((permissionId) => !permissionIds.has(permissionId))) {
    throw new TypeError('api_key_permissions_invalid');
  }
  return Object.freeze(canonical as PermissionId[]);
}

function canonicalEventIds(values: readonly EventId[]): readonly EventId[] {
  if (!Array.isArray(values) || values.length > 1_000) throw new TypeError('api_key_events_invalid');
  const canonical = [...values].map(parseEventId).sort();
  if (new Set(canonical).size !== canonical.length) throw new TypeError('api_key_events_invalid');
  return Object.freeze(canonical);
}

export function parseNewApiKeyRecord(candidate: NewApiKeyRecord): NewApiKeyRecord {
  const displayName = candidate.displayName.trim();
  const createdAt = parseInstant(candidate.createdAt);
  const expiresAt = candidate.expiresAt === null ? null : parseInstant(candidate.expiresAt);
  if (displayName.length < 1 || displayName.length > 80) throw new TypeError('api_key_name_invalid');
  if (!SHA256_HEX.test(candidate.tokenHashSha256)) throw new TypeError('api_key_hash_invalid');
  if (!/^jooak1_[A-Za-z0-9_-]{4}$/.test(candidate.tokenHint)) {
    throw new TypeError('api_key_hint_invalid');
  }
  if (!candidate.mayRead && !candidate.maySubmitPlans) throw new TypeError('api_key_capability_invalid');
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new TypeError('api_key_expiry_invalid');
  }
  return Object.freeze({
    apiKeyId: parseApiKeyId(candidate.apiKeyId),
    workspaceId: parseWorkspaceId(candidate.workspaceId),
    ownerUserId: parseUserId(candidate.ownerUserId),
    displayName,
    tokenHashSha256: candidate.tokenHashSha256,
    tokenHint: candidate.tokenHint,
    mayRead: candidate.mayRead,
    maySubmitPlans: candidate.maySubmitPlans,
    permissionIds: canonicalPermissionIds(candidate.permissionIds),
    eventIds: canonicalEventIds(candidate.eventIds),
    createdAt,
    expiresAt
  });
}

export type ApiKeyCredentialResolution =
  | { readonly kind: 'current'; readonly key: ApiKeyRecord }
  | { readonly kind: 'invalid' };

export interface ApiKeyStore {
  create(record: NewApiKeyRecord): ApiKeyRecord;
  resolveByTokenHash(input: {
    readonly tokenHashSha256: string;
    readonly workspaceId: WorkspaceId;
    readonly evaluatedAt: string;
  }): ApiKeyCredentialResolution;
  get(apiKeyId: ApiKeyId): ApiKeyRecord | undefined;
  list(input: { readonly workspaceId: WorkspaceId; readonly ownerUserId?: UserId }): readonly ApiKeyRecord[];
  recordUse(input: { readonly apiKeyId: ApiKeyId; readonly usedAt: string; readonly coalesceWithinMs: number }): void;
  rotate(input: {
    readonly predecessorId: ApiKeyId;
    readonly expectedVersion: number;
    readonly successor: NewApiKeyRecord;
    readonly predecessorExpiresAt: string;
  }): { readonly predecessor: ApiKeyRecord; readonly successor: ApiKeyRecord };
  revoke(input: {
    readonly apiKeyId: ApiKeyId;
    readonly expectedVersion: number;
    readonly revokedAt: string;
    readonly revokedByUserId: UserId;
    readonly reason: ApiKeyRevokeReason;
  }): ApiKeyRecord;
}
