import { expect, test } from 'bun:test';
import type { ParticipantContext, SignInLinkCallbackResult } from '@jooevents/contracts';
import type { ApiResult } from '$lib/api/client';
import { ParticipantEntryController } from './ParticipantEntryController';

const participant = { id: 'par_amara', displayName: 'Amara Okafor', email: 'amara@example.com' };
const event = {
  id: 'evt_summit',
  name: 'Summit 2026',
  timezone: 'Europe/Berlin',
  cfpClosesAt: '2026-09-20T21:59:00.000Z',
  closePolicy: 'hard' as const
};

function build(options: {
  readonly contexts?: readonly (ParticipantContext | 'error')[];
  readonly request?: () => Promise<ApiResult<{ readonly outcome: 'link_requested' }>>;
  readonly complete?: () => Promise<ApiResult<SignInLinkCallbackResult>>;
} = {}) {
  const contexts = [...(options.contexts ?? ['anonymous' as const].map((state) => ({ state })))];
  const navigations: Array<[string, boolean]> = [];
  const requested: string[] = [];
  const tokens: string[] = [];
  const instance = new ParticipantEntryController({
    getContext: async () => {
      const next = contexts.length > 1 ? contexts.shift() : contexts[0];
      return next === 'error'
        ? { kind: 'error', error: { code: 'network_unavailable', retryable: true } }
        : { kind: 'success', data: next as ParticipantContext };
    },
    requestLink: async (input) => {
      requested.push(input.email);
      return options.request
        ? options.request()
        : { kind: 'success', data: { outcome: 'link_requested' } };
    },
    completeLink: async (input) => {
      tokens.push(input.token);
      return options.complete
        ? options.complete()
        : { kind: 'success', data: { outcome: 'signed_in' } };
    },
    signOut: async () => ({ kind: 'success', data: { signedOut: true } }),
    navigate: (path, replace) => {
      navigations.push([path, replace]);
    }
  });
  instance.setRoute({ path: '/portal/sign-in' });
  return { instance, navigations, requested, tokens };
}

test('an active participant context is navigation, never a rendered entry state', async () => {
  const { instance, navigations } = build({ contexts: [{ state: 'active', participant, event }] });
  instance.setRoute({ path: '/portal/sign-in', returnTo: '/portal/submissions/sub_1' });
  await instance.resolve({ announceDelay: false });
  expect(navigations).toEqual([['/portal/submissions/sub_1', true]]);
  instance.dispose();
});

test('an expired session asks for the address again instead of claiming a failure', async () => {
  const { instance } = build({ contexts: [{ state: 'expired' }] });
  await instance.resolve({ announceDelay: false });
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') expect(instance.state.notice).toBe('session_expired');
  instance.dispose();
});

test('a context failure stays a failure and never renders as signed out', async () => {
  const { instance } = build({ contexts: ['error'] });
  await instance.resolve({ announceDelay: false });
  expect(instance.state.kind).toBe('context_error');
  instance.dispose();
});

test('the acknowledgement is identical whoever asks and whatever the address', async () => {
  const first = build();
  await first.instance.resolve({ announceDelay: false });
  first.instance.setEmail('amara@example.com');
  await first.instance.requestLink();
  const second = build();
  await second.instance.resolve({ announceDelay: false });
  second.instance.setEmail('nobody@example.invalid');
  await second.instance.requestLink();
  expect(first.instance.state.kind).toBe('link_requested');
  expect(second.instance.state.kind).toBe('link_requested');
  expect(first.requested).toEqual(['amara@example.com']);
  first.instance.dispose();
  second.instance.dispose();
});

test('a malformed address is refused locally and never reaches the server', async () => {
  const { instance, requested } = build();
  await instance.resolve({ announceDelay: false });
  instance.setEmail('amara@example');
  await instance.requestLink();
  expect(requested).toEqual([]);
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') expect(instance.state.invalid).toBe(true);
  instance.dispose();
});

test('a refused request keeps the typed address and its structured reason', async () => {
  const { instance } = build({
    request: async () => ({ kind: 'error', error: { code: 'rate_limited', retryable: true } })
  });
  await instance.resolve({ announceDelay: false });
  instance.setEmail('amara@example.com');
  await instance.requestLink();
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.email).toBe('amara@example.com');
    expect(instance.state.requestError?.code).toBe('rate_limited');
  }
  instance.dispose();
});

test('the confirmation returns to the field when another address is wanted', async () => {
  const { instance } = build();
  await instance.resolve({ announceDelay: false });
  instance.setEmail('amara@example.com');
  await instance.requestLink();
  instance.useDifferentAddress();
  expect(instance.state.kind).toBe('anonymous');
  if (instance.state.kind === 'anonymous') {
    expect(instance.state.email).toBe('amara@example.com');
    expect(instance.state.invalid).toBe(false);
  }
  instance.dispose();
});

test('a completed link resolves the participant session and enters the portal', async () => {
  const { instance, navigations, tokens } = build({
    contexts: [{ state: 'active', participant, event }]
  });
  instance.setRoute({ path: '/portal/auth/complete' });
  await instance.completeLink('token_value');
  expect(tokens).toEqual(['token_value']);
  expect(navigations).toEqual([['/portal', true]]);
  instance.dispose();
});

test('each closed link outcome renders as itself, with no judgement about the address', async () => {
  for (const outcome of ['link_expired', 'link_used', 'link_invalid'] as const) {
    const { instance, navigations } = build({ complete: async () => ({ kind: 'success', data: { outcome } }) });
    instance.setRoute({ path: '/portal/auth/complete' });
    await instance.completeLink('token_value');
    expect(instance.state.kind).toBe('callback_error');
    if (instance.state.kind === 'callback_error') expect(instance.state.outcome).toBe(outcome);
    expect(navigations).toEqual([]);
    await instance.backToSignIn();
    expect(navigations).toEqual([['/portal/sign-in', false]]);
    instance.dispose();
  }
});

test('a completion transport failure is a failure, not a rejected link', async () => {
  const { instance } = build({
    complete: async () => ({ kind: 'error', error: { code: 'network_unavailable', retryable: true } })
  });
  instance.setRoute({ path: '/portal/auth/complete' });
  await instance.completeLink('token_value');
  expect(instance.state.kind).toBe('context_error');
  instance.dispose();
});

test('a completion route reached without proof resolves the ordinary context', async () => {
  const { instance, tokens, navigations } = build({ contexts: [{ state: 'anonymous' }] });
  instance.setRoute({ path: '/portal/auth/complete' });
  await instance.completeLink(null);
  expect(tokens).toEqual([]);
  expect(instance.state.kind).toBe('anonymous');
  expect(navigations).toEqual([['/portal/sign-in', true]]);
  instance.dispose();
});
