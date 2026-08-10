import type { AccessContext, SafeUser, SafeWorkspace } from '@jooevents/contracts';
import type { ApiResult, SafeApiError } from '$lib/api/client';
import type { EntryNotice } from './copy';
import { safeOperatorReturnPath } from './return-path';

export type PendingState = { readonly kind: 'pending_review'; readonly user: SafeUser; readonly workspace: SafeWorkspace };
export type BlockedState = { readonly kind: 'blocked'; readonly code: 'suspended' | 'deactivated' | 'not_admitted'; readonly correlationId?: string };

export type AccessEntryState =
  | { readonly kind: 'resolving'; readonly delayed: boolean }
  | { readonly kind: 'anonymous'; readonly notice?: EntryNotice; readonly actionError?: SafeApiError }
  /* Carries the previous failure through the attempt so the message never
     flickers away on retry; only success (navigation) or a new failure ends it. */
  | { readonly kind: 'starting_google'; readonly actionError?: SafeApiError }
  | { readonly kind: 'provisioning'; readonly retryAfterSeconds: number; readonly correlationId: string; readonly delayed: boolean }
  | PendingState
  | BlockedState
  | { readonly kind: 'context_error'; readonly error: SafeApiError }
  | { readonly kind: 'sign_out_error'; readonly previous: PendingState | BlockedState; readonly error: SafeApiError };

export interface AccessEntryDependencies {
  readonly getContext: (options?: { readonly signal?: AbortSignal }) => Promise<ApiResult<AccessContext>>;
  readonly startGoogle: (input: { readonly provider: 'google'; readonly returnTo: string }) => Promise<ApiResult<{ readonly redirecting: true }>>;
  readonly signOut: () => Promise<ApiResult<{ readonly signedOut: true }>>;
  readonly navigate: (path: string, replace: boolean) => void | Promise<void>;
  readonly now?: () => number;
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

  async resolve(options: { readonly announceDelay?: boolean } = {}) {
    if (this.#disposed) return;
    this.#clearRetry();
    this.#abort?.abort('superseded');
    const abort = new AbortController();
    this.#abort = abort;
    const generation = ++this.#generation;
    this.#set({ kind: 'resolving', delayed: false });
    this.#resolverDelay = setTimeout(() => {
      if (generation === this.#generation && this.#state.kind === 'resolving') this.#set({ kind: 'resolving', delayed: true });
    }, options.announceDelay === false ? 10_000 : 300);

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
      this.#set({ kind: 'context_error', error: result.error });
      return;
    }
    await this.#acceptContext(result.data, result.correlationId);
  }

  async startGoogle() {
    if (this.#state.kind !== 'anonymous') return;
    const previous = this.#state;
    this.#set({ kind: 'starting_google', ...(previous.actionError ? { actionError: previous.actionError } : {}) });
    const result = await this.dependencies.startGoogle({ provider: 'google', returnTo: this.#returnTo });
    if (result.kind === 'error') this.#set({ ...previous, actionError: result.error });
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
    this.#set({ kind: 'anonymous', notice: 'signed_out' });
  }

  async checkStatus() { await this.resolve(); }

  handleVisibility(visible: boolean) {
    if (!visible) {
      this.#clearRetry();
      return;
    }
    if (this.#state.kind === 'provisioning' || this.#state.kind === 'pending_review' || this.#state.kind === 'blocked') void this.resolve({ announceDelay: false });
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
        this.#set({ kind: 'anonymous', ...(this.#notice ? { notice: this.#notice } : {}) });
        if (this.#currentPath !== '/sign-in') await this.dependencies.navigate('/sign-in', true);
        return;
      case 'active':
        this.#provisioningStartedAt = undefined;
        await this.dependencies.navigate(this.#returnTo, true);
        return;
      case 'pending_review':
        this.#provisioningStartedAt = undefined;
        this.#set({ kind: 'pending_review', user: context.user, workspace: context.workspace });
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
