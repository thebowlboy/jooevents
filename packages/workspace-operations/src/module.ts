import {
  createOperationAutonomyPolicy,
  createReadInvocationContextBuilder,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext
} from '@jooevents/application';
import {
  createSafeSchemaManifestRef,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS,
  workspaceOverviewCanonicalResultSchema,
  workspaceOverviewProjectionSchema,
  workspaceOverviewReadInputSchema,
  workspaceOverviewReadResultSchema,
  workspaceOverviewAreaCatalogSchema,
  type WorkspaceOverviewAreaCatalog,
  type WorkspaceOverviewProjection
} from '@jooevents/contracts/workspace-overview';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

export const WORKSPACE_OVERVIEW_READ_OPERATION = Object.freeze({
  name: 'workspace.overview.read',
  version: 1
});

export const WORKSPACE_OVERVIEW_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.workspace.overview.read',
  version: parseContractVersion(1)
});

export const DEFAULT_WORKSPACE_OVERVIEW_AREA_CATALOG: WorkspaceOverviewAreaCatalog =
  workspaceOverviewAreaCatalogSchema.parse([
    {
      area: 'overview',
      status: 'available',
      capabilities: [
        'operation.history.list',
        'workspace.overview.read',
        'workspace.shell.summary.read'
      ]
    },
    {
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
    },
    {
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
    },
    {
      area: 'decisions',
      status: 'available',
      // Notification review and send ride the mounted communication send
      // lane (prepare/adopt preview + send_messages); with no outbound
      // provider activated every delivery still lands honestly not-delivered.
      capabilities: [
        'decision.decide',
        'decision.notification.send',
        'decision.state.read'
      ]
    },
    {
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
    },
    {
      area: 'reviewers',
      status: 'partial',
      availableCapabilities: [
        'reviewer_roster.change',
        'reviewer_roster.snapshot.read'
      ],
      unavailableCapabilities: ['reviewer_roster.delivery.activate']
    },
    {
      area: 'tasks',
      status: 'partial',
      availableCapabilities: ['task.board.read', 'task.mutation'],
      unavailableCapabilities: ['task.reminder.send']
    },
    {
      area: 'schedule',
      status: 'partial',
      availableCapabilities: [
        'release.change.draft',
        'schedule.placement',
        'schedule.placement.snapshot.read',
        'session.catalog.read',
        'session.change'
      ],
      // `publish_schedule` now rides the mounted `release.change.draft`
      // owner-native publication loop (gated by the minted `publication.manage`), so the
      // separate schedule.publish capability id is no longer the truth of
      // what is unavailable here.
      unavailableCapabilities: ['schedule.break.manage']
    },
    {
      area: 'messages',
      status: 'partial',
      // The mounted authoring, audience-preview, send-lane, and
      // delivery-history operations, by their exact operation names; the
      // send ceremony and history projection are live (J-WEB-2), and with no
      // outbound provider activated every delivery lands honestly
      // not-delivered. Provider connection setup remains unavailable.
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
    },
    {
      area: 'templates',
      status: 'available',
      capabilities: [
        'template.artifact.change',
        'template.artifact.change.draft',
        'template.artifact.get',
        'template.artifact.list',
        'template.edit.classify',
        'template.edit.model_choices.list',
        'template.edit.revise'
      ]
    },
    {
      area: 'forms',
      status: 'partial',
      availableCapabilities: [
        'form.create.draft',
        'form.lifecycle.draft',
        'form.list',
        'form.publish.draft',
        'form.read',
        'form.revise.draft'
      ],
      unavailableCapabilities: ['form.composition.manage', 'form.fields.manage']
    },
    {
      area: 'embeds',
      // The embed security slice is mounted server-side: the framing
      // allowlist is authorable through the `release.change.draft`
      // `surface_allowlist` arm and `/embed/*` HTML serves the enforced
      // frame-ancestors policy. The embed documents and loader themselves
      // are web-composition work that has not landed.
      status: 'partial',
      availableCapabilities: ['embed.frame_allowlist.draft'],
      unavailableCapabilities: ['embed.document.render', 'embed.loader.serve']
    },
    {
      area: 'settings',
      status: 'partial',
      availableCapabilities: [
        'communication.sender_identity.read',
        'communication.sender_identity.update',
        'event.current.read',
        'event.settings.current.read',
        'event.settings.update',
        'field_registry.add.draft',
        'field_registry.edit.draft',
        'field_registry.move.draft',
        'field_registry.remove.draft',
        'field_registry.restore.draft',
        'field_registry.snapshot.read',
        'program_vocabulary.snapshot.read',
        'workspace_team.invite',
        'workspace_team.members.read',
        'workspace_team.remove',
        'workspace_team.role_change'
      ],
      unavailableCapabilities: [
        'workspace_team.delivery.activate',
        'workspace_team.session_revocation.activate'
      ]
    }
  ]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const nullDetailSchema = z.null();
const schemas = {
  input: WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.inputSchema,
  canonical: schemaRef(
    'schema.workspace.overview.read.canonical-result',
    workspaceOverviewCanonicalResultSchema
  ),
  projected: WORKSPACE_OVERVIEW_OPERATION_SCHEMA_REFS.read.resultSchema,
  nullDetail: schemaRef('schema.workspace.overview.operation.null-detail', nullDetailSchema)
} as const;

const refs = {
  context: ref('context.workspace.overview.read'),
  autonomy: ref('autonomy.workspace.overview.read'),
  capability: ref('capability.workspace.overview.read'),
  handler: ref('handler.workspace.overview.read'),
  projection: ref('projection.workspace.overview.read.operator'),
  trace: ref('trace.workspace.overview.read'),
  auditRecordProfile: ref('record-profile.workspace.overview.operation-audit')
} as const;

export interface WorkspaceOverviewReadPort {
  readOverview(workspaceId: WorkspaceId):
    | WorkspaceOverviewProjection
    | Promise<WorkspaceOverviewProjection>;
}

export interface WorkspaceOverviewOperationIds {
  newInvocationId(): InvocationId;
}

export interface CreateWorkspaceOverviewOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly overviewRead: WorkspaceOverviewReadPort;
  readonly clock: Clock;
  readonly ids: WorkspaceOverviewOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied',
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  });
}

function workspaceScopeResolver(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
  });
}

export function createWorkspaceOverviewOperationModule(
  input: CreateWorkspaceOverviewOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (
    input.policy.key !== WORKSPACE_OVERVIEW_READ_ACCESS_POLICY.key
    || input.policy.version !== WORKSPACE_OVERVIEW_READ_ACCESS_POLICY.version
  ) {
    throw new TypeError('workspace_overview_operation_policy_catalog_mismatch');
  }

  const lane = parseOperationAccessLane({
    kind: 'operator',
    surface: 'operator_http',
    policy: input.policy
  });
  const autonomy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: WORKSPACE_OVERVIEW_READ_OPERATION,
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
  });
  const context = createReadInvocationContextBuilder({
    reference: refs.context,
    operation: WORKSPACE_OVERVIEW_READ_OPERATION,
    effect: 'read',
    lanes: [lane],
    scopeResolver: workspaceScopeResolver(workspaceId),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.capability,
    openSnapshot: async (invocation: ReadInvocationContext) => Object.freeze({
      overview: await input.overviewRead.readOverview(invocation.scope.workspaceId)
    })
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: schemas.nullDetail
  }));

  return Object.freeze({
    id: 'workspace.overview.operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: workspaceOverviewReadInputSchema },
        { reference: schemas.canonical, schema: workspaceOverviewCanonicalResultSchema },
        { reference: schemas.projected, schema: workspaceOverviewReadResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ]),
      contextBuilders: Object.freeze([context]),
      readCapabilities: Object.freeze([capability]),
      handlers: Object.freeze([{
        reference: refs.handler,
        readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ snapshot }: { readonly snapshot: Readonly<Record<string, unknown>> }) => ({
          kind: 'success',
          data: workspaceOverviewProjectionSchema.parse(snapshot.overview)
        })
      }]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => workspaceOverviewCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...WORKSPACE_OVERVIEW_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read durable workspace overview facts and implemented-area availability.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: [],
        inputSchema: schemas.input,
        canonicalResultSchema: schemas.canonical,
        outcomes: accessOutcomes,
        accessLanes: [lane],
        contextBuilder: refs.context,
        readCapability: refs.capability,
        handler: refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: '/api/workspace/overview',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }])
    })
  });
}
