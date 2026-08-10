import { expect, test } from 'bun:test';
import { createRoleFromPreset, ROLE_PRESETS } from './permissions';

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
