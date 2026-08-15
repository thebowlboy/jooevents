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

/**
 * A hand-driven clock and timer queue. Nothing here waits on wall time: a test
 * runs the exact deferred work it is making a claim about, and running it moves
 * the clock the controller reads, so elapsed-time decisions are real decisions
 * rather than approximations of them.
 */
function scheduler() {
  const queue: Array<{ at: number; ms: number; run: () => void; spent: boolean }> = [];
  const clock = { ms: 0 };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    now: () => clock.ms,
    delay: (run: () => void, ms: number) => {
      const entry = { at: clock.ms, ms, run, spent: false };
      queue.push(entry);
      return () => { entry.spent = true; };
    },
    /** Every deferred call still live, by the delay it was asked to wait. */
    pending: () => queue.filter((entry) => !entry.spent).map((entry) => entry.ms),
    /** Every delay this entry ever asked for, in the order it asked. */
    scheduled: () => queue.map((entry) => entry.ms),
    /** Only the calls still armed — what would actually fire from here. */
    live: () => queue.filter((entry) => !entry.spent).map((entry) => entry.ms),
    /** Run the earliest live call scheduled for exactly this delay. */
    async run(ms: number) {
      const entry = queue.find((candidate) => !candidate.spent && candidate.ms === ms);
      if (!entry) throw new Error(`no deferred call is waiting ${ms}ms; live: ${queue.filter((c) => !c.spent).map((c) => c.ms).join(', ')}`);
      entry.spent = true;
      clock.ms = Math.max(clock.ms, entry.at + entry.ms);
      entry.run();
      await flush();
    },
    flush
  };
}

const provisioning = (retryAfterSeconds = 2): AccessContext => ({
  state: 'provisioning',
  retryAfterSeconds,
  correlationId: 'corr_admission'
});

const active: AccessContext = {
  state: 'active',
  user: { id: 'user_ada', displayName: 'Ada' },
  workspace: { id: 'workspace_summit', name: 'Summit Operations' }
};

/** A sign-in landing on the callback route, with every answer scripted. */
function callback(answers: Array<AccessContext | 'error'>, options: { readonly warm?: (path: string) => void | Promise<unknown> } = {}) {
  const clock = scheduler();
  const seen: string[] = [];
  const navigations: Array<[string, boolean]> = [];
  const warmed: string[] = [];
  let asked = 0;
  const instance = new AccessEntryController({
    getContext: async () => {
      const answer = answers[Math.min(asked, answers.length - 1)];
      asked += 1;
      return answer === 'error'
        ? { kind: 'error', error: { code: 'upstream_failed', retryable: true } }
        : { kind: 'success', data: answer };
    },
    startGoogle: async () => ({ kind: 'error', error: { code: 'start_failed', retryable: true } }),
    signOut: async () => ({ kind: 'error', error: { code: 'sign_out_failed', retryable: true } }),
    requestSignInLink: async () => ({ kind: 'success', data: { outcome: 'link_requested' } }),
    navigate: (path, replace) => { navigations.push([path, replace]); },
    now: clock.now,
    delay: clock.delay,
    warmDestination: (path) => {
      warmed.push(path);
      return options.warm?.(path);
    }
  });
  instance.subscribe((state) => seen.push(state.kind));
  instance.setRoute({ path: '/auth/complete' });
  return { instance, clock, seen, navigations, warmed, asked: () => asked };
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

test('a served pending_review context rests on the pending surface without a poll loop', async () => {
  const pending: AccessContext = { state: 'pending_review', user: { id: 'user_ada', displayName: 'Ada' }, membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 }, workspace: { id: 'workspace_summit', name: 'Summit Operations' } };
  let requestCount = 0;
  const navigations: Array<[string, boolean]> = [];
  const instance = new AccessEntryController({
    getContext: async () => {
      requestCount += 1;
      return { kind: 'success', data: pending };
    },
    startGoogle: async () => ({ kind: 'error', error: { code: 'start_failed', retryable: true } }),
    signOut: async () => ({ kind: 'error', error: { code: 'sign_out_failed', retryable: true } }),
    requestSignInLink: async () => ({ kind: 'success', data: { outcome: 'link_requested' } }),
    navigate: (path, replace) => { navigations.push([path, replace]); }
  });
  instance.setRoute({ path: '/auth/complete' });
  await instance.resolve({ announceDelay: false });
  expect(instance.state.kind).toBe('pending_review');
  if (instance.state.kind === 'pending_review') {
    expect(instance.state.workspace.name).toBe('Summit Operations');
    expect(instance.state.checking).toBe(false);
  }
  expect(navigations).toEqual([['/access/pending', true]]);
  // Pending is a resting state: no automatic re-fetch may be scheduled the way
  // provisioning schedules one — the state must not turn into a refresh loop.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(requestCount).toBe(1);
  expect(instance.state.kind).toBe('pending_review');
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

test('an admission that commits inside the quiet window never paints the interstitial', async () => {
  const { instance, clock, seen, navigations } = callback([provisioning(), active]);
  await instance.resolve();
  // The answer is in hand and it is "not yet" — which this composition already
  // says by saying nothing. Nothing about the state claims provisioning.
  expect(instance.state).toEqual({ kind: 'resolving', delayed: false, awaiting: 'admission' });
  expect(clock.pending()).toContain(250);
  await clock.run(250);
  expect(navigations).toEqual([['/app', true]]);
  expect(seen).not.toContain('provisioning');
  instance.dispose();
});

test('an admission that misses the quiet window is named, with its real support code', async () => {
  const { instance, clock } = callback([provisioning()]);
  await instance.resolve();
  expect(instance.state.kind).toBe('resolving');
  await clock.run(600);
  expect(instance.state).toEqual({
    kind: 'provisioning',
    retryAfterSeconds: 2,
    correlationId: 'corr_admission',
    delayed: false
  });
  instance.dispose();
});

test('the re-check is fast twice, then the server says when', async () => {
  const { instance, clock, seen } = callback([provisioning(2)]);
  await instance.resolve();
  await clock.run(600);
  await clock.run(250);
  await clock.run(750);
  await clock.run(2000);
  // In order: the resolver's own 300ms grace (cancelled by the first answer),
  // the quiet window that decides whether this wait earns a screen, two fast
  // probes, then the server's own hint for as long as it keeps answering.
  expect(clock.scheduled()).toEqual([300, 600, 250, 750, 2000, 2000]);
  // One neutral composition for the whole wait: the re-checks under it never
  // blank the panel back to the resolver and repaint it.
  expect(seen.filter((kind) => kind === 'resolving')).toHaveLength(2);
  instance.dispose();
});

test('a wait that keeps saying "not yet" escalates and then stops asking by itself', async () => {
  const { instance, clock } = callback([provisioning(2)]);
  await instance.resolve();
  await clock.run(600);
  await clock.run(250);
  await clock.run(750);
  for (let guard = 0; guard < 20 && instance.state.kind === 'provisioning' && !instance.state.delayed; guard += 1) {
    await clock.run(2000);
  }
  expect(instance.state).toMatchObject({ kind: 'provisioning', delayed: true, correlationId: 'corr_admission' });
  // Escalation hands the wait to the person: no timer is left running, so a
  // rolled-back admission cannot poll for ever.
  expect(clock.pending()).toEqual([]);
  instance.dispose();
});

test('an admission re-check that fails becomes a failure, not a wait that keeps implying progress', async () => {
  const { instance, clock } = callback([provisioning(), 'error']);
  await instance.resolve();
  await clock.run(250);
  expect(instance.state.kind).toBe('context_error');
  instance.dispose();
});

test('a hidden tab stops asking, and returning to it asks again without repainting the wait', async () => {
  const { instance, clock, seen, asked } = callback([provisioning(), provisioning(), active]);
  await instance.resolve();
  expect(asked()).toBe(1);
  instance.handleVisibility(false);
  expect(clock.pending()).not.toContain(250);
  instance.handleVisibility(true);
  await clock.flush();
  expect(asked()).toBe(2);
  // Still the wordless hold, and the cadence resumed rather than restarted.
  expect(instance.state.kind).toBe('resolving');
  expect(clock.pending()).toContain(750);
  expect(seen).not.toContain('provisioning');
  instance.dispose();
});

test('the destination warms once, while admission is still deciding', async () => {
  const { instance, clock, warmed } = callback([provisioning(), provisioning(), active]);
  instance.setRoute({ path: '/auth/complete', returnTo: '/app/schedule' });
  await instance.resolve();
  expect(warmed).toEqual(['/app/schedule']);
  await clock.run(250);
  await clock.run(750);
  expect(warmed).toEqual(['/app/schedule']);
  instance.dispose();
});

test('a destination reached only through admission still warms once, and only once', async () => {
  // Honest about what warming can and cannot know: at the moment admission is
  // in flight, nobody knows yet whether it ends active, pending, or blocked.
  // Warming fires there because that is the ONLY moment the destination is both
  // known and not yet reachable. It preloads route code, never data, so it can
  // issue no protected request — a person who turns out to be pending has cost
  // the product one cached module and learned nothing.
  const provisioning: AccessContext = {
    state: 'provisioning', retryAfterSeconds: 2, correlationId: 'corr_warm'
  };
  const pending: AccessContext = {
    state: 'pending_review',
    user: { id: 'user_ada', displayName: 'Ada' },
    membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 },
    workspace: { id: 'workspace_summit', name: 'Summit Operations' }
  };
  const { instance, warmed, clock } = callback([provisioning, pending]);
  await instance.resolve();
  expect(warmed.length).toBe(1);
  await clock.run(250);
  expect(warmed.length).toBe(1);
  instance.dispose();
});

test('an outcome decided without any admission wait is never warmed', async () => {
  const outcomes: Array<AccessContext | 'error'> = [
    { state: 'pending_review', user: { id: 'user_ada', displayName: 'Ada' }, membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 }, workspace: { id: 'workspace_summit', name: 'Summit Operations' } },
    { state: 'blocked', code: 'not_admitted' },
    { state: 'anonymous' },
    'error'
  ];
  for (const outcome of outcomes) {
    const { instance, warmed } = callback([outcome]);
    await instance.resolve();
    expect(warmed).toEqual([]);
    instance.dispose();
  }
});

test('a warming failure is not a sign-in outcome', async () => {
  for (const warm of [
    () => Promise.reject(new Error('preload unavailable')),
    () => { throw new Error('no router'); }
  ]) {
    const { instance, clock, navigations, seen } = callback([provisioning(), active], { warm });
    await instance.resolve();
    expect(instance.state.kind).toBe('resolving');
    await clock.run(250);
    expect(navigations).toEqual([['/app', true]]);
    expect(seen).not.toContain('context_error');
    instance.dispose();
  }
});

test('the paint never lands after the wait it described has ended', async () => {
  // The quiet window and the fast probe are two timers racing. If the paint
  // fires after the probe already carried the person onward, it paints a screen
  // over a departure — the flash the threshold exists to prevent, arriving from
  // the other side.
  const provisioning: AccessContext = {
    state: 'provisioning', retryAfterSeconds: 2, correlationId: 'corr_slow'
  };
  const { instance, seen, clock, navigations } = callback([provisioning, active]);
  await instance.resolve();
  expect(seen).not.toContain('provisioning');
  await clock.run(250);
  expect(navigations.at(-1)?.[0]).toBe('/app');
  // The departure takes the pending paint with it: there is no armed timer left
  // that could put a screen up over a person who has already arrived.
  expect(clock.live()).toEqual([]);
  expect(seen).not.toContain('provisioning');
  instance.dispose();
});

test('a decision cancels the re-check armed behind its own navigation', async () => {
  // The retry is scheduled before `navigate` is awaited, so without cancelling
  // it, it fires after `blocked` has painted and blanks a decided screen back
  // to the neutral resolver.
  const provisioning: AccessContext = {
    state: 'provisioning', retryAfterSeconds: 2, correlationId: 'corr_decided'
  };
  const blocked: AccessContext = { state: 'blocked', code: 'not_admitted' };
  const { instance, clock } = callback([provisioning, blocked]);
  await instance.resolve();
  await clock.run(250);
  expect(instance.state.kind).toBe('blocked');
  // Nothing armed survives the decision — the retry scheduled before `navigate`
  // was awaited would otherwise blank this decided screen back to the resolver.
  expect(clock.live()).toEqual([]);
  instance.dispose();
});
