import type { Database } from 'bun:sqlite';
import {
  compareAuthoritySubject,
  REVIEWER_CAPABILITY_IDS,
  type ReviewerAuthoritySetDto,
  type ReviewerAuthoritySubjectRefDto,
  type ReviewerEligibilityFactDto,
  type ReviewerRosterScopeDto
} from '@jooevents/contracts/reviewer-roster';
import {
  evaluateAccess,
  PERMISSIONS,
  type AccessScope,
  type PermissionId,
  type PermissionOverride,
  type Role,
  type RoleAssignment,
  type WorkspaceMembership
} from '@jooevents/identity-access';
import { isApplicationId, parseInstant } from '@jooevents/kernel';
import {
  parseReviewerAuthoritySet,
  parseReviewerRosterScope,
  reviewerAuthorityFactDigest,
  reviewerAuthoritySetDigest,
  type ReviewerAuthoritySource
} from '@jooevents/review/roster';

type EligibleReviewerFact = Extract<
  ReviewerEligibilityFactDto,
  { readonly state: 'reserved' | 'active' }
>;

type SQLiteValue = string | number | bigint | Uint8Array | null;

const permissionIds = new Set<string>(PERMISSIONS.map((permission) => permission.id));
const membershipStatuses = new Set<WorkspaceMembership['status']>([
  'invited',
  'pending_review',
  'active',
  'suspended',
  'deactivated'
]);
const reservationStatuses = new Set(['open', 'consumed', 'revoked', 'expired']);

export class SQLiteReviewerAuthorityEvidenceError extends Error {
  readonly code = 'malformed_reviewer_authority_evidence';

  constructor(message: string) {
    super(message);
    this.name = 'SQLiteReviewerAuthorityEvidenceError';
  }
}

interface EventRow {
  readonly id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
}

interface MembershipRow {
  readonly id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly user_id: SQLiteValue;
  readonly status: SQLiteValue;
  readonly created_at: SQLiteValue;
  readonly updated_at: SQLiteValue;
  readonly version: SQLiteValue;
  readonly user_display_name: SQLiteValue;
}

interface ReservationRow {
  readonly id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly status: SQLiteValue;
  readonly expires_at: SQLiteValue;
  readonly consumed_by_user_id: SQLiteValue;
  readonly created_at: SQLiteValue;
  readonly version: SQLiteValue;
}

interface RoleRow {
  readonly id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly name: SQLiteValue;
  readonly description: SQLiteValue;
  readonly archived_at: SQLiteValue;
  readonly permission_id: SQLiteValue;
}

interface GrantScopeRow {
  readonly scope_kind: SQLiteValue;
  readonly event_id: SQLiteValue;
  readonly event_workspace_id: SQLiteValue;
}

interface AssignmentRow extends GrantScopeRow {
  readonly id: SQLiteValue;
  readonly user_id: SQLiteValue;
  readonly role_id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly role_workspace_id: SQLiteValue;
  readonly assigned_at: SQLiteValue;
  readonly expires_at: SQLiteValue;
}

interface OverrideRow extends GrantScopeRow {
  readonly id: SQLiteValue;
  readonly user_id: SQLiteValue;
  readonly permission_id: SQLiteValue;
  readonly effect: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly reason: SQLiteValue;
  readonly decided_at: SQLiteValue;
  readonly expires_at: SQLiteValue;
}

interface ReservedAssignmentRow extends GrantScopeRow {
  readonly id: SQLiteValue;
  readonly role_id: SQLiteValue;
}

interface ReservedOverrideRow extends GrantScopeRow {
  readonly id: SQLiteValue;
  readonly permission_id: SQLiteValue;
  readonly effect: SQLiteValue;
  readonly reason: SQLiteValue;
}

interface MembershipAuthority {
  readonly membershipId: string;
  readonly membershipVersion: number;
  readonly eligible: boolean;
  readonly evidenceIds: readonly string[];
  readonly displayName: string | undefined;
}

function malformed(message: string): never {
  throw new SQLiteReviewerAuthorityEvidenceError(message);
}

function requiredText(value: SQLiteValue, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    malformed(`${field} must be a non-empty string.`);
  }
  return value;
}

function text(value: SQLiteValue, field: string): string {
  if (typeof value !== 'string') malformed(`${field} must be a string.`);
  return value;
}

function nonNegativeInteger(value: SQLiteValue, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value: SQLiteValue, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) malformed(`${field} must be positive.`);
  return parsed;
}

function instant(value: SQLiteValue, field: string): string {
  const milliseconds = nonNegativeInteger(value, field);
  const result = new Date(milliseconds);
  if (!Number.isFinite(result.getTime())) {
    malformed(`${field} is outside the supported instant range.`);
  }
  return result.toISOString();
}

function optionalInstant(value: SQLiteValue, field: string): string | undefined {
  return value === null ? undefined : instant(value, field);
}

function permissionId(value: SQLiteValue, field: string): PermissionId {
  const id = requiredText(value, field);
  if (!permissionIds.has(id)) malformed(`${field} is not in the deployed permission catalog.`);
  return id as PermissionId;
}

function subjectId(value: string, field: string): ReviewerAuthoritySubjectRefDto['id'] {
  if (!isApplicationId(value)) malformed(`${field} must be a canonical application id.`);
  return value;
}

function accessScope(input: {
  readonly workspaceId: string;
  readonly scopeKind: SQLiteValue;
  readonly eventId: SQLiteValue;
  readonly eventWorkspaceId: SQLiteValue;
  readonly field: string;
}): AccessScope {
  if (input.scopeKind === 'workspace') {
    if (input.eventId !== null || input.eventWorkspaceId !== null) {
      malformed(`${input.field} workspace scope carries event evidence.`);
    }
    return Object.freeze({ kind: 'workspace', workspaceId: input.workspaceId });
  }
  if (input.scopeKind !== 'event') malformed(`${input.field} has an unknown scope kind.`);
  const eventId = requiredText(input.eventId, `${input.field}.event_id`);
  if (requiredText(input.eventWorkspaceId, `${input.field}.event_workspace_id`) !== input.workspaceId) {
    malformed(`${input.field} event does not belong to its declared workspace.`);
  }
  return Object.freeze({ kind: 'event', workspaceId: input.workspaceId, eventId });
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now);
}

function eligibleCapabilityIds(): EligibleReviewerFact['capabilityIds'] {
  return [...REVIEWER_CAPABILITY_IDS] as EligibleReviewerFact['capabilityIds'];
}

/** Canonical, bounded evidence-id list: unique, ascending, disclosure-free. */
function canonicalEvidenceIds(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort().slice(0, 100);
}

/** Display names are presentation, not authority evidence: schema-legal but unreleasable values (empty, untrimmed, over-length) read as absent. */
function releasableDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value === value.trim() && value.length >= 1 && value.length <= 160 ? value : undefined;
}

/**
 * Synchronous reviewer-authority facts over the durable identity/access
 * evidence tables. Facts are keyed by exact access-subject refs — workspace
 * memberships and access reservations — never by email; the emitted set
 * discloses no addresses and no role names. Eligibility means the complete
 * reviewer capability tuple evaluates as granted at the requested event scope
 * through the sole `evaluateAccess` policy; subjects without the full tuple are
 * omitted, which downstream projections surface as unavailable authority.
 *
 * Reservation lifecycle: an open, unexpired reservation whose reserved grants
 * produce the full tuple emits a `reserved` fact keyed by the reservation. A
 * consumed reservation keeps emitting under its original reservation ref — as
 * an `active` fact whose current subject is the admitted user's workspace
 * membership — so rosters registered against an invitation survive admission.
 *
 * Versions: each fact carries its current subject's persisted row version, and
 * the set version is a deterministic aggregate counter over the workspace's
 * versioned access-evidence rows (row counts plus row-version sums), so both
 * stay small enough for downstream version pairing. The set and per-fact
 * digests remain the byte-exact drift authority for guard validation.
 */
export class SQLiteReviewerAuthoritySource implements ReviewerAuthoritySource {
  constructor(
    private readonly sqlite: Database,
    private readonly now: () => string
  ) {}

  readReviewerAuthority(scopeValue: ReviewerRosterScopeDto): ReviewerAuthoritySetDto | undefined {
    const scope = parseReviewerRosterScope(scopeValue);
    const events = this.sqlite.query<EventRow, [string, string]>(`
      select id, workspace_id from events
       where id = ? and workspace_id = ?
       limit 2
    `).all(scope.eventId, scope.workspaceId);
    if (events.length === 0) return undefined;
    if (events.length > 1
        || requiredText(events[0]!.id, 'events.id') !== scope.eventId
        || requiredText(events[0]!.workspace_id, 'events.workspace_id') !== scope.workspaceId) {
      malformed('Event lookup returned evidence outside the requested scope.');
    }
    const now = parseInstant(this.now());
    const requestedScope: AccessScope = Object.freeze({
      kind: 'event',
      workspaceId: scope.workspaceId,
      eventId: scope.eventId
    });
    const roles = this.listRoles(scope.workspaceId);
    const membershipAuthorityByUserId = this.evaluateMemberships({
      workspaceId: scope.workspaceId,
      requestedScope,
      roles,
      now
    });
    const facts: ReviewerEligibilityFactDto[] = [];
    for (const authority of membershipAuthorityByUserId.values()) {
      if (!authority.eligible) continue;
      const subject: ReviewerAuthoritySubjectRefDto = {
        kind: 'workspace_membership',
        id: subjectId(authority.membershipId, 'workspace_memberships.id'),
        version: authority.membershipVersion
      };
      facts.push(eligibleFact({
        scope,
        rosterSubject: subject,
        currentSubject: subject,
        state: 'active',
        version: authority.membershipVersion,
        evidenceIds: canonicalEvidenceIds([
          membershipEvidenceId(authority),
          ...authority.evidenceIds
        ]),
        displayName: authority.displayName
      }));
    }
    this.appendReservationFacts({
      scope,
      requestedScope,
      roles,
      now,
      membershipAuthorityByUserId,
      facts
    });
    facts.sort((left, right) => compareAuthoritySubject(left.rosterSubject, right.rosterSubject));
    const unsigned = {
      schemaVersion: 1 as const,
      scope,
      version: this.setVersion(scope.workspaceId),
      facts
    };
    return parseReviewerAuthoritySet({
      ...unsigned,
      digestSha256: reviewerAuthoritySetDigest(unsigned)
    });
  }

  private evaluateMemberships(input: {
    readonly workspaceId: string;
    readonly requestedScope: AccessScope;
    readonly roles: readonly Role[];
    readonly now: string;
  }): ReadonlyMap<string, MembershipAuthority> {
    const rows = this.sqlite.query<MembershipRow, [string]>(`
      select m.id, m.workspace_id, m.user_id, m.status, m.created_at, m.updated_at,
             m.version, u.display_name as user_display_name
        from workspace_memberships m
        left join users u on u.id = m.user_id
       where m.workspace_id = ?
       order by m.id collate binary asc
    `).all(input.workspaceId);
    const byUserId = new Map<string, MembershipAuthority>();
    for (const row of rows) {
      const userId = requiredText(row.user_id, 'workspace_memberships.user_id');
      if (byUserId.has(userId)) malformed('Membership evidence is not unique per user.');
      const status = requiredText(row.status, 'workspace_memberships.status');
      if (!membershipStatuses.has(status as WorkspaceMembership['status'])) {
        malformed('workspace_memberships.status is unknown.');
      }
      const version = positiveInteger(row.version, 'workspace_memberships.version');
      const membership: WorkspaceMembership = Object.freeze({
        id: requiredText(row.id, 'workspace_memberships.id'),
        workspaceId: requiredText(row.workspace_id, 'workspace_memberships.workspace_id'),
        userId,
        status: status as WorkspaceMembership['status'],
        createdAt: instant(row.created_at, 'workspace_memberships.created_at'),
        updatedAt: instant(row.updated_at, 'workspace_memberships.updated_at'),
        version
      });
      const evaluation = this.evaluateCapabilities({
        userId,
        membership,
        roles: input.roles,
        assignments: this.listAssignments(input.workspaceId, userId),
        overrides: this.listOverrides(input.workspaceId, userId),
        requestedScope: input.requestedScope,
        now: input.now
      });
      byUserId.set(userId, Object.freeze({
        membershipId: membership.id,
        membershipVersion: version,
        eligible: evaluation.eligible,
        evidenceIds: evaluation.evidenceIds,
        displayName: releasableDisplayName(
          text(row.user_display_name, 'users.display_name')
        )
      }));
    }
    return byUserId;
  }

  private appendReservationFacts(input: {
    readonly scope: ReviewerRosterScopeDto;
    readonly requestedScope: AccessScope;
    readonly roles: readonly Role[];
    readonly now: string;
    readonly membershipAuthorityByUserId: ReadonlyMap<string, MembershipAuthority>;
    readonly facts: ReviewerEligibilityFactDto[];
  }): void {
    const rows = this.sqlite.query<ReservationRow, [string]>(`
      select id, workspace_id, status, expires_at, consumed_by_user_id, created_at, version
        from access_reservations
       where workspace_id = ?
       order by id collate binary asc
    `).all(input.scope.workspaceId);
    for (const row of rows) {
      const reservation = Object.freeze({
        id: requiredText(row.id, 'access_reservations.id'),
        status: requiredText(row.status, 'access_reservations.status'),
        expiresAt: optionalInstant(row.expires_at, 'access_reservations.expires_at'),
        consumedByUserId: row.consumed_by_user_id === null
          ? undefined
          : requiredText(row.consumed_by_user_id, 'access_reservations.consumed_by_user_id'),
        createdAt: instant(row.created_at, 'access_reservations.created_at'),
        version: positiveInteger(row.version, 'access_reservations.version')
      });
      if (!reservationStatuses.has(reservation.status)) {
        malformed('access_reservations.status is unknown.');
      }
      const subject: ReviewerAuthoritySubjectRefDto = {
        kind: 'access_reservation',
        id: subjectId(reservation.id, 'access_reservations.id'),
        version: reservation.version
      };
      if (reservation.status === 'open' && !isExpired(reservation.expiresAt, input.now)) {
        const evaluation = this.evaluateReservedCapabilities({
          reservation,
          workspaceId: input.scope.workspaceId,
          requestedScope: input.requestedScope,
          roles: input.roles,
          now: input.now
        });
        if (!evaluation.eligible) continue;
        input.facts.push(eligibleFact({
          scope: input.scope,
          rosterSubject: subject,
          currentSubject: subject,
          state: 'reserved',
          version: reservation.version,
          evidenceIds: canonicalEvidenceIds([
            reservationEvidenceId(reservation),
            ...evaluation.evidenceIds
          ]),
          displayName: undefined
        }));
        continue;
      }
      if (reservation.status !== 'consumed' || reservation.consumedByUserId === undefined) continue;
      const authority = input.membershipAuthorityByUserId.get(reservation.consumedByUserId);
      if (!authority?.eligible) continue;
      input.facts.push(eligibleFact({
        scope: input.scope,
        rosterSubject: subject,
        currentSubject: {
          kind: 'workspace_membership',
          id: subjectId(authority.membershipId, 'workspace_memberships.id'),
          version: authority.membershipVersion
        },
        state: 'active',
        version: authority.membershipVersion,
        evidenceIds: canonicalEvidenceIds([
          reservationEvidenceId(reservation),
          membershipEvidenceId(authority),
          ...authority.evidenceIds
        ]),
        displayName: authority.displayName
      }));
    }
  }

  private evaluateCapabilities(input: {
    readonly userId: string;
    readonly membership: WorkspaceMembership;
    readonly roles: readonly Role[];
    readonly assignments: readonly RoleAssignment[];
    readonly overrides: readonly PermissionOverride[];
    readonly requestedScope: AccessScope;
    readonly now: string;
  }): { readonly eligible: boolean; readonly evidenceIds: readonly string[] } {
    const evidenceIds: string[] = [];
    for (const capability of REVIEWER_CAPABILITY_IDS) {
      const decision = evaluateAccess({
        userId: input.userId,
        permissionId: capability,
        requestedScope: input.requestedScope,
        membership: input.membership,
        roles: input.roles,
        assignments: input.assignments,
        overrides: input.overrides,
        now: input.now
      });
      if (!decision.allowed) return { eligible: false, evidenceIds: Object.freeze([]) };
      for (const evidence of decision.evidence) {
        if (evidence.effect === 'grant') evidenceIds.push(`${evidence.kind}:${evidence.id}`);
      }
    }
    return { eligible: true, evidenceIds: Object.freeze(evidenceIds) };
  }

  private evaluateReservedCapabilities(input: {
    readonly reservation: {
      readonly id: string;
      readonly createdAt: string;
      readonly version: number;
    };
    readonly workspaceId: string;
    readonly requestedScope: AccessScope;
    readonly roles: readonly Role[];
    readonly now: string;
  }): { readonly eligible: boolean; readonly evidenceIds: readonly string[] } {
    // The reservation is evaluated as the principal it would admit: the sole
    // policy algorithm runs over the reserved grants with the reservation id
    // standing in for the not-yet-admitted user.
    const principal = input.reservation.id;
    const membership: WorkspaceMembership = Object.freeze({
      id: input.reservation.id,
      workspaceId: input.workspaceId,
      userId: principal,
      status: 'active',
      createdAt: input.reservation.createdAt,
      updatedAt: input.reservation.createdAt,
      version: input.reservation.version
    });
    return this.evaluateCapabilities({
      userId: principal,
      membership,
      roles: input.roles,
      assignments: this.listReservedAssignments({
        reservationId: input.reservation.id,
        workspaceId: input.workspaceId,
        principal,
        assignedAt: input.reservation.createdAt
      }),
      overrides: this.listReservedOverrides({
        reservationId: input.reservation.id,
        workspaceId: input.workspaceId,
        principal,
        decidedAt: input.reservation.createdAt
      }),
      requestedScope: input.requestedScope,
      now: input.now
    });
  }

  private listRoles(workspaceId: string): readonly Role[] {
    const rows = this.sqlite.query<RoleRow, [string]>(`
      select r.id, r.workspace_id, r.name, r.description, r.archived_at, rp.permission_id
        from roles r
        left join role_permissions rp on rp.role_id = r.id
       where r.workspace_id = ?
       order by r.id collate binary asc, rp.permission_id collate binary asc
    `).all(workspaceId);
    const groups = new Map<string, RoleRow[]>();
    for (const row of rows) {
      const id = requiredText(row.id, 'roles.id');
      const group = groups.get(id);
      if (group) group.push(row);
      else groups.set(id, [row]);
    }
    return Object.freeze([...groups.values()].map((group) => {
      const first = group[0]!;
      const id = requiredText(first.id, 'roles.id');
      if (requiredText(first.workspace_id, 'roles.workspace_id') !== workspaceId) {
        malformed('Role lookup crossed workspace scope.');
      }
      const permissions: PermissionId[] = [];
      for (const row of group) {
        if (row.permission_id !== null) {
          permissions.push(permissionId(row.permission_id, 'role_permissions.permission_id'));
        }
      }
      return Object.freeze({
        id,
        workspaceId,
        name: requiredText(first.name, 'roles.name'),
        description: text(first.description, 'roles.description'),
        permissionIds: Object.freeze(permissions),
        ...(optionalInstant(first.archived_at, 'roles.archived_at') === undefined
          ? {}
          : { archivedAt: instant(first.archived_at, 'roles.archived_at') })
      });
    }));
  }

  private listAssignments(workspaceId: string, userId: string): readonly RoleAssignment[] {
    const rows = this.sqlite.query<AssignmentRow, [string, string]>(`
      select a.id, a.user_id, a.role_id, a.workspace_id, a.scope_kind, a.event_id,
             e.workspace_id as event_workspace_id, r.workspace_id as role_workspace_id,
             a.assigned_at, a.expires_at
        from role_assignments a
        join roles r on r.id = a.role_id
        left join events e on e.id = a.event_id
       where a.workspace_id = ? and a.user_id = ?
       order by a.id collate binary asc
    `).all(workspaceId, userId);
    return Object.freeze(rows.map((row) => {
      if (requiredText(row.user_id, 'role_assignments.user_id') !== userId
          || requiredText(row.workspace_id, 'role_assignments.workspace_id') !== workspaceId
          || requiredText(row.role_workspace_id, 'roles.workspace_id') !== workspaceId) {
        malformed('Role-assignment lookup returned evidence outside the requested principal.');
      }
      const expiresAt = optionalInstant(row.expires_at, 'role_assignments.expires_at');
      return Object.freeze({
        id: requiredText(row.id, 'role_assignments.id'),
        userId,
        roleId: requiredText(row.role_id, 'role_assignments.role_id'),
        scope: accessScope({
          workspaceId,
          scopeKind: row.scope_kind,
          eventId: row.event_id,
          eventWorkspaceId: row.event_workspace_id,
          field: 'role_assignments.scope'
        }),
        assignedAt: instant(row.assigned_at, 'role_assignments.assigned_at'),
        ...(expiresAt === undefined ? {} : { expiresAt })
      });
    }));
  }

  private listOverrides(workspaceId: string, userId: string): readonly PermissionOverride[] {
    const rows = this.sqlite.query<OverrideRow, [string, string]>(`
      select o.id, o.user_id, o.permission_id, o.effect, o.workspace_id,
             o.scope_kind, o.event_id, e.workspace_id as event_workspace_id,
             o.reason, o.decided_at, o.expires_at
        from permission_overrides o
        left join events e on e.id = o.event_id
       where o.workspace_id = ? and o.user_id = ?
       order by o.id collate binary asc
    `).all(workspaceId, userId);
    return Object.freeze(rows.map((row) => {
      if (requiredText(row.user_id, 'permission_overrides.user_id') !== userId
          || requiredText(row.workspace_id, 'permission_overrides.workspace_id') !== workspaceId) {
        malformed('Permission-override lookup returned evidence outside the requested principal.');
      }
      if (row.effect !== 'grant' && row.effect !== 'deny') {
        malformed('permission_overrides.effect is unknown.');
      }
      const expiresAt = optionalInstant(row.expires_at, 'permission_overrides.expires_at');
      return Object.freeze({
        id: requiredText(row.id, 'permission_overrides.id'),
        userId,
        permissionId: permissionId(row.permission_id, 'permission_overrides.permission_id'),
        effect: row.effect,
        scope: accessScope({
          workspaceId,
          scopeKind: row.scope_kind,
          eventId: row.event_id,
          eventWorkspaceId: row.event_workspace_id,
          field: 'permission_overrides.scope'
        }),
        reason: requiredText(row.reason, 'permission_overrides.reason'),
        decidedAt: instant(row.decided_at, 'permission_overrides.decided_at'),
        ...(expiresAt === undefined ? {} : { expiresAt })
      });
    }));
  }

  private listReservedAssignments(input: {
    readonly reservationId: string;
    readonly workspaceId: string;
    readonly principal: string;
    readonly assignedAt: string;
  }): readonly RoleAssignment[] {
    const rows = this.sqlite.query<ReservedAssignmentRow, [string]>(`
      select a.id, a.role_id, a.scope_kind, a.event_id,
             e.workspace_id as event_workspace_id
        from reservation_role_assignments a
        left join events e on e.id = a.event_id
       where a.reservation_id = ?
       order by a.id collate binary asc
    `).all(input.reservationId);
    return Object.freeze(rows.map((row) => Object.freeze({
      id: requiredText(row.id, 'reservation_role_assignments.id'),
      userId: input.principal,
      roleId: requiredText(row.role_id, 'reservation_role_assignments.role_id'),
      scope: accessScope({
        workspaceId: input.workspaceId,
        scopeKind: row.scope_kind,
        eventId: row.event_id,
        eventWorkspaceId: row.event_workspace_id,
        field: 'reservation_role_assignments.scope'
      }),
      assignedAt: input.assignedAt
    })));
  }

  private listReservedOverrides(input: {
    readonly reservationId: string;
    readonly workspaceId: string;
    readonly principal: string;
    readonly decidedAt: string;
  }): readonly PermissionOverride[] {
    const rows = this.sqlite.query<ReservedOverrideRow, [string]>(`
      select o.id, o.permission_id, o.effect, o.scope_kind, o.event_id,
             e.workspace_id as event_workspace_id, o.reason
        from reservation_permission_overrides o
        left join events e on e.id = o.event_id
       where o.reservation_id = ?
       order by o.id collate binary asc
    `).all(input.reservationId);
    return Object.freeze(rows.map((row) => {
      if (row.effect !== 'grant' && row.effect !== 'deny') {
        malformed('reservation_permission_overrides.effect is unknown.');
      }
      return Object.freeze({
        id: requiredText(row.id, 'reservation_permission_overrides.id'),
        userId: input.principal,
        permissionId: permissionId(
          row.permission_id,
          'reservation_permission_overrides.permission_id'
        ),
        effect: row.effect,
        scope: accessScope({
          workspaceId: input.workspaceId,
          scopeKind: row.scope_kind,
          eventId: row.event_id,
          eventWorkspaceId: row.event_workspace_id,
          field: 'reservation_permission_overrides.scope'
        }),
        reason: requiredText(row.reason, 'reservation_permission_overrides.reason'),
        decidedAt: input.decidedAt
      });
    }));
  }

  /**
   * Deterministic aggregate counter over the workspace's versioned access
   * evidence. It moves with every row insert and row-version bump; byte-exact
   * drift detection remains the digest's responsibility.
   */
  private setVersion(workspaceId: string): number {
    const row = this.sqlite.query<{ readonly version: SQLiteValue }, [
      string, string, string, string, string, string, string, string, string
    ]>(`
      select 1
        + (select count(*) + coalesce(sum(version), 0) from workspace_memberships where workspace_id = ?)
        + (select count(*) + coalesce(sum(version), 0) from access_reservations where workspace_id = ?)
        + (select count(*) + coalesce(sum(version), 0) from roles where workspace_id = ?)
        + (select count(*) + coalesce(sum(version), 0) from role_assignments where workspace_id = ?)
        + (select count(*) + coalesce(sum(version), 0) from permission_overrides where workspace_id = ?)
        + (select count(*) + coalesce(sum(u.version), 0) from users u
            where u.id in (select user_id from workspace_memberships where workspace_id = ?))
        + (select count(*) from role_permissions
            where role_id in (select id from roles where workspace_id = ?))
        + (select count(*) from reservation_role_assignments
            where reservation_id in (select id from access_reservations where workspace_id = ?))
        + (select count(*) from reservation_permission_overrides
            where reservation_id in (select id from access_reservations where workspace_id = ?))
        as version
    `).get(
      workspaceId, workspaceId, workspaceId, workspaceId, workspaceId,
      workspaceId, workspaceId, workspaceId, workspaceId
    );
    if (!row) malformed('Authority set version aggregate is missing.');
    return positiveInteger(row.version, 'reviewer_authority_set.version');
  }
}

function membershipEvidenceId(authority: {
  readonly membershipId: string;
  readonly membershipVersion: number;
}): string {
  return `workspace_membership:${authority.membershipId}:v${authority.membershipVersion}`;
}

function reservationEvidenceId(reservation: {
  readonly id: string;
  readonly version: number;
}): string {
  return `access_reservation:${reservation.id}:v${reservation.version}`;
}

function eligibleFact(input: {
  readonly scope: ReviewerRosterScopeDto;
  readonly rosterSubject: ReviewerAuthoritySubjectRefDto;
  readonly currentSubject: ReviewerAuthoritySubjectRefDto;
  readonly state: 'reserved' | 'active';
  readonly version: number;
  readonly evidenceIds: readonly string[];
  readonly displayName: string | undefined;
}): EligibleReviewerFact {
  const unsigned = {
    schemaVersion: 1 as const,
    scope: input.scope,
    rosterSubject: input.rosterSubject,
    currentSubject: input.currentSubject,
    state: input.state,
    version: input.version,
    capabilityIds: eligibleCapabilityIds(),
    evidenceIds: [...input.evidenceIds],
    ...(input.displayName === undefined ? {} : { displayName: input.displayName })
  };
  return { ...unsigned, digestSha256: reviewerAuthorityFactDigest(unsigned) };
}
