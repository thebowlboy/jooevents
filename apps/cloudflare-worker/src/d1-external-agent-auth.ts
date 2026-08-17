import type { InvocationEvidence } from '@jooevents/application';
import {
  PERMISSIONS,
  evaluateAccess,
  isWellFormedApiKey,
  type ApiKeyRecord,
  type PermissionId
} from '@jooevents/identity-access';
import {
  parseApiKeyId,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId,
  type EventId,
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

const INVALID_API_KEY_CANARY = `jooak1_${'A'.repeat(43)}`;
const LAST_USE_COALESCE_MS = 60_000;
const knownPermissionIds = new Set(PERMISSIONS.map((permission) => permission.id));

interface KeyRow {
  readonly api_key_id: string;
  readonly workspace_id: string;
  readonly owner_user_id: string;
  readonly display_name: string;
  readonly token_hash_sha256: string;
  readonly token_hint: string;
  readonly may_read: number;
  readonly may_submit_plans: number;
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
  readonly last_used_at_ms: number | null;
  readonly standing: string;
  readonly revoked_at_ms: number | null;
  readonly revoked_by_user_id: string | null;
  readonly revoke_reason: string | null;
  readonly rotation_successor_id: string | null;
  readonly version: number;
  readonly owner_display_name: string;
  readonly owner_status: string;
  readonly workspace_state: string;
  readonly membership_status: string | null;
}

interface ApiKeyPermissionRow { readonly permission_id: string }
interface ApiKeyEventRow { readonly event_id: string }
interface CurrentEventRow {
  readonly event_id: string | null;
  readonly resolved_event_id: string | null;
}
interface CurrentProofRow { readonly current: number }

export class D1ExternalAgentAuthError extends Error {
  readonly name = 'D1ExternalAgentAuthError';
  constructor(readonly code: 'key_data_corrupt' | 'authority_corrupt') { super(code); }
}

function rows<Row>(result: D1Result<Row>): readonly Row[] {
  return Object.freeze([...(result.results ?? [])]);
}

function boolean(value: number): boolean {
  if (value !== 0 && value !== 1) throw new D1ExternalAgentAuthError('key_data_corrupt');
  return value === 1;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new D1ExternalAgentAuthError('key_data_corrupt');
  }
  return value;
}

function instant(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new D1ExternalAgentAuthError('key_data_corrupt');
  }
  return parseInstant(new Date(value).toISOString());
}

function permissionId(value: string): PermissionId {
  if (!knownPermissionIds.has(value as PermissionId)) {
    throw new D1ExternalAgentAuthError('key_data_corrupt');
  }
  return value as PermissionId;
}

function uniqueSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bearer(request: Request): { readonly raw: string; readonly wellFormed: boolean } {
  const authorization = request.headers.get('authorization');
  const parts = authorization?.split(' ') ?? [];
  const supplied = parts.length === 2 && parts[0] === 'Bearer' && parts[1]!.length <= 128;
  const candidate = supplied ? parts[1]! : INVALID_API_KEY_CANARY;
  const wellFormed = supplied && isWellFormedApiKey(candidate);
  return Object.freeze({ raw: candidate, wellFormed });
}

export type D1ExternalAgentReadAuthentication =
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'forbidden' }
  | {
      readonly kind: 'verified';
      readonly key: ApiKeyRecord;
      readonly ownerDisplayName: string;
      readonly ownerPermissionIds: readonly PermissionId[];
      readonly currentEventId?: EventId;
      readonly evidence: Extract<InvocationEvidence, { readonly kind: 'external_mcp' }>;
    };

/** Hashes once, performs one indexed lookup, then loads access only for a current key. */
export async function authenticateD1ExternalAgentRead(input: {
  readonly database: D1Database;
  readonly workspaceId: WorkspaceId;
  readonly request: Request;
  readonly nowMs: number;
}): Promise<D1ExternalAgentReadAuthentication> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new TypeError('d1_external_agent_auth_time_invalid');
  }
  const candidate = bearer(input.request);
  const tokenHash = await sha256(candidate.raw);
  const session = input.database.withSession('first-primary');
  const keyResult = await session.prepare(`SELECT key.api_key_id,key.workspace_id,
    key.owner_user_id,key.display_name,key.token_hash_sha256,key.token_hint,key.may_read,
    key.may_submit_plans,key.created_at_ms,key.expires_at_ms,key.last_used_at_ms,
    key.standing,key.revoked_at_ms,key.revoked_by_user_id,key.revoke_reason,
    key.rotation_successor_id,key.version,owner.display_name AS owner_display_name,
    owner.status AS owner_status,workspace.state AS workspace_state,
    membership.status AS membership_status
    FROM api_keys key JOIN users owner ON owner.id = key.owner_user_id
    JOIN workspaces workspace ON workspace.id = key.workspace_id
    LEFT JOIN workspace_memberships membership
      ON membership.workspace_id = key.workspace_id AND membership.user_id = key.owner_user_id
    WHERE key.workspace_id = ? AND key.token_hash_sha256 = ? LIMIT 2`)
    .bind(workspaceId, tokenHash).all<KeyRow>();
  const keyRows = rows(keyResult);
  if (keyRows.length > 1) throw new D1ExternalAgentAuthError('key_data_corrupt');
  const row = keyRows[0];
  if (!candidate.wellFormed || !row) return Object.freeze({ kind: 'unauthenticated' as const });
  const expiresAt = instant(row.expires_at_ms);
  if (row.workspace_id !== workspaceId || row.token_hash_sha256 !== tokenHash
      || row.workspace_state !== 'active' || row.owner_status !== 'active'
      || row.membership_status !== 'active' || row.standing !== 'active'
      || (expiresAt !== null && Date.parse(expiresAt) <= input.nowMs)) {
    return Object.freeze({ kind: 'unauthenticated' as const });
  }
  const mayRead = boolean(row.may_read);
  const maySubmitPlans = boolean(row.may_submit_plans);
  if (!mayRead) return Object.freeze({ kind: 'forbidden' as const });
  const ownerUserId = parseUserId(row.owner_user_id);

  const [permissionResult, eventResult, membershipResult, roleResult,
    assignmentResult, overrideResult, currentEventResult, , currentProofResult] =
    await session.batch([
    session.prepare(`SELECT permission_id FROM api_key_permission_scopes
      WHERE api_key_id = ? ORDER BY permission_id COLLATE BINARY`).bind(row.api_key_id),
    session.prepare(`SELECT event_id FROM api_key_event_scopes
      WHERE api_key_id = ? ORDER BY event_id COLLATE BINARY`).bind(row.api_key_id),
    session.prepare(`SELECT id,workspace_id,user_id,status,approved_by_user_id,
      approved_at,created_at,updated_at,version FROM workspace_memberships
      WHERE workspace_id = ? AND user_id = ? LIMIT 2`).bind(workspaceId, ownerUserId),
    session.prepare(`SELECT role.id,role.workspace_id,role.name,role.description,
      role.source_preset_key,role.source_preset_version,role.archived_at,
      permission.permission_id FROM roles role
      LEFT JOIN role_permissions permission ON permission.role_id = role.id
      WHERE role.workspace_id = ?
      ORDER BY role.id COLLATE BINARY,permission.permission_id COLLATE BINARY`)
      .bind(workspaceId),
    session.prepare(`SELECT assignment.id,assignment.user_id,assignment.role_id,
      assignment.workspace_id,assignment.scope_kind,assignment.event_id,
      event.workspace_id AS event_workspace_id,role.workspace_id AS role_workspace_id,
      assignment.assigned_by_user_id,assignment.assigned_at,assignment.expires_at
      FROM role_assignments assignment JOIN roles role ON role.id = assignment.role_id
      LEFT JOIN events event ON event.id = assignment.event_id
      WHERE assignment.workspace_id = ? AND assignment.user_id = ?
      ORDER BY assignment.id COLLATE BINARY`)
      .bind(workspaceId, ownerUserId),
    session.prepare(`SELECT override.id,override.user_id,override.permission_id,
      override.effect,override.workspace_id,override.scope_kind,override.event_id,
      event.workspace_id AS event_workspace_id,override.reason,
      override.decided_by_user_id,override.decided_at,override.expires_at
      FROM permission_overrides override LEFT JOIN events event ON event.id = override.event_id
      WHERE override.workspace_id = ? AND override.user_id = ?
      ORDER BY override.id COLLATE BINARY`)
      .bind(workspaceId, ownerUserId),
    session.prepare(`SELECT selection.current_event_id AS event_id,
      event.id AS resolved_event_id
      FROM event_spine_workspace_sets selection
      LEFT JOIN event_spine_heads event ON event.workspace_id = selection.workspace_id
        AND event.id = selection.current_event_id
      WHERE selection.workspace_id = ? LIMIT 2`).bind(workspaceId),
    session.prepare(`UPDATE api_keys SET last_used_at_ms = ?,version = version + 1
      WHERE api_key_id = ? AND workspace_id = ? AND token_hash_sha256 = ?
        AND standing = 'active' AND may_read = 1
        AND (expires_at_ms IS NULL OR expires_at_ms > ?)
        AND (last_used_at_ms IS NULL OR last_used_at_ms <= ?)
        AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND state = 'active')
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM workspace_memberships
          WHERE workspace_id = ? AND user_id = ? AND status = 'active')`)
      .bind(
        input.nowMs, row.api_key_id, workspaceId, tokenHash, input.nowMs,
        input.nowMs - LAST_USE_COALESCE_MS, workspaceId, ownerUserId,
        workspaceId, ownerUserId
      ),
    session.prepare(`SELECT 1 AS current FROM api_keys key
      JOIN workspaces workspace ON workspace.id = key.workspace_id
      JOIN users owner ON owner.id = key.owner_user_id
      JOIN workspace_memberships membership ON membership.workspace_id = key.workspace_id
        AND membership.user_id = key.owner_user_id
      WHERE key.api_key_id = ? AND key.workspace_id = ? AND key.token_hash_sha256 = ?
        AND key.standing = 'active' AND key.may_read = 1
        AND (key.expires_at_ms IS NULL OR key.expires_at_ms > ?)
        AND workspace.state = 'active' AND owner.status = 'active'
        AND membership.status = 'active'`)
      .bind(row.api_key_id, workspaceId, tokenHash, input.nowMs)
  ]);
  const membershipRows = rows(membershipResult as D1Result<MembershipEvidenceRow>);
  if (membershipRows.length > 1) throw new D1ExternalAgentAuthError('authority_corrupt');
  const currentProofRows = rows(currentProofResult as D1Result<CurrentProofRow>);
  if (currentProofRows.length !== 1 || currentProofRows[0]?.current !== 1
      || membershipRows[0]?.status !== 'active') {
    return Object.freeze({ kind: 'unauthenticated' as const });
  }

  const keyPermissions = rows(permissionResult as D1Result<ApiKeyPermissionRow>)
    .map((entry) => permissionId(entry.permission_id));
  const keyEvents = rows(eventResult as D1Result<ApiKeyEventRow>)
    .map((entry) => parseEventId(entry.event_id));
  if (!uniqueSorted(keyPermissions) || !uniqueSorted(keyEvents)) {
    throw new D1ExternalAgentAuthError('key_data_corrupt');
  }
  const membership = membershipFromAccessEvidenceRow(
    membershipRows[0]!, workspaceId, ownerUserId
  );
  const roleGroups = new Map<string, RoleEvidenceRow[]>();
  for (const roleRow of rows(roleResult as D1Result<RoleEvidenceRow>)) {
    if (typeof roleRow.id !== 'string') {
      throw new D1ExternalAgentAuthError('authority_corrupt');
    }
    const group = roleGroups.get(roleRow.id);
    if (group) group.push(roleRow);
    else roleGroups.set(roleRow.id, [roleRow]);
  }
  const roles = [...roleGroups.values()].map((group) =>
    roleFromAccessEvidenceRows(group, workspaceId)
  );
  const assignments = rows(assignmentResult as D1Result<AssignmentEvidenceRow>)
    .map((entry) => assignmentFromAccessEvidenceRow(entry, workspaceId, ownerUserId));
  const overrides = rows(overrideResult as D1Result<OverrideEvidenceRow>)
    .map((entry) => overrideFromAccessEvidenceRow(entry, workspaceId, ownerUserId));
  const currentRows = rows(currentEventResult as D1Result<CurrentEventRow>);
  if (currentRows.length !== 1
      || (currentRows[0]!.event_id === null) !== (currentRows[0]!.resolved_event_id === null)) {
    throw new D1ExternalAgentAuthError('authority_corrupt');
  }
  const currentEventId = currentRows[0]!.event_id === null
    ? undefined
    : parseEventId(currentRows[0]!.event_id);
  const now = parseInstant(new Date(input.nowMs).toISOString());
  const requestedScope = currentEventId === undefined
    ? { kind: 'workspace' as const, workspaceId }
    : { kind: 'event' as const, workspaceId, eventId: currentEventId };
  const ownerPermissionIds = Object.freeze(PERMISSIONS
    .filter((permission) => evaluateAccess({
      userId: ownerUserId,
      permissionId: permission.id,
      requestedScope,
      membership,
      roles,
      assignments,
      overrides,
      now
    }).allowed)
    .map((permission) => permission.id));

  const key: ApiKeyRecord = Object.freeze({
    apiKeyId: parseApiKeyId(row.api_key_id),
    workspaceId,
    ownerUserId,
    displayName: row.display_name,
    tokenHashSha256: row.token_hash_sha256,
    tokenHint: row.token_hint,
    mayRead,
    maySubmitPlans,
    permissionIds: Object.freeze(keyPermissions),
    eventIds: Object.freeze(keyEvents),
    createdAt: instant(row.created_at_ms)!,
    expiresAt,
    lastUsedAt: instant(row.last_used_at_ms),
    standing: 'active',
    revokedAt: instant(row.revoked_at_ms),
    revokedByUserId: row.revoked_by_user_id === null ? null : parseUserId(row.revoked_by_user_id),
    revokeReason: row.revoke_reason as ApiKeyRecord['revokeReason'],
    rotationSuccessorId: row.rotation_successor_id === null
      ? null
      : parseApiKeyId(row.rotation_successor_id),
    version: positiveInteger(row.version)
  });
  return Object.freeze({
    kind: 'verified' as const,
    key,
    ownerDisplayName: row.owner_display_name,
    ownerPermissionIds,
    ...(currentEventId === undefined ? {} : { currentEventId }),
    evidence: Object.freeze({
      kind: 'external_mcp' as const,
      surface: 'external_mcp' as const,
      client: Object.freeze({ key: 'api.v1' }),
      credentialHandle: key.apiKeyId,
      clientKey: `api-key:${key.apiKeyId}`
    })
  });
}
