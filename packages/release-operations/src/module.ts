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
  createReadOperationResultSchema,
  createSafeSchemaManifestRef,
  releasePublicReadInputSchema,
  servedPublicPresentationSchema,
  servedPublicRosterSchema,
  servedPublicScheduleSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type ServedPublicPresentationDto,
  type ServedPublicRosterDto,
  type ServedPublicScheduleDto,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type OperationAccessLane,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseWorkspaceId,
  type Clock,
  type EventId,
  type InvocationId,
  type PublicPolicyRevisionId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';

export const RELEASE_PUBLIC_SCHEDULE_READ_OPERATION = Object.freeze({
  name: 'schedule.public.read', version: 1
});
export const RELEASE_PUBLIC_ROSTER_READ_OPERATION = Object.freeze({
  name: 'roster.public.read', version: 1
});
export const RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION = Object.freeze({
  name: 'schedule.public.presentation.read', version: 1
});
export const RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION = Object.freeze({
  name: 'roster.public.presentation.read', version: 1
});
export const RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION = Object.freeze({
  name: 'apply.public.presentation.read', version: 1
});

export const RELEASE_PUBLIC_SCHEDULE_READ_PATH = '/api/public/schedule/current';
export const RELEASE_PUBLIC_ROSTER_READ_PATH = '/api/public/speakers/current';
export const RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_PATH = '/api/public/schedule/presentation';
export const RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_PATH = '/api/public/speakers/presentation';
export const RELEASE_PUBLIC_APPLY_PRESENTATION_READ_PATH = '/api/public/forms/presentation';

export const RELEASE_PUBLIC_OPEN_ACCESS_POLICY = Object.freeze({
  key: 'authority.release.public-open', version: parseContractVersion(1)
});

/**
 * Public surface identities the open read scope names. Schedule and speakers
 * serve released program data; all three kinds also serve their immutable
 * presentation release without accepting a caller-selected release.
 */
export type ReleasePublicSurface = 'schedule' | 'speakers' | 'apply';

/**
 * Read surface the public modules consume: served projections only, produced
 * from immutable release rows. The confirmed-and-visible join and the audited
 * name declassification already happened at materialization; a port
 * implementation must never re-derive from live operator state or join the
 * classified store. `undefined` means "no program release has ever been
 * published" and serves as a typed absence, never as an empty page.
 */
export interface ReleasePublicReadPort {
  readServedSchedule(
    scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }
  ): ServedPublicScheduleDto | undefined;
  readServedRoster(
    scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId }
  ): ServedPublicRosterDto | undefined;
  readServedPresentation(
    scope: { readonly workspaceId: WorkspaceId; readonly eventId: EventId },
    kind: ReleasePublicSurface
  ): ServedPublicPresentationDto | undefined;
}

/**
 * Resolves which event the open public surface serves, keyed by the presented
 * public policy revision. Returning `undefined` refuses the request outright
 * (revision mismatch, no current event, surface disabled); the composing
 * runtime owns the durable revision source.
 */
export interface ReleasePublicScopeSource {
  resolve(input: { readonly publicPolicyRevisionId: PublicPolicyRevisionId }):
    | { readonly workspaceId: string; readonly eventId: string; readonly evidenceIds: readonly string[] }
    | undefined
    | Promise<
      | { readonly workspaceId: string; readonly eventId: string; readonly evidenceIds: readonly string[] }
      | undefined
    >;
}

export interface ReleasePublicOperationIds { newInvocationId(): InvocationId; }

export interface ReleasePublicOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema, parseContractVersion(1));
}

function canonicalEvidence(values: readonly string[]): readonly string[] {
  const checked = values.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() !== value) {
      throw new TypeError('release_scope_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(checked)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

function assertPolicy(
  actual: VersionedAccessPolicyRef,
  expected: VersionedAccessPolicyRef,
  code: string
): void {
  if (actual.key !== expected.key || actual.version !== expected.version) {
    throw new TypeError(code);
  }
}

type PublicOpenLane = Extract<OperationAccessLane, {
  readonly kind: 'public_open';
  readonly surface: 'public_http';
}>;

function publicOpenLane(policy: VersionedAccessPolicyRef): PublicOpenLane {
  const lane = parseOperationAccessLane({ kind: 'public_open', surface: 'public_http', policy });
  if (lane.kind !== 'public_open') throw new TypeError('release_public_open_lane_invalid');
  return lane;
}

/**
 * Evidence-keyed scope resolution: only `public_open` evidence is admissible,
 * and the composed source decides whether the presented policy revision still
 * addresses a servable event. Anything else refuses before a read port runs.
 */
function publicSurfaceScope(
  source: ReleasePublicScopeSource,
  surface: ReleasePublicSurface
): InvocationScopeResolver {
  return Object.freeze({ async resolve({ evidence }:
    Parameters<InvocationScopeResolver['resolve']>[0]) {
    if (evidence.kind !== 'public_open') {
      throw new TypeError('release_public_open_evidence_required');
    }
    const resolved = await source.resolve({
      publicPolicyRevisionId: evidence.publicPolicyRevisionId
    });
    if (!resolved) throw new TypeError('release_public_surface_unavailable');
    const workspaceId = parseWorkspaceId(resolved.workspaceId);
    const eventId = parseEventId(resolved.eventId);
    return Object.freeze({
      workspaceId, eventId,
      subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId },
        { kind: 'event' as const, id: eventId },
        { kind: 'domain' as const, domain: 'release', entity: 'public_surface', id: surface }
      ]),
      resolutionEvidenceIds: canonicalEvidence(resolved.evidenceIds)
    });
  }});
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

/** Typed absence: no program release has ever been published for this event. */
const NOT_PUBLISHED_OUTCOME = Object.freeze({
  class: 'conflict' as const,
  kind: 'release.not_published',
  retryable: false,
  subjects: Object.freeze([]),
  detail: null,
  detailSchemaVersion: 1
});

const nullSchema = z.null();
const refs = Object.freeze({
  auditRecord: ref('record-profile.release.operation-audit'),
  trace: ref('trace.release.public-read'),
  nullDetail: schemaRef('schema.release.public-read.null-detail', nullSchema)
});

const canonicalResult = <Schema extends z.ZodType>(data: Schema) => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

function readSchemas(key: string, input: z.ZodType, data: z.ZodType) {
  const canonical = canonicalResult(data);
  const projected = createReadOperationResultSchema(data);
  return Object.freeze({
    input: schemaRef(`schema.${key}.input`, input),
    canonical: schemaRef(`schema.${key}.canonical-result`, canonical),
    projected: schemaRef(`schema.${key}.projected-result`, projected),
    inputSchema: input, canonicalSchema: canonical, projectedSchema: projected
  });
}

const readCatalog = Object.freeze({
  publicSchedule: readSchemas(
    'schedule.public-read', releasePublicReadInputSchema, servedPublicScheduleSchema
  ),
  publicRoster: readSchemas(
    'roster.public-read', releasePublicReadInputSchema, servedPublicRosterSchema
  ),
  schedulePresentation: readSchemas(
    'schedule.public-presentation-read', releasePublicReadInputSchema,
    servedPublicPresentationSchema
  ),
  rosterPresentation: readSchemas(
    'roster.public-presentation-read', releasePublicReadInputSchema,
    servedPublicPresentationSchema
  ),
  applyPresentation: readSchemas(
    'apply.public-presentation-read', releasePublicReadInputSchema,
    servedPublicPresentationSchema
  )
});

type ReadEntry = {
  readonly operation: { readonly name: string; readonly version: number };
  readonly key: keyof typeof readCatalog;
  readonly path: string;
  readonly lane: PublicOpenLane;
  readonly scope: InvocationScopeResolver;
  readonly read: (context: ReadInvocationContext, input: unknown) => unknown;
};

function autonomy(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef
) {
  return createOperationAutonomyPolicy({
    definition, operation, riskFloor: 'low', unattendedRiskCeiling: 'low',
    supportedDispositions: ['proceed', 'safe_retry', 'reconcile', 'renewed_approval', 'replan', 'compensate', 'block', 'attention'],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
}

function scopeRequired(context: ReadInvocationContext): {
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
} {
  if (!context.scope.eventId) throw new TypeError('release_public_event_required');
  return { workspaceId: context.scope.workspaceId, eventId: context.scope.eventId };
}

function readModule(input: {
  readonly id: string;
  readonly authority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: ReleasePublicOperationIds;
  readonly crypto: ReleasePublicOperationCrypto;
  readonly entries: readonly ReadEntry[];
}): OperationRegistryModule {
  const built = input.entries.map((entry) => {
    const schema = readCatalog[entry.key];
    return Object.freeze({
      ...entry,
      schema,
      autonomy: autonomy(entry.operation, ref(`autonomy.${entry.operation.name}`)),
      contextRef: ref(`context.${entry.operation.name}`),
      capabilityRef: ref(`capability.${entry.operation.name}`),
      handlerRef: ref(`handler.${entry.operation.name}`),
      projectionRef: ref(`projection.${entry.operation.name}`)
    });
  }).map((entry) => Object.freeze({
    ...entry,
    context: createReadInvocationContextBuilder({
      reference: entry.contextRef, operation: entry.operation, effect: 'read',
      lanes: [entry.lane], scopeResolver: entry.scope, authorityResolver: input.authority,
      clock: input.clock, newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.crypto.scopePartitionProfile,
      requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
      deniedAuthorityOutcome: authorityOutcome
    })
  }));
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false,
    detailSchema: refs.nullDetail
  }));
  return Object.freeze({
    id: input.id,
    source: Object.freeze({
      autonomyPolicies: built.map((entry) => entry.autonomy),
      schemas: [
        ...built.flatMap((entry) => [
          { reference: entry.schema.input, schema: entry.schema.inputSchema },
          { reference: entry.schema.canonical, schema: entry.schema.canonicalSchema },
          { reference: entry.schema.projected, schema: entry.schema.projectedSchema }
        ]),
        { reference: refs.nullDetail, schema: nullSchema }
      ],
      contextBuilders: built.map((entry) => entry.context),
      readCapabilities: built.map<ReadCapabilityRegistration>((entry) => Object.freeze({
        reference: entry.capabilityRef,
        openSnapshot: (context: ReadInvocationContext) => Object.freeze({ context })
      })),
      handlers: built.map((entry) => Object.freeze({
        reference: entry.handlerRef,
        readCapability: entry.capabilityRef,
        canonicalResultSchema: entry.schema.canonical,
        handle: ({ businessInput, context }: {
          readonly businessInput: unknown;
          readonly context: ReadInvocationContext;
        }) => {
          const value = entry.read(context, businessInput);
          return value === undefined
            ? Object.freeze({ kind: 'outcome' as const, outcome: NOT_PUBLISHED_OUTCOME })
            : Object.freeze({ kind: 'success' as const, data: value });
        }
      })),
      projections: built.map((entry) => Object.freeze({
        reference: entry.projectionRef,
        canonicalResultSchema: entry.schema.canonical,
        projectedResultSchema: entry.schema.projected,
        project: (candidate: unknown) => entry.schema.canonicalSchema.parse(candidate)
      })),
      readOperationalTraceTargets: [{
        reference: refs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: refs.auditRecord
      }],
      operationAuditRecordProfiles: [{
        reference: refs.auditRecord, kind: 'canonical_json' as const, maximumBytes: 262_144
      }],
      operations: built.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: `Read ${entry.operation.name}.`,
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: entry.autonomy.definition,
        consequenceTags: [],
        inputSchema: entry.schema.input,
        canonicalResultSchema: entry.schema.canonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'release.not_published', retryable: false,
            detailSchema: refs.nullDetail }
        ],
        accessLanes: [entry.lane],
        contextBuilder: entry.contextRef,
        readCapability: entry.capabilityRef,
        handler: entry.handlerRef,
        observability: {
          trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'public_http' as const, method: 'GET' as const, path: entry.path,
          input: 'query' as const, browserResumption: { kind: 'none' as const },
          projection: entry.projectionRef
        }]
      }))
    })
  });
}

/**
 * Registers the open, public-safe served projections of the release domain:
 * schedule and speaker data plus each kind's active immutable presentation.
 * No release yet is the typed `release.not_published` refusal — never an
 * empty page pretending to be published. The reads follow
 * the public form-read blueprint: `public_open` evidence, policy-revision
 * gating in the scope source, and a strict served-DTO re-parse that refuses a
 * read port smuggling anything a public page must not carry.
 */
export function createReleasePublicReadOperationModule(input: {
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly publicScope: ReleasePublicScopeSource;
  readonly read: ReleasePublicReadPort;
  readonly clock: Clock;
  readonly ids: ReleasePublicOperationIds;
  readonly crypto: ReleasePublicOperationCrypto;
}): OperationRegistryModule {
  assertPolicy(input.policy, RELEASE_PUBLIC_OPEN_ACCESS_POLICY,
    'release_public_open_policy_catalog_mismatch');
  const lane = publicOpenLane(input.policy);
  return readModule({
    id: 'release.public-read',
    authority: input.currentAuthority,
    clock: input.clock,
    ids: input.ids,
    crypto: input.crypto,
    entries: [
      {
        operation: RELEASE_PUBLIC_SCHEDULE_READ_OPERATION,
        key: 'publicSchedule',
        path: RELEASE_PUBLIC_SCHEDULE_READ_PATH,
        lane,
        scope: publicSurfaceScope(input.publicScope, 'schedule'),
        read: (context, raw) => {
          releasePublicReadInputSchema.parse(raw ?? {});
          const value = input.read.readServedSchedule(scopeRequired(context));
          return value === undefined ? undefined : servedPublicScheduleSchema.parse(value);
        }
      },
      {
        operation: RELEASE_PUBLIC_ROSTER_READ_OPERATION,
        key: 'publicRoster',
        path: RELEASE_PUBLIC_ROSTER_READ_PATH,
        lane,
        scope: publicSurfaceScope(input.publicScope, 'speakers'),
        read: (context, raw) => {
          releasePublicReadInputSchema.parse(raw ?? {});
          const value = input.read.readServedRoster(scopeRequired(context));
          return value === undefined ? undefined : servedPublicRosterSchema.parse(value);
        }
      },
      {
        operation: RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_OPERATION,
        key: 'schedulePresentation',
        path: RELEASE_PUBLIC_SCHEDULE_PRESENTATION_READ_PATH,
        lane,
        scope: publicSurfaceScope(input.publicScope, 'schedule'),
        read: (context, raw) => {
          releasePublicReadInputSchema.parse(raw ?? {});
          const value = input.read.readServedPresentation(scopeRequired(context), 'schedule');
          return value === undefined ? undefined : servedPublicPresentationSchema.parse(value);
        }
      },
      {
        operation: RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_OPERATION,
        key: 'rosterPresentation',
        path: RELEASE_PUBLIC_ROSTER_PRESENTATION_READ_PATH,
        lane,
        scope: publicSurfaceScope(input.publicScope, 'speakers'),
        read: (context, raw) => {
          releasePublicReadInputSchema.parse(raw ?? {});
          const value = input.read.readServedPresentation(scopeRequired(context), 'speakers');
          return value === undefined ? undefined : servedPublicPresentationSchema.parse(value);
        }
      },
      {
        operation: RELEASE_PUBLIC_APPLY_PRESENTATION_READ_OPERATION,
        key: 'applyPresentation',
        path: RELEASE_PUBLIC_APPLY_PRESENTATION_READ_PATH,
        lane,
        scope: publicSurfaceScope(input.publicScope, 'apply'),
        read: (context, raw) => {
          releasePublicReadInputSchema.parse(raw ?? {});
          const value = input.read.readServedPresentation(scopeRequired(context), 'apply');
          return value === undefined ? undefined : servedPublicPresentationSchema.parse(value);
        }
      }
    ]
  });
}
