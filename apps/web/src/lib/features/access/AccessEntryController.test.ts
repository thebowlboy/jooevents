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
    requestSignInLink: async () => ({ kind: 'success', data: { outcome: 'link_requested' } }),
    navigate: (path, replace) => { navigations.push([path, replace]); }
  });
  return { instance, navigations };
}

function anonymous(
  requestSignInLink: AccessEntryController['dependencies']['requestSignInLink'] = async () => ({
    kind: 'success',
    data: { outcome: 'link_requested' }
  })
) {
  const requested: string[] = [];
  const instance = new AccessEntryController({
    getContext: async () => ({ kind: 'success', data: { state: 'anonymous' } }),
    startGoogle: async () => ({ kind: 'error', error: { code: 'start_failed', retryable: true } }),
    signOut: async () => ({ kind: 'error', error: { code: 'sign_out_failed', retryable: true } }),
    requestSignInLink: async (input) => {
      requested.push(input.email);
      return requestSignInLink(input);
    },
    navigate: () => undefined
  });
  instance.setRoute({ path: '/sign-in' });
  return { instance, requested };
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

test('checking pending access preserves the screen until the refreshed context arrives', async () => {
  const pending: AccessContext = { state: 'pending_review', user: { id: 'user_ada', displayName: 'Ada' }, membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 }, workspace: { id: 'workspace_summit', name: 'Summit Operations' } };
  let requestCount = 0;
  let releaseRefresh!: (context: AccessContext) => void;
  const instance = new AccessEntryController({
    getContext: async () => {
      requestCount += 1;
      if (requestCount === 1) return { kind: 'success', data: pending };
      return new Promise((resolve) => { releaseRefresh = (context) => resolve({ kind: 'success', data: context }); });
    },
    startGoogle: async () => ({ kind: 'error', error: { code: 'start_failed', retryable: true } }),
    signOut: async () => ({ kind: 'error', error: { code: 'sign_out_failed', retryable: true } }),
    requestSignInLink: async () => ({ kind: 'success', data: { outcome: 'link_requested' } }),
    navigate: () => undefined
  });
  instance.setRoute({ path: '/access/pending' });
  await instance.resolve({ announceDelay: false });

  const refresh = instance.checkStatus();
  expect(instance.state.kind).toBe('pending_review');
  if (instance.state.kind === 'pending_review') expect(instance.state.checking).toBe(true);
  releaseRefresh(pending);
  await refresh;
  expect(instance.state.kind).toBe('pending_review');
  if (instance.state.kind === 'pending_review') expect(instance.state.checking).toBe(false);
  instance.dispose();
});

test('the resting card already holds an empty field and the notice the page arrived with', async () => {
  const { instance } = anonymous();
  instance.setRoute({ path: '/sign-in', notice: 'link_expired' });
  await instance.resolve({ announceDelay: false });
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.email).toBe('');
    expect(instance.state.busy).toBe(false);
    expect(instance.state.invalid).toBe(false);
    expect(instance.state.notice).toBe('link_expired');
  }
  instance.dispose();
});

test('a malformed address is refused locally and never reaches the server', async () => {
  const { instance, requested } = anonymous();
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@');
  await instance.requestSignInLink();
  expect(requested).toEqual([]);
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') expect(instance.state.invalid).toBe(true);
  instance.setLinkEmail('ada@example.com');
  if (instance.state.kind === 'anonymous') expect(instance.state.invalid).toBe(false);
  instance.dispose();
});

test('a requested link always confirms the same way and can be redirected to another address', async () => {
  const { instance, requested } = anonymous();
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('  ada@example.com  ');
  await instance.requestSignInLink();
  expect(requested).toEqual(['ada@example.com']);
  expect(instance.state.kind).toBe('link_requested');
  if (instance.state.kind === 'link_requested') expect(instance.state.email).toBe('ada@example.com');
  instance.useDifferentAddress();
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.email).toBe('ada@example.com');
    expect(instance.state.busy).toBe(false);
    expect(instance.state.invalid).toBe(false);
  }
  instance.dispose();
});

test('correcting the address after a refusal clears the refusal with it', async () => {
  const { instance } = anonymous(async () => ({ kind: 'error', error: { code: 'rate_limited', retryable: true } }));
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@example.com');
  await instance.requestSignInLink();
  instance.setLinkEmail('ada@example.co');
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.requestError).toBeUndefined();
    expect(instance.state.invalid).toBe(false);
  }
  instance.dispose();
});

test('the field is closed to edits while its own request is in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { instance, requested } = anonymous(async () => {
    await gate;
    return { kind: 'success', data: { outcome: 'link_requested' } };
  });
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@example.com');
  const request = instance.requestSignInLink();
  instance.setLinkEmail('someone.else@example.com');
  if (instance.state.kind === 'anonymous') expect(instance.state.email).toBe('ada@example.com');
  release();
  await request;
  expect(requested).toEqual(['ada@example.com']);
  expect(instance.state.kind).toBe('link_requested');
  if (instance.state.kind === 'link_requested') expect(instance.state.email).toBe('ada@example.com');
  instance.dispose();
});

test('signing out lands on the same open card, not on a reveal step', async () => {
  const blocked: AccessContext = { state: 'blocked', code: 'suspended' };
  const navigations: Array<[string, boolean]> = [];
  const instance = new AccessEntryController({
    getContext: async () => ({ kind: 'success', data: blocked }),
    startGoogle: async () => ({ kind: 'error', error: { code: 'start_failed', retryable: true } }),
    signOut: async () => ({ kind: 'success', data: { signedOut: true } }),
    requestSignInLink: async () => ({ kind: 'success', data: { outcome: 'link_requested' } }),
    navigate: (path, replace) => { navigations.push([path, replace]); }
  });
  instance.setRoute({ path: '/access/blocked' });
  await instance.resolve({ announceDelay: false });
  await instance.signOut();
  expect(navigations).toContainEqual(['/sign-in?notice=signed_out', false]);
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.email).toBe('');
    expect(instance.state.busy).toBe(false);
    expect(instance.state.invalid).toBe(false);
    expect(instance.state.notice).toBe('signed_out');
  }
  instance.dispose();
});

test('a refused link request keeps the typed address and its structured reason', async () => {
  const { instance } = anonymous(async () => ({ kind: 'error', error: { code: 'rate_limited', retryable: true } }));
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@example.com');
  await instance.requestSignInLink();
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.busy).toBe(false);
    expect(instance.state.email).toBe('ada@example.com');
    expect(instance.state.requestError?.code).toBe('rate_limited');
  }
  instance.dispose();
});

test('one in-flight request answers a repeated submit', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { instance } = anonymous(async () => {
    calls += 1;
    await gate;
    return { kind: 'success', data: { outcome: 'link_requested' } };
  });
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@example.com');
  const first = instance.requestSignInLink();
  await instance.requestSignInLink();
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') expect(instance.state.busy).toBe(true);
  release();
  await first;
  expect(calls).toBe(1);
  expect(instance.state.kind).toBe('link_requested');
  instance.dispose();
});

test('an in-flight link request holds the provider control too', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { instance } = anonymous(async () => {
    await gate;
    return { kind: 'success', data: { outcome: 'link_requested' } };
  });
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@example.com');
  const request = instance.requestSignInLink();
  await instance.startGoogle();
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.busy).toBe(true);
    expect(instance.state.actionError).toBeUndefined();
  }
  release();
  await request;
  expect(instance.state.kind).toBe('link_requested');
  instance.dispose();
});

test('starting Google from the confirmation keeps that surface when the provider fails', async () => {
  const { instance } = anonymous();
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@example.com');
  await instance.requestSignInLink();
  await instance.startGoogle();
  expect(instance.state.kind).toBe('link_requested');
  if (instance.state.kind === 'link_requested') {
    expect(instance.state.email).toBe('ada@example.com');
    expect(instance.state.actionError?.code).toBe('start_failed');
  }
  instance.dispose();
});

test('the typed address survives a failed Google attempt', async () => {
  const { instance } = anonymous();
  await instance.resolve({ announceDelay: false });
  instance.setLinkEmail('ada@example.com');
  await instance.startGoogle();
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.email).toBe('ada@example.com');
    expect(instance.state.actionError?.code).toBe('start_failed');
  }
  instance.dispose();
});
