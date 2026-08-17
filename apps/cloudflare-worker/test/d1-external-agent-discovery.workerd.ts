import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { consumeD1ExternalAgentDiscoveryRateLimit } from
  '../src/d1-external-agent-discovery';

describe('D1 external-agent discovery rate limit', () => {
  test('allows thirty requests, refuses the next, and resets at the fixed window', async () => {
    const scopeKey = `discovery:${'a'.repeat(64)}`;
    for (let request = 1; request <= 30; request += 1) {
      await expect(consumeD1ExternalAgentDiscoveryRateLimit({
        database: env.DB,
        scopeKey,
        nowMs: 1_000
      })).resolves.toEqual({ kind: 'allowed' });
    }
    await expect(consumeD1ExternalAgentDiscoveryRateLimit({
      database: env.DB,
      scopeKey,
      nowMs: 1_000
    })).resolves.toEqual({ kind: 'limited', retryAfterSeconds: 60 });
    await expect(consumeD1ExternalAgentDiscoveryRateLimit({
      database: env.DB,
      scopeKey,
      nowMs: 61_000
    })).resolves.toEqual({ kind: 'allowed' });

    const row = await env.DB.prepare(`SELECT scope_key,request_count,version
      FROM external_api_rate_limit_heads WHERE scope_key=?`).bind(scopeKey).first<{
      readonly scope_key: string;
      readonly request_count: number;
      readonly version: number;
    }>();
    expect(row).toEqual({ scope_key: scopeKey, request_count: 1, version: 32 });
  });
});
