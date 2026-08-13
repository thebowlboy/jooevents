import { expect, test } from 'bun:test';
import { createRoleFromPreset, PERMISSIONS, ROLE_PRESETS } from './permissions';

const workspaceAdminV1PermissionIds = [
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
] as const;

test('copies a preset into a concrete role with provenance', () => {
  const role = createRoleFromPreset('speaker_reviewer', {
    id: 'role_custom_reviewer',
    workspaceId: 'workspace_summit',
    name: 'APAC proposal reviewers'
  });
  const preset = ROLE_PRESETS.find((candidate) => candidate.key === 'speaker_reviewer');
  if (!preset) throw new Error('Speaker Reviewer preset fixture is missing');

  expect(role.name).toBe('APAC proposal reviewers');
  expect(role.sourcePresetKey).toBe('speaker_reviewer');
  expect(role.sourcePresetVersion).toBe(1);
  expect(role.permissionIds).toEqual(preset.permissionIds);
  expect(role.permissionIds).not.toBe(preset.permissionIds);
});

test('registers Program Vocabulary management without widening any existing preset', () => {
  expect(PERMISSIONS.find((permission) => permission.id === 'program.vocabulary.manage'))
    .toEqual({
      id: 'program.vocabulary.manage',
      group: 'events',
      label: 'Manage program vocabulary',
      description: "Create and change an event's rooms, tracks, and formats.",
      risk: 'sensitive',
      allowedScopes: ['workspace', 'event']
    });

  const workspaceAdmin = ROLE_PRESETS.find((candidate) => candidate.key === 'workspace_admin');
  expect(workspaceAdmin?.version).toBe(1);
  expect(workspaceAdmin?.permissionIds).toEqual(workspaceAdminV1PermissionIds);
  expect(ROLE_PRESETS.every((preset) =>
    !Array.from(preset.permissionIds, String).includes('program.vocabulary.manage')
  )).toBe(true);
});

test('registers provider management without silently widening version-one presets', () => {
  expect(PERMISSIONS.find((permission) => permission.id === 'communication.provider.manage'))
    .toEqual({
      id: 'communication.provider.manage',
      group: 'communications',
      label: 'Manage email providers',
      description: 'Read and manage email provider connections, readiness, sender profiles, and routing.',
      risk: 'sensitive',
      allowedScopes: ['workspace']
    });

  expect(ROLE_PRESETS.every((preset) =>
    !Array.from(preset.permissionIds, String).includes('communication.provider.manage')
  )).toBe(true);
});
