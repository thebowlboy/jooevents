import type { AdapterOutcome } from './outcomes';

export type ISODateTime = string;
export type UserId = string;
export type WorkspaceId = string;
export type EventId = string;
export type MembershipId = string;
export type ReservationId = string;
export type IdentityLinkRequestId = string;

export type UserStatus = 'pending_review' | 'active' | 'suspended' | 'deactivated';

/** One person inside JooEvents, independent of any login provider. */
export interface User {
  readonly id: UserId;
  readonly status: UserStatus;
  readonly displayName: string;
  readonly primaryEmailId?: string;
  readonly avatarAssetId?: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly version?: number;
}

export interface UserEmail {
  readonly id: string;
  readonly userId: UserId;
  readonly normalizedEmail: string;
  readonly displayEmail: string;
  readonly verified: boolean;
  readonly source: 'auth_provider' | 'admin' | 'user';
  readonly isPrimary: boolean;
  readonly createdAt: ISODateTime;
  readonly lastVerifiedAt?: ISODateTime;
}

export interface ProviderAvatarCandidate {
  readonly provider: string;
  readonly url: string;
  readonly observedAt: ISODateTime;
  /** Optional provider value used to avoid downloading an unchanged image. */
  readonly sourceFingerprint?: string;
}

/** Claims after the provider adapter has verified issuer, audience, signature, and expiry. */
export interface ExternalIdentityClaims {
  readonly provider: string;
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly hostedDomain?: string;
  readonly avatar?: ProviderAvatarCandidate;
  readonly observedAt: ISODateTime;
}

/** The stable link is provider + verified issuer + subject. Email is only a snapshot. */
export interface ExternalIdentityLink {
  readonly id: string;
  readonly userId: UserId;
  readonly provider: string;
  readonly issuer: string;
  readonly subject: string;
  readonly emailSnapshot?: string;
  readonly emailVerifiedSnapshot: boolean;
  readonly displayNameSnapshot?: string;
  readonly avatarUrlSnapshot?: string;
  readonly linkedAt: ISODateTime;
  readonly lastObservedAt: ISODateTime;
}

export function externalIdentityKey(
  identity: Pick<ExternalIdentityClaims, 'provider' | 'issuer' | 'subject'>
): string {
  return `${identity.provider}\u001f${identity.issuer}\u001f${identity.subject}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export type MembershipStatus =
  | 'invited'
  | 'pending_review'
  | 'active'
  | 'suspended'
  | 'deactivated';

/** A user's admission state inside one workspace. */
export interface WorkspaceMembership {
  readonly id: MembershipId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly status: MembershipStatus;
  readonly approvedByUserId?: UserId;
  readonly approvedAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly version?: number;
}

export type AuthUserProvisioningState = 'pending' | 'ready' | 'failed';

/** A recoverable mapping between a Better Auth principal and the canonical person. */
export interface AuthUserLink {
  readonly authUserId: string;
  readonly userId?: UserId;
  readonly provisioningState: AuthUserProvisioningState;
  readonly lastErrorCode?: string;
  readonly attempts: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Provider-specific code ends here; the application only receives normalized claims. */
export interface AuthProviderAdapter<Input> {
  readonly provider: string;
  verify(input: Input): Promise<AdapterOutcome<ExternalIdentityClaims>>;
}
