import type {
  EventId,
  PersonId,
  UserId,
  WorkspaceId
} from './ids';
import type { AggregateVersion } from './versions';

export interface WorkspaceScopeRef {
  readonly kind: 'workspace';
  readonly workspaceId: WorkspaceId;
}

export interface EventScopeRef {
  readonly kind: 'event';
  readonly workspaceId: WorkspaceId;
  readonly eventId: EventId;
}

export type ScopeRef = WorkspaceScopeRef | EventScopeRef;

export type SubjectRef =
  | { readonly kind: 'workspace'; readonly id: WorkspaceId }
  | { readonly kind: 'event'; readonly id: EventId }
  | { readonly kind: 'workspace_user'; readonly id: UserId }
  | { readonly kind: 'participant_person'; readonly id: PersonId }
  | {
      readonly kind: 'domain';
      readonly domain: string;
      readonly entity: string;
      readonly id: string;
      readonly version?: AggregateVersion;
    };

/** Scope produced from server-owned relationship resolution, not request assertions. */
export interface ResolvedScope {
  readonly workspaceId: WorkspaceId;
  readonly eventId?: EventId;
  readonly subjects: readonly SubjectRef[];
  readonly resolutionEvidenceIds: readonly string[];
}
