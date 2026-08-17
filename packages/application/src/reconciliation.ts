import {
  gatewayAuthorityProjectionSchema,
  type AccessContext,
  type SafeMembership,
  type SafeUser,
  type SafeWorkspace
} from '@jooevents/contracts';
import {
  failure,
  normalizeEmail,
  planSignIn,
  success,
  type AccessReservation,
  type AdapterOutcome,
  type AuthUserLink,
  type ExternalIdentityClaims,
  type ExternalIdentityLink,
  type SignInPlan,
  type User,
  type UserEmail,
  type WorkspaceMembership
} from '@jooevents/identity-access';

export interface AuthPrincipalEvidenceReader {
  getVerifiedClaims(authUserId: string): Promise<AdapterOutcome<ExternalIdentityClaims>>;
}

export interface SignInEvidence {
  readonly identityLink?: ExternalIdentityLink;
  readonly linkedUser?: User;
  readonly linkedMembership?: WorkspaceMembership;
  readonly sameEmailUser?: { readonly user: User; readonly email: UserEmail };
  readonly reservation?: AccessReservation;
}

export interface CommittedAccessState {
  readonly user: SafeUser;
  readonly membership: SafeMembership;
  readonly workspace: SafeWorkspace;
}

/**
 * Optional until a deployment explicitly composes purpose-specific gateway key
 * profiles. The provider reloads complete current disclosure evidence server-side;
 * these stable IDs are lookup coordinates, never caller input.
 */
export interface GatewayAuthorityProjectionProvider {
  project(input: {
    readonly userId: string;
    readonly membershipId: string;
    readonly membershipVersion: number;
    readonly workspaceId: string;
  }): Promise<unknown>;
}

export interface ProvisioningStore {
  findAuthUserLink(authUserId: string): Promise<AuthUserLink | undefined>;
  loadSignInEvidence(input: {
    readonly workspaceId: string;
    readonly claims: ExternalIdentityClaims;
  }): Promise<SignInEvidence>;
  commitSignInPlan(input: {
    readonly authUserId: string;
    readonly workspaceId: string;
    readonly plan: SignInPlan;
    readonly correlationId: string;
    readonly now: string;
  }): Promise<AdapterOutcome<CommittedAccessState>>;
  readCommittedAccess(authUserId: string, workspaceId: string): Promise<AdapterOutcome<CommittedAccessState>>;
  markProvisioningFailure(authUserId: string, errorCode: string, now: string): Promise<void>;
}

export interface AdmissionPolicy {
  readonly mode: 'pending' | 'workspace_domain' | 'reservation_only';
  readonly hostedDomain?: string;
}

export interface EnsureProvisionedInput {
  readonly authUserId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly now: string;
}

async function contextFromCommitted(
  state: CommittedAccessState,
  gatewayAuthority: GatewayAuthorityProjectionProvider | undefined
): Promise<AccessContext> {
  if (state.membership.status === 'active') {
    const active: AccessContext = { state: 'active', user: state.user, workspace: state.workspace };
    if (!gatewayAuthority) return active;
    try {
      const projected = await gatewayAuthority.project({
        userId: state.user.id,
        membershipId: state.membership.id,
        membershipVersion: state.membership.version,
        workspaceId: state.workspace.id
      });
      const parsed = gatewayAuthorityProjectionSchema.safeParse(projected);
      return parsed.success ? { ...active, gatewayAuthority: parsed.data } : active;
    } catch {
      // Gateway persistence is fail-closed independently of ordinary active access.
      return active;
    }
  }
  if (state.membership.status === 'pending_review' || state.membership.status === 'invited') {
    return {
      state: 'pending_review',
      user: state.user,
      membership: { ...state.membership, status: 'pending_review' },
      workspace: state.workspace
    };
  }
  return {
    state: 'blocked',
    code: state.membership.status === 'suspended' ? 'suspended' : 'deactivated'
  };
}

function admissionAllowsNewPerson(
  policy: AdmissionPolicy,
  claims: ExternalIdentityClaims,
  reservation: AccessReservation | undefined
): boolean {
  if (reservation) return true;
  if (policy.mode === 'reservation_only') return false;
  if (policy.mode === 'workspace_domain') return claims.hostedDomain === policy.hostedDomain;
  return true;
}

/**
 * Idempotent discovery path after Better Auth has committed. It never treats the
 * authentication principal as an admitted application user by itself.
 */
export function createProvisioningService(dependencies: {
  readonly principals: AuthPrincipalEvidenceReader;
  readonly store: ProvisioningStore;
  readonly admission: AdmissionPolicy;
  readonly gatewayAuthority?: GatewayAuthorityProjectionProvider;
}) {
  return {
    async ensureAuthPrincipalProvisioned(input: EnsureProvisionedInput): Promise<AdapterOutcome<AccessContext>> {
      const existingLink = await dependencies.store.findAuthUserLink(input.authUserId);
      let readyPendingState: CommittedAccessState | undefined;
      if (existingLink?.provisioningState === 'ready') {
        const committed = await dependencies.store.readCommittedAccess(input.authUserId, input.workspaceId);
        if (committed.kind === 'success') {
          if (
            committed.data.membership.status !== 'pending_review' &&
            committed.data.membership.status !== 'invited'
          ) {
            return success(
              await contextFromCommitted(committed.data, dependencies.gatewayAuthority),
              committed.notices
            );
          }
          // A reservation may be added after a first sign-in created a ready
          // pending link. Re-evaluate only that pending branch so the normal
          // reservation transaction can admit it; active/blocked links remain
          // current-state reads and an unchanged pending link is never logged
          // again merely because the person checks status.
          readyPendingState = committed.data;
        } else if (committed.kind === 'error') {
          return failure(committed.error, committed.notices);
        } else {
          return {
            kind: 'needs_confirmation',
            ...(committed.proposed ? {
              proposed: await contextFromCommitted(committed.proposed, dependencies.gatewayAuthority)
            } : {}),
            confirmation: committed.confirmation,
            notices: committed.notices
          };
        }
      }

      const principal = await dependencies.principals.getVerifiedClaims(input.authUserId);
      if (principal.kind === 'error') {
        if (readyPendingState) {
          return success(
            await contextFromCommitted(readyPendingState, dependencies.gatewayAuthority),
            principal.notices
          );
        }
        return failure(principal.error, principal.notices);
      }
      if (principal.kind === 'needs_confirmation') {
        if (readyPendingState) {
          return success(
            await contextFromCommitted(readyPendingState, dependencies.gatewayAuthority),
            principal.notices
          );
        }
        return { kind: 'needs_confirmation', confirmation: principal.confirmation, notices: principal.notices };
      }

      try {
        const evidence = await dependencies.store.loadSignInEvidence({
          workspaceId: input.workspaceId,
          claims: principal.data
        });
        if (readyPendingState && !evidence.reservation) {
          return success(
            await contextFromCommitted(readyPendingState, dependencies.gatewayAuthority),
            principal.notices
          );
        }
        if (!evidence.identityLink && !evidence.sameEmailUser && !admissionAllowsNewPerson(dependencies.admission, principal.data, evidence.reservation)) {
          return success({ state: 'blocked', code: 'not_admitted' }, principal.notices);
        }

        const plan = planSignIn({
          workspaceId: input.workspaceId,
          claims: principal.data,
          ...evidence,
          now: input.now
        });
        if (readyPendingState && plan.code !== 'existing_preapproved_member') {
          return success(
            await contextFromCommitted(readyPendingState, dependencies.gatewayAuthority),
            [...principal.notices, ...plan.notices]
          );
        }
        if (plan.result === 'confirmation_required') {
          return success({ state: 'blocked', code: 'not_admitted' }, [...principal.notices, ...plan.notices]);
        }
        if (plan.result === 'rejected') {
          const code = plan.code === 'user_inactive' || plan.code === 'membership_inactive' ? 'suspended' : 'not_admitted';
          return success({ state: 'blocked', code }, [...principal.notices, ...plan.notices]);
        }

        const committed = await dependencies.store.commitSignInPlan({
          authUserId: input.authUserId,
          workspaceId: input.workspaceId,
          plan,
          correlationId: input.correlationId,
          now: input.now
        });
        if (committed.kind === 'success') {
          return success(
            await contextFromCommitted(committed.data, dependencies.gatewayAuthority),
            [...principal.notices, ...committed.notices]
          );
        }
        if (committed.kind === 'needs_confirmation') {
          return {
            kind: 'needs_confirmation',
            ...(committed.proposed ? {
              proposed: await contextFromCommitted(committed.proposed, dependencies.gatewayAuthority)
            } : {}),
            confirmation: committed.confirmation,
            notices: [...principal.notices, ...committed.notices]
          };
        }
        if (readyPendingState) {
          // A failed reservation upgrade must not degrade the healthy pending
          // link it was trying to improve: the link stays ready and the next
          // status check simply retries the admission.
          return success(
            await contextFromCommitted(readyPendingState, dependencies.gatewayAuthority),
            [...principal.notices, ...committed.notices]
          );
        }
        await dependencies.store.markProvisioningFailure(input.authUserId, committed.error.code, input.now);
        return failure(committed.error, [...principal.notices, ...committed.notices]);
      } catch {
        if (readyPendingState) {
          return success(
            await contextFromCommitted(readyPendingState, dependencies.gatewayAuthority),
            principal.notices
          );
        }
        await dependencies.store.markProvisioningFailure(input.authUserId, 'provisioning_dependency_failed', input.now);
        return failure({
          code: 'provisioning_dependency_failed',
          message: 'JooEvents could not finish sign-in yet.',
          retryable: true
        }, principal.notices);
      }
    },

    normalizeVerifiedEmail(email: string): string {
      return normalizeEmail(email);
    }
  };
}
