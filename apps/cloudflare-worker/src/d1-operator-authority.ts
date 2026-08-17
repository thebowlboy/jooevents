import {
  createOperatorCurrentAuthorityResolver,
  type CurrentOperatorSessionRepository,
  type OperatorAuthorityPolicyCatalog,
  type OperatorScopeRelationshipResolution,
  type OperatorScopeRelationshipValidator
} from '@jooevents/application';
import type {
  AuthorizationRepository,
  MembershipRepository
} from '@jooevents/identity-access';
import {
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type EventId,
  type Instant,
  type ResolvedScope,
  type SubjectRef,
  type UserId,
  type WorkspaceId
} from '@jooevents/kernel';
import {
  assignmentFromAccessEvidenceRow,
  membershipFromAccessEvidenceRow,
  overrideFromAccessEvidenceRow,
  roleFromAccessEvidenceRows,
  type AssignmentEvidenceRow,
  type MembershipEvidenceRow,
  type OverrideEvidenceRow,
  type RoleEvidenceRow
} from '@jooevents/persistence/access-evidence';
import type { D1BufferedUnitOfWork } from './d1-atomic-batch';

interface OperatorSessionRow {
  readonly session_id: string;
  readonly auth_user_id: string;
  readonly expires_at: number;
  readonly link_auth_user_id: string | null;
  readonly user_id: string | null;
  readonly provisioning_state: string | null;
  readonly user_status: string | null;
}

interface WorkspaceRow {
  readonly id: string;
  readonly state: string;
}

interface RelationshipRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly user_id?: string;
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError(`d1_authority_evidence_invalid:${field}`);
  }
  return value;
}

function epochInstant(value: unknown, field: string): Instant {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`d1_authority_evidence_invalid:${field}`);
  }
  return parseInstant(new Date(value).toISOString());
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sessionHandle(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new TypeError('d1_operator_session_handle_invalid');
  }
  return value;
}

function resultRows<Row>(result: D1Result<Row>): readonly Row[] {
  return Object.freeze([...(result.results ?? [])]);
}

function assertRowCount(
  unitOfWork: D1BufferedUnitOfWork | undefined,
  countSql: string,
  bindings: readonly unknown[],
  count: number
): void {
  unitOfWork?.assertCurrent(`(${countSql}) = ?`, [...bindings, count]);
}

export interface D1OperatorSubjectRelationshipSource {
  validateSubject(input: Readonly<{
    unitOfWork?: D1BufferedUnitOfWork;
    session: D1DatabaseSession;
    workspaceId: WorkspaceId;
    eventId?: EventId;
    userId: UserId;
    subject: Extract<SubjectRef, { readonly kind: 'participant_person' | 'domain' }>;
    evaluatedAt: Instant;
  }>): OperatorScopeRelationshipResolution | Promise<OperatorScopeRelationshipResolution>;
}

function createCurrentSessionRepository(input: {
  readonly session: D1DatabaseSession;
  readonly unitOfWork?: D1BufferedUnitOfWork;
}): CurrentOperatorSessionRepository {
  return Object.freeze({
    async resolveCurrent(request: Parameters<CurrentOperatorSessionRepository['resolveCurrent']>[0]) {
      const handle = sessionHandle(request.sessionHandle);
      const evaluatedAt = parseInstant(request.evaluatedAt);
      const row = await input.session.prepare(`SELECT s.id AS session_id,
        s.user_id AS auth_user_id,s.expires_at,l.auth_user_id AS link_auth_user_id,
        l.user_id,l.provisioning_state,u.status AS user_status
        FROM auth_sessions s
        LEFT JOIN auth_user_links l ON l.auth_user_id = s.user_id
        LEFT JOIN users u ON u.id = l.user_id
        WHERE s.id = ?`).bind(handle).first<OperatorSessionRow>();
      if (!row) return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      const sessionId = boundedText(row.session_id, 'auth_sessions.id');
      const authUserId = boundedText(row.auth_user_id, 'auth_sessions.user_id');
      if (sessionId !== handle) throw new TypeError('d1_operator_session_identity_mismatch');
      const expiresAt = epochInstant(row.expires_at, 'auth_sessions.expires_at');
      if (Date.parse(expiresAt) <= Date.parse(evaluatedAt)) {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }
      if (row.link_auth_user_id === null || row.user_id === null
          || row.provisioning_state === null || row.user_status === null) {
        return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      }
      const linkedAuthUserId = boundedText(row.link_auth_user_id, 'auth_user_links.auth_user_id');
      const userId = parseUserId(boundedText(row.user_id, 'auth_user_links.user_id'));
      if (linkedAuthUserId !== authUserId) throw new TypeError('d1_operator_session_link_mismatch');
      if (row.provisioning_state !== 'ready') {
        return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      }
      if (row.user_status !== 'active') {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }
      input.unitOfWork?.assertCurrent(`EXISTS (
        SELECT 1 FROM auth_sessions s
        JOIN auth_user_links l ON l.auth_user_id = s.user_id
        JOIN users u ON u.id = l.user_id
        WHERE s.id = ? AND s.user_id = ? AND s.expires_at = ?
          AND l.auth_user_id = ? AND l.user_id = ? AND l.provisioning_state = 'ready'
          AND u.status = 'active'
      )`, [sessionId, authUserId, row.expires_at, linkedAuthUserId, userId]);
      return Object.freeze({
        kind: 'current' as const,
        session: Object.freeze({
          sessionId,
          authUserId,
          userId,
          expiresAt,
          evidenceIds: Object.freeze([
            `auth-session:sha256:${await sha256Hex(`session\u0000${sessionId}`)}@${expiresAt}`,
            `auth-user-link:sha256:${await sha256Hex(`link\u0000${authUserId}\u0000${userId}`)}`
          ])
        })
      });
    }
  });
}

function createMembershipRepository(input: {
  readonly session: D1DatabaseSession;
  readonly unitOfWork?: D1BufferedUnitOfWork;
}): MembershipRepository {
  return Object.freeze({
    async find(workspaceId: WorkspaceId, userId: UserId) {
      const rows = resultRows(await input.session.prepare(`SELECT id,workspace_id,user_id,status,
        approved_by_user_id,approved_at,created_at,updated_at,version
        FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`)
        .bind(workspaceId, userId).all<MembershipEvidenceRow>());
      if (rows.length > 1) throw new TypeError('d1_membership_not_unique');
      const row = rows[0];
      if (!row) return undefined;
      input.unitOfWork?.assertCurrent(`EXISTS (SELECT 1 FROM workspace_memberships
        WHERE id = ? AND workspace_id = ? AND user_id = ? AND status = ?
          AND approved_by_user_id IS ? AND approved_at IS ? AND created_at = ?
          AND updated_at = ? AND version = ?)`, [
        row.id, row.workspace_id, row.user_id, row.status, row.approved_by_user_id,
        row.approved_at, row.created_at, row.updated_at, row.version
      ]);
      return membershipFromAccessEvidenceRow(row, workspaceId, userId);
    }
  });
}

function guardRoleRows(
  unitOfWork: D1BufferedUnitOfWork | undefined,
  workspaceId: WorkspaceId,
  rows: readonly RoleEvidenceRow[]
): void {
  assertRowCount(unitOfWork, `SELECT count(*) FROM roles r
    LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.workspace_id = ?`,
  [workspaceId], rows.length);
  for (const row of rows) unitOfWork?.assertCurrent(`EXISTS (
    SELECT 1 FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
    WHERE r.id = ? AND r.workspace_id = ? AND r.name = ? AND r.description = ?
      AND r.source_preset_key IS ? AND r.source_preset_version IS ?
      AND r.archived_at IS ? AND rp.permission_id IS ?
  )`, [
    row.id, row.workspace_id, row.name, row.description, row.source_preset_key,
    row.source_preset_version, row.archived_at, row.permission_id
  ]);
}

function createAuthorizationRepository(input: {
  readonly session: D1DatabaseSession;
  readonly unitOfWork?: D1BufferedUnitOfWork;
}): AuthorizationRepository {
  return Object.freeze({
    async listRoles(workspaceId: WorkspaceId) {
      const rows = resultRows(await input.session.prepare(`SELECT r.id,r.workspace_id,r.name,
        r.description,r.source_preset_key,r.source_preset_version,r.archived_at,rp.permission_id
        FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.workspace_id = ? ORDER BY r.id COLLATE BINARY,rp.permission_id COLLATE BINARY`)
        .bind(workspaceId).all<RoleEvidenceRow>());
      guardRoleRows(input.unitOfWork, workspaceId, rows);
      const groups = new Map<string, RoleEvidenceRow[]>();
      for (const row of rows) {
        const id = boundedText(row.id, 'roles.id');
        const group = groups.get(id);
        if (group) group.push(row);
        else groups.set(id, [row]);
      }
      return Object.freeze([...groups.values()].map((group) =>
        roleFromAccessEvidenceRows(group, workspaceId)
      ));
    },

    async listAssignments(workspaceId: WorkspaceId, userId: UserId) {
      const rows = resultRows(await input.session.prepare(`SELECT a.id,a.user_id,a.role_id,
        a.workspace_id,a.scope_kind,a.event_id,e.workspace_id AS event_workspace_id,
        r.workspace_id AS role_workspace_id,a.assigned_by_user_id,a.assigned_at,a.expires_at
        FROM role_assignments a JOIN roles r ON r.id = a.role_id
        LEFT JOIN events e ON e.id = a.event_id
        WHERE a.workspace_id = ? AND a.user_id = ? ORDER BY a.id COLLATE BINARY`)
        .bind(workspaceId, userId).all<AssignmentEvidenceRow>());
      assertRowCount(input.unitOfWork, `SELECT count(*) FROM role_assignments
        WHERE workspace_id = ? AND user_id = ?`, [workspaceId, userId], rows.length);
      for (const row of rows) input.unitOfWork?.assertCurrent(`EXISTS (
        SELECT 1 FROM role_assignments a JOIN roles r ON r.id = a.role_id
        LEFT JOIN events e ON e.id = a.event_id
        WHERE a.id = ? AND a.user_id = ? AND a.role_id = ? AND a.workspace_id = ?
          AND a.scope_kind = ? AND a.event_id IS ? AND e.workspace_id IS ?
          AND r.workspace_id = ? AND a.assigned_by_user_id IS ?
          AND a.assigned_at = ? AND a.expires_at IS ?
      )`, [
        row.id, row.user_id, row.role_id, row.workspace_id, row.scope_kind, row.event_id,
        row.event_workspace_id, row.role_workspace_id, row.assigned_by_user_id,
        row.assigned_at, row.expires_at
      ]);
      return Object.freeze(rows.map((row) =>
        assignmentFromAccessEvidenceRow(row, workspaceId, userId)
      ));
    },

    async listOverrides(workspaceId: WorkspaceId, userId: UserId) {
      const rows = resultRows(await input.session.prepare(`SELECT o.id,o.user_id,o.permission_id,
        o.effect,o.workspace_id,o.scope_kind,o.event_id,e.workspace_id AS event_workspace_id,
        o.reason,o.decided_by_user_id,o.decided_at,o.expires_at
        FROM permission_overrides o LEFT JOIN events e ON e.id = o.event_id
        WHERE o.workspace_id = ? AND o.user_id = ? ORDER BY o.id COLLATE BINARY`)
        .bind(workspaceId, userId).all<OverrideEvidenceRow>());
      assertRowCount(input.unitOfWork, `SELECT count(*) FROM permission_overrides
        WHERE workspace_id = ? AND user_id = ?`, [workspaceId, userId], rows.length);
      for (const row of rows) input.unitOfWork?.assertCurrent(`EXISTS (
        SELECT 1 FROM permission_overrides o LEFT JOIN events e ON e.id = o.event_id
        WHERE o.id = ? AND o.user_id = ? AND o.permission_id = ? AND o.effect = ?
          AND o.workspace_id = ? AND o.scope_kind = ? AND o.event_id IS ?
          AND e.workspace_id IS ? AND o.reason = ? AND o.decided_by_user_id IS ?
          AND o.decided_at = ? AND o.expires_at IS ?
      )`, [
        row.id, row.user_id, row.permission_id, row.effect, row.workspace_id,
        row.scope_kind, row.event_id, row.event_workspace_id, row.reason,
        row.decided_by_user_id, row.decided_at, row.expires_at
      ]);
      return Object.freeze(rows.map((row) =>
        overrideFromAccessEvidenceRow(row, workspaceId, userId)
      ));
    }
  });
}

function createScopeRelationships(input: {
  readonly session: D1DatabaseSession;
  readonly unitOfWork?: D1BufferedUnitOfWork;
  readonly workspaceId: WorkspaceId;
  readonly additionalSubjects?: D1OperatorSubjectRelationshipSource;
}): OperatorScopeRelationshipValidator {
  return Object.freeze({
    async validate(request: {
      readonly userId: UserId;
      readonly scope: ResolvedScope;
      readonly evaluatedAt: Instant;
    }) {
      const userId = parseUserId(request.userId);
      const evaluatedAt = parseInstant(request.evaluatedAt);
      if (request.scope.workspaceId !== input.workspaceId) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
      const workspace = await input.session.prepare(
        'SELECT id,state FROM workspaces WHERE id = ?'
      ).bind(input.workspaceId).first<WorkspaceRow>();
      if (!workspace) return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      if (workspace.id !== input.workspaceId) throw new TypeError('d1_workspace_scope_mismatch');
      if (workspace.state !== 'active') {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }
      input.unitOfWork?.assertCurrent(
        'EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND state = ?)',
        [input.workspaceId, workspace.state]
      );
      const evidenceIds: string[] = [`workspace-root:${input.workspaceId}`];
      let eventId: EventId | undefined;
      if (request.scope.eventId !== undefined) {
        eventId = parseEventId(request.scope.eventId);
        const eventRoot = await input.session.prepare(`SELECT workspace_id,id
          FROM event_spine_heads WHERE workspace_id = ? AND id = ?`)
          .bind(input.workspaceId, eventId).first<{ workspace_id: string; id: string }>();
        if (!eventRoot) return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
        input.unitOfWork?.assertCurrent(`EXISTS (SELECT 1 FROM event_spine_heads
          WHERE workspace_id = ? AND id = ?)`, [input.workspaceId, eventId]);
        evidenceIds.push(`event-root:${eventId}`);
      }
      for (const subject of request.scope.subjects) {
        if (subject.kind === 'workspace') {
          if (subject.id !== input.workspaceId) {
            return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
          }
          evidenceIds.push(`workspace-subject:${subject.id}`);
        } else if (subject.kind === 'event') {
          if (eventId === undefined || subject.id !== eventId) {
            return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
          }
          evidenceIds.push(`event-subject:${subject.id}`);
        } else if (subject.kind === 'workspace_user') {
          const relationship = await input.session.prepare(`SELECT id,workspace_id,user_id
            FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`)
            .bind(input.workspaceId, subject.id).first<RelationshipRow>();
          if (!relationship) {
            return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
          }
          input.unitOfWork?.assertCurrent(`EXISTS (SELECT 1 FROM workspace_memberships
            WHERE id = ? AND workspace_id = ? AND user_id = ?)`, [
            relationship.id, relationship.workspace_id, relationship.user_id
          ]);
          evidenceIds.push(`workspace-user-subject:${relationship.id}`);
        } else {
          if (!input.additionalSubjects) {
            return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
          }
          const resolved = await input.additionalSubjects.validateSubject({
            session: input.session,
            ...(input.unitOfWork ? { unitOfWork: input.unitOfWork } : {}),
            workspaceId: input.workspaceId,
            ...(eventId ? { eventId } : {}),
            userId,
            subject,
            evaluatedAt
          });
          if (resolved.kind === 'denied') return resolved;
          evidenceIds.push(...resolved.evidenceIds);
        }
      }
      return Object.freeze({ kind: 'valid' as const, evidenceIds: Object.freeze(evidenceIds) });
    }
  });
}

/** Builds the existing application authority resolver over one D1 session view. */
export function createD1OperatorCurrentAuthorityResolver(input: {
  readonly session: D1DatabaseSession;
  readonly unitOfWork?: D1BufferedUnitOfWork;
  readonly workspaceId: WorkspaceId;
  readonly policies: OperatorAuthorityPolicyCatalog;
  readonly additionalSubjects?: D1OperatorSubjectRelationshipSource;
}) {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const common = {
    session: input.session,
    ...(input.unitOfWork ? { unitOfWork: input.unitOfWork } : {})
  };
  return createOperatorCurrentAuthorityResolver({
    workspaceId,
    policies: input.policies,
    sessions: createCurrentSessionRepository(common),
    memberships: createMembershipRepository(common),
    authorization: createAuthorizationRepository(common),
    scopeRelationships: createScopeRelationships({
      ...common,
      workspaceId,
      ...(input.additionalSubjects ? { additionalSubjects: input.additionalSubjects } : {})
    })
  });
}
