import type { AccessContext, SafeUser, SafeWorkspace } from '@jooevents/contracts';
import type { OperatorEntryDependencies } from '$lib/api/composition/entry-dependencies';
import type { ApiResult, SafeApiError } from '$lib/api/client';
import type { EntryNotice } from './copy';
import { isEmailShaped } from './link-request';
import { safeOperatorReturnPath } from './return-path';

export type PendingState = {
  readonly kind: 'pending_review';
  readonly user: SafeUser;
  readonly workspace: SafeWorkspace;
  readonly checking: boolean;
  readonly checkError?: SafeApiError;
};
export type BlockedState = { readonly kind: 'blocked'; readonly code: 'suspended' | 'deactivated' | 'not_admitted'; readonly correlationId?: string };

/**
 * The resting card. Both sign-in choices stand in it at once: the magic-link
 * field carries `email`/`busy`/`invalid`/`requestError`, while `actionError`
 * stays the provider's.
 */
export type AnonymousState = {
  readonly kind: 'anonymous';
  readonly email: string;
  readonly busy: boolean;
  readonly invalid: boolean;
  readonly notice?: EntryNotice;
  readonly actionError?: SafeApiError;
  readonly requestError?: SafeApiError;
};
/** One acknowledgement for every address, matched or not. */
export type LinkRequestedState = { readonly kind: 'link_requested'; readonly email: string; readonly actionError?: SafeApiError };
export type EntrySurfaceState = AnonymousState | LinkRequestedState;

export type AccessEntryState =
  /* `awaiting` names which of the two server questions this resolver composition
     is holding for: who this browser is, or whether that identity is admitted
     here. It carries no outcome claim either way; the admission variant names
     only the work in flight until the server supplies a concrete result. */
  | { readonly kind: 'resolving'; readonly delayed: boolean; readonly awaiting?: 'identity' | 'admission' }
  | EntrySurfaceState
  /* Carries the surface it started from — including any previous failure and
     the typed address — so nothing disappears during the attempt; only success
     (navigation) or a new failure ends it. */
  | { readonly kind: 'starting_google'; readonly previous: EntrySurfaceState }
  | { readonly kind: 'provisioning'; readonly retryAfterSeconds: number; readonly correlationId: string; readonly delayed: boolean }
  | PendingState
  | BlockedState
  | { readonly kind: 'context_error'; readonly error: SafeApiError }
  | { readonly kind: 'sign_out_error'; readonly previous: PendingState | BlockedState; readonly error: SafeApiError };

export interface AccessEntryDependencies extends OperatorEntryDependencies {
  readonly navigate: (path: string, replace: boolean) => void | Promise<void>;
  readonly now?: () => number;
  /** Deferred work, injectable so the waiting cadence is testable without wall clock. */
  readonly delay?: (run: () => void, ms: number) => () => void;
  /**
   * Best-effort warming of the destination this sign-in is heading for, called
   * at most once and never awaited. It may not fail the sign-in, delay it, or
   * observe its outcome.
   */
  readonly warmDestination?: (path: string) => void | Promise<unknown>;
}

function withActionError(surface: EntrySurfaceState, error: SafeApiError): EntrySurfaceState {
  return { ...surface, actionError: error };
}

/* Admission is a separate commit from authentication, so a completed link or
   provider return can land here while that commit is still in flight. The three
   numbers below keep the screen that reports it from charging every ordinary
   sign-in for the rare case it exists to describe. */

/**
 * How long admission may take before the interstitial paints.
 *
 * The surface already holds that a wait under roughly 300ms is not worth
 * naming — that is the resolver's grace. Admission is measured against the same
 * precedent, but it is also racing its own first re-check, which is answered at
 * ~250ms plus one round trip: painting at 300ms would reliably put the screen
 * up a few dozen milliseconds before the answer that removes it, which is the
 * flash this rule exists to prevent. Two of those quiet windows clears the fast
 * probe's answer, so the identity paints only once admission has actually
 * missed it.
 */
const ADMISSION_QUIET_MS = 600;

/**
 * The first re-checks after a provisioning answer, before the server's own
 * `retryAfterSeconds` takes over. A commit that finished in 100ms should not
 * cost a flat server-suggested pause; two fast probes is the whole optimisation,
 * and the cap is what keeps a genuinely slow admission from being hammered.
 */
const ADMISSION_PROBE_MS = [250, 750] as const;

/** After this, provisioning stops re-checking itself and asks the person. */
const ADMISSION_DELAYED_MS = 15_000;

export class AccessEntryController {
  #state: AccessEntryState = { kind: 'resolving', delayed: false, awaiting: 'identity' };
  #listeners = new Set<(state: AccessEntryState) => void>();
  #abort?: AbortController;
  /** True while a context read is awaiting its answer; a paint defers to it. */
  #inFlight = false;
  #resolverDelay?: () => void;
  #retry?: () => void;
  #admissionPaint?: () => void;
  #generation = 0;
  #provisioningStartedAt?: number;
  /** Fast probes already spent in this admission episode. */
  #admissionProbes = 0;
  /** The latest provisioning answer, so a delayed paint uses real evidence. */
  #admissionAnswer?: { readonly retryAfterSeconds: number; readonly correlationId: string };
  #warmed = false;
  #currentPath = '/';
  #returnTo = '/app';
  #notice?: EntryNotice;
  #disposed = false;

  constructor(readonly dependencies: AccessEntryDependencies) {}

  get state() { return this.#state; }

  subscribe(listener: (state: AccessEntryState) => void) {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  setRoute(input: { readonly path: string; readonly returnTo?: string | null; readonly notice?: EntryNotice }) {
    this.#currentPath = input.path;
    this.#returnTo = safeOperatorReturnPath(input.returnTo);
    this.#notice = input.notice;
  }

  async resolve(options: { readonly announceDelay?: boolean; readonly retainState?: boolean; readonly reportFailure?: boolean } = {}) {
    if (this.#disposed) return;
    this.#clearRetry();
    this.#abort?.abort('superseded');
    const abort = new AbortController();
    this.#abort = abort;
    const generation = ++this.#generation;
    const retainedState = options.retainState ? this.#state : undefined;
    /* An admission episode already owns the composition — the compact status hold or
       the painted interstitial. Its own re-checks must not blank back to the
       neutral resolver and repaint: the wait they ask about is the same wait,
       and a screen that restarts every couple of seconds is the flicker this
       cadence exists to remove. A failure still fails (below); only the
       repaint is suppressed. */
    const holding = !retainedState && this.#provisioningStartedAt !== undefined
      && (this.#state.kind === 'provisioning' || this.#state.kind === 'resolving');
    if (!retainedState && !holding) {
      /* Path decides only until an answer does. Once admission is known to be
         in flight, the hold takes the admission composition wherever it stands,
         so the panel does not hold a tall sign-in card over a wait that
         resolves into a compact screen and drop ~190px when it paints. */
      const awaiting = this.#currentPath === '/auth/complete'
        || this.#provisioningStartedAt !== undefined
        ? 'admission'
        : 'identity';
      this.#set({ kind: 'resolving', delayed: false, awaiting });
      this.#resolverDelay = this.#schedule(() => {
        if (generation === this.#generation && this.#state.kind === 'resolving') {
          this.#set({ kind: 'resolving', delayed: true, awaiting });
        }
      }, options.announceDelay === false ? 10_000 : 300);
    }

    let result: ApiResult<AccessContext>;
    this.#inFlight = true;
    try {
      result = await this.dependencies.getContext({ signal: abort.signal });
    } catch {
      if (abort.signal.aborted) return;
      result = { kind: 'error', error: { code: 'request_cancelled', retryable: true } };
    } finally {
      if (generation === this.#generation) this.#inFlight = false;
    }
    if (generation !== this.#generation || abort.signal.aborted || this.#disposed) return;
    this.#clearResolverDelay();
    if (result.kind === 'error') {
      if (retainedState) {
        if (retainedState.kind === 'pending_review') {
          this.#set({
            ...retainedState,
            checking: false,
            ...(options.reportFailure ? { checkError: result.error } : {})
          });
          return;
        }
        /* Every state but an admission wait keeps its server-backed view: a
           failed refresh is not evidence that blocked or pending changed. An
           admission wait is the exception, because holding it would keep
           implying work that nobody is doing — it becomes the honest retryable
           failure instead. */
        if (retainedState.kind !== 'provisioning' && !this.#isAdmissionHold(retainedState)) {
          this.#set(retainedState);
          return;
        }
      }
      this.#set({ kind: 'context_error', error: result.error });
      return;
    }
    await this.#acceptContext(result.data, result.correlationId);
  }

  async startGoogle() {
    const previous = this.#state;
    if (previous.kind !== 'anonymous' && previous.kind !== 'link_requested') return;
    if (previous.kind === 'anonymous' && previous.busy) return;
    this.#set({ kind: 'starting_google', previous });
    const result = await this.dependencies.startGoogle({ provider: 'google', returnTo: this.#returnTo });
    if (result.kind === 'error') this.#set(withActionError(previous, result.error));
  }

  setLinkEmail(email: string) {
    const current = this.#state;
    if (current.kind !== 'anonymous' || current.busy) return;
    this.#set({ ...current, email, invalid: false, requestError: undefined });
  }

  async requestSignInLink() {
    const current = this.#state;
    if (current.kind !== 'anonymous' || current.busy) return;
    const email = current.email.trim();
    if (!isEmailShaped(email)) {
      this.#set({ ...current, email, invalid: true, requestError: undefined });
      return;
    }
    this.#set({ ...current, email, busy: true, invalid: false, requestError: undefined });
    const result = await this.dependencies.requestSignInLink({ email });
    const pending = this.#state;
    if (this.#disposed || pending.kind !== 'anonymous' || !pending.busy) return;
    if (result.kind === 'error') {
      this.#set({ ...pending, busy: false, requestError: result.error });
      return;
    }
    this.#set({ kind: 'link_requested', email });
  }

  useDifferentAddress() {
    const current = this.#state;
    if (current.kind !== 'link_requested') return;
    this.#set({ kind: 'anonymous', email: current.email, busy: false, invalid: false });
  }

  async signOut() {
    const previous = this.#state.kind === 'sign_out_error' ? this.#state.previous : this.#state;
    if (previous.kind !== 'pending_review' && previous.kind !== 'blocked') return;
    const result = await this.dependencies.signOut();
    if (result.kind === 'error') {
      this.#set({ kind: 'sign_out_error', previous, error: result.error });
      return;
    }
    await this.dependencies.navigate('/sign-in?notice=signed_out', false);
    this.#set({ kind: 'anonymous', email: '', busy: false, invalid: false, notice: 'signed_out' });
  }

  async checkStatus() {
    const current = this.#state.kind === 'sign_out_error' ? this.#state.previous : this.#state;
    if (current.kind !== 'pending_review' || current.checking) return;
    this.#set({ ...current, checking: true, checkError: undefined });
    await this.resolve({ retainState: true, reportFailure: true });
  }

  handleVisibility(visible: boolean) {
    if (!visible) {
      this.#clearRetry();
      return;
    }
    /* A compact admission hold is as much a live wait as the painted one, so
       returning to the tab re-checks it too rather than resuming a timer that
       the hidden tab already cancelled. */
    if (
      this.#state.kind === 'provisioning' ||
      this.#state.kind === 'pending_review' ||
      this.#state.kind === 'blocked' ||
      this.#isAdmissionHold(this.#state)
    ) {
      void this.resolve({ announceDelay: false, retainState: true });
    }
  }

  dispose() {
    this.#disposed = true;
    this.#generation += 1;
    this.#abort?.abort('disposed');
    this.#clearResolverDelay();
    this.#clearRetry();
    this.#clearAdmissionPaint();
    this.#listeners.clear();
  }

  async #acceptContext(context: AccessContext, correlationId?: string) {
    switch (context.state) {
      case 'anonymous':
        this.#endAdmission();
        this.#set({ kind: 'anonymous', email: '', busy: false, invalid: false, ...(this.#notice ? { notice: this.#notice } : {}) });
        if (this.#currentPath !== '/sign-in') await this.dependencies.navigate('/sign-in', true);
        return;
      case 'active':
        this.#endAdmission();
        await this.dependencies.navigate(this.#returnTo, true);
        return;
      case 'pending_review':
        this.#endAdmission();
        this.#set({ kind: 'pending_review', user: context.user, workspace: context.workspace, checking: false });
        if (this.#currentPath !== '/access/pending') await this.dependencies.navigate('/access/pending', true);
        return;
      case 'blocked':
        this.#endAdmission();
        this.#set({ kind: 'blocked', code: context.code, ...(correlationId ? { correlationId } : {}) });
        if (this.#currentPath !== '/access/blocked') await this.dependencies.navigate('/access/blocked', true);
        return;
      case 'provisioning': {
        const now = this.#now();
        const first = this.#provisioningStartedAt === undefined;
        this.#provisioningStartedAt ??= now;
        const waited = now - this.#provisioningStartedAt;
        const delayed = waited >= ADMISSION_DELAYED_MS;
        const retryAfterSeconds = Math.min(30, Math.max(1, context.retryAfterSeconds));
        this.#admissionAnswer = { retryAfterSeconds, correlationId: context.correlationId };
        /* Identity is verified but admission is not decided, so this is the one
           moment the destination is both known and not yet reachable: warm it
           here so its load overlaps the wait instead of following it. */
        if (first) this.#warmDestination();
        if (this.#state.kind === 'provisioning' || waited >= ADMISSION_QUIET_MS || delayed) {
          this.#clearAdmissionPaint();
          this.#set({ kind: 'provisioning', retryAfterSeconds, correlationId: context.correlationId, delayed });
        } else {
          /* Still inside the quiet window: hold the compact status composition and let
             the clock, not this answer, decide whether the wait ever earns a
             screen. */
          this.#armAdmissionPaint(ADMISSION_QUIET_MS - waited);
        }
        if (this.#currentPath !== '/auth/complete') await this.dependencies.navigate('/auth/complete', true);
        if (!delayed && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
          /* Fast first, then the server's own hint. The fast probes are capped,
             so a slow admission settles onto `retryAfterSeconds` and — once
             delayed — onto the person's Retry. */
          const probe = ADMISSION_PROBE_MS[this.#admissionProbes] ?? retryAfterSeconds * 1000;
          this.#admissionProbes += 1;
          this.#retry = this.#schedule(() => void this.resolve({ announceDelay: false }), probe);
        }
      }
    }
  }

  /** True while the compact status composition is standing in for an admission wait. */
  #isAdmissionHold(state: AccessEntryState) {
    return state.kind === 'resolving' && this.#provisioningStartedAt !== undefined;
  }

  #armAdmissionPaint(after: number) {
    if (this.#admissionPaint) return;
    const generation = this.#generation;
    this.#admissionPaint = this.#schedule(() => {
      this.#admissionPaint = undefined;
      const answer = this.#admissionAnswer;
      /* Paints only over its own hold: by now the answer may have become an
         error, a decision, or a departure, and none of those is provisioning.
         The generation check makes a stale timer harmless — it is the one piece
         of deferred work that could otherwise repaint over a fresher check.
         And a paint is never allowed to land while a re-check is IN FLIGHT:
         the window can elapse a few milliseconds before the answer that would
         have removed the screen, which manufactures the exact flash this
         threshold exists to prevent. The in-flight answer re-arms it if the
         wait really is still going. */
      if (this.#disposed || !answer || generation !== this.#generation) return;
      if (this.#inFlight || !this.#isAdmissionHold(this.#state)) return;
      this.#set({
        kind: 'provisioning',
        retryAfterSeconds: answer.retryAfterSeconds,
        correlationId: answer.correlationId,
        delayed: this.#now() - (this.#provisioningStartedAt ?? 0) >= ADMISSION_DELAYED_MS
      });
    }, Math.max(0, after));
  }

  /**
   * One warming attempt per entry, fired and forgotten. A rejection is not a
   * sign-in outcome, so it is swallowed rather than surfaced.
   */
  #warmDestination() {
    if (this.#warmed) return;
    this.#warmed = true;
    const warm = this.dependencies.warmDestination;
    if (!warm) return;
    try {
      void Promise.resolve(warm(this.#returnTo)).catch(() => undefined);
    } catch {
      /* A warming failure can never affect the sign-in it was meant to speed up. */
    }
  }

  #endAdmission() {
    /* A decision ends the episode's deferred work too: a retry armed behind an
       awaited navigation would otherwise fire after `blocked` or `pending` has
       been painted and blank that decided screen back to the neutral resolver. */
    this.#clearRetry();
    this.#provisioningStartedAt = undefined;
    this.#admissionProbes = 0;
    this.#admissionAnswer = undefined;
    this.#clearAdmissionPaint();
  }

  #now() { return (this.dependencies.now ?? Date.now)(); }

  #schedule(run: () => void, ms: number): () => void {
    const schedule = this.dependencies.delay;
    if (schedule) return schedule(run, ms);
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  }

  #set(state: AccessEntryState) {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
  #clearResolverDelay() { this.#resolverDelay?.(); this.#resolverDelay = undefined; }
  #clearRetry() { this.#retry?.(); this.#retry = undefined; }
  #clearAdmissionPaint() { this.#admissionPaint?.(); this.#admissionPaint = undefined; }
}
