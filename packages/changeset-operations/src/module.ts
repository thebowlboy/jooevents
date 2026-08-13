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
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer
} from '@jooevents/application';
import {
  approveChangesetRevisionInputSchema,
  createSafeSchemaManifestRef,
  approvedChangesetDataSchema,
  approvedChangesetOperationResultSchema,
  CHANGESET_OPERATION_SCHEMA_REFS,
  changesetApplicationIdSchema,
  changesetApprovalPolicyViewSchema,
  changesetCanonicalInstantSchema,
  changesetDiffCanonicalResultSchema,
  changesetDiffDataSchema,
  changesetDiffInputSchema,
  changesetDiffOperationResultSchema,
  changesetLifecycleCanonicalResultSchema,
  changesetLifecycleDataSchema,
  changesetLifecycleOperationResultSchema,
  changesetRevisionSelectorSchema,
  commitChangesetInputSchema,
  committedChangesetDataSchema,
  committedChangesetOperationResultSchema,
  draftChangesetCorrectionInputSchema,
  draftedChangesetCorrectionDataSchema,
  draftedChangesetCorrectionOperationResultSchema,
  proposeChangesetInputSchema,
  proposedChangesetDataSchema,
  proposedChangesetOperationResultSchema,
  rebuildChangesetInputSchema,
  rebuiltChangesetDataSchema,
  rebuiltChangesetOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentResolvedAuthority,
  type PermissionId,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId,
  type Clock,
  type EventId,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  readChangesetDiff,
  type ChangesetLifecycleRefusal,
  type ChangesetLifecycleStore
} from './lifecycle';
import {
  projectStoredChangesetDiff,
  type StoredChangesetRecord
} from './records';

export {
  approveChangesetRevisionInputSchema,
  approvedChangesetDataSchema,
  approvedChangesetOperationResultSchema,
  changesetApplicationIdSchema,
  changesetApprovalPolicyViewSchema,
  changesetCanonicalInstantSchema,
  changesetDiffCanonicalResultSchema,
  changesetDiffDataSchema,
  changesetDiffInputSchema,
  changesetDiffOperationResultSchema,
  changesetLifecycleCanonicalResultSchema,
  changesetLifecycleDataSchema,
  changesetLifecycleOperationResultSchema,
  changesetRevisionSelectorSchema,
  commitChangesetInputSchema,
  committedChangesetDataSchema,
  committedChangesetOperationResultSchema,
  draftChangesetCorrectionInputSchema,
  draftedChangesetCorrectionDataSchema,
  draftedChangesetCorrectionOperationResultSchema,
  proposeChangesetInputSchema,
  proposedChangesetDataSchema,
  proposedChangesetOperationResultSchema,
  rebuildChangesetInputSchema,
  rebuiltChangesetDataSchema,
  rebuiltChangesetOperationResultSchema
} from '@jooevents/contracts';

export const GET_CHANGESET_DIFF_OPERATION = Object.freeze({
  name: 'changeset.diff.read', version: 1
});
export const PROPOSE_CHANGESET_OPERATION = Object.freeze({
  name: 'changeset.propose', version: 1
});
export const APPROVE_CHANGESET_REVISION_OPERATION = Object.freeze({
  name: 'changeset.approve', version: 1
});
export const REBUILD_CHANGESET_OPERATION = Object.freeze({
  name: 'changeset.rebuild', version: 1
});
export const DRAFT_CHANGESET_CORRECTION_OPERATION = Object.freeze({
  name: 'changeset.correction.draft', version: 1
});
export const COMMIT_CHANGESET_OPERATION = Object.freeze({
  name: 'changeset.commit', version: 1
});

export type ChangesetLifecycleAction =
  | 'propose'
  | 'approve'
  | 'rebuild'
  | 'correction'
  | 'commit';

const applicationIdSchema = changesetApplicationIdSchema;
const positiveIntegerSchema = z.number().int().positive().safe();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const stableKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const canonicalInstantSchema = changesetCanonicalInstantSchema;
const nullDetailSchema = z.null();

export const changesetLifecycleRefusalDetailSchema = z.strictObject({
  code: z.enum([
    'not_found', 'scope_changed', 'id_collision', 'wrong_status', 'stale_head',
    'revision_changed', 'definition_changed', 'policy_changed',
    'invalid_rebuild_selection', 'approval_not_required',
    'approval_separation_required', 'approval_changed', 'base_version_changed',
    'guard_changed', 'approval_missing', 'approval_invalid', 'domain_changed'
  ]),
  status: z.enum(['draft', 'proposed', 'committed', 'discarded']).optional(),
  expected: positiveIntegerSchema.optional(),
  actual: positiveIntegerSchema.optional(),
  operationIndex: z.number().int().nonnegative().safe().optional(),
  subjectId: z.string().trim().min(1).max(512).optional()
});

export const changesetLifecycleDomainContributionSchema = z.strictObject({
  kind: z.literal('changeset_lifecycle'),
  action: z.enum(['propose', 'approve', 'rebuild', 'correction', 'commit']),
  preparationHandle: applicationIdSchema,
  workspaceId: applicationIdSchema,
  eventId: applicationIdSchema.optional(),
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  revisionDigest: sha256Schema,
  contributionDigestSha256: sha256Schema,
  occurredAt: canonicalInstantSchema
});

const changesetTimelineEvidenceBaseShape = {
  kind: z.literal('timeline'),
  timelineId: applicationIdSchema,
  sourceKind: z.enum([
    'changeset_proposal', 'changeset_approval', 'changeset_rebuild',
    'changeset_correction', 'changeset_commit'
  ]),
  workspaceId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  occurredAt: canonicalInstantSchema
} as const;
export const workspaceChangesetTimelineEvidenceChildSchema = z.strictObject({
  ...changesetTimelineEvidenceBaseShape
});
export const eventChangesetTimelineEvidenceChildSchema = z.strictObject({
  ...changesetTimelineEvidenceBaseShape,
  eventId: applicationIdSchema
});
export const changesetTimelineEvidenceChildSchema = z.union([
  workspaceChangesetTimelineEvidenceChildSchema,
  eventChangesetTimelineEvidenceChildSchema
]);
const changesetDomainFactEvidenceBaseShape = {
  kind: z.literal('domain_fact'),
  factId: applicationIdSchema,
  factKind: stableKeySchema,
  factVersion: positiveIntegerSchema,
  workspaceId: applicationIdSchema,
  changesetId: applicationIdSchema,
  revisionId: applicationIdSchema,
  payload: z.json()
} as const;
export const workspaceChangesetDomainFactEvidenceChildSchema = z.strictObject({
  ...changesetDomainFactEvidenceBaseShape
});
export const eventChangesetDomainFactEvidenceChildSchema = z.strictObject({
  ...changesetDomainFactEvidenceBaseShape,
  eventId: applicationIdSchema
});
export const changesetDomainFactEvidenceChildSchema = z.union([
  workspaceChangesetDomainFactEvidenceChildSchema,
  eventChangesetDomainFactEvidenceChildSchema
]);
export const changesetOutboxEvidenceChildSchema = z.strictObject({
  kind: z.literal('outbox_pointer'),
  pointerId: applicationIdSchema,
  sourceKind: z.literal('domain_fact'),
  factId: applicationIdSchema
});

const lifecycleSuccessContributionSchema = z.strictObject({
  result: z.strictObject({
    kind: z.literal('success'),
    data: z.union([
      proposedChangesetDataSchema,
      approvedChangesetDataSchema,
      rebuiltChangesetDataSchema,
      draftedChangesetCorrectionDataSchema
    ])
  }),
  domain: changesetLifecycleDomainContributionSchema,
  receiptChildren: z.tuple([changesetTimelineEvidenceChildSchema])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const domain = contribution.domain;
  const timeline = contribution.receiptChildren[0];
  if (data.action !== domain.action
      || timeline.workspaceId !== domain.workspaceId
      || ('eventId' in timeline ? timeline.eventId : undefined) !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Changeset lifecycle evidence is incoherent.' });
  }
});

const commitSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: committedChangesetDataSchema }),
  domain: changesetLifecycleDomainContributionSchema.extend({ action: z.literal('commit') }),
  receiptChildren: z.tuple([
    changesetDomainFactEvidenceChildSchema,
    changesetOutboxEvidenceChildSchema,
    changesetTimelineEvidenceChildSchema
  ])
}).superRefine((contribution, context) => {
  const data = contribution.result.data;
  const domain = contribution.domain;
  const [fact, pointer, timeline] = contribution.receiptChildren;
  if (data.changesetId !== domain.changesetId
      || data.revisionId !== domain.revisionId
      || data.revisionDigest !== domain.revisionDigest
      || fact.workspaceId !== domain.workspaceId
      || ('eventId' in fact ? fact.eventId : undefined) !== domain.eventId
      || fact.changesetId !== domain.changesetId
      || fact.revisionId !== domain.revisionId
      || pointer.factId !== fact.factId
      || timeline.sourceKind !== 'changeset_commit'
      || timeline.workspaceId !== domain.workspaceId
      || ('eventId' in timeline ? timeline.eventId : undefined)
        !== ('eventId' in fact ? fact.eventId : undefined)
      || ('eventId' in timeline ? timeline.eventId : undefined) !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'Changeset commit evidence is incoherent.' });
  }
});

const lifecycleOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((contribution, context) => {
  const outcome = contribution.result.outcome;
  if (outcome.kind !== 'changeset.lifecycle_refused'
      || !['conflict', 'stale_revision', 'policy_violation'].includes(outcome.class)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !changesetLifecycleRefusalDetailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'Changeset lifecycle refusal is invalid.' });
  }
});

export const changesetLifecycleContributionSchema = z.union([
  lifecycleSuccessContributionSchema,
  commitSuccessContributionSchema,
  lifecycleOutcomeContributionSchema
]);

export type ChangesetLifecycleContribution =
  z.infer<typeof changesetLifecycleContributionSchema>;

export interface ChangesetLifecyclePreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

export interface ChangesetLifecyclePreparation {
  prepare(input: {
    readonly action: ChangesetLifecycleAction;
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): ChangesetLifecyclePreparedContribution;
}

interface SealedLifecyclePreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: ChangesetLifecyclePreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedLifecyclePreparations = new WeakMap<object, SealedLifecyclePreparation>();

function sameRef(
  left: VersionedDefinitionRef,
  right: VersionedDefinitionRef
): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealChangesetLifecyclePreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: ChangesetLifecyclePreparation;
}): EffectHandlerSnapshot {
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('changeset_lifecycle_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'changeset_lifecycle', version: 1 });
  sealedLifecyclePreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

export function changesetLifecycleActionForOperation(
  operationName: string,
  operationVersion: number
): ChangesetLifecycleAction | undefined {
  if (operationVersion !== 1) return undefined;
  switch (operationName) {
    case PROPOSE_CHANGESET_OPERATION.name: return 'propose';
    case APPROVE_CHANGESET_REVISION_OPERATION.name: return 'approve';
    case REBUILD_CHANGESET_OPERATION.name: return 'rebuild';
    case DRAFT_CHANGESET_CORRECTION_OPERATION.name: return 'correction';
    case COMMIT_CHANGESET_OPERATION.name: return 'commit';
    default: return undefined;
  }
}

export function createChangesetLifecycleHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly effect: 'draft' | 'commit';
  readonly handlerCapability: VersionedDefinitionRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
}): EffectHandlerRegistration {
  const capability = Object.freeze({ ...input.handlerCapability });
  return Object.freeze({
    reference: Object.freeze({ ...input.reference }),
    effect: input.effect,
    handlerCapability: capability,
    contributionSchema: Object.freeze({ ...input.contributionSchema }),
    canonicalResultSchema: Object.freeze({ ...input.canonicalResultSchema }),
    handle({ businessInput, context, snapshot }: Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedLifecyclePreparations.get(snapshot);
      const action = changesetLifecycleActionForOperation(
        context.operation.name,
        context.operation.version
      );
      const actionEffect = action === 'propose' || action === 'rebuild' || action === 'correction'
        ? 'draft'
        : 'commit';
      if (!sealed || !sameRef(sealed.capability, capability)
          || sealed.context !== context || sealed.phase !== 'ready' || action === undefined
          || actionEffect !== input.effect || context.operation.effect !== input.effect) {
        throw new TypeError('invalid_changeset_lifecycle_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ action, businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('changeset_lifecycle_preparation_must_be_synchronous');
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

export const CHANGESET_LIFECYCLE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.changeset.lifecycle', version: parseContractVersion(1)
});
export const CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE = ref(
  'request-hash.changeset.lifecycle'
);
export const CHANGESET_LIFECYCLE_HANDLER_CAPABILITY = ref(
  'capability.changeset.lifecycle'
);

export interface ChangesetLifecycleOwnerResolution {
  readonly id: string;
  readonly evidenceIds: readonly string[];
  /**
   * Optional owner-authenticated least-privilege guard for the generic diff read.
   * Effect adapters still recheck their exact frozen plan inside the transaction.
   */
  readonly diffReadPermissionIds?: readonly [PermissionId, ...PermissionId[]];
}

function ownerDiffReadAuthorized(
  owner: ChangesetLifecycleOwnerResolution,
  authority: CurrentResolvedAuthority
): boolean {
  if (owner.diffReadPermissionIds === undefined) return true;
  const granted = new Set(
    authority.grants.flatMap((grant) => grant.kind === 'permission' ? [grant.key] : [])
  );
  return owner.diffReadPermissionIds.every((permissionId) => granted.has(permissionId));
}

/**
 * Authenticates an exact stored changeset to one registered owning domain. The
 * generic operation family emits only the neutral changeset-owner subject; domain
 * packages decide which operation definitions constitute that owner.
 */
export interface ChangesetLifecycleOwnerResolutionSource {
  resolveOwner(record: StoredChangesetRecord):
    | ChangesetLifecycleOwnerResolution
    | undefined
    | Promise<ChangesetLifecycleOwnerResolution | undefined>;
}

export interface CreateChangesetOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly lifecycleStore: ChangesetLifecycleStore;
  readonly ownerResolution: ChangesetLifecycleOwnerResolutionSource;
  /** Approval is mounted only by a composition that exercises a real distinct-human path. */
  readonly enableDistinctHumanApproval?: boolean;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

const moduleSchemas = Object.freeze({
  diffInput: CHANGESET_OPERATION_SCHEMA_REFS.diff.inputSchema,
  diffCanonical: schemaRef(
    'schema.changeset.diff-read.canonical-result', changesetDiffCanonicalResultSchema
  ),
  diffProjected: CHANGESET_OPERATION_SCHEMA_REFS.diff.resultSchema,
  lifecycleContribution: schemaRef(
    'schema.changeset.lifecycle.contribution', changesetLifecycleContributionSchema
  ),
  lifecycleCanonical: schemaRef(
    'schema.changeset.lifecycle.canonical-result', changesetLifecycleCanonicalResultSchema
  ),
  lifecycleProjected: CHANGESET_OPERATION_SCHEMA_REFS.propose.resultSchema,
  nullDetail: schemaRef('schema.changeset.operation.null-detail', nullDetailSchema),
  refusalDetail: schemaRef(
    'schema.changeset.lifecycle-refusal.detail', changesetLifecycleRefusalDetailSchema
  ),
  inputs: Object.freeze({
    propose: CHANGESET_OPERATION_SCHEMA_REFS.propose.inputSchema,
    approve: CHANGESET_OPERATION_SCHEMA_REFS.approve.inputSchema,
    rebuild: CHANGESET_OPERATION_SCHEMA_REFS.rebuild.inputSchema,
    correction: CHANGESET_OPERATION_SCHEMA_REFS.correction.inputSchema,
    commit: CHANGESET_OPERATION_SCHEMA_REFS.commit.inputSchema
  })
});

const moduleRefs = Object.freeze({
  readContext: ref('context.changeset.diff-read'),
  readAutonomy: ref('autonomy.changeset.diff-read'),
  readCapability: ref('capability.changeset.diff-read'),
  readHandler: ref('handler.changeset.diff-read'),
  readProjection: ref('projection.changeset.diff-read.operator'),
  readTrace: ref('trace.changeset.diff-read'),
  draftHandler: ref('handler.changeset.lifecycle-draft'),
  commitHandler: ref('handler.changeset.lifecycle-commit'),
  effectProjection: ref('projection.changeset.lifecycle.operator'),
  audit: ref('audit.changeset.lifecycle'),
  auditRecordProfile: ref('record-profile.changeset.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

interface LifecycleOperationEntry {
  readonly action: ChangesetLifecycleAction;
  readonly operation: {
    readonly name: string;
    readonly version: number;
  };
  readonly effect: 'draft' | 'commit';
  readonly path: string;
  readonly inputSchema: z.ZodType;
  readonly inputSchemaRef: SafeSchemaManifestRef;
  readonly consequenceTag: string;
}

const allLifecycleOperationEntries: readonly LifecycleOperationEntry[] = Object.freeze([
  Object.freeze({
    action: 'propose', operation: PROPOSE_CHANGESET_OPERATION, effect: 'draft',
    path: '/api/changesets/proposals', inputSchema: proposeChangesetInputSchema,
    inputSchemaRef: moduleSchemas.inputs.propose, consequenceTag: 'changeset-proposed'
  }),
  Object.freeze({
    action: 'approve', operation: APPROVE_CHANGESET_REVISION_OPERATION, effect: 'commit',
    path: '/api/changesets/approvals', inputSchema: approveChangesetRevisionInputSchema,
    inputSchemaRef: moduleSchemas.inputs.approve, consequenceTag: 'changeset-approved'
  }),
  Object.freeze({
    action: 'rebuild', operation: REBUILD_CHANGESET_OPERATION, effect: 'draft',
    path: '/api/changesets/rebuilds', inputSchema: rebuildChangesetInputSchema,
    inputSchemaRef: moduleSchemas.inputs.rebuild, consequenceTag: 'changeset-rebuilt'
  }),
  Object.freeze({
    action: 'correction', operation: DRAFT_CHANGESET_CORRECTION_OPERATION, effect: 'draft',
    path: '/api/changesets/corrections', inputSchema: draftChangesetCorrectionInputSchema,
    inputSchemaRef: moduleSchemas.inputs.correction, consequenceTag: 'changeset-correction-drafted'
  }),
  Object.freeze({
    action: 'commit', operation: COMMIT_CHANGESET_OPERATION, effect: 'commit',
    path: '/api/changesets/commits', inputSchema: commitChangesetInputSchema,
    inputSchemaRef: moduleSchemas.inputs.commit, consequenceTag: 'changeset-committed'
  })
]);

function effectRefs(action: ChangesetLifecycleAction) {
  return Object.freeze({
    context: ref(`context.changeset.${action}`),
    autonomy: ref(`autonomy.changeset.${action}`),
    concurrency: ref(`concurrency.changeset.${action}`),
    family: ref(`changeset.${action}.execution-family`),
    phase: ref(`changeset.${action}.phase.single-uow`),
    terminalization: ref(`changeset.${action}.terminalization`),
    risk: ref(`changeset.${action}.risk-resolver`),
    evidence: ref(`changeset.${action}.autonomy-evidence`),
    approval: ref(`changeset.${action}.approval-resolver`),
    preflight: ref(`changeset.${action}.autonomy-preflight`)
  });
}

function operationAutonomy(input: {
  readonly operation: { readonly name: string; readonly version: number };
  readonly definition: VersionedDefinitionRef;
}) {
  return createOperationAutonomyPolicy({
    definition: input.definition,
    operation: input.operation,
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
}

function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512
        || value.trim() !== value) {
      throw new TypeError('changeset_owner_evidence_invalid');
    }
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function changesetIdForOperation(
  operationName: string,
  operationVersion: number,
  businessInput: unknown
): string {
  if (operationVersion !== 1) throw new TypeError('changeset_operation_version_invalid');
  switch (operationName) {
    case GET_CHANGESET_DIFF_OPERATION.name:
      return changesetDiffInputSchema.parse(businessInput).changesetId;
    case PROPOSE_CHANGESET_OPERATION.name:
      return proposeChangesetInputSchema.parse(businessInput).changesetId;
    case APPROVE_CHANGESET_REVISION_OPERATION.name:
      return approveChangesetRevisionInputSchema.parse(businessInput).changesetId;
    case REBUILD_CHANGESET_OPERATION.name:
      return rebuildChangesetInputSchema.parse(businessInput).changesetId;
    case DRAFT_CHANGESET_CORRECTION_OPERATION.name:
      return draftChangesetCorrectionInputSchema.parse(businessInput).sourceChangesetId;
    case COMMIT_CHANGESET_OPERATION.name:
      return commitChangesetInputSchema.parse(businessInput).changesetId;
    default:
      throw new TypeError('changeset_operation_unknown');
  }
}

function changesetScopeResolver(input: {
  readonly workspaceId: WorkspaceId;
  readonly store: ChangesetLifecycleStore;
  readonly ownerResolution: ChangesetLifecycleOwnerResolutionSource;
}): InvocationScopeResolver {
  return Object.freeze({
    async resolve({ operation, businessInput }:
      Parameters<InvocationScopeResolver['resolve']>[0]) {
      const changesetId = changesetIdForOperation(
        operation.name, operation.version, businessInput
      );
      const record = input.store.read(changesetId);
      if (!record || record.head.workspaceId !== input.workspaceId) {
        return Object.freeze({
          workspaceId: input.workspaceId,
          subjects: Object.freeze([{ kind: 'workspace' as const, id: input.workspaceId }]),
          resolutionEvidenceIds: Object.freeze([`changeset-unresolved:${changesetId}`])
        });
      }
      const owner = await input.ownerResolution.resolveOwner(record);
      const eventId = record.head.eventId === undefined
        ? undefined
        : parseEventId(record.head.eventId);
      const baseSubjects = [
        { kind: 'workspace' as const, id: input.workspaceId },
        ...(eventId === undefined ? [] : [{ kind: 'event' as const, id: eventId }])
      ];
      if (!owner) {
        return Object.freeze({
          workspaceId: input.workspaceId,
          ...(eventId === undefined ? {} : { eventId }),
          subjects: Object.freeze(baseSubjects),
          resolutionEvidenceIds: Object.freeze([
            `changeset-record:${record.recordDigestSha256}`
          ])
        });
      }
      const ownerId = stableKeySchema.parse(owner.id);
      return Object.freeze({
        workspaceId: input.workspaceId,
        ...(eventId === undefined ? {} : { eventId }),
        subjects: Object.freeze([
          ...baseSubjects,
          { kind: 'domain' as const, domain: 'changeset', entity: 'owner', id: ownerId }
        ]),
        resolutionEvidenceIds: canonicalEvidenceIds([
          `changeset-record:${record.recordDigestSha256}`,
          ...owner.evidenceIds
        ])
      });
    }
  });
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

export function changesetLifecycleRefusalOutcome(
  refusal: ChangesetLifecycleRefusal | { readonly kind: 'domain_changed' }
): StructuredOutcome {
  const stale = new Set([
    'stale_head', 'revision_changed', 'definition_changed', 'policy_changed',
    'approval_changed', 'base_version_changed', 'guard_changed', 'domain_changed'
  ]).has(refusal.kind);
  const policy = new Set([
    'wrong_status', 'invalid_rebuild_selection', 'approval_not_required',
    'approval_separation_required', 'approval_missing', 'approval_invalid'
  ]).has(refusal.kind);
  const detail = changesetLifecycleRefusalDetailSchema.parse({
    code: refusal.kind,
    ...('status' in refusal ? { status: refusal.status } : {}),
    ...('expected' in refusal ? { expected: refusal.expected } : {}),
    ...('actual' in refusal && refusal.actual !== undefined ? { actual: refusal.actual } : {}),
    ...('operationIndex' in refusal ? { operationIndex: refusal.operationIndex } : {}),
    ...('id' in refusal ? { subjectId: refusal.id } : {})
  });
  return Object.freeze(structuredOutcomeSchema.parse({
    class: stale ? 'stale_revision' : policy ? 'policy_violation' : 'conflict',
    kind: 'changeset.lifecycle_refused',
    retryable: false,
    subjects: [],
    detail,
    detailSchemaVersion: 1
  }));
}

function trustedActorContext(context: ReadInvocationContext | EffectInvocationContext) {
  if (context.actor.kind !== 'workspace_user') {
    throw new TypeError('changeset_operator_actor_required');
  }
  return Object.freeze({
    workspaceId: context.scope.workspaceId,
    ...(context.scope.eventId === undefined ? {} : { eventId: context.scope.eventId }),
    principalKey: `workspace_user:${context.actor.userId}`,
    authorityPrincipalKey: context.authorityPrincipalKey,
    evaluatedAt: context.receivedAt
  });
}

export function createChangesetOperationModule(
  input: CreateChangesetOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policy.key !== CHANGESET_LIFECYCLE_ACCESS_POLICY.key
      || input.policy.version !== CHANGESET_LIFECYCLE_ACCESS_POLICY.version) {
    throw new TypeError('changeset_operation_policy_catalog_mismatch');
  }
  const effectEntries = allLifecycleOperationEntries.filter((entry) =>
    entry.action !== 'approve' || input.enableDistinctHumanApproval === true
  );
  const scopeResolver = changesetScopeResolver({
    workspaceId,
    store: input.lifecycleStore,
    ownerResolution: input.ownerResolution
  });
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policy
  });
  const readAutonomy = operationAutonomy({
    operation: GET_CHANGESET_DIFF_OPERATION,
    definition: moduleRefs.readAutonomy
  });
  const readContext = createReadInvocationContextBuilder({
    reference: moduleRefs.readContext,
    operation: GET_CHANGESET_DIFF_OPERATION,
    effect: 'read',
    lanes: [lane],
    scopeResolver,
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const readCapability: ReadCapabilityRegistration = Object.freeze({
    reference: moduleRefs.readCapability,
    openSnapshot: () => Object.freeze({ kind: 'changeset_diff' })
  });
  const effectDefinitions = effectEntries.map((entry) => {
    const references = effectRefs(entry.action);
    const autonomy = operationAutonomy({ operation: entry.operation, definition: references.autonomy });
    const context = createEffectInvocationContextBuilder({
      reference: references.context,
      operation: entry.operation,
      effect: entry.effect,
      lanes: [lane],
      scopeResolver,
      authorityResolver: input.currentAuthority,
      clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE,
      requestHashSealer: input.requestHashSealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const handler = entry.effect === 'draft' ? moduleRefs.draftHandler : moduleRefs.commitHandler;
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: references.family, phase: references.phase
    });
    const terminalization = createTerminalizationResolverRegistration({
      reference: references.terminalization,
      operation: entry.operation,
      phase: references.phase,
      resolve: ({ result }) => result.kind === 'success'
        ? Object.freeze({ kind: 'terminal' as const })
        : Object.freeze({ kind: 'nonterminal' as const })
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: references.phase,
      family: references.family,
      operation: entry.operation,
      effect: entry.effect,
      handler,
      handlerCapability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
      contributionSchema: moduleSchemas.lifecycleContribution,
      terminalization: references.terminalization,
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
      reference: references.risk,
      operation: entry.operation,
      resolve: () => Object.freeze({
        risk: 'normal' as const,
        consequenceTags: Object.freeze([entry.consequenceTag]),
        evidenceIds: Object.freeze([`changeset.${entry.action}.risk`])
      })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: references.evidence,
      operation: entry.operation,
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
            key: `changeset.${entry.action}.execute`,
            version: 1,
            digestSha256: subject.requestHashSha256
          }),
          failure: Object.freeze({ kind: 'none' as const })
        });
      }
    });
    const approval = createRenewedApprovalResolverRegistration({
      reference: references.approval,
      operation: entry.operation,
      resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: references.preflight,
      operation: entry.operation,
      policy: references.autonomy,
      riskResolver: references.risk,
      evidenceResolver: references.evidence,
      approvalResolver: references.approval,
      interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    return Object.freeze({
      entry, references, autonomy, context, family, terminalization,
      phase, risk, evidence, approval, preflight
    });
  });

  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: moduleSchemas.nullDetail
  }));
  const draftHandler = createChangesetLifecycleHandler({
    reference: moduleRefs.draftHandler,
    effect: 'draft',
    handlerCapability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    contributionSchema: moduleSchemas.lifecycleContribution,
    canonicalResultSchema: moduleSchemas.lifecycleCanonical
  });
  const commitHandler = createChangesetLifecycleHandler({
    reference: moduleRefs.commitHandler,
    effect: 'commit',
    handlerCapability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
    contributionSchema: moduleSchemas.lifecycleContribution,
    canonicalResultSchema: moduleSchemas.lifecycleCanonical
  });

  return Object.freeze({
    id: 'changeset.operations',
    source: Object.freeze({
      effectExecutionFamilies: Object.freeze(effectDefinitions.map((value) => value.family)),
      effectPhases: Object.freeze(effectDefinitions.map((value) => value.phase)),
      terminalizationResolvers: Object.freeze(
        effectDefinitions.map((value) => value.terminalization)
      ),
      riskResolvers: Object.freeze(effectDefinitions.map((value) => value.risk)),
      autonomyEvidenceResolvers: Object.freeze(effectDefinitions.map((value) => value.evidence)),
      renewedApprovalResolvers: Object.freeze(effectDefinitions.map((value) => value.approval)),
      autonomyPreflights: Object.freeze(effectDefinitions.map((value) => value.preflight)),
      autonomyPolicies: Object.freeze([
        readAutonomy,
        ...effectDefinitions.map((value) => value.autonomy)
      ]),
      schemas: Object.freeze([
        { reference: moduleSchemas.diffInput, schema: changesetDiffInputSchema },
        { reference: moduleSchemas.diffCanonical, schema: changesetDiffCanonicalResultSchema },
        { reference: moduleSchemas.diffProjected, schema: changesetDiffOperationResultSchema },
        ...effectDefinitions.map(({ entry }) => ({
          reference: entry.inputSchemaRef, schema: entry.inputSchema
        })),
        {
          reference: moduleSchemas.lifecycleContribution,
          schema: changesetLifecycleContributionSchema
        },
        {
          reference: moduleSchemas.lifecycleCanonical,
          schema: changesetLifecycleCanonicalResultSchema
        },
        {
          reference: moduleSchemas.lifecycleProjected,
          schema: changesetLifecycleOperationResultSchema
        },
        { reference: moduleSchemas.nullDetail, schema: nullDetailSchema },
        { reference: moduleSchemas.refusalDetail, schema: changesetLifecycleRefusalDetailSchema }
      ]),
      contextBuilders: Object.freeze([readContext]),
      readCapabilities: Object.freeze([readCapability]),
      handlers: Object.freeze([{
        reference: moduleRefs.readHandler,
        readCapability: moduleRefs.readCapability,
        canonicalResultSchema: moduleSchemas.diffCanonical,
        async handle({ businessInput, context }: {
          readonly businessInput: unknown;
          readonly context: ReadInvocationContext;
        }) {
          const wire = changesetDiffInputSchema.parse(businessInput);
          const record = input.lifecycleStore.read(wire.changesetId);
          const owner = record ? await input.ownerResolution.resolveOwner(record) : undefined;
          const domainSubject = context.scope.subjects.filter((subject) => subject.kind === 'domain');
          if (!record || !owner || !ownerDiffReadAuthorized(owner, context.authority)
              || record.head.workspaceId !== context.scope.workspaceId
              || record.head.eventId !== context.scope.eventId || domainSubject.length !== 1
              || domainSubject[0]?.domain !== 'changeset'
              || domainSubject[0]?.entity !== 'owner'
              || domainSubject[0]?.id !== owner.id) {
            return Object.freeze({
              kind: 'outcome' as const,
              outcome: changesetLifecycleRefusalOutcome({ kind: 'scope_changed' })
            });
          }
          const result = readChangesetDiff({
            store: input.lifecycleStore,
            context: trustedActorContext(context),
            ...wire
          });
          return result.kind === 'success'
            ? Object.freeze({
                kind: 'success' as const,
                data: changesetDiffDataSchema.parse(result.diff)
              })
            : Object.freeze({
                kind: 'outcome' as const,
                outcome: changesetLifecycleRefusalOutcome(result.refusal)
              });
        }
      }]),
      projections: Object.freeze([{
        reference: moduleRefs.readProjection,
        canonicalResultSchema: moduleSchemas.diffCanonical,
        projectedResultSchema: moduleSchemas.diffProjected,
        project: (candidate: unknown) => changesetDiffCanonicalResultSchema.parse(candidate)
      }, {
        reference: moduleRefs.effectProjection,
        canonicalResultSchema: moduleSchemas.lifecycleCanonical,
        projectedResultSchema: moduleSchemas.lifecycleProjected,
        project: (candidate: unknown) => changesetLifecycleCanonicalResultSchema.parse(candidate)
      }]),
      readOperationalTraceTargets: Object.freeze([{
        reference: moduleRefs.readTrace,
        kind: 'read_operational_trace_record' as const,
        recordProfile: moduleRefs.auditRecordProfile
      }]),
      operationAuditTargets: Object.freeze([{
        reference: moduleRefs.audit,
        kind: 'operation_audit_record' as const,
        recordProfile: moduleRefs.auditRecordProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: moduleRefs.auditRecordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 65_536
      }]),
      operations: Object.freeze([{
        ...GET_CHANGESET_DIFF_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read the deterministic safe diff for one exact changeset revision.',
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: moduleRefs.readAutonomy,
        consequenceTags: [],
        inputSchema: moduleSchemas.diffInput,
        canonicalResultSchema: moduleSchemas.diffCanonical,
        outcomes: [
          ...accessOutcomes,
          {
            class: 'conflict' as const,
            kind: 'changeset.lifecycle_refused',
            retryable: false,
            detailSchema: moduleSchemas.refusalDetail
          },
          {
            class: 'stale_revision' as const,
            kind: 'changeset.lifecycle_refused',
            retryable: false,
            detailSchema: moduleSchemas.refusalDetail
          }
        ],
        accessLanes: [lane],
        contextBuilder: moduleRefs.readContext,
        readCapability: moduleRefs.readCapability,
        handler: moduleRefs.readHandler,
        observability: {
          trace: { mode: 'required' as const, target: moduleRefs.readTrace },
          immutableAudit: { mode: 'none' as const }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: '/api/changesets/diff',
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: moduleRefs.readProjection
        }]
      }]),
      effectContextBuilders: Object.freeze(effectDefinitions.map((value) => value.context)),
      effectHandlers: Object.freeze([draftHandler, commitHandler]),
      effectOperations: Object.freeze(effectDefinitions.map(({ entry, references }) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: `Execute the reviewed changeset ${entry.action} transition.`,
        effect: entry.effect,
        maxRisk: entry.effect === 'commit' ? 'consequential' as const : 'normal' as const,
        autonomyPolicy: references.autonomy,
        consequenceTags: [entry.consequenceTag],
        inputSchema: entry.inputSchemaRef,
        contributionSchema: moduleSchemas.lifecycleContribution,
        canonicalResultSchema: moduleSchemas.lifecycleCanonical,
        outcomes: [
          {
            class: 'idempotency_conflict' as const,
            kind: 'operation.request_changed',
            retryable: false,
            detailSchema: moduleSchemas.nullDetail
          },
          ...accessOutcomes,
          ...(['conflict', 'stale_revision', 'policy_violation'] as const).map((outcomeClass) => ({
            class: outcomeClass,
            kind: 'changeset.lifecycle_refused',
            retryable: false,
            detailSchema: moduleSchemas.refusalDetail
          })),
          {
            class: 'conflict' as const,
            kind: 'operation.in_progress',
            retryable: true,
            detailSchema: moduleSchemas.nullDetail
          },
          ...autonomyInterventionOutcomeDeclarations(moduleSchemas.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: references.context,
        handlerCapability: CHANGESET_LIFECYCLE_HANDLER_CAPABILITY,
        handler: entry.effect === 'draft' ? moduleRefs.draftHandler : moduleRefs.commitHandler,
        audit: { mode: 'required' as const, target: moduleRefs.audit },
        idempotency: {
          keySource: moduleRefs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: CHANGESET_LIFECYCLE_REQUEST_HASH_PROFILE
        },
        concurrency: references.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          family: references.family,
          phase: references.phase,
          terminalization: references.terminalization,
          autonomyPreflight: references.preflight
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: entry.path,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: moduleRefs.effectProjection
        }]
      })))
    })
  });
}
