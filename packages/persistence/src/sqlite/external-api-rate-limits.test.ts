import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  installSQLiteExternalApiRateLimitSchema,
  SQLiteExternalApiIdempotencyStore,
  SQLiteExternalApiRateLimiter
} from './external-api-rate-limits';

describe('external API durable limits and idempotency', () => {
  let sqlite: Database;
  beforeEach(() => {
    sqlite = new Database(':memory:', { create: true, strict: true });
    sqlite.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY) STRICT;
      INSERT INTO users VALUES ('user-owner');`);
    installSQLiteExternalApiRateLimitSchema(sqlite);
  });
  afterEach(() => sqlite.close());

  test('persists fixed-window counts and concurrency leases', () => {
    const limiter = new SQLiteExternalApiRateLimiter(sqlite);
    expect(limiter.consume({ scopeKey: 'key-minute:key', now: '2026-08-17T00:00:00.000Z', windowMs: 60_000, limit: 2 }).kind).toBe('allowed');
    expect(limiter.consume({ scopeKey: 'key-minute:key', now: '2026-08-17T00:00:01.000Z', windowMs: 60_000, limit: 2 }).kind).toBe('allowed');
    expect(limiter.consume({ scopeKey: 'key-minute:key', now: '2026-08-17T00:00:02.000Z', windowMs: 60_000, limit: 2 })).toEqual({ kind: 'limited', retryAfterSeconds: 58 });
    expect(limiter.acquireConcurrency({ scopeKey: 'inflight:key', leaseId: '018f0f47-7a86-7d36-8a25-9f86589c7400', now: '2026-08-17T00:00:00.000Z', leaseDurationMs: 5_000, limit: 1 }).kind).toBe('acquired');
    expect(limiter.acquireConcurrency({ scopeKey: 'inflight:key', leaseId: '018f0f47-7a86-7d36-8a25-9f86589c7401', now: '2026-08-17T00:00:01.000Z', leaseDurationMs: 5_000, limit: 1 }).kind).toBe('limited');
    limiter.releaseConcurrency({ scopeKey: 'inflight:key', leaseId: '018f0f47-7a86-7d36-8a25-9f86589c7400' });
    expect(limiter.acquireConcurrency({ scopeKey: 'inflight:key', leaseId: '018f0f47-7a86-7d36-8a25-9f86589c7401', now: '2026-08-17T00:00:01.000Z', leaseDurationMs: 5_000, limit: 1 }).kind).toBe('acquired');
  });

  test('replays by owner and endpoint, conflicts on changed input, and skips new-work quotas on replay', () => {
    const store = new SQLiteExternalApiIdempotencyStore(sqlite);
    let applied = 0;
    let quotaChecks = 0;
    const execute = (requestHashSha256: string) => store.execute({
      ownerUserId: 'user-owner', endpointKey: 'plans.submit', keyVerifierSha256: 'a'.repeat(64),
      requestHashSha256, createdAt: '2026-08-17T00:00:00.000Z',
      beforeApply: () => { quotaChecks += 1; },
      apply: () => ({ applied: ++applied }),
      parse: (value) => value as { applied: number }
    });
    expect(execute('b'.repeat(64))).toEqual({ kind: 'executed', value: { applied: 1 } });
    expect(execute('b'.repeat(64))).toEqual({ kind: 'replayed', value: { applied: 1 } });
    expect(execute('c'.repeat(64))).toEqual({ kind: 'conflict' });
    expect({ applied, quotaChecks }).toEqual({ applied: 1, quotaChecks: 1 });
  });
});
