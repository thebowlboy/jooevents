import { describe, expect, test } from 'bun:test';
import {
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  type OperationSurface,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseAgentRunId,
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseModelAttemptId,
  parseModelToolCallId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createOperationAutonomyPolicy } from '../autonomy';
import { createReadOperationExecutor, OperationExecutionError } from './executor';
import { createReadInvocationContextBuilder } from './invocation-context';
import {
  isSealedReadImmutableAuditRecord,
  isSealedReadOperationalTraceRecord
} from './read-observability';
import { createReadOperationRegistry, OperationRegistryValidationError } from './registry';
import type {
  ReadImmutableAuditDeclaration,
  ReadImmutableAuditRecord,
  ReadObservationResultSummary,
  ReadOperationalTraceRecord,
  ExecuteReadOperationInput,
  ReadOperationRegistrySource
} from './types';

function definitionRef(key: string, version = 1): VersionedDefinitionRef {
  return { key, version };
}

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: seed.repeat(64) };
}

const refs = {
  input: schemaRef('schema.read-observation.input', '1'),
  canonical: schemaRef('schema.read-observation.canonical', '2'),
  projected: schemaRef('schema.read-observation.projected', '3'),
  denialDetail: schemaRef('schema.read-observation.denial-detail', '4'),
  expectedDetail: schemaRef('schema.read-observation.expected-detail', '5'),
  context: definitionRef('context.read-observation'),
  autonomy: definitionRef('autonomy.read-observation'),
  capability: definitionRef('capability.read-observation'),
  handler: definitionRef('handler.read-observation'),
  projection: definitionRef('projection.read-observation'),
  trace: definitionRef('trace.read-observation'),
  audit: definitionRef('audit.read-observation'),
  recordProfile: definitionRef('record-profile.read-observation')
} as const;

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  agentRun: parseAgentRunId('01890f47-9abc-7def-8123-456789abc003'),
  modelAttempt: parseModelAttemptId('01890f47-9abc-7def-8123-456789abc004'),
  modelToolCall: parseModelToolCallId('01890f47-9abc-7def-8123-456789abc005')
} as const;
const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const now = parseInstant('2026-08-11T00:00:00.000Z');
const profile = { key: 'read-observation-test', version: parseContractVersion(1) } as const;

const operatorLane = parseOperationAccessLane({
  kind: 'operator', surface: 'operator_http',
  policy: { key: 'authority.read-observation.operator', version: 1 }
});
const mcpLane = parseOperationAccessLane({
  kind: 'external_mcp', surface: 'external_mcp',
  policy: { key: 'authority.read-observation.external-mcp', version: 1 }
});
const modelLane = parseOperationAccessLane({
  kind: 'app_model', surface: 'app_model',
  policy: { key: 'authority.read-observation.app-model', version: 1 }
});

const inputSchema = z.strictObject({
  mode: z.enum(['success', 'expected_outcome', 'handler_failure', 'invalid_canonical'])
});
const canonicalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('success'),
    data: z.strictObject({ value: z.string(), privateResult: z.string() })
  }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const projectedSchema = createReadOperationResultSchema(z.strictObject({ value: z.string() }));

type SourceOptions = {
  readonly machineBindings?: boolean;
  readonly immutableAudit?: ReadImmutableAuditDeclaration;
  readonly snapshotFailure?: boolean;
  readonly projectionFailure?: boolean;
  readonly invalidProjectedResult?: boolean;
  readonly maximumBytes?: number;
  readonly nextInvocationId?: () => ReturnType<typeof parseInvocationId>;
  readonly state?: { handlerCalls: number; snapshotCalls: number };
};

function nextIdFactory() {
  let value = 16;
  return () => parseInvocationId(
    `018f0f47-7a86-7d36-8a25-${(value++).toString(16).padStart(12, '0')}`
  );
}

function source(options: SourceOptions = {}): ReadOperationRegistrySource {
  const machineBindings = options.machineBindings ?? false;
  const lanes = [operatorLane, ...(machineBindings ? [mcpLane, modelLane] : [])];
  const state = options.state ?? { handlerCalls: 0, snapshotCalls: 0 };
  const nextInvocationId = options.nextInvocationId ?? nextIdFactory();
  const contextBuilder = createReadInvocationContextBuilder({
    reference: refs.context,
    operation: { name: 'observation.read', version: 1 },
    effect: 'read',
    lanes,
    scopeResolver: {
      resolve: () => ({
        workspaceId: ids.workspace,
        subjects: [{ kind: 'workspace', id: ids.workspace }],
        resolutionEvidenceIds: ['scope-current:v1']
      })
    },
    authorityResolver: {
      resolve(input) {
        if (input.evidence.client.key === 'denied-client') {
          return { kind: 'denied', reason: 'not_authorized' };
        }
        const actor = input.evidence.kind === 'external_mcp'
          ? {
              kind: 'external_mcp_client' as const,
              clientKey: input.evidence.clientKey,
              authorityPrincipalId: 'principal-read-observation'
            }
          : input.evidence.kind === 'app_model'
            ? {
                kind: 'app_model_run' as const,
                agentRunId: input.evidence.agentRunId,
                delegatedByPrincipalId: 'principal-read-observation'
              }
            : input.evidence.kind === 'operator'
              ? { kind: 'workspace_user' as const, userId: ids.user }
              : undefined;
        if (!actor) return { kind: 'denied', reason: 'lane_mismatch' };
        return {
          kind: 'authorized',
          authority: {
            actor,
            principal: { kind: 'workspace_user', userId: ids.user, membershipId: ids.membership },
            lane: input.lane,
            scope: input.scope,
            grants: [{ kind: 'permission', key: 'test.observation.read' }],
            evidenceIds: ['authority-current:v1'],
            authorityCitationIds: [],
            evaluatedAt: input.evaluatedAt
          }
        };
      }
    },
    clock: { now: () => now },
    newInvocationId: nextInvocationId,
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    deniedAuthorityOutcome: () => ({
      class: 'access_denied',
      kind: 'observation.not_authorized',
      retryable: false,
      subjects: [],
      detail: { reason: 'denied' },
      detailSchemaVersion: 1
    })
  });
  const immutableAudit = options.immutableAudit
    ?? (machineBindings
      ? { mode: 'external_mcp_app_model', target: refs.audit }
      : { mode: 'none' });
  return {
    autonomyPolicies: [createOperationAutonomyPolicy({
      definition: refs.autonomy,
      operation: { name: 'observation.read', version: 1 },
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
      { reference: refs.denialDetail, schema: z.strictObject({ reason: z.literal('denied') }) },
      { reference: refs.expectedDetail, schema: z.null() }
    ],
    contextBuilders: [contextBuilder],
    readCapabilities: [{
      reference: refs.capability,
      openSnapshot: () => {
        state.snapshotCalls += 1;
        if (options.snapshotFailure) throw new Error('snapshot-provider-secret-canary');
        return { value: 'snapshot-value' };
      }
    }],
    handlers: [{
      reference: refs.handler,
      readCapability: refs.capability,
      canonicalResultSchema: refs.canonical,
      handle: ({ businessInput, snapshot }) => {
        state.handlerCalls += 1;
        const parsed = inputSchema.parse(businessInput);
        if (parsed.mode === 'handler_failure') throw new Error('handler-provider-secret-canary');
        if (parsed.mode === 'invalid_canonical') {
          return { kind: 'success', data: { value: snapshot.value, privateResult: 42 } };
        }
        if (parsed.mode === 'expected_outcome') {
          return {
            kind: 'outcome',
            outcome: {
              class: 'conflict',
              kind: 'observation.expected',
              retryable: false,
              subjects: [],
              detail: null,
              detailSchemaVersion: 1
            }
          };
        }
        return {
          kind: 'success',
          data: { value: String(snapshot.value), privateResult: 'private-result-canary' }
        };
      }
    }],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project: (candidate) => {
        if (options.projectionFailure) throw new Error('projection-provider-secret-canary');
        const parsed = canonicalSchema.parse(candidate);
        if (parsed.kind === 'outcome') return parsed;
        return options.invalidProjectedResult
          ? { kind: 'success', data: { value: 42 } }
          : { kind: 'success', data: { value: parsed.data.value } };
      }
    }],
    readOperationalTraceTargets: [{
      reference: refs.trace,
      kind: 'read_operational_trace_record',
      recordProfile: refs.recordProfile
    }],
    operationAuditTargets: [{
      reference: refs.audit,
      kind: 'operation_audit_record',
      recordProfile: refs.recordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: refs.recordProfile,
      kind: 'canonical_json',
      maximumBytes: options.maximumBytes ?? 32_768
    }],
    operations: [{
      name: 'observation.read',
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Exercise safe read observability.',
      effect: 'read',
      maxRisk: 'low',
      autonomyPolicy: refs.autonomy,
      consequenceTags: ['disclosure'],
      inputSchema: refs.input,
      canonicalResultSchema: refs.canonical,
      outcomes: [
        {
          class: 'access_denied', kind: 'observation.not_authorized', retryable: false,
          detailSchema: refs.denialDetail
        },
        {
          class: 'conflict', kind: 'observation.expected', retryable: false,
          detailSchema: refs.expectedDetail
        }
      ],
      accessLanes: lanes,
      contextBuilder: refs.context,
      readCapability: refs.capability,
      handler: refs.handler,
      observability: {
        trace: { mode: 'required', target: refs.trace },
        immutableAudit
      },
      bindings: [
        {
          surface: 'operator_http',
          method: 'GET',
          path: '/api/test/read-observation',
          input: 'query',
          browserResumption: { kind: 'none' },
          projection: refs.projection
        },
        ...(machineBindings
          ? [
              {
                surface: 'external_mcp' as const,
                toolName: 'observation_read',
                projection: refs.projection
              },
              {
                surface: 'app_model' as const,
                toolName: 'observation_read_for_model',
                projection: refs.projection
              }
            ]
          : [])
      ]
    }]
  };
}

function invocation(
  surface: 'operator_http' | 'external_mcp' | 'app_model',
  businessInput: unknown = { mode: 'success' },
  clientKey = 'read-observation-client'
) {
  const verifiedEvidence = surface === 'operator_http'
    ? {
        kind: 'operator' as const,
        surface,
        client: { key: clientKey },
        sessionHandle: 'raw-session-secret-canary'
      }
    : surface === 'external_mcp'
      ? {
          kind: 'external_mcp' as const,
          surface,
          client: { key: clientKey },
          credentialHandle: 'raw-oauth-secret-canary',
          clientKey: 'client.read-observation'
        }
      : {
          kind: 'app_model' as const,
          surface,
          client: { key: clientKey },
          agentRunId: ids.agentRun,
          modelAttemptId: ids.modelAttempt,
          modelToolCallId: ids.modelToolCall
        };
  return {
    operationName: 'observation.read',
    operationVersion: 1,
    surface,
    correlationId,
    businessInput,
    verifiedEvidence
  };
}

async function harness(options: SourceOptions & {
  readonly auditFailure?: boolean;
  readonly traceSinkFailure?: boolean;
} = {}) {
  const traces: ReadOperationalTraceRecord[] = [];
  const audits: ReadImmutableAuditRecord[] = [];
  let auditAttempts = 0;
  const nextInvocationId = nextIdFactory();
  const registry = await createReadOperationRegistry(source({ ...options, nextInvocationId }));
  const executor = createReadOperationExecutor(registry, {
    operationalTrace: {
      emit(record) {
        traces.push(record);
        if (options.traceSinkFailure) throw new Error('trace-sink-unavailable');
      }
    },
    immutableAudit: {
      append(record) {
        auditAttempts += 1;
        if (options.auditFailure) throw new Error('audit-store-unavailable');
        audits.push(record);
      }
    },
    clock: { now: () => now },
    newInvocationId: nextInvocationId
  });
  return { registry, executor, traces, audits, auditAttempts: () => auditAttempts };
}

describe('read observability registry', () => {
  test('keeps trace/audit targets internal and the public manifest byte-stable', async () => {
    const firstSource = source();
    const alternateTrace = definitionRef('trace.read-observation.alternate', 2);
    const secondSource: ReadOperationRegistrySource = {
      ...source(),
      readOperationalTraceTargets: [{
        reference: alternateTrace,
        kind: 'read_operational_trace_record',
        recordProfile: refs.recordProfile
      }],
      operations: source().operations.map((operation) => ({
        ...operation,
        observability: {
          ...operation.observability,
          trace: { mode: 'required', target: alternateTrace }
        }
      }))
    };
    const [first, second] = await Promise.all([
      createReadOperationRegistry(firstSource),
      createReadOperationRegistry(secondSource)
    ]);
    expect(first.safeManifest).toEqual(second.safeManifest);
    expect(first.manifestDigestSha256).toBe(second.manifestDigestSha256);
    const serialized = JSON.stringify(first.safeManifest);
    for (const hidden of [refs.trace.key, refs.audit.key, refs.recordProfile.key]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  test('rejects malformed, dangling, or surface-incoherent declarations deterministically', async () => {
    const cases: readonly [string, ReadOperationRegistrySource][] = [
      ['unknown_read_trace_target', { ...source(), readOperationalTraceTargets: [] }],
      ['invalid_read_trace_declaration', {
        ...source(),
        operations: source().operations.map((operation) => ({
          ...operation, observability: { immutableAudit: { mode: 'none' } }
        } as never))
      }],
      ['read_machine_audit_required', {
        ...source({ machineBindings: true }),
        operations: source({ machineBindings: true }).operations.map((operation) => ({
          ...operation,
          observability: { ...operation.observability, immutableAudit: { mode: 'none' } }
        }))
      }],
      ['read_machine_audit_without_binding', {
        ...source(),
        operations: source().operations.map((operation) => ({
          ...operation,
          observability: {
            ...operation.observability,
            immutableAudit: { mode: 'external_mcp_app_model', target: refs.audit }
          }
        }))
      }],
      ['invalid_read_audit_declaration', {
        ...source(),
        operations: source().operations.map((operation) => ({
          ...operation,
          observability: {
            ...operation.observability,
            immutableAudit: { mode: 'required', target: refs.audit }
          }
        } as never))
      }],
      ['unknown_read_audit_target', {
        ...source({
          immutableAudit: {
            mode: 'required', reason: 'security_sensitive',
            target: definitionRef('audit.missing')
          }
        })
      }],
      ['invalid_read_trace_target', {
        ...source(),
        readOperationalTraceTargets: [{
          reference: refs.trace,
          kind: 'wrong-kind',
          recordProfile: refs.recordProfile
        } as never]
      }]
    ];
    for (const [code, candidate] of cases) {
      try {
        await createReadOperationRegistry(candidate);
        throw new Error(`expected ${code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(OperationRegistryValidationError);
        expect((error as OperationRegistryValidationError).issues.map((issue) => issue.code)).toContain(code);
      }
    }
  });
});

describe('read executor observability', () => {
  test('traces ordinary success/outcome/authority denial without immutable audit or data leakage', async () => {
    const target = await harness();
    await expect(target.executor.execute(invocation('operator_http'))).resolves.toMatchObject({ kind: 'success' });
    await expect(target.executor.execute(invocation('operator_http', { mode: 'expected_outcome' })))
      .resolves.toMatchObject({ kind: 'outcome' });
    await expect(target.executor.execute(invocation('operator_http', { mode: 'success' }, 'denied-client')))
      .resolves.toMatchObject({ kind: 'outcome' });

    expect(target.traces.map((record) => record.resultSummary.kind)).toEqual([
      'success', 'outcome', 'outcome'
    ]);
    expect(target.traces[2]?.disposition).toBe('context_denied');
    expect(target.audits).toHaveLength(0);
    expect(target.traces.every(isSealedReadOperationalTraceRecord)).toBe(true);
    expect(target.traces.every(Object.isFrozen)).toBe(true);
    const serialized = JSON.stringify(target.traces);
    for (const forbidden of [
      'raw-session-secret-canary', 'private-result-canary', 'businessInput',
      'verifiedEvidence', 'requestHash', 'authorityPrincipalKey', '"detail"'
    ]) expect(serialized).not.toContain(forbidden);
  });

  test('audits external MCP and app-model success/denial while operator calls on the same operation only trace', async () => {
    const target = await harness({ machineBindings: true });
    await target.executor.execute(invocation('operator_http'));
    await target.executor.execute(invocation('external_mcp'));
    await target.executor.execute(invocation('app_model'));
    await target.executor.execute(invocation('external_mcp', { mode: 'success' }, 'denied-client'));

    expect(target.traces).toHaveLength(4);
    expect(target.audits).toHaveLength(3);
    expect(target.audits.map((record) => record.surface)).toEqual([
      'external_mcp', 'app_model', 'external_mcp'
    ]);
    expect(target.audits.at(-1)?.disposition).toBe('context_denied');
    expect(target.audits.every(isSealedReadImmutableAuditRecord)).toBe(true);
    expect(target.audits.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(target.audits)).not.toContain('raw-oauth-secret-canary');
  });

  test('audits explicitly security-sensitive and classified operator reads', async () => {
    for (const reason of ['security_sensitive', 'classified'] as const) {
      const target = await harness({
        immutableAudit: { mode: 'required', reason, target: refs.audit }
      });
      await target.executor.execute(invocation('operator_http'));
      expect(target.traces).toHaveLength(1);
      expect(target.audits).toHaveLength(1);
      expect(target.audits[0]?.surface).toBe('operator_http');
    }
  });

  test('records request rejection distinctly and covers every bound internal-failure branch', async () => {
    const rejected = await harness({ machineBindings: true });
    await expect(rejected.executor.execute(invocation('external_mcp', {
      mode: 'success', rawSecret: 'invalid-input-secret-canary'
    }))).rejects.toMatchObject({ name: 'OperationInputError' });
    expect(rejected.traces[0]?.resultSummary).toEqual({
      kind: 'request_rejected', reason: 'invalid_input'
    });
    expect(rejected.audits[0]?.resultSummary).toEqual({
      kind: 'request_rejected', reason: 'invalid_input'
    });
    expect(JSON.stringify([rejected.traces, rejected.audits])).not.toContain('invalid-input-secret-canary');

    const rejectedClaim = await harness({ machineBindings: true });
    await expect(rejectedClaim.executor.execute(invocation('external_mcp', {
      mode: 'success', actor: { kind: 'caller-security-claim-canary' }
    }))).rejects.toMatchObject({ name: 'OperationInputError' });
    expect(rejectedClaim.traces[0]?.resultSummary).toEqual({
      kind: 'request_rejected', reason: 'invalid_input'
    });
    expect(rejectedClaim.audits[0]?.resultSummary).toEqual({
      kind: 'request_rejected', reason: 'invalid_input'
    });
    expect(JSON.stringify([rejectedClaim.traces, rejectedClaim.audits]))
      .not.toContain('caller-security-claim-canary');

    type FailurePhase = Extract<
      ReadObservationResultSummary,
      { readonly kind: 'internal_failure' }
    >['phase'];
    const cases: readonly [
      FailurePhase,
      SourceOptions,
      ExecuteReadOperationInput
    ][] = [
      ['context', {}, {
        ...invocation('external_mcp'),
        verifiedEvidence: {
          kind: 'external_mcp', surface: 'external_mcp', client: { key: 'bad-evidence' },
          clientKey: 'client.read-observation'
        }
      }],
      ['read_snapshot', { snapshotFailure: true }, invocation('external_mcp')],
      ['handler', {}, invocation('external_mcp', { mode: 'handler_failure' })],
      ['canonical_result', {}, invocation('external_mcp', { mode: 'invalid_canonical' })],
      ['projection', { projectionFailure: true }, invocation('external_mcp')],
      ['projected_result', { invalidProjectedResult: true }, invocation('external_mcp')]
    ];
    for (const [phase, options, call] of cases) {
      const target = await harness({ ...options, machineBindings: true });
      await expect(target.executor.execute(call)).rejects.toBeDefined();
      expect(target.traces).toHaveLength(1);
      expect(target.audits).toHaveLength(1);
      expect(target.traces[0]?.resultSummary).toEqual({ kind: 'internal_failure', phase });
      expect(target.audits[0]?.resultSummary).toEqual({ kind: 'internal_failure', phase });
      const serialized = JSON.stringify([target.traces, target.audits]);
      expect(serialized).not.toContain('provider-secret-canary');
    }
  });

  test('fails closed on immutable-audit failure and still emits one safe failure trace', async () => {
    const state = { handlerCalls: 0, snapshotCalls: 0 };
    const target = await harness({ machineBindings: true, auditFailure: true, state });
    await expect(target.executor.execute(invocation('external_mcp'))).rejects.toMatchObject({
      name: 'OperationExecutionError',
      phase: 'read_immutable_audit'
    } satisfies Partial<OperationExecutionError>);
    expect(state.handlerCalls).toBe(1);
    expect(target.auditAttempts()).toBe(1);
    expect(target.audits).toHaveLength(0);
    expect(target.traces).toHaveLength(1);
    expect(target.traces[0]?.resultSummary).toEqual({
      kind: 'internal_failure', phase: 'immutable_audit'
    });
  });

  test('keeps trace delivery best-effort but trace record construction fail-closed', async () => {
    const unavailable = await harness({ traceSinkFailure: true });
    await expect(unavailable.executor.execute(invocation('operator_http')))
      .resolves.toMatchObject({ kind: 'success' });
    expect(unavailable.traces).toHaveLength(1);

    const invalidProfile = await harness({ maximumBytes: 1 });
    await expect(invalidProfile.executor.execute(invocation('operator_http'))).rejects.toMatchObject({
      name: 'OperationExecutionError',
      phase: 'read_operational_trace'
    } satisfies Partial<OperationExecutionError>);
    expect(invalidProfile.traces).toHaveLength(0);
  });

  test('leaves an unbound invocation to boundary security telemetry', async () => {
    const target = await harness({ machineBindings: true });
    await expect(target.executor.execute({
      ...invocation('external_mcp'),
      operationName: 'unregistered.read'
    })).rejects.toMatchObject({
      name: 'OperationExecutionError',
      phase: 'binding'
    } satisfies Partial<OperationExecutionError>);
    expect(target.traces).toHaveLength(0);
    expect(target.audits).toHaveLength(0);
    expect(target.auditAttempts()).toBe(0);
  });
});
