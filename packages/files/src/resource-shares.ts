import {
  resourceShareCreateInputSchema,
  resourceShareRevokeInputSchema,
  type FileScopeDto,
  type ResourceShareChangedFactPayload,
  type ResourceShareCreateInput,
  type ResourceShareDto,
  type ResourceShareRevokeInput
} from '@jooevents/contracts/files';
import { deepFreeze, parseResourceShare, type FilesFact } from './model';

export interface ResourceShareRepository {
  readResourceShare(scope: FileScopeDto, resourceShareId: string): ResourceShareDto | undefined;
  listResourceShares(scope: FileScopeDto): readonly ResourceShareDto[];
  createResourceShare(share: ResourceShareDto): void;
  transitionResourceShare(input: {
    readonly expected: ResourceShareDto;
    readonly next: ResourceShareDto;
  }): void;
}

/** Audience references resolve against their owning aggregates, never by guess. */
export interface ResourceShareAudienceSource {
  trackExists(scope: FileScopeDto, trackId: string): boolean;
  engagementExists(scope: FileScopeDto, engagementId: string): boolean;
}

export type ResourceShareCreateResult =
  | {
      readonly kind: 'created';
      readonly share: ResourceShareDto;
      readonly idempotent: boolean;
      readonly facts: readonly FilesFact<ResourceShareChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code: 'share_id_collision' | 'track_missing' | 'engagement_missing';
    };

export function createResourceShare(input: {
  readonly scope: FileScopeDto;
  readonly create: ResourceShareCreateInput;
  readonly createdByUserId: string;
  readonly shares: ResourceShareRepository;
  readonly audiences: ResourceShareAudienceSource;
  readonly now: string;
}): ResourceShareCreateResult {
  const create = resourceShareCreateInputSchema.parse(input.create);
  const existing = input.shares.readResourceShare(input.scope, create.resourceShareId);
  if (existing) {
    const identical = existing.title === create.title
      && existing.state === 'active'
      && JSON.stringify(existing.audience) === JSON.stringify(create.audience);
    return identical
      ? deepFreeze({ kind: 'created', share: existing, idempotent: true, facts: [] })
      : deepFreeze({ kind: 'refused', code: 'share_id_collision' });
  }
  if (create.audience.kind === 'track'
      && !input.audiences.trackExists(input.scope, create.audience.trackId)) {
    return deepFreeze({ kind: 'refused', code: 'track_missing' });
  }
  if (create.audience.kind === 'engagement'
      && !input.audiences.engagementExists(input.scope, create.audience.engagementId)) {
    return deepFreeze({ kind: 'refused', code: 'engagement_missing' });
  }
  const share = parseResourceShare({
    schemaVersion: 1,
    id: create.resourceShareId,
    scope: input.scope,
    title: create.title,
    audience: create.audience,
    createdByUserId: input.createdByUserId,
    state: 'active',
    version: 1,
    createdAt: input.now,
    revokedAt: null
  });
  input.shares.createResourceShare(share);
  return deepFreeze({
    kind: 'created',
    share,
    idempotent: false,
    facts: [shareFact('create', share)]
  });
}

export type ResourceShareRevokeResult =
  | {
      readonly kind: 'revoked';
      readonly share: ResourceShareDto;
      readonly facts: readonly FilesFact<ResourceShareChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code: 'share_missing' | 'already_revoked' | 'stale_share';
    };

/** Revoke is the compensation of create; attached materials stay refcounted. */
export function revokeResourceShare(input: {
  readonly scope: FileScopeDto;
  readonly revoke: ResourceShareRevokeInput;
  readonly shares: ResourceShareRepository;
  readonly now: string;
}): ResourceShareRevokeResult {
  const revoke = resourceShareRevokeInputSchema.parse(input.revoke);
  const current = input.shares.readResourceShare(input.scope, revoke.resourceShareId);
  if (!current) return deepFreeze({ kind: 'refused', code: 'share_missing' });
  if (current.state === 'revoked') {
    return deepFreeze({ kind: 'refused', code: 'already_revoked' });
  }
  if (current.version !== revoke.expectedVersion) {
    return deepFreeze({ kind: 'refused', code: 'stale_share' });
  }
  const next = parseResourceShare({
    ...current,
    state: 'revoked',
    version: current.version + 1,
    revokedAt: input.now
  });
  input.shares.transitionResourceShare({ expected: current, next });
  return deepFreeze({
    kind: 'revoked',
    share: next,
    facts: [shareFact('revoke', next)]
  });
}

/**
 * Whether one engagement sits inside a share's audience. `all_confirmed`
 * resolution requires the engagement's current state; the caller supplies it
 * from the engagement aggregate.
 */
export function resourceShareReachesEngagement(input: {
  readonly share: ResourceShareDto;
  readonly engagementId: string;
  readonly engagementState: 'invited' | 'confirmed' | 'declined' | 'cancelled';
  readonly engagementTrackIds: readonly string[];
}): boolean {
  if (input.share.state !== 'active') return false;
  switch (input.share.audience.kind) {
    case 'all_confirmed':
      return input.engagementState === 'confirmed';
    case 'track':
      return input.engagementTrackIds.includes(input.share.audience.trackId);
    case 'engagement':
      return input.share.audience.engagementId === input.engagementId;
  }
}

function shareFact(
  action: ResourceShareChangedFactPayload['action'],
  share: ResourceShareDto
): FilesFact<ResourceShareChangedFactPayload> {
  return deepFreeze({
    kind: 'resource_share_changed',
    version: 1 as const,
    payload: {
      action,
      resourceShareId: share.id,
      state: share.state,
      version: share.version
    }
  });
}
