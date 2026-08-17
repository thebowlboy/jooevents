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
import { canonicalJsonText } from '@jooevents/kernel';
import {
  runD1BufferedUnitOfWork,
  type D1BufferedUnitOfWork
} from './d1-atomic-batch';

type Row = Record<string, string | number | null>;

function iso(value: string | number | null | undefined): string {
  if (value === null || value === undefined) throw new Error('required_timestamp_missing');
  return new Date(Number(value)).toISOString();
}

async function reservationFromRow(
  session: D1DatabaseSession,
  row: Row
): Promise<AccessReservation> {
  const roleRows = await session.prepare(`
    SELECT role_id,scope_kind,event_id
      FROM reservation_role_assignments WHERE reservation_id = ?
  `).bind(String(row.id)).all<Row>();
  const overrideRows = await session.prepare(`
    SELECT permission_id,effect,scope_kind,event_id,reason
      FROM reservation_permission_overrides WHERE reservation_id = ?
  `).bind(String(row.id)).all<Row>();
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    normalizedEmail: String(row.normalized_email),
    roleAssignments: roleRows.results.map((item) => ({
      roleId: String(item.role_id),
      scope: item.scope_kind === 'event'
        ? { kind: 'event', eventId: String(item.event_id) }
        : { kind: 'workspace' }
    })),
    permissionOverrides: overrideRows.results.map((item) => ({
      permissionId: String(item.permission_id) as AccessReservation['permissionOverrides'][number]['permissionId'],
      effect: String(item.effect) as 'grant' | 'deny',
      scope: item.scope_kind === 'event'
        ? { kind: 'event', eventId: String(item.event_id) }
        : { kind: 'workspace' },
      reason: String(item.reason)
    })),
    status: String(row.status) as AccessReservation['status'],
    ...(row.expires_at !== null ? { expiresAt: iso(row.expires_at) } : {}),
    createdByUserId: row.created_by_user_id === null
      ? 'system_bootstrap'
      : String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    ...(row.consumed_by_user_id !== null
      ? { consumedByUserId: String(row.consumed_by_user_id) }
      : {}),
    ...(row.consumed_at !== null ? { consumedAt: iso(row.consumed_at) } : {})
  };
}

async function readState(
  session: D1DatabaseSession,
  authUserId: string,
  workspaceId: string
): Promise<AdapterOutcome<CommittedAccessState>> {
  const row = await session.prepare(`
    SELECT u.id AS user_id,u.display_name,u.avatar_asset_id,e.display_email,
           m.id AS membership_id,m.status AS membership_status,m.version AS membership_version,
           w.id AS workspace_id,w.name AS workspace_name
      FROM auth_user_links l
      JOIN users u ON u.id = l.user_id
      JOIN workspace_memberships m ON m.user_id = u.id AND m.workspace_id = ?
      JOIN workspaces w ON w.id = m.workspace_id
      LEFT JOIN user_emails e ON e.id = u.primary_email_id
     WHERE l.auth_user_id = ? AND l.provisioning_state = 'ready'
  `).bind(workspaceId, authUserId).first<Row>();
  if (!row) {
    return failure({
      code: 'access_context_not_ready',
      message: 'Application access is still being prepared.',
      retryable: true
    });
  }
  return success({
    user: {
      id: String(row.user_id),
      displayName: String(row.display_name),
      ...(row.display_email !== null ? { primaryEmail: String(row.display_email) } : {}),
      ...(row.avatar_asset_id !== null ? { avatarAssetId: String(row.avatar_asset_id) } : {})
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

function referencedUserId(plan: SignInPlan): string | undefined {
  return plan.mutations.flatMap((mutation) =>
    'user' in mutation && mutation.user.kind === 'existing' ? [mutation.user.userId] : []
  ).at(0);
}

async function workspaceInvitationLookupBinding(input: {
  readonly keyBytes: Uint8Array;
  readonly workspaceId: string;
  readonly normalizedEmail: string;
}): Promise<string> {
  if (input.keyBytes.byteLength < 32) throw new TypeError('workspace_invitation_lookup_key_invalid');
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(input.keyBytes).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalJsonText({
      workspaceId: input.workspaceId,
      normalizedEmail: input.normalizedEmail
    }))
  ));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** D1 implementation of the existing two-transaction admission store contract. */
export function createD1ProvisioningStore(
  database: D1Database,
  options: { readonly workspaceInvitationLookupKeyBytes?: readonly Uint8Array[] } = {}
): ProvisioningStore {
  const workspaceInvitationLookupKeyBytes = (options.workspaceInvitationLookupKeyBytes ?? [])
    .map((keyBytes) => Uint8Array.from(keyBytes));
  if (workspaceInvitationLookupKeyBytes.some((keyBytes) => keyBytes.byteLength < 32)) {
    throw new TypeError('workspace_invitation_lookup_key_invalid');
  }
  const userIdFor = (reference: UserReference, newUserId: string | undefined): string => {
    if (reference.kind === 'existing') return reference.userId;
    if (!newUserId) throw new Error('sign_in_mutation_references_missing_new_user');
    return newUserId;
  };

  async function bufferMutation(input: {
    readonly unitOfWork: D1BufferedUnitOfWork;
    readonly mutation: SignInMutation;
    readonly workspaceId: string;
    readonly nowMs: number;
    readonly correlationId: string;
    readonly newUserId: string | undefined;
  }): Promise<string | undefined> {
    const { unitOfWork, mutation, workspaceId, nowMs, correlationId } = input;
    const newId = () => crypto.randomUUID();
    switch (mutation.type) {
      case 'create_user': {
        const createdUserId = input.newUserId ?? newId();
        unitOfWork.write(`INSERT INTO users
          (id,status,display_name,created_at,updated_at,version)
          VALUES (?,?,?,?,?,1)`, [
          createdUserId,
          mutation.status,
          mutation.displayName,
          nowMs,
          nowMs
        ]);
        return createdUserId;
      }
      case 'activate_user':
        unitOfWork.assertCurrent(
          "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'pending_review')",
          [mutation.userId]
        );
        unitOfWork.write(`UPDATE users SET status = 'active',updated_at = ?,version = version + 1
          WHERE id = ? AND status = 'pending_review'`, [nowMs, mutation.userId]);
        break;
      case 'add_verified_email': {
        const userId = userIdFor(mutation.user, input.newUserId);
        const normalizedEmail = normalizeEmail(mutation.email);
        const emailId = newId();
        unitOfWork.assertCurrent(`NOT EXISTS (
          SELECT 1 FROM user_emails
           WHERE normalized_email = ? AND verified = 1 AND revoked_at IS NULL
        )`, [normalizedEmail]);
        unitOfWork.write(`INSERT INTO user_emails
          (id,user_id,normalized_email,display_email,verified,source,is_primary,verified_at,created_at)
          VALUES (?,?,?,?,1,'auth_provider',1,?,?)`, [
          emailId,
          userId,
          normalizedEmail,
          mutation.email,
          nowMs,
          nowMs
        ]);
        unitOfWork.write(`UPDATE users SET primary_email_id = ?,updated_at = ?
          WHERE id = ? AND primary_email_id IS NULL`, [emailId, nowMs, userId]);
        break;
      }
      case 'link_external_identity': {
        const userId = userIdFor(mutation.user, input.newUserId);
        unitOfWork.assertCurrent(`NOT EXISTS (
          SELECT 1 FROM external_identities WHERE provider = ? AND issuer = ? AND subject = ?
        )`, [mutation.claims.provider, mutation.claims.issuer, mutation.claims.subject]);
        unitOfWork.write(`INSERT INTO external_identities
          (id,user_id,provider,issuer,subject,email_snapshot,email_verified_snapshot,
           display_name_snapshot,avatar_url_snapshot,linked_at,last_observed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
          newId(),
          userId,
          mutation.claims.provider,
          mutation.claims.issuer,
          mutation.claims.subject,
          mutation.claims.email ?? null,
          mutation.claims.emailVerified ? 1 : 0,
          mutation.claims.displayName ?? null,
          mutation.claims.avatar?.url ?? null,
          nowMs,
          Date.parse(mutation.claims.observedAt)
        ]);
        break;
      }
      case 'refresh_external_identity_snapshot':
        unitOfWork.assertCurrent(`EXISTS (
          SELECT 1 FROM external_identities
           WHERE id = ? AND provider = ? AND issuer = ? AND subject = ?
        )`, [
          mutation.identityLinkId,
          mutation.claims.provider,
          mutation.claims.issuer,
          mutation.claims.subject
        ]);
        unitOfWork.write(`UPDATE external_identities
          SET email_snapshot = ?,email_verified_snapshot = ?,display_name_snapshot = ?,
              avatar_url_snapshot = ?,last_observed_at = ? WHERE id = ?`, [
          mutation.claims.email ?? null,
          mutation.claims.emailVerified ? 1 : 0,
          mutation.claims.displayName ?? null,
          mutation.claims.avatar?.url ?? null,
          Date.parse(mutation.claims.observedAt),
          mutation.identityLinkId
        ]);
        break;
      case 'create_membership': {
        const userId = userIdFor(mutation.user, input.newUserId);
        unitOfWork.assertCurrent(`NOT EXISTS (
          SELECT 1 FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?
        )`, [mutation.workspaceId, userId]);
        unitOfWork.write(`INSERT INTO workspace_memberships
          (id,workspace_id,user_id,status,created_at,updated_at,version)
          VALUES (?,?,?,?,?,?,1)`, [
          newId(),
          mutation.workspaceId,
          userId,
          mutation.status,
          nowMs,
          nowMs
        ]);
        break;
      }
      case 'activate_membership':
        unitOfWork.assertCurrent(`EXISTS (
          SELECT 1 FROM workspace_memberships
           WHERE id = ? AND status IN ('invited','pending_review')
        )`, [mutation.membershipId]);
        unitOfWork.write(`UPDATE workspace_memberships
          SET status = 'active',approved_at = ?,updated_at = ?,version = version + 1
          WHERE id = ? AND status IN ('invited','pending_review')`, [
          nowMs,
          nowMs,
          mutation.membershipId
        ]);
        break;
      case 'assign_reserved_roles': {
        const userId = userIdFor(mutation.user, input.newUserId);
        for (const assignment of mutation.roleAssignments) {
          unitOfWork.assertCurrent(`EXISTS (
            SELECT 1 FROM roles WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
          )`, [assignment.roleId, workspaceId]);
          unitOfWork.write(`INSERT INTO role_assignments
            (id,user_id,role_id,workspace_id,scope_kind,event_id,assigned_at,version)
            VALUES (?,?,?,?,?,?,?,1)`, [
            newId(),
            userId,
            assignment.roleId,
            workspaceId,
            assignment.scope.kind,
            assignment.scope.kind === 'event' ? assignment.scope.eventId : null,
            nowMs
          ]);
        }
        break;
      }
      case 'apply_reserved_permission_overrides': {
        const userId = userIdFor(mutation.user, input.newUserId);
        for (const override of mutation.permissionOverrides) {
          unitOfWork.write(`INSERT INTO permission_overrides
            (id,user_id,permission_id,effect,workspace_id,scope_kind,event_id,reason,decided_at,version)
            VALUES (?,?,?,?,?,?,?,?,?,1)`, [
            newId(),
            userId,
            override.permissionId,
            override.effect,
            workspaceId,
            override.scope.kind,
            override.scope.kind === 'event' ? override.scope.eventId : null,
            override.reason,
            nowMs
          ]);
        }
        break;
      }
      case 'consume_access_reservation': {
        const userId = userIdFor(mutation.user, input.newUserId);
        unitOfWork.assertCurrent(`EXISTS (
          SELECT 1 FROM access_reservations
           WHERE id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
        )`, [mutation.reservationId, nowMs]);
        unitOfWork.write(`UPDATE access_reservations
          SET status = 'consumed',consumed_by_user_id = ?,consumed_at = ?,version = version + 1
          WHERE id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)`, [
          userId,
          nowMs,
          mutation.reservationId,
          nowMs
        ]);
        break;
      }
      case 'request_avatar_import': {
        const userId = userIdFor(mutation.user, input.newUserId);
        const current = await unitOfWork.readSession.prepare(
          'SELECT avatar_asset_id FROM users WHERE id = ?'
        ).bind(userId).first<Row>();
        unitOfWork.write(`INSERT OR IGNORE INTO avatar_import_jobs
          (id,user_id,status,source_provider,source_url,source_fingerprint,
           expected_current_asset_id,replace_asset_id,attempts,next_attempt_at,
           idempotency_key,created_at,updated_at)
          VALUES (?,?,'pending',?,?,?,?,?,0,?,?,?,?)`, [
          newId(),
          userId,
          mutation.candidate.provider,
          mutation.candidate.url,
          mutation.candidate.sourceFingerprint ?? null,
          current?.avatar_asset_id ?? null,
          current?.avatar_asset_id ?? null,
          nowMs,
          `${userId}:${mutation.candidate.provider}:${mutation.candidate.sourceFingerprint ?? mutation.candidate.url}`,
          nowMs,
          nowMs
        ]);
        break;
      }
      case 'expose_active_access_context':
      case 'expose_pending_review_access_context':
        break;
      case 'write_audit_event': {
        const userId = userIdFor(mutation.user, input.newUserId);
        unitOfWork.write(`INSERT INTO audit_events
          (id,actor_type,actor_id,action,target_type,target_id,workspace_id,
           evidence_json,correlation_id,occurred_at)
          VALUES (?,'user',?,?,'user',?,?,'{}',?,?)`, [
          newId(),
          userId,
          mutation.eventType,
          userId,
          workspaceId,
          correlationId,
          nowMs
        ]);
        break;
      }
    }
    return input.newUserId;
  }

  return {
    async findAuthUserLink(authUserId: string): Promise<AuthUserLink | undefined> {
      const row = await database.withSession('first-primary').prepare(
        'SELECT * FROM auth_user_links WHERE auth_user_id = ?'
      ).bind(authUserId).first<Row>();
      if (!row) return undefined;
      return {
        authUserId: String(row.auth_user_id),
        ...(row.user_id !== null ? { userId: String(row.user_id) } : {}),
        provisioningState: String(row.provisioning_state) as AuthUserLink['provisioningState'],
        ...(row.last_error_code !== null ? { lastErrorCode: String(row.last_error_code) } : {}),
        attempts: Number(row.attempts),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at)
      };
    },

    async loadSignInEvidence(input: {
      workspaceId: string;
      claims: ExternalIdentityClaims;
    }): Promise<SignInEvidence> {
      const session = database.withSession('first-primary');
      const identity = await session.prepare(`SELECT * FROM external_identities
        WHERE provider = ? AND issuer = ? AND subject = ?`).bind(
        input.claims.provider,
        input.claims.issuer,
        input.claims.subject
      ).first<Row>();
      let linkedUser: SignInEvidence['linkedUser'];
      let linkedMembership: SignInEvidence['linkedMembership'];
      if (identity) {
        const user = await session.prepare('SELECT * FROM users WHERE id = ?')
          .bind(String(identity.user_id)).first<Row>();
        if (user) {
          linkedUser = {
            id: String(user.id),
            status: String(user.status) as NonNullable<SignInEvidence['linkedUser']>['status'],
            displayName: String(user.display_name),
            ...(user.primary_email_id !== null
              ? { primaryEmailId: String(user.primary_email_id) }
              : {}),
            ...(user.avatar_asset_id !== null ? { avatarAssetId: String(user.avatar_asset_id) } : {}),
            createdAt: iso(user.created_at),
            updatedAt: iso(user.updated_at),
            version: Number(user.version)
          };
        }
        const membership = await session.prepare(`SELECT * FROM workspace_memberships
          WHERE workspace_id = ? AND user_id = ?`).bind(
          input.workspaceId,
          String(identity.user_id)
        ).first<Row>();
        if (membership) {
          linkedMembership = {
            id: String(membership.id),
            workspaceId: String(membership.workspace_id),
            userId: String(membership.user_id),
            status: String(membership.status) as NonNullable<SignInEvidence['linkedMembership']>['status'],
            ...(membership.approved_by_user_id !== null
              ? { approvedByUserId: String(membership.approved_by_user_id) }
              : {}),
            ...(membership.approved_at !== null ? { approvedAt: iso(membership.approved_at) } : {}),
            createdAt: iso(membership.created_at),
            updatedAt: iso(membership.updated_at),
            version: Number(membership.version)
          };
        }
      }
      const normalizedEmail = input.claims.email && input.claims.emailVerified
        ? normalizeEmail(input.claims.email)
        : undefined;
      let sameEmailUser: SignInEvidence['sameEmailUser'];
      if (!identity && normalizedEmail) {
        const owner = await session.prepare(`
          SELECT e.*,u.status,u.display_name,u.primary_email_id,u.avatar_asset_id,
                 u.created_at AS user_created_at,u.updated_at AS user_updated_at,u.version
            FROM user_emails e JOIN users u ON u.id = e.user_id
           WHERE e.normalized_email = ? AND e.verified = 1 AND e.revoked_at IS NULL
        `).bind(normalizedEmail).first<Row>();
        if (owner) {
          sameEmailUser = {
            user: {
              id: String(owner.user_id),
              status: String(owner.status) as NonNullable<SignInEvidence['linkedUser']>['status'],
              displayName: String(owner.display_name),
              ...(owner.primary_email_id !== null
                ? { primaryEmailId: String(owner.primary_email_id) }
                : {}),
              ...(owner.avatar_asset_id !== null
                ? { avatarAssetId: String(owner.avatar_asset_id) }
                : {}),
              createdAt: iso(owner.user_created_at),
              updatedAt: iso(owner.user_updated_at),
              version: Number(owner.version)
            },
            email: {
              id: String(owner.id),
              userId: String(owner.user_id),
              normalizedEmail: String(owner.normalized_email),
              displayEmail: String(owner.display_email),
              verified: true,
              source: String(owner.source) as 'auth_provider' | 'admin' | 'user',
              isPrimary: Number(owner.is_primary) === 1,
              createdAt: iso(owner.created_at),
              ...(owner.verified_at !== null ? { lastVerifiedAt: iso(owner.verified_at) } : {})
            }
          };
        }
      }
      let reservation: AccessReservation | undefined;
      if (normalizedEmail) {
        const row = await session.prepare(`SELECT * FROM access_reservations
          WHERE workspace_id = ? AND normalized_email = ? AND status = 'open'
            AND (expires_at IS NULL OR expires_at > ?)`
        ).bind(
          input.workspaceId,
          normalizedEmail,
          Date.parse(input.claims.observedAt)
        ).first<Row>();
        if (row) reservation = await reservationFromRow(session, row);
        if (!reservation && workspaceInvitationLookupKeyBytes.length > 0) {
          const invitations = new Map<string, Row>();
          for (const keyBytes of workspaceInvitationLookupKeyBytes) {
            const binding = await workspaceInvitationLookupBinding({
              keyBytes,
              workspaceId: input.workspaceId,
              normalizedEmail
            });
            const rows = await session.prepare(`
              SELECT r.* FROM access_reservations r
                JOIN workspace_team_invitation_recipients recipient
                  ON recipient.reservation_id = r.id
               WHERE r.workspace_id = ? AND recipient.lookup_binding = ?
                 AND r.status = 'open' AND (r.expires_at IS NULL OR r.expires_at > ?)
               LIMIT 2
            `).bind(
              input.workspaceId,
              binding,
              Date.parse(input.claims.observedAt)
            ).all<Row>();
            for (const invitation of rows.results) {
              invitations.set(String(invitation.id), invitation);
            }
          }
          if (invitations.size > 1) throw new Error('workspace_invitation_lookup_collision');
          const invitation = invitations.values().next().value;
          if (invitation) {
            reservation = {
              ...await reservationFromRow(session, invitation),
              normalizedEmail
            };
          }
        }
      }
      return {
        ...(identity ? {
          identityLink: {
            id: String(identity.id),
            userId: String(identity.user_id),
            provider: String(identity.provider),
            issuer: String(identity.issuer),
            subject: String(identity.subject),
            ...(identity.email_snapshot !== null
              ? { emailSnapshot: String(identity.email_snapshot) }
              : {}),
            emailVerifiedSnapshot: Number(identity.email_verified_snapshot) === 1,
            ...(identity.display_name_snapshot !== null
              ? { displayNameSnapshot: String(identity.display_name_snapshot) }
              : {}),
            ...(identity.avatar_url_snapshot !== null
              ? { avatarUrlSnapshot: String(identity.avatar_url_snapshot) }
              : {}),
            linkedAt: iso(identity.linked_at),
            lastObservedAt: iso(identity.last_observed_at)
          }
        } : {}),
        ...(linkedUser ? { linkedUser } : {}),
        ...(linkedMembership ? { linkedMembership } : {}),
        ...(sameEmailUser ? { sameEmailUser } : {}),
        ...(reservation ? { reservation } : {})
      };
    },

    async commitSignInPlan(input: {
      authUserId: string;
      workspaceId: string;
      plan: SignInPlan;
      correlationId: string;
      now: string;
    }): Promise<AdapterOutcome<CommittedAccessState>> {
      const nowMs = Date.parse(input.now);
      try {
        await runD1BufferedUnitOfWork({
          database,
          async work(unitOfWork) {
            unitOfWork.assertCurrent(`EXISTS (
              SELECT 1 FROM auth_users WHERE id = ?
            ) AND EXISTS (
              SELECT 1 FROM workspaces WHERE id = ? AND state = 'active'
            )`, [input.authUserId, input.workspaceId]);
            unitOfWork.write(`INSERT INTO auth_user_links
              (auth_user_id,provisioning_state,attempts,created_at,updated_at)
              VALUES (?,'pending',1,?,?)
              ON CONFLICT(auth_user_id) DO UPDATE SET
                provisioning_state = 'pending',
                attempts = auth_user_links.attempts + 1,
                last_error_code = NULL,
                updated_at = excluded.updated_at`, [input.authUserId, nowMs, nowMs]);
            let newUserId: string | undefined;
            for (const mutation of input.plan.mutations) {
              newUserId = await bufferMutation({
                unitOfWork,
                mutation,
                workspaceId: input.workspaceId,
                nowMs,
                correlationId: input.correlationId,
                newUserId
              });
            }
            const resolvedUserId = newUserId ?? referencedUserId(input.plan);
            if (!resolvedUserId) throw new Error('sign_in_plan_has_no_user');
            unitOfWork.write(`UPDATE auth_user_links
              SET user_id = ?,provisioning_state = 'ready',last_error_code = NULL,updated_at = ?
              WHERE auth_user_id = ?`, [resolvedUserId, nowMs, input.authUserId]);
            if (input.plan.result === 'awaiting_approval') {
              unitOfWork.write(`INSERT OR IGNORE INTO outbox_events
                (id,type,version,payload_json,aggregate_type,aggregate_id,idempotency_key,
                 status,attempts,next_attempt_at,created_at,updated_at)
                VALUES (?,'access.requested',1,?,'user',?,?,'pending',0,?,?,?)`, [
                crypto.randomUUID(),
                JSON.stringify({ userId: resolvedUserId, workspaceId: input.workspaceId }),
                resolvedUserId,
                `access.requested:${input.workspaceId}:${resolvedUserId}`,
                nowMs,
                nowMs,
                nowMs
              ]);
            }
          }
        });
        return readState(database.withSession('first-primary'), input.authUserId, input.workspaceId);
      } catch (error) {
        const converged = await readState(
          database.withSession('first-primary'),
          input.authUserId,
          input.workspaceId
        );
        if (converged.kind === 'success') {
          return success(converged.data, [{
            code: 'provisioning_converged',
            severity: 'info',
            message: 'A concurrent sign-in already completed the same application state.'
          }]);
        }
        return failure({
          code: 'provisioning_commit_failed',
          message: 'JooEvents could not commit the application identity state.',
          retryable: true,
          details: { cause: error instanceof Error ? error.message : 'unknown' }
        });
      }
    },

    readCommittedAccess(authUserId: string, workspaceId: string) {
      return readState(database.withSession('first-primary'), authUserId, workspaceId);
    },

    async markProvisioningFailure(authUserId: string, errorCode: string, now: string): Promise<void> {
      const nowMs = Date.parse(now);
      await database.prepare(`INSERT INTO auth_user_links
        (auth_user_id,provisioning_state,last_error_code,attempts,created_at,updated_at)
        VALUES (?,'failed',?,1,?,?)
        ON CONFLICT(auth_user_id) DO UPDATE SET
          provisioning_state = 'failed',
          last_error_code = excluded.last_error_code,
          attempts = auth_user_links.attempts + 1,
          updated_at = excluded.updated_at
      `).bind(authUserId, errorCode, nowMs, nowMs).run();
    }
  };
}
