import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
};

export const authUsers = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  ...timestamps
});

export const authAccounts = sqliteTable('auth_accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUsers.id),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  ...timestamps
}, (table) => [uniqueIndex('auth_accounts_provider_account_unique').on(table.providerId, table.accountId), index('auth_accounts_user_idx').on(table.userId)]);

export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  userId: text('user_id').notNull().references(() => authUsers.id),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  ...timestamps
}, (table) => [index('auth_sessions_user_idx').on(table.userId), index('auth_sessions_expiry_idx').on(table.expiresAt)]);

export const authVerifications = sqliteTable('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ...timestamps
}, (table) => [index('auth_verifications_identifier_idx').on(table.identifier)]);

export const authRateLimits = sqliteTable('auth_rate_limits', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull()
});

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  state: text('state', { enum: ['active', 'archived'] }).notNull().default('active'),
  ...timestamps,
  version: integer('version').notNull().default(1)
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  ...timestamps
}, (table) => [uniqueIndex('events_workspace_id_unique').on(table.workspaceId, table.id)]);

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  status: text('status', { enum: ['pending_review', 'active', 'suspended', 'deactivated'] }).notNull(),
  displayName: text('display_name').notNull(),
  primaryEmailId: text('primary_email_id'),
  avatarAssetId: text('avatar_asset_id'),
  ...timestamps,
  version: integer('version').notNull().default(1)
});

export const authUserLinks = sqliteTable('auth_user_links', {
  authUserId: text('auth_user_id').primaryKey().references(() => authUsers.id),
  userId: text('user_id').references(() => users.id),
  provisioningState: text('provisioning_state', { enum: ['pending', 'ready', 'failed'] }).notNull(),
  lastErrorCode: text('last_error_code'),
  attempts: integer('attempts').notNull().default(0),
  ...timestamps
}, (table) => [uniqueIndex('auth_user_links_user_unique').on(table.userId)]);

export const userEmails = sqliteTable('user_emails', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  normalizedEmail: text('normalized_email').notNull(),
  displayEmail: text('display_email').notNull(),
  verified: integer('verified', { mode: 'boolean' }).notNull(),
  source: text('source', { enum: ['auth_provider', 'admin', 'user'] }).notNull(),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull(),
  verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  uniqueIndex('user_emails_live_verified_owner_unique').on(table.normalizedEmail).where(sql`${table.verified} = 1 and ${table.revokedAt} is null`),
  uniqueIndex('user_emails_primary_unique').on(table.userId).where(sql`${table.isPrimary} = 1 and ${table.revokedAt} is null`),
  index('user_emails_user_idx').on(table.userId)
]);

export const externalIdentities = sqliteTable('external_identities', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(),
  issuer: text('issuer').notNull(),
  subject: text('subject').notNull(),
  emailSnapshot: text('email_snapshot'),
  emailVerifiedSnapshot: integer('email_verified_snapshot', { mode: 'boolean' }).notNull(),
  displayNameSnapshot: text('display_name_snapshot'),
  avatarUrlSnapshot: text('avatar_url_snapshot'),
  linkedAt: integer('linked_at', { mode: 'timestamp_ms' }).notNull(),
  lastObservedAt: integer('last_observed_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [uniqueIndex('external_identities_stable_unique').on(table.provider, table.issuer, table.subject), index('external_identities_user_idx').on(table.userId)]);

export const workspaceMemberships = sqliteTable('workspace_memberships', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  userId: text('user_id').notNull().references(() => users.id),
  status: text('status', { enum: ['invited', 'pending_review', 'active', 'suspended', 'deactivated'] }).notNull(),
  approvedByUserId: text('approved_by_user_id'),
  approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  decisionReason: text('decision_reason'),
  ...timestamps,
  version: integer('version').notNull().default(1)
}, (table) => [uniqueIndex('workspace_memberships_user_unique').on(table.workspaceId, table.userId), index('workspace_memberships_user_idx').on(table.userId, table.workspaceId), index('workspace_memberships_status_idx').on(table.workspaceId, table.status)]);

export const accessReservations = sqliteTable('access_reservations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  normalizedEmail: text('normalized_email').notNull(),
  status: text('status', { enum: ['open', 'consumed', 'revoked', 'expired'] }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdByUserId: text('created_by_user_id'),
  consumedByUserId: text('consumed_by_user_id'),
  consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  version: integer('version').notNull().default(1)
}, (table) => [uniqueIndex('access_reservations_live_unique').on(table.workspaceId, table.normalizedEmail).where(sql`${table.status} = 'open'`), index('access_reservations_lookup_idx').on(table.workspaceId, table.normalizedEmail)]);

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  sourcePresetKey: text('source_preset_key'),
  sourcePresetVersion: integer('source_preset_version'),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  ...timestamps,
  version: integer('version').notNull().default(1)
}, (table) => [uniqueIndex('roles_live_name_unique').on(table.workspaceId, table.name).where(sql`${table.archivedAt} is null`)]);

export const rolePermissions = sqliteTable('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id),
  permissionId: text('permission_id').notNull()
}, (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })]);

export const reservationRoleAssignments = sqliteTable('reservation_role_assignments', {
  id: text('id').primaryKey(),
  reservationId: text('reservation_id').notNull().references(() => accessReservations.id),
  roleId: text('role_id').notNull().references(() => roles.id),
  scopeKind: text('scope_kind', { enum: ['workspace', 'event'] }).notNull(),
  eventId: text('event_id')
}, (table) => [check('reservation_role_scope_check', sql`(${table.scopeKind} = 'workspace' and ${table.eventId} is null) or (${table.scopeKind} = 'event' and ${table.eventId} is not null)`)]);

export const reservationPermissionOverrides = sqliteTable('reservation_permission_overrides', {
  id: text('id').primaryKey(),
  reservationId: text('reservation_id').notNull().references(() => accessReservations.id),
  permissionId: text('permission_id').notNull(),
  effect: text('effect', { enum: ['grant', 'deny'] }).notNull(),
  scopeKind: text('scope_kind', { enum: ['workspace', 'event'] }).notNull(),
  eventId: text('event_id'),
  reason: text('reason').notNull()
}, (table) => [check('reservation_override_scope_check', sql`(${table.scopeKind} = 'workspace' and ${table.eventId} is null) or (${table.scopeKind} = 'event' and ${table.eventId} is not null)`)]);

export const roleAssignments = sqliteTable('role_assignments', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  roleId: text('role_id').notNull().references(() => roles.id),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  scopeKind: text('scope_kind', { enum: ['workspace', 'event'] }).notNull(),
  eventId: text('event_id'),
  assignedByUserId: text('assigned_by_user_id'),
  assignedAt: integer('assigned_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  version: integer('version').notNull().default(1)
}, (table) => [index('role_assignments_access_idx').on(table.userId, table.workspaceId), check('role_assignment_scope_check', sql`(${table.scopeKind} = 'workspace' and ${table.eventId} is null) or (${table.scopeKind} = 'event' and ${table.eventId} is not null)`)]);

export const permissionOverrides = sqliteTable('permission_overrides', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  permissionId: text('permission_id').notNull(),
  effect: text('effect', { enum: ['grant', 'deny'] }).notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  scopeKind: text('scope_kind', { enum: ['workspace', 'event'] }).notNull(),
  eventId: text('event_id'),
  reason: text('reason').notNull(),
  decidedByUserId: text('decided_by_user_id'),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  version: integer('version').notNull().default(1)
}, (table) => [index('permission_overrides_access_idx').on(table.userId, table.workspaceId), check('permission_override_scope_check', sql`(${table.scopeKind} = 'workspace' and ${table.eventId} is null) or (${table.scopeKind} = 'event' and ${table.eventId} is not null)`)]);

export const identityLinkRequests = sqliteTable('identity_link_requests', {
  id: text('id').primaryKey(),
  targetUserId: text('target_user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(),
  normalizedTargetEmail: text('normalized_target_email').notNull(),
  state: text('state').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  ...timestamps,
  version: integer('version').notNull().default(1)
}, (table) => [uniqueIndex('identity_link_requests_active_unique').on(table.targetUserId, table.provider, table.normalizedTargetEmail).where(sql`${table.state} not in ('linked', 'expired', 'cancelled', 'failed')`)]);

export const identityLinkEvidence = sqliteTable('identity_link_evidence', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().references(() => identityLinkRequests.id),
  kind: text('kind').notNull(),
  provider: text('provider'),
  issuer: text('issuer'),
  subject: text('subject'),
  authenticatedAt: integer('authenticated_at', { mode: 'timestamp_ms' }),
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
  redactedMetadataJson: text('redacted_metadata_json')
}, (table) => [uniqueIndex('identity_link_evidence_kind_unique').on(table.requestId, table.kind)]);

export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  purpose: text('purpose').notNull(),
  storageProvider: text('storage_provider').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  checksumSha256: text('checksum_sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  sourceProvider: text('source_provider'),
  sourceUrl: text('source_url'),
  sourceFingerprint: text('source_fingerprint'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

export const avatarImportJobs = sqliteTable('avatar_import_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed'] }).notNull(),
  sourceProvider: text('source_provider').notNull(),
  sourceUrl: text('source_url').notNull(),
  sourceFingerprint: text('source_fingerprint'),
  expectedCurrentAssetId: text('expected_current_asset_id'),
  replaceAssetId: text('replace_asset_id'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }).notNull(),
  lastErrorCode: text('last_error_code'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  ...timestamps
}, (table) => [index('avatar_jobs_due_idx').on(table.status, table.nextAttemptAt)]);

export const outboxEvents = sqliteTable('outbox_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  version: integer('version').notNull(),
  payloadJson: text('payload_json').notNull(),
  sensitivePayloadJson: text('sensitive_payload_json'),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }).notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
  lastErrorCode: text('last_error_code'),
  ...timestamps
}, (table) => [index('outbox_due_idx').on(table.status, table.nextAttemptAt)]);

export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  workspaceId: text('workspace_id'),
  eventId: text('event_id'),
  evidenceJson: text('evidence_json').notNull(),
  correlationId: text('correlation_id').notNull(),
  occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [index('audit_workspace_time_idx').on(table.workspaceId, table.occurredAt)]);

export const bootstrapState = sqliteTable('bootstrap_state', {
  key: text('key').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  ownerReservationId: text('owner_reservation_id').notNull().references(() => accessReservations.id),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }).notNull()
});
