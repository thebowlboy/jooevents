import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type InvocationEvidence,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt
} from '@jooevents/application';
import { WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS } from '@jooevents/contracts';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY,
  createWorkspaceShellSummaryOperationModule
} from './shell-summary-module';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  correlation: '018f7d5a-4b3c-7abc-8def-0123456789a7'
} as const;
const now = parseInstant('2026-08-16T08:30:00.000Z');
const profile = { key: 'workspace-shell-summary-test', version: parseContractVersion(1) } as const;
const projection = {
  schemaVersion: 1 as const,
  workspace: { id: ids.workspace, name: 'Summit Operations' },
  event: null
};

class UnusedUnitOfWork implements EffectUnitOfWorkPort {
  findTerminalReceipt(): TerminalEffectReceipt | undefined { return undefined; }
  recordShortOperationAudit(_record: ShortOperationAuditRecord): void {}
  async runInUnitOfWork<Value>(_work: (unitOfWork: EffectUnitOfWork) => Promise<Value>) {
    return Promise.reject(new TypeError('unused'));
  }
}

function fixture(options: { readonly denied?: boolean; readonly wrongPolicy?: boolean } = {}) {
  let invocation = 0;
  const module = createWorkspaceShellSummaryOperationModule({
    workspaceId: ids.workspace,
    policy: options.wrongPolicy
      ? { key: 'authority.workspace.shell.summary.wrong', version: parseContractVersion(1) }
      : WORKSPACE_SHELL_SUMMARY_READ_ACCESS_POLICY,
    currentAuthority: {
      resolve(resolution) {
        if (options.denied) return { kind: 'denied', reason: 'not_authorized' };
        if (resolution.evidence.kind !== 'operator') {
          return { kind: 'denied', reason: 'lane_mismatch' };
        }
        return {
          kind: 'authorized',
          authority: {
            actor: { kind: 'workspace_user', userId: ids.user },
            principal: {
              kind: 'workspace_user', userId: ids.user, membershipId: ids.membership
            },
            lane: resolution.lane,
            scope: resolution.scope,
            grants: [{ kind: 'permission', key: 'event.read' }],
            evidenceIds: ['membership.current'],
            authorityCitationIds: [],
            evaluatedAt: resolution.evaluatedAt
          }
        };
      }
    },
    read: { readSummary: () => projection },
    clock: { now: () => now },
    ids: {
      newInvocationId: () => parseInvocationId(
        `018f7d5a-4b3c-7abc-8def-${(invocation++ + 100).toString().padStart(12, '0')}`
      )
    },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile
    }
  });
  const evidence: InvocationEvidence = {
    kind: 'operator',
    surface: 'operator_http',
    client: { key: 'web.operator' },
    sessionHandle: 'session-current'
  };
  return { module, evidence };
}

async function runtime(input: ReturnType<typeof fixture>) {
  return createApplicationOperationRuntime({
    source: input.module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId(crypto.randomUUID())
    },
    unitOfWork: new UnusedUnitOfWork()
  });
}

describe('workspace shell summary operation', () => {
  test('publishes one deterministic low-risk operator read with exact schemas', async () => {
    const first = await runtime(fixture());
    const second = await runtime(fixture());
    expect(first.registry.manifestDigestSha256).toBe(second.registry.manifestDigestSha256);
    expect(first.registry.operatorHttpBindings).toEqual([{
      operationName: 'workspace.shell.summary.read',
      operationVersion: 1,
      surface: 'operator_http',
      method: 'GET',
      path: '/api/workspace/shell-summary',
      input: 'query'
    }]);
    const operation = first.registry.safeManifest.operations[0];
    expect(operation?.inputSchema)
      .toEqual(WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.inputSchema);
    expect(operation?.enabledBindings[0]?.resultSchema)
      .toEqual(WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS.read.resultSchema);
  });

  test('reads through current authority and returns the compact projection', async () => {
    const input = fixture();
    const operations = await runtime(input);
    expect(await operations.readExecutor.execute({
      operationName: 'workspace.shell.summary.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: ids.correlation,
      businessInput: {},
      verifiedEvidence: input.evidence
    })).toEqual({ kind: 'success', data: projection, correlationId: ids.correlation });
  });

  test('returns typed current-authority denial and rejects policy substitution', async () => {
    expect(() => fixture({ wrongPolicy: true }))
      .toThrow('workspace_shell_summary_policy_catalog_mismatch');
    const input = fixture({ denied: true });
    const operations = await runtime(input);
    expect(await operations.readExecutor.execute({
      operationName: 'workspace.shell.summary.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: ids.correlation,
      businessInput: {},
      verifiedEvidence: input.evidence
    })).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.not_authorized' }
    });
  });
});
