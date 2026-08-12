import { afterEach, describe, expect, test } from 'bun:test';
import {
  createOperationAutonomyPolicy,
  createReadImmutableAuditRecord,
  createReadInvocationContextBuilder,
  createReadOperationExecutor,
  createReadOperationRegistry,
  OperationExecutionError,
  type ReadImmutableAuditRecord,
  type ReadOperationDefinition,
  type ReadOperationRegistrySource,
  type ReadOperationalTraceRecord
} from '@jooevents/application';
import {
  readOperationResultSchema,
  versionedDefinitionRefSchema,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  canonicalJsonText,
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
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReadImmutableAuditConflictError,
  SQLiteTrialReadImmutableAuditPort,
  installReadImmutableAuditTrialSchema
} from './read-immutable-audit-trial';

function definitionRef(key: string, version = 1): VersionedDefinitionRef {
  return { key, version };
}

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: seed.repeat(64) };
}

const refs = {
  input: schemaRef('schema.read-audit-trial.input', '1'),
  canonical: schemaRef('schema.read-audit-trial.canonical', '2'),
  projected: schemaRef('schema.read-audit-trial.projected', '3'),
  context: definitionRef('context.read-audit-trial'),
  autonomy: definitionRef('autonomy.read-audit-trial'),
  capability: definitionRef('capability.read-audit-trial'),
  handler: definitionRef('handler.read-audit-trial'),
  projection: definitionRef('projection.read-audit-trial'),
  trace: definitionRef('trace.read-audit-trial'),
  audit: definitionRef('audit.read-audit-trial'),
  recordProfile: definitionRef('record-profile.read-audit-trial')
} as const;

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  agentRun: parseAgentRunId('01890f47-9abc-7def-8123-456789abc003'),
  modelAttempt: parseModelAttemptId('01890f47-9abc-7def-8123-456789abc004'),
  modelToolCall: parseModelToolCallId('01890f47-9abc-7def-8123-456789abc005'),
  invocation: parseInvocationId('018f0f47-7a86-7d36-8a25-9f86589c7b40')
} as const;

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const recordedAt = parseInstant('2026-08-11T00:00:00.000Z');
const keyProfile = {
  key: 'read-audit-trial-key-profile',
  version: parseContractVersion(1)
} as const;
const externalMcpLane = parseOperationAccessLane({
  kind: 'external_mcp',
  surface: 'external_mcp',
  policy: { key: 'authority.read-audit-trial.external-mcp', version: 1 }
});
const appModelLane = parseOperationAccessLane({
  kind: 'app_model',
  surface: 'app_model',
  policy: { key: 'authority.read-audit-trial.app-model', version: 1 }
});
const auditTarget = {
  reference: refs.audit,
  kind: 'operation_audit_record' as const,
  recordProfile: refs.recordProfile
};
const traceTarget = {
  reference: refs.trace,
  kind: 'read_operational_trace_record' as const,
  recordProfile: refs.recordProfile
};
const recordProfile = {
  reference: refs.recordProfile,
  kind: 'canonical_json' as const,
  maximumBytes: 32_768
};

const readDefinition: ReadOperationDefinition = {
  name: 'trial.audit.read',
  version: 1,
  lifecycle: { status: 'active' },
  summary: 'Read through the immutable audit trial.',
  effect: 'read',
  maxRisk: 'low',
  autonomyPolicy: refs.autonomy,
  consequenceTags: ['classified-read'],
  inputSchema: refs.input,
  canonicalResultSchema: refs.canonical,
  outcomes: [],
  accessLanes: [externalMcpLane, appModelLane],
  contextBuilder: refs.context,
  readCapability: refs.capability,
  handler: refs.handler,
  observability: {
    trace: { mode: 'required', target: refs.trace },
    immutableAudit: { mode: 'external_mcp_app_model', target: refs.audit }
  },
  bindings: [
    {
      surface: 'external_mcp',
      toolName: 'trial_audit_read',
      projection: refs.projection
    },
    {
      surface: 'app_model',
      toolName: 'trial_audit_read_for_model',
      projection: refs.projection
    }
  ]
};

function contextBuilder(nextInvocationId = () => ids.invocation) {
  return createReadInvocationContextBuilder({
    reference: refs.context,
    operation: { name: readDefinition.name, version: readDefinition.version },
    effect: 'read',
    lanes: readDefinition.accessLanes,
    scopeResolver: {
      resolve: () => ({
        workspaceId: ids.workspace,
        subjects: [{ kind: 'workspace', id: ids.workspace }],
        resolutionEvidenceIds: ['scope-current:v1']
      })
    },
    authorityResolver: {
      resolve(input) {
        const actor = input.evidence.kind === 'external_mcp'
          ? {
              kind: 'external_mcp_client' as const,
              oauthClientId: input.evidence.oauthClientId,
              authorityPrincipalId: 'principal-read-audit-trial'
            }
          : input.evidence.kind === 'app_model'
            ? {
                kind: 'app_model_run' as const,
                agentRunId: input.evidence.agentRunId,
                delegatedByPrincipalId: 'principal-read-audit-trial'
              }
            : undefined;
        if (!actor) return { kind: 'denied' as const, reason: 'lane_mismatch' as const };
        return {
          kind: 'authorized' as const,
          authority: {
            actor,
            principal: {
              kind: 'workspace_user' as const,
              userId: ids.user,
              membershipId: ids.membership
            },
            lane: input.lane,
            scope: input.scope,
            grants: [{ kind: 'permission' as const, key: 'trial.audit.read' }],
            evidenceIds: ['authority-current:v1'],
            authorityCitationIds: [],
            evaluatedAt: input.evaluatedAt
          }
        };
      }
    },
    clock: { now: () => recordedAt },
    newInvocationId: nextInvocationId,
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    deniedAuthorityOutcome: () => ({
      class: 'access_denied',
      kind: 'trial.audit.not_authorized',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
}

const sourceCanaries = [
  'business-input-canary',
  'result-canary',
  'detail-canary',
  'request-hash-canary',
  'raw-credential-canary',
  'provider-text-canary'
] as const;

async function sealedAuditRecords(): Promise<{
  readonly original: ReadImmutableAuditRecord;
  readonly conflicting: ReadImmutableAuditRecord;
}> {
  const resolution = await contextBuilder().build({
    operationName: readDefinition.name,
    operationVersion: readDefinition.version,
    surface: 'external_mcp',
    correlationId,
    businessInput: {
      query: sourceCanaries[0],
      result: sourceCanaries[1],
      detail: sourceCanaries[2],
      requestHash: sourceCanaries[3],
      providerText: sourceCanaries[5]
    },
    verifiedEvidence: {
      kind: 'external_mcp',
      surface: 'external_mcp',
      client: { key: 'read-audit-trial-client' },
      oauthTokenHandle: sourceCanaries[4],
      oauthClientId: 'client.read-audit-trial'
    }
  });
  if (resolution.kind !== 'ready') throw new Error('expected a ready read context');
  const shared = {
    kind: 'authorized' as const,
    definition: readDefinition,
    context: resolution.context,
    auditTarget,
    recordProfile
  };
  return {
    original: createReadImmutableAuditRecord({
      ...shared,
      resultSummary: { kind: 'success' }
    }),
    conflicting: createReadImmutableAuditRecord({
      ...shared,
      resultSummary: { kind: 'internal_failure', phase: 'handler' }
    })
  };
}

function cellText(value: unknown): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Includes every cell in every _trial table plus every _trial sqlite_schema cell. */
function everyTrialSqlCell(sqlite: Database): string {
  const schemaRows = sqlite.query<Record<string, unknown>, []>(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_schema
     WHERE name GLOB '_trial*'
     ORDER BY type, name
  `).all();
  const cells = schemaRows.flatMap((row) => Object.values(row).map(cellText));
  for (const row of schemaRows) {
    if (row.type !== 'table' || typeof row.name !== 'string') continue;
    const columns = sqlite.query<{ readonly name: string }, []>(
      `PRAGMA table_info(${quotedIdentifier(row.name)})`
    ).all().map((column) => column.name);
    const selection = columns.map(quotedIdentifier).join(', ');
    const rows = sqlite.query<Record<string, unknown>, []>(
      `SELECT ${selection} FROM ${quotedIdentifier(row.name)}`
    ).all();
    cells.push(...rows.flatMap((value) => Object.values(value).map(cellText)));
  }
  return cells.join('\n');
}

function storedBytes(sqlite: Database): Uint8Array {
  const row = sqlite.query<{ readonly canonical_record_bytes: Uint8Array }, []>(`
    SELECT canonical_record_bytes FROM _trial_read_immutable_audits
  `).get();
  if (!row) throw new Error('expected a stored audit row');
  return Uint8Array.from(row.canonical_record_bytes);
}

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('file-backed immutable read-audit trial', () => {
  test('persists exact canonical bytes across restart and refuses conflict, update, and delete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-read-audit-trial-'));
    temporaryDirectories.add(directory);
    const path = join(directory, 'read-audit.sqlite');
    const records = await sealedAuditRecords();

    let sqlite = new Database(path, { strict: true, create: true });
    try {
      installReadImmutableAuditTrialSchema(sqlite);
      const port = new SQLiteTrialReadImmutableAuditPort(sqlite);
      port.append(records.original);
      const originalBytes = storedBytes(sqlite);

      port.append(records.original);
      expect(sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM _trial_read_immutable_audits'
      ).get()?.count).toBe(1);
      expect(storedBytes(sqlite)).toEqual(originalBytes);

      expect(() => port.append(records.conflicting)).toThrow(ReadImmutableAuditConflictError);
      expect(storedBytes(sqlite)).toEqual(originalBytes);
      sqlite.close();

      sqlite = new Database(path, { strict: true });
      const reopenedPort = new SQLiteTrialReadImmutableAuditPort(sqlite);
      expect(storedBytes(sqlite)).toEqual(originalBytes);
      reopenedPort.append(records.original);
      expect(sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM _trial_read_immutable_audits'
      ).get()?.count).toBe(1);
      expect(storedBytes(sqlite)).toEqual(originalBytes);

      expect(() => sqlite.query(`
        UPDATE _trial_read_immutable_audits SET audit_target_version = 2
      `).run()).toThrow('append-only');
      expect(() => sqlite.query('DELETE FROM _trial_read_immutable_audits').run())
        .toThrow('append-only');
      expect(storedBytes(sqlite)).toEqual(originalBytes);

      const allCells = everyTrialSqlCell(sqlite);
      for (const canary of sourceCanaries) expect(allCells).not.toContain(canary);
      expect(allCells).not.toContain('requestHashSha256');
      expect(allCells).not.toContain('authorityPrincipalKey');
      expect(allCells).toContain(canonicalJsonText(records.original));
    } finally {
      if (sqlite) sqlite.close(false);
    }
  });

  test('a SQLite append failure prevents a registered machine read from disclosing its result', async () => {
    const sqlite = new Database(':memory:', { strict: true });
    try {
      installReadImmutableAuditTrialSchema(sqlite);
      sqlite.exec(`
        CREATE TRIGGER _trial_read_immutable_audits_injected_insert_failure
        BEFORE INSERT ON _trial_read_immutable_audits
        BEGIN
          SELECT RAISE(ABORT, 'injected audit persistence failure');
        END;
      `);
      let handlerCalls = 0;
      const builder = contextBuilder();
      const source: ReadOperationRegistrySource = {
        autonomyPolicies: [createOperationAutonomyPolicy({
          definition: refs.autonomy,
          operation: { name: readDefinition.name, version: readDefinition.version },
          riskFloor: 'low',
          unattendedRiskCeiling: 'low',
          supportedDispositions: [
            'proceed',
            'safe_retry',
            'reconcile',
            'renewed_approval',
            'replan',
            'compensate',
            'block',
            'attention'
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
          { reference: refs.input, schema: versionedDefinitionRefSchema },
          { reference: refs.canonical, schema: readOperationResultSchema },
          { reference: refs.projected, schema: readOperationResultSchema }
        ],
        contextBuilders: [builder],
        readCapabilities: [{
          reference: refs.capability,
          openSnapshot: () => ({ current: true })
        }],
        handlers: [{
          reference: refs.handler,
          readCapability: refs.capability,
          canonicalResultSchema: refs.canonical,
          handle: ({ context }) => {
            handlerCalls += 1;
            return {
              kind: 'success',
              data: { value: sourceCanaries[1], providerText: sourceCanaries[5] },
              correlationId: context.correlationId
            };
          }
        }],
        projections: [{
          reference: refs.projection,
          canonicalResultSchema: refs.canonical,
          projectedResultSchema: refs.projected,
          project: () => ({
            kind: 'success',
            data: { value: 'would-have-been-disclosed' },
            correlationId
          })
        }],
        readOperationalTraceTargets: [traceTarget],
        operationAuditTargets: [auditTarget],
        operationAuditRecordProfiles: [recordProfile],
        operations: [readDefinition]
      };
      const registry = await createReadOperationRegistry(source);
      const traces: ReadOperationalTraceRecord[] = [];
      const executor = createReadOperationExecutor(registry, {
        operationalTrace: { emit: (record) => traces.push(record) },
        immutableAudit: new SQLiteTrialReadImmutableAuditPort(sqlite),
        clock: { now: () => recordedAt },
        newInvocationId: () => ids.invocation
      });

      let disclosed: unknown;
      try {
        disclosed = await executor.execute({
          operationName: readDefinition.name,
          operationVersion: readDefinition.version,
          surface: 'external_mcp',
          correlationId,
          businessInput: { key: 'query.read-audit-trial', version: 1 },
          verifiedEvidence: {
            kind: 'external_mcp',
            surface: 'external_mcp',
            client: { key: 'read-audit-trial-client' },
            oauthTokenHandle: sourceCanaries[4],
            oauthClientId: 'client.read-audit-trial'
          }
        });
      } catch (error) {
        expect(error).toBeInstanceOf(OperationExecutionError);
        expect(error).toMatchObject({ phase: 'read_immutable_audit' });
        expect((error as OperationExecutionError).cause).toBeInstanceOf(Error);
        expect(((error as OperationExecutionError).cause as Error).message)
          .toContain('injected audit persistence failure');
      }
      expect(disclosed).toBeUndefined();
      expect(handlerCalls).toBe(1);
      expect(sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM _trial_read_immutable_audits'
      ).get()?.count).toBe(0);
      expect(traces).toHaveLength(1);
      expect(traces[0]?.resultSummary).toEqual({
        kind: 'internal_failure',
        phase: 'immutable_audit'
      });
      const traceBytes = canonicalJsonText(traces[0]);
      for (const canary of sourceCanaries) expect(traceBytes).not.toContain(canary);
      const allCells = everyTrialSqlCell(sqlite);
      for (const canary of sourceCanaries) expect(allCells).not.toContain(canary);
    } finally {
      sqlite.close();
    }
  });
});
