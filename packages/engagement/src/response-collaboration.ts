import type { StructuredOutcome, VersionedDefinitionRef } from '@jooevents/contracts';
import type {
  ChangesetApplyContribution,
  ChangesetPlanningSnapshot,
  ChangesetReadPortKey,
  ChangesetTransaction,
  ChangesetTransactionPortKey,
  ChangesetValidation,
  ChangesetValidationPortKey,
  GuardRef,
  VersionRef
} from '@jooevents/changesets';
import type { CanonicalJson } from '@jooevents/kernel';
import type { EngagementMutationPlanDto, EngagementRestorePlanDto } from '@jooevents/contracts';

export type EngagementResponseCorePlan = EngagementMutationPlanDto | EngagementRestorePlanDto;

export interface EngagementResponseCollaborationPlan {
  readonly contributor: VersionedDefinitionRef;
  readonly plan: CanonicalJson;
  readonly safeDiff: CanonicalJson;
  readonly aggregateRefs: readonly VersionRef[];
  readonly guardRefs: readonly GuardRef[];
  readonly consequences: readonly string[];
}

export interface EngagementResponseCollaborator {
  readonly reference: VersionedDefinitionRef;
  readonly readPorts: readonly ChangesetReadPortKey<any>[];
  readonly validationPorts: readonly ChangesetValidationPortKey<any>[];
  readonly transactionPorts: readonly ChangesetTransactionPortKey<any>[];
  readonly allowedAggregateKinds: readonly string[];
  readonly allowedGuardKinds: readonly string[];
  readonly allowedConsequences: readonly string[];
  readonly allowedOutcomes: readonly {
    readonly class: StructuredOutcome['class'];
    readonly kind: string;
    readonly retryable: boolean;
    readonly detailSchema: import('@jooevents/changesets').ChangesetSchemaRef;
  }[];
  readonly allowedFacts: readonly { readonly kind: string; readonly version: number }[];
  readonly allowedEffects: readonly { readonly kind: string; readonly version: number }[];
  readonly schemas: readonly import('@jooevents/changesets').RegisteredChangesetSchema[];
  plan(
    core: EngagementResponseCorePlan,
    snapshot: ChangesetPlanningSnapshot
  ): EngagementResponseCollaborationPlan | undefined;
  validate(
    core: EngagementResponseCorePlan,
    contribution: EngagementResponseCollaborationPlan,
    validation: ChangesetValidation
  ): { readonly kind: 'ready'; readonly validated: CanonicalJson }
    | { readonly kind: 'outcome'; readonly outcome: StructuredOutcome };
  apply(
    core: EngagementResponseCorePlan,
    validated: CanonicalJson,
    transaction: ChangesetTransaction
  ): ChangesetApplyContribution<CanonicalJson>;
}

export interface EngagementResponseCollaborationRegistry {
  readonly collaborators: readonly EngagementResponseCollaborator[];
}

export const EMPTY_ENGAGEMENT_RESPONSE_COLLABORATIONS: EngagementResponseCollaborationRegistry =
  Object.freeze({ collaborators: Object.freeze([]) });
