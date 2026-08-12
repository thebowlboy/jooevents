/**
 * The waiting contract shared by every in-flight operation in the product.
 *
 * A wait is not a boolean. Treating it as one produces the two failures this
 * module exists to prevent: a resolver that appears and vanishes inside a blink
 * (a strobe), and a resolver that appears so eagerly it replaces content the
 * person could still have been reading.
 *
 * Three tiers, and a floor:
 *
 * - `idle`    nothing in flight, or in flight for less time than a person reads
 *             as a wait at all.
 * - `pending` long enough to deserve a status treatment.
 * - `slow`    long enough to deserve representative structure and an
 *             announcement naming what is being fetched.
 *
 * Once a treatment becomes visible it stays visible for `minVisibleMs`, even if
 * the work finishes immediately afterwards. A grace delay alone only moves the
 * strobe: work that lands at 150ms would otherwise flash a resolver for 10ms.
 * Delay-then-hold is what makes the sequence flicker-free at every duration.
 */

/**
 * Below this, a completed wait should leave no trace on screen. Research on
 * perceived responsiveness puts the "instant" ceiling around 100ms; the extra
 * margin covers a warm client-side route whose module is already cached.
 */
export const PENDING_GRACE_MS = 140;

/**
 * Once shown, a treatment holds for at least this long. Long enough to register
 * as a deliberate state rather than a glitch, short enough not to feel padded.
 */
export const PENDING_MIN_VISIBLE_MS = 320;

/**
 * Past this, a quiet signal is no longer enough: the surface owes representative
 * structure and a polite announcement.
 */
export const PENDING_SLOW_MS = 900;

export type PendingPhase = 'idle' | 'pending' | 'slow';

export interface PendingState {
  /** The current tier. */
  readonly phase: PendingPhase;
  /** True from `pending` onward, including the minimum-visible tail. */
  readonly visible: boolean;
}

export interface PendingOptions {
  /** Floor on how long the treatment stays up once shown. */
  minVisibleMs?: number;
}

/**
 * Track a boolean "in flight" source as a three-tier phase with a visibility
 * floor.
 *
 * Call during component initialisation: the internal effect is owned by the
 * calling component and its timers are cleared on supersession and teardown, so
 * a superseded wait can never strand a resolver on screen.
 */
export function trackPending(
  isActive: () => boolean,
  { minVisibleMs = 0 }: PendingOptions = {}
): PendingState {
  let phase = $state<PendingPhase>('idle');

  // Plain mirrors, deliberately not reactive: the effect below decides using
  // them, so reading them cannot make the effect depend on its own writes.
  let currentPhase: PendingPhase = 'idle';
  let shownAt = 0;

  const enter = (next: PendingPhase) => {
    if (next !== 'idle' && currentPhase === 'idle') shownAt = Date.now();
    currentPhase = next;
    phase = next;
  };

  $effect(() => {
    if (isActive()) {
      const toPending = setTimeout(() => enter('pending'), PENDING_GRACE_MS);
      const toSlow = setTimeout(() => enter('slow'), PENDING_SLOW_MS);
      return () => {
        clearTimeout(toPending);
        clearTimeout(toSlow);
      };
    }

    // The work finished. If nothing was ever shown, leave without a trace.
    if (currentPhase === 'idle') return;

    const remaining = minVisibleMs - (Date.now() - shownAt);
    if (remaining <= 0) {
      enter('idle');
      return;
    }

    const release = setTimeout(() => enter('idle'), remaining);
    return () => clearTimeout(release);
  });

  return {
    get phase() {
      return phase;
    },
    get visible() {
      return phase !== 'idle';
    }
  };
}
