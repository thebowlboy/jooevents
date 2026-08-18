import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt,
  type InvocationEvidence
} from '@jooevents/application';
import {
  WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS,
  workspaceOverviewReadInputSchema,
  type WorkspaceOverviewProjection
} from '@jooevents/contracts/workspace-overview';
import {
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseContractVersion,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG,
  WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
  createWorkspaceOverviewOperationModule
} from './module';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  correlation: '018f7d5a-4b3c-7abc-8def-0123456789a7'
} as const;
const now = parseInstant('2026-08-12T08:30:00.000Z');
const profile = {
  key: 'workspace-overview-test',
  version: parseContractVersion(1)
} as const;
const projection: WorkspaceOverviewProjection = {
  schemaVersion: 1,
  event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 1 },
  areas: DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.map((entry) => (
    entry.area !== 'overview'
      && entry.area !== 'settings'
      && (entry.status === 'available' || entry.status === 'partial')
      ? { area: entry.area, status: 'locked', reason: 'event_required' }
      : entry
  )),
  metrics: {
    forms: { kind: 'unavailable', reason: 'event_required' },
    submissions: { kind: 'unavailable', reason: 'event_required' },
    programVocabulary: { kind: 'unavailable', reason: 'event_required' },
    operations: { kind: 'unavailable', reason: 'event_required' },
    triage: { kind: 'unavailable', reason: 'event_required' },
    reviews: { kind: 'unavailable', reason: 'event_required' },
    reviewers: { kind: 'unavailable', reason: 'event_required' },
    decisions: { kind: 'unavailable', reason: 'event_required' },
    engagements: { kind: 'unavailable', reason: 'event_required' },
    sessions: { kind: 'unavailable', reason: 'event_required' },
    communications: { kind: 'unavailable', reason: 'event_required' },
    templates: { kind: 'unavailable', reason: 'event_required' }
  },
  history: { total: 0, truncated: false, threads: [] }
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
  const module = createWorkspaceOverviewOperationModule({
    workspaceId: ids.workspace,
    policy: options.wrongPolicy
      ? { key: 'authority.workspace.overview.wrong', version: parseContractVersion(1) }
      : WORKSPACE_OVERVIEW_READ_ACCESS_POLICY,
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
              kind: 'workspace_user',
              userId: ids.user,
              membershipId: ids.membership
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
    overviewRead: { readOverview: () => projection },
    clock: { now: () => now },
    ids: {
      newInvocationId: () => parseInvocationId(
        `018f7d5a-4b3c-7abc-8def-${(invocation++ + 100).toString().padStart(12, '0')}`
      )
    },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile
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

describe('workspace overview operation', () => {
  test('advertises the mounted triage and Field Registry capabilities', () => {
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'submissions'
    )).toEqual({
      area: 'submissions',
      status: 'partial',
      availableCapabilities: [
        'submission.contact.list',
        'submission.contact.read',
        'submission.direct_entry.create',
        'submission.list',
        'submission.read',
        'submission.triage'
      ],
      unavailableCapabilities: ['submission.decision', 'submission.review']
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'schedule'
    )).toEqual({
      area: 'schedule',
      status: 'partial',
      availableCapabilities: [
        'release.change.draft',
        'schedule.placement',
        'schedule.placement.snapshot.read',
        'session.catalog.read',
        'session.change'
      ],
      unavailableCapabilities: ['schedule.break.manage']
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'tasks'
    )).toEqual({
      area: 'tasks',
      status: 'partial',
      availableCapabilities: ['task.board.read', 'task.mutation'],
      unavailableCapabilities: ['task.reminder.send']
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'embeds'
    )).toEqual({
      area: 'embeds',
      status: 'partial',
      availableCapabilities: ['embed.frame_allowlist.draft'],
      unavailableCapabilities: ['embed.document.render', 'embed.loader.serve']
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'messages'
    )).toEqual({
      area: 'messages',
      status: 'partial',
      availableCapabilities: [
        'communication.email_readiness.read',
        'create_message_draft',
        'discard_message_draft',
        'get_communication_purpose',
        'get_delivery_history',
        'get_delivery_timeline',
        'get_message_batch_preview',
        'get_message_draft',
        'get_message_template',
        'get_person_thread',
        'list_audience_options',
        'list_communication_purposes',
        'list_message_attention_items',
        'list_message_drafts',
        'list_message_preview_recipients',
        'list_message_templates',
        'message_template.create',
        'prepare_message_batch_preview',
        'preview_message_batch',
        'retry_message_delivery',
        'revise_message_batch',
        'send_messages',
        'store_communication_authoring_payload'
      ],
      unavailableCapabilities: [
        'create_email_provider_connection_draft'
      ]
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'review'
    )).toEqual({
      area: 'review',
      status: 'partial',
      availableCapabilities: [
        'review.assignment.step_back',
        'review.evaluation.change',
        'review.evaluation.draft.save',
        'review.round.change',
        'review.round.setup.read',
        'review.snapshot.read'
      ],
      unavailableCapabilities: ['review.comparison.read', 'submission.decision.commit']
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'decisions'
    )).toEqual({
      area: 'decisions',
      status: 'available',
      capabilities: [
        'decision.decide',
        'decision.notification.send',
        'decision.state.read'
      ]
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'speakers'
    )).toEqual({
      area: 'speakers',
      status: 'partial',
      availableCapabilities: [
        'engagement.change',
        'engagement.snapshot.read'
      ],
      unavailableCapabilities: [
        'speaker.category.manage',
        'speaker.lineup.manage'
      ]
    });
    expect(DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'reviewers'
    )).toEqual({
      area: 'reviewers',
      status: 'partial',
      availableCapabilities: [
        'reviewer_roster.change',
        'reviewer_roster.snapshot.read'
      ],
      unavailableCapabilities: ['reviewer_roster.delivery.activate']
    });
    const settings = DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG.find(
      (entry) => entry.area === 'settings'
    );
    expect(settings?.status).toBe('partial');
    if (settings?.status !== 'partial') throw new TypeError('expected partial settings area');
    expect(settings.availableCapabilities).toContain('field_registry.snapshot.read');
    expect(settings.availableCapabilities).toContain('field_registry.add.draft');
    expect(settings.availableCapabilities).toContain('field_registry.restore.draft');
    expect(settings.availableCapabilities).toContain('workspace_team.members.read');
    expect(settings.availableCapabilities).toContain('workspace_team.invite');
    expect(settings.availableCapabilities).toContain('communication.sender_identity.read');
    expect(settings.availableCapabilities).toContain('communication.sender_identity.update');
    expect(settings.unavailableCapabilities).toEqual([
      'workspace_team.delivery.activate',
      'workspace_team.session_revocation.activate'
    ]);
  });

  test('publishes one deterministic operator read with exact schemas', async () => {
    const first = await runtime(fixture());
    const second = await runtime(fixture());
    expect(first.registry.manifestDigestSha256).toBe(second.registry.manifestDigestSha256);
    expect(first.registry.operatorHttpBindings).toEqual([{
      operationName: 'workspace.overview.read',
      operationVersion: 1,
      surface: 'operator_http',
      method: 'GET',
      path: '/api/workspace/overview',
      input: 'query'
    }]);
    const operation = first.registry.safeManifest.operations[0];
    expect(operation?.inputSchema).toEqual(
      WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.inputSchema
    );
    expect(operation?.enabledBindings[0]?.resultSchema).toEqual(
      WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.resultSchema
    );
  });

  test('reads no-Event state through current authority and rejects caller scope', async () => {
    const input = fixture();
    const operations = await runtime(input);
    const result = await operations.readExecutor.execute({
      operationName: 'workspace.overview.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: ids.correlation,
      businessInput: {},
      verifiedEvidence: input.evidence
    });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new TypeError('expected success');
    expect(JSON.stringify(result.data)).toBe(JSON.stringify(projection));
    expect(result.correlationId).toBe(ids.correlation);
    expect(workspaceOverviewReadInputSchema.safeParse({ workspaceId: ids.workspace }).success)
      .toBe(false);
    expect(workspaceOverviewReadInputSchema.safeParse({ authority: 'event.read' }).success)
      .toBe(false);
  });

  test('returns current authority denial and rejects policy substitution', async () => {
    expect(() => fixture({ wrongPolicy: true }))
      .toThrow('workspace_overview_operation_policy_catalog_mismatch');
    const input = fixture({ denied: true });
    const operations = await runtime(input);
    expect(await operations.readExecutor.execute({
      operationName: 'workspace.overview.read',
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
