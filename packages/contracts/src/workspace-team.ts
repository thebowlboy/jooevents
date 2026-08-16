import { isApplicationId } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from './operations';

const DIGEST = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const WORKSPACE_TEAM_ROLE_ORDER = [
  'workspace_admin',
  'event_manager',
  'speaker_manager',
  'speaker_reviewer',
  'scheduler',
  'communications_coordinator',
  'viewer'
] as const;
const applicationIdSchema = z.string().refine(isApplicationId, {
  message: 'Expected a canonical lowercase UUIDv4 or UUIDv7 application ID.'
});
const positiveVersionSchema = z.number().int().positive().safe();
const canonicalEmailInputSchema = z.email().max(320).transform((value) => value.normalize('NFC').trim());

export const workspaceTeamRoleKeySchema = z.enum([
  'workspace_admin',
  'event_manager',
  'speaker_manager',
  'speaker_reviewer',
  'scheduler',
  'communications_coordinator',
  'viewer'
]);

export const workspaceTeamRoleViewSchema = z.discriminatedUnion('key', [
  z.strictObject({ key: z.literal('workspace_admin'), name: z.literal('Workspace Admin'), version: z.literal(1) }),
  z.strictObject({ key: z.literal('event_manager'), name: z.literal('Event Manager'), version: z.literal(1) }),
  z.strictObject({ key: z.literal('speaker_manager'), name: z.literal('Speaker Manager'), version: z.literal(1) }),
  z.strictObject({ key: z.literal('speaker_reviewer'), name: z.literal('Speaker Reviewer'), version: z.literal(1) }),
  z.strictObject({ key: z.literal('scheduler'), name: z.literal('Scheduler'), version: z.literal(1) }),
  z.strictObject({ key: z.literal('communications_coordinator'), name: z.literal('Communications Coordinator'), version: z.literal(1) }),
  z.strictObject({ key: z.literal('viewer'), name: z.literal('Viewer'), version: z.literal(1) })
]);

export const workspaceTeamCanonicalEmailSchema = z.email().max(320).refine(
  (value) => value === value.normalize('NFC').trim() && !CONTROL.test(value),
  { message: 'Expected a canonical control-free email projection.' }
);

/** Opaque recognition hint derived from a keyed binding, never from address characters. */
export const workspaceTeamRecipientHintSchema = z.string().regex(/^recipient-[a-f0-9]{12}$/);

export const workspaceTeamSubjectRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('member'),
    membershipId: applicationIdSchema,
    version: positiveVersionSchema
  }),
  z.strictObject({
    kind: z.literal('invitation'),
    reservationId: applicationIdSchema,
    version: positiveVersionSchema
  })
]);

const memberBaseSchema = z.strictObject({
  id: applicationIdSchema,
  name: z.string().trim().min(1).max(240),
  email: workspaceTeamCanonicalEmailSchema,
  role: workspaceTeamRoleViewSchema,
  version: positiveVersionSchema,
  hasAdditionalAccess: z.boolean()
});

export const workspaceTeamMemberViewSchema = z.discriminatedUnion('status', [
  memberBaseSchema.extend({
    status: z.literal('active'),
    kind: z.literal('member'),
    userId: applicationIdSchema
  }),
  memberBaseSchema.extend({
    status: z.literal('pending_review'),
    kind: z.literal('member'),
    userId: applicationIdSchema
  }),
  memberBaseSchema.extend({
    status: z.literal('invited'),
    kind: z.literal('invitation'),
    delivery: z.literal('awaiting_activation')
  })
]);

export const workspaceTeamSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: positiveVersionSchema,
  digestSha256: z.string().regex(DIGEST),
  roles: z.array(workspaceTeamRoleViewSchema).length(7),
  members: z.array(workspaceTeamMemberViewSchema).max(10_000)
}).superRefine((snapshot, context) => {
  const roleKeys = snapshot.roles.map((role) => role.key);
  if (roleKeys.some((key, index) => key !== WORKSPACE_TEAM_ROLE_ORDER[index])) {
    context.addIssue({ code: 'custom', path: ['roles'], message: 'Roles must use canonical unique order.' });
  }
  const subjectKeys = snapshot.members.map((member) => `${member.kind}:${member.id}`);
  const subjectIds = snapshot.members.map((member) => member.id);
  const canonical = [...subjectKeys].sort();
  if (new Set(subjectIds).size !== subjectIds.length
      || canonical.some((key, index) => key !== subjectKeys[index])) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'Members must have unique IDs in canonical order.' });
  }
});

export const workspaceTeamMembersReadInputSchema = z.strictObject({});
export const workspaceTeamMembersCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: workspaceTeamSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const workspaceTeamMembersReadResultSchema =
  createReadOperationResultSchema(workspaceTeamSnapshotSchema);

export const workspaceTeamInviteInputSchema = z.strictObject({
  email: canonicalEmailInputSchema,
  roleKey: workspaceTeamRoleKeySchema,
  expectedTeamVersion: positiveVersionSchema,
  expectedTeamDigestSha256: z.string().regex(DIGEST)
});

export const workspaceTeamRoleChangeInputSchema = z.strictObject({
  subject: workspaceTeamSubjectRefSchema,
  roleKey: workspaceTeamRoleKeySchema,
  expectedTeamVersion: positiveVersionSchema,
  expectedTeamDigestSha256: z.string().regex(DIGEST)
});

export const workspaceTeamRemovalInputSchema = z.strictObject({
  subject: workspaceTeamSubjectRefSchema,
  expectedTeamVersion: positiveVersionSchema,
  expectedTeamDigestSha256: z.string().regex(DIGEST)
});

export const workspaceTeamSafeDiffSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('invite'),
    recipientHint: workspaceTeamRecipientHintSchema,
    role: workspaceTeamRoleViewSchema,
    invitationStatus: z.literal('recorded'),
    delivery: z.literal('awaiting_activation')
  }),
  z.strictObject({
    action: z.literal('change_role'),
    subject: workspaceTeamSubjectRefSchema,
    before: workspaceTeamRoleViewSchema,
    after: workspaceTeamRoleViewSchema
  }),
  z.strictObject({
    action: z.literal('remove'),
    subject: workspaceTeamSubjectRefSchema,
    before: workspaceTeamRoleViewSchema,
    after: z.null(),
    sessionRevocation: z.enum(['not_applicable', 'awaiting_activation'])
  })
]);

export const workspaceTeamMutationDataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['invite', 'change_role', 'remove']),
  teamVersion: positiveVersionSchema,
  safeDiff: workspaceTeamSafeDiffSchema
}).superRefine((data, context) => {
  if (data.action !== data.safeDiff.action) {
    context.addIssue({ code: 'custom', message: 'Workspace team mutation action and diff disagree.' });
  }
});

export const workspaceTeamMutationCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: workspaceTeamMutationDataSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const workspaceTeamMutationOperationResultSchema =
  createEffectfulOperationResultSchema(workspaceTeamMutationDataSchema);

export const WORKSPACE_TEAM_OPERATION_SCHEMA_REFS = Object.freeze({
  members: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace_team.members-read.input',
    inputSchema: workspaceTeamMembersReadInputSchema,
    resultKey: 'schema.workspace_team.members-read.operator-result',
    resultSchema: workspaceTeamMembersReadResultSchema
  }),
  invite: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace_team.invite.input',
    inputSchema: workspaceTeamInviteInputSchema,
    resultKey: 'schema.workspace_team.mutation.operator-result',
    resultSchema: workspaceTeamMutationOperationResultSchema
  }),
  roleChange: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace_team.role-change.input',
    inputSchema: workspaceTeamRoleChangeInputSchema,
    resultKey: 'schema.workspace_team.mutation.operator-result',
    resultSchema: workspaceTeamMutationOperationResultSchema
  }),
  removal: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace_team.removal.input',
    inputSchema: workspaceTeamRemovalInputSchema,
    resultKey: 'schema.workspace_team.mutation.operator-result',
    resultSchema: workspaceTeamMutationOperationResultSchema
  })
});

export type WorkspaceTeamRoleKey = z.infer<typeof workspaceTeamRoleKeySchema>;
export type WorkspaceTeamRoleView = z.infer<typeof workspaceTeamRoleViewSchema>;
export type WorkspaceTeamSubjectRef = z.infer<typeof workspaceTeamSubjectRefSchema>;
export type WorkspaceTeamMemberView = z.infer<typeof workspaceTeamMemberViewSchema>;
export type WorkspaceTeamSnapshot = z.infer<typeof workspaceTeamSnapshotSchema>;
export type WorkspaceTeamSafeDiff = z.infer<typeof workspaceTeamSafeDiffSchema>;
export type WorkspaceTeamMutationData = z.infer<typeof workspaceTeamMutationDataSchema>;
