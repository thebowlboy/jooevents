import type {
  ExternalIdentityClaims,
  ExternalIdentityLink,
  User,
  UserEmail,
  UserId,
  WorkspaceId,
  WorkspaceMembership
} from './identity';
import type { AvatarImportJob, MediaAsset } from './profile-media';
import type {
  AccessReservation,
  PermissionOverride,
  Role,
  RoleAssignment
} from './permissions';
import type { SignInMutation } from './sign-in';

export interface UserRepository {
  findById(userId: UserId): Promise<User | undefined>;
  findByVerifiedEmail(normalizedEmail: string): Promise<{ user: User; email: UserEmail } | undefined>;
}

export interface ExternalIdentityRepository {
  findByProviderIdentity(input: Pick<ExternalIdentityClaims, 'provider' | 'issuer' | 'subject'>): Promise<ExternalIdentityLink | undefined>;
}

export interface MembershipRepository {
  find(workspaceId: WorkspaceId, userId: UserId): Promise<WorkspaceMembership | undefined>;
}

export interface AccessReservationRepository {
  findOpenByEmail(workspaceId: WorkspaceId, normalizedEmail: string): Promise<AccessReservation | undefined>;
}

export interface AuthorizationRepository {
  listRoles(workspaceId: WorkspaceId): Promise<readonly Role[]>;
  listAssignments(workspaceId: WorkspaceId, userId: UserId): Promise<readonly RoleAssignment[]>;
  listOverrides(workspaceId: WorkspaceId, userId: UserId): Promise<readonly PermissionOverride[]>;
}

export interface ProfileMediaRepository {
  findAsset(assetId: string): Promise<MediaAsset | undefined>;
  claimPendingAvatarJobs(limit: number): Promise<readonly AvatarImportJob[]>;
}

/**
 * SQLite, D1, and PostgreSQL adapters expose the same repositories. Multi-record
 * sign-in changes and their audit/outbox records must commit in one transaction.
 */
export interface IdentityAccessStore {
  readonly users: UserRepository;
  readonly externalIdentities: ExternalIdentityRepository;
  readonly memberships: MembershipRepository;
  readonly reservations: AccessReservationRepository;
  readonly authorization: AuthorizationRepository;
  readonly profileMedia: ProfileMediaRepository;
  runInTransaction<T>(operation: (transaction: IdentityAccessTransaction) => Promise<T>): Promise<T>;
}

export interface IdentityAccessTransaction {
  execute(command: SignInMutation): Promise<void>;
}
