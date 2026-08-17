import { beforeAll, describe, expect, test } from 'bun:test';
import { api } from './workspace';
import type { Submission, TrayKey } from './types';

/**
 * A held scope is only true until something writes.
 *
 * These run against the real API rather than the residency module in isolation,
 * because what they are guarding is not the cache — it is that every mutation
 * reaches it. That is the same shape as the failure the freshness design set out
 * to avoid: not "does invalidation work", but "did someone add a write path and
 * forget". Each case asserts through a *subsequent read*, which is the only way
 * to tell the difference.
 */

let subject: Submission;
let origin: TrayKey;

async function trayOf(id: string): Promise<TrayKey | null> {
	for (const tray of ['inbox', 'set-aside', 'late', 'spam'] as TrayKey[]) {
		const page = await api.submissions.list({ tray });
		if (page.rows.some((row) => row.id === id)) return tray;
	}
	return null;
}

beforeAll(async () => {
	const page = await api.submissions.list({ tray: 'inbox' });
	subject = page.rows[0]!;
	origin = subject.tray;
	expect(subject).toBeDefined();
});

describe('a mutation is visible to the next read', () => {
	test('setAside', async () => {
		await api.submissions.setAside([subject.id]);
		expect(await trayOf(subject.id)).toBe('set-aside');
	});

	test('returnToInbox', async () => {
		await api.submissions.returnToInbox([subject.id]);
		expect(await trayOf(subject.id)).toBe('inbox');
	});

	test('markSpam', async () => {
		await api.submissions.markSpam([subject.id]);
		expect(await trayOf(subject.id)).toBe('spam');
	});

	test('notSpam', async () => {
		await api.submissions.notSpam([subject.id]);
		expect(await trayOf(subject.id)).toBe('inbox');
	});

	// These two change a row without moving a tray, so they cannot ride the
	// shared count helper and have to invalidate themselves.
	//
	// Both assert a *transition* from the value the row actually starts with.
	// Asserting a fixed value is how a guard like this quietly stops guarding:
	// the flight row already carries `accepted`, so `toBe('accepted')` passed
	// whether or not the write was ever seen.
	async function readBack(id: string, tray: TrayKey): Promise<Submission | undefined> {
		const page = await api.submissions.list({ tray });
		return page.rows.find((row) => row.id === id);
	}

	test('decisions.decide', async () => {
		const before = await readBack(subject.id, origin);
		const next = before?.decision === 'declined' ? 'waitlisted' : 'declined';
		await api.decisions.decide([subject.id], next);
		expect((await readBack(subject.id, origin))?.decision).toBe(next);
		expect((await readBack(subject.id, origin))?.decision).not.toBe(before?.decision);
	});

	test('decisions.notify', async () => {
		// `decide` clears it, so the flip to true is always a real change.
		await api.decisions.decide([subject.id], 'accepted');
		expect((await readBack(subject.id, origin))?.notified).toBe(false);
		await api.decisions.notify([subject.id], 'Decision');
		expect((await readBack(subject.id, origin))?.notified).toBe(true);
	});
});

describe('the two modes agree', () => {
	// The seam is only worth having if both sides answer the same. They share one
	// selection function precisely so this cannot drift, and this asserts the
	// sharing actually holds end to end.
	test('a resident answer matches a freshly scoped one', async () => {
		const queries = [
			{ tray: 'inbox' as TrayKey },
			{ tray: 'inbox' as TrayKey, search: 'a' },
			{ tray: 'inbox' as TrayKey, search: 'kubernetes' },
			{ tray: 'spam' as TrayKey }
		];
		for (const query of queries) {
			const first = await api.submissions.list(query);
			// Two explicit forward actions return the row to its current inbox
			// state while forcing the resident snapshot to rebuild.
			await api.submissions.setAside([subject.id]);
			await api.submissions.returnToInbox([subject.id]);
			const second = await api.submissions.list(query);
			expect(second.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
			expect(second.search?.matched).toBe(first.search?.matched);
			expect(second.search?.scanned).toBe(first.search?.scanned);
		}
	});
});
