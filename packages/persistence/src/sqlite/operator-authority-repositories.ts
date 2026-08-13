import type { Database } from 'bun:sqlite';
import {
  createSQLiteAccessRepositories,
  type SQLiteAccessRepositories
} from './access-repositories';
import { sha256Hex } from './migration-artifact';
import type {
  CurrentOperatorSessionRepository,
  OperatorScopeRelationshipValidator
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

type SQLiteValue = string | number | bigint | Uint8Array | null;

interface OperatorSessionRow {
  readonly session_id: SQLiteValue;
  readonly auth_user_id: SQLiteValue;
  readonly expires_at: SQLiteValue;
  readonly link_auth_user_id: SQLiteValue;
  readonly user_id: SQLiteValue;
  readonly provisioning_state: SQLiteValue;
  readonly user_status: SQLiteValue;
}

interface WorkspaceRow {
  readonly id: SQLiteValue;
  readonly state: SQLiteValue;
}

interface MembershipRelationshipRow {
  readonly id: SQLiteValue;
  readonly workspace_id: SQLiteValue;
  readonly user_id: SQLiteValue;
}

export type SQLiteOperatorRelationshipResolution =
  | { readonly kind: 'valid'; readonly evidenceIds: readonly string[] }
  | { readonly kind: 'denied'; readonly reason: 'missing' | 'revoked' | 'cross_scope' };

export interface SQLiteOperatorEventRelationshipSource {
  validateEvent(input: {
    /** The exact connection used by every other authority read and the active UoW. */
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventId: EventId;
    readonly userId: UserId;
    readonly evaluatedAt: Instant;
  }): SQLiteOperatorRelationshipResolution;
}

export interface SQLiteOperatorSubjectRelationshipSource {
  validateSubject(input: {
    /** The exact connection used by every other authority read and the active UoW. */
    readonly sqlite: Database;
    readonly workspaceId: WorkspaceId;
    readonly eventId?: EventId;
    readonly userId: UserId;
    readonly subject: Extract<SubjectRef, { readonly kind: 'participant_person' | 'domain' }>;
    readonly evaluatedAt: Instant;
  }): SQLiteOperatorRelationshipResolution;
}

export class SQLiteOperatorAuthorityEvidenceError extends Error {
  readonly code = 'malformed_operator_authority_evidence';

  constructor(message: string) {
    super(message);
    this.name = 'SQLiteOperatorAuthorityEvidenceError';
  }
}

export class SQLiteOperatorAuthorityTransactionError extends Error {
  readonly code = 'operator_authority_transaction_required';

  constructor() {
    super('Transaction-bound operator authority must resolve inside an active SQLite transaction.');
    this.name = 'SQLiteOperatorAuthorityTransactionError';
  }
}

function assertActiveTransaction(sqlite: Database): void {
  if (!sqlite.inTransaction) throw new SQLiteOperatorAuthorityTransactionError();
}

function malformed(message: string): never {
  throw new SQLiteOperatorAuthorityEvidenceError(message);
}

function boundedText(value: SQLiteValue, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    malformed(`${field} must be a bounded non-empty string.`);
  }
  return value;
}

function epochMilliseconds(value: SQLiteValue, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(`${field} must be a non-negative epoch-millisecond integer.`);
  }
  return value;
}

function canonicalInstant(value: SQLiteValue, field: string): Instant {
  const parsed = new Date(epochMilliseconds(value, field));
  if (!Number.isFinite(parsed.getTime())) malformed(`${field} is outside the supported instant range.`);
  return parseInstant(parsed.toISOString());
}

function sessionHandle(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new TypeError('Operator session handle must be a bounded non-empty string.');
  }
  return value;
}

/**
 * Resolves a verified Better Auth session record ID through the ready application
 * link. The credential token column is neither selected nor returned.
 */
export function createSQLiteCurrentOperatorSessionRepository(
  sqlite: Database
): CurrentOperatorSessionRepository {
  return Object.freeze({
    resolveCurrent(input: { readonly sessionHandle: string; readonly evaluatedAt: Instant }) {
      const handle = sessionHandle(input.sessionHandle);
      const evaluatedAt = parseInstant(input.evaluatedAt);
      const rows = sqlite.query<OperatorSessionRow, [string]>(`
        select s.id as session_id,
               s.user_id as auth_user_id,
               s.expires_at,
               l.auth_user_id as link_auth_user_id,
               l.user_id,
               l.provisioning_state,
               u.status as user_status
          from auth_sessions s
          left join auth_user_links l on l.auth_user_id = s.user_id
          left join users u on u.id = l.user_id
         where s.id = ?
         limit 2
      `).all(handle);
      if (rows.length > 1) malformed('Operator session record identity is not unique.');
      const row = rows[0];
      if (!row) return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });

      const sessionId = boundedText(row.session_id, 'auth_sessions.id');
      const authUserId = boundedText(row.auth_user_id, 'auth_sessions.user_id');
      if (sessionId !== handle) malformed('Operator session lookup returned another record.');
      const expiresAt = canonicalInstant(row.expires_at, 'auth_sessions.expires_at');
      if (Date.parse(expiresAt) <= Date.parse(evaluatedAt)) {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }

      if (row.link_auth_user_id === null || row.user_id === null || row.provisioning_state === null) {
        return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      }
      const linkedAuthUserId = boundedText(
        row.link_auth_user_id,
        'auth_user_links.auth_user_id'
      );
      if (linkedAuthUserId !== authUserId) {
        malformed('Operator session and application-user link disagree.');
      }
      const provisioningState = boundedText(
        row.provisioning_state,
        'auth_user_links.provisioning_state'
      );
      if (!['pending', 'ready', 'failed'].includes(provisioningState)) {
        malformed('auth_user_links.provisioning_state is unknown.');
      }
      if (provisioningState !== 'ready') {
        return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      }
      const userId = parseUserId(boundedText(row.user_id, 'auth_user_links.user_id'));
      const userStatus = boundedText(row.user_status, 'users.status');
      if (!['pending_review', 'active', 'suspended', 'deactivated'].includes(userStatus)) {
        malformed('users.status is unknown.');
      }
      if (userStatus !== 'active') {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }

      return Object.freeze({
        kind: 'current' as const,
        session: Object.freeze({
          sessionId,
          authUserId,
          userId,
          expiresAt,
          evidenceIds: Object.freeze([
            `auth-session:sha256:${sha256Hex(`session\u0000${sessionId}`)}@${expiresAt}`,
            `auth-user-link:sha256:${sha256Hex(`link\u0000${authUserId}\u0000${userId}`)}`
          ])
        })
      });
    }
  });
}

/**
 * Revalidates the workspace/event roots and the Foundation subject vocabulary using
 * only the supplied SQLite handle. Unknown domain/participant subjects fail closed.
 */
export function createSQLiteOperatorScopeRelationshipValidator(input: {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly eventRelationships?: SQLiteOperatorEventRelationshipSource;
  readonly additionalSubjectRelationships?: SQLiteOperatorSubjectRelationshipSource;
}): OperatorScopeRelationshipValidator {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const sqlite = input.sqlite;
  const validateEvent = input.eventRelationships?.validateEvent.bind(input.eventRelationships);
  const validateAdditionalSubject = input.additionalSubjectRelationships?.validateSubject.bind(
    input.additionalSubjectRelationships
  );

  return Object.freeze({
    validate({ userId: rawUserId, scope, evaluatedAt: rawEvaluatedAt }: {
      readonly userId: UserId;
      readonly scope: ResolvedScope;
      readonly evaluatedAt: Instant;
    }) {
      const userId = parseUserId(rawUserId);
      const evaluatedAt = parseInstant(rawEvaluatedAt);
      if (scope.workspaceId !== workspaceId) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
      const workspaceRows = sqlite.query<WorkspaceRow, [string]>(`
        select id, state from workspaces where id = ? limit 2
      `).all(workspaceId);
      if (workspaceRows.length > 1) malformed('Workspace scope root is not unique.');
      const workspace = workspaceRows[0];
      if (!workspace) return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
      if (boundedText(workspace.id, 'workspaces.id') !== workspaceId) {
        malformed('Workspace lookup returned another scope root.');
      }
      const workspaceState = boundedText(workspace.state, 'workspaces.state');
      if (workspaceState !== 'active' && workspaceState !== 'archived') {
        malformed('workspaces.state is unknown.');
      }
      if (workspaceState !== 'active') {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }

      const evidenceIds: string[] = [`workspace-root:${workspaceId}`];
      let eventId: EventId | undefined;
      if (scope.eventId !== undefined) {
        eventId = parseEventId(scope.eventId);
        if (!validateEvent) {
          return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
        }
        const eventResolution = validateEvent({
          sqlite,
          workspaceId,
          eventId,
          userId,
          evaluatedAt
        });
        if (eventResolution.kind === 'denied') return eventResolution;
        if (eventResolution.kind !== 'valid' || !Array.isArray(eventResolution.evidenceIds)) {
          malformed('Event relationship source returned an invalid resolution.');
        }
        evidenceIds.push(...eventResolution.evidenceIds);
      }

      if (eventId !== undefined) evidenceIds.push(`event-root:${eventId}`);
      for (const subject of scope.subjects) {
        switch (subject.kind) {
          case 'workspace':
            if (subject.id !== workspaceId) {
              return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
            }
            evidenceIds.push(`workspace-subject:${subject.id}`);
            break;
          case 'event':
            if (eventId === undefined || subject.id !== eventId) {
              return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
            }
            evidenceIds.push(`event-subject:${subject.id}`);
            break;
          case 'workspace_user': {
            const rows = sqlite.query<MembershipRelationshipRow, [string, string]>(`
              select id, workspace_id, user_id
                from workspace_memberships
               where workspace_id = ? and user_id = ?
               limit 2
            `).all(workspaceId, subject.id);
            if (rows.length > 1) malformed('Workspace-user relationship is not unique.');
            const relationship = rows[0];
            if (!relationship) {
              return Object.freeze({ kind: 'denied' as const, reason: 'missing' as const });
            }
            if (
              boundedText(relationship.workspace_id, 'workspace_memberships.workspace_id')
                !== workspaceId
              || boundedText(relationship.user_id, 'workspace_memberships.user_id') !== subject.id
            ) {
              return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
            }
            evidenceIds.push(
              `workspace-user-subject:${boundedText(relationship.id, 'workspace_memberships.id')}`
            );
            break;
          }
          case 'participant_person':
          case 'domain': {
            if (!validateAdditionalSubject) {
              return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
            }
            const subjectResolution = validateAdditionalSubject({
              sqlite,
              workspaceId,
              ...(eventId === undefined ? {} : { eventId }),
              userId,
              subject,
              evaluatedAt
            });
            if (subjectResolution.kind === 'denied') return subjectResolution;
            if (subjectResolution.kind !== 'valid' || !Array.isArray(subjectResolution.evidenceIds)) {
              malformed('Subject relationship source returned an invalid resolution.');
            }
            evidenceIds.push(...subjectResolution.evidenceIds);
            break;
          }
        }
      }

      return Object.freeze({ kind: 'valid' as const, evidenceIds: Object.freeze(evidenceIds) });
    }
  });
}

export interface SQLiteOperatorAuthorityPersistence extends SQLiteAccessRepositories {
  readonly sessions: CurrentOperatorSessionRepository;
  readonly scopeRelationships: OperatorScopeRelationshipValidator;
}

export interface SQLiteOperatorAuthorityPersistenceInput {
  readonly sqlite: Database;
  readonly workspaceId: WorkspaceId;
  readonly eventRelationships?: SQLiteOperatorEventRelationshipSource;
  readonly additionalSubjectRelationships?: SQLiteOperatorSubjectRelationshipSource;
}

/** All current-authority readers share this exact SQLite connection/transaction view. */
export function createSQLiteOperatorAuthorityPersistence(
  input: SQLiteOperatorAuthorityPersistenceInput
): SQLiteOperatorAuthorityPersistence {
  const access = createSQLiteAccessRepositories(input.sqlite);
  return Object.freeze({
    ...access,
    sessions: createSQLiteCurrentOperatorSessionRepository(input.sqlite),
    scopeRelationships: createSQLiteOperatorScopeRelationshipValidator(input)
  });
}

export interface SQLiteTransactionBoundOperatorAuthorityPersistence
  extends SQLiteOperatorAuthorityPersistence {
  readonly transactionRequired: true;
  assertInTransaction(): void;
}

/**
 * Wraps every authority reader with an active-transaction assertion. The wrapper and
 * its base readers retain the same caller-owned SQLite handle.
 */
export function createSQLiteTransactionBoundOperatorAuthorityPersistence(
  input: SQLiteOperatorAuthorityPersistenceInput
): SQLiteTransactionBoundOperatorAuthorityPersistence {
  const base = createSQLiteOperatorAuthorityPersistence(input);
  const assertInTransaction = () => assertActiveTransaction(input.sqlite);
  const memberships: MembershipRepository = Object.freeze({
    find(...args: Parameters<MembershipRepository['find']>) {
      assertInTransaction();
      return base.memberships.find(...args);
    }
  });
  const authorization: AuthorizationRepository = Object.freeze({
    listRoles(...args: Parameters<AuthorizationRepository['listRoles']>) {
      assertInTransaction();
      return base.authorization.listRoles(...args);
    },
    listAssignments(...args: Parameters<AuthorizationRepository['listAssignments']>) {
      assertInTransaction();
      return base.authorization.listAssignments(...args);
    },
    listOverrides(...args: Parameters<AuthorizationRepository['listOverrides']>) {
      assertInTransaction();
      return base.authorization.listOverrides(...args);
    }
  });
  const sessions: CurrentOperatorSessionRepository = Object.freeze({
    resolveCurrent(...args: Parameters<CurrentOperatorSessionRepository['resolveCurrent']>) {
      assertInTransaction();
      return base.sessions.resolveCurrent(...args);
    }
  });
  const scopeRelationships: OperatorScopeRelationshipValidator = Object.freeze({
    validate(...args: Parameters<OperatorScopeRelationshipValidator['validate']>) {
      assertInTransaction();
      return base.scopeRelationships.validate(...args);
    }
  });
  return Object.freeze({
    transactionRequired: true as const,
    assertInTransaction,
    sessions,
    memberships,
    authorization,
    scopeRelationships
  });
}
