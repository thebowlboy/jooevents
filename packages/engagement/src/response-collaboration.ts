import type { VersionedDefinitionRef } from '@jooevents/contracts';
import type { CanonicalJson } from '@jooevents/kernel';
import type { EngagementMutationPlanDto } from '@jooevents/contracts';

export type EngagementResponseCorePlan = EngagementMutationPlanDto;

export interface EngagementResponseAggregateRef {
  readonly id: string;
  readonly version: number;
}

export interface EngagementResponseGuardRef extends EngagementResponseAggregateRef {
  readonly digest: string;
}

export interface EngagementResponseReadPortKey<Port> {
  readonly key: string;
  readonly version: number;
  readonly portType?: () => Port;
}

export interface EngagementResponsePlanningSnapshot {
  getPort<Port>(key: EngagementResponseReadPortKey<Port>): Port;
}

export interface EngagementResponseCollaborationPlan {
  readonly contributor: VersionedDefinitionRef;
  readonly plan: CanonicalJson;
  readonly safeDiff: CanonicalJson;
  readonly aggregateRefs: readonly EngagementResponseAggregateRef[];
  readonly guardRefs: readonly EngagementResponseGuardRef[];
  readonly consequences: readonly string[];
}

export interface EngagementResponseCollaborator {
  readonly reference: VersionedDefinitionRef;
  readonly readPort: EngagementResponseReadPortKey<unknown>;
  plan(
    core: EngagementResponseCorePlan,
    snapshot: EngagementResponsePlanningSnapshot
  ): EngagementResponseCollaborationPlan | undefined;
}

export interface EngagementResponseCollaborationRegistry {
  readonly collaborators: readonly EngagementResponseCollaborator[];
}

export const EMPTY_ENGAGEMENT_RESPONSE_COLLABORATIONS: EngagementResponseCollaborationRegistry =
  Object.freeze({ collaborators: Object.freeze([]) });
