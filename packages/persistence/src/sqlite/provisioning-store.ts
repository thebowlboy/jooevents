import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type {
  CommittedAccessState,
  ProvisioningStore,
  SignInEvidence
} from '@jooevents/application';
import {
  failure,
  normalizeEmail,
  success,
  type AccessReservation,
  type AdapterOutcome,
  type AuthUserLink,
  type ExternalIdentityClaims,
  type SignInMutation,
  type SignInPlan,
  type UserReference
} from '@jooevents/identity-access';
import type {
  WorkspaceTeamProvisioningGuard,
  WorkspaceTeamProvisioningSynchronizationPort
} from './workspace-team';

type Row = Record<string, string | number | null>;

function iso(value: string | number | null | undefined): string {
  if (value === null || value === undefined) throw new Error('required timestamp is missing');
  return new Date(Number(value)).toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

function bind(sqlite: Database, statement: string, ...values: SQLQueryBindings[]) {
  return sqlite.query(statement).run(...values);
}

function reservationFromRows(sqlite: Database, row: Row): AccessReservation {
  const roleRows = sqlite.query<Row, [string]>('select role_id, scope_kind, event_id from reservation_role_assignments where reservation_id = ?').all(String(row.id));
  const overrideRows = sqlite.query<Row, [string]>('select permission_id, effect, scope_kind, event_id, reason from reservation_permission_overrides where reservation_id = ?').all(String(row.id));
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    normalizedEmail: String(row.normalized_email),
    roleAssignments: roleRows.map((item) => ({
      roleId: String(item.role_id),
      scope: item.scope_kind === 'event' ? { kind: 'event', eventId: String(item.event_id) } : { kind: 'workspace' }
    })),
    permissionOverrides: overrideRows.map((item) => ({
      permissionId: String(item.permission_id) as AccessReservation['permissionOverrides'][number]['permissionId'],
      effect: String(item.effect) as 'grant' | 'deny',
      scope: item.scope_kind === 'event' ? { kind: 'event', eventId: String(item.event_id) } : { kind: 'workspace' },
      reason: String(item.reason)
    })),
    status: String(row.status) as AccessReservation['status'],
    ...(row.expires_at != null ? { expiresAt: iso(row.expires_at) } : {}),
    createdByUserId: row.created_by_user_id === null ? 'system_bootstrap' : String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    ...(row.consumed_by_user_id != null ? { consumedByUserId: String(row.consumed_by_user_id) } : {}),
    ...(row.consumed_at != null ? { consumedAt: iso(row.consumed_at) } : {})
  };
}

function readState(sqlite: Database, authUserId: string, workspaceId: string): AdapterOutcome<CommittedAccessState> {
  const row = sqlite.query<Row, [string, string]>(`
    select u.id user_id, u.display_name, u.avatar_asset_id, e.display_email,
           m.id membership_id, m.status membership_status, m.version membership_version,
           w.id workspace_id, w.name workspace_name
      from auth_user_links l
      join users u on u.id = l.user_id
      join workspace_memberships m on m.user_id = u.id and m.workspace_id = ?
      join workspaces w on w.id = m.workspace_id
      left join user_emails e on e.id = u.primary_email_id
     where l.auth_user_id = ? and l.provisioning_state = 'ready'
  `).get(workspaceId, authUserId);
  if (!row) return failure({ code: 'access_context_not_ready', message: 'Application access is still being prepared.', retryable: true });
  return success({
    user: {
      id: String(row.user_id),
      displayName: String(row.display_name),
      ...(row.display_email != null ? { primaryEmail: String(row.display_email) } : {}),
      ...(row.avatar_asset_id != null ? { avatarAssetId: String(row.avatar_asset_id) } : {})
    },
    membership: {
      id: String(row.membership_id),
      workspaceId: String(row.workspace_id),
      status: String(row.membership_status) as CommittedAccessState['membership']['status'],
      version: Number(row.membership_version)
    },
    workspace: { id: String(row.workspace_id), name: String(row.workspace_name) }
  });
}

export function createSQLiteProvisioningStore(
  sqlite: Database,
  options: {
    readonly workspaceTeam?: WorkspaceTeamProvisioningSynchronizationPort;
  } = {}
): ProvisioningStore {
  function userIdFor(reference: UserReference, newUserId: string | undefined): string {
    if (reference.kind === 'existing') return reference.userId;
    if (!newUserId) throw new Error('Mutation references the new user before create_user');
    return newUserId;
  }

  function executeMutation(input: {
    mutation: SignInMutation;
    workspaceId: string;
    nowMs: number;
    correlationId: string;
    newUserId: string | undefined;
  }): string | undefined {
    const { mutation, workspaceId, nowMs, correlationId } = input;
    switch (mutation.type) {
      case 'create_user': {
        const newUserId = input.newUserId ?? id();
        bind(sqlite, 'insert into users (id, status, display_name, created_at, updated_at, version) values (?, ?, ?, ?, ?, 1)', newUserId, mutation.status, mutation.displayName, nowMs, nowMs);
        return newUserId;
      }
      case 'activate_user':
        bind(sqlite, `update users set status = 'active', updated_at = ?, version = version + 1 where id = ? and status = 'pending_review'`, nowMs, mutation.userId);
        break;
      case 'add_verified_email': {
        const userId = userIdFor(mutation.user, input.newUserId);
        const emailId = id();
        bind(sqlite, `insert into user_emails (id, user_id, normalized_email, display_email, verified, source, is_primary, verified_at, created_at)
          values (?, ?, ?, ?, 1, 'auth_provider', 1, ?, ?)`, emailId, userId, normalizeEmail(mutation.email), mutation.email, nowMs, nowMs);
        bind(sqlite, 'update users set primary_email_id = ?, updated_at = ? where id = ? and primary_email_id is null', emailId, nowMs, userId);
        break;
      }
      case 'link_external_identity': {
        const userId = userIdFor(mutation.user, input.newUserId);
        bind(sqlite, `insert into external_identities
          (id, user_id, provider, issuer, subject, email_snapshot, email_verified_snapshot, display_name_snapshot, avatar_url_snapshot, linked_at, last_observed_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id(), userId, mutation.claims.provider, mutation.claims.issuer, mutation.claims.subject, mutation.claims.email ?? null, mutation.claims.emailVerified ? 1 : 0, mutation.claims.displayName ?? null, mutation.claims.avatar?.url ?? null, nowMs, Date.parse(mutation.claims.observedAt));
        break;
      }
      case 'refresh_external_identity_snapshot':
        bind(sqlite, `update external_identities set email_snapshot = ?, email_verified_snapshot = ?, display_name_snapshot = ?, avatar_url_snapshot = ?, last_observed_at = ? where id = ?`,
          mutation.claims.email ?? null, mutation.claims.emailVerified ? 1 : 0, mutation.claims.displayName ?? null, mutation.claims.avatar?.url ?? null, Date.parse(mutation.claims.observedAt), mutation.identityLinkId);
        break;
      case 'create_membership':
        bind(sqlite, `insert into workspace_memberships (id, workspace_id, user_id, status, created_at, updated_at, version) values (?, ?, ?, ?, ?, ?, 1)`, id(), mutation.workspaceId, userIdFor(mutation.user, input.newUserId), mutation.status, nowMs, nowMs);
        break;
      case 'activate_membership':
        bind(sqlite, `update workspace_memberships set status = 'active', approved_at = ?, updated_at = ?, version = version + 1 where id = ? and status in ('invited', 'pending_review')`, nowMs, nowMs, mutation.membershipId);
        break;
      case 'assign_reserved_roles': {
        const userId = userIdFor(mutation.user, input.newUserId);
        for (const assignment of mutation.roleAssignments) {
          const role = sqlite.query<Row, [string, string]>('select id from roles where id = ? and workspace_id = ? and archived_at is null').get(assignment.roleId, workspaceId);
          if (!role) throw new Error('reserved_role_not_in_workspace');
          bind(sqlite, `insert into role_assignments (id, user_id, role_id, workspace_id, scope_kind, event_id, assigned_at, version) values (?, ?, ?, ?, ?, ?, ?, 1)`, id(), userId, assignment.roleId, workspaceId, assignment.scope.kind, assignment.scope.kind === 'event' ? assignment.scope.eventId : null, nowMs);
        }
        break;
      }
      case 'apply_reserved_permission_overrides': {
        const userId = userIdFor(mutation.user, input.newUserId);
        for (const override of mutation.permissionOverrides) {
          bind(sqlite, `insert into permission_overrides (id, user_id, permission_id, effect, workspace_id, scope_kind, event_id, reason, decided_at, version) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, id(), userId, override.permissionId, override.effect, workspaceId, override.scope.kind, override.scope.kind === 'event' ? override.scope.eventId : null, override.reason, nowMs);
        }
        break;
      }
      case 'consume_access_reservation': {
        const userId = userIdFor(mutation.user, input.newUserId);
        const result = bind(sqlite, `update access_reservations set status = 'consumed', consumed_by_user_id = ?, consumed_at = ?, version = version + 1 where id = ? and status = 'open' and (expires_at is null or expires_at > ?)`, userId, nowMs, mutation.reservationId, nowMs);
        if (result.changes !== 1) {
          const current = sqlite.query<Row, [string, string]>('select id from access_reservations where id = ? and status = \'consumed\' and consumed_by_user_id = ?').get(mutation.reservationId, userId);
          if (!current) throw new Error('reservation_not_available');
        }
        break;
      }
      case 'request_avatar_import': {
        const userId = userIdFor(mutation.user, input.newUserId);
        const current = sqlite.query<Row, [string]>('select avatar_asset_id from users where id = ?').get(userId);
        const key = `${userId}:${mutation.candidate.provider}:${mutation.candidate.sourceFingerprint ?? mutation.candidate.url}`;
        bind(sqlite, `insert or ignore into avatar_import_jobs
          (id, user_id, status, source_provider, source_url, source_fingerprint, expected_current_asset_id, replace_asset_id, attempts, next_attempt_at, idempotency_key, created_at, updated_at)
          values (?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`, id(), userId, mutation.candidate.provider, mutation.candidate.url, mutation.candidate.sourceFingerprint ?? null, current?.avatar_asset_id ?? null, current?.avatar_asset_id ?? null, nowMs, key, nowMs, nowMs);
        break;
      }
      case 'expose_active_access_context':
      case 'expose_pending_review_access_context':
        break;
      case 'write_audit_event': {
        const userId = userIdFor(mutation.user, input.newUserId);
        bind(sqlite, `insert into audit_events (id, actor_type, actor_id, action, target_type, target_id, workspace_id, evidence_json, correlation_id, occurred_at)
          values (?, 'user', ?, ?, 'user', ?, ?, '{}', ?, ?)`, id(), userId, mutation.eventType, userId, workspaceId, correlationId, nowMs);
        break;
      }
    }
    return input.newUserId;
  }

  return {
    async findAuthUserLink(authUserId: string): Promise<AuthUserLink | undefined> {
      const row = sqlite.query<Row, [string]>('select * from auth_user_links where auth_user_id = ?').get(authUserId);
      if (!row) return undefined;
      return {
        authUserId: String(row.auth_user_id),
        ...(row.user_id != null ? { userId: String(row.user_id) } : {}),
        provisioningState: String(row.provisioning_state) as AuthUserLink['provisioningState'],
        ...(row.last_error_code != null ? { lastErrorCode: String(row.last_error_code) } : {}),
        attempts: Number(row.attempts),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at)
      };
    },

    async loadSignInEvidence(input: { workspaceId: string; claims: ExternalIdentityClaims }): Promise<SignInEvidence> {
      const identity = sqlite.query<Row, [string, string, string]>(`select * from external_identities where provider = ? and issuer = ? and subject = ?`).get(input.claims.provider, input.claims.issuer, input.claims.subject);
      let linkedUser: SignInEvidence['linkedUser'];
      let linkedMembership: SignInEvidence['linkedMembership'];
      if (identity) {
        const user = sqlite.query<Row, [string]>('select * from users where id = ?').get(String(identity.user_id));
        if (user) linkedUser = { id: String(user.id), status: String(user.status) as NonNullable<SignInEvidence['linkedUser']>['status'], displayName: String(user.display_name), ...(user.primary_email_id != null ? { primaryEmailId: String(user.primary_email_id) } : {}), ...(user.avatar_asset_id != null ? { avatarAssetId: String(user.avatar_asset_id) } : {}), createdAt: iso(user.created_at), updatedAt: iso(user.updated_at), version: Number(user.version) };
        const membership = sqlite.query<Row, [string, string]>('select * from workspace_memberships where workspace_id = ? and user_id = ?').get(input.workspaceId, String(identity.user_id));
        if (membership) linkedMembership = { id: String(membership.id), workspaceId: String(membership.workspace_id), userId: String(membership.user_id), status: String(membership.status) as NonNullable<SignInEvidence['linkedMembership']>['status'], ...(membership.approved_by_user_id != null ? { approvedByUserId: String(membership.approved_by_user_id) } : {}), ...(membership.approved_at != null ? { approvedAt: iso(membership.approved_at) } : {}), createdAt: iso(membership.created_at), updatedAt: iso(membership.updated_at), version: Number(membership.version) };
      }

      const normalizedEmail = input.claims.email && input.claims.emailVerified ? normalizeEmail(input.claims.email) : undefined;
      let sameEmailUser: SignInEvidence['sameEmailUser'];
      if (!identity && normalizedEmail) {
        const owner = sqlite.query<Row, [string]>(`select e.*, u.status, u.display_name, u.primary_email_id, u.avatar_asset_id, u.updated_at, u.version from user_emails e join users u on u.id = e.user_id where e.normalized_email = ? and e.verified = 1 and e.revoked_at is null`).get(normalizedEmail);
        if (owner) sameEmailUser = {
          user: { id: String(owner.user_id), status: String(owner.status) as NonNullable<SignInEvidence['linkedUser']>['status'], displayName: String(owner.display_name), ...(owner.primary_email_id != null ? { primaryEmailId: String(owner.primary_email_id) } : {}), ...(owner.avatar_asset_id != null ? { avatarAssetId: String(owner.avatar_asset_id) } : {}), createdAt: iso(owner.created_at), updatedAt: iso(owner.updated_at), version: Number(owner.version) },
          email: { id: String(owner.id), userId: String(owner.user_id), normalizedEmail: String(owner.normalized_email), displayEmail: String(owner.display_email), verified: true, source: String(owner.source) as 'auth_provider' | 'admin' | 'user', isPrimary: Number(owner.is_primary) === 1, createdAt: iso(owner.created_at), ...(owner.verified_at != null ? { lastVerifiedAt: iso(owner.verified_at) } : {}) }
        };
      }
      let reservation: AccessReservation | undefined;
      if (normalizedEmail) {
        const row = sqlite.query<Row, [string, string, number]>(`select * from access_reservations where workspace_id = ? and normalized_email = ? and status = 'open' and (expires_at is null or expires_at > ?)`).get(input.workspaceId, normalizedEmail, Date.parse(input.claims.observedAt));
        if (row) reservation = reservationFromRows(sqlite, row);
      }
      return {
        ...(identity ? { identityLink: { id: String(identity.id), userId: String(identity.user_id), provider: String(identity.provider), issuer: String(identity.issuer), subject: String(identity.subject), ...(identity.email_snapshot != null ? { emailSnapshot: String(identity.email_snapshot) } : {}), emailVerifiedSnapshot: Number(identity.email_verified_snapshot) === 1, ...(identity.display_name_snapshot != null ? { displayNameSnapshot: String(identity.display_name_snapshot) } : {}), ...(identity.avatar_url_snapshot != null ? { avatarUrlSnapshot: String(identity.avatar_url_snapshot) } : {}), linkedAt: iso(identity.linked_at), lastObservedAt: iso(identity.last_observed_at) } } : {}),
        ...(linkedUser ? { linkedUser } : {}),
        ...(linkedMembership ? { linkedMembership } : {}),
        ...(sameEmailUser ? { sameEmailUser } : {}),
        ...(reservation ? { reservation } : {})
      };
    },

    async commitSignInPlan(input: { authUserId: string; workspaceId: string; plan: SignInPlan; correlationId: string; now: string }): Promise<AdapterOutcome<CommittedAccessState>> {
      const nowMs = Date.parse(input.now);
      const run = sqlite.transaction(() => {
        const teamGuard: WorkspaceTeamProvisioningGuard | undefined =
          options.workspaceTeam?.captureWithinTransaction(input.workspaceId);
        bind(sqlite, `insert into auth_user_links (auth_user_id, provisioning_state, attempts, created_at, updated_at)
          values (?, 'pending', 1, ?, ?)
          on conflict(auth_user_id) do update set provisioning_state = 'pending', attempts = auth_user_links.attempts + 1, last_error_code = null, updated_at = excluded.updated_at`, input.authUserId, nowMs, nowMs);
        let newUserId: string | undefined;
        for (const mutation of input.plan.mutations) {
          newUserId = executeMutation({ mutation, workspaceId: input.workspaceId, nowMs, correlationId: input.correlationId, newUserId });
        }
        const resolvedUserId = newUserId ?? input.plan.mutations.flatMap((mutation) => 'user' in mutation && mutation.user.kind === 'existing' ? [mutation.user.userId] : []).at(0);
        if (!resolvedUserId) throw new Error('sign_in_plan_has_no_user');
        bind(sqlite, `update auth_user_links set user_id = ?, provisioning_state = 'ready', last_error_code = null, updated_at = ? where auth_user_id = ?`, resolvedUserId, nowMs, input.authUserId);
        if (input.plan.result === 'awaiting_approval') {
          bind(sqlite, `insert or ignore into outbox_events
            (id, type, version, payload_json, aggregate_type, aggregate_id, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
            values (?, 'access.requested', 1, ?, 'user', ?, ?, 'pending', 0, ?, ?, ?)`, id(), JSON.stringify({ userId: resolvedUserId, workspaceId: input.workspaceId }), resolvedUserId, `access.requested:${input.workspaceId}:${resolvedUserId}`, nowMs, nowMs, nowMs);
        }
        if (teamGuard) options.workspaceTeam!.synchronizeWithinTransaction(teamGuard);
      });
      try {
        run();
        return readState(sqlite, input.authUserId, input.workspaceId);
      } catch (error) {
        const converged = readState(sqlite, input.authUserId, input.workspaceId);
        if (converged.kind === 'success') return success(converged.data, [{ code: 'provisioning_converged', severity: 'info', message: 'A concurrent sign-in already completed the same application state.' }]);
        return failure({ code: 'provisioning_commit_failed', message: 'JooEvents could not commit the application identity state.', retryable: true, details: { cause: error instanceof Error ? error.message : 'unknown' } });
      }
    },

    async readCommittedAccess(authUserId: string, workspaceId: string) {
      return readState(sqlite, authUserId, workspaceId);
    },

    async markProvisioningFailure(authUserId: string, errorCode: string, now: string): Promise<void> {
      const nowMs = Date.parse(now);
      bind(sqlite, `insert into auth_user_links (auth_user_id, provisioning_state, last_error_code, attempts, created_at, updated_at)
        values (?, 'failed', ?, 1, ?, ?)
        on conflict(auth_user_id) do update set provisioning_state = 'failed', last_error_code = excluded.last_error_code, attempts = auth_user_links.attempts + 1, updated_at = excluded.updated_at`, authUserId, errorCode, nowMs, nowMs);
    }
  };
}
