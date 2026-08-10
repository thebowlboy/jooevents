import { expect, test } from 'bun:test';
import type { AccessContext } from '@jooevents/contracts';
import { AccessEntryController } from './AccessEntryController';

function controller(context: AccessContext | 'error') {
  const navigations: Array<[string, boolean]> = [];
  const instance = new AccessEntryController({
    getContext: async () => context === 'error'
      ? { kind: 'error', error: { code: 'network_unavailable', retryable: true } }
      : { kind: 'success', data: context },
    startGoogle: async () => ({ kind: 'error', error: { code: 'start_failed', retryable: true } }),
    signOut: async () => ({ kind: 'error', error: { code: 'sign_out_failed', retryable: true } }),
    navigate: (path, replace) => { navigations.push([path, replace]); }
  });
  return { instance, navigations };
}

test('a context failure remains an error and never exposes anonymous login', async () => {
  const { instance } = controller('error');
  await instance.resolve({ announceDelay: false });
  expect(instance.state.kind).toBe('context_error');
  instance.dispose();
});

test('active context is navigation and not a rendered entry state', async () => {
  const { instance, navigations } = controller({ state: 'active', user: { id: 'user_ada', displayName: 'Ada' }, workspace: { id: 'workspace_summit', name: 'Summit Operations' } });
  instance.setRoute({ path: '/sign-in', returnTo: '/app/schedule' });
  await instance.resolve({ announceDelay: false });
  expect(navigations).toEqual([['/app/schedule', true]]);
  expect(instance.state.kind).toBe('resolving');
  instance.dispose();
});

test('failed sign-out preserves the pending server-backed view', async () => {
  const pending: AccessContext = { state: 'pending_review', user: { id: 'user_ada', displayName: 'Ada' }, membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 }, workspace: { id: 'workspace_summit', name: 'Summit Operations' } };
  const { instance } = controller(pending);
  instance.setRoute({ path: '/access/pending' });
  await instance.resolve({ announceDelay: false });
  await instance.signOut();
  expect(instance.state.kind).toBe('sign_out_error');
  if (instance.state.kind === 'sign_out_error') expect(instance.state.previous.kind).toBe('pending_review');
  instance.dispose();
});
