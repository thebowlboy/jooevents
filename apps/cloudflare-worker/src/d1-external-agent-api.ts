import {
  getCompiledReadOperation,
  resolveOperatorAuthorityPermissionRequirement,
  type ApplicationOperationRuntime,
  type OperatorAuthorityPolicyCatalog
} from '@jooevents/application';
import {
  API_KEY_EXPIRES_SOON_DAYS,
  externalAgentMeResponseSchema,
  externalAgentToolsResponseSchema,
  operationTransportErrorSchema,
  type ExternalAgentAvailability
} from '@jooevents/contracts';
import {
  DEFAULT_EXTERNAL_AGENT_API_POLICY,
  EXTERNAL_AGENT_CONDUCT,
  EXTERNAL_AGENT_DISCOVERY_LINK,
  EXTERNAL_AGENT_UPCOMING,
  externalAgentToolCatalogProjection,
  externalAgentToolGuidance,
  type ExternalAgentApiPolicy
} from '@jooevents/http-operation-adapters';
import { canonicalJsonSha256, parseWorkspaceId, type WorkspaceId } from '@jooevents/kernel';
import { createMcpToolRegistry, type McpToolDefinition } from '@jooevents/mcp';
import { z } from 'zod';
import {
  authenticateD1ExternalAgentRead,
  type D1ExternalAgentReadAuthentication
} from './d1-external-agent-auth';
import { consumeD1ExternalApiRateLimit } from './d1-external-agent-discovery';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const BURST_WINDOW_MS = 10_000;
const EXPIRES_SOON_MS = API_KEY_EXPIRES_SOON_DAYS * DAY_MS;

interface PendingCountRow {
  readonly awaiting_approval: number;
  readonly needs_attention: number;
}

function correlationId(request: Request): string {
  const candidate = request.headers.get('x-correlation-id');
  return z.uuid().safeParse(candidate).success ? candidate! : crypto.randomUUID();
}

function headers(id: string): Headers {
  return new Headers({
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'x-correlation-id': id,
    'x-content-type-options': 'nosniff',
    link: EXTERNAL_AGENT_DISCOVERY_LINK
  });
}

function errorResponse(input: {
  readonly id: string;
  readonly code: 'invalid_request' | 'unauthenticated' | 'forbidden' | 'rate_limited' | 'internal_error';
  readonly status: 400 | 401 | 403 | 429 | 500;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
}): Response {
  const responseHeaders = headers(input.id);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  if (input.retryAfterSeconds !== undefined) {
    responseHeaders.set('retry-after', String(input.retryAfterSeconds));
  }
  return new Response(JSON.stringify(operationTransportErrorSchema.parse({
    kind: 'transport_error',
    code: input.code,
    retryable: input.retryable ?? false,
    correlationId: input.id
  })), { status: input.status, headers: responseHeaders });
}

function json(id: string, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  const responseHeaders = headers(id);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(extraHeaders)) responseHeaders.set(name, value);
  return new Response(JSON.stringify(body), { status: 200, headers: responseHeaders });
}

function ipScope(request: Request): string {
  const address = request.headers.get('cf-connecting-ip') ?? 'unavailable';
  return `ip:${canonicalJsonSha256(address)}`;
}

function availability(input: {
  readonly auth: Extract<D1ExternalAgentReadAuthentication, { readonly kind: 'verified' }>;
  readonly operations: ApplicationOperationRuntime;
  readonly policies: OperatorAuthorityPolicyCatalog;
  readonly tool: McpToolDefinition;
}): ExternalAgentAvailability {
  const compiled = getCompiledReadOperation(
    input.operations.registry,
    input.tool.contract.operation.name,
    input.tool.contract.operation.version,
    'external_mcp'
  );
  const lane = compiled?.operation.definition.accessLanes.find((candidate) =>
    candidate.kind === 'external_mcp' && candidate.surface === 'external_mcp'
  );
  if (!compiled || !lane) return Object.freeze({
    state: 'locked_owner' as const,
    permissionIds: ['event.read'],
    note: 'The operation policy is not available in this workspace.'
  });
  const scope = Object.freeze({
    workspaceId: input.auth.key.workspaceId,
    ...(input.auth.currentEventId === undefined ? {} : { eventId: input.auth.currentEventId }),
    subjects: Object.freeze([
      Object.freeze({ kind: 'workspace' as const, id: input.auth.key.workspaceId }),
      ...(input.auth.currentEventId === undefined
        ? []
        : [Object.freeze({ kind: 'event' as const, id: input.auth.currentEventId })])
    ]),
    resolutionEvidenceIds: Object.freeze(['external-tool-catalog.current'])
  });
  const requirement = resolveOperatorAuthorityPermissionRequirement({
    catalog: input.policies,
    policy: lane.policy,
    scope
  });
  if (!requirement) return Object.freeze({
    state: 'locked_owner' as const,
    permissionIds: ['event.read'],
    note: 'The owner cannot reach this tool in the current scope.'
  });
  if (input.auth.key.eventIds.length > 0
      && (input.auth.currentEventId === undefined
        || !input.auth.key.eventIds.includes(input.auth.currentEventId))) {
    return Object.freeze({
      state: 'locked_scope' as const,
      permissionIds: [...requirement.permissionIds],
      note: 'This key is not scoped to the current event.',
      humanDoor: '/app/settings/api-keys' as const
    });
  }
  const owner = new Set(input.auth.ownerPermissionIds);
  const ownerAllows = requirement.kind === 'all_of'
    ? requirement.permissionIds.every((permissionId) => owner.has(permissionId))
    : requirement.permissionIds.some((permissionId) => owner.has(permissionId));
  if (!ownerAllows) return Object.freeze({
    state: 'locked_owner' as const,
    permissionIds: [...requirement.permissionIds],
    note: 'The key owner does not currently hold the permission required by this tool.'
  });
  const keyAllows = requirement.kind === 'all_of'
    ? requirement.permissionIds.every((permissionId) => input.auth.key.permissionIds.includes(permissionId))
    : requirement.permissionIds.some((permissionId) => input.auth.key.permissionIds.includes(permissionId));
  return keyAllows
    ? Object.freeze({ state: 'active' as const })
    : Object.freeze({
        state: 'locked_scope' as const,
        permissionIds: [...requirement.permissionIds],
        note: 'This key does not carry the permission required by this tool.',
        humanDoor: '/app/settings/api-keys' as const
      });
}

async function pendingCounts(input: {
  readonly database: D1Database;
  readonly auth: Extract<D1ExternalAgentReadAuthentication, { readonly kind: 'verified' }>;
}): Promise<PendingCountRow> {
  if (!input.auth.key.maySubmitPlans) {
    return Object.freeze({ awaiting_approval: 0, needs_attention: 0 });
  }
  const row = await input.database.withSession('first-primary').prepare(`SELECT
    sum(CASE WHEN batch.status = 'awaiting_approval' THEN 1 ELSE 0 END)
      AS awaiting_approval,
    sum(CASE WHEN batch.status = 'paused' AND EXISTS (
      SELECT 1 FROM agent_action_steps step
      WHERE step.batch_id = batch.id AND step.status = 'needs_attention'
    ) THEN 1 ELSE 0 END) AS needs_attention
    FROM agent_action_batches batch
    WHERE batch.source_surface = 'external_mcp'
      AND batch.source_principal_id = ?
      AND json_extract(batch.plan_json, '$.source.clientKey') = ?`)
    .bind(input.auth.key.ownerUserId, `api-key:${input.auth.key.apiKeyId}`)
    .first<PendingCountRow>();
  const awaitingApproval = row?.awaiting_approval ?? 0;
  const needsAttention = row?.needs_attention ?? 0;
  if (!Number.isSafeInteger(awaitingApproval) || awaitingApproval < 0
      || !Number.isSafeInteger(needsAttention) || needsAttention < 0) {
    throw new TypeError('d1_external_agent_pending_counts_invalid');
  }
  return Object.freeze({
    awaiting_approval: awaitingApproval,
    needs_attention: needsAttention
  });
}

/** Mounts protected standing/catalog reads only; tool execution and plans remain closed. */
export function createD1ExternalAgentApiTransport(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly delegate: { fetch(request: Request): Promise<Response> };
  readonly operations: ApplicationOperationRuntime;
  readonly policies: OperatorAuthorityPolicyCatalog;
  readonly nowMs?: () => number;
  readonly policy?: ExternalAgentApiPolicy;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const nowMs = input.nowMs ?? Date.now;
  const policy = input.policy ?? DEFAULT_EXTERNAL_AGENT_API_POLICY;

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const protectedRead = url.pathname === '/api/v1/me' || url.pathname === '/api/v1/tools';
      if (!protectedRead) return input.delegate.fetch(request);
      const id = correlationId(request);
      if (request.method !== 'GET') return errorResponse({
        id, code: 'invalid_request', status: 400
      });
      try {
        const evaluatedAtMs = nowMs();
        const auth = await authenticateD1ExternalAgentRead({
          database: input.database,
          workspaceId,
          request,
          nowMs: evaluatedAtMs
        });
        if (auth.kind === 'unauthenticated') {
          const threshold = policy.failedAuthPerMinute;
          const attempt = await consumeD1ExternalApiRateLimit({
            database: input.database,
            scopeKey: `failed-auth:${ipScope(request)}`,
            nowMs: evaluatedAtMs,
            windowMs: MINUTE_MS,
            limit: threshold + 6
          });
          if (attempt.kind === 'limited') return errorResponse({
            id, code: 'rate_limited', status: 429, retryable: true,
            retryAfterSeconds: attempt.retryAfterSeconds
          });
          if (attempt.requestCount > threshold) return errorResponse({
            id, code: 'rate_limited', status: 429, retryable: true,
            retryAfterSeconds: Math.min(60, 2 ** (attempt.requestCount - threshold - 1))
          });
          return errorResponse({ id, code: 'unauthenticated', status: 401 });
        }
        if (auth.kind === 'forbidden') {
          return errorResponse({ id, code: 'forbidden', status: 403 });
        }
        for (const limit of [
          { scopeKey: `key-minute:${auth.key.apiKeyId}`, windowMs: MINUTE_MS,
            limit: policy.requestsPerMinute },
          { scopeKey: `key-burst:${auth.key.apiKeyId}`, windowMs: BURST_WINDOW_MS,
            limit: policy.burstPerTenSeconds }
        ]) {
          const result = await consumeD1ExternalApiRateLimit({
            database: input.database,
            nowMs: evaluatedAtMs,
            ...limit
          });
          if (result.kind === 'limited') return errorResponse({
            id, code: 'rate_limited', status: 429, retryable: true,
            retryAfterSeconds: result.retryAfterSeconds
          });
        }

        if (url.pathname === '/api/v1/me') {
          const expiresSoon = auth.key.expiresAt !== null
            && Date.parse(auth.key.expiresAt) > evaluatedAtMs
            && Date.parse(auth.key.expiresAt) - evaluatedAtMs <= EXPIRES_SOON_MS;
          const ownerPermissions = new Set(auth.ownerPermissionIds);
          const dormantPermissionIds = auth.key.permissionIds
            .filter((permissionId) => !ownerPermissions.has(permissionId));
          const counts = await pendingCounts({ database: input.database, auth });
          return json(id, externalAgentMeResponseSchema.parse({
            workspace: { id: auth.key.workspaceId },
            owner: { id: auth.key.ownerUserId, displayName: auth.ownerDisplayName },
            capabilities: {
              read: auth.key.mayRead,
              submitPlans: auth.key.maySubmitPlans
            },
            permissionScopes: auth.key.permissionIds,
            eventScopes: auth.key.eventIds,
            expiresAt: auth.key.expiresAt,
            createdAt: auth.key.createdAt,
            rateLimitClass: 'standard',
            standing: {
              serverTime: new Date(evaluatedAtMs).toISOString(),
              key: { expiresAt: auth.key.expiresAt, expiresSoon },
              warnings: [
                ...(expiresSoon ? [{
                  code: 'key_expires_soon' as const,
                  expiresAt: auth.key.expiresAt,
                  note: `This key expires within ${API_KEY_EXPIRES_SOON_DAYS} days. Rotate it before work is interrupted.`
                }] : []),
                ...(dormantPermissionIds.length > 0 ? [{
                  code: 'scopes_dormant' as const,
                  permissionIds: dormantPermissionIds,
                  note: 'These key scopes are dormant because the owner does not currently hold them.'
                }] : [])
              ],
              limits: {
                requestsPerMinute: policy.requestsPerMinute,
                burstPerTenSeconds: policy.burstPerTenSeconds,
                maximumConcurrency: policy.maximumConcurrency,
                planSubmissionsPerDay: policy.planSubmissionsPerDay,
                maximumOpenPlans: policy.maximumOpenPlans
              },
              pending: {
                ...(auth.key.maySubmitPlans ? {
                  awaitingApproval: counts.awaiting_approval,
                  needsAttention: counts.needs_attention
                } : {}),
                hint: '/api/v1/pending'
              },
              conduct: EXTERNAL_AGENT_CONDUCT
            },
            correlationId: id
          }));
        }

        const tools = await createMcpToolRegistry(
          input.operations.registry.safeManifest,
          { enableCommitTools: false }
        );
        const visible: { readonly tool: McpToolDefinition;
          readonly availability: ExternalAgentAvailability }[] = [];
        const unavailable: { readonly name: string;
          readonly operation: McpToolDefinition['contract']['operation'];
          readonly availability: ExternalAgentAvailability }[] = [];
        for (const tool of tools.tools) {
          const current = availability({
            auth,
            operations: input.operations,
            policies: input.policies,
            tool
          });
          if (current.state === 'active') visible.push({ tool, availability: current });
          else unavailable.push({
            name: tool.name,
            operation: tool.contract.operation,
            availability: current
          });
        }
        return json(id, externalAgentToolsResponseSchema.parse({
          registryDigestSha256: tools.registryDigestSha256,
          tools: visible.map(({ tool, availability: current }) => ({
            ...externalAgentToolCatalogProjection(input.operations, tool),
            availability: current,
            guidance: externalAgentToolGuidance(tool)
          })),
          unavailableTools: unavailable,
          upcoming: EXTERNAL_AGENT_UPCOMING,
          correlationId: id
        }), { etag: `"${tools.registryDigestSha256}"` });
      } catch (error) {
        console.error(JSON.stringify({
          event: 'cloudflare.external_agent.read_failed',
          correlationId: id,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        }));
        return errorResponse({ id, code: 'internal_error', status: 500 });
      }
    }
  });
}
