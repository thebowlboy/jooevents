import { describe, expect, test } from 'bun:test';
import type { FileScopeDto, ResourceShareDto } from '@jooevents/contracts/files';
import {
  createResourceShare,
  resourceShareReachesEngagement,
  revokeResourceShare,
  type ResourceShareAudienceSource,
  type ResourceShareRepository
} from './resource-shares';
import { FIXTURE_SCOPE, LATER, NOW, OPERATOR, fixtureId } from './test-fixtures';

class MemoryShares implements ResourceShareRepository {
  readonly rows = new Map<string, ResourceShareDto>();
  readResourceShare(scope: FileScopeDto, id: string): ResourceShareDto | undefined {
    const row = this.rows.get(id);
    return row && row.scope.eventId === scope.eventId ? row : undefined;
  }
  listResourceShares(scope: FileScopeDto): readonly ResourceShareDto[] {
    return [...this.rows.values()].filter((row) => row.scope.eventId === scope.eventId);
  }
  createResourceShare(share: ResourceShareDto): void {
    if (this.rows.has(share.id)) throw new Error('duplicate_share');
    this.rows.set(share.id, share);
  }
  transitionResourceShare(input: {
    readonly expected: ResourceShareDto;
    readonly next: ResourceShareDto;
  }): void {
    const current = this.rows.get(input.expected.id);
    if (!current || current.version !== input.expected.version) throw new Error('share_drift');
    this.rows.set(input.next.id, input.next);
  }
}

const allAudiences: ResourceShareAudienceSource = {
  trackExists: () => true,
  engagementExists: () => true
};

describe('resource shares (organizer → speakers)', () => {
  test('creates a share with an audience selector and a receipt-bound fact', () => {
    const shares = new MemoryShares();
    const resourceShareId = fixtureId();
    const created = createResourceShare({
      scope: FIXTURE_SCOPE,
      create: { resourceShareId, title: 'Slide template', audience: { kind: 'all_confirmed' } },
      createdByUserId: OPERATOR.kind === 'operator_user' ? OPERATOR.userId : '',
      shares,
      audiences: allAudiences,
      now: NOW
    });
    if (created.kind !== 'created') throw new Error('expected creation');
    expect(created.share).toMatchObject({
      id: resourceShareId, title: 'Slide template',
      audience: { kind: 'all_confirmed' }, state: 'active', version: 1
    });
    expect(created.facts[0]).toMatchObject({
      kind: 'resource_share_changed',
      payload: { action: 'create', resourceShareId, state: 'active' }
    });
    const replay = createResourceShare({
      scope: FIXTURE_SCOPE,
      create: { resourceShareId, title: 'Slide template', audience: { kind: 'all_confirmed' } },
      createdByUserId: '11111111-0000-4000-8000-000000000010',
      shares, audiences: allAudiences, now: LATER
    });
    if (replay.kind !== 'created') throw new Error('expected idempotent creation');
    expect(replay.idempotent).toBe(true);
  });

  test('audience references resolve against their owners; unknowns refuse', () => {
    const shares = new MemoryShares();
    const audiences: ResourceShareAudienceSource = {
      trackExists: () => false,
      engagementExists: () => false
    };
    expect(createResourceShare({
      scope: FIXTURE_SCOPE,
      create: {
        resourceShareId: fixtureId(), title: 'AV guide',
        audience: { kind: 'track', trackId: fixtureId() }
      },
      createdByUserId: '11111111-0000-4000-8000-000000000010',
      shares, audiences, now: NOW
    })).toEqual({ kind: 'refused', code: 'track_missing' });
    expect(createResourceShare({
      scope: FIXTURE_SCOPE,
      create: {
        resourceShareId: fixtureId(), title: 'AV guide',
        audience: { kind: 'engagement', engagementId: fixtureId() }
      },
      createdByUserId: '11111111-0000-4000-8000-000000000010',
      shares, audiences, now: NOW
    })).toEqual({ kind: 'refused', code: 'engagement_missing' });
  });

  test('revoke is version-guarded compensation', () => {
    const shares = new MemoryShares();
    const resourceShareId = fixtureId();
    const created = createResourceShare({
      scope: FIXTURE_SCOPE,
      create: { resourceShareId, title: 'Speaker agreement', audience: { kind: 'all_confirmed' } },
      createdByUserId: '11111111-0000-4000-8000-000000000010',
      shares, audiences: allAudiences, now: NOW
    });
    if (created.kind !== 'created') throw new Error('expected creation');
    expect(revokeResourceShare({
      scope: FIXTURE_SCOPE,
      revoke: { resourceShareId, expectedVersion: 5 },
      shares, now: LATER
    })).toEqual({ kind: 'refused', code: 'stale_share' });
    const revoked = revokeResourceShare({
      scope: FIXTURE_SCOPE,
      revoke: { resourceShareId, expectedVersion: 1 },
      shares, now: LATER
    });
    if (revoked.kind !== 'revoked') throw new Error('expected revocation');
    expect(revoked.share).toMatchObject({ state: 'revoked', version: 2, revokedAt: LATER });
    expect(revokeResourceShare({
      scope: FIXTURE_SCOPE,
      revoke: { resourceShareId, expectedVersion: 2 },
      shares, now: LATER
    })).toEqual({ kind: 'refused', code: 'already_revoked' });
  });

  test('audience membership projects per engagement state, track, or exact engagement', () => {
    const base: Omit<Parameters<typeof resourceShareReachesEngagement>[0], 'share'> = {
      engagementId: 'e-1',
      engagementState: 'confirmed',
      engagementTrackIds: ['t-1']
    };
    const share = (audience: ResourceShareDto['audience'], state: ResourceShareDto['state'] = 'active'): ResourceShareDto => ({
      schemaVersion: 1,
      id: '44444444-0000-4000-8000-000000000001',
      scope: FIXTURE_SCOPE,
      title: 'Template',
      audience,
      createdByUserId: '11111111-0000-4000-8000-000000000010',
      state,
      version: 1,
      createdAt: NOW,
      revokedAt: state === 'revoked' ? NOW : null
    });
    expect(resourceShareReachesEngagement({ ...base, share: share({ kind: 'all_confirmed' }) })).toBe(true);
    expect(resourceShareReachesEngagement({
      ...base, engagementState: 'invited', share: share({ kind: 'all_confirmed' })
    })).toBe(false);
    expect(resourceShareReachesEngagement({
      ...base,
      share: share({ kind: 'track', trackId: 't-1' })
    })).toBe(true);
    expect(resourceShareReachesEngagement({
      ...base,
      share: share({ kind: 'track', trackId: 't-9' })
    })).toBe(false);
    expect(resourceShareReachesEngagement({
      ...base,
      share: share({ kind: 'engagement', engagementId: 'e-1' })
    })).toBe(true);
    expect(resourceShareReachesEngagement({
      ...base,
      share: share({ kind: 'all_confirmed' }, 'revoked')
    })).toBe(false);
  });
});
