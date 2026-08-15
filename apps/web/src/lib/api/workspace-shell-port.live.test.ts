import { describe, expect, test } from 'bun:test';
import type { OverviewPagePort, OverviewPageSummary } from './overview-page-port';
import { createLiveWorkspaceShellPort } from './workspace-shell-live';

const summary: OverviewPageSummary = {
	event: null,
	lockedAreas: ['submissions', 'forms'],
	navCounts: {},
	arrivals: null,
	stats: [],
	attention: [],
	pipeline: [],
	deadlines: [],
	activity: [],
	trays: [],
	sections: {
		attention: { kind: 'unavailable', message: 'Unavailable' },
		pipeline: { kind: 'unavailable', message: 'Unavailable' },
		deadlines: { kind: 'unavailable', message: 'Unavailable' },
		activity: { kind: 'available' },
		trays: { kind: 'unavailable', message: 'Unavailable' }
	}
};

function overview(input: {
	readonly source?: 'live' | 'sample';
	readonly createResult?: { readonly ok: true } | { readonly ok: false; readonly reason: string };
} = {}) {
	const creates: unknown[] = [];
	const port: OverviewPagePort = {
		source: input.source === 'sample'
			? { kind: 'sample', scenario: { key: 'sample', name: 'Sample', description: 'Sample' } }
			: { kind: 'live' },
		snapshot: () => summary,
		async read() {
			return { kind: 'success', data: summary };
		},
		async createEvent(request) {
			creates.push(request);
			return input.createResult ?? { ok: true };
		}
	};
	return { port, creates };
}

describe('live tuned workspace shell port', () => {
	test('projects only authenticated live identity and exact Overview shell facts', async () => {
		const source = overview();
		const port = createLiveWorkspaceShellPort({
			user: { id: 'user-1', displayName: 'Ada Lovelace', primaryEmail: 'ada@example.test' },
			overview: source.port
		});

		expect(port.source).toEqual({ kind: 'live' });
		expect(port.viewer).toEqual({ kind: 'organizer' });
		expect(port.events).toBeUndefined();
		expect(port.account.emailChange).toBeUndefined();
		expect(await port.account.current()).toEqual({
			name: 'Ada Lovelace', email: 'ada@example.test', pendingEmailChange: null
		});
		expect(await port.summary.read()).toEqual({
			kind: 'success',
			data: { event: null, lockedAreas: ['submissions', 'forms'], navCounts: {} }
		});
	});

	test('delegates first-event creation without inventing multi-event switching', async () => {
		const source = overview();
		const port = createLiveWorkspaceShellPort({
			user: { id: 'user-1', displayName: 'Ada Lovelace' },
			overview: source.port
		});
		const request = {
			name: 'Joo Summit', timezone: 'Asia/Singapore',
			startDate: '2027-01-03', endDate: '2027-01-04', idempotencyKey: crypto.randomUUID()
		};

		expect(await port.createFirstEvent?.(request)).toEqual({ ok: true });
		expect(source.creates).toEqual([request]);
		expect(port.events).toBeUndefined();
	});

	test('refuses a sample Overview at the pure-live composition boundary', () => {
		expect(() => createLiveWorkspaceShellPort({
			user: { id: 'user-1', displayName: 'Ada Lovelace' },
			overview: overview({ source: 'sample' }).port
		})).toThrow('live_workspace_shell_source_required');
	});
});
