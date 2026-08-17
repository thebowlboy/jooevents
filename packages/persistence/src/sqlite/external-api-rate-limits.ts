import type { Database } from 'bun:sqlite';
import { parseInstant } from '@jooevents/kernel';

export const SQLITE_EXTERNAL_API_RATE_LIMIT_SQL = `
CREATE TABLE external_api_rate_limit_heads (
  scope_key TEXT PRIMARY KEY CHECK(length(scope_key) BETWEEN 1 AND 200),
  window_started_at_ms INTEGER NOT NULL CHECK(window_started_at_ms BETWEEN 0 AND 8640000000000000),
  window_ms INTEGER NOT NULL CHECK(window_ms BETWEEN 1000 AND 86400000),
  request_count INTEGER NOT NULL CHECK(request_count > 0),
  version INTEGER NOT NULL CHECK(version > 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE external_api_inflight_leases (
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 200),
  lease_id TEXT NOT NULL CHECK(length(lease_id) = 36),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(scope_key, lease_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX external_api_inflight_expiry
  ON external_api_inflight_leases(scope_key, expires_at_ms);

CREATE TABLE external_api_idempotency_receipts (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  endpoint_key TEXT NOT NULL CHECK(length(endpoint_key) BETWEEN 1 AND 120),
  key_verifier_sha256 TEXT NOT NULL CHECK(
    length(key_verifier_sha256) = 64 AND key_verifier_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash_sha256 TEXT NOT NULL CHECK(
    length(request_hash_sha256) = 64 AND request_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json) = 'object'),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(owner_user_id, endpoint_key, key_verifier_sha256)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER external_api_idempotency_receipts_no_update
BEFORE UPDATE ON external_api_idempotency_receipts
BEGIN SELECT RAISE(ABORT, 'external API idempotency receipts are immutable'); END;
CREATE TRIGGER external_api_idempotency_receipts_no_delete
BEFORE DELETE ON external_api_idempotency_receipts
BEGIN SELECT RAISE(ABORT, 'external API idempotency receipts are immutable'); END;
`;

export function installSQLiteExternalApiRateLimitSchema(sqlite: Database): void {
  if (sqlite.inTransaction) throw new TypeError('external_api_rate_limit_schema_inside_transaction');
  sqlite.exec(SQLITE_EXTERNAL_API_RATE_LIMIT_SQL);
}

export type ExternalApiRateLimitResult =
  | { readonly kind: 'allowed'; readonly remaining: number }
  | { readonly kind: 'limited'; readonly retryAfterSeconds: number };

function millis(value: string): number {
  const parsed = Date.parse(parseInstant(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError('external_api_rate_limit_instant_invalid');
  return parsed;
}

function scopeKey(value: string): string {
  if (value.length < 1 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('external_api_rate_limit_scope_invalid');
  }
  return value;
}

export class SQLiteExternalApiRateLimiter {
  constructor(readonly sqlite: Database) {}

  private transaction<Value>(work: () => Value): Value {
    return this.sqlite.inTransaction ? work() : this.sqlite.transaction(work)();
  }

  consume(input: {
    readonly scopeKey: string;
    readonly now: string;
    readonly windowMs: number;
    readonly limit: number;
  }): ExternalApiRateLimitResult {
    if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1_000 || input.windowMs > 86_400_000
        || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000_000) {
      throw new TypeError('external_api_rate_limit_policy_invalid');
    }
    const key = scopeKey(input.scopeKey);
    const now = millis(input.now);
    return this.transaction(() => {
      const row = this.sqlite.query<{
        window_started_at_ms: number;
        window_ms: number;
        request_count: number;
        version: number;
      }, [string]>('SELECT * FROM external_api_rate_limit_heads WHERE scope_key = ?').get(key);
      if (!row || row.window_ms !== input.windowMs || now >= row.window_started_at_ms + row.window_ms) {
        this.sqlite.query(`INSERT INTO external_api_rate_limit_heads(
          scope_key, window_started_at_ms, window_ms, request_count, version
        ) VALUES (?, ?, ?, 1, 1)
        ON CONFLICT(scope_key) DO UPDATE SET window_started_at_ms=excluded.window_started_at_ms,
          window_ms=excluded.window_ms, request_count=1, version=external_api_rate_limit_heads.version+1`)
          .run(key, now, input.windowMs);
        return Object.freeze({ kind: 'allowed' as const, remaining: input.limit - 1 });
      }
      if (row.request_count >= input.limit) {
        return Object.freeze({
          kind: 'limited' as const,
          retryAfterSeconds: Math.max(1, Math.ceil((row.window_started_at_ms + row.window_ms - now) / 1_000))
        });
      }
      this.sqlite.query(`UPDATE external_api_rate_limit_heads
        SET request_count=request_count+1, version=version+1 WHERE scope_key=? AND version=?`)
        .run(key, row.version);
      return Object.freeze({ kind: 'allowed' as const, remaining: input.limit - row.request_count - 1 });
    });
  }

  acquireConcurrency(input: {
    readonly scopeKey: string;
    readonly leaseId: string;
    readonly now: string;
    readonly leaseDurationMs: number;
    readonly limit: number;
  }): { readonly kind: 'acquired' } | { readonly kind: 'limited'; readonly retryAfterSeconds: number } {
    if (!/^[0-9a-f-]{36}$/.test(input.leaseId)
        || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000
        || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new TypeError('external_api_concurrency_policy_invalid');
    }
    const key = scopeKey(input.scopeKey);
    const now = millis(input.now);
    return this.transaction(() => {
      this.sqlite.query('DELETE FROM external_api_inflight_leases WHERE scope_key=? AND expires_at_ms<=?')
        .run(key, now);
      const rows = this.sqlite.query<{ expires_at_ms: number }, [string]>(`
        SELECT expires_at_ms FROM external_api_inflight_leases
         WHERE scope_key=? ORDER BY expires_at_ms
      `).all(key);
      if (rows.length >= input.limit) {
        return Object.freeze({
          kind: 'limited' as const,
          retryAfterSeconds: Math.max(1, Math.ceil(((rows[0]?.expires_at_ms ?? now + 1_000) - now) / 1_000))
        });
      }
      this.sqlite.query(`INSERT INTO external_api_inflight_leases(scope_key,lease_id,expires_at_ms)
        VALUES (?, ?, ?)`).run(key, input.leaseId, now + input.leaseDurationMs);
      return Object.freeze({ kind: 'acquired' as const });
    });
  }

  releaseConcurrency(input: { readonly scopeKey: string; readonly leaseId: string }): void {
    this.sqlite.query('DELETE FROM external_api_inflight_leases WHERE scope_key=? AND lease_id=?')
      .run(scopeKey(input.scopeKey), input.leaseId);
  }
}

export type ExternalApiIdempotentExecution<Value> =
  | { readonly kind: 'executed'; readonly value: Value }
  | { readonly kind: 'replayed'; readonly value: Value }
  | { readonly kind: 'conflict' };

export class SQLiteExternalApiIdempotencyStore {
  constructor(readonly sqlite: Database) {}

  execute<Value>(input: {
    readonly ownerUserId: string;
    readonly endpointKey: string;
    readonly keyVerifierSha256: string;
    readonly requestHashSha256: string;
    readonly createdAt: string;
    /** Runs only after proving this is not a replay or conflict, in the same transaction. */
    readonly beforeApply?: () => void;
    readonly apply: () => Value;
    readonly parse: (value: unknown) => Value;
  }): ExternalApiIdempotentExecution<Value> {
    if (!/^[0-9a-f]{64}$/.test(input.keyVerifierSha256)
        || !/^[0-9a-f]{64}$/.test(input.requestHashSha256)
        || input.endpointKey.length < 1 || input.endpointKey.length > 120) {
      throw new TypeError('external_api_idempotency_identity_invalid');
    }
    const work = () => {
      const existing = this.sqlite.query<{
        request_hash_sha256: string;
        response_json: string;
      }, [string, string, string]>(`SELECT request_hash_sha256,response_json
        FROM external_api_idempotency_receipts
        WHERE owner_user_id=? AND endpoint_key=? AND key_verifier_sha256=?`)
        .get(input.ownerUserId, input.endpointKey, input.keyVerifierSha256);
      if (existing) {
        if (existing.request_hash_sha256 !== input.requestHashSha256) {
          return Object.freeze({ kind: 'conflict' as const });
        }
        return Object.freeze({
          kind: 'replayed' as const,
          value: input.parse(JSON.parse(existing.response_json))
        });
      }
      input.beforeApply?.();
      const value = input.apply();
      const responseJson = JSON.stringify(value);
      if (!responseJson.startsWith('{')) throw new TypeError('external_api_idempotency_response_invalid');
      this.sqlite.query(`INSERT INTO external_api_idempotency_receipts(
        owner_user_id,endpoint_key,key_verifier_sha256,request_hash_sha256,response_json,created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(
        input.ownerUserId,
        input.endpointKey,
        input.keyVerifierSha256,
        input.requestHashSha256,
        responseJson,
        millis(input.createdAt)
      );
      return Object.freeze({ kind: 'executed' as const, value });
    };
    return this.sqlite.inTransaction ? work() : this.sqlite.transaction(work)();
  }
}
