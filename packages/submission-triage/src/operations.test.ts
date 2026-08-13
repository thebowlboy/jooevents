import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type InvocationEvidence,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  parseContractVersion,
  parseCorrelationId,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  SUBMISSION_TRIAGE_HTTP_PATHS,
  SUBMISSION_TRIAGE_LIST_OPERATION,
  SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY,
  SUBMISSION_TRIAGE_MCP_TOOLS,
  SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
  SUBMISSION_TRIAGE_READ_OPERATION,
  createSubmissionTriageInitialization,
  createSubmissionTriageReadOperationModule,
  createSubmissionTriageState,
  type SubmissionTriageReadPort,
  type SubmissionTriageScope,
  type SubmissionTriageSourcePort
} from '.';
import {
  SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS,
  submissionTriageSourceRowSchema
} from '@jooevents/contracts/submission-triage';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('01890f47-9abc-7def-8123-456789abcdef');
const submissionId = '01890f47-9abc-7def-8123-456789abc001';
const formId = '01890f47-9abc-7def-8123-456789abc002';
const formVersionId = '01890f47-9abc-7def-8123-456789abc003';
const fieldId = '01890f47-9abc-7def-8123-456789abc004';
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc005');
const membershipId = parseMembershipId('01890f47-9abc-7def-8123-456789abc006');
const now = parseInstant('2026-08-13T10:00:00.000Z');
const profile = { key: 'submission-triage-read-test', version: parseContractVersion(1) } as const;

class UnusedUnitOfWork implements EffectUnitOfWorkPort {
  findTerminalReceipt(): TerminalEffectReceipt | undefined { return undefined; }
  recordShortOperationAudit(_record: ShortOperationAuditRecord): void {}
  runInUnitOfWork<Value>(_work: (unitOfWork: EffectUnitOfWork) => Promise<Value>) {
    return Promise.reject(new TypeError('unused'));
  }
}

function readPort(): SubmissionTriageReadPort {
  const source = submissionTriageSourceRowSchema.parse({
    schemaVersion: 1, scope: { workspaceId, eventId }, source: 'public_form',
    summary: {
      schemaVersion: 1, id: submissionId, formId, formVersionId,
      target: { kind: 'general_pool' }, title: 'Encrypted Kubernetes',
      primaryParticipantName: 'José Sørensen', submittedAt: now
    },
    detail: {
      schemaVersion: 1, submissionId, formId, formVersionId, submittedAt: now,
      participantCount: 1,
      answers: [{ kind: 'text', fieldId, fieldLabel: 'Session title', value: 'Encrypted Kubernetes' }],
      affirmedConsentFieldIds: []
    },
    abstract: 'Practical distributed systems', track: null, format: null
  });
  const initialized = createSubmissionTriageInitialization({
    scope: { workspaceId, eventId },
    submission: { id: submissionId, formId, formVersionId, source: 'public_form', submittedAt: now },
    arrivalId: '01890f47-9abc-7def-8123-456789abc007', recordedAt: now, closeEvidence: null
  });
  const state = createSubmissionTriageState({
    scope: { workspaceId, eventId }, version: 2, entries: [initialized]
  });
  return {
    listSourceRows(scope: SubmissionTriageScope) {
      return scope.workspaceId === workspaceId && scope.eventId === eventId ? [source] : [];
    },
    readSourceRow(scope: SubmissionTriageScope, candidate: string) {
      return candidate === submissionId ? this.listSourceRows(scope)[0] : undefined;
    },
    readTriageState(scope: SubmissionTriageScope) {
      return scope.workspaceId === workspaceId && scope.eventId === eventId ? state : undefined;
    }
  };
}

function moduleFixture(options: { readonly event?: boolean; readonly denied?: boolean } = {}) {
  let invocation = 0;
  const module = createSubmissionTriageReadOperationModule({
    workspaceId,
    policies: {
      operatorRead: SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
      externalMcpRead: SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY
    },
    currentAuthority: {
      resolve(input) {
        if (options.denied) return { kind: 'denied', reason: 'revoked' };
        const expectedSurface = input.evidence.kind === 'operator' ? 'operator_http' : 'external_mcp';
        if (input.lane.surface !== expectedSurface) return { kind: 'denied', reason: 'lane_mismatch' };
        const actor = input.evidence.kind === 'external_mcp'
          ? {
              kind: 'external_mcp_client' as const,
              oauthClientId: input.evidence.oauthClientId,
              authorityPrincipalId: `workspace_user:${userId}`
            }
          : { kind: 'workspace_user' as const, userId };
        return {
          kind: 'authorized',
          authority: {
            actor,
            principal: { kind: 'workspace_user', userId, membershipId },
            lane: input.lane, scope: input.scope,
            grants: [{ kind: 'permission', key: 'event.read' }],
            evidenceIds: ['membership.current'], authorityCitationIds: [],
            evaluatedAt: input.evaluatedAt
          }
        };
      }
    },
    currentEvent: {
      resolveCurrentEvent: () => options.event === false
        ? { evidenceIds: ['event:none'] }
        : { eventId, evidenceIds: ['event:current'] }
    },
    read: readPort(), clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(
      `018f7d5a-4b3c-7abc-8def-${(++invocation).toString().padStart(12, '0')}`
    ) },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile
    }
  });
  return module;
}

async function runtime(module: ReturnType<typeof moduleFixture>, audits: unknown[]) {
  return createApplicationOperationRuntime({
    source: module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append(record) { audits.push(record); } },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId('018f7d5a-4b3c-7abc-8def-012345678999')
    },
    unitOfWork: new UnusedUnitOfWork()
  });
}

const operatorEvidence: InvocationEvidence = {
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'current-session'
};
const mcpEvidence: InvocationEvidence = {
  kind: 'external_mcp', surface: 'external_mcp', client: { key: 'mcp.agent' },
  oauthTokenHandle: 'current-mcp-token', oauthClientId: 'mcp-client'
};

describe('submission triage read operations', () => {
  test('freezes the operator endpoints and read-only MCP tools against exact schemas', async () => {
    const first = await runtime(moduleFixture(), []);
    const second = await runtime(moduleFixture(), []);
    expect(first.registry.manifestDigestSha256).toBe(second.registry.manifestDigestSha256);
    expect(first.registry.operatorHttpBindings).toEqual([
      {
        operationName: SUBMISSION_TRIAGE_LIST_OPERATION.name, operationVersion: 1,
        surface: 'operator_http', method: 'GET', path: SUBMISSION_TRIAGE_HTTP_PATHS.list,
        input: 'query'
      },
      {
        operationName: SUBMISSION_TRIAGE_READ_OPERATION.name, operationVersion: 1,
        surface: 'operator_http', method: 'GET', path: SUBMISSION_TRIAGE_HTTP_PATHS.read,
        input: 'query'
      }
    ]);
    expect(first.registry.safeManifest.operations.flatMap((operation) =>
      operation.enabledBindings
        .filter((binding) => binding.surface === 'external_mcp')
        .map((binding) => ({ operationName: operation.name, toolName: binding.toolName }))
    )).toEqual([
      { operationName: SUBMISSION_TRIAGE_LIST_OPERATION.name, toolName: SUBMISSION_TRIAGE_MCP_TOOLS.list },
      { operationName: SUBMISSION_TRIAGE_READ_OPERATION.name, toolName: SUBMISSION_TRIAGE_MCP_TOOLS.read }
    ]);
    const manifests = first.registry.safeManifest.operations;
    expect(manifests.map((operation) => operation.inputSchema)).toEqual([
      SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.list.inputSchema,
      SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.read.inputSchema
    ]);
    expect(manifests.every((operation) => operation.effect === 'read')).toBe(true);
  });

  test('projects only safe fields and writes immutable audit for MCP but not ordinary operator reads', async () => {
    const audits: unknown[] = [];
    const operations = await runtime(moduleFixture(), audits);
    const operatorResult = await operations.readExecutor.execute({
      operationName: SUBMISSION_TRIAGE_LIST_OPERATION.name, operationVersion: 1,
      surface: 'operator_http',
      correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678901'),
      businessInput: { search: 'sorensen' }, verifiedEvidence: operatorEvidence
    });
    expect(operatorResult).toMatchObject({
      kind: 'success', data: { rows: [{ visibleTray: 'inbox' }], trayTotals: { inbox: 1 } }
    });
    expect(JSON.stringify(operatorResult)).not.toContain('@');
    expect(audits).toHaveLength(0);
    const mcpResult = await operations.readExecutor.execute({
      operationName: SUBMISSION_TRIAGE_READ_OPERATION.name, operationVersion: 1,
      surface: 'external_mcp',
      correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678902'),
      businessInput: { submissionId }, verifiedEvidence: mcpEvidence
    });
    expect(mcpResult).toMatchObject({
      kind: 'success', data: { row: { source: { summary: { id: submissionId } } } }
    });
    expect(audits).toHaveLength(1);
  });

  test('returns event-required without touching state and current authority can revoke either lane', async () => {
    const noEvent = await runtime(moduleFixture({ event: false }), []);
    await expect(noEvent.readExecutor.execute({
      operationName: SUBMISSION_TRIAGE_LIST_OPERATION.name, operationVersion: 1,
      surface: 'operator_http',
      correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678903'),
      businessInput: {}, verifiedEvidence: operatorEvidence
    })).resolves.toMatchObject({
      kind: 'outcome', outcome: { kind: 'submission_triage.event_required' }
    });
    const revoked = await runtime(moduleFixture({ denied: true }), []);
    await expect(revoked.readExecutor.execute({
      operationName: SUBMISSION_TRIAGE_LIST_OPERATION.name, operationVersion: 1,
      surface: 'external_mcp',
      correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678904'),
      businessInput: {}, verifiedEvidence: mcpEvidence
    })).resolves.toMatchObject({
      kind: 'outcome', outcome: { class: 'access_denied', kind: 'authority.revoked' }
    });
  });

  test('fails closed on substituted policy identities', () => {
    expect(() => createSubmissionTriageReadOperationModule({
      workspaceId,
      policies: {
        operatorRead: SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY,
        externalMcpRead: SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY
      },
      currentAuthority: { resolve: () => ({ kind: 'denied', reason: 'revoked' }) },
      currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: [] }) },
      read: readPort(), clock: { now: () => now },
      ids: { newInvocationId: () => parseInvocationId('018f7d5a-4b3c-7abc-8def-012345678905') },
      crypto: {
        authorityPrincipalKeyProfile: profile,
        scopePartitionProfile: profile,
        requestCanonicalizationProfile: profile
      }
    })).toThrow('submission_triage_operator_read_policy_catalog_mismatch');
  });
});
