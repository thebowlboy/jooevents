import { describe, expect, test } from 'bun:test';
import {
  createReadInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createReadOperationExecutor,
  createReadOperationRegistry,
  isSealedInvocationContext,
  type ReadOperationRegistrySource
} from '@jooevents/application';
import {
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parsePublicPolicyRevisionId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  createOperatorReadHttpAdapter,
  createPublicReadHttpAdapter
} from './read-operation-adapter';

const requestedCorrelationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const digest = (seed: string) => seed.repeat(64);
const schemaRef = (key: string, seed: string): SafeSchemaManifestRef => ({ key, version: 1, digestSha256: digest(seed) });
const refs = {
  input: schemaRef('schema.adapter-proof.input', '1'),
  canonical: schemaRef('schema.adapter-proof.canonical', '2'),
  projected: schemaRef('schema.adapter-proof.operator-result', '3'),
  detail: schemaRef('schema.adapter-proof.denial-detail', '4'),
  context: { key: 'context.adapter-proof', version: 1 },
  autonomy: { key: 'autonomy.adapter-proof-read', version: 1 },
  capability: { key: 'capability.adapter-proof-read', version: 1 },
  handler: { key: 'handler.adapter-proof-read', version: 1 },
  projection: { key: 'projection.adapter-proof-operator', version: 1 },
  trace: { key: 'trace.adapter-proof-read', version: 1 },
  recordProfile: { key: 'record-profile.adapter-proof-read', version: 1 }
} as const;

const inputSchema = z.strictObject({
  mode: z.enum(['success', 'outcome', 'explode']).default('success'),
  limit: z.number().int().positive().optional(),
  enabled: z.boolean().optional()
});
const canonicalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: z.strictObject({ actor: z.string(), workspaceId: z.string() }) }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const projectedSchema = createReadOperationResultSchema(z.strictObject({ actor: z.string(), workspaceId: z.string() }));

const authorityIds = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  invocation: parseInvocationId('01890f47-9abc-7def-8123-456789abc003'),
  publicPolicy: parsePublicPolicyRevisionId('01890f47-9abc-7def-8123-456789abc004')
} as const;
const authorityInstant = parseInstant('2026-08-11T00:00:00.000Z');
const keyProfile = { key: 'server-adapter-test', version: parseContractVersion(1) } as const;
const operatorLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.server-adapter-test', version: 1 }
});
const publicLane = parseOperationAccessLane({
  kind: 'public_open',
  surface: 'public_http',
  policy: { key: 'authority.server-public-adapter-test', version: 1 }
});

function provingSource(): ReadOperationRegistrySource {
  const contextBuilder = createReadInvocationContextBuilder({
    reference: refs.context,
    operation: { name: 'adapter-proof.read', version: 1 },
    effect: 'read',
    lanes: [operatorLane, publicLane],
    scopeResolver: {
      resolve: () => ({
        workspaceId: authorityIds.workspace,
        subjects: [{ kind: 'workspace', id: authorityIds.workspace }],
        resolutionEvidenceIds: ['workspace-target:v1']
      })
    },
    authorityResolver: {
      resolve: (input) => input.lane.kind === 'public_open'
        ? ({
            kind: 'authorized',
            authority: {
              actor: {
                kind: 'public_request',
                publicPolicyRevisionId: authorityIds.publicPolicy,
                authority: { kind: 'open_policy' }
              },
              principal: {
                kind: 'public_capability',
                publicPolicyRevisionId: authorityIds.publicPolicy,
                authority: { kind: 'open_policy' }
              },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'public_policy', key: 'test.adapter.read' }],
              evidenceIds: ['public-policy-current:v1'],
              authorityCitationIds: [],
              evaluatedAt: input.evaluatedAt
            }
          })
        : ({
            kind: 'authorized',
            authority: {
              actor: { kind: 'workspace_user', userId: authorityIds.user },
              principal: {
                kind: 'workspace_user',
                userId: authorityIds.user,
                membershipId: authorityIds.membership
              },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'permission', key: 'test.adapter.read' }],
              evidenceIds: ['membership-current:v1'],
              authorityCitationIds: [],
              evaluatedAt: input.evaluatedAt
            }
          })
    },
    clock: { now: () => authorityInstant },
    newInvocationId: () => authorityIds.invocation,
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    deniedAuthorityOutcome: () => ({
      class: 'access_denied', kind: 'workspace.revoked', retryable: false,
      subjects: [], detail: { reason: 'revoked' }, detailSchemaVersion: 1
    })
  });
  return {
    autonomyPolicies: [createOperationAutonomyPolicy({
      definition: refs.autonomy,
      operation: { name: 'adapter-proof.read', version: 1 },
      riskFloor: 'low',
      unattendedRiskCeiling: 'low',
      supportedDispositions: [
        'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
        'replan', 'compensate', 'block', 'attention'
      ],
      triggerDispositions: {
        authority_lost: 'block',
        unattended_bounds_exceeded: 'renewed_approval',
        approval_required: 'renewed_approval',
        known_retryable_failure: 'safe_retry',
        ambiguous_external_effect: 'reconcile',
        stale_plan: 'replan',
        compensation_required: 'compensate',
        terminal_failure: 'attention'
      },
      requiresSeparateApproval: false
    })],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.canonical, schema: canonicalSchema },
      { reference: refs.projected, schema: projectedSchema },
      { reference: refs.detail, schema: z.strictObject({ reason: z.literal('revoked') }) }
    ],
    contextBuilders: [contextBuilder],
    readCapabilities: [{ reference: refs.capability, openSnapshot: () => ({ read: true }) }],
    handlers: [{
      reference: refs.handler,
      readCapability: refs.capability,
      canonicalResultSchema: refs.canonical,
      handle: ({ businessInput, context }) => {
        expect(isSealedInvocationContext(context)).toBe(true);
        const request = inputSchema.parse(businessInput);
        if (request.mode === 'explode') throw new Error('secret implementation failure');
        if (request.mode === 'outcome') {
          return {
            kind: 'outcome',
            outcome: {
              class: 'access_denied',
              kind: 'workspace.revoked',
              retryable: false,
              subjects: [],
              detail: { reason: 'revoked' },
              detailSchemaVersion: 1
            }
          };
        }
        if (context.scope.workspaceId !== authorityIds.workspace) {
          throw new Error('trusted context mismatch');
        }
        if (context.actor.kind === 'public_request') {
          return {
            kind: 'success',
            data: { actor: 'public_server_resolved', workspaceId: 'workspace_server_resolved' }
          };
        }
        if (context.actor.kind !== 'workspace_user' || context.actor.userId !== authorityIds.user) {
          throw new Error('trusted actor mismatch');
        }
        return {
          kind: 'success',
          data: { actor: 'user_server_resolved', workspaceId: 'workspace_server_resolved' }
        };
      }
    }],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project: (value) => canonicalSchema.parse(value)
    }],
    operations: [{
      name: 'adapter-proof.read',
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Prove the generic operator read adapter.',
      effect: 'read',
      maxRisk: 'low',
      autonomyPolicy: refs.autonomy,
      consequenceTags: ['disclosure'],
      inputSchema: refs.input,
      canonicalResultSchema: refs.canonical,
      outcomes: [{ class: 'access_denied', kind: 'workspace.revoked', retryable: false, detailSchema: refs.detail }],
      accessLanes: [operatorLane, publicLane],
      contextBuilder: refs.context,
      readCapability: refs.capability,
      handler: refs.handler,
      observability: {
        trace: { mode: 'required', target: refs.trace },
        immutableAudit: { mode: 'none' }
      },
      bindings: [{
        surface: 'operator_http',
        method: 'GET',
        path: '/api/test/adapter-proof',
        input: 'query',
        browserResumption: { kind: 'none' },
        projection: refs.projection
      }, {
        surface: 'public_http',
        method: 'GET',
        path: '/api/public/test/adapter-proof',
        input: 'query',
        browserResumption: { kind: 'none' },
        projection: refs.projection
      }]
    }],
    readOperationalTraceTargets: [{
      reference: refs.trace,
      kind: 'read_operational_trace_record',
      recordProfile: refs.recordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: refs.recordProfile,
      kind: 'canonical_json',
      maximumBytes: 16_384
    }]
  };
}

async function harness() {
  const registry = await createReadOperationRegistry(provingSource());
  return createOperatorReadHttpAdapter({
    registry,
    executor: createReadOperationExecutor(registry, {
      operationalTrace: { emit: () => undefined },
      immutableAudit: { append: () => undefined },
      clock: { now: () => authorityInstant },
      newInvocationId: () => authorityIds.invocation
    }),
    evidence: {
      verify: ({ request }) => request.headers.get('x-test-session') === 'valid'
        ? {
            kind: 'verified',
            evidence: {
              kind: 'operator', surface: 'operator_http', client: { key: 'web.test' }, sessionHandle: 'verified'
            }
          }
        : { kind: 'rejected', reason: 'unauthenticated' }
    }
  });
}

async function publicHarness() {
  const registry = await createReadOperationRegistry(provingSource());
  return createPublicReadHttpAdapter({
    registry,
    executor: createReadOperationExecutor(registry, {
      operationalTrace: { emit: () => undefined },
      immutableAudit: { append: () => undefined },
      clock: { now: () => authorityInstant },
      newInvocationId: () => authorityIds.invocation
    }),
    evidence: {
      verify: () => ({
        kind: 'verified',
        evidence: {
          kind: 'public_open',
          surface: 'public_http',
          client: { key: 'web.public-test' },
          publicPolicyRevisionId: authorityIds.publicPolicy
        }
      })
    }
  });
}

function trustedHeaders(): HeadersInit {
  return { 'x-test-session': 'valid', 'x-correlation-id': requestedCorrelationId };
}

describe('generic operator read HTTP adapter', () => {
  test('binds the source-controlled route with no-store and correlation', async () => {
    const response = await (await harness()).request('/api/test/adapter-proof?mode=success', { headers: trustedHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-correlation-id')).toBe(requestedCorrelationId);
    expect(await response.json()).toEqual({
      kind: 'success',
      data: { actor: 'user_server_resolved', workspaceId: 'workspace_server_resolved' },
      correlationId: requestedCorrelationId
    });
  });

  test('decodes registered scalar query types before operator execution', async () => {
    const response = await (await harness()).request(
      '/api/test/adapter-proof?mode=success&limit=2&enabled=false',
      { headers: trustedHeaders() }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'success',
      data: { actor: 'user_server_resolved' }
    });
  });

  test('caller fields cannot select authority, scope, or another operation', async () => {
    const response = await (await harness()).request(
      '/api/test/adapter-proof?mode=success&actor=user_attacker&workspaceId=workspace_attacker&operationName=other.read',
      { headers: trustedHeaders() }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      kind: 'transport_error', code: 'invalid_request', retryable: false, correlationId: requestedCorrelationId
    });
  });

  test('keeps expected outcomes distinct from protocol and unexpected failures', async () => {
    const app = await harness();
    const outcome = await app.request('/api/test/adapter-proof?mode=outcome', { headers: trustedHeaders() });
    expect(outcome.status).toBe(200);
    expect((await outcome.json() as { kind: string }).kind).toBe('outcome');

    const protocol = await app.request('/api/test/adapter-proof?mode=invalid', { headers: trustedHeaders() });
    expect(protocol.status).toBe(400);
    expect(await protocol.json()).toMatchObject({ kind: 'transport_error', code: 'invalid_request', retryable: false });

    const unexpected = await app.request('/api/test/adapter-proof?mode=explode', { headers: trustedHeaders() });
    expect(unexpected.status).toBe(500);
    const unexpectedBody = await unexpected.json();
    expect(unexpectedBody).toMatchObject({ kind: 'transport_error', code: 'internal_error', retryable: true });
    expect(JSON.stringify(unexpectedBody)).not.toContain('secret implementation failure');
  });

  test('protocol evidence rejection never enters the application operation', async () => {
    const response = await (await harness()).request('/api/test/adapter-proof?mode=success', {
      headers: { 'x-correlation-id': requestedCorrelationId }
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ kind: 'transport_error', code: 'unauthenticated', retryable: false });
  });

  test('does not execute an undeclared implicit HEAD variant of a GET operation', async () => {
    const response = await (await harness()).request('/api/test/adapter-proof?mode=explode', {
      method: 'HEAD',
      headers: trustedHeaders()
    });
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('');
  });
});

describe('generic public read HTTP adapter', () => {
  test('uses the same registered schema-aware query transport', async () => {
    const response = await (await publicHarness()).request(
      '/api/public/test/adapter-proof?mode=success&limit=2&enabled=true',
      { headers: { 'x-correlation-id': requestedCorrelationId } }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe(requestedCorrelationId);
    expect(await response.json()).toEqual({
      kind: 'success',
      data: { actor: 'public_server_resolved', workspaceId: 'workspace_server_resolved' },
      correlationId: requestedCorrelationId
    });
  });
});
