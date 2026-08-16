import { describe, expect, test } from 'bun:test';
import { parseInstant } from '@jooevents/kernel';
import { createDevFixtureClock } from './dev-fixture-clock';

describe('dev fixture clock', () => {
  test('moves monotonically through a relative fixture timeline and then relinquishes control', () => {
    const clock = createDevFixtureClock(new Date('2026-08-17T12:00:00.000Z'));

    expect(clock.moveToDaysBeforeAnchor(63)).toBe(parseInstant('2026-06-15T12:00:00.000Z'));
    expect(clock.moveToDaysBeforeAnchor(35)).toBe(parseInstant('2026-07-13T12:00:00.000Z'));
    expect(() => clock.moveToDaysBeforeAnchor(36)).toThrow('dev_fixture_clock_cannot_move_backwards');

    const beforeReset = Date.now();
    clock.useSystemTime();
    const restored = Date.parse(clock.now());
    expect(restored).toBeGreaterThanOrEqual(beforeReset);
    expect(restored).toBeLessThanOrEqual(Date.now());
  });

  test('refuses an unbounded fixture offset', () => {
    const clock = createDevFixtureClock(new Date('2026-08-17T12:00:00.000Z'));
    expect(() => clock.moveToDaysBeforeAnchor(367)).toThrow('dev_fixture_clock_days_invalid');
    expect(() => clock.moveToDaysBeforeAnchor(1.5)).toThrow('dev_fixture_clock_days_invalid');
  });
});
