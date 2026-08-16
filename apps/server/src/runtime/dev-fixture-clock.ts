import { parseInstant, type Clock, type Instant } from '@jooevents/kernel';

const DAY_MS = 86_400_000;

/**
 * Process-local clock controller for deterministic dev-fixture assembly.
 *
 * It is deliberately not an HTTP capability and is never returned from the
 * live runtime. The seeded-playground entry is the only production source
 * caller: it keeps the controller while the runtime receives only `Clock`.
 */
export interface DevFixtureClock extends Clock {
  /** Moves fixture time to an earlier point relative to the captured anchor. */
  moveToDaysBeforeAnchor(days: number): Instant;
  /** Drops fixture authority and resumes wall-clock time. */
  useSystemTime(): void;
}

export function createDevFixtureClock(anchor = new Date()): DevFixtureClock {
  const anchorMs = anchor.getTime();
  if (!Number.isFinite(anchorMs)) throw new TypeError('dev_fixture_clock_anchor_invalid');
  let fixed: Instant | undefined;
  let lastFixtureMs: number | undefined;

  return Object.freeze({
    now(): Instant {
      return fixed ?? parseInstant(new Date().toISOString());
    },
    moveToDaysBeforeAnchor(days: number): Instant {
      if (!Number.isSafeInteger(days) || days < 0 || days > 366) {
        throw new TypeError('dev_fixture_clock_days_invalid');
      }
      const nextMs = anchorMs - days * DAY_MS;
      if (lastFixtureMs !== undefined && nextMs < lastFixtureMs) {
        throw new TypeError('dev_fixture_clock_cannot_move_backwards');
      }
      fixed = parseInstant(new Date(nextMs).toISOString());
      lastFixtureMs = nextMs;
      return fixed;
    },
    useSystemTime(): void {
      fixed = undefined;
      lastFixtureMs = undefined;
    }
  });
}
