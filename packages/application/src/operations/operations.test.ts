import { describe, expect, test } from 'bun:test';
import {
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  type ReadOperationResult,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createOperationAutonomyPolicy, type OperationAutonomyPolicy } from '../autonomy';
import { createReadOperationExecutor, OperationExecutionError, OperationInputError } from './executor';
import { createReadInvocationContextBuilder, isSealedInvocationContext } from './invocation-context';
import { createReadOperationRegistry, OperationRegistryValidationError } from './registry';
import type { ReadOperationRegistrySource } from './types';

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';

function definitionRef(key: string, version = 1): VersionedDefinitionRef {
  return { key, version };
}

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: seed.repeat(64) };
}

const refs = {
  input: schemaRef('schema.greeting.input', '1'),
  canonical: schemaRef('schema.greeting.canonical', '2'),
  projected: schemaRef('schema.greeting.operator-result', '3'),
  detail: schemaRef('schema.greeting.denial-detail', '4'),
  context: definitionRef('context.greeting'),
  farewellContext: definitionRef('context.farewell'),
  autonomy: definitionRef('autonomy.greeting-read'),
  farewellAutonomy: definitionRef('autonomy.farewell-read'),
  capability: definitionRef('capability.greeting-read'),
  handler: definitionRef('handler.greeting-read'),
  projection: definitionRef('projection.greeting-operator'),
  trace: definitionRef('trace.greeting-read'),
  audit: definitionRef('audit.greeting-read'),
  recordProfile: definitionRef('record-profile.read-observation')
} as const;

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc001');
const membershipId = parseMembershipId('01890f47-9abc-7def-8123-456789abc002');
const invocationId = parseInvocationId('01890f47-9abc-7def-8123-456789abc003');
const instant = parseInstant('2026-08-11T00:00:00.000Z');
const keyProfile = { key: 'operation-test', version: parseContractVersion(1) } as const;
const operatorLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.operation-test', version: 1 }
});
const externalMcpLane = parseOperationAccessLane({
  kind: 'external_mcp',
  surface: 'external_mcp',
  policy: { key: 'authority.operation-test-mcp', version: 1 }
});
const appModelLane = parseOperationAccessLane({
  kind: 'app_model',
  surface: 'app_model',
  policy: { key: 'authority.operation-test-model', version: 1 }
});

const denial: StructuredOutcome = {
  class: 'access_denied',
  kind: 'workspace.inactive',
  retryable: false,
  subjects: [],
  detail: { reason: 'inactive' },
  detailSchemaVersion: 1
};

function autonomyPolicy(
  operationName: string,
  definition: VersionedDefinitionRef,
  riskFloor: 'low' | 'normal' | 'consequential' = 'low'
): OperationAutonomyPolicy {
  return createOperationAutonomyPolicy({
    definition,
    operation: { name: operationName, version: 1 },
    riskFloor,
    unattendedRiskCeiling: riskFloor,
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
  });
}

function fixture(options: {
  readonly calls?: string[];
  readonly contextOutcome?: boolean;
  readonly asyncProjection?: boolean;
  readonly includeReceipt?: boolean;
  readonly permissiveProjectedSchema?: boolean;
  readonly twoOperations?: boolean;
  readonly includeMcp?: boolean;
  readonly includeAppModel?: boolean;
} = {}): ReadOperationRegistrySource {
  const calls = options.calls;
  const lanes = [
    operatorLane,
    ...(options.includeMcp ? [externalMcpLane] : []),
    ...(options.includeAppModel ? [appModelLane] : [])
  ];
  const inputBase = z.strictObject({ topic: z.string().trim().min(1) });
  const inputSchema = calls ? inputBase.transform((value) => { calls.push('input'); return value; }) : inputBase;
  const canonicalBase = z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('success'),
      data: z.strictObject({ value: z.string(), internalNote: z.string() })
    }),
    z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
  ]);
  const canonicalSchema = calls ? canonicalBase.transform((value) => { calls.push('canonical_result'); return value; }) : canonicalBase;
  const projectedBase = options.permissiveProjectedSchema
    ? z.unknown()
    : createReadOperationResultSchema(z.strictObject({ value: z.string() }));
  const projectedSchema = calls ? projectedBase.transform((value) => { calls.push('projected_result'); return value; }) : projectedBase;
  const operation = (
    name: string,
    path: string,
    contextBuilder: VersionedDefinitionRef,
    policy: VersionedDefinitionRef
  ) => ({
    name,
    version: 1,
    lifecycle: { status: 'active' as const },
    summary: `Read ${name}.`,
    effect: 'read' as const,
    maxRisk: 'low' as const,
    autonomyPolicy: policy,
    consequenceTags: ['disclosure'],
    inputSchema: refs.input,
    canonicalResultSchema: refs.canonical,
    outcomes: [{ class: 'access_denied' as const, kind: 'workspace.inactive', retryable: false, detailSchema: refs.detail }],
    accessLanes: lanes,
    contextBuilder,
    readCapability: refs.capability,
    handler: refs.handler,
    observability: {
      trace: { mode: 'required' as const, target: refs.trace },
      immutableAudit: options.includeMcp || options.includeAppModel
        ? { mode: 'external_mcp_app_model' as const, target: refs.audit }
        : { mode: 'none' as const }
    },
    bindings: [
      {
        surface: 'operator_http' as const,
        method: 'GET' as const,
        path,
        input: 'query' as const,
        browserResumption: { kind: 'none' as const },
        projection: refs.projection
      },
      ...(options.includeMcp
        ? [{
            surface: 'external_mcp' as const,
            toolName: `${name.replaceAll('.', '_')}_tool`,
            projection: refs.projection
          }]
        : []),
      ...(options.includeAppModel
        ? [{
            surface: 'app_model' as const,
            toolName: `${name.replaceAll('.', '_')}_model_tool`,
            projection: refs.projection
          }]
        : [])
    ]
  });

  const contextBuilder = (name: string, reference: VersionedDefinitionRef) => createReadInvocationContextBuilder({
    reference,
    operation: { name, version: 1 },
    effect: 'read',
    lanes,
    scopeResolver: {
      resolve: () => {
        calls?.push('context');
        return {
          workspaceId,
          subjects: [{ kind: 'workspace' as const, id: workspaceId }],
          resolutionEvidenceIds: ['workspace-target:v1']
        };
      }
    },
    authorityResolver: {
      resolve: (input) => options.contextOutcome
        ? { kind: 'denied', reason: 'not_authorized' }
        : {
            kind: 'authorized',
            authority: {
              actor: { kind: 'workspace_user', userId },
              principal: { kind: 'workspace_user', userId, membershipId },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'permission', key: 'test.greeting.read' }],
              evidenceIds: ['membership-current:v1'],
              authorityCitationIds: [],
              evaluatedAt: input.evaluatedAt
            }
          },
    },
    clock: { now: () => instant },
    newInvocationId: () => invocationId,
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    deniedAuthorityOutcome: () => denial
  });

  return {
    autonomyPolicies: options.twoOperations
      ? [autonomyPolicy('greeting.read', refs.autonomy), autonomyPolicy('farewell.read', refs.farewellAutonomy)]
      : [autonomyPolicy('greeting.read', refs.autonomy)],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.canonical, schema: canonicalSchema },
      { reference: refs.projected, schema: projectedSchema },
      { reference: refs.detail, schema: z.strictObject({ reason: z.literal('inactive') }) }
    ],
    contextBuilders: options.twoOperations
      ? [contextBuilder('greeting.read', refs.context), contextBuilder('farewell.read', refs.farewellContext)]
      : [contextBuilder('greeting.read', refs.context)],
    readCapabilities: [{
      reference: refs.capability,
      openSnapshot: () => {
        calls?.push('read_snapshot');
        return { readValue: async (topic: string) => `Hello ${topic}` };
      }
    }],
    handlers: [{
      reference: refs.handler,
      readCapability: refs.capability,
      canonicalResultSchema: refs.canonical,
      handle: async ({ businessInput, context, snapshot }) => {
        calls?.push('handler');
        expect(isSealedInvocationContext(context)).toBe(true);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.keys(snapshot)).toEqual(['readValue']);
        const input = inputBase.parse(businessInput);
        const value = await (snapshot.readValue as (topic: string) => Promise<string>)(input.topic);
        return { kind: 'success', data: { value, internalNote: 'must stay server-side' } };
      }
    }],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project: (candidate) => {
        calls?.push('projection');
        if (options.asyncProjection) return Promise.resolve({ kind: 'success', data: { value: 'late' } });
        const canonical = canonicalBase.parse(candidate);
        if (canonical.kind === 'outcome') return canonical;
        const projected = { kind: 'success' as const, data: { value: canonical.data.value } };
        return options.includeReceipt
          ? { ...projected, receipt: { id: correlationId, operationName: 'greeting.read', operationVersion: 1 } }
          : projected;
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
      maximumBytes: 16_384
    }],
    operations: options.twoOperations
      ? [
          operation('greeting.read', '/api/test/greeting', refs.context, refs.autonomy),
          operation('farewell.read', '/api/test/farewell', refs.farewellContext, refs.farewellAutonomy)
        ]
      : [operation('greeting.read', '/api/test/greeting', refs.context, refs.autonomy)]
  };
}

function observationOptions() {
  return {
    operationalTrace: { emit: () => undefined },
    immutableAudit: { append: () => undefined },
    clock: { now: () => instant },
    newInvocationId: () => invocationId
  };
}

function invocation(name = 'greeting.read') {
  return {
    operationName: name,
    operationVersion: 1,
    surface: 'operator_http' as const,
    correlationId,
    businessInput: { topic: 'Ada' },
    verifiedEvidence: {
      kind: 'operator' as const,
      surface: 'operator_http' as const,
      client: { key: 'web.test' },
      sessionHandle: 'verified_server_evidence'
    }
  };
}

describe('read operation registry', () => {
  test('manifest ordering and digest do not depend on registration order', async () => {
    const source = fixture({ twoOperations: true });
    const reversed: ReadOperationRegistrySource = {
      autonomyPolicies: [...source.autonomyPolicies].reverse(),
      schemas: [...source.schemas].reverse(),
      contextBuilders: [...source.contextBuilders].reverse(),
      readCapabilities: [...source.readCapabilities].reverse(),
      handlers: [...source.handlers].reverse(),
      projections: [...source.projections].reverse(),
      readOperationalTraceTargets: [...(source.readOperationalTraceTargets ?? [])].reverse(),
      operationAuditTargets: [...(source.operationAuditTargets ?? [])].reverse(),
      operationAuditRecordProfiles: [...(source.operationAuditRecordProfiles ?? [])].reverse(),
      operations: [...source.operations].reverse()
    };
    const [first, second] = await Promise.all([createReadOperationRegistry(source), createReadOperationRegistry(reversed)]);
    expect(first.safeManifest).toEqual(second.safeManifest);
    expect(first.manifestDigestSha256).toBe(second.manifestDigestSha256);
    expect(first.safeManifest.operations.map((operation) => operation.name)).toEqual(['farewell.read', 'greeting.read']);
    expect(first.manifestDigestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('safe manifests omit every internal executable reference', async () => {
    const registry = await createReadOperationRegistry(fixture());
    expect(Object.hasOwn(registry, 'operatorHttpEffectBindings')).toBe(false);
    const serialized = JSON.stringify(registry.safeManifest);
    expect(serialized).not.toContain(refs.context.key);
    expect(serialized).not.toContain(refs.capability.key);
    expect(serialized).not.toContain(refs.handler.key);
    expect(serialized).not.toContain(refs.projection.key);
    expect(serialized).not.toContain(refs.trace.key);
    expect(serialized).not.toContain(refs.audit.key);
    expect(serialized).not.toContain(refs.recordProfile.key);
    expect(serialized).not.toContain(operatorLane.policy.key);
    expect(registry.safeManifest.operations[0]?.autonomy).toEqual({
      policy: refs.autonomy,
      riskFloor: 'low',
      unattendedRiskCeiling: 'low',
      requiresSeparateApproval: false,
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
      }
    });
    expect(serialized).not.toContain('runtimeEvaluator');
    expect(Object.isFrozen(registry.safeManifest.operations)).toBe(true);
  });

  test('one read definition emits operator HTTP and external MCP bindings without adapter drift', async () => {
    const registry = await createReadOperationRegistry(fixture({ includeMcp: true }));
    const operation = registry.safeManifest.operations[0]!;
    expect(registry.operatorHttpBindings).toEqual([{
      operationName: 'greeting.read',
      operationVersion: 1,
      surface: 'operator_http',
      method: 'GET',
      path: '/api/test/greeting',
      input: 'query'
    }]);
    expect(operation.enabledBindings).toEqual([
      {
        surface: 'external_mcp',
        protocol: 'tool',
        toolName: 'greeting_read_tool',
        resultSchema: refs.projected
      },
      {
        surface: 'operator_http',
        protocol: 'http',
        method: 'GET',
        path: '/api/test/greeting',
        input: 'query',
        resultSchema: refs.projected,
        browserResumption: { kind: 'none' }
      }
    ]);
  });

  test('read operations expose only the registered app-model selector and safe projected schema', async () => {
    const registry = await createReadOperationRegistry(fixture({ includeAppModel: true }));
    const operation = registry.safeManifest.operations[0]!;

    expect(registry.appModelReadBindings).toEqual([{
      operationName: 'greeting.read',
      operationVersion: 1,
      surface: 'app_model',
      toolName: 'greeting_read_model_tool'
    }]);
    expect(operation.enabledBindings).toEqual([
      {
        surface: 'app_model',
        protocol: 'tool',
        toolName: 'greeting_read_model_tool',
        resultSchema: refs.projected
      },
      {
        surface: 'operator_http',
        protocol: 'http',
        method: 'GET',
        path: '/api/test/greeting',
        input: 'query',
        resultSchema: refs.projected,
        browserResumption: { kind: 'none' }
      }
    ]);
    const serialized = JSON.stringify(registry);
    expect(serialized).not.toContain(refs.context.key);
    expect(serialized).not.toContain(refs.handler.key);
    expect(serialized).not.toContain(refs.projection.key);
    expect(serialized).not.toContain(appModelLane.policy.key);
  });

  test('dangling references, digest mismatches, and duplicate routes fail before traffic', async () => {
    const source = fixture({ twoOperations: true });
    const broken: ReadOperationRegistrySource = {
      ...source,
      operations: source.operations.map((operation, index) => ({
        ...operation,
        ...(index === 0 ? {
          handler: definitionRef('handler.missing'),
          inputSchema: { ...operation.inputSchema, digestSha256: 'f'.repeat(64) }
        } : {
          bindings: operation.bindings.map((binding) => ({ ...binding, path: '/api/test/greeting' }))
        })
      }))
    };
    try {
      await createReadOperationRegistry(broken);
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationRegistryValidationError);
      const codes = (error as OperationRegistryValidationError).issues.map((issue) => issue.code);
      expect(codes).toContain('missing_definition_reference');
      expect(codes).toContain('schema_digest_mismatch');
      expect(codes).toContain('duplicate_http_binding');
    }
  });

  test('duplicate MCP tool selectors fail before traffic', async () => {
    const source = fixture({ twoOperations: true, includeMcp: true });
    const duplicated: ReadOperationRegistrySource = {
      ...source,
      operations: source.operations.map((operation) => ({
        ...operation,
        bindings: operation.bindings.map((binding) => binding.surface === 'external_mcp'
          ? { ...binding, toolName: 'shared_read_tool' }
          : binding)
      }))
    };
    await expect(createReadOperationRegistry(duplicated)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_mcp_binding' })])
    });
  });

  test('startup rejects generic builders and missing, extra, substitutable, or builder-mismatched lanes', async () => {
    const genericSource = fixture();
    const generic: ReadOperationRegistrySource = {
      ...genericSource,
      contextBuilders: [
        ...genericSource.contextBuilders,
        { reference: definitionRef('context.generic-extra'), build: () => ({ kind: 'outcome', outcome: denial }) } as never
      ]
    };
    await expect(createReadOperationRegistry(generic)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'untrusted_context_builder' })])
    });

    const missingSource = fixture();
    const missing: ReadOperationRegistrySource = {
      ...missingSource,
      operations: missingSource.operations.map((operation) => {
        const { accessLanes: _accessLanes, ...withoutAccessLanes } = operation;
        return withoutAccessLanes as never;
      })
    };
    await expect(createReadOperationRegistry(missing)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'missing_access_lanes' })])
    });

    const participantLane = parseOperationAccessLane({
      kind: 'participant', surface: 'participant_http',
      policy: { key: 'authority.participant-test', version: 1 }
    });
    const extraSource = fixture();
    const extra: ReadOperationRegistrySource = {
      ...extraSource,
      operations: extraSource.operations.map((operation) => ({
        ...operation,
        accessLanes: [...operation.accessLanes, participantLane]
      }))
    };
    await expect(createReadOperationRegistry(extra)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'extra_access_lane' })])
    });

    const competingOperatorLane = parseOperationAccessLane({
      kind: 'operator', surface: 'operator_http',
      policy: { key: 'authority.competing-operator', version: 1 }
    });
    const substitutableSource = fixture();
    const substitutable: ReadOperationRegistrySource = {
      ...substitutableSource,
      operations: substitutableSource.operations.map((operation) => ({
        ...operation,
        accessLanes: [...operation.accessLanes, competingOperatorLane]
      }))
    };
    await expect(createReadOperationRegistry(substitutable)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'substitutable_access_lane' })])
    });

    const mismatchedSource = fixture({ twoOperations: true });
    const mismatched: ReadOperationRegistrySource = {
      ...mismatchedSource,
      operations: mismatchedSource.operations.map((operation) => operation.name === 'farewell.read'
        ? { ...operation, contextBuilder: refs.context }
        : operation)
    };
    await expect(createReadOperationRegistry(mismatched)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'context_builder_operation_mismatch' })])
    });
  });

  test('startup rejects duplicate, missing, untrusted, mismatched, invalid, or over-max autonomy policy', async () => {
    const duplicateSource = fixture();
    await expect(createReadOperationRegistry({
      ...duplicateSource,
      autonomyPolicies: [...duplicateSource.autonomyPolicies, duplicateSource.autonomyPolicies[0]!]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_reference' })])
    });

    const missingSource = fixture();
    await expect(createReadOperationRegistry({ ...missingSource, autonomyPolicies: [] })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'missing_autonomy_policy' })])
    });

    const untrustedSource = fixture();
    await expect(createReadOperationRegistry({
      ...untrustedSource,
      autonomyPolicies: untrustedSource.autonomyPolicies.map((policy) => ({ ...policy }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'untrusted_autonomy_policy' })])
    });

    const mismatchedSource = fixture({ twoOperations: true });
    await expect(createReadOperationRegistry({
      ...mismatchedSource,
      operations: mismatchedSource.operations.map((operation) => operation.name === 'greeting.read'
        ? { ...operation, autonomyPolicy: refs.farewellAutonomy }
        : operation)
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'autonomy_policy_operation_mismatch' })])
    });

    const invalidSource = fixture();
    await expect(createReadOperationRegistry({
      ...invalidSource,
      autonomyPolicies: invalidSource.autonomyPolicies.map((policy) => ({
        ...policy,
        supportedDispositions: ['proceed', 'invented']
      } as never))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_autonomy_policy' })])
    });

    const aboveMaxSource = fixture();
    await expect(createReadOperationRegistry({
      ...aboveMaxSource,
      autonomyPolicies: [autonomyPolicy('greeting.read', refs.autonomy, 'normal')]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'autonomy_risk_floor_above_max' })])
    });
  });
});

describe('sealed read executor', () => {
  test('runs the fixed parse/context/snapshot/handler/validation/projection order', async () => {
    const calls: string[] = [];
    const registry = await createReadOperationRegistry(fixture({ calls }));
    const result = await createReadOperationExecutor(registry, observationOptions()).execute(invocation());
    expect(result).toEqual({ kind: 'success', data: { value: 'Hello Ada' }, correlationId });
    expect(calls).toEqual(['input', 'context', 'read_snapshot', 'handler', 'canonical_result', 'projection', 'projected_result']);
    expect(JSON.stringify(result)).not.toContain('internalNote');
  });

  test('context outcomes skip protected reads and remain expected outcomes', async () => {
    const calls: string[] = [];
    const registry = await createReadOperationRegistry(fixture({ calls, contextOutcome: true }));
    const result = await createReadOperationExecutor(registry, observationOptions()).execute(invocation());
    expect(result.kind).toBe('outcome');
    expect(calls).toEqual(['input', 'context', 'canonical_result', 'projection', 'projected_result']);
  });

  test('caller authority hints fail input parsing before context construction', async () => {
    const calls: string[] = [];
    const registry = await createReadOperationRegistry(fixture({ calls }));
    const executor = createReadOperationExecutor(registry, observationOptions());
    await expect(executor.execute({
      ...invocation(),
      businessInput: { topic: 'Ada', actor: 'attacker', workspaceId: 'workspace_attacker' }
    })).rejects.toBeInstanceOf(OperationInputError);
    expect(calls).toEqual([]);
  });

  test('async projection and read receipts are internal contract defects', async () => {
    const asyncRegistry = await createReadOperationRegistry(fixture({ asyncProjection: true }));
    await expect(createReadOperationExecutor(asyncRegistry, observationOptions()).execute(invocation())).rejects.toMatchObject({
      name: 'OperationExecutionError',
      phase: 'projection'
    } satisfies Partial<OperationExecutionError>);

    const receiptRegistry = await createReadOperationRegistry(fixture({ includeReceipt: true, permissiveProjectedSchema: true }));
    await expect(createReadOperationExecutor(receiptRegistry, observationOptions()).execute(invocation())).rejects.toMatchObject({
      name: 'OperationExecutionError',
      phase: 'projected_result'
    } satisfies Partial<OperationExecutionError>);
  });

  test('a second operation uses the same executor without generic changes', async () => {
    const registry = await createReadOperationRegistry(fixture({ twoOperations: true }));
    const executor = createReadOperationExecutor(registry, observationOptions());
    const result: ReadOperationResult = await executor.execute(invocation('farewell.read'));
    expect(result.kind).toBe('success');
  });
});
