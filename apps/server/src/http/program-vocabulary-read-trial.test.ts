import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createOperationAutonomyPolicy,
  createReadInvocationContextBuilder,
  createReadOperationExecutor,
  createReadOperationRegistry,
  type ReadOperationRegistrySource
} from '@jooevents/application';
import {
  programVocabularySnapshotCanonicalResultSchema,
  programVocabularySnapshotReadInputSchema,
  programVocabularySnapshotReadResultSchema,
  programVocabularySnapshotSchema,
  type SafeSchemaManifestRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  createMcpToolRegistry,
  findMcpTool,
  mapMcpToolCallToInvocation,
  mapOperationResultToMcp,
  type McpSchemaParser
} from '@jooevents/mcp';
import {
  installProgramVocabularyTrialSchema,
  SQLiteProgramVocabularyTrialStore
} from '@jooevents/persistence/testing/program-vocabulary-trial';
import {
  createProgramReferenceContributorRegistry,
  projectProgramVocabularySnapshot
} from '@jooevents/program';
import { z, type ZodType } from 'zod';
import { createOperatorReadHttpAdapter } from './read-operation-adapter';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  event: parseEventId('018f7d5a-4b3c-7abc-8def-0123456789ab'),
  otherEvent: parseEventId('018f7d5a-4b3c-7abc-8def-0123456789ac'),
  user: parseUserId('018f7d5a-4b3c-7abc-8def-0123456789ad'),
  membership: parseMembershipId('018f7d5a-4b3c-7abc-8def-0123456789ae'),
  invocation: parseInvocationId('018f7d5a-4b3c-7abc-8def-0123456789af'),
  room: '018f7d5a-4b3c-7abc-8def-0123456789b0',
  track: '018f7d5a-4b3c-7abc-8def-0123456789b1',
  format: '018f7d5a-4b3c-7abc-8def-0123456789b2'
} as const;

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const instant = parseInstant('2026-08-11T00:00:00.000Z');
const keyProfile = { key: 'program-vocabulary-read-trial', version: parseContractVersion(1) } as const;
const operation = { name: 'program_vocabulary.snapshot.read', version: 1 } as const;

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: seed.repeat(64) };
}

const refs = {
  input: schemaRef('schema.program_vocabulary.snapshot_read.input', 'a'),
  canonical: schemaRef('schema.program_vocabulary.snapshot_read.canonical_result', 'b'),
  projected: schemaRef('schema.program_vocabulary.snapshot_read.result', 'c'),
  denialDetail: schemaRef('schema.program_vocabulary.snapshot_read.denial_detail', 'd'),
  context: { key: 'context.program_vocabulary.snapshot_read', version: 1 },
  autonomy: { key: 'autonomy.program_vocabulary.snapshot_read', version: 1 },
  capability: { key: 'capability.program_vocabulary.snapshot_read', version: 1 },
  handler: { key: 'handler.program_vocabulary.snapshot_read', version: 1 },
  projection: { key: 'projection.program_vocabulary.snapshot_read', version: 1 },
  trace: { key: 'trace.program_vocabulary.snapshot_read', version: 1 },
  audit: { key: 'audit.program_vocabulary.snapshot_read', version: 1 },
  recordProfile: { key: 'record-profile.program_vocabulary.snapshot_read', version: 1 }
} as const;

const operatorLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.program_vocabulary.operator_read', version: 1 }
});
const externalMcpLane = parseOperationAccessLane({
  kind: 'external_mcp',
  surface: 'external_mcp',
  policy: { key: 'authority.program_vocabulary.external_mcp_read', version: 1 }
});
const lanes = [operatorLane, externalMcpLane] as const;

function seed(sqlite: Database): void {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    sqlite.query<never, [string, string, number]>(`
      INSERT INTO program_vocabulary_trial_sets (workspace_id, event_id, set_version)
      VALUES (?, ?, ?)
    `).run(ids.workspace, ids.event, 4);
    sqlite.query<never, [string, string, string, string, number, string, number]>(`
      INSERT INTO program_vocabulary_trial_rooms (
        workspace_id, event_id, id, name, capacity, status, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ids.workspace, ids.event, ids.room, 'Main hall', 320, 'active', 2);
    sqlite.query<never, [string, string, string, string, string, number]>(`
      INSERT INTO program_vocabulary_trial_tracks (
        workspace_id, event_id, id, name, status, version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(ids.workspace, ids.event, ids.track, 'Applied AI', 'retired', 3);
    sqlite.query<never, [string, string, string, string, string, number]>(`
      INSERT INTO program_vocabulary_trial_formats (
        workspace_id, event_id, id, name, status, version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(ids.workspace, ids.event, ids.format, 'Workshop', 'active', 1);
    sqlite.exec('COMMIT;');
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function mcpParser(reference: SafeSchemaManifestRef, schema: ZodType): McpSchemaParser {
  return { reference, parse: (value: unknown) => schema.parse(value) };
}

async function harness() {
  const sqlite = new Database(':memory:', { strict: true });
  installProgramVocabularyTrialSchema(sqlite);
  seed(sqlite);
  const referenceRegistry = createProgramReferenceContributorRegistry({
    expected: [],
    contributors: []
  });
  const store = new SQLiteProgramVocabularyTrialStore(sqlite, referenceRegistry);
  let protectedReadCount = 0;
  const handledSurfaces: string[] = [];

  const contextBuilder = createReadInvocationContextBuilder({
    reference: refs.context,
    operation,
    effect: 'read',
    lanes,
    scopeResolver: {
      resolve: () => {
        const eventId = ids.event;
        return {
          workspaceId: ids.workspace,
          eventId,
          subjects: [
            { kind: 'workspace', id: ids.workspace },
            { kind: 'event', id: eventId }
          ],
          resolutionEvidenceIds: [`trusted-event-target:${eventId}`]
        };
      }
    },
    authorityResolver: {
      resolve: (input) => {
        if (input.evidence.kind === 'operator') {
          if (input.evidence.sessionHandle === 'revoked') return { kind: 'denied', reason: 'revoked' };
          if (input.evidence.sessionHandle === 'cross-event') return { kind: 'denied', reason: 'cross_scope' };
          if (input.evidence.sessionHandle !== 'operator-current') return { kind: 'denied', reason: 'missing' };
          return {
            kind: 'authorized',
            authority: {
              actor: { kind: 'workspace_user', userId: ids.user },
              principal: { kind: 'workspace_user', userId: ids.user, membershipId: ids.membership },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'permission', key: 'program_vocabulary.read' }],
              evidenceIds: ['membership-current:v1'],
              authorityCitationIds: [],
              evaluatedAt: input.evaluatedAt
            }
          };
        }
        if (
          input.evidence.kind !== 'external_mcp'
          || input.evidence.oauthTokenHandle !== 'oauth-current'
          || input.evidence.oauthClientId !== 'client.program-agent'
        ) return { kind: 'denied', reason: 'revoked' };
        return {
          kind: 'authorized',
          authority: {
            actor: {
              kind: 'external_mcp_client',
              oauthClientId: input.evidence.oauthClientId,
              authorityPrincipalId: ids.user
            },
            principal: { kind: 'workspace_user', userId: ids.user, membershipId: ids.membership },
            lane: input.lane,
            scope: input.scope,
            grants: [
              { kind: 'permission', key: 'program_vocabulary.read' },
              { kind: 'token_scope', key: 'program_vocabulary.read' }
            ],
            evidenceIds: ['oauth-current:v1', 'membership-current:v1'],
            authorityCitationIds: [],
            evaluatedAt: input.evaluatedAt
          }
        };
      }
    },
    clock: { now: () => instant },
    newInvocationId: () => ids.invocation,
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    deniedAuthorityOutcome: (reason) => ({
      class: 'access_denied',
      kind: 'program_vocabulary.not_authorized',
      retryable: false,
      subjects: [],
      detail: { reason },
      detailSchemaVersion: 1
    })
  });

  const source: ReadOperationRegistrySource = {
    autonomyPolicies: [createOperationAutonomyPolicy({
      definition: refs.autonomy,
      operation,
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
      { reference: refs.input, schema: programVocabularySnapshotReadInputSchema },
      { reference: refs.canonical, schema: programVocabularySnapshotCanonicalResultSchema },
      { reference: refs.projected, schema: programVocabularySnapshotReadResultSchema },
      {
        reference: refs.denialDetail,
        schema: z.strictObject({ reason: z.enum(['missing', 'not_authorized', 'stale', 'revoked', 'cross_scope', 'lane_mismatch']) })
      }
    ],
    contextBuilders: [contextBuilder],
    readCapabilities: [{
      reference: refs.capability,
      openSnapshot: (context) => {
        protectedReadCount += 1;
        if (context.scope.eventId === undefined) throw new TypeError('trusted_event_scope_required');
        const state = store.readVocabulary({
          workspaceId: context.scope.workspaceId,
          eventId: context.scope.eventId
        });
        if (!state) throw new TypeError('trusted_program_vocabulary_missing');
        const references = referenceRegistry.capture(state.scope, store);
        return { vocabulary: projectProgramVocabularySnapshot(state, references) };
      }
    }],
    handlers: [{
      reference: refs.handler,
      readCapability: refs.capability,
      canonicalResultSchema: refs.canonical,
      handle: ({ businessInput, context, snapshot }) => {
        programVocabularySnapshotReadInputSchema.parse(businessInput);
        handledSurfaces.push(context.surface);
        return {
          kind: 'success',
          data: programVocabularySnapshotSchema.parse(snapshot.vocabulary)
        };
      }
    }],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project: (candidate) => programVocabularySnapshotCanonicalResultSchema.parse(candidate)
    }],
    operations: [{
      ...operation,
      lifecycle: { status: 'active' },
      summary: 'Read the current event program vocabulary snapshot.',
      effect: 'read',
      maxRisk: 'low',
      autonomyPolicy: refs.autonomy,
      consequenceTags: ['disclosure'],
      inputSchema: refs.input,
      canonicalResultSchema: refs.canonical,
      outcomes: [{
        class: 'access_denied',
        kind: 'program_vocabulary.not_authorized',
        retryable: false,
        detailSchema: refs.denialDetail
      }],
      accessLanes: lanes,
      contextBuilder: refs.context,
      readCapability: refs.capability,
      handler: refs.handler,
      observability: {
        trace: { mode: 'required', target: refs.trace },
        immutableAudit: { mode: 'external_mcp_app_model', target: refs.audit }
      },
      bindings: [
        {
          surface: 'operator_http',
          method: 'GET',
          path: '/api/test/foundation/program-vocabulary',
          input: 'query',
          browserResumption: { kind: 'none' },
          projection: refs.projection
        },
        {
          surface: 'external_mcp',
          toolName: 'program_vocabulary_snapshot_read',
          projection: refs.projection
        }
      ]
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
      maximumBytes: 32_768
    }]
  };

  const registry = await createReadOperationRegistry(source);
  const executor = createReadOperationExecutor(registry, {
    operationalTrace: { emit: () => undefined },
    immutableAudit: { append: () => undefined },
    clock: { now: () => instant },
    newInvocationId: () => ids.invocation
  });
  const http = createOperatorReadHttpAdapter({
    registry,
    executor,
    evidence: {
      verify: ({ request }) => {
        const sessionHandle = request.headers.get('x-test-session');
        return sessionHandle === null
          ? { kind: 'rejected', reason: 'unauthenticated' }
          : {
              kind: 'verified',
              evidence: {
                kind: 'operator',
                surface: 'operator_http',
                client: { key: 'web.program-vocabulary-trial' },
                sessionHandle
              }
            };
      }
    }
  });
  const mcp = await createMcpToolRegistry(registry.safeManifest);

  return {
    sqlite,
    registry,
    executor,
    http,
    mcp,
    handledSurfaces,
    protectedReadCount: () => protectedReadCount
  };
}

describe('disposable Program Vocabulary read vertical', () => {
  test('derives HTTP and MCP contracts from the same inert operation definition', async () => {
    const target = await harness();
    try {
      const manifestOperation = target.registry.safeManifest.operations[0]!;
      expect(target.registry.operatorHttpBindings).toHaveLength(1);
      expect(manifestOperation.enabledBindings.map((binding) => binding.surface)).toEqual([
        'external_mcp',
        'operator_http'
      ]);
      const tool = findMcpTool(target.mcp, 'program_vocabulary_snapshot_read')!;
      expect(tool.contract.operation).toEqual(operation);
      expect(tool.inputSchema).toEqual(manifestOperation.inputSchema);
      expect(tool.outputSchema).toEqual(refs.projected);
      expect(target.mcp.sourceOperationRegistryDigestSha256)
        .toBe(target.registry.manifestDigestSha256);
    } finally {
      target.sqlite.close();
    }
  });

  test('reads SQLite only after sealed current operator authority and returns the canonical DTO', async () => {
    const target = await harness();
    try {
      const response = await target.http.request('/api/test/foundation/program-vocabulary', {
        headers: {
          'x-test-session': 'operator-current',
          'x-correlation-id': correlationId
        }
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const result = programVocabularySnapshotReadResultSchema.parse(await response.json());
      expect(result.kind).toBe('success');
      if (result.kind !== 'success') throw new TypeError('expected_success');
      expect(result.data).toMatchObject({
        schemaVersion: 1,
        scope: { workspaceId: ids.workspace, eventId: ids.event },
        setVersion: 4,
        rooms: [{ id: ids.room, capacity: 320, usage: { current: 0, historicalPins: 0 } }],
        tracks: [{ id: ids.track, status: 'retired' }],
        formats: [{ id: ids.format, status: 'active' }]
      });
      expect(target.protectedReadCount()).toBe(1);
      expect(target.handledSurfaces).toEqual(['operator_http']);
    } finally {
      target.sqlite.close();
    }
  });

  test('rejects caller scope and denies revoked or cross-event authority before protected reads', async () => {
    const target = await harness();
    try {
      const callerScope = await target.http.request(
        `/api/test/foundation/program-vocabulary?eventId=${ids.event}&scope=attacker`,
        { headers: { 'x-test-session': 'operator-current', 'x-correlation-id': correlationId } }
      );
      expect(callerScope.status).toBe(400);

      const revoked = await target.http.request('/api/test/foundation/program-vocabulary', {
        headers: { 'x-test-session': 'revoked', 'x-correlation-id': correlationId }
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'access_denied',
          kind: 'program_vocabulary.not_authorized',
          detail: { reason: 'revoked' }
        }
      });

      const crossEvent = await target.http.request('/api/test/foundation/program-vocabulary', {
        headers: { 'x-test-session': 'cross-event', 'x-correlation-id': correlationId }
      });
      expect(crossEvent.status).toBe(200);
      const crossBody = await crossEvent.json();
      expect(crossBody).toMatchObject({
        kind: 'outcome',
        outcome: { detail: { reason: 'cross_scope' } }
      });
      expect(JSON.stringify(crossBody)).not.toContain(ids.event);
      expect(JSON.stringify(crossBody)).not.toContain(ids.room);
      expect(target.protectedReadCount()).toBe(0);
      expect(target.handledSurfaces).toEqual([]);
    } finally {
      target.sqlite.close();
    }
  });

  test('invokes the same sealed handler through MCP and rejects scope-shaped tool arguments', async () => {
    const target = await harness();
    try {
      const tool = findMcpTool(target.mcp, 'program_vocabulary_snapshot_read')!;
      const inputParser = mcpParser(tool.inputSchema, programVocabularySnapshotReadInputSchema);
      expect(() => mapMcpToolCallToInvocation(
        target.mcp,
        { toolName: tool.name, arguments: { scope: { workspaceId: ids.workspace, eventId: ids.event } } },
        inputParser
      )).toThrow(/schema/);
      expect(target.protectedReadCount()).toBe(0);

      const invocation = mapMcpToolCallToInvocation(
        target.mcp,
        { toolName: tool.name, arguments: {} },
        inputParser
      );
      const result = await target.executor.execute({
        operationName: invocation.operation.name,
        operationVersion: invocation.operation.version,
        surface: invocation.surface,
        correlationId,
        businessInput: invocation.businessInput,
        verifiedEvidence: {
          kind: 'external_mcp',
          surface: 'external_mcp',
          client: { key: 'mcp.program-vocabulary-trial' },
          oauthTokenHandle: 'oauth-current',
          oauthClientId: 'client.program-agent'
        }
      });
      const mapped = mapOperationResultToMcp(
        target.mcp,
        invocation,
        result,
        mcpParser(tool.outputSchema, programVocabularySnapshotReadResultSchema)
      );
      expect(mapped.isError).toBe(false);
      expect(programVocabularySnapshotReadResultSchema.parse(mapped.structuredContent))
        .toEqual(programVocabularySnapshotReadResultSchema.parse(result));
      expect(target.protectedReadCount()).toBe(1);
      expect(target.handledSurfaces).toEqual(['external_mcp']);
    } finally {
      target.sqlite.close();
    }
  });
});
