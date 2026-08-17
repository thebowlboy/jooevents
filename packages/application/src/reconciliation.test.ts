import { describe, expect, test } from 'bun:test';
import { failure, success, type AuthUserLink, type ExternalIdentityClaims } from '@jooevents/identity-access';
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

  test('a later reservation admits an already-ready pending link through the normal sign-in plan', async () => {
    const link: AuthUserLink = {
      authUserId: 'auth_ada',
      userId: 'user_ada',
      provisioningState: 'ready',
      attempts: 1,
      createdAt: now,
      updatedAt: now
    };
    const pending = {
      user: { id: 'user_ada', displayName: 'Ada Lovelace', primaryEmail: 'ada@example.com' },
      membership: {
        id: 'membership_ada',
        workspaceId: 'workspace_summit',
        status: 'pending_review' as const,
        version: 1
      },
      workspace: { id: 'workspace_summit', name: 'Summit Operations' }
    };
    let committedPlanCode: string | undefined;
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => success(claims) },
      store: store({
        findAuthUserLink: async () => link,
        readCommittedAccess: async () => success(pending),
        loadSignInEvidence: async () => ({
          identityLink: {
            id: 'identity_ada',
            userId: 'user_ada',
            provider: claims.provider,
            issuer: claims.issuer,
            subject: claims.subject,
            emailSnapshot: 'ada@example.com',
            emailVerifiedSnapshot: true,
            displayNameSnapshot: 'Ada Lovelace',
            linkedAt: now,
            lastObservedAt: now
          },
          linkedUser: {
            id: 'user_ada',
            status: 'pending_review',
            displayName: 'Ada Lovelace',
            createdAt: now,
            updatedAt: now,
            version: 1
          },
          linkedMembership: {
            id: 'membership_ada',
            workspaceId: 'workspace_summit',
            userId: 'user_ada',
            status: 'pending_review',
            createdAt: now,
            updatedAt: now,
            version: 1
          },
          reservation: {
            id: 'reservation_ada',
            workspaceId: 'workspace_summit',
            normalizedEmail: 'ada@example.com',
            roleAssignments: [],
            permissionOverrides: [],
            status: 'open',
            createdByUserId: 'system_bootstrap',
            createdAt: now
          }
        }),
        commitSignInPlan: async (input) => {
          committedPlanCode = input.plan.code;
          return success({
            ...pending,
            membership: { ...pending.membership, status: 'active', version: 2 }
          });
        }
      }),
      admission: { mode: 'pending' }
    });

    const result = await service.ensureAuthPrincipalProvisioned({
      authUserId: 'auth_ada',
      workspaceId: 'workspace_summit',
      correlationId: 'corr_ada',
      now
    });

    expect(committedPlanCode).toBe('existing_preapproved_member');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data.state).toBe('active');
  });

  test('checking an unchanged ready pending link does not commit another pending plan', async () => {
    const link: AuthUserLink = {
      authUserId: 'auth_ada',
      userId: 'user_ada',
      provisioningState: 'ready',
      attempts: 1,
      createdAt: now,
      updatedAt: now
    };
    let commits = 0;
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => success(claims) },
      store: store({
        findAuthUserLink: async () => link,
        readCommittedAccess: async () => success({
          user: { id: 'user_ada', displayName: 'Ada Lovelace' },
          membership: {
            id: 'membership_ada',
            workspaceId: 'workspace_summit',
            status: 'pending_review',
            version: 1
          },
          workspace: { id: 'workspace_summit', name: 'Summit Operations' }
        }),
        loadSignInEvidence: async () => ({}),
        commitSignInPlan: async () => {
          commits += 1;
          throw new Error('must not commit');
        }
      }),
      admission: { mode: 'pending' }
    });

    const result = await service.ensureAuthPrincipalProvisioned({
      authUserId: 'auth_ada',
      workspaceId: 'workspace_summit',
      correlationId: 'corr_ada',
      now
    });

    expect(commits).toBe(0);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data.state).toBe('pending_review');
  });

  test('a failed reservation upgrade leaves the ready pending link undegraded', async () => {
    const link: AuthUserLink = {
      authUserId: 'auth_ada',
      userId: 'user_ada',
      provisioningState: 'ready',
      attempts: 1,
      createdAt: now,
      updatedAt: now
    };
    const pending = {
      user: { id: 'user_ada', displayName: 'Ada Lovelace', primaryEmail: 'ada@example.com' },
      membership: {
        id: 'membership_ada',
        workspaceId: 'workspace_summit',
        status: 'pending_review' as const,
        version: 1
      },
      workspace: { id: 'workspace_summit', name: 'Summit Operations' }
    };
    let failuresMarked = 0;
    const service = createProvisioningService({
      principals: { getVerifiedClaims: async () => success(claims) },
      store: store({
        findAuthUserLink: async () => link,
        readCommittedAccess: async () => success(pending),
        loadSignInEvidence: async () => ({
          identityLink: {
            id: 'identity_ada',
            userId: 'user_ada',
            provider: claims.provider,
            issuer: claims.issuer,
            subject: claims.subject,
            emailSnapshot: 'ada@example.com',
            emailVerifiedSnapshot: true,
            displayNameSnapshot: 'Ada Lovelace',
            linkedAt: now,
            lastObservedAt: now
          },
          linkedUser: {
            id: 'user_ada',
            status: 'pending_review',
            displayName: 'Ada Lovelace',
            createdAt: now,
            updatedAt: now,
            version: 1
          },
          linkedMembership: {
            id: 'membership_ada',
            workspaceId: 'workspace_summit',
            userId: 'user_ada',
            status: 'pending_review',
            createdAt: now,
            updatedAt: now,
            version: 1
          },
          reservation: {
            id: 'reservation_ada',
            workspaceId: 'workspace_summit',
            normalizedEmail: 'ada@example.com',
            roleAssignments: [],
            permissionOverrides: [],
            status: 'open',
            createdByUserId: 'system_bootstrap',
            createdAt: now
          }
        }),
        // A routine status poll racing another poll: the upgrade commit loses
        // its version guard and returns a typed error. The healthy link must
        // keep answering pending — never flip to provisioning-failed.
        commitSignInPlan: async () => failure({
          code: 'provisioning_dependency_failed',
          message: 'version conflict',
          retryable: true
        }),
        markProvisioningFailure: async () => {
          failuresMarked += 1;
        }
      }),
      admission: { mode: 'pending' }
    });

    const result = await service.ensureAuthPrincipalProvisioned({
      authUserId: 'auth_ada',
      workspaceId: 'workspace_summit',
      correlationId: 'corr_ada',
      now
    });

    expect(failuresMarked).toBe(0);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data.state).toBe('pending_review');
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
