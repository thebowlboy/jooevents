import { describe, expect, test } from 'bun:test';
import {
  EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS,
  emailProviderConnectionProjectionSchema,
  organizerEmailReadinessProjectionSchema
} from '@jooevents/contracts';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  createApplicationOperationRuntime,
  OperationInputError,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type InvocationEvidence,
  type ReadImmutableAuditRecord,
  type ReadOperationalTraceRecord,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt
} from './operations';
import { COMMUNICATION_PROVIDER_OPERATIONS } from './communications-provider-operations';
import {
  COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
  createCommunicationProviderReadOperationModule,
  type CreateCommunicationProviderReadOperationModuleInput
} from './communications-provider-read-operation-registry';

const ids = Object.freeze({
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  otherWorkspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002')
});
const now = parseInstant('2026-08-13T09:00:00.000Z');
const profile = Object.freeze({
  key: 'profile.communication.provider-read-test',
  version: parseContractVersion(1)
});

const operatorEvidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.provider-settings' }),
  sessionHandle: 'operator-session-secret-canary'
});
const mcpEvidence: InvocationEvidence = Object.freeze({
  kind: 'external_mcp',
  surface: 'external_mcp',
  client: Object.freeze({ key: 'mcp.provider-settings' }),
  credentialHandle: 'mcp-oauth-secret-canary',
  clientKey: 'mcp_client_opsdesk'
});

class UnusedUnitOfWork implements EffectUnitOfWorkPort {
  findTerminalReceipt(): TerminalEffectReceipt | undefined { return undefined; }
  recordShortOperationAudit(_record: ShortOperationAuditRecord): void {}
  async runInUnitOfWork<Value>(
    _work: (unitOfWork: EffectUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    return Promise.reject(new TypeError('read-only fixture'));
  }
}

function connection(workspaceId = ids.workspace) {
  return emailProviderConnectionProjectionSchema.parse({
    schemaVersion: 1,
    connectionId: 'connection-example-1',
    workspaceId,
    displayName: 'Example Email',
    adapterKey: 'example.email',
    lifecycle: 'draft',
    headVersion: 1,
    currentRevisionId: null,
    candidateRevisions: [],
    createdAt: now,
    updatedAt: now
  });
}

const readiness = organizerEmailReadinessProjectionSchema.parse({
  schemaVersion: 1,
  provider: {
    adapterKey: 'example.email',
    adapterVersion: 'v1',
    displayName: 'Example Email'
  },
  outbound: {
    state: 'ready',
    connectionRevisionId: 'connection-revision-example-1',
    evidence: {
      evidenceId: 'evidence-example-1',
      registeredCode: 'readiness.ready',
      digestSha256: 'a'.repeat(64),
      observedAt: now
    },
    validUntil: '2026-08-13T09:10:00.000Z'
  },
  callbacks: { state: 'not_supported' },
  inbound: { state: 'not_enabled' }
});

interface FixtureOptions {
  readonly connectionWorkspaceId?: typeof ids.workspace | typeof ids.otherWorkspace;
}

function fixture(options: FixtureOptions = {}) {
  let authorized = true;
  let invocation = 0;
  const calls = { authority: 0, connection: 0, readiness: 0 };
  const input: CreateCommunicationProviderReadOperationModuleInput = {
    workspaceId: ids.workspace,
    policy: COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY,
    currentAuthority: {
      resolve(resolution) {
        calls.authority += 1;
        if (!authorized) return { kind: 'denied' as const, reason: 'revoked' as const };
        const actor = resolution.evidence.kind === 'external_mcp'
          ? {
              kind: 'external_mcp_client' as const,
              clientKey: resolution.evidence.clientKey,
              authorityPrincipalId: 'principal_maya_comms'
            }
          : resolution.evidence.kind === 'operator'
            ? { kind: 'workspace_user' as const, userId: ids.user }
            : undefined;
        if (actor === undefined) return { kind: 'denied' as const, reason: 'lane_mismatch' as const };
        return {
          kind: 'authorized' as const,
          authority: {
            actor,
            principal: {
              kind: 'workspace_user' as const,
              userId: ids.user,
              membershipId: ids.membership
            },
            lane: resolution.lane,
            scope: resolution.scope,
            grants: [
              { kind: 'permission' as const, key: 'communication.provider.manage' },
              ...(resolution.evidence.kind === 'external_mcp'
                ? [{ kind: 'token_scope' as const, key: 'communication.provider.read.test-scope' }]
                : [])
            ],
            evidenceIds: ['membership.current', 'provider-management.current'],
            authorityCitationIds: [],
            evaluatedAt: resolution.evaluatedAt
          }
        };
      }
    },
    configuration: {
      getConnection() {
        calls.connection += 1;
        return connection(options.connectionWorkspaceId ?? ids.workspace);
      }
    },
    readiness: {
      getReadiness(request) {
        calls.readiness += 1;
        expect(request.workspaceId).toBe(ids.workspace);
        return readiness;
      }
    },
    clock: { now: () => now },
    ids: {
      newInvocationId: () => parseInvocationId(
        `018f7d5a-4b3c-7abc-8def-${(++invocation).toString().padStart(12, '0')}`
      )
    },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile
    }
  };
  return {
    module: createCommunicationProviderReadOperationModule(input),
    input,
    calls,
    setAuthorized(value: boolean) { authorized = value; }
  };
}

async function runtime(target: ReturnType<typeof fixture>) {
  const traces: ReadOperationalTraceRecord[] = [];
  const audits: ReadImmutableAuditRecord[] = [];
  let observationId = 100;
  const application = await createApplicationOperationRuntime({
    source: target.module.source,
    read: {
      operationalTrace: { emit(record) { traces.push(record); } },
      immutableAudit: { append(record) { audits.push(record); } },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId(
        `018f7d5a-4b3c-7abc-8def-${(++observationId).toString().padStart(12, '0')}`
      )
    },
    unitOfWork: new UnusedUnitOfWork()
  });
  return { application, traces, audits };
}

function invocation(
  operation: (typeof COMMUNICATION_PROVIDER_OPERATIONS)[keyof typeof COMMUNICATION_PROVIDER_OPERATIONS],
  surface: 'operator_http' | 'external_mcp',
  businessInput: unknown
) {
  return {
    operationName: operation.name,
    operationVersion: operation.version,
    surface,
    correlationId: crypto.randomUUID(),
    businessInput,
    verifiedEvidence: surface === 'operator_http' ? operatorEvidence : mcpEvidence
  };
}

describe('communication provider read operation registry', () => {
  test('registers exactly the two frozen reads and requires the explicit provider policy', async () => {
    const target = fixture();
    const { application } = await runtime(target);

    expect(target.module.source.operations.map((operation) => operation.name)).toEqual([
      COMMUNICATION_PROVIDER_OPERATIONS.getConnection.name,
      COMMUNICATION_PROVIDER_OPERATIONS.getReadiness.name
    ]);
    expect(target.module.source.effectOperations).toBeUndefined();
    expect(application.registry.operatorHttpBindings).toEqual([
      {
        operationName: COMMUNICATION_PROVIDER_OPERATIONS.getReadiness.name,
        operationVersion: 1,
        surface: 'operator_http',
        method: 'GET',
        path: '/api/communications/email-readiness',
        input: 'query'
      },
      {
        operationName: COMMUNICATION_PROVIDER_OPERATIONS.getConnection.name,
        operationVersion: 1,
        surface: 'operator_http',
        method: 'GET',
        path: '/api/communications/provider-connection',
        input: 'query'
      }
    ]);
    expect(application.registry.publicHttpBindings).toEqual([]);
    expect(application.registry.appModelReadBindings).toEqual([]);
    expect(application.registry.operatorHttpEffectBindings).toEqual([]);
    expect(application.registry.publicHttpEffectBindings).toEqual([]);
    expect(application.registry.appModelEffectBindings).toEqual([]);

    const connectionManifest = application.registry.safeManifest.operations.find(
      (operation) => operation.name === COMMUNICATION_PROVIDER_OPERATIONS.getConnection.name
    );
    const readinessManifest = application.registry.safeManifest.operations.find(
      (operation) => operation.name === COMMUNICATION_PROVIDER_OPERATIONS.getReadiness.name
    );
    expect(connectionManifest?.inputSchema).toEqual(
      EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getConnection.inputSchema
    );
    expect(readinessManifest?.inputSchema).toEqual(
      EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getReadiness.inputSchema
    );
    expect(connectionManifest?.enabledBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: 'external_mcp',
        protocol: 'tool',
        toolName: 'get_email_provider_connection',
        resultSchema: EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getConnection.resultSchema
      })
    ]));
    expect(readinessManifest?.enabledBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: 'external_mcp',
        protocol: 'tool',
        toolName: 'get_email_readiness',
        resultSchema: EMAIL_PROVIDER_CONFIGURATION_OPERATION_SCHEMA_REFS.getReadiness.resultSchema
      })
    ]));
    expect(target.module.source.operations.every((operation) =>
      operation.bindings.map((binding) => binding.surface).join(',')
        === 'operator_http,external_mcp'
      && operation.accessLanes.every(
        (lane) => lane.policy.key === COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY.key
          && lane.policy.version === COMMUNICATION_PROVIDER_MANAGE_ACCESS_POLICY.version
      )
    )).toBe(true);

    expect(() => createCommunicationProviderReadOperationModule({
      ...target.input,
      policy: { key: 'policy.communication.send', version: parseContractVersion(1) }
    })).toThrow('communication_provider_read_policy_catalog_mismatch');
  });

  test('serves HTTP and explicitly exposed MCP from the same safe read projections', async () => {
    const target = fixture();
    const { application, traces, audits } = await runtime(target);
    const connectionInput = { connectionId: 'connection-example-1' };

    const connectionHttp = await application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getConnection,
      'operator_http',
      connectionInput
    ));
    const connectionMcp = await application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getConnection,
      'external_mcp',
      connectionInput
    ));
    const readinessHttp = await application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getReadiness,
      'operator_http',
      {}
    ));
    const readinessMcp = await application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getReadiness,
      'external_mcp',
      {}
    ));

    expect(connectionHttp).toMatchObject({ kind: 'success', data: connection() });
    expect(connectionMcp).toMatchObject({ kind: 'success', data: connection() });
    expect(readinessHttp).toMatchObject({ kind: 'success', data: readiness });
    expect(readinessMcp).toMatchObject({ kind: 'success', data: readiness });
    expect(target.calls).toEqual({ authority: 4, connection: 2, readiness: 2 });
    expect(traces).toHaveLength(4);
    expect(audits).toHaveLength(2);
    expect(audits.every((record) => record.surface === 'external_mcp')).toBe(true);
    expect(JSON.stringify({ connectionHttp, connectionMcp, readinessHttp, readinessMcp, traces, audits }))
      .not.toContain('secret-canary');
  });

  test('reevaluates current authority and never reaches a read port after revocation', async () => {
    const target = fixture();
    const { application, audits } = await runtime(target);
    const first = await application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getConnection,
      'operator_http',
      { connectionId: 'connection-example-1' }
    ));
    target.setAuthorized(false);
    const denied = await application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getConnection,
      'external_mcp',
      { connectionId: 'connection-example-1' }
    ));

    expect(first.kind).toBe('success');
    expect(denied).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'access_denied',
        kind: 'authority.revoked',
        retryable: false
      }
    });
    expect(target.calls).toEqual({ authority: 2, connection: 1, readiness: 0 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      disposition: 'context_denied',
      surface: 'external_mcp'
    });
  });

  test('fails closed for another workspace and rejects caller-selected scope before authority', async () => {
    const target = fixture({ connectionWorkspaceId: ids.otherWorkspace });
    const { application, traces } = await runtime(target);
    const unavailable = await application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getConnection,
      'operator_http',
      { connectionId: 'connection-example-1' }
    ));

    expect(unavailable).toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'communication.provider_connection_unavailable',
        retryable: false
      }
    });
    expect(JSON.stringify(unavailable)).not.toContain(ids.otherWorkspace);
    expect(JSON.stringify(unavailable)).not.toContain('Example Email');

    await expect(application.readExecutor.execute(invocation(
      COMMUNICATION_PROVIDER_OPERATIONS.getReadiness,
      'external_mcp',
      { workspaceId: ids.otherWorkspace, authority: 'communication.send' }
    ))).rejects.toBeInstanceOf(OperationInputError);
    expect(target.calls).toEqual({ authority: 1, connection: 1, readiness: 0 });
    expect(traces.map((record) => record.resultSummary.kind)).toEqual([
      'outcome', 'request_rejected'
    ]);
  });
});
