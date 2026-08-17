import type { Database } from 'bun:sqlite';
import {
  apiKeyHashEquals,
  parseNewApiKeyRecord,
  type ApiKeyCredentialResolution,
  type ApiKeyRecord,
  type ApiKeyRevokeReason,
  type ApiKeyStore,
  type NewApiKeyRecord,
  type PermissionId
} from '@jooevents/identity-access';
import {
  parseApiKeyId,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type ApiKeyId,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';

/** Hash-only workspace-scoped external-agent credentials and immutable grant rows. */
export const SQLITE_API_KEYS_SQL = `
CREATE TABLE api_keys (
  api_key_id TEXT PRIMARY KEY CHECK(length(api_key_id) = 36 AND api_key_id = lower(api_key_id)),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  token_hash_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_hash_sha256) = 64 AND token_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  token_hint TEXT NOT NULL CHECK(
    length(token_hint) = 11 AND token_hint GLOB 'jooak1_[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]'
  ),
  may_read INTEGER NOT NULL CHECK(may_read IN (0, 1)),
  may_submit_plans INTEGER NOT NULL CHECK(may_submit_plans IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  last_used_at_ms INTEGER CHECK(last_used_at_ms IS NULL OR last_used_at_ms >= created_at_ms),
  standing TEXT NOT NULL CHECK(standing IN ('active', 'revoked')),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  revoked_by_user_id TEXT REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revoke_reason TEXT CHECK(revoke_reason IS NULL OR revoke_reason IN (
    'rotated', 'owner_request', 'admin_request', 'security'
  )),
  rotation_successor_id TEXT REFERENCES api_keys(api_key_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK(may_read = 1 OR may_submit_plans = 1),
  CHECK((standing = 'active') = (
    revoked_at_ms IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL
  )),
  CHECK(rotation_successor_id IS NULL OR rotation_successor_id <> api_key_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX api_keys_workspace_owner_created
  ON api_keys(workspace_id, owner_user_id, created_at_ms DESC, api_key_id);
CREATE INDEX api_keys_workspace_standing_expiry
  ON api_keys(workspace_id, standing, expires_at_ms, api_key_id);

CREATE TRIGGER api_keys_identity_immutable
BEFORE UPDATE ON api_keys
WHEN NEW.api_key_id IS NOT OLD.api_key_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.display_name IS NOT OLD.display_name
  OR NEW.token_hash_sha256 IS NOT OLD.token_hash_sha256
  OR NEW.token_hint IS NOT OLD.token_hint
  OR NEW.may_read IS NOT OLD.may_read
  OR NEW.may_submit_plans IS NOT OLD.may_submit_plans
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'api key identity is immutable'); END;

CREATE TRIGGER api_keys_transition_guard
BEFORE UPDATE ON api_keys
WHEN NEW.version <> OLD.version + 1
  OR (OLD.expires_at_ms IS NOT NULL AND (
    NEW.expires_at_ms IS NULL OR NEW.expires_at_ms > OLD.expires_at_ms
  ))
  OR NEW.last_used_at_ms < OLD.last_used_at_ms
  OR (OLD.standing = 'revoked' AND (
    NEW.standing IS NOT OLD.standing
    OR NEW.revoked_at_ms IS NOT OLD.revoked_at_ms
    OR NEW.revoked_by_user_id IS NOT OLD.revoked_by_user_id
    OR NEW.revoke_reason IS NOT OLD.revoke_reason
  ))
  OR (OLD.rotation_successor_id IS NOT NULL
    AND NEW.rotation_successor_id IS NOT OLD.rotation_successor_id)
BEGIN SELECT RAISE(ABORT, 'api key transition is invalid'); END;

CREATE TRIGGER api_keys_no_delete
BEFORE DELETE ON api_keys
BEGIN SELECT RAISE(ABORT, 'api keys are retained'); END;

CREATE TABLE api_key_permission_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(api_key_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  permission_id TEXT NOT NULL CHECK(length(permission_id) BETWEEN 1 AND 120),
  PRIMARY KEY(api_key_id, permission_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER api_key_permission_scopes_no_update
BEFORE UPDATE ON api_key_permission_scopes
BEGIN SELECT RAISE(ABORT, 'api key permission scopes are immutable'); END;
CREATE TRIGGER api_key_permission_scopes_no_delete
BEFORE DELETE ON api_key_permission_scopes
BEGIN SELECT RAISE(ABORT, 'api key permission scopes are immutable'); END;

CREATE TABLE api_key_event_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(api_key_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY(api_key_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER api_key_event_scopes_no_update
BEFORE UPDATE ON api_key_event_scopes
BEGIN SELECT RAISE(ABORT, 'api key event scopes are immutable'); END;
CREATE TRIGGER api_key_event_scopes_no_delete
BEFORE DELETE ON api_key_event_scopes
BEGIN SELECT RAISE(ABORT, 'api key event scopes are immutable'); END;
`;

export function installSQLiteApiKeySchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('api_key_schema_inside_transaction');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SQLITE_API_KEYS_SQL);
}

interface ApiKeyRow {
  readonly api_key_id: string;
  readonly workspace_id: string;
  readonly owner_user_id: string;
  readonly display_name: string;
  readonly token_hash_sha256: string;
  readonly token_hint: string;
  readonly may_read: number;
  readonly may_submit_plans: number;
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
  readonly last_used_at_ms: number | null;
  readonly standing: 'active' | 'revoked';
  readonly revoked_at_ms: number | null;
  readonly revoked_by_user_id: string | null;
  readonly revoke_reason: ApiKeyRevokeReason | null;
  readonly rotation_successor_id: string | null;
  readonly version: number;
}

const KEY_SELECT = `SELECT api_key_id, workspace_id, owner_user_id, display_name,
  token_hash_sha256, token_hint, may_read, may_submit_plans, created_at_ms,
  expires_at_ms, last_used_at_ms, standing, revoked_at_ms, revoked_by_user_id,
  revoke_reason, rotation_successor_id, version FROM api_keys`;

function instantMs(value: string): number {
  const parsed = Date.parse(parseInstant(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError('api_key_instant_invalid');
  return parsed;
}

function instant(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export class SQLiteApiKeyStore implements ApiKeyStore {
  constructor(readonly sqlite: Database) {}

  private transaction<Value>(work: () => Value): Value {
    return this.sqlite.inTransaction ? work() : this.sqlite.transaction(work)();
  }

  private permissions(apiKeyId: string): readonly PermissionId[] {
    return Object.freeze(this.sqlite.query<{ permission_id: PermissionId }, [string]>(`
      SELECT permission_id FROM api_key_permission_scopes
       WHERE api_key_id = ? ORDER BY permission_id
    `).all(apiKeyId).map((row) => row.permission_id));
  }

  private events(apiKeyId: string) {
    return Object.freeze(this.sqlite.query<{ event_id: string }, [string]>(`
      SELECT event_id FROM api_key_event_scopes WHERE api_key_id = ? ORDER BY event_id
    `).all(apiKeyId).map((row) => parseEventId(row.event_id)));
  }

  private view(row: ApiKeyRow): ApiKeyRecord {
    return Object.freeze({
      apiKeyId: parseApiKeyId(row.api_key_id),
      workspaceId: parseWorkspaceId(row.workspace_id),
      ownerUserId: parseUserId(row.owner_user_id),
      displayName: row.display_name,
      tokenHashSha256: row.token_hash_sha256,
      tokenHint: row.token_hint,
      mayRead: row.may_read === 1,
      maySubmitPlans: row.may_submit_plans === 1,
      permissionIds: this.permissions(row.api_key_id),
      eventIds: this.events(row.api_key_id),
      createdAt: instant(row.created_at_ms)!,
      expiresAt: instant(row.expires_at_ms),
      lastUsedAt: instant(row.last_used_at_ms),
      standing: row.standing,
      revokedAt: instant(row.revoked_at_ms),
      revokedByUserId: row.revoked_by_user_id === null ? null : parseUserId(row.revoked_by_user_id),
      revokeReason: row.revoke_reason,
      rotationSuccessorId: row.rotation_successor_id === null
        ? null
        : parseApiKeyId(row.rotation_successor_id),
      version: row.version
    });
  }

  private require(apiKeyId: ApiKeyId): ApiKeyRecord {
    const key = this.get(apiKeyId);
    if (!key) throw new TypeError('api_key_missing');
    return key;
  }

  create(candidate: NewApiKeyRecord): ApiKeyRecord {
    const record = parseNewApiKeyRecord(candidate);
    return this.transaction(() => {
      this.sqlite.query(`INSERT INTO api_keys (
        api_key_id, workspace_id, owner_user_id, display_name, token_hash_sha256,
        token_hint, may_read, may_submit_plans, created_at_ms, expires_at_ms,
        standing, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`).run(
        record.apiKeyId,
        record.workspaceId,
        record.ownerUserId,
        record.displayName,
        record.tokenHashSha256,
        record.tokenHint,
        record.mayRead ? 1 : 0,
        record.maySubmitPlans ? 1 : 0,
        instantMs(record.createdAt),
        record.expiresAt === null ? null : instantMs(record.expiresAt)
      );
      const insertPermission = this.sqlite.query(`
        INSERT INTO api_key_permission_scopes(api_key_id, permission_id) VALUES (?, ?)
      `);
      for (const permissionId of record.permissionIds) insertPermission.run(record.apiKeyId, permissionId);
      const insertEvent = this.sqlite.query(`
        INSERT INTO api_key_event_scopes(api_key_id, event_id) VALUES (?, ?)
      `);
      for (const eventId of record.eventIds) insertEvent.run(record.apiKeyId, eventId);
      return this.require(record.apiKeyId);
    });
  }

  resolveByTokenHash(input: {
    readonly tokenHashSha256: string;
    readonly workspaceId: WorkspaceId;
    readonly evaluatedAt: string;
  }): ApiKeyCredentialResolution {
    if (!/^[0-9a-f]{64}$/.test(input.tokenHashSha256)) return Object.freeze({ kind: 'invalid' });
    const row = this.sqlite.query<ApiKeyRow, [string]>(`${KEY_SELECT} WHERE token_hash_sha256 = ?`)
      .get(input.tokenHashSha256);
    if (!row || !apiKeyHashEquals(row.token_hash_sha256, input.tokenHashSha256)) {
      return Object.freeze({ kind: 'invalid' });
    }
    const key = this.view(row);
    if (key.workspaceId !== parseWorkspaceId(input.workspaceId)
        || key.standing !== 'active'
        || (key.expiresAt !== null && Date.parse(key.expiresAt) <= instantMs(input.evaluatedAt))) {
      return Object.freeze({ kind: 'invalid' });
    }
    return Object.freeze({ kind: 'current', key });
  }

  get(apiKeyId: ApiKeyId): ApiKeyRecord | undefined {
    const row = this.sqlite.query<ApiKeyRow, [string]>(`${KEY_SELECT} WHERE api_key_id = ?`)
      .get(parseApiKeyId(apiKeyId));
    return row ? this.view(row) : undefined;
  }

  list(input: { readonly workspaceId: WorkspaceId; readonly ownerUserId?: UserId }): readonly ApiKeyRecord[] {
    const rows = input.ownerUserId === undefined
      ? this.sqlite.query<ApiKeyRow, [string]>(`${KEY_SELECT}
          WHERE workspace_id = ? ORDER BY created_at_ms DESC, api_key_id`).all(parseWorkspaceId(input.workspaceId))
      : this.sqlite.query<ApiKeyRow, [string, string]>(`${KEY_SELECT}
          WHERE workspace_id = ? AND owner_user_id = ? ORDER BY created_at_ms DESC, api_key_id`)
        .all(parseWorkspaceId(input.workspaceId), parseUserId(input.ownerUserId));
    return Object.freeze(rows.map((row) => this.view(row)));
  }

  recordUse(input: { readonly apiKeyId: ApiKeyId; readonly usedAt: string; readonly coalesceWithinMs: number }): void {
    const usedAt = instantMs(input.usedAt);
    if (!Number.isSafeInteger(input.coalesceWithinMs) || input.coalesceWithinMs < 0) {
      throw new TypeError('api_key_use_coalesce_invalid');
    }
    this.sqlite.query(`UPDATE api_keys SET last_used_at_ms = ?, version = version + 1
      WHERE api_key_id = ? AND standing = 'active'
        AND (last_used_at_ms IS NULL OR last_used_at_ms <= ?)`)
      .run(usedAt, parseApiKeyId(input.apiKeyId), usedAt - input.coalesceWithinMs);
  }

  rotate(input: {
    readonly predecessorId: ApiKeyId;
    readonly expectedVersion: number;
    readonly successor: NewApiKeyRecord;
    readonly predecessorExpiresAt: string;
  }): { readonly predecessor: ApiKeyRecord; readonly successor: ApiKeyRecord } {
    return this.transaction(() => {
      const predecessor = this.require(input.predecessorId);
      const successor = parseNewApiKeyRecord(input.successor);
      const predecessorExpiresAt = instantMs(input.predecessorExpiresAt);
      if (predecessor.standing !== 'active'
          || predecessor.version !== input.expectedVersion
          || successor.workspaceId !== predecessor.workspaceId
          || successor.ownerUserId !== predecessor.ownerUserId
          || successor.displayName !== predecessor.displayName
          || successor.mayRead !== predecessor.mayRead
          || successor.maySubmitPlans !== predecessor.maySubmitPlans
          || JSON.stringify(successor.permissionIds) !== JSON.stringify(predecessor.permissionIds)
          || JSON.stringify(successor.eventIds) !== JSON.stringify(predecessor.eventIds)
          || (predecessor.expiresAt !== null
            && predecessorExpiresAt > Date.parse(predecessor.expiresAt))) {
        throw new TypeError('api_key_rotation_stale');
      }
      const created = this.create(successor);
      const changed = this.sqlite.query(`UPDATE api_keys
        SET expires_at_ms = ?, rotation_successor_id = ?, version = version + 1
        WHERE api_key_id = ? AND version = ? AND standing = 'active'`)
        .run(predecessorExpiresAt, created.apiKeyId, predecessor.apiKeyId, input.expectedVersion);
      if (changed.changes !== 1) throw new TypeError('api_key_rotation_stale');
      return Object.freeze({ predecessor: this.require(predecessor.apiKeyId), successor: created });
    });
  }

  revoke(input: {
    readonly apiKeyId: ApiKeyId;
    readonly expectedVersion: number;
    readonly revokedAt: string;
    readonly revokedByUserId: UserId;
    readonly reason: ApiKeyRevokeReason;
  }): ApiKeyRecord {
    const changed = this.sqlite.query(`UPDATE api_keys SET standing = 'revoked',
      revoked_at_ms = ?, revoked_by_user_id = ?, revoke_reason = ?, version = version + 1
      WHERE api_key_id = ? AND version = ? AND standing = 'active'`).run(
      instantMs(input.revokedAt),
      parseUserId(input.revokedByUserId),
      input.reason,
      parseApiKeyId(input.apiKeyId),
      input.expectedVersion
    );
    if (changed.changes !== 1) throw new TypeError('api_key_revocation_stale');
    return this.require(input.apiKeyId);
  }
}
