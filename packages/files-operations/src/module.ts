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
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  FILES_OPERATION_SCHEMA_REFS,
  fileSubjectReadInputSchema,
  filesEmptyReadInputSchema,
  organizerFileOverviewReadResultSchema,
  organizerFileOverviewSchema,
  portalEngagementFilesReadResultSchema,
  portalEngagementFilesSchema,
  type FileScopeDto,
  type OrganizerFileOverviewDto,
  type PortalEngagementFilesDto
} from '@jooevents/contracts/files';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type PermissionId,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Operation identities, policies, permissions
// ---------------------------------------------------------------------------

export const FILE_OVERVIEW_READ_OPERATION = Object.freeze({
  name: 'file.overview.read', version: 1
});
export const FILE_PORTAL_ENGAGEMENT_FILES_READ_OPERATION = Object.freeze({
  name: 'file.portal.engagement-files.read', version: 1
});

export const FILE_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.file.read', version: parseContractVersion(1)
});
/** External MCP agents get read access through their own evaluated policy (D: MCP read-only). */
export const FILE_MCP_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.file.mcp-read', version: parseContractVersion(1)
});
/**
 * The portal lane reuses the participant portal read policy: files never grow
 * a second participant authority scheme, and the participant resolver's
 * per-request relationship evaluation is exactly the D8 authorization source.
 */
export const FILE_PORTAL_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.portal.participant.read', version: parseContractVersion(1)
});

/**
 * Reused permission ids (minted sparingly, per the identity-access catalog):
 * the organizer file overview reads submitted material, and file commands are
 * event-management actions. No new permission id is introduced by v1 files.
 */
export const FILE_READ_PERMISSION_ID: PermissionId = 'submission.read';
export const FILE_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';

// ---------------------------------------------------------------------------
// Read ports
// ---------------------------------------------------------------------------

/**
 * `undefined` means the scope root itself is missing — a composition fault,
 * never an empty state: an event with no files serves an empty overview.
 */
export interface FilesOrganizerReadPort {
  readOrganizerFileOverview(scope: FileScopeDto): OrganizerFileOverviewDto | undefined;
}

export interface FilesPortalReadPort {
  readPortalEngagementFiles(
    scope: FileScopeDto,
    engagementId: string
  ): PortalEngagementFilesDto | undefined;
}

export interface FilesOperationIds {
  newInvocationId(): InvocationId;
}

export interface FilesCurrentEventResolution {
  readonly eventId?: string;
  readonly evidenceIds: readonly string[];
}

export interface FilesCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    FilesCurrentEventResolution | Promise<FilesCurrentEventResolution>;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.trim() !== value) {
      throw new TypeError('files_current_event_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function filesCurrentEventScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly source: FilesCurrentEventSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve() {
      const resolved = await input.source.resolveCurrentEvent(input.workspaceId);
      if (!resolved || !Array.isArray(resolved.evidenceIds)) {
        throw new TypeError('files_current_event_resolution_invalid');
      }
      const evidenceIds = canonicalEvidenceIds(resolved.evidenceIds);
      if (resolved.eventId === undefined) {
        return Object.freeze({
          workspaceId: input.workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: input.workspaceId }]),
          resolutionEvidenceIds: evidenceIds
        });
      }
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({
        workspaceId: input.workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: input.workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: evidenceIds
      });
    }
  });
}

function fixedScopeResolver(scope: {
  readonly workspaceId: WorkspaceId;
  readonly eventId: string;
}): InvocationScopeResolver {
  const eventId = parseEventId(scope.eventId);
  return Object.freeze({
    resolve() {
      return Object.freeze({
        workspaceId: scope.workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: scope.workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: Object.freeze(['files.portal.lane'])
      });
    }
  });
}

const AUTONOMY_DISPOSITIONS = [
  'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
  'replan', 'compensate', 'block', 'attention'
] as const;
const AUTONOMY_TRIGGERS = Object.freeze({
  authority_lost: 'block',
  unattended_bounds_exceeded: 'renewed_approval',
  approval_required: 'renewed_approval',
  known_retryable_failure: 'safe_retry',
  ambiguous_external_effect: 'reconcile',
  stale_plan: 'replan',
  compensation_required: 'compensate',
  terminal_failure: 'attention'
} as const);

function readAutonomy(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef
) {
  return createOperationAutonomyPolicy({
    definition,
    operation,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
    supportedDispositions: [...AUTONOMY_DISPOSITIONS],
    triggerDispositions: { ...AUTONOMY_TRIGGERS },
    requiresSeparateApproval: false
  });
}

interface ReadEntry {
  readonly operation: { readonly name: string; readonly version: number };
  readonly summary: string;
  readonly path: string;
  readonly surface: 'operator_http' | 'participant_http';
  readonly lanes: readonly ReturnType<typeof parseOperationAccessLane>[];
  readonly scope: InvocationScopeResolver;
  readonly input: { readonly ref: SafeSchemaManifestRef; readonly schema: z.ZodType };
  readonly data: { readonly ref: SafeSchemaManifestRef; readonly schema: z.ZodType };
  /** The FULL projected read-result envelope the binding serves. */
  readonly projected: { readonly ref: SafeSchemaManifestRef; readonly schema: z.ZodType };
  readonly extraOutcomes: readonly {
    readonly class: StructuredOutcome['class'];
    readonly kind: string;
    readonly retryable: boolean;
  }[];
  readonly read: (
    context: ReadInvocationContext,
    businessInput: unknown
  ) => unknown | { readonly kind: 'outcome'; readonly outcome: StructuredOutcome };
}

function readModule(input: {
  readonly id: string;
  readonly authority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: FilesOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly entries: readonly ReadEntry[];
}): OperationRegistryModule {
  const nullDetail = schemaRef(`schema.${input.id}.null-detail`, z.null());
  const machineAudit = ref(`audit.${input.id}.machine-read`);
  const machineAuditProfile = ref(`record-profile.${input.id}.machine-read-audit`);
  const anyMachineLane = input.entries.some((entry) =>
    entry.lanes.some((lane) => lane.surface === 'external_mcp' || lane.surface === 'app_model'));
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: nullDetail
  }));
  const built = input.entries.map((entry) => {
    const canonicalSchema = z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('success'), data: entry.data.schema }),
      z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
    ]);
    const refs = Object.freeze({
      context: ref(`context.${entry.operation.name}`),
      autonomy: ref(`autonomy.${entry.operation.name}`),
      capability: ref(`capability.${entry.operation.name}`),
      handler: ref(`handler.${entry.operation.name}`),
      projection: ref(`projection.${entry.operation.name}`),
      trace: ref(`trace.${entry.operation.name}`),
      recordProfile: ref(`record-profile.${entry.operation.name}`)
    });
    const canonicalRef = schemaRef(
      `schema.${entry.operation.name}.canonical-result`, canonicalSchema
    );
    return Object.freeze({
      entry,
      refs,
      canonicalSchema,
      canonicalRef,
      autonomy: readAutonomy(entry.operation, refs.autonomy),
      context: createReadInvocationContextBuilder({
        reference: refs.context,
        operation: entry.operation,
        effect: 'read',
        lanes: [...entry.lanes],
        scopeResolver: entry.scope,
        authorityResolver: input.authority,
        clock: input.clock,
        newInvocationId: input.ids.newInvocationId,
        authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
        scopePartitionProfile: input.scopePartitionProfile,
        requestCanonicalizationProfile: input.requestCanonicalizationProfile,
        deniedAuthorityOutcome: authorityOutcome
      })
    });
  });
  return Object.freeze({
    id: input.id,
    source: Object.freeze({
      autonomyPolicies: built.map((item) => item.autonomy),
      schemas: [
        ...built.flatMap((item) => [
          { reference: item.entry.input.ref, schema: item.entry.input.schema },
          { reference: item.canonicalRef, schema: item.canonicalSchema },
          { reference: item.entry.projected.ref, schema: item.entry.projected.schema }
        ]),
        { reference: nullDetail, schema: z.null() }
      ],
      contextBuilders: built.map((item) => item.context),
      readCapabilities: built.map<ReadCapabilityRegistration>((item) => Object.freeze({
        reference: item.refs.capability,
        openSnapshot: (context: ReadInvocationContext) => Object.freeze({ context })
      })),
      handlers: built.map((item) => Object.freeze({
        reference: item.refs.handler,
        readCapability: item.refs.capability,
        canonicalResultSchema: item.canonicalRef,
        handle: ({ businessInput, context }: {
          readonly businessInput: unknown;
          readonly context: ReadInvocationContext;
        }) => {
          const value = item.entry.read(context, businessInput);
          if (value !== null && typeof value === 'object' && 'kind' in (value as object)
              && (value as { readonly kind: unknown }).kind === 'outcome') {
            return value;
          }
          return value === undefined
            ? Object.freeze({
                kind: 'outcome' as const,
                outcome: Object.freeze({
                  class: 'conflict' as const, kind: 'file.not_found', retryable: false,
                  subjects: [], detail: null, detailSchemaVersion: 1
                })
              })
            : Object.freeze({ kind: 'success' as const, data: value });
        }
      })),
      projections: built.map((item) => Object.freeze({
        reference: item.refs.projection,
        canonicalResultSchema: item.canonicalRef,
        projectedResultSchema: item.entry.projected.ref,
        project: (candidate: unknown) => item.canonicalSchema.parse(candidate)
      })),
      readOperationalTraceTargets: built.map((item) => ({
        reference: item.refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: item.refs.recordProfile
      })),
      operationAuditRecordProfiles: [
        ...built.map((item) => ({
          reference: item.refs.recordProfile,
          kind: 'canonical_json' as const,
          maximumBytes: 262_144
        })),
        ...(anyMachineLane ? [{
          reference: machineAuditProfile,
          kind: 'canonical_json' as const,
          maximumBytes: 262_144
        }] : [])
      ],
      ...(anyMachineLane ? {
        operationAuditTargets: Object.freeze([{
          reference: machineAudit,
          kind: 'operation_audit_record' as const,
          recordProfile: machineAuditProfile
        }])
      } : {}),
      operations: built.map((item) => ({
        ...item.entry.operation,
        lifecycle: { status: 'active' as const },
        summary: item.entry.summary,
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: item.refs.autonomy,
        consequenceTags: [],
        inputSchema: item.entry.input.ref,
        canonicalResultSchema: item.canonicalRef,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'file.not_found', retryable: false, detailSchema: nullDetail },
          ...item.entry.extraOutcomes.map((outcome) => ({ ...outcome, detailSchema: nullDetail }))
        ],
        accessLanes: [...item.entry.lanes],
        contextBuilder: item.refs.context,
        readCapability: item.refs.capability,
        handler: item.refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: item.refs.trace },
          immutableAudit: item.entry.lanes.some((lane) =>
            lane.surface === 'external_mcp' || lane.surface === 'app_model')
            ? { mode: 'external_mcp_app_model' as const, target: machineAudit }
            : { mode: 'none' as const }
        },
        bindings: [
          {
            surface: item.entry.surface,
            method: 'GET' as const,
            path: item.entry.path,
            input: 'query' as const,
            browserResumption: { kind: 'none' as const },
            projection: item.refs.projection
          },
          ...item.entry.lanes
            .filter((lane) => lane.surface === 'external_mcp')
            .map(() => ({
              surface: 'external_mcp' as const,
              toolName: item.entry.operation.name === FILE_OVERVIEW_READ_OPERATION.name
                ? 'get_file_overview'
                : item.entry.operation.name,
              projection: item.refs.projection
            }))
        ]
      }))
    })
  });
}

function eventRequiredOutcome(): { readonly kind: 'outcome'; readonly outcome: StructuredOutcome } {
  return Object.freeze({
    kind: 'outcome' as const,
    outcome: Object.freeze({
      class: 'conflict' as const, kind: 'file.event_required', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
}

// ---------------------------------------------------------------------------
// Organizer (and optional MCP) read module
// ---------------------------------------------------------------------------

export interface CreateFilesReadOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly readPolicy: VersionedAccessPolicyRef;
  /** Present exactly when this installation exposes files to external MCP reads. */
  readonly mcpReadPolicy?: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: FilesCurrentEventSource;
  readonly clock: Clock;
  readonly ids: FilesOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly read: FilesOrganizerReadPort;
}

export function createFilesReadOperationModule(
  input: CreateFilesReadOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.readPolicy.key !== FILE_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== FILE_READ_ACCESS_POLICY.version) {
    throw new TypeError('files_read_policy_catalog_mismatch');
  }
  if (input.mcpReadPolicy !== undefined
      && (input.mcpReadPolicy.key !== FILE_MCP_READ_ACCESS_POLICY.key
        || input.mcpReadPolicy.version !== FILE_MCP_READ_ACCESS_POLICY.version)) {
    throw new TypeError('files_mcp_read_policy_catalog_mismatch');
  }
  const lanes = [
    parseOperationAccessLane({
      kind: 'operator', surface: 'operator_http', policy: input.readPolicy
    }),
    ...(input.mcpReadPolicy
      ? [parseOperationAccessLane({
          kind: 'external_mcp', surface: 'external_mcp', policy: input.mcpReadPolicy
        })]
      : [])
  ];
  return readModule({
    id: 'files.read-operations',
    authority: input.currentAuthority,
    clock: input.clock,
    ids: input.ids,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    entries: [{
      operation: FILE_OVERVIEW_READ_OPERATION,
      summary: 'Read every attachment, resource share, and file request for the current event.',
      path: '/api/events/current/files',
      surface: 'operator_http',
      lanes,
      scope: filesCurrentEventScopeResolver({ workspaceId, source: input.currentEvent }),
      input: {
        ref: FILES_OPERATION_SCHEMA_REFS.organizerOverview.inputSchema,
        schema: filesEmptyReadInputSchema
      },
      data: {
        ref: schemaRef('schema.file.overview.data', organizerFileOverviewSchema),
        schema: organizerFileOverviewSchema
      },
      projected: {
        ref: FILES_OPERATION_SCHEMA_REFS.organizerOverview.resultSchema,
        schema: organizerFileOverviewReadResultSchema
      },
      extraOutcomes: [{ class: 'conflict', kind: 'file.event_required', retryable: false }],
      read: (context) => {
        if (!context.scope.eventId) return eventRequiredOutcome();
        const scope: FileScopeDto = {
          workspaceId: context.scope.workspaceId,
          eventId: context.scope.eventId
        };
        const overview = input.read.readOrganizerFileOverview(scope);
        // A resolved current event with a missing scope root is corrupt
        // composition state, never an honest empty overview.
        if (overview === undefined) throw new TypeError('files_overview_scope_missing');
        return organizerFileOverviewSchema.parse(overview);
      }
    }]
  });
}

// ---------------------------------------------------------------------------
// Participant portal read module (D8: own engagement only)
// ---------------------------------------------------------------------------

export interface CreateFilesPortalReadOperationModuleInput {
  readonly lane: {
    readonly workspaceId: WorkspaceId;
    readonly eventId: string;
  };
  readonly readPolicy: VersionedAccessPolicyRef;
  /**
   * The participant-lane resolver (portal module composition). It re-reads the
   * person's current relationship per request and exposes it as
   * `participant_relationship` grants; this module never consults operator
   * authority.
   */
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: FilesOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly read: FilesPortalReadPort;
}

/** Grants of this exact shape are minted by the participant authority resolver. */
export function portalEngagementGrantKeys(context: ReadInvocationContext): ReadonlySet<string> {
  const grants = (context.authority as { readonly grants?: readonly unknown[] }).grants ?? [];
  const keys = new Set<string>();
  for (const grant of grants) {
    if (grant !== null && typeof grant === 'object'
        && (grant as { readonly kind?: unknown }).kind === 'participant_relationship'
        && typeof (grant as { readonly key?: unknown }).key === 'string') {
      keys.add((grant as { readonly key: string }).key);
    }
  }
  return keys;
}

export function createFilesPortalReadOperationModule(
  input: CreateFilesPortalReadOperationModuleInput
): OperationRegistryModule {
  if (input.readPolicy.key !== FILE_PORTAL_READ_ACCESS_POLICY.key
      || input.readPolicy.version !== FILE_PORTAL_READ_ACCESS_POLICY.version) {
    throw new TypeError('files_portal_read_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.lane.workspaceId);
  const eventId = parseEventId(input.lane.eventId);
  const lane = parseOperationAccessLane({
    kind: 'participant', surface: 'participant_http', policy: input.readPolicy
  });
  return readModule({
    id: 'files.portal-read-operations',
    authority: input.currentAuthority,
    clock: input.clock,
    ids: input.ids,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    entries: [{
      operation: FILE_PORTAL_ENGAGEMENT_FILES_READ_OPERATION,
      summary: 'Read the files and open file requests on one engagement the participant is currently related to.',
      path: '/api/portal/engagements/files',
      surface: 'participant_http',
      lanes: [lane],
      scope: fixedScopeResolver({ workspaceId, eventId }),
      input: {
        ref: FILES_OPERATION_SCHEMA_REFS.portalEngagementFiles.inputSchema,
        schema: fileSubjectReadInputSchema
      },
      data: {
        ref: schemaRef('schema.file.portal-engagement.data', portalEngagementFilesSchema),
        schema: portalEngagementFilesSchema
      },
      projected: {
        ref: FILES_OPERATION_SCHEMA_REFS.portalEngagementFiles.resultSchema,
        schema: portalEngagementFilesReadResultSchema
      },
      extraOutcomes: [
        { class: 'access_denied', kind: 'file.portal.not_related', retryable: false }
      ],
      read: (context, businessInput) => {
        const { subject } = fileSubjectReadInputSchema.parse(businessInput);
        if (subject.kind !== 'engagement') {
          // The portal lane serves engagement material only; other subjects
          // are organizer surfaces.
          return Object.freeze({
            kind: 'outcome' as const,
            outcome: Object.freeze({
              class: 'access_denied' as const, kind: 'file.portal.not_related',
              retryable: false, subjects: [],
              detail: null, detailSchemaVersion: 1
            })
          });
        }
        const grantKeys = portalEngagementGrantKeys(context);
        if (!grantKeys.has(`engagement:${subject.engagementId}`)) {
          return Object.freeze({
            kind: 'outcome' as const,
            outcome: Object.freeze({
              class: 'access_denied' as const, kind: 'file.portal.not_related',
              retryable: false, subjects: [],
              detail: null, detailSchemaVersion: 1
            })
          });
        }
        const scope: FileScopeDto = { workspaceId, eventId };
        const value = input.read.readPortalEngagementFiles(scope, subject.engagementId);
        if (value && value.engagementId !== subject.engagementId) {
          throw new TypeError('files_portal_projection_id_mismatch');
        }
        return value === undefined ? undefined : portalEngagementFilesSchema.parse(value);
      }
    }]
  });
}
