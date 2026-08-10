import { expect, test } from 'bun:test';
import { accessContextSchema, createAccessReservationSchema } from './access';

test('access context is a closed discriminated union', () => {
  expect(accessContextSchema.safeParse({ state: 'active', user: { id: 'user_ada', displayName: 'Ada' }, workspace: { id: 'workspace_summit', name: 'Summit Operations' } }).success).toBe(true);
  expect(accessContextSchema.safeParse({ state: 'active', permissions: ['*'] }).success).toBe(false);
});

test('pending review includes the safe workspace and cannot claim another status', () => {
  const base = {
    state: 'pending_review',
    user: { id: 'user_ada', displayName: 'Ada Lovelace' },
    membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 },
    workspace: { id: 'workspace_summit', name: 'Summit Operations' }
  };
  expect(accessContextSchema.safeParse(base).success).toBe(true);
  expect(accessContextSchema.safeParse({ ...base, membership: { ...base.membership, status: 'active' } }).success).toBe(false);
});

test('reservation requests reject malformed emails and unreasoned overrides', () => {
  const result = createAccessReservationSchema.safeParse({
    workspaceId: 'workspace_summit',
    email: 'not-an-email',
    roleAssignments: [],
    permissionOverrides: [{ permissionId: 'submission.score', effect: 'deny', scope: { kind: 'workspace' }, reason: '' }]
  });
  expect(result.success).toBe(false);
});
