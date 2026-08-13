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
  | { readonly kind: 'resolving'; readonly delayed: boolean }
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
}

function withActionError(surface: EntrySurfaceState, error: SafeApiError): EntrySurfaceState {
  return { ...surface, actionError: error };
}

export class AccessEntryController {
  #state: AccessEntryState = { kind: 'resolving', delayed: false };
  #listeners = new Set<(state: AccessEntryState) => void>();
  #abort?: AbortController;
  #resolverDelay?: ReturnType<typeof setTimeout>;
  #retry?: ReturnType<typeof setTimeout>;
  #generation = 0;
  #provisioningStartedAt?: number;
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
    if (!retainedState) {
      this.#set({ kind: 'resolving', delayed: false });
      this.#resolverDelay = setTimeout(() => {
        if (generation === this.#generation && this.#state.kind === 'resolving') this.#set({ kind: 'resolving', delayed: true });
      }, options.announceDelay === false ? 10_000 : 300);
    }

    let result: ApiResult<AccessContext>;
    try {
      result = await this.dependencies.getContext({ signal: abort.signal });
    } catch {
      if (abort.signal.aborted) return;
      result = { kind: 'error', error: { code: 'request_cancelled', retryable: true } };
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
        } else {
          this.#set(retainedState);
        }
        return;
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
    if (this.#state.kind === 'provisioning' || this.#state.kind === 'pending_review' || this.#state.kind === 'blocked') {
      void this.resolve({ announceDelay: false, retainState: true });
    }
  }

  dispose() {
    this.#disposed = true;
    this.#generation += 1;
    this.#abort?.abort('disposed');
    this.#clearResolverDelay();
    this.#clearRetry();
    this.#listeners.clear();
  }

  async #acceptContext(context: AccessContext, correlationId?: string) {
    switch (context.state) {
      case 'anonymous':
        this.#provisioningStartedAt = undefined;
        this.#set({ kind: 'anonymous', email: '', busy: false, invalid: false, ...(this.#notice ? { notice: this.#notice } : {}) });
        if (this.#currentPath !== '/sign-in') await this.dependencies.navigate('/sign-in', true);
        return;
      case 'active':
        this.#provisioningStartedAt = undefined;
        await this.dependencies.navigate(this.#returnTo, true);
        return;
      case 'pending_review':
        this.#provisioningStartedAt = undefined;
        this.#set({ kind: 'pending_review', user: context.user, workspace: context.workspace, checking: false });
        if (this.#currentPath !== '/access/pending') await this.dependencies.navigate('/access/pending', true);
        return;
      case 'blocked':
        this.#provisioningStartedAt = undefined;
        this.#set({ kind: 'blocked', code: context.code, ...(correlationId ? { correlationId } : {}) });
        if (this.#currentPath !== '/access/blocked') await this.dependencies.navigate('/access/blocked', true);
        return;
      case 'provisioning': {
        const now = (this.dependencies.now ?? Date.now)();
        this.#provisioningStartedAt ??= now;
        const delayed = now - this.#provisioningStartedAt >= 15_000;
        const retryAfterSeconds = Math.min(30, Math.max(1, context.retryAfterSeconds));
        this.#set({ kind: 'provisioning', retryAfterSeconds, correlationId: context.correlationId, delayed });
        if (this.#currentPath !== '/auth/complete') await this.dependencies.navigate('/auth/complete', true);
        if (!delayed && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
          this.#retry = setTimeout(() => void this.resolve({ announceDelay: false }), retryAfterSeconds * 1000);
        }
      }
    }
  }

  #set(state: AccessEntryState) {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
  #clearResolverDelay() { if (this.#resolverDelay) clearTimeout(this.#resolverDelay); this.#resolverDelay = undefined; }
  #clearRetry() { if (this.#retry) clearTimeout(this.#retry); this.#retry = undefined; }
}
