import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type OperationRegistryModule,
  type RequestHashSealer
} from '@jooevents/application';
import {
  createEffectfulOperationResultSchema,
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { deadlineReferencePinSchema } from '@jooevents/contracts/deadlines';
import {
  fileAssetSchema,
  fileAttachInputSchema,
  fileAttachmentSchema,
  fileDetachInputSchema,
  fileLinkAttachInputSchema,
  fileRequestCreateInputSchema,
  fileRequestFulfillInputSchema,
  fileRequestSchema,
  fileRequestWithdrawInputSchema,
  fileUploadConfirmInputSchema,
  fileUploadIntentRegisterInputSchema,
  fileUploadIntentSchema,
  resourceShareCreateInputSchema,
  resourceShareRevokeInputSchema,
  resourceShareSchema
} from '@jooevents/contracts/files';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  isApplicationId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  filesCurrentEventScopeResolver,
  portalEngagementGrantKeys,
  type FilesCurrentEventSource,
  type FilesOperationIds
} from './module';

// ---------------------------------------------------------------------------
// Command catalog
// ---------------------------------------------------------------------------

export const FILES_COMMAND_ACTIONS = [
  'upload.intent',
  'upload.confirm',
  'attachment.attach',
  'attachment.link',
  'attachment.detach',
  'share.create',
  'share.revoke',
  'request.create',
  'request.withdraw',
  'request.fulfill'
] as const;
export type FilesCommandAction = (typeof FILES_COMMAND_ACTIONS)[number];
export const filesCommandActionSchema = z.enum(FILES_COMMAND_ACTIONS);

const applicationIdSchema = z.string().refine(isApplicationId);
const canonicalInstantSchema = z.string().refine((value) => {
  try {
    return parseInstant(value) === value;
  } catch {
    return false;
  }
});

/** Every domain refusal a files command may surface, closed and typed. */
export const filesCommandRefusalCodeSchema = z.enum([
  'content_type_refused', 'video_refused_use_link', 'file_too_large',
  'event_quota_exceeded', 'display_filename_invalid', 'intent_id_collision',
  'intent_not_pending', 'intent_expired', 'byte_cap_exceeded', 'empty_stream',
  'image_reencoder_unavailable', 'image_decode_failed', 'image_reencode_invalid',
  'intent_not_stored', 'hash_mismatch', 'asset_id_collision',
  'attachment_id_collision', 'subject_missing', 'asset_missing',
  'asset_not_available', 'asset_blocked', 'attachment_missing',
  'already_detached', 'stale_attachment', 'share_id_collision', 'track_missing',
  'engagement_missing', 'stale_share', 'already_revoked', 'share_missing',
  'request_id_collision', 'engagement_cancelled', 'deadline_unavailable',
  'request_missing', 'request_not_open', 'stale_request', 'attachment_detached',
  'attachment_subject_mismatch', 'portal_not_related'
]);

export const filesCommandRefusalDetailSchema = z.strictObject({
  action: filesCommandActionSchema,
  code: filesCommandRefusalCodeSchema
});

const commandDataSchemas = Object.freeze({
  'upload.intent': z.strictObject({
    action: z.literal('upload.intent'),
    intent: fileUploadIntentSchema,
    idempotent: z.boolean()
  }),
  'upload.confirm': z.strictObject({
    action: z.literal('upload.confirm'),
    asset: fileAssetSchema,
    idempotent: z.boolean()
  }),
  'attachment.attach': z.strictObject({
    action: z.literal('attachment.attach'),
    attachment: fileAttachmentSchema,
    idempotent: z.boolean()
  }),
  'attachment.link': z.strictObject({
    action: z.literal('attachment.link'),
    attachment: fileAttachmentSchema,
    idempotent: z.boolean()
  }),
  'attachment.detach': z.strictObject({
    action: z.literal('attachment.detach'),
    attachment: fileAttachmentSchema
  }),
  'share.create': z.strictObject({
    action: z.literal('share.create'),
    share: resourceShareSchema,
    idempotent: z.boolean()
  }),
  'share.revoke': z.strictObject({
    action: z.literal('share.revoke'),
    share: resourceShareSchema
  }),
  'request.create': z.strictObject({
    action: z.literal('request.create'),
    request: fileRequestSchema,
    deadline: deadlineReferencePinSchema.nullable(),
    idempotent: z.boolean()
  }),
  'request.withdraw': z.strictObject({
    action: z.literal('request.withdraw'),
    request: fileRequestSchema
  }),
  'request.fulfill': z.strictObject({
    action: z.literal('request.fulfill'),
    request: fileRequestSchema
  })
} as const satisfies Record<FilesCommandAction, z.ZodType>);

const commandInputSchemas = Object.freeze({
  'upload.intent': fileUploadIntentRegisterInputSchema,
  'upload.confirm': fileUploadConfirmInputSchema,
  'attachment.attach': fileAttachInputSchema,
  'attachment.link': fileLinkAttachInputSchema,
  'attachment.detach': fileDetachInputSchema,
  'share.create': resourceShareCreateInputSchema,
  'share.revoke': resourceShareRevokeInputSchema,
  'request.create': fileRequestCreateInputSchema,
  'request.withdraw': fileRequestWithdrawInputSchema,
  'request.fulfill': fileRequestFulfillInputSchema
} as const satisfies Record<FilesCommandAction, z.ZodType>);

function operationName(action: FilesCommandAction): string {
  return `file.${action}`;
}

/** The wire operations: `file.<action>` v1, commit-tier, receipts required. */
export const FILES_COMMAND_OPERATIONS = Object.freeze(
  FILES_COMMAND_ACTIONS.map((action) => Object.freeze({
    action,
    name: operationName(action),
    version: 1
  }))
);

export const FILES_COMMAND_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.file.command', version: parseContractVersion(1)
});
/** The portal command lane reuses the participant portal act policy. */
export const FILES_PORTAL_COMMAND_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.portal.participant.act', version: parseContractVersion(1)
});
/**
 * D: agents draft file requests; they never move binary content. The mutation
 * runs on the `app_model` lane (the platform's agent effect surface); the
 * external MCP surface carries reads only, matching the platform's effect
 * binding vocabulary.
 */
export const FILES_AGENT_REQUEST_DRAFT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.file.agent-request-draft', version: parseContractVersion(1)
});
export const FILE_REQUEST_CREATE_DRAFT_OPERATION = Object.freeze({
  name: 'file.request.create.draft', version: 1
});

/** Actions a portal participant may perform (D8: authenticated portal lane). */
export const FILES_PORTAL_COMMAND_ACTIONS = Object.freeze([
  'upload.intent', 'upload.confirm', 'attachment.attach', 'attachment.link',
  'request.fulfill'
] as const satisfies readonly FilesCommandAction[]);

// ---------------------------------------------------------------------------
// Contribution schemas (mirrored by the persistence effect-domain adapter)
// ---------------------------------------------------------------------------

export const filesCommandDomainContributionSchema = z.strictObject({
  kind: z.literal('files_command'),
  preparationHandle: applicationIdSchema,
  action: filesCommandActionSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  /** The primary record the command created or transitioned. */
  recordId: applicationIdSchema,
  recordVersion: z.number().int().positive(),
  occurredAt: canonicalInstantSchema
});

export const filesCommandFactChildSchema = z.strictObject({
  kind: z.literal('domain_fact'),
  factId: applicationIdSchema,
  factKind: z.enum([
    'file_asset_changed', 'file_attachment_changed',
    'resource_share_changed', 'file_request_changed'
  ]),
  payload: z.json(),
  occurredAt: canonicalInstantSchema
});

export function filesCommandContributionSchema(action: FilesCommandAction) {
  const success = z.strictObject({
    result: z.strictObject({
      kind: z.literal('success'),
      data: commandDataSchemas[action]
    }),
    domain: filesCommandDomainContributionSchema,
    receiptChildren: z.array(filesCommandFactChildSchema).max(2)
  }).superRefine((contribution, context) => {
    if (contribution.domain.action !== action) {
      context.addIssue({ code: 'custom', message: 'Files command evidence is incoherent.' });
    }
  });
  const outcome = z.strictObject({
    result: z.strictObject({
      kind: z.literal('outcome'),
      outcome: structuredOutcomeSchema
    }),
    domain: z.null(),
    receiptChildren: z.tuple([])
  }).superRefine((contribution, context) => {
    const value = contribution.result.outcome;
    const allowed = new Set([
      'policy_violation:file.command_refused',
      'conflict:file.event_required'
    ]);
    const detail = value.kind === 'file.command_refused'
      ? filesCommandRefusalDetailSchema
      : z.null();
    if (!allowed.has(`${value.class}:${value.kind}`) || value.retryable
        || value.detailSchemaVersion !== 1 || !detail.safeParse(value.detail).success) {
      context.addIssue({ code: 'custom', message: 'Files command refusal is invalid.' });
    }
  });
  return z.union([success, outcome]);
}

export type FilesCommandContribution = z.infer<ReturnType<typeof filesCommandContributionSchema>>;

// ---------------------------------------------------------------------------
// Sealed preparation seam (adapter-owned, transaction-bound)
// ---------------------------------------------------------------------------

export interface FilesCommandPreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

/**
 * Transaction-owned preparation for one files command. The persistence
 * composition constructs it inside the unit of work around the
 * `@jooevents/files` domain functions and the SQLite repository; the handler
 * only transports its synchronous contribution.
 */
export interface FilesCommandPreparation {
  prepare(input: {
    readonly action: FilesCommandAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
    /**
     * Present exactly on the participant lane: the engagement ids the acting
     * participant's freshly evaluated relationship lists. The adapter must
     * refuse any record whose subject engagement is outside this set.
     */
    readonly portalRelationship: { readonly engagementIds: readonly string[] } | null;
  }): FilesCommandPreparedContribution;
}

export const FILES_COMMAND_HANDLER_CAPABILITY = ref('capability.file.command');
export const FILES_COMMAND_REQUEST_HASH_PROFILE = ref('request-hash.file.command');

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: FilesCommandPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealFilesCommandPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: FilesCommandPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('files_command_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('files_command_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'files_command', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

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

function portalRefusal(action: FilesCommandAction): FilesCommandPreparedContribution {
  return Object.freeze({
    result: Object.freeze({
      kind: 'outcome' as const,
      outcome: Object.freeze({
        class: 'policy_violation' as const,
        kind: 'file.command_refused',
        retryable: false,
        subjects: [],
        detail: Object.freeze({ action, code: 'portal_not_related' as const }),
        detailSchemaVersion: 1
      })
    }),
    domain: null,
    receiptChildren: Object.freeze([])
  });
}

function createFilesCommandHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly action: FilesCommandAction;
  readonly lane: 'operator' | 'participant' | 'app_model';
  readonly effect: 'draft' | 'commit';
  readonly handlerCapability?: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const handlerCapability = Object.freeze({
    ...(input.handlerCapability ?? FILES_COMMAND_HANDLER_CAPABILITY)
  });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: input.effect,
    handlerCapability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, handlerCapability)
          || sealed.context !== context
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_files_command_preparation');
      }
      sealed.phase = 'preparing';
      try {
        let portalRelationship: { readonly engagementIds: readonly string[] } | null = null;
        if (input.lane === 'participant') {
          const keys = portalEngagementGrantKeys(context);
          const engagementIds = [...keys]
            .filter((key) => key.startsWith('engagement:'))
            .map((key) => key.slice('engagement:'.length));
          portalRelationship = Object.freeze({ engagementIds: Object.freeze(engagementIds) });
          const guarded = portalSubjectGuard(input.action, businessInput, engagementIds);
          if (guarded !== undefined) {
            sealed.phase = 'spent';
            return { ...guarded, receiptChildren: [...guarded.receiptChildren] };
          }
        }
        const contribution = sealed.prepare({
          action: input.action,
          businessInput,
          context,
          portalRelationship
        });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('files_command_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          receiptChildren: [...contribution.receiptChildren]
        };
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}

/**
 * Statically checkable portal scoping: an attach/link whose subject is not an
 * engagement of the acting participant refuses before any adapter work.
 * Record-level checks (fulfil against an owned engagement, confirm of an own
 * intent) stay with the transaction-bound adapter via `portalRelationship`.
 */
export function portalSubjectGuard(
  action: FilesCommandAction,
  businessInput: unknown,
  engagementIds: readonly string[]
): FilesCommandPreparedContribution | undefined {
  if (action !== 'attachment.attach' && action !== 'attachment.link') return undefined;
  const parsed = z.object({
    subject: z.object({ kind: z.string() }).loose()
  }).loose().safeParse(businessInput);
  if (!parsed.success) return portalRefusal(action);
  const subject = parsed.data.subject as { kind: string; engagementId?: string };
  if (subject.kind !== 'engagement'
      || typeof subject.engagementId !== 'string'
      || !engagementIds.includes(subject.engagementId)) {
    return portalRefusal(action);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Module builders
// ---------------------------------------------------------------------------

interface CommandModuleShapeInput {
  readonly id: string;
  readonly laneKind: 'operator' | 'participant' | 'app_model';
  readonly lane: ReturnType<typeof parseOperationAccessLane>;
  readonly actions: readonly FilesCommandAction[];
  readonly pathPrefix: string | null;
  readonly scopeResolver: Parameters<typeof createEffectInvocationContextBuilder>[0]['scopeResolver'];
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: FilesOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

const commandPaths = Object.freeze({
  'upload.intent': 'uploads/intent',
  'upload.confirm': 'uploads/confirm',
  'attachment.attach': 'attachments/attach',
  'attachment.link': 'attachments/link',
  'attachment.detach': 'attachments/detach',
  'share.create': 'shares/create',
  'share.revoke': 'shares/revoke',
  'request.create': 'requests/create',
  'request.withdraw': 'requests/withdraw',
  'request.fulfill': 'requests/fulfill'
} as const satisfies Record<FilesCommandAction, string>);

function commandModule(input: CommandModuleShapeInput): OperationRegistryModule {
  const nullDetail = schemaRef(`schema.${input.id}.null-detail`, z.null());
  const refusalDetail = schemaRef(
    `schema.${input.id}.refusal-detail`, filesCommandRefusalDetailSchema
  );
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: nullDetail
  }));
  const built = input.actions.map((action) => {
    const operation = Object.freeze({ name: operationName(action), version: 1 });
    const prefix = `${input.id}.${action}`;
    const refs = Object.freeze({
      context: ref(`context.${prefix}`),
      autonomy: ref(`autonomy.${prefix}`),
      concurrency: ref(`concurrency.${prefix}`),
      family: ref(`${prefix}.execution-family`),
      phase: ref(`${prefix}.phase.single-uow`),
      terminalization: ref(`${prefix}.terminalization`),
      risk: ref(`${prefix}.risk-resolver`),
      autonomyEvidence: ref(`${prefix}.autonomy-evidence`),
      approval: ref(`${prefix}.approval-resolver`),
      preflight: ref(`${prefix}.autonomy-preflight`),
      handler: ref(`handler.${prefix}`),
      projection: ref(`projection.${prefix}`),
      audit: ref(`audit.${prefix}`),
      keySource: ref('idempotency.operator-header')
    });
    const contributionSchema = filesCommandContributionSchema(action);
    const canonicalSchema = z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('success'), data: commandDataSchemas[action] }),
      z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
    ]);
    const projectedSchema = createEffectfulOperationResultSchema(commandDataSchemas[action]);
    const schemas = Object.freeze({
      input: schemaRef(`schema.${prefix}.input`, commandInputSchemas[action]),
      contribution: schemaRef(`schema.${prefix}.contribution`, contributionSchema),
      canonical: schemaRef(`schema.${prefix}.canonical-result`, canonicalSchema),
      projected: schemaRef(`schema.${prefix}.projected-result`, projectedSchema)
    });
    const autonomy = createOperationAutonomyPolicy({
      definition: refs.autonomy,
      operation,
      riskFloor: 'low',
      unattendedRiskCeiling: 'normal',
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
    const context = createEffectInvocationContextBuilder({
      reference: refs.context,
      operation,
      effect: 'commit',
      lanes: [input.lane],
      scopeResolver: input.scopeResolver,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: FILES_COMMAND_REQUEST_HASH_PROFILE,
      requestHashSealer: input.requestHashSealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: refs.family, phase: refs.phase
    });
    const terminalization = createTerminalizationResolverRegistration({
      reference: refs.terminalization,
      operation,
      phase: refs.phase,
      resolve: ({ result }) => result.kind === 'success'
        ? Object.freeze({ kind: 'terminal' as const })
        : Object.freeze({ kind: 'nonterminal' as const })
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: refs.phase,
      family: refs.family,
      operation,
      effect: 'commit',
      handler: refs.handler,
      handlerCapability: FILES_COMMAND_HANDLER_CAPABILITY,
      contributionSchema: schemas.contribution,
      terminalization: refs.terminalization,
      terminalOutcomeKeys: [],
      contentionOutcome: Object.freeze({
        class: 'conflict' as const,
        kind: 'operation.in_progress',
        retryable: true,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      })
    });
    const risk = createOperationRiskResolverRegistration({
      reference: refs.risk,
      operation,
      resolve: () => Object.freeze({
        risk: 'normal' as const,
        consequenceTags: Object.freeze(['file-state-changed']),
        evidenceIds: Object.freeze([`${operation.name}.risk`])
      })
    });
    const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.autonomyEvidence,
      operation,
      resolve: ({ subject }) => {
        const notAfter = parseInstant(
          new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()
        );
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]),
          maximumSpendMicros: 0,
          maximumActions: 1,
          notAfter
        });
        return Object.freeze({
          evaluatedAt: subject.evaluatedAt,
          hardBounds: bounds,
          unattendedBounds: bounds,
          spendMicros: 0,
          actionCount: 1,
          completesBy: subject.evaluatedAt,
          proposedAction: Object.freeze({
            key: `${operation.name}.execute`,
            version: 1,
            digestSha256: subject.requestHashSha256
          }),
          failure: Object.freeze({ kind: 'none' as const })
        });
      }
    });
    const approval = createRenewedApprovalResolverRegistration({
      reference: refs.approval,
      operation,
      resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: refs.preflight,
      operation,
      policy: refs.autonomy,
      riskResolver: refs.risk,
      evidenceResolver: refs.autonomyEvidence,
      approvalResolver: refs.approval,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    const handler = createFilesCommandHandler({
      reference: refs.handler,
      action,
      lane: input.laneKind,
      effect: 'commit',
      contributionSchema: schemas.contribution,
      canonicalResultSchema: schemas.canonical
    });
    return Object.freeze({
      action, operation, refs, schemas, contributionSchema, canonicalSchema,
      projectedSchema, autonomy, context, family, terminalization, phase, risk,
      autonomyEvidence, approval, preflight, handler
    });
  });
  return Object.freeze({
    id: input.id,
    source: Object.freeze({
      effectExecutionFamilies: built.map((item) => item.family),
      effectPhases: built.map((item) => item.phase),
      terminalizationResolvers: built.map((item) => item.terminalization),
      riskResolvers: built.map((item) => item.risk),
      autonomyEvidenceResolvers: built.map((item) => item.autonomyEvidence),
      renewedApprovalResolvers: built.map((item) => item.approval),
      autonomyPreflights: built.map((item) => item.preflight),
      autonomyPolicies: built.map((item) => item.autonomy),
      schemas: [
        ...built.flatMap((item) => [
          { reference: item.schemas.input, schema: commandInputSchemas[item.action] },
          { reference: item.schemas.contribution, schema: item.contributionSchema },
          { reference: item.schemas.canonical, schema: item.canonicalSchema },
          { reference: item.schemas.projected, schema: item.projectedSchema }
        ]),
        { reference: nullDetail, schema: z.null() },
        { reference: refusalDetail, schema: filesCommandRefusalDetailSchema }
      ],
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      operations: Object.freeze([]),
      readOperationalTraceTargets: Object.freeze([]),
      projections: built.map((item) => Object.freeze({
        reference: item.refs.projection,
        canonicalResultSchema: item.schemas.canonical,
        projectedResultSchema: item.schemas.projected,
        project: (candidate: unknown) => item.canonicalSchema.parse(candidate)
      })),
      operationAuditTargets: built.map((item) => Object.freeze({
        reference: item.refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: ref(`record-profile.${input.id}.operation-audit`)
      })),
      operationAuditRecordProfiles: Object.freeze([{
        reference: ref(`record-profile.${input.id}.operation-audit`),
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      effectContextBuilders: built.map((item) => item.context),
      effectHandlers: built.map((item) => item.handler),
      effectOperations: built.map((item) => ({
        ...item.operation,
        lifecycle: { status: 'active' as const },
        summary: `Files command ${item.action}: idempotent, receipt-bearing, permission-gated.`,
        effect: 'commit' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: item.refs.autonomy,
        consequenceTags: ['file-state-changed'],
        inputSchema: item.schemas.input,
        contributionSchema: item.schemas.contribution,
        canonicalResultSchema: item.schemas.canonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed',
            retryable: false,
            detailSchema: nullDetail
          },
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'file.event_required',
            retryable: false,
            detailSchema: nullDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'file.command_refused',
            retryable: false,
            detailSchema: refusalDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(nullDetail)
        ],
        accessLanes: [input.lane],
        contextBuilder: item.refs.context,
        handlerCapability: FILES_COMMAND_HANDLER_CAPABILITY,
        handler: item.refs.handler,
        audit: { mode: 'required' as const, target: item.refs.audit },
        idempotency: {
          keySource: item.refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: FILES_COMMAND_REQUEST_HASH_PROFILE
        },
        concurrency: item.refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: item.refs.family,
          phase: item.refs.phase,
          terminalization: item.refs.terminalization,
          autonomyPreflight: item.refs.preflight
        },
        bindings: input.pathPrefix === null
          ? []
          : [{
              surface: input.lane.surface as 'operator_http' | 'participant_http',
              method: 'POST' as const,
              path: `${input.pathPrefix}/${commandPaths[item.action]}`,
              input: 'body' as const,
              browserResumption: { kind: 'none' as const },
              projection: item.refs.projection
            }]
      }))
    })
  });
}

export interface CreateFilesCommandOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly commandPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: FilesCurrentEventSource;
  readonly clock: Clock;
  readonly ids: FilesOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

/** All ten commands on the operator lane under `/api/events/current/files/...`. */
export function createFilesCommandOperationModule(
  input: CreateFilesCommandOperationModuleInput
): OperationRegistryModule {
  if (input.commandPolicy.key !== FILES_COMMAND_ACCESS_POLICY.key
      || input.commandPolicy.version !== FILES_COMMAND_ACCESS_POLICY.version) {
    throw new TypeError('files_command_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  return commandModule({
    id: 'files.command-operations',
    laneKind: 'operator',
    lane: parseOperationAccessLane({
      kind: 'operator', surface: 'operator_http', policy: input.commandPolicy
    }),
    actions: FILES_COMMAND_ACTIONS,
    pathPrefix: '/api/events/current/files',
    scopeResolver: filesCurrentEventScopeResolver({
      workspaceId, source: input.currentEvent
    }),
    currentAuthority: input.currentAuthority,
    clock: input.clock,
    ids: input.ids,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer
  });
}

export interface CreateFilesPortalCommandOperationModuleInput {
  readonly lane: {
    readonly workspaceId: WorkspaceId;
    readonly eventId: string;
  };
  readonly commandPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: FilesOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

/**
 * The participant portal command lane (D8): upload intent/confirm, attach and
 * link-attach on the participant's own engagement, and request fulfilment.
 * Authorization rides the participant relationship exclusively.
 */
export function createFilesPortalCommandOperationModule(
  input: CreateFilesPortalCommandOperationModuleInput
): OperationRegistryModule {
  if (input.commandPolicy.key !== FILES_PORTAL_COMMAND_ACCESS_POLICY.key
      || input.commandPolicy.version !== FILES_PORTAL_COMMAND_ACCESS_POLICY.version) {
    throw new TypeError('files_portal_command_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.lane.workspaceId);
  return commandModule({
    id: 'files.portal-command-operations',
    laneKind: 'participant',
    lane: parseOperationAccessLane({
      kind: 'participant', surface: 'participant_http', policy: input.commandPolicy
    }),
    actions: FILES_PORTAL_COMMAND_ACTIONS,
    pathPrefix: '/api/portal/files',
    scopeResolver: Object.freeze({
      resolve() {
        const eventId = parseEventId(input.lane.eventId);
        return Object.freeze({
          workspaceId,
          eventId,
          subjects: Object.freeze([
            { kind: 'workspace' as const, id: workspaceId },
            { kind: 'event' as const, id: eventId }
          ]),
          resolutionEvidenceIds: Object.freeze(['files.portal.lane'])
        });
      }
    }),
    currentAuthority: input.currentAuthority,
    clock: input.clock,
    ids: input.ids,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer
  });
}

// ---------------------------------------------------------------------------
// MCP request-draft module (agents draft asks; they never upload bytes)
// ---------------------------------------------------------------------------

export const fileRequestDraftDataSchema = z.strictObject({
  action: z.literal('request.create.draft'),
  changesetId: applicationIdSchema,
  proposal: fileRequestCreateInputSchema,
  deadline: deadlineReferencePinSchema.nullable()
});

export const fileRequestDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('files_request_draft'),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: canonicalInstantSchema
});

export const fileRequestDraftContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: fileRequestDraftDataSchema }),
    domain: fileRequestDraftDomainContributionSchema,
    receiptChildren: z.array(filesCommandFactChildSchema).max(1)
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    receiptChildren: z.tuple([])
  })
]);

export interface FileRequestDraftPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): FilesCommandPreparedContribution;
}

export const FILE_REQUEST_DRAFT_HANDLER_CAPABILITY = ref('capability.file.request-draft');

export function sealFileRequestDraftPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: FileRequestDraftPreparation;
}): EffectHandlerSnapshot {
  return sealFilesCommandPreparation({
    capability: input.capability,
    context: input.context,
    preparation: {
      prepare: ({ businessInput, context }) =>
        input.preparation.prepare({ businessInput, context })
    }
  });
}

/**
 * The one MCP-lane mutation: draft a file request as an inert changeset for
 * organizer review. Reads aside, agents get nothing else — binary upload
 * operations are deliberately absent from this lane.
 */
export function createFilesAgentRequestDraftOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly draftPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: FilesCurrentEventSource;
  readonly clock: Clock;
  readonly ids: FilesOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}): OperationRegistryModule {
  if (input.draftPolicy.key !== FILES_AGENT_REQUEST_DRAFT_ACCESS_POLICY.key
      || input.draftPolicy.version !== FILES_AGENT_REQUEST_DRAFT_ACCESS_POLICY.version) {
    throw new TypeError('files_agent_request_draft_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({
    kind: 'app_model', surface: 'app_model', policy: input.draftPolicy
  });
  const operation = FILE_REQUEST_CREATE_DRAFT_OPERATION;
  const nullDetail = schemaRef('schema.file.request-draft.null-detail', z.null());
  const refs = Object.freeze({
    context: ref('context.file.request.create-draft'),
    autonomy: ref('autonomy.file.request.create-draft'),
    concurrency: ref('concurrency.file.request.create-draft'),
    family: ref('file.request.create-draft.execution-family'),
    phase: ref('file.request.create-draft.phase.single-uow'),
    terminalization: ref('file.request.create-draft.terminalization'),
    risk: ref('file.request.create-draft.risk-resolver'),
    autonomyEvidence: ref('file.request.create-draft.autonomy-evidence'),
    approval: ref('file.request.create-draft.approval-resolver'),
    preflight: ref('file.request.create-draft.autonomy-preflight'),
    handler: ref('handler.file.request.create-draft'),
    projection: ref('projection.file.request.create-draft'),
    audit: ref('audit.file.request.create-draft'),
    auditProfile: ref('record-profile.file.request-draft.operation-audit'),
    keySource: ref('idempotency.mcp-header')
  });
  const canonicalSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('success'), data: fileRequestDraftDataSchema }),
    z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
  ]);
  const projectedSchema = createEffectfulOperationResultSchema(fileRequestDraftDataSchema);
  const requestDraftRefusalDetail = schemaRef(
    'schema.file.request-draft.refusal-detail', filesCommandRefusalDetailSchema
  );
  const schemas = Object.freeze({
    input: schemaRef('schema.file.request-draft.input', fileRequestCreateInputSchema),
    contribution: schemaRef(
      'schema.file.request-draft.contribution', fileRequestDraftContributionSchema
    ),
    canonical: schemaRef('schema.file.request-draft.canonical-result', canonicalSchema),
    projected: schemaRef('schema.file.request-draft.projected-result', projectedSchema)
  });
  const autonomy = createOperationAutonomyPolicy({
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
  });
  const context = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation,
    effect: 'draft',
    lanes: [lane],
    scopeResolver: filesCurrentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: FILES_COMMAND_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.family, phase: refs.phase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation,
    effect: 'draft',
    handler: refs.handler,
    handlerCapability: FILE_REQUEST_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const,
      kind: 'operation.in_progress',
      retryable: true,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk,
    operation,
    resolve: () => Object.freeze({
      risk: 'low' as const,
      consequenceTags: Object.freeze(['changeset-drafted']),
      evidenceIds: Object.freeze(['file.request.create.draft.risk'])
    })
  });
  const autonomyEvidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.autonomyEvidence,
    operation,
    resolve: ({ subject }) => {
      const notAfter = parseInstant(
        new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()
      );
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]),
        maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt,
        hardBounds: bounds,
        unattendedBounds: bounds,
        spendMicros: 0,
        actionCount: 1,
        completesBy: subject.evaluatedAt,
        proposedAction: Object.freeze({
          key: 'file.request.create.draft.execute',
          version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation,
    policy: refs.autonomy,
    riskResolver: refs.risk,
    evidenceResolver: refs.autonomyEvidence,
    approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createFilesCommandHandler({
    reference: refs.handler,
    action: 'request.create',
    lane: 'app_model',
    effect: 'draft',
    handlerCapability: FILE_REQUEST_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: nullDetail
  }));
  return Object.freeze({
    id: 'files.agent-request-draft.operation',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze([family]),
      effectPhases: Object.freeze([phase]),
      terminalizationResolvers: Object.freeze([terminalization]),
      riskResolvers: Object.freeze([risk]),
      autonomyEvidenceResolvers: Object.freeze([autonomyEvidence]),
      renewedApprovalResolvers: Object.freeze([approval]),
      autonomyPreflights: Object.freeze([preflight]),
      autonomyPolicies: Object.freeze([autonomy]),
      schemas: Object.freeze([
        { reference: schemas.input, schema: fileRequestCreateInputSchema },
        { reference: schemas.contribution, schema: fileRequestDraftContributionSchema },
        { reference: schemas.canonical, schema: canonicalSchema },
        { reference: schemas.projected, schema: projectedSchema },
        { reference: nullDetail, schema: z.null() },
        { reference: requestDraftRefusalDetail, schema: filesCommandRefusalDetailSchema }
      ]),
      contextBuilders: Object.freeze([]),
      readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]),
      operations: Object.freeze([]),
      readOperationalTraceTargets: Object.freeze([]),
      projections: Object.freeze([{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => canonicalSchema.parse(candidate)
      }]),
      operationAuditTargets: Object.freeze([{
        reference: refs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: refs.auditProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: refs.auditProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      effectContextBuilders: Object.freeze([context]),
      effectHandlers: Object.freeze([handler]),
      effectOperations: Object.freeze([{
        ...operation,
        lifecycle: { status: 'active' as const },
        summary: 'Draft one file request as an inert changeset for organizer review (MCP lane).',
        effect: 'draft' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['changeset-drafted'],
        inputSchema: schemas.input,
        contributionSchema: schemas.contribution,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed',
            retryable: false,
            detailSchema: nullDetail
          },
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'file.event_required',
            retryable: false,
            detailSchema: nullDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'file.command_refused',
            retryable: false,
            detailSchema: requestDraftRefusalDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: refs.context,
        handlerCapability: FILE_REQUEST_DRAFT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: FILES_COMMAND_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: refs.family,
          phase: refs.phase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight
        },
        bindings: [{
          surface: 'app_model' as const,
          toolName: operation.name,
          projection: refs.projection
        }]
      }])
    })
  });
}
