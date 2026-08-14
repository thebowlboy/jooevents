import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createReadInvocationContextBuilder,
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
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer,
  type ReturnTypeOrPromise
} from '@jooevents/application';
import {
  ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  organizerMessagePreviewCanonicalResultSchema,
  organizerPrepareMessagePreviewCanonicalResultSchema,
  organizerPrepareMessagePreviewOperationResultSchema,
  organizerPreviewMessageBatchInputSchema,
  organizerPreviewMessageBatchOperationResultSchema,
  organizerPreviewMessageBatchResultSchema,
  organizerSendMessagesCanonicalResultSchema,
  organizerSendMessagesInputSchema,
  organizerSendMessagesOperationResultSchema,
  organizerSendMessagesResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  type OrganizerCommunicationCanonicalResult,
  type OrganizerCommunicationCurrentEventSource,
  type OrganizerCommunicationScope
} from './organizer-authoring-module';
import {
  SEND_MESSAGES_DRAFT_ACCESS_POLICY,
  SEND_MESSAGES_OPERATION,
  sendMessagesSafeDiffSchema
} from './send-module';

/**
 * The decision-notification send lane's operator operations.
 *
 * Preview adoption is a two-step lane because the engine's sealed effect
 * preparations are synchronous by contract while audience resolution and
 * per-recipient rendering are asynchronous: `prepare_message_batch_preview`
 * (a compute-only read) runs the asynchronous preparation and parks it
 * server-side against the exact draft revision, and `preview_message_batch`
 * (the effect) adopts the parked preparation inside its one unit-of-work
 * transaction, where draft version and audience guard state are re-verified
 * before anything is written. `send_messages` then commits the adopted
 * preview as one irreversible release batch — the whole
 * draft -> propose -> commit ceremony (recorder default BLOCKED-3), the
 * immutable releases, and the outbox delivery registrations ride one
 * transaction server-side, and a preview whose evidence no longer reproduces
 * from current domain state refuses typed instead of sending.
 */
export const COMMUNICATION_SEND_LANE_OPERATIONS = Object.freeze({
  previewBatch: Object.freeze({ name: 'preview_message_batch', version: 1 }),
  sendMessages: SEND_MESSAGES_OPERATION
});

export const PREPARE_MESSAGE_BATCH_PREVIEW_OPERATION = Object.freeze({
  name: 'prepare_message_batch_preview',
  version: 1
});

export type CommunicationSendLaneOperationName = 'preview_message_batch' | 'send_messages';

/** Exact persistence/runtime seam for the two send-lane effect operations. */
export const COMMUNICATION_SEND_LANE_HANDLER_CAPABILITY_BY_OPERATION = Object.freeze({
  preview_message_batch: Object.freeze({
    key: 'capability.communication.organizer.preview_message_batch',
    version: 1
  }),
  send_messages: Object.freeze({
    key: 'capability.communication.organizer.send_messages',
    version: 1
  })
} satisfies Readonly<Record<CommunicationSendLaneOperationName, VersionedDefinitionRef>>);

/**
 * Pre-transaction adoption preparer, driven by the
 * `prepare_message_batch_preview` read. The runtime implements it over the
 * audience-preview repository: it performs the asynchronous, compute-only
 * preview preparation (audience resolution + per-recipient render, no writes)
 * and parks the prepared handle against the draft revision for the
 * `preview_message_batch` effect-domain adapter to consume inside the unit of
 * work. Preparing is side-effect-free, so an unadopted preparation merely
 * expires unused.
 */
export interface CommunicationPreviewAdoptionPreparer {
  prepareAdoption(input: {
    readonly scope: OrganizerCommunicationScope;
    readonly businessInput: unknown;
  }): ReturnTypeOrPromise<OrganizerCommunicationCanonicalResult>;
}

const canonicalIdSchema = z.string().min(1).max(256);

export const communicationSendLaneDomainContributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('communication_preview_adopted'),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    audienceSpecId: canonicalIdSchema,
    draftId: canonicalIdSchema,
    draftVersion: z.number().int().positive().safe(),
    previewGeneration: z.number().int().positive().safe(),
    occurredAt: z.iso.datetime({ offset: true })
  }),
  z.strictObject({
    kind: z.literal('communication_send_committed'),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    batchId: canonicalIdSchema,
    changesetId: canonicalIdSchema,
    commitReceiptId: canonicalIdSchema,
    releaseCount: z.number().int().positive().safe(),
    deliveryCount: z.number().int().positive().safe(),
    occurredAt: z.iso.datetime({ offset: true })
  })
]);

const sendLaneSuccessDataSchema = z.union([
  organizerPreviewMessageBatchResultSchema,
  organizerSendMessagesResultSchema
]);

export const communicationSendLaneContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: sendLaneSuccessDataSchema }),
    domain: communicationSendLaneDomainContributionSchema,
    receiptChildren: z.tuple([])
  }).superRefine((contribution, context) => {
    const data = contribution.result.data;
    const isSummary = 'identity' in data;
    const domain = contribution.domain;
    if (domain.kind === 'communication_preview_adopted') {
      if (!isSummary
          || data.identity.audienceSpecId !== domain.audienceSpecId
          || data.identity.draftId !== domain.draftId
          || data.identity.draftVersion !== domain.draftVersion
          || data.identity.previewGeneration !== domain.previewGeneration) {
        context.addIssue({
          code: 'custom',
          message: 'Adoption evidence does not bind the adopted preview summary.'
        });
      }
      return;
    }
    if (isSummary
        || data.batchId !== domain.batchId
        || data.changesetId !== domain.changesetId
        || data.releaseCount !== domain.releaseCount
        || data.deliveryCount !== domain.deliveryCount) {
      context.addIssue({
        code: 'custom',
        message: 'Send evidence does not bind the committed release batch.'
      });
    }
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    receiptChildren: z.tuple([])
  })
]);

export type CommunicationSendLaneContribution = z.infer<
  typeof communicationSendLaneContributionSchema
>;

export interface CommunicationSendLanePreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

export interface CommunicationSendLanePreparation {
  prepare(input: {
    readonly operationName: CommunicationSendLaneOperationName;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): CommunicationSendLanePreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly operationName: CommunicationSendLaneOperationName;
  readonly prepare: CommunicationSendLanePreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

/** Seals one transaction-local, synchronous send-lane step. */
export function sealCommunicationSendLanePreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly operationName: CommunicationSendLaneOperationName;
  readonly preparation: CommunicationSendLanePreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function'
      || input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('communication_send_lane_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'communication_send_lane', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    operationName: input.operationName,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createSendLaneHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly operationName: CommunicationSendLaneOperationName;
  readonly effect: 'draft' | 'commit';
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: EffectHandlerRegistration['contributionSchema'];
  readonly canonicalResultSchema: EffectHandlerRegistration['canonicalResultSchema'];
}): EffectHandlerRegistration {
  const capability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: input.effect,
    handlerCapability: capability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, capability)
          || sealed.context !== context
          || sealed.operationName !== input.operationName
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_communication_send_lane_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({
          operationName: input.operationName,
          businessInput,
          context
        });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('communication_send_lane_preparation_must_be_synchronous');
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

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
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

const nullDetailSchema = z.null();
const sharedRefs = Object.freeze({
  nullDetail: schemaRef('schema.communication.organizer.send-lane.null-detail', nullDetailSchema),
  /**
   * `send_messages` refuses a drifted preview with the reviewed safe diff as
   * its detail (the ceremony's own declared outcome shape); declaring null
   * here would make the engine reject the produced refusal as undeclared.
   */
  previewChangedDetail: schemaRef(
    'schema.communication.organizer.send-lane.preview-changed-detail',
    sendMessagesSafeDiffSchema
  ),
  effectAudit: ref('audit.communication.organizer.send-lane'),
  auditRecord: ref('record-profile.communication.organizer.send-lane'),
  contribution: schemaRef(
    'schema.communication.organizer.send-lane.contribution',
    communicationSendLaneContributionSchema
  ),
  keySource: ref('idempotency.operator-or-tool-header')
});

export interface CommunicationSendOperationIds {
  newInvocationId(): InvocationId;
}

export interface CommunicationSendOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

type SendLaneKey = keyof typeof COMMUNICATION_SEND_LANE_OPERATIONS;

/**
 * Operator-only in v1: the send ceremony derives its `changeset.commit`
 * receipt from the invoking operator's own attribution (BLOCKED-3), and no
 * agent send policy is recorded yet, so no MCP or app-model lane is compiled.
 */
export function createCommunicationSendOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly draftPolicy: VersionedAccessPolicyRef;
  readonly sendPolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: OrganizerCommunicationCurrentEventSource;
  readonly adoptionPreparer: CommunicationPreviewAdoptionPreparer;
  readonly clock: Clock;
  readonly ids: CommunicationSendOperationIds;
  readonly crypto: CommunicationSendOperationCrypto;
}): OperationRegistryModule {
  if (input.draftPolicy.key !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.key
      || input.draftPolicy.version !== ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY.version
      || input.sendPolicy.key !== SEND_MESSAGES_DRAFT_ACCESS_POLICY.key
      || input.sendPolicy.version !== SEND_MESSAGES_DRAFT_ACCESS_POLICY.version) {
    throw new TypeError('communication_send_operation_policy_catalog_mismatch');
  }
  if (typeof input.adoptionPreparer?.prepareAdoption !== 'function') {
    throw new TypeError('communication_send_operation_adoption_preparer_invalid');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const scopeResolver = Object.freeze({
    async resolve() {
      const selected = await input.currentEvent.resolveCurrentEvent(workspaceId);
      if (selected === undefined) {
        return Object.freeze({
          workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
          resolutionEvidenceIds: Object.freeze(['workspace.current', 'event.selection.absent'])
        });
      }
      const eventId = parseEventId(selected.eventId);
      const evidenceIds = [...new Set(['workspace.current', ...selected.evidenceIds])].sort();
      return Object.freeze({
        workspaceId,
        eventId,
        subjects: Object.freeze([
          { kind: 'workspace' as const, id: workspaceId },
          { kind: 'event' as const, id: eventId }
        ]),
        resolutionEvidenceIds: Object.freeze(evidenceIds)
      });
    }
  });

  const catalog = Object.freeze({
    previewBatch: Object.freeze({
      policy: input.draftPolicy,
      effect: 'draft' as const,
      refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.previewBatch,
      inputSchema: organizerPreviewMessageBatchInputSchema,
      canonicalSchema: organizerMessagePreviewCanonicalResultSchema,
      projectedSchema: organizerPreviewMessageBatchOperationResultSchema,
      path: '/api/events/current/communications/previews/adopt',
      consequenceTag: 'communication-preview-adopted',
      summary: 'Adopt one prepared, reviewed audience preview for a draft.'
    }),
    sendMessages: Object.freeze({
      policy: input.sendPolicy,
      effect: 'commit' as const,
      refs: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.sendMessages,
      inputSchema: organizerSendMessagesInputSchema,
      canonicalSchema: organizerSendMessagesCanonicalResultSchema,
      projectedSchema: organizerSendMessagesOperationResultSchema,
      path: '/api/events/current/communications/messages/send',
      consequenceTag: 'communication-messages-sent',
      summary: 'Commit one adopted, reviewed preview as an irreversible release batch.'
    })
  });

  const prepareOperation = PREPARE_MESSAGE_BATCH_PREVIEW_OPERATION;
  const prepareBase = `communication.organizer.${prepareOperation.name}`;
  const prepareRefs = Object.freeze({
    autonomy: ref(`autonomy.${prepareBase}`),
    context: ref(`context.${prepareBase}`),
    capability: ref(`capability.${prepareBase}`),
    handler: ref(`handler.${prepareBase}`),
    projection: ref(`projection.${prepareBase}`),
    trace: ref(`trace.${prepareBase}`),
    canonical: schemaRef(
      `schema.${prepareBase}.canonical-result`,
      organizerPrepareMessagePreviewCanonicalResultSchema
    )
  });
  const prepareLanes = Object.freeze([
    parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy: input.draftPolicy
    })
  ]);
  const prepareAutonomy = createOperationAutonomyPolicy({
    definition: prepareRefs.autonomy,
    operation: prepareOperation,
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
  const prepareContext = createReadInvocationContextBuilder({
    reference: prepareRefs.context,
    operation: prepareOperation,
    effect: 'read',
    lanes: prepareLanes,
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.crypto.scopePartitionProfile,
    requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });

  const entries = (Object.keys(COMMUNICATION_SEND_LANE_OPERATIONS) as SendLaneKey[]).map((key) => {
    const operation = COMMUNICATION_SEND_LANE_OPERATIONS[key];
    const operationName = operation.name as CommunicationSendLaneOperationName;
    const entryCatalog = catalog[key];
    const lanes = Object.freeze([
      parseOperationAccessLane({
        kind: 'operator',
        surface: 'operator_http',
        policy: entryCatalog.policy
      })
    ]);
    const base = `communication.organizer.${operation.name}`;
    const refs = Object.freeze({
      autonomy: ref(`autonomy.${base}`),
      context: ref(`context.${base}`),
      handler: ref(`handler.${base}`),
      capability: COMMUNICATION_SEND_LANE_HANDLER_CAPABILITY_BY_OPERATION[operationName],
      projection: ref(`projection.${base}`),
      canonical: schemaRef(`schema.${base}.canonical-result`, entryCatalog.canonicalSchema),
      requestHash: ref(`request-hash.${base}`),
      concurrency: ref(`concurrency.${base}`),
      family: ref(`${base}.execution-family`),
      phase: ref(`${base}.phase.single-uow`),
      terminalization: ref(`${base}.terminalization`),
      risk: ref(`${base}.risk-resolver`),
      evidence: ref(`${base}.autonomy-evidence`),
      approval: ref(`${base}.approval-resolver`),
      preflight: ref(`${base}.autonomy-preflight`)
    });
    const autonomy = createOperationAutonomyPolicy({
      definition: refs.autonomy,
      operation,
      riskFloor: 'normal',
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
      effect: entryCatalog.effect,
      lanes,
      scopeResolver,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.crypto.scopePartitionProfile,
      requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
      requestHashProfile: refs.requestHash,
      requestHashSealer: input.crypto.requestHashSealer,
      idempotencyCredentialProfile: input.crypto.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.crypto.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: refs.family,
      phase: refs.phase
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
      effect: entryCatalog.effect,
      handler: refs.handler,
      handlerCapability: refs.capability,
      contributionSchema: sharedRefs.contribution,
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
        consequenceTags: Object.freeze([entryCatalog.consequenceTag]),
        evidenceIds: Object.freeze([`${operation.name}.risk`])
      })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: refs.evidence,
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
      evidenceResolver: refs.evidence,
      approvalResolver: refs.approval,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    const handler = createSendLaneHandler({
      reference: refs.handler,
      operationName,
      effect: entryCatalog.effect,
      handlerCapability: refs.capability,
      contributionSchema: sharedRefs.contribution,
      canonicalResultSchema: refs.canonical
    });
    return Object.freeze({
      key, operation, operationName, catalog: entryCatalog, lanes, refs, autonomy,
      context, family, terminalization, phase, risk, evidence, approval, preflight, handler
    });
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: sharedRefs.nullDetail
  }));
  const schemaMap = new Map<string, {
    readonly reference: SafeSchemaManifestRef;
    readonly schema: z.ZodType;
  }>();
  const addSchema = (reference: SafeSchemaManifestRef, schema: z.ZodType) => {
    schemaMap.set(
      `${reference.key}@${reference.version}:${reference.digestSha256}`,
      { reference, schema }
    );
  };
  addSchema(sharedRefs.nullDetail, nullDetailSchema);
  addSchema(sharedRefs.previewChangedDetail, sendMessagesSafeDiffSchema);
  addSchema(sharedRefs.contribution, communicationSendLaneContributionSchema);
  addSchema(
    ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.prepareBatchPreview.inputSchema,
    organizerPreviewMessageBatchInputSchema
  );
  addSchema(prepareRefs.canonical, organizerPrepareMessagePreviewCanonicalResultSchema);
  addSchema(
    ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.prepareBatchPreview.resultSchema,
    organizerPrepareMessagePreviewOperationResultSchema
  );
  for (const entry of entries) {
    addSchema(entry.catalog.refs.inputSchema, entry.catalog.inputSchema);
    addSchema(entry.refs.canonical, entry.catalog.canonicalSchema);
    addSchema(entry.catalog.refs.resultSchema, entry.catalog.projectedSchema);
  }

  return Object.freeze({
    id: 'communication.organizer.send-lane-operations',
    source: Object.freeze({
      autonomyPolicies: Object.freeze([
        prepareAutonomy,
        ...entries.map((entry) => entry.autonomy)
      ]),
      schemas: Object.freeze([...schemaMap.values()]),
      contextBuilders: Object.freeze([prepareContext]),
      readCapabilities: Object.freeze([{
        reference: prepareRefs.capability,
        openSnapshot: (invocation: ReadInvocationContext) => Object.freeze({ context: invocation })
      } satisfies ReadCapabilityRegistration]),
      handlers: Object.freeze([{
        reference: prepareRefs.handler,
        readCapability: prepareRefs.capability,
        canonicalResultSchema: prepareRefs.canonical,
        handle: async ({ businessInput, context: invocation }: {
          readonly businessInput: unknown;
          readonly context: ReadInvocationContext;
        }) => {
          if (invocation.scope.eventId === undefined) {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: Object.freeze({
                class: 'conflict' as const,
                kind: 'communication.event_required',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: 1
              })
            });
          }
          return await input.adoptionPreparer.prepareAdoption({
            scope: Object.freeze({
              workspaceId: parseWorkspaceId(invocation.scope.workspaceId),
              eventId: parseEventId(invocation.scope.eventId)
            }),
            businessInput
          });
        }
      }]),
      projections: Object.freeze([
        {
          reference: prepareRefs.projection,
          canonicalResultSchema: prepareRefs.canonical,
          projectedResultSchema:
            ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.prepareBatchPreview.resultSchema,
          project: (candidate: unknown) =>
            organizerPrepareMessagePreviewCanonicalResultSchema.parse(candidate)
        },
        ...entries.map((entry) => ({
          reference: entry.refs.projection,
          canonicalResultSchema: entry.refs.canonical,
          projectedResultSchema: entry.catalog.refs.resultSchema,
          project: (candidate: unknown) => entry.catalog.canonicalSchema.parse(candidate)
        }))
      ]),
      readOperationalTraceTargets: Object.freeze([{
        reference: prepareRefs.trace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: sharedRefs.auditRecord
      }]),
      operationAuditTargets: Object.freeze([{
        reference: sharedRefs.effectAudit,
        kind: 'operation_audit_record' as const,
        recordProfile: sharedRefs.auditRecord
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: sharedRefs.auditRecord,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }]),
      operations: Object.freeze([{
        ...prepareOperation,
        lifecycle: { status: 'active' as const },
        summary:
          'Prepare one reviewed audience preview for a draft; the effect adopts it.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: prepareRefs.autonomy,
        consequenceTags: [],
        inputSchema: ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.prepareBatchPreview.inputSchema,
        canonicalResultSchema: prepareRefs.canonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'communication.event_required',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'communication.not_found',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'communication.revision_changed',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'communication.preview_invalid',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          }
        ],
        accessLanes: prepareLanes,
        contextBuilder: prepareRefs.context,
        readCapability: prepareRefs.capability,
        handler: prepareRefs.handler,
        observability: {
          trace: { mode: 'required' as const, target: prepareRefs.trace },
          // Operator-only lane: the machine-audit mode requires an MCP or
          // app-model binding, and no agent send policy is recorded yet.
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [
          {
            surface: 'operator_http' as const,
            method: 'GET' as const,
            path: '/api/events/current/communications/previews/prepare',
            input: 'query' as const,
            browserResumption: { kind: 'none' as const },
            projection: prepareRefs.projection
          }
        ]
      }]),
      effectExecutionFamilies: Object.freeze(entries.map((entry) => entry.family)),
      effectPhases: Object.freeze(entries.map((entry) => entry.phase)),
      terminalizationResolvers: Object.freeze(entries.map((entry) => entry.terminalization)),
      riskResolvers: Object.freeze(entries.map((entry) => entry.risk)),
      autonomyEvidenceResolvers: Object.freeze(entries.map((entry) => entry.evidence)),
      renewedApprovalResolvers: Object.freeze(entries.map((entry) => entry.approval)),
      autonomyPreflights: Object.freeze(entries.map((entry) => entry.preflight)),
      effectContextBuilders: Object.freeze(entries.map((entry) => entry.context)),
      effectHandlers: Object.freeze(entries.map((entry) => entry.handler)),
      effectOperations: Object.freeze(entries.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: entry.catalog.summary,
        effect: entry.catalog.effect,
        maxRisk: 'normal' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: [entry.catalog.consequenceTag],
        inputSchema: entry.catalog.refs.inputSchema,
        contributionSchema: sharedRefs.contribution,
        canonicalResultSchema: entry.refs.canonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'communication.event_required',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'communication.not_found',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'stale_revision' as const,
            kind: entry.operationName === 'send_messages'
              ? 'communication.preview_changed'
              : 'communication.revision_changed',
            retryable: false,
            detailSchema: entry.operationName === 'send_messages'
              ? sharedRefs.previewChangedDetail
              : sharedRefs.nullDetail
          },
          {
            class: 'policy_violation' as const,
            kind: 'communication.preview_invalid',
            retryable: false,
            detailSchema: sharedRefs.nullDetail
          },
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: sharedRefs.nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(sharedRefs.nullDetail)
        ],
        accessLanes: entry.lanes,
        contextBuilder: entry.refs.context,
        handlerCapability: entry.refs.capability,
        handler: entry.refs.handler,
        audit: { mode: 'required' as const, target: sharedRefs.effectAudit },
        idempotency: {
          keySource: sharedRefs.keySource,
          credentialVerifierProfile: input.crypto.idempotencyCredentialProfile,
          requestHashProfile: entry.refs.requestHash
        },
        concurrency: entry.refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: entry.refs.family,
          phase: entry.refs.phase,
          terminalization: entry.refs.terminalization,
          autonomyPreflight: entry.refs.preflight
        },
        bindings: [
          {
            surface: 'operator_http' as const,
            method: 'POST' as const,
            path: entry.catalog.path,
            input: 'body' as const,
            browserResumption: { kind: 'none' as const },
            projection: entry.refs.projection
          }
        ]
      })))
    })
  });
}
