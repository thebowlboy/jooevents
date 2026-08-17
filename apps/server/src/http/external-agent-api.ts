import {
  getCompiledEffectOperation,
  getCompiledReadOperation,
  OperationExecutionError,
  OperationInputError,
  parseAgentActionBatchView,
  type AgentActionPlanSurface,
  type ApplicationOperationRuntime,
  type RegisteredAgentActionEligibility
} from '@jooevents/application';
import {
  API_KEY_EXPIRES_SOON_DAYS,
  agentActionBatchStatusSchema,
  agentActionBatchViewSchema,
  agentActionPlanSchema,
  externalAgentMeResponseSchema,
  externalAgentOutcomeResponseSchema,
  externalAgentPendingResponseSchema,
  externalAgentPlanCancelResponseSchema,
  externalAgentPlanInspectResponseSchema,
  externalAgentPlanOperationsResponseSchema,
  externalAgentPlanPageResponseSchema,
  externalAgentPlanSubmitResponseSchema,
  externalAgentToolsResponseSchema,
  operationHttpIdempotencyKeySchema,
  operationTransportErrorSchema,
  type ExternalAgentAvailability,
  type ExternalAgentGuidance,
  type ExternalAgentPendingAttention,
  type AgentActionBatchStatus,
  type AgentActionBatchView
} from '@jooevents/contracts';
import {
  EXTERNAL_AGENT_CONDUCT,
  EXTERNAL_AGENT_DISCOVERY_LINK,
  EXTERNAL_AGENT_GUIDANCE_V1,
  EXTERNAL_AGENT_UPCOMING,
  DEFAULT_EXTERNAL_AGENT_API_POLICY,
  createExternalAgentOpenApiDocument,
  externalAgentLlmsText,
  externalAgentToolCatalogProjection,
  externalAgentToolGuidance,
  type ExternalAgentApiPolicy
} from '@jooevents/http-operation-adapters';
import type { ApiKeyRecord } from '@jooevents/identity-access';
import { canonicalJsonSha256 } from '@jooevents/kernel';
import {
  assertExternalAgentToolCatalog,
  findMcpTool,
  mapMcpToolCallToInvocation,
  mapOperationResultToMcp,
  McpEnvelopeError,
  type McpToolDefinition,
  type McpToolRegistry
} from '@jooevents/mcp';
import type {
  ExternalApiIdempotentExecution,
  SQLiteExternalApiIdempotencyStore,
  SQLiteExternalApiRateLimiter
} from '@jooevents/persistence/external-api-rate-limits';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiKeyEvidenceResult, ExternalAgentCapability } from '../auth/api-key-evidence';
import { boundedJsonBody } from './effect-operation-adapter';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const BURST_WINDOW_MS = 10_000;
const EXPIRES_SOON_MS = API_KEY_EXPIRES_SOON_DAYS * DAY_MS;

export const GUIDANCE_V1 = EXTERNAL_AGENT_GUIDANCE_V1;
export const EXTERNAL_API_UPCOMING = EXTERNAL_AGENT_UPCOMING;
export { EXTERNAL_AGENT_CONDUCT, externalAgentLlmsText };

export { DEFAULT_EXTERNAL_AGENT_API_POLICY, type ExternalAgentApiPolicy };

type OwnedPlanPage = {
  readonly items: readonly AgentActionBatchView[];
  readonly nextCursor: string | null;
};

export interface ExternalAgentOwnedPlanRepository {
  listOwned(input: {
    readonly sourceSurface: 'external_mcp';
    readonly proposingPrincipalId: string;
    readonly clientKey: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly status?: AgentActionBatchStatus;
  }): OwnedPlanPage;
}

export interface ExternalAgentApiRuntime {
  readonly operations: ApplicationOperationRuntime;
  readonly tools: McpToolRegistry;
  readonly evidence: {
    verify(request: Request, capability: ExternalAgentCapability): ApiKeyEvidenceResult;
  };
  readonly owner: {
    displayName(key: ApiKeyRecord): string;
  };
  readonly rateLimiter: Pick<
    SQLiteExternalApiRateLimiter,
    'consume' | 'acquireConcurrency' | 'releaseConcurrency'
  >;
  readonly idempotency: Pick<SQLiteExternalApiIdempotencyStore, 'execute'>;
  readonly idempotencySealer: {
    seal(raw: string):
      | { readonly verifierSha256: string }
      | Promise<{ readonly verifierSha256: string }>;
  };
  readonly plans: AgentActionPlanSurface;
  readonly planRepository: ExternalAgentOwnedPlanRepository;
  readonly planOperations: readonly RegisteredAgentActionEligibility[];
  readonly now: () => string;
  readonly reviewUrl: (batchId: string) => string;
  readonly clientAddress: (request: Request) => string;
  readonly toolVisible?: (key: ApiKeyRecord, tool: McpToolDefinition) => boolean | Promise<boolean>;
  readonly toolAvailability?: (
    key: ApiKeyRecord,
    tool: McpToolDefinition
  ) => ExternalAgentAvailability | Promise<ExternalAgentAvailability>;
  readonly planOperationVisible?: (
    key: ApiKeyRecord,
    operation: RegisteredAgentActionEligibility,
    scope: AgentActionBatchView['plan']['scope']
  ) => boolean | Promise<boolean>;
  readonly planOperationAvailability?: (
    key: ApiKeyRecord,
    operation: RegisteredAgentActionEligibility,
    scope: AgentActionBatchView['plan']['scope']
  ) => ExternalAgentAvailability | Promise<ExternalAgentAvailability>;
  readonly dormantPermissionIds?: (key: ApiKeyRecord) => readonly string[] | Promise<readonly string[]>;
  readonly pendingAttention?: (
    key: ApiKeyRecord,
    correlationId: string
  ) => readonly ExternalAgentPendingAttention[] | Promise<readonly ExternalAgentPendingAttention[]>;
  readonly policy?: ExternalAgentApiPolicy;
}

function policy(runtime: ExternalAgentApiRuntime): ExternalAgentApiPolicy {
  return runtime.policy ?? DEFAULT_EXTERNAL_AGENT_API_POLICY;
}

function correlationId(context: Context): string {
  const inherited = context.get('correlationId' as never) as unknown;
  if (typeof inherited === 'string' && z.uuid().safeParse(inherited).success) return inherited;
  const incoming = context.req.header('x-correlation-id');
  return z.uuid().safeParse(incoming).success ? incoming! : crypto.randomUUID();
}

function transport(context: Context, code: 'invalid_request' | 'unauthenticated' | 'forbidden' | 'rate_limited' | 'internal_error', status: 400 | 401 | 403 | 429 | 500, retryable = false, retryAfterSeconds?: number) {
  const id = correlationId(context);
  context.header('x-correlation-id', id);
  if (retryAfterSeconds !== undefined) context.header('retry-after', String(retryAfterSeconds));
  return context.json(operationTransportErrorSchema.parse({
    kind: 'transport_error', code, retryable, correlationId: id
  }), status);
}

function requestIpKey(runtime: ExternalAgentApiRuntime, request: Request): string {
  return `ip:${canonicalJsonSha256(runtime.clientAddress(request))}`;
}

function rateLimited(context: Context, result: { readonly kind: string; readonly retryAfterSeconds?: number }) {
  return result.kind === 'limited'
    ? transport(context, 'rate_limited', 429, true, result.retryAfterSeconds ?? 1)
    : undefined;
}

function authenticate(
  context: Context,
  runtime: ExternalAgentApiRuntime,
  capability: ExternalAgentCapability
): ApiKeyEvidenceResult | Response {
  const result = runtime.evidence.verify(context.req.raw, capability);
  if (result.kind === 'rejected') {
    if (result.reason === 'unauthenticated') {
      const failedAuthThreshold = policy(runtime).failedAuthPerMinute;
      const escalationSteps = 6;
      const failed = runtime.rateLimiter.consume({
        scopeKey: `failed-auth:${requestIpKey(runtime, context.req.raw)}`,
        now: runtime.now(),
        windowMs: MINUTE_MS,
        limit: failedAuthThreshold + escalationSteps
      });
      const limited = rateLimited(context, failed);
      if (limited) return limited;
      if (failed.kind !== 'allowed') return transport(context, 'rate_limited', 429, true, 60);
      const attempt = failedAuthThreshold + escalationSteps - failed.remaining;
      if (attempt > failedAuthThreshold) {
        return transport(
          context, 'rate_limited', 429, true,
          Math.min(60, 2 ** (attempt - failedAuthThreshold - 1))
        );
      }
      return transport(context, 'unauthenticated', 401);
    }
    return transport(context, 'forbidden', 403);
  }
  const minute = runtime.rateLimiter.consume({
    scopeKey: `key-minute:${result.key.apiKeyId}`,
    now: runtime.now(),
    windowMs: MINUTE_MS,
    limit: policy(runtime).requestsPerMinute
  });
  const minuteLimited = rateLimited(context, minute);
  if (minuteLimited) return minuteLimited;
  const burst = runtime.rateLimiter.consume({
    scopeKey: `key-burst:${result.key.apiKeyId}`,
    now: runtime.now(),
    windowMs: BURST_WINDOW_MS,
    limit: policy(runtime).burstPerTenSeconds
  });
  return rateLimited(context, burst) ?? result;
}

async function withConcurrency(
  context: Context,
  runtime: ExternalAgentApiRuntime,
  key: ApiKeyRecord,
  work: () => Promise<Response>
): Promise<Response> {
  const leaseId = crypto.randomUUID();
  const scopeKey = `key-inflight:${key.apiKeyId}`;
  const acquired = runtime.rateLimiter.acquireConcurrency({
    scopeKey,
    leaseId,
    now: runtime.now(),
    leaseDurationMs: 120_000,
    limit: policy(runtime).maximumConcurrency
  });
  const limited = rateLimited(context, acquired);
  if (limited) return limited;
  try { return await work(); }
  finally { runtime.rateLimiter.releaseConcurrency({ scopeKey, leaseId }); }
}

function toolSchemas(runtime: ExternalAgentApiRuntime, tool: McpToolDefinition) {
  const compiled = getCompiledReadOperation(
    runtime.operations.registry,
    tool.contract.operation.name,
    tool.contract.operation.version,
    'external_mcp'
  );
  if (!compiled) throw new TypeError('external_agent_tool_binding_missing');
  return {
    input: Object.freeze({
      reference: compiled.operation.inputSchema.reference,
      parse: (value: unknown) => {
        const parsed = compiled.operation.inputSchema.schema.safeParse(value);
        if (!parsed.success) throw new OperationInputError();
        return parsed.data;
      }
    }),
    output: Object.freeze({
      reference: compiled.binding.projectedResultSchema.reference,
      parse: (value: unknown) => {
        const parsed = compiled.binding.projectedResultSchema.schema.safeParse(value);
        if (!parsed.success) throw new TypeError('external_agent_tool_result_invalid');
        return parsed.data;
      }
    })
  };
}

function registeredJsonSchema(registration: {
  readonly jsonSchema?: unknown;
}): unknown {
  const candidate = registration.jsonSchema;
  if (candidate === undefined) return {};
  if (candidate !== null && typeof candidate === 'object' && '_zod' in candidate) {
    return jsonSchema(candidate as z.ZodType);
  }
  return candidate;
}

function jsonSchema(schema: z.ZodType): unknown {
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any'
  }))) as unknown;
}

function operationInputJsonSchema(runtime: ExternalAgentApiRuntime, operationName: string, version: number): unknown {
  const manifest = runtime.operations.registry.safeManifest.operations.find((entry) =>
    entry.name === operationName && entry.version === version
  );
  const surface = manifest?.enabledBindings[0]?.surface;
  if (!manifest || !surface || manifest.effect === 'read') return {};
  const compiled = getCompiledEffectOperation(runtime.operations.registry, operationName, version, surface);
  return compiled ? registeredJsonSchema(compiled.operation.inputSchema) : {};
}

function planGuidance(operation: RegisteredAgentActionEligibility): ExternalAgentGuidance {
  const key = operation.maxRisk === 'consequential' || operation.externalEffect === 'reconcilable'
    ? 'plan_consequential_reconcilable'
    : 'plan_routine_none';
  return Object.freeze({ key, message: GUIDANCE_V1[key] });
}

async function rawToolAvailability(
  runtime: ExternalAgentApiRuntime,
  key: ApiKeyRecord,
  tool: McpToolDefinition
): Promise<ExternalAgentAvailability> {
  if (runtime.toolAvailability) return runtime.toolAvailability(key, tool);
  if (runtime.toolVisible && !(await runtime.toolVisible(key, tool))) {
    return Object.freeze({
      state: 'locked_scope',
      permissionIds: [...key.permissionIds],
      note: 'This key does not currently carry the permission required by this tool.',
      humanDoor: '/app/settings/api-keys'
    });
  }
  return Object.freeze({ state: 'active' });
}

async function guardWorkspaceDisclosure(
  runtime: ExternalAgentApiRuntime,
  key: ApiKeyRecord,
  availability: ExternalAgentAvailability
): Promise<ExternalAgentAvailability> {
  if (availability.state !== 'locked_workspace') return availability;
  const watchTool = findMcpTool(runtime.tools, availability.watch.tool);
  if (!watchTool) throw new TypeError('external_agent_workspace_watch_tool_missing');
  const watchAvailability = await rawToolAvailability(runtime, key, watchTool);
  if (watchAvailability.state === 'active') return availability;
  if (watchAvailability.state !== 'locked_scope' && watchAvailability.state !== 'locked_owner') {
    throw new TypeError('external_agent_workspace_watch_availability_invalid');
  }
  return Object.freeze({
    state: 'locked_scope' as const,
    permissionIds: [...watchAvailability.permissionIds],
    note: `This key cannot inspect ${availability.watch.tool}, so the workspace condition is withheld.`,
    humanDoor: '/app/settings/api-keys' as const
  });
}

async function toolAvailability(
  runtime: ExternalAgentApiRuntime,
  key: ApiKeyRecord,
  tool: McpToolDefinition
): Promise<ExternalAgentAvailability> {
  return guardWorkspaceDisclosure(runtime, key, await rawToolAvailability(runtime, key, tool));
}

async function planAvailability(
  runtime: ExternalAgentApiRuntime,
  key: ApiKeyRecord,
  operation: RegisteredAgentActionEligibility,
  scope: AgentActionBatchView['plan']['scope']
): Promise<ExternalAgentAvailability> {
  if (runtime.planOperationAvailability) {
    return guardWorkspaceDisclosure(
      runtime, key, await runtime.planOperationAvailability(key, operation, scope)
    );
  }
  if (runtime.planOperationVisible && !(await runtime.planOperationVisible(key, operation, scope))) {
    return Object.freeze({
      state: 'locked_scope',
      permissionIds: [...key.permissionIds],
      note: 'This key does not currently carry the permission required by this operation.',
      humanDoor: '/app/settings/api-keys'
    });
  }
  return Object.freeze({ state: 'active' });
}

function owned(runtime: ExternalAgentApiRuntime, key: ApiKeyRecord, batchId: string): AgentActionBatchView | undefined {
  const view = runtime.plans.inspect(batchId);
  return view
    && view.plan.source.surface === 'external_mcp'
    && view.plan.source.proposingPrincipalId === key.ownerUserId
    && view.plan.source.clientKey === `api-key:${key.apiKeyId}`
    ? view
    : undefined;
}

function outcome(context: Context, classification: 'quota_exceeded' | 'idempotency_conflict' | 'access_denied', kind: string, detail: unknown) {
  return context.json(externalAgentOutcomeResponseSchema.parse({
    kind: 'outcome',
    outcome: {
      class: classification,
      kind,
      retryable: false,
      subjects: [],
      detail,
      detailSchemaVersion: 1
    },
    correlationId: correlationId(context)
  }));
}

async function idempotent<Value>(input: {
  readonly context: Context;
  readonly runtime: ExternalAgentApiRuntime;
  readonly key: ApiKeyRecord;
  readonly endpointKey: string;
  readonly requestBody: unknown;
  readonly beforeApply?: () => void;
  readonly apply: () => Value;
  readonly parse: (value: unknown) => Value;
}): Promise<ExternalApiIdempotentExecution<Value> | Response> {
  const raw = input.context.req.header('idempotency-key');
  const parsed = operationHttpIdempotencyKeySchema.safeParse(raw);
  if (!parsed.success) return transport(input.context, 'invalid_request', 400);
  const sealed = await input.runtime.idempotencySealer.seal(parsed.data);
  return input.runtime.idempotency.execute({
    ownerUserId: input.key.ownerUserId,
    endpointKey: input.endpointKey,
    keyVerifierSha256: sealed.verifierSha256,
    requestHashSha256: canonicalJsonSha256(input.requestBody),
    createdAt: input.runtime.now(),
    ...(input.beforeApply === undefined ? {} : { beforeApply: input.beforeApply }),
    apply: input.apply,
    parse: input.parse
  });
}

class PlanSubmissionQuotaError extends Error {
  constructor(
    readonly quota: 'open' | 'daily',
    readonly current: number,
    readonly maximum: number,
    readonly retryAfterSeconds?: number
  ) {
    super(`external_agent_plan_${quota}_quota`);
  }
}

/** Mounts the bearer-only external-agent contract; no cookie/session reader is reachable here. */
export function createExternalAgentApi(runtime: ExternalAgentApiRuntime) {
  assertExternalAgentToolCatalog(runtime.tools);
  const app = new Hono();
  const openapi = createExternalAgentOpenApiDocument({
    operations: runtime.operations,
    tools: runtime.tools
  });
  const openApiDigestSha256 = canonicalJsonSha256(JSON.parse(JSON.stringify(openapi)));

  app.use('/api/v1/*', async (context, next) => {
    const publicDescription = context.req.path === '/api/v1/openapi.json'
      || context.req.path === '/api/v1/llms.txt';
    context.header('cache-control', publicDescription
      ? 'public, max-age=0, must-revalidate'
      : 'no-store, max-age=0');
    if (!publicDescription) context.header('pragma', 'no-cache');
    context.header('x-correlation-id', correlationId(context));
    context.header('link', EXTERNAL_AGENT_DISCOVERY_LINK);
    await next();
  });

  app.get('/api/v1/openapi.json', (context) => {
    const limit = runtime.rateLimiter.consume({
      scopeKey: `discovery:${requestIpKey(runtime, context.req.raw)}`,
      now: runtime.now(), windowMs: MINUTE_MS, limit: policy(runtime).openapiPerMinute
    });
    const limited = rateLimited(context, limit);
    if (limited) return limited;
    context.header('etag', `"${openApiDigestSha256}"`);
    return context.json(openapi);
  });

  app.get('/api/v1/llms.txt', (context) => {
    const limit = runtime.rateLimiter.consume({
      scopeKey: `discovery:${requestIpKey(runtime, context.req.raw)}`,
      now: runtime.now(), windowMs: MINUTE_MS, limit: policy(runtime).openapiPerMinute
    });
    const limited = rateLimited(context, limit);
    if (limited) return limited;
    const manifest = externalAgentLlmsText(new URL(context.req.url).origin);
    context.header('etag', `"${canonicalJsonSha256(manifest)}"`);
    return context.body(manifest, 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });

  app.get('/api/v1/me', async (context) => {
    const auth = authenticate(context, runtime, 'read');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    const key = auth.key;
    const serverTime = runtime.now();
    const expiresSoon = key.expiresAt !== null
      && Date.parse(key.expiresAt) > Date.parse(serverTime)
      && Date.parse(key.expiresAt) - Date.parse(serverTime) <= EXPIRES_SOON_MS;
    const dormantPermissionIds = [...new Set(
      runtime.dormantPermissionIds ? await runtime.dormantPermissionIds(key) : []
    )].sort();
    const warnings = [
      ...(expiresSoon ? [{
        code: 'key_expires_soon' as const,
        expiresAt: key.expiresAt,
        note: `This key expires within ${API_KEY_EXPIRES_SOON_DAYS} days. Rotate it before work is interrupted.`
      }] : []),
      ...(dormantPermissionIds.length > 0 ? [{
        code: 'scopes_dormant' as const,
        permissionIds: dormantPermissionIds,
        note: 'These key scopes are dormant because the owner does not currently hold them.'
      }] : [])
    ];
    const pending = key.maySubmitPlans
      ? runtime.planRepository.listOwned({
          sourceSurface: 'external_mcp', proposingPrincipalId: key.ownerUserId,
          clientKey: `api-key:${key.apiKeyId}`, limit: 100
        }).items
      : [];
    return context.json(externalAgentMeResponseSchema.parse({
      workspace: { id: key.workspaceId },
      owner: { id: key.ownerUserId, displayName: runtime.owner.displayName(key) },
      capabilities: { read: key.mayRead, submitPlans: key.maySubmitPlans },
      permissionScopes: key.permissionIds,
      eventScopes: key.eventIds,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      rateLimitClass: 'standard',
      standing: {
        serverTime,
        key: { expiresAt: key.expiresAt, expiresSoon },
        warnings,
        limits: {
          requestsPerMinute: policy(runtime).requestsPerMinute,
          burstPerTenSeconds: policy(runtime).burstPerTenSeconds,
          maximumConcurrency: policy(runtime).maximumConcurrency,
          planSubmissionsPerDay: policy(runtime).planSubmissionsPerDay,
          maximumOpenPlans: policy(runtime).maximumOpenPlans
        },
        pending: {
          ...(key.maySubmitPlans ? {
            awaitingApproval: pending.filter((plan) => plan.status === 'awaiting_approval').length,
            needsAttention: pending.filter((plan) => plan.status === 'paused'
              && plan.steps.some((step) => step.status === 'needs_attention')).length
          } : {}),
          hint: '/api/v1/pending'
        },
        conduct: EXTERNAL_AGENT_CONDUCT
      },
      correlationId: correlationId(context)
    }));
  });

  app.get('/api/v1/pending', async (context) => {
    const auth = authenticate(context, runtime, 'read');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    const nowMs = Date.parse(runtime.now());
    const terminal = new Set<AgentActionBatchStatus>(['rejected', 'cancelled', 'failed', 'succeeded']);
    const ownedPlans = auth.key.maySubmitPlans
      ? runtime.planRepository.listOwned({
          sourceSurface: 'external_mcp', proposingPrincipalId: auth.key.ownerUserId,
          clientKey: `api-key:${auth.key.apiKeyId}`, limit: 100
        }).items.filter((view) => !terminal.has(view.status))
      : [];
    const plans = ownedPlans.map((view) => {
      const current = view.steps.find((step) => step.ordinal === view.currentOrdinal);
      return {
        batchId: view.plan.batchId,
        status: view.status,
        ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(view.createdAt)) / 1_000)),
        progress: {
          completed: view.steps.filter((step) => step.status === 'succeeded').length,
          total: view.steps.length
        },
        reviewUrl: runtime.reviewUrl(view.plan.batchId),
        ...(current ? { currentStep: {
          ordinal: current.ordinal,
          status: current.status,
          ...(current.lastSafeOutcome === null ? {} : { lastSafeOutcome: current.lastSafeOutcome })
        } } : {}),
        ...(view.status === 'paused' || current?.status === 'needs_attention'
          ? { note: 'Completed steps remain applied. Inspect the step outcome and submit a successor plan, or cancel the remainder.' }
          : {})
      };
    });
    const id = correlationId(context);
    const attention = runtime.pendingAttention ? await runtime.pendingAttention(auth.key, id) : [];
    return context.json(externalAgentPendingResponseSchema.parse({
      ...(auth.key.maySubmitPlans ? { plans } : {}), attention, correlationId: id
    }));
  });

  app.get('/api/v1/tools', async (context) => {
    const auth = authenticate(context, runtime, 'read');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    const visible: { readonly tool: McpToolDefinition; readonly availability: ExternalAgentAvailability }[] = [];
    const unavailable: { readonly name: string; readonly operation: McpToolDefinition['contract']['operation']; readonly availability: ExternalAgentAvailability }[] = [];
    for (const tool of runtime.tools.tools) {
      const availability = await toolAvailability(runtime, auth.key, tool);
      if (availability.state === 'active') visible.push({ tool, availability });
      else unavailable.push({ name: tool.name, operation: tool.contract.operation, availability });
    }
    context.header('etag', `"${runtime.tools.registryDigestSha256}"`);
    return context.json(externalAgentToolsResponseSchema.parse({
      registryDigestSha256: runtime.tools.registryDigestSha256,
      tools: visible.map(({ tool, availability }) => ({
        ...externalAgentToolCatalogProjection(runtime.operations, tool),
        availability,
        guidance: externalAgentToolGuidance(tool)
      })),
      unavailableTools: unavailable,
      upcoming: EXTERNAL_API_UPCOMING,
      correlationId: correlationId(context)
    }));
  });

  app.post('/api/v1/tools/:toolName', async (context) => {
    if (context.req.header('idempotency-key') !== undefined) return transport(context, 'invalid_request', 400);
    const auth = authenticate(context, runtime, 'read');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    const executeTool = async (): Promise<Response> => {
      try {
        const toolName = context.req.param('toolName');
        const tool = findMcpTool(runtime.tools, toolName);
        if (!tool || tool.contract.effect !== 'read') return transport(context, 'invalid_request', 400);
        const availability = await toolAvailability(runtime, auth.key, tool);
        if (availability.state !== 'active') {
          return outcome(context, 'access_denied', 'external_tool.unavailable', {
            toolName, availability
          });
        }
        const body = await boundedJsonBody(context.req.raw);
        const argumentsOnly = z.strictObject({ arguments: z.unknown() }).parse(body);
        const schemas = toolSchemas(runtime, tool);
        const invocation = mapMcpToolCallToInvocation(runtime.tools, {
          toolName,
          arguments: argumentsOnly.arguments
        }, schemas.input);
        const result = await runtime.operations.readExecutor.execute({
          operationName: invocation.operation.name,
          operationVersion: invocation.operation.version,
          surface: 'external_mcp',
          correlationId: correlationId(context),
          businessInput: invocation.businessInput,
          verifiedEvidence: auth.evidence
        });
        const mapped = mapOperationResultToMcp(runtime.tools, invocation, result, schemas.output);
        return context.json(mapped.structuredContent);
      } catch (error) {
        if (error instanceof McpEnvelopeError || error instanceof OperationInputError || error instanceof SyntaxError) {
          return transport(context, 'invalid_request', 400);
        }
        return transport(context, 'internal_error', 500, error instanceof OperationExecutionError);
      }
    };
    return withConcurrency(context, runtime, auth.key, executeTool);
  });

  app.get('/api/v1/plan-operations', async (context) => {
    const auth = authenticate(context, runtime, 'submit_plans');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    const currentEventScope = {
      workspaceId: auth.key.workspaceId,
      ...(auth.key.eventIds.length === 1 ? { eventId: auth.key.eventIds[0] } : {}),
      subjects: [
        { type: 'workspace', id: auth.key.workspaceId },
        ...(auth.key.eventIds.length === 1
          ? [{ type: 'event', id: auth.key.eventIds[0]! }]
          : [])
      ]
    };
    const operations = await Promise.all(runtime.planOperations.map(async (entry) => ({
      entry,
      availability: await planAvailability(runtime, auth.key, entry, currentEventScope)
    })));
    return context.json(externalAgentPlanOperationsResponseSchema.parse({
      registryDigestSha256: runtime.operations.registry.manifestDigestSha256,
      operations: operations.map(({ entry, availability }) => ({
        name: entry.operationName,
        version: entry.operationVersion,
        contractDigestSha256: entry.contractDigestSha256,
        inputSchema: operationInputJsonSchema(runtime, entry.operationName, entry.operationVersion),
        displayLabel: entry.displayLabel,
        consequences: entry.consequences,
        externalEffect: entry.externalEffect,
        availability,
        guidance: planGuidance(entry)
      })),
      correlationId: correlationId(context)
    }));
  });

  app.post('/api/v1/plans', async (context) => {
    const auth = authenticate(context, runtime, 'submit_plans');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    let body: unknown;
    try { body = await boundedJsonBody(context.req.raw); } catch { return transport(context, 'invalid_request', 400); }
    const parsed = agentActionPlanSchema.safeParse(body);
    if (!parsed.success) return transport(context, 'invalid_request', 400);
    const plan = parsed.data;
    if (plan.source.surface !== 'external_mcp'
        || plan.source.proposingPrincipalId !== auth.key.ownerUserId
        || plan.source.clientKey !== `api-key:${auth.key.apiKeyId}`
        || plan.scope.workspaceId !== auth.key.workspaceId
        || (auth.key.eventIds.length > 0
          && (plan.scope.eventId === undefined
            || !auth.key.eventIds.some((eventId) => eventId === plan.scope.eventId)))) {
      return transport(context, 'forbidden', 403);
    }
    const catalog = new Map(runtime.planOperations.map((entry) => [
      `${entry.operationName}\u0000${entry.operationVersion}`, entry
    ]));
    for (const step of plan.steps) {
      const operation = catalog.get(`${step.operationName}\u0000${step.operationVersion}`);
      if (!operation) return transport(context, 'forbidden', 403);
      const availability = await planAvailability(runtime, auth.key, operation, plan.scope);
      if (availability.state !== 'active') {
        return outcome(context, 'access_denied', 'agent_plan.step_unavailable', {
          stepId: step.id,
          operationName: step.operationName,
          operationVersion: step.operationVersion,
          availability
        });
      }
    }
    try {
      const executed = await idempotent({
        context, runtime, key: auth.key, endpointKey: 'plans.submit', requestBody: plan,
        beforeApply: () => {
          const open = runtime.planRepository.listOwned({
            sourceSurface: 'external_mcp',
            proposingPrincipalId: auth.key.ownerUserId,
            clientKey: `api-key:${auth.key.apiKeyId}`,
            status: 'awaiting_approval',
            limit: policy(runtime).maximumOpenPlans
          });
          if (open.items.length >= policy(runtime).maximumOpenPlans) {
            throw new PlanSubmissionQuotaError(
              'open', open.items.length, policy(runtime).maximumOpenPlans
            );
          }
          const daily = runtime.rateLimiter.consume({
            scopeKey: `plan-day:${auth.key.apiKeyId}`,
            now: runtime.now(), windowMs: DAY_MS, limit: policy(runtime).planSubmissionsPerDay
          });
          if (daily.kind === 'limited') {
            throw new PlanSubmissionQuotaError(
              'daily', policy(runtime).planSubmissionsPerDay,
              policy(runtime).planSubmissionsPerDay, daily.retryAfterSeconds
            );
          }
        },
        apply: () => runtime.plans.submit(plan), parse: parseAgentActionBatchView
      });
      if (executed instanceof Response) return executed;
      if (executed.kind === 'conflict') {
        return outcome(context, 'idempotency_conflict', 'agent_plan.idempotency_conflict', {});
      }
      return context.json(externalAgentPlanSubmitResponseSchema.parse({
        plan: executed.value,
        reviewUrl: runtime.reviewUrl(executed.value.plan.batchId),
        correlationId: correlationId(context)
      }));
    } catch (error) {
      if (error instanceof PlanSubmissionQuotaError) {
        return outcome(
          context,
          'quota_exceeded',
          error.quota === 'open' ? 'agent_plan.open_limit' : 'agent_plan.daily_limit',
          { current: error.current, maximum: error.maximum, hint: '/api/v1/pending' }
        );
      }
      return transport(context, 'invalid_request', 400);
    }
  });

  app.get('/api/v1/plans', (context) => {
    const auth = authenticate(context, runtime, 'submit_plans');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    const cursor = context.req.query('cursor');
    const statusCandidate = context.req.query('status');
    const status = statusCandidate === undefined
      ? undefined
      : agentActionBatchStatusSchema.safeParse(statusCandidate);
    if (status !== undefined && !status.success) return transport(context, 'invalid_request', 400);
    try {
      const page = runtime.planRepository.listOwned({
        sourceSurface: 'external_mcp',
        proposingPrincipalId: auth.key.ownerUserId,
        clientKey: `api-key:${auth.key.apiKeyId}`,
        limit: 50,
        ...(cursor === undefined ? {} : { cursor }),
        ...(status === undefined ? {} : { status: status.data })
      });
      return context.json(externalAgentPlanPageResponseSchema.parse({
        ...page, correlationId: correlationId(context)
      }));
    } catch { return transport(context, 'invalid_request', 400); }
  });

  app.get('/api/v1/plans/:batchId', (context) => {
    const auth = authenticate(context, runtime, 'submit_plans');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    const view = owned(runtime, auth.key, context.req.param('batchId'));
    return view
      ? context.json(externalAgentPlanInspectResponseSchema.parse({
          plan: view,
          reviewUrl: runtime.reviewUrl(view.plan.batchId),
          correlationId: correlationId(context)
        }))
      : transport(context, 'forbidden', 403);
  });

  app.post('/api/v1/plans/:batchId/cancel', async (context) => {
    const auth = authenticate(context, runtime, 'submit_plans');
    if (auth instanceof Response) return auth;
    if (auth.kind !== 'verified') return transport(context, 'internal_error', 500);
    let body: unknown;
    try { body = await boundedJsonBody(context.req.raw); } catch { return transport(context, 'invalid_request', 400); }
    const command = z.strictObject({ expectedVersion: z.number().int().positive() }).safeParse(body);
    if (!command.success) return transport(context, 'invalid_request', 400);
    const batchId = context.req.param('batchId');
    if (!owned(runtime, auth.key, batchId)) return transport(context, 'forbidden', 403);
    try {
      const executed = await idempotent({
        context, runtime, key: auth.key, endpointKey: `plans.cancel:${batchId}`,
        requestBody: { batchId, expectedVersion: command.data.expectedVersion },
        apply: () => runtime.plans.cancel({ batchId, expectedVersion: command.data.expectedVersion }),
        parse: (value) => agentActionBatchViewSchema.parse(value)
      });
      if (executed instanceof Response) return executed;
      if (executed.kind === 'conflict') {
        return outcome(context, 'idempotency_conflict', 'agent_plan.idempotency_conflict', {});
      }
      return context.json(externalAgentPlanCancelResponseSchema.parse({
        plan: executed.value,
        message: 'Completed steps remain applied. Cancel stops the remaining steps.',
        correlationId: correlationId(context)
      }));
    } catch { return transport(context, 'invalid_request', 400); }
  });

  return app;
}
