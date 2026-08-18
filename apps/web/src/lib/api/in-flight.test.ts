import { describe, expect, test } from 'bun:test';
import { createInFlightSlot, shareInFlight } from './in-flight';

describe('shareInFlight', () => {
	test('concurrent callers join one attempt and the next read is fresh', async () => {
		let loads = 0;
		const slot = createInFlightSlot<number>();
		const load = () => {
			loads += 1;
			return Promise.resolve(loads);
		};
		const [first, second] = await Promise.all([
			shareInFlight(slot, load),
			shareInFlight(slot, load)
		]);
		expect(first).toBe(1);
		expect(second).toBe(1);
		expect(loads).toBe(1);
		expect(await shareInFlight(slot, load)).toBe(2);
		expect(loads).toBe(2);
	});

	test('a failed attempt still clears the slot', async () => {
		const slot = createInFlightSlot<number>();
		await expect(shareInFlight(slot, async () => {
			throw new Error('boom');
		})).rejects.toThrow('boom');
		expect(await shareInFlight(slot, async () => 7)).toBe(7);
	});
});
