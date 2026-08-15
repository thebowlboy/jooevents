import { describePortFailure } from './port-failure';

/**
 * The three answers a live read can give, kept disjoint on purpose.
 *
 * The eternal-loading defect is a surface rendering `resolving` where the truth
 * is `unavailable`: a read that can never be answered wearing the costume of one
 * that has not been answered yet. A skeleton is a promise that something is
 * coming. When the port has already rejected, that promise is a lie, and the
 * person keeps waiting on a request nobody is still making.
 *
 * Modelling the three states as one union forces every consumer to branch on
 * all three, so "it failed" cannot silently reuse the "still waiting" branch.
 */
export type LiveReadState<T> =
	| { readonly kind: 'resolving' }
	/**
	 * `refreshFailure` is a later read failing over data already on screen. The
	 * rows stay — they are still the last thing known to be true — and the
	 * failure is stated beside them rather than blanking the surface.
	 */
	| { readonly kind: 'resolved'; readonly value: T; readonly refreshFailure?: string }
	| { readonly kind: 'unavailable'; readonly message: string; readonly retryable: boolean };

/**
 * One re-triggerable read of one port capability, holding the three states
 * above and the two ordering guarantees every re-triggerable loader needs:
 *
 * - **Newest wins.** Every request carries a ticket; a response whose ticket is
 *   no longer current is dropped. A slow first answer can never overwrite the
 *   fast second one.
 * - **No double-fire.** `read()` while a request is open joins that request
 *   instead of opening another, so a popover reopened twice, a nav change
 *   landing beside a mount effect, or a double-clicked retry all stay one
 *   request.
 *
 * Deliberately rune-free plain TypeScript: the ordering and failure rules are
 * the part that was untested, and they are testable here without a component
 * harness. A component owns the reactive mirror of `state`, not these rules.
 */
export class LiveRead<T> {
	readonly #source: () => Promise<T>;
	readonly #fallback: string | undefined;
	readonly #onChange: ((state: LiveReadState<T>) => void) | undefined;

	#state: LiveReadState<T> = { kind: 'resolving' };
	#ticket = 0;
	#inFlight: Promise<void> | null = null;

	constructor(input: {
		readonly read: () => Promise<T>;
		/** Reviewed copy for a failure that carried none of its own. */
		readonly fallback?: string;
		readonly onChange?: (state: LiveReadState<T>) => void;
	}) {
		this.#source = input.read;
		this.#fallback = input.fallback;
		this.#onChange = input.onChange;
	}

	get state(): LiveReadState<T> {
		return this.#state;
	}

	/** True while a request is open, for a quiet in-place refresh indicator. */
	get pending(): boolean {
		return this.#inFlight !== null;
	}

	/**
	 * Asks for the value, joining a request that is already open. This is the
	 * call every trigger uses — mount, a popover's `onreveal`, a nav change.
	 */
	read(): Promise<void> {
		return this.#inFlight ?? this.refresh();
	}

	/**
	 * Opens a new request even if one is already in flight, and drops whatever
	 * the older one eventually says. This is the explicit retry and the
	 * "something changed underneath, re-read now" call.
	 */
	refresh(): Promise<void> {
		const ticket = (this.#ticket += 1);
		const run = (async () => {
			try {
				const value = await this.#source();
				if (ticket !== this.#ticket) return;
				this.#set({ kind: 'resolved', value });
			} catch (error) {
				if (ticket !== this.#ticket) return;
				const failure = describePortFailure(error, this.#fallback);
				const held = this.#state;
				this.#set(
					held.kind === 'resolved'
						? { kind: 'resolved', value: held.value, refreshFailure: failure.message }
						: { kind: 'unavailable', message: failure.message, retryable: failure.retryable }
				);
			} finally {
				// Only the current request may clear the slot; a superseded one
				// leaving would advertise the live request as finished.
				if (ticket === this.#ticket) this.#inFlight = null;
			}
		})();
		this.#inFlight = run;
		return run;
	}

	#set(next: LiveReadState<T>): void {
		this.#state = next;
		this.#onChange?.(next);
	}
}
