import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import { workspaceEvents } from './sample/registry';

/**
 * The account seam behind the shell's one identity mark, and the event
 * projection behind the sidebar switcher. Tests share one in-memory
 * workspace, in order.
 */

describe('the signed-in account', () => {
	test('identity resolves from the workspace members, never hardcoded', async () => {
		const account = await api.account.current();
		expect(account.name).toBe('Jere K.');
		expect(account.email).toBe('jere@aie-demo.example');
		expect(account.pendingEmailChange).toBeNull();
	});

	test('an email change needs a complete, different address — refusals are values', async () => {
		const incomplete = await api.account.requestEmailChange('not-an-address');
		expect(incomplete.ok).toBe(false);
		if (!incomplete.ok) expect(incomplete.reason).toContain('complete email address');

		const unchanged = await api.account.requestEmailChange('JERE@aie-demo.example');
		expect(unchanged.ok).toBe(false);
		if (!unchanged.ok) expect(unchanged.reason).toContain('already your address');

		// Nothing pended on either refusal.
		expect((await api.account.current()).pendingEmailChange).toBeNull();
	});

	test('a requested change pends on both confirmations and cancel compensates it', async () => {
		const requested = await api.account.requestEmailChange('jere@next.example');
		expect(requested.ok).toBe(true);

		const pending = (await api.account.current()).pendingEmailChange;
		expect(pending).toEqual({
			newEmail: 'jere@next.example',
			confirmedCurrent: false,
			confirmedNew: false
		});
		// The account keeps its current address until both mailboxes confirm.
		expect((await api.account.current()).email).toBe('jere@aie-demo.example');

		expect((await api.account.resendEmailChange()).ok).toBe(true);

		expect((await api.account.cancelEmailChange()).ok).toBe(true);
		expect((await api.account.current()).pendingEmailChange).toBeNull();

		const resendWithoutPending = await api.account.resendEmailChange();
		expect(resendWithoutPending.ok).toBe(false);
	});
});

describe('the event projection', () => {
	test('one entry per distinct event, the active scenario marking its own', () => {
		const events = workspaceEvents();
		expect(events.length).toBe(2);

		const nyc = events.find((event) => event.id === 'evt_aie-nyc-2026');
		expect(nyc?.name).toBe('AI Engineer NYC 2026');
		expect(nyc?.current).toBe(true);
		expect(nyc?.scenarioKey).toBe('flight');

		const london = events.find((event) => event.id === 'evt_aie-london-2027');
		expect(london?.name).toBe('AI Engineer London 2027');
		expect(london?.current).toBe(false);
		expect(london?.scenarioKey).toBe('opening');
	});

	test('switching to an unknown event is refused with a reason', async () => {
		const outcome = await api.workspace.switchEvent('evt-nope');
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain('no longer exists');
	});
});

describe('creating an event', () => {
	test('refusals are values: empty name, missing dates, inverted dates', async () => {
		const unnamed = await api.workspace.createEvent({
			name: '   ',
			timezone: 'UTC',
			startDate: '2027-01-01',
			endDate: '2027-01-02'
		});
		expect(unnamed.ok).toBe(false);

		const dateless = await api.workspace.createEvent({
			name: 'DevOps Days',
			timezone: 'UTC',
			startDate: '',
			endDate: ''
		});
		expect(dateless.ok).toBe(false);

		const inverted = await api.workspace.createEvent({
			name: 'DevOps Days',
			timezone: 'UTC',
			startDate: '2027-01-02',
			endDate: '2027-01-01'
		});
		expect(inverted.ok).toBe(false);
		if (!inverted.ok) expect(inverted.reason).toContain('end date');
	});

	test('a complete request is accepted', async () => {
		const created = await api.workspace.createEvent({
			name: 'DevOps Days Helsinki 2027',
			timezone: 'Europe/Helsinki',
			startDate: '2027-09-09',
			endDate: '2027-09-10'
		});
		expect(created.ok).toBe(true);
	});
});
