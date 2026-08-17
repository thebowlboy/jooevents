import type { ApplicationOperationRuntime } from '@jooevents/application';
import { operationTransportErrorSchema } from '@jooevents/contracts';
import {
  EXTERNAL_AGENT_DISCOVERY_LINK,
  createExternalAgentOpenApiDocument,
  externalAgentLlmsText
} from '@jooevents/http-operation-adapters';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import { createMcpToolRegistry } from '@jooevents/mcp';
import { z } from 'zod';

const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 30;

interface RateLimitRow {
  readonly window_started_at_ms: number;
  readonly request_count: number;
}

function correlationId(request: Request): string {
  const candidate = request.headers.get('x-correlation-id');
  return z.uuid().safeParse(candidate).success ? candidate! : crypto.randomUUID();
}

function ipScope(request: Request): string {
  const address = request.headers.get('cf-connecting-ip') ?? 'unavailable';
  return `discovery:${canonicalJsonSha256(address)}`;
}

export async function consumeD1ExternalAgentDiscoveryRateLimit(input: {
  readonly database: D1Database;
  readonly scopeKey: string;
  readonly nowMs: number;
}): Promise<{ readonly kind: 'allowed' } | {
  readonly kind: 'limited';
  readonly retryAfterSeconds: number;
}> {
  const row = await input.database.withSession('first-primary').prepare(`
    INSERT INTO external_api_rate_limit_heads(
      scope_key,window_started_at_ms,window_ms,request_count,version
    ) VALUES (?,?,?,1,1)
    ON CONFLICT(scope_key) DO UPDATE SET
      window_started_at_ms=CASE
        WHEN excluded.window_ms<>external_api_rate_limit_heads.window_ms
          OR excluded.window_started_at_ms>=external_api_rate_limit_heads.window_started_at_ms
            + external_api_rate_limit_heads.window_ms
        THEN excluded.window_started_at_ms
        ELSE external_api_rate_limit_heads.window_started_at_ms END,
      window_ms=excluded.window_ms,
      request_count=CASE
        WHEN excluded.window_ms<>external_api_rate_limit_heads.window_ms
          OR excluded.window_started_at_ms>=external_api_rate_limit_heads.window_started_at_ms
            + external_api_rate_limit_heads.window_ms
        THEN 1
        WHEN external_api_rate_limit_heads.request_count<?
        THEN external_api_rate_limit_heads.request_count+1
        ELSE ? END,
      version=external_api_rate_limit_heads.version+1
    RETURNING window_started_at_ms,request_count
  `).bind(
    input.scopeKey, input.nowMs, WINDOW_MS, REQUEST_LIMIT + 1, REQUEST_LIMIT + 1
  ).first<RateLimitRow>();
  if (!row || !Number.isSafeInteger(row.window_started_at_ms)
      || !Number.isSafeInteger(row.request_count) || row.request_count < 1) {
    throw new TypeError('d1_external_agent_discovery_rate_limit_corrupt');
  }
  if (row.request_count <= REQUEST_LIMIT) return Object.freeze({ kind: 'allowed' as const });
  return Object.freeze({
    kind: 'limited' as const,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((row.window_started_at_ms + WINDOW_MS - input.nowMs) / 1_000)
    )
  });
}

function commonHeaders(input: {
  readonly correlationId: string;
  readonly etag?: string;
}): Headers {
  return new Headers({
    'cache-control': 'public, max-age=0, must-revalidate',
    'x-correlation-id': input.correlationId,
    'x-content-type-options': 'nosniff',
    link: EXTERNAL_AGENT_DISCOVERY_LINK,
    ...(input.etag === undefined ? {} : { etag: input.etag })
  });
}

/** Mounts only public discovery; bearer reads and plans remain separately closed. */
export function createD1ExternalAgentDiscoveryTransport(input: {
  readonly database: D1Database;
  readonly delegate: { fetch(request: Request): Promise<Response> };
  readonly operations: ApplicationOperationRuntime;
  readonly nowMs?: () => number;
}) {
  const nowMs = input.nowMs ?? Date.now;

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const discovery = url.pathname === '/api/v1/openapi.json'
        || url.pathname === '/api/v1/llms.txt';
      if (!discovery) return input.delegate.fetch(request);
      const id = correlationId(request);
      if (request.method !== 'GET') {
        return new Response(JSON.stringify(operationTransportErrorSchema.parse({
          kind: 'transport_error',
          code: 'invalid_request',
          retryable: false,
          correlationId: id
        })), {
          status: 400,
          headers: {
            ...Object.fromEntries(commonHeaders({ correlationId: id })),
            'content-type': 'application/json; charset=utf-8'
          }
        });
      }
      const rate = await consumeD1ExternalAgentDiscoveryRateLimit({
        database: input.database,
        scopeKey: ipScope(request),
        nowMs: nowMs()
      });
      if (rate.kind === 'limited') {
        const headers = commonHeaders({ correlationId: id });
        headers.set('content-type', 'application/json; charset=utf-8');
        headers.set('retry-after', String(rate.retryAfterSeconds));
        return new Response(JSON.stringify(operationTransportErrorSchema.parse({
          kind: 'transport_error',
          code: 'rate_limited',
          retryable: true,
          correlationId: id
        })), { status: 429, headers });
      }
      const tools = await createMcpToolRegistry(
        input.operations.registry.safeManifest,
        { enableCommitTools: false }
      );
      const openapi = createExternalAgentOpenApiDocument({
        operations: input.operations,
        tools
      });
      const openApiEtag = `"${canonicalJsonSha256(JSON.parse(JSON.stringify(openapi)))}"`;
      const llms = url.pathname.endsWith('/llms.txt');
      const body = llms ? externalAgentLlmsText(url.origin) : JSON.stringify(openapi);
      const etag = llms ? `"${canonicalJsonSha256(body)}"` : openApiEtag;
      const headers = commonHeaders({ correlationId: id, etag });
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers });
      }
      headers.set('content-type', llms
        ? 'text/markdown; charset=utf-8'
        : 'application/json; charset=utf-8');
      return new Response(body, { status: 200, headers });
    }
  });
}
