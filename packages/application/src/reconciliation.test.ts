import { describe, expect, test } from 'bun:test';
import { success, type AuthUserLink, type ExternalIdentityClaims } from '@jooevents/identity-access';
import { createProvisioningService, type ProvisioningStore } from './reconciliation';

const now = '2026-08-09T08:00:00.000Z';
const claims: ExternalIdentityClaims = {
  provider: 'google',
  issuer: 'https://accounts.google.com',
  subject: 'google-subject-ada',
  email: 'ada@example.com',
  emailVerified: true,
  displayName: 'Ada Lovelace',
  observedAt: now
};

function store(overrides: Partial<ProvisioningStore> = {}): ProvisioningStore {
  return {
    findAuthUserLink: async () => undefined,
    loadSignInEvidence: async () => ({}),
    commitSignInPlan: async () => success({
      user: { id: 'user_ada', displayName: 'Ada Lovelace', primaryEmail: 'ada@example.com' },
      membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 },
      workspace: { id: 'workspace_summit', name: 'Summit Operations' }
    }),
    readCommittedAccess: async () => { throw new Error('not used'); },
    markProvisioningFailure: async () => {},
    ...overrides
  };
}

describe('provisioning service', () => {
  test('a valid auth principal without a reservation receives pending review, not active access', async () => {
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => success(claims) },
      store: store(),
      admission: { mode: 'pending' }
    });
    const result = await service.ensureAuthPrincipalProvisioned({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', correlationId: 'corr_ada', now });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.data.state).toBe('pending_review');
      if (result.data.state === 'pending_review') expect(result.data.workspace.name).toBe('Summit Operations');
    }
  });

  test('reservation-only installs expose no app person when reservation evidence is absent', async () => {
    let committed = false;
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => success(claims) },
      store: store({ commitSignInPlan: async () => { committed = true; throw new Error('must not commit'); } }),
      admission: { mode: 'reservation_only' }
    });
    const result = await service.ensureAuthPrincipalProvisioned({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', correlationId: 'corr_ada', now });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data).toEqual({ state: 'blocked', code: 'not_admitted' });
    expect(committed).toBe(false);
  });

  test('ready links use committed membership instead of trusting the session', async () => {
    const link: AuthUserLink = { authUserId: 'auth_ada', userId: 'user_ada', provisioningState: 'ready', attempts: 1, createdAt: now, updatedAt: now };
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => { throw new Error('not used'); } },
      store: store({
        findAuthUserLink: async () => link,
        readCommittedAccess: async () => success({
          user: { id: 'user_ada', displayName: 'Ada Lovelace' },
          membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'suspended', version: 2 },
          workspace: { id: 'workspace_summit', name: 'Summit Operations' }
        })
      }),
      admission: { mode: 'pending' }
    });
    const result = await service.ensureAuthPrincipalProvisioned({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', correlationId: 'corr_ada', now });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data).toEqual({ state: 'blocked', code: 'suspended' });
  });
});
