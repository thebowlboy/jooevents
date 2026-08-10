import { describe, expect, test } from 'bun:test';
import type { ProviderAvatarCandidate } from './identity';
import type { MediaAsset } from './profile-media';
import { planAvatarImport } from './profile-media';

const candidate: ProviderAvatarCandidate = {
  provider: 'google',
  url: 'https://lh3.googleusercontent.com/a/new-avatar',
  sourceFingerprint: 'google-avatar-v2',
  observedAt: '2026-08-09T08:00:00.000Z'
};

const current: MediaAsset = {
  id: 'asset_current',
  ownerUserId: 'user_ada',
  purpose: 'profile_avatar',
  storageProvider: 'local',
  storageKey: 'profiles/user_ada/avatar/asset_current.webp',
  contentType: 'image/webp',
  byteSize: 42_000,
  checksumSha256: 'abc123',
  sourceProvider: 'google',
  sourceUrl: 'https://lh3.googleusercontent.com/a/old-avatar',
  sourceFingerprint: 'google-avatar-v1',
  createdAt: '2026-01-01T00:00:00.000Z'
};

describe('planAvatarImport', () => {
  test('enqueues replacement under the initial replace policy', () => {
    const outcome = planAvatarImport({
      userId: 'user_ada',
      candidate,
      current,
      policy: 'replace'
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.data).toMatchObject({
      action: 'enqueue',
      expectedCurrentAssetId: 'asset_current',
      replaceAssetId: 'asset_current'
    });
  });

  test('can preserve an existing image with a warning', () => {
    const outcome = planAvatarImport({
      userId: 'user_ada',
      candidate,
      current,
      policy: 'keep_existing'
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.data).toEqual({ action: 'skip', reason: 'keep_existing' });
    expect(outcome.notices[0]?.severity).toBe('warning');
  });

  test('returns a structured confirmation instead of throwing', () => {
    const outcome = planAvatarImport({
      userId: 'user_ada',
      candidate,
      current,
      policy: 'confirm_if_existing'
    });

    expect(outcome.kind).toBe('needs_confirmation');
    if (outcome.kind !== 'needs_confirmation') return;
    expect(outcome.confirmation.code).toBe('replace_existing_profile_image');
    expect(outcome.proposed?.action).toBe('enqueue');
  });

  test('skips a candidate whose provider fingerprint is unchanged', () => {
    const outcome = planAvatarImport({
      userId: 'user_ada',
      candidate: { ...candidate, sourceFingerprint: 'google-avatar-v1' },
      current,
      policy: 'replace'
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.data).toEqual({ action: 'skip', reason: 'unchanged' });
  });
});
