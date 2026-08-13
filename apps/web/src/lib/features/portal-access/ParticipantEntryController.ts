import type { ParticipantContext } from '@jooevents/contracts';
import type { ParticipantEntryDependencies } from '$lib/api/composition/entry-dependencies';
import type { ApiResult, SafeApiError } from '$lib/api/client';
import { isEmailShaped } from '$lib/features/access/link-request';
import type { ParticipantEntryNotice, ParticipantLinkFailure } from './copy';
import { safeParticipantReturnPath } from './return-path';

/**
 * Participant entry state. One email field serves first arrival and return, so
 * there is no branch here that depends on whether the address is already known
 * — the acknowledgement is the same either way. `active` is a navigation
 * result, never a rendered screen, and a transport failure stays a transport
 * failure instead of collapsing into "signed out".
 */
export type ParticipantEntryState =
  | { readonly kind: 'resolving'; readonly delayed: boolean }
  | {
      readonly kind: 'anonymous';
      readonly email: string;
      readonly invalid: boolean;
      readonly notice?: ParticipantEntryNotice;
      readonly requestError?: SafeApiError;
    }
  | { readonly kind: 'link_request_busy'; readonly email: string }
  | { readonly kind: 'link_requested'; readonly email: string }
  | { readonly kind: 'completing'; readonly delayed: boolean }
  | { readonly kind: 'callback_error'; readonly outcome: ParticipantLinkFailure }
  | { readonly kind: 'context_error'; readonly error: SafeApiError };

export interface ParticipantEntryControllerDependencies extends ParticipantEntryDependencies {
  readonly navigate: (path: string, replace: boolean) => void | Promise<void>;
}

const SIGN_IN_PATH = '/portal/sign-in';

export class ParticipantEntryController {
  #state: ParticipantEntryState = { kind: 'resolving', delayed: false };
  #listeners = new Set<(state: ParticipantEntryState) => void>();
  #abort?: AbortController;
  #resolverDelay?: ReturnType<typeof setTimeout>;
  #generation = 0;
  #currentPath = SIGN_IN_PATH;
  #returnTo = '/portal';
  #notice?: ParticipantEntryNotice;
  #disposed = false;

  constructor(readonly dependencies: ParticipantEntryControllerDependencies) {}

  get state() {
    return this.#state;
  }

  subscribe(listener: (state: ParticipantEntryState) => void) {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  setRoute(input: {
    readonly path: string;
    readonly returnTo?: string | null;
    readonly notice?: ParticipantEntryNotice;
  }) {
    this.#currentPath = input.path;
    this.#returnTo = safeParticipantReturnPath(input.returnTo);
    this.#notice = input.notice;
  }

  async resolve(options: { readonly announceDelay?: boolean } = {}) {
    if (this.#disposed) return;
    this.#abort?.abort('superseded');
    const abort = new AbortController();
    this.#abort = abort;
    const generation = ++this.#generation;
    this.#set({ kind: 'resolving', delayed: false });
    this.#resolverDelay = setTimeout(
      () => {
        if (generation === this.#generation && this.#state.kind === 'resolving') {
          this.#set({ kind: 'resolving', delayed: true });
        }
      },
      options.announceDelay === false ? 10_000 : 300
    );

    let result: ApiResult<ParticipantContext>;
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
    await this.#acceptContext(result.data);
  }

  /** The clicked link's proof, exchanged once; the token never reaches view state. */
  async completeLink(token: string | null) {
    if (this.#disposed) return;
    if (!token) {
      await this.resolve();
      return;
    }
    const generation = ++this.#generation;
    this.#set({ kind: 'completing', delayed: false });
    this.#resolverDelay = setTimeout(() => {
      if (generation === this.#generation && this.#state.kind === 'completing') {
        this.#set({ kind: 'completing', delayed: true });
      }
    }, 300);
    const result = await this.dependencies.completeLink({ token });
    if (generation !== this.#generation || this.#disposed) return;
    this.#clearResolverDelay();
    if (result.kind === 'error') {
      this.#set({ kind: 'context_error', error: result.error });
      return;
    }
    if (result.data.outcome === 'signed_in') {
      await this.resolve({ announceDelay: false });
      return;
    }
    this.#set({ kind: 'callback_error', outcome: result.data.outcome });
  }

  setEmail(email: string) {
    const current = this.#state;
    if (current.kind !== 'anonymous') return;
    this.#set({ ...current, email, invalid: false, requestError: undefined });
  }

  async requestLink() {
    const current = this.#state;
    if (current.kind !== 'anonymous') return;
    const email = current.email.trim();
    if (!isEmailShaped(email)) {
      this.#set({ ...current, email, invalid: true, requestError: undefined });
      return;
    }
    this.#set({ kind: 'link_request_busy', email });
    const result = await this.dependencies.requestLink({ email });
    if (this.#disposed || this.#state.kind !== 'link_request_busy') return;
    if (result.kind === 'error') {
      this.#set({ kind: 'anonymous', email, invalid: false, requestError: result.error });
      return;
    }
    this.#set({ kind: 'link_requested', email });
  }

  useDifferentAddress() {
    const current = this.#state;
    if (current.kind !== 'link_requested') return;
    this.#set({ kind: 'anonymous', email: current.email, invalid: false });
  }

  async backToSignIn() {
    if (this.#state.kind !== 'callback_error') return;
    await this.dependencies.navigate(SIGN_IN_PATH, false);
  }

  dispose() {
    this.#disposed = true;
    this.#generation += 1;
    this.#abort?.abort('disposed');
    this.#clearResolverDelay();
    this.#listeners.clear();
  }

  async #acceptContext(context: ParticipantContext) {
    switch (context.state) {
      case 'active':
        await this.dependencies.navigate(this.#returnTo, true);
        return;
      case 'expired':
        this.#set({ kind: 'anonymous', email: '', invalid: false, notice: 'session_expired' });
        if (this.#currentPath !== SIGN_IN_PATH) await this.dependencies.navigate(SIGN_IN_PATH, true);
        return;
      case 'anonymous':
        this.#set({
          kind: 'anonymous',
          email: '',
          invalid: false,
          ...(this.#notice ? { notice: this.#notice } : {})
        });
        if (this.#currentPath !== SIGN_IN_PATH) await this.dependencies.navigate(SIGN_IN_PATH, true);
    }
  }

  #set(state: ParticipantEntryState) {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  #clearResolverDelay() {
    if (this.#resolverDelay) clearTimeout(this.#resolverDelay);
    this.#resolverDelay = undefined;
  }
}
