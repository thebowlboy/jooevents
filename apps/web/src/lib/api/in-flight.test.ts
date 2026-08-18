import { describe, expect, test } from 'bun:test';
import { createInFlightSlot, shareInFlight } from './in-flight';

function hold<Value = void>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<Value>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe('shareInFlight', () => {
	test('a caller that arrives while a load is open joins it; the next read is fresh', async () => {
		let loads = 0;
		const gate = hold();
		const started = hold();
		const slot = createInFlightSlot<number>();
		const load = async () => {
			loads += 1;
			started.resolve();
			await gate.promise;
			return loads;
		};
		const first = shareInFlight(slot, load);
		await started.promise;
		const second = shareInFlight(slot, load);
		expect(loads).toBe(1);
		gate.resolve();
		expect(await Promise.all([first, second])).toEqual([1, 1]);
		expect(await shareInFlight(slot, load)).toBe(2);
		expect(loads).toBe(2);
	});

	test('independent slots do not join each other', async () => {
		let loads = 0;
		const gate = hold();
		const load = async () => {
			const ticket = (loads += 1);
			await gate.promise;
			return ticket;
		};
		const left = shareInFlight(createInFlightSlot<number>(), load);
		const right = shareInFlight(createInFlightSlot<number>(), load);
		expect(loads).toBe(2);
		gate.resolve();
		expect(await Promise.all([left, right])).toEqual([1, 2]);
	});

	test('every waiter sees the same rejection and the slot clears', async () => {
		const gate = hold();
		const slot = createInFlightSlot<number>();
		const load = async () => {
			await gate.promise;
			throw new Error('boom');
		};
		const first = shareInFlight(slot, load);
		const second = shareInFlight(slot, load);
		gate.resolve();
		await expect(first).rejects.toThrow('boom');
		await expect(second).rejects.toThrow('boom');
		expect(await shareInFlight(slot, async () => 7)).toBe(7);
	});
});
