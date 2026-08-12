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
    let projectionCalls = 0;
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => success(claims) },
      store: store(),
      admission: { mode: 'pending' },
      gatewayAuthority: {
        project: async () => {
          projectionCalls += 1;
          throw new Error('must not project non-active access');
        }
      }
    });
    const result = await service.ensureAuthPrincipalProvisioned({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', correlationId: 'corr_ada', now });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.data.state).toBe('pending_review');
      if (result.data.state === 'pending_review') expect(result.data.workspace.name).toBe('Summit Operations');
    }
    expect(projectionCalls).toBe(0);
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
    let projectionCalls = 0;
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
      admission: { mode: 'pending' },
      gatewayAuthority: {
        project: async () => {
          projectionCalls += 1;
          throw new Error('must not project blocked access');
        }
      }
    });
    const result = await service.ensureAuthPrincipalProvisioned({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', correlationId: 'corr_ada', now });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data).toEqual({ state: 'blocked', code: 'suspended' });
    expect(projectionCalls).toBe(0);
  });

  test('injects a server projection only for a committed active membership', async () => {
    const link: AuthUserLink = { authUserId: 'auth_ada', userId: 'user_ada', provisioningState: 'ready', attempts: 1, createdAt: now, updatedAt: now };
    const calls: unknown[] = [];
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => { throw new Error('not used'); } },
      store: store({
        findAuthUserLink: async () => link,
        readCommittedAccess: async () => success({
          user: { id: 'user_ada', displayName: 'Ada Lovelace' },
          membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'active', version: 9 },
          workspace: { id: 'workspace_summit', name: 'Summit Operations' }
        })
      }),
      admission: { mode: 'pending' },
      gatewayAuthority: {
        async project(input) {
          calls.push(input);
          return {
            schemaVersion: 1,
            principalPartition: {
              current: 'gpp_0123456789abcdef',
              aliases: ['gpp_fedcba9876543210']
            },
            disclosureEpoch: 'gde_0123456789abcdef'
          };
        }
      }
    });
    const result = await service.ensureAuthPrincipalProvisioned({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', correlationId: 'corr_ada', now });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new TypeError('expected success');
    expect(result.data).toMatchObject({
      state: 'active',
      gatewayAuthority: {
        principalPartition: {
          current: 'gpp_0123456789abcdef',
          aliases: ['gpp_fedcba9876543210']
        },
        disclosureEpoch: 'gde_0123456789abcdef'
      }
    });
    expect(calls).toEqual([{
      userId: 'user_ada',
      membershipId: 'membership_ada',
      membershipVersion: 9,
      workspaceId: 'workspace_summit'
    }]);
  });

  test('missing or malformed gateway projection fails closed without blocking active access', async () => {
    const link: AuthUserLink = { authUserId: 'auth_ada', userId: 'user_ada', provisioningState: 'ready', attempts: 1, createdAt: now, updatedAt: now };
    const activeStore = store({
      findAuthUserLink: async () => link,
      readCommittedAccess: async () => success({
        user: { id: 'user_ada', displayName: 'Ada Lovelace' },
        membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'active', version: 9 },
        workspace: { id: 'workspace_summit', name: 'Summit Operations' }
      })
    });
    const services = [
      createProvisioningService({
        principals: { getVerifiedClaims: async () => { throw new Error('not used'); } },
        store: activeStore,
        admission: { mode: 'pending' }
      }),
      createProvisioningService({
        principals: { getVerifiedClaims: async () => { throw new Error('not used'); } },
        store: activeStore,
        admission: { mode: 'pending' },
        gatewayAuthority: {
          project: async () => ({ invalid: true }) as never
        }
      }),
      createProvisioningService({
        principals: { getVerifiedClaims: async () => { throw new Error('not used'); } },
        store: activeStore,
        admission: { mode: 'pending' },
        gatewayAuthority: {
          project: async () => { throw new Error('key service unavailable'); }
        }
      })
    ];

    for (const service of services) {
      const result = await service.ensureAuthPrincipalProvisioned({ authUserId: 'auth_ada', workspaceId: 'workspace_summit', correlationId: 'corr_ada', now });
      expect(result.kind).toBe('success');
      if (result.kind !== 'success') throw new TypeError('expected success');
      expect(result.data).toEqual({
        state: 'active',
        user: { id: 'user_ada', displayName: 'Ada Lovelace' },
        workspace: { id: 'workspace_summit', name: 'Summit Operations' }
      });
    }
  });
});
