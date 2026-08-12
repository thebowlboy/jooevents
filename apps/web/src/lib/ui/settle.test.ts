import { describe, expect, test } from 'bun:test';
import { createSettler } from './settle';
import { PENDING_GRACE_MS } from './pending.svelte';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createSettler', () => {
	test('runs once, after the delay', async () => {
		let runs = 0;
		const settler = createSettler(20);
		settler.schedule(() => (runs += 1));
		expect(runs).toBe(0);
		await wait(45);
		expect(runs).toBe(1);
	});

	// The behaviour the whole helper exists for: typing eight characters must
	// cost one action, not eight.
	test('a burst of schedules produces one run, the last one', async () => {
		const ran: string[] = [];
		const settler = createSettler(20);
		for (const value of ['k', 'ku', 'kub', 'kube']) settler.schedule(() => ran.push(value));
		await wait(45);
		expect(ran).toEqual(['kube']);
	});

	test('flush runs the pending action immediately and only once', async () => {
		const ran: string[] = [];
		const settler = createSettler(1000);
		settler.schedule(() => ran.push('now'));
		settler.flush();
		expect(ran).toEqual(['now']);
		await wait(30);
		expect(ran).toEqual(['now']);
	});

	test('flush with nothing pending is a no-op', () => {
		expect(() => createSettler(20).flush()).not.toThrow();
	});

	// A superseded action that still fires is how results for a deleted word
	// land after results for the current one.
	test('cancel drops the pending action', async () => {
		let runs = 0;
		const settler = createSettler(20);
		settler.schedule(() => (runs += 1));
		settler.cancel();
		await wait(45);
		expect(runs).toBe(0);
	});

	test('defaults to the grace threshold, so a fast answer shows no waiting state', () => {
		expect(PENDING_GRACE_MS).toBe(140);
		let runs = 0;
		const settler = createSettler();
		settler.schedule(() => (runs += 1));
		settler.flush();
		expect(runs).toBe(1);
	});
});
