import type {
  EventId,
  ISODateTime,
  ReservationId,
  UserId,
  WorkspaceId
} from './identity';

export type PermissionRisk = 'routine' | 'sensitive' | 'consequential';
export type AccessScopeKind = 'workspace' | 'event';

export const FEATURE_GROUPS = [
  { id: 'events', label: 'Events', description: 'Event records and operating details.' },
  { id: 'speakers', label: 'Speakers', description: 'Speaker profiles and private contact details.' },
  { id: 'submissions', label: 'Submissions', description: 'Abstract review, scoring, and decisions.' },
  { id: 'schedule', label: 'Schedule', description: 'Sessions, rooms, timing, and publication.' },
  { id: 'communications', label: 'Communications', description: 'Messages sent on behalf of the event.' },
  { id: 'access', label: 'Users & access', description: 'Admission, roles, and account state.' },
  { id: 'integrations', label: 'Integrations', description: 'Connected operational systems such as Airtable.' },
  { id: 'audit', label: 'Audit', description: 'Who changed consequential state and why.' }
] as const;

export type FeatureGroupId = (typeof FEATURE_GROUPS)[number]['id'];

export interface PermissionDefinition {
  readonly id: string;
  readonly group: FeatureGroupId;
  readonly label: string;
  readonly description: string;
  readonly risk: PermissionRisk;
  readonly allowedScopes: readonly AccessScopeKind[];
}

export const PERMISSIONS = [
  { id: 'event.read', group: 'events', label: 'View events', description: 'Read event settings and operating details.', risk: 'routine', allowedScopes: ['workspace', 'event'] },
  { id: 'event.manage', group: 'events', label: 'Manage events', description: 'Create events and change event settings.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'program.vocabulary.manage', group: 'events', label: 'Manage program vocabulary', description: 'Create and change an event\'s rooms, tracks, and formats.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'speaker.directory.read', group: 'speakers', label: 'View speaker directory', description: 'Read names, biographies, and public profile details.', risk: 'routine', allowedScopes: ['workspace', 'event'] },
  { id: 'speaker.contact.read', group: 'speakers', label: 'View speaker contact details', description: 'Read private email addresses, phone numbers, and contact notes.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'speaker.profile.manage', group: 'speakers', label: 'Manage speaker profiles', description: 'Create speakers and edit profile or contact details.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'submission.read', group: 'submissions', label: 'View submissions', description: 'Read titles, abstracts, tracks, and submitted material.', risk: 'routine', allowedScopes: ['workspace', 'event'] },
  { id: 'submission.score', group: 'submissions', label: 'Score submissions', description: 'Create or update the user’s own review score.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'submission.comment', group: 'submissions', label: 'Comment on submissions', description: 'Create review notes visible to the review team.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'submission.decision', group: 'submissions', label: 'Decide submissions', description: 'Accept, reject, or waitlist a submission.', risk: 'consequential', allowedScopes: ['workspace', 'event'] },
  { id: 'schedule.read', group: 'schedule', label: 'View working schedule', description: 'Read draft sessions, rooms, and timing.', risk: 'routine', allowedScopes: ['workspace', 'event'] },
  { id: 'schedule.manage', group: 'schedule', label: 'Manage schedule', description: 'Create sessions and change rooms or timing.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'schedule.publish', group: 'schedule', label: 'Publish schedule', description: 'Make a schedule revision visible to attendees.', risk: 'consequential', allowedScopes: ['workspace', 'event'] },
  { id: 'publication.manage', group: 'schedule', label: 'Manage publication', description: 'Draft, publish, and roll back the public program, surfaces, and embed framing.', risk: 'consequential', allowedScopes: ['workspace', 'event'] },
  { id: 'communication.draft', group: 'communications', label: 'Draft communications', description: 'Prepare messages without sending them.', risk: 'routine', allowedScopes: ['workspace', 'event'] },
  { id: 'communication.send', group: 'communications', label: 'Send communications', description: 'Send a message to speakers, reviewers, or attendees.', risk: 'consequential', allowedScopes: ['workspace', 'event'] },
  { id: 'communication.provider.manage', group: 'communications', label: 'Manage email providers', description: 'Read and manage email provider connections, readiness, sender profiles, and routing.', risk: 'sensitive', allowedScopes: ['workspace'] },
  { id: 'access.users.read', group: 'access', label: 'View users', description: 'Read users, membership states, and effective roles.', risk: 'sensitive', allowedScopes: ['workspace'] },
  { id: 'access.users.invite', group: 'access', label: 'Invite users', description: 'Create pre-approved email reservations.', risk: 'sensitive', allowedScopes: ['workspace'] },
  { id: 'access.users.approve', group: 'access', label: 'Approve users', description: 'Admit or reject people waiting for review.', risk: 'consequential', allowedScopes: ['workspace'] },
  { id: 'access.roles.manage', group: 'access', label: 'Manage roles', description: 'Change role definitions, assignments, and direct overrides.', risk: 'consequential', allowedScopes: ['workspace'] },
  { id: 'access.users.suspend', group: 'access', label: 'Suspend users', description: 'End workspace access and revoke active sessions.', risk: 'consequential', allowedScopes: ['workspace'] },
  { id: 'integration.airtable.read', group: 'integrations', label: 'View Airtable sync', description: 'Read connection status, field mappings, and sync history.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] },
  { id: 'integration.airtable.manage', group: 'integrations', label: 'Manage Airtable sync', description: 'Change mappings, conflict policy, and connection credentials.', risk: 'consequential', allowedScopes: ['workspace', 'event'] },
  { id: 'integration.api.manage', group: 'integrations', label: 'Manage API keys', description: 'Create, rotate, list, and revoke external agent credentials.', risk: 'consequential', allowedScopes: ['workspace'] },
  { id: 'audit.read', group: 'audit', label: 'View audit history', description: 'Read security and consequential-change history.', risk: 'sensitive', allowedScopes: ['workspace', 'event'] }
] as const satisfies readonly PermissionDefinition[];

export type PermissionId = (typeof PERMISSIONS)[number]['id'];

/** Version 1 is immutable: later permission definitions require an explicit grant decision. */
const WORKSPACE_ADMIN_V1_PERMISSION_IDS = [
  'event.read',
  'event.manage',
  'speaker.directory.read',
  'speaker.contact.read',
  'speaker.profile.manage',
  'submission.read',
  'submission.score',
  'submission.comment',
  'submission.decision',
  'schedule.read',
  'schedule.manage',
  'schedule.publish',
  'communication.draft',
  'communication.send',
  'access.users.read',
  'access.users.invite',
  'access.users.approve',
  'access.roles.manage',
  'access.users.suspend',
  'integration.airtable.read',
  'integration.airtable.manage',
  'audit.read'
] as const satisfies readonly PermissionId[];

export type AccessScope =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'event'; readonly workspaceId: WorkspaceId; readonly eventId: EventId };

export interface Role {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description: string;
  readonly permissionIds: readonly PermissionId[];
  readonly sourcePresetKey?: RolePresetKey;
  readonly sourcePresetVersion?: number;
  readonly archivedAt?: ISODateTime;
}

export interface RoleAssignment {
  readonly id: string;
  readonly userId: UserId;
  readonly roleId: string;
  readonly scope: AccessScope;
  /** Present only when the durable assignment identifies a concrete user actor. */
  readonly assignedByUserId?: UserId;
  readonly assignedAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
}

export interface PermissionOverride {
  readonly id: string;
  readonly userId: UserId;
  readonly permissionId: PermissionId;
  readonly effect: 'grant' | 'deny';
  readonly scope: AccessScope;
  readonly reason: string;
  /** Present only when the durable override identifies a concrete user actor. */
  readonly decidedByUserId?: UserId;
  readonly decidedAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
}

export type ReservedAccessScope =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'event'; readonly eventId: EventId };

export interface ReservedRoleAssignment {
  readonly roleId: string;
  readonly scope: ReservedAccessScope;
}

export interface ReservedPermissionOverride {
  readonly permissionId: PermissionId;
  readonly effect: 'grant' | 'deny';
  readonly scope: ReservedAccessScope;
  readonly reason: string;
}

/** Admin intent that becomes access only after a matching verified-email login. */
export interface AccessReservation {
  readonly id: ReservationId;
  readonly workspaceId: WorkspaceId;
  readonly normalizedEmail: string;
  readonly roleAssignments: readonly ReservedRoleAssignment[];
  readonly permissionOverrides: readonly ReservedPermissionOverride[];
  readonly status: 'open' | 'consumed' | 'revoked' | 'expired';
  readonly expiresAt?: ISODateTime;
  readonly createdByUserId: UserId;
  readonly createdAt: ISODateTime;
  readonly consumedByUserId?: UserId;
  readonly consumedAt?: ISODateTime;
}

export const ROLE_PRESETS = [
  {
    key: 'workspace_admin',
    version: 1,
    name: 'Workspace Admin',
    description: 'Runs the workspace, including users, integrations, and consequential actions.',
    permissionIds: WORKSPACE_ADMIN_V1_PERMISSION_IDS
  },
  {
    key: 'event_manager',
    version: 1,
    name: 'Event Manager',
    description: 'Runs event records, speakers, submissions, schedule, and communications.',
    permissionIds: ['event.read', 'event.manage', 'speaker.directory.read', 'speaker.contact.read', 'speaker.profile.manage', 'submission.read', 'submission.score', 'submission.comment', 'submission.decision', 'schedule.read', 'schedule.manage', 'schedule.publish', 'communication.draft', 'communication.send', 'integration.airtable.read']
  },
  {
    key: 'speaker_manager',
    version: 1,
    name: 'Speaker Manager',
    description: 'Maintains speaker records and coordinates speaker communication.',
    permissionIds: ['event.read', 'speaker.directory.read', 'speaker.contact.read', 'speaker.profile.manage', 'submission.read', 'schedule.read', 'communication.draft', 'communication.send']
  },
  {
    key: 'speaker_reviewer',
    version: 1,
    name: 'Speaker Reviewer',
    description: 'Reads and reviews submissions without seeing private contact data or making final decisions.',
    permissionIds: ['event.read', 'speaker.directory.read', 'submission.read', 'submission.score', 'submission.comment', 'schedule.read']
  },
  {
    key: 'scheduler',
    version: 1,
    name: 'Scheduler',
    description: 'Builds the working schedule; publication remains a separate permission.',
    permissionIds: ['event.read', 'speaker.directory.read', 'speaker.contact.read', 'submission.read', 'schedule.read', 'schedule.manage']
  },
  {
    key: 'communications_coordinator',
    version: 1,
    name: 'Communications Coordinator',
    description: 'Prepares and sends approved event communications.',
    permissionIds: ['event.read', 'speaker.directory.read', 'speaker.contact.read', 'schedule.read', 'communication.draft', 'communication.send']
  },
  {
    key: 'viewer',
    version: 1,
    name: 'Viewer',
    description: 'Reads routine event, speaker, submission, and schedule records.',
    permissionIds: ['event.read', 'speaker.directory.read', 'submission.read', 'schedule.read']
  }
] as const satisfies readonly {
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly permissionIds: readonly PermissionId[];
}[];

export type RolePresetKey = (typeof ROLE_PRESETS)[number]['key'];

/** Presets seed editable roles. They are copied, so future preset changes never grant access silently. */
export function createRoleFromPreset(
  presetKey: RolePresetKey,
  input: { readonly id: string; readonly workspaceId: WorkspaceId; readonly name?: string }
): Role {
  const preset = ROLE_PRESETS.find((candidate) => candidate.key === presetKey);
  if (!preset) throw new Error(`Unknown role preset: ${presetKey}`);

  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name ?? preset.name,
    description: preset.description,
    permissionIds: [...preset.permissionIds],
    sourcePresetKey: preset.key,
    sourcePresetVersion: preset.version
  };
}
