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

// ---------------------------------------------------------------------------
// Wave items 2 + 3: the fast nameplate and the live event collection.

import { formatDateRange } from '@jooevents/contracts';
import type { WorkspaceShellSummaryLivePort } from './operations/workspace-shell-summary-live';
import type { EventLiveClient } from './operations/event-live';
import { createLiveWorkspaceEventCollection } from './workspace-shell-live';

const eventId = (value: number) =>
	`00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function shellSummaryPort(
	result: Awaited<ReturnType<WorkspaceShellSummaryLivePort['read']>>,
	calls: string[] = []
): WorkspaceShellSummaryLivePort {
	return {
		source: { kind: 'live' },
		async read() {
			calls.push('read');
			return result;
		}
	};
}

const nameplate = {
	schemaVersion: 1 as const,
	workspace: { id: eventId(99), name: 'JooEvents' },
	event: {
		id: eventId(1),
		name: 'JooCon 2027',
		timezone: 'Europe/Helsinki',
		startDate: '2027-05-04',
		endDate: '2027-05-06'
	}
};

describe('the nameplate reads its own operation', () => {
	test('paints identity without touching the overview read', async () => {
		const source = overview();
		let overviewReads = 0;
		const watched: OverviewPagePort = {
			...source.port,
			async read() {
				overviewReads += 1;
				return { kind: 'success', data: summary };
			}
		};
		const port = createLiveWorkspaceShellPort({
			user: { id: 'user-1', displayName: 'Ada Lovelace' },
			overview: watched,
			shellSummary: shellSummaryPort({
				kind: 'success',
				data: nameplate,
				correlationId: eventId(7)
			})
		});
		const result = await port.summary.read();
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.event?.name).toBe('JooCon 2027');
		// The one date vocabulary's own output, not a hand-typed twin: the span
		// carries word joiners so it can never break across a line.
		expect(result.data.event?.dates).toBe(formatDateRange('2027-05-04', '2027-05-06'));
		expect(result.data.event?.timezone).toBe('Europe/Helsinki');
		// An Event exists, so nothing is locked — and the metrics were never asked for.
		expect(result.data.lockedAreas).toEqual([]);
		expect(overviewReads).toBe(0);
	});

	test('with no event, states every area locked — the only lock reason there is', async () => {
		const port = createLiveWorkspaceShellPort({
			user: { id: 'user-1', displayName: 'Ada Lovelace' },
			overview: overview().port,
			shellSummary: shellSummaryPort({
				kind: 'success',
				data: { ...nameplate, event: null },
				correlationId: eventId(7)
			})
		});
		const result = await port.summary.read();
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.event).toBeNull();
		expect(result.data.lockedAreas).toContain('submissions');
		expect(result.data.lockedAreas).not.toContain('overview');
	});

	test('falls back to the overview wrapper where the fast read is not composed', async () => {
		const port = createLiveWorkspaceShellPort({
			user: { id: 'user-1', displayName: 'Ada Lovelace' },
			overview: overview().port
		});
		const result = await port.summary.read();
		expect(result).toEqual({
			kind: 'success',
			data: { event: null, lockedAreas: ['submissions', 'forms'], navCounts: {} }
		});
	});
});

function eventClient(input: {
	readonly list?: Awaited<ReturnType<EventLiveClient['list']>>;
	readonly select?: Awaited<ReturnType<EventLiveClient['select']>>;
	readonly selects?: unknown[];
}): EventLiveClient {
	return {
		async read() { throw new Error('read_not_used'); },
		async create() { throw new Error('create_not_used'); },
		async list() {
			return input.list ?? {
				kind: 'success',
				correlationId: eventId(8),
				data: {
					schemaVersion: 1,
					eventSetVersion: 4,
					currentEventId: eventId(1),
					events: [
						{ id: eventId(1), name: 'JooCon 2027', timezone: 'Europe/Helsinki',
							startDate: '2027-05-04', endDate: '2027-05-06', version: 1 },
						{ id: eventId(2), name: 'DevOps Days', timezone: 'Europe/Helsinki',
							startDate: '2027-09-09', endDate: '2027-09-10', version: 1 }
					]
				}
			};
		},
		async select(request, options) {
			input.selects?.push({ request, options });
			return input.select ?? {
				kind: 'success',
				correlationId: eventId(9),
				receipt: { id: eventId(10), operationName: 'event.select', operationVersion: 1 },
				data: { eventSetVersion: 5, event: { id: eventId(2), name: 'DevOps Days',
					timezone: 'Europe/Helsinki', startDate: '2027-09-09', endDate: '2027-09-10', version: 1 } }
			};
		}
	};
}

describe('the live event collection', () => {
	test('marks current from the served selection, never from the nameplate', async () => {
		const options = await createLiveWorkspaceEventCollection({
			events: eventClient({})
		}).list();
		expect(options.map((option) => [option.name, option.current])).toEqual([
			['JooCon 2027', true],
			['DevOps Days', false]
		]);
		expect(options[1]?.dates).toBe(formatDateRange('2027-09-09', '2027-09-10'));
	});

	test('switches under the served set version, with one high-entropy attempt key', async () => {
		const selects: unknown[] = [];
		const collection = createLiveWorkspaceEventCollection({
			events: eventClient({ selects })
		});
		expect(await collection.switchEvent(eventId(2))).toEqual({ ok: true });
		expect(selects).toHaveLength(1);
		const call = selects[0] as { request: unknown; options: { idempotencyKey: string } };
		// The guard is the version the list served, so a set that moved refuses.
		expect(call.request).toEqual({ eventId: eventId(2), expectedEventSetVersion: 4 });
		expect(call.options.idempotencyKey.startsWith('je.event.select.')).toBe(true);
		expect(call.options.idempotencyKey.length).toBeGreaterThan('je.event.select.'.length + 30);
	});

	test('maps a typed refusal to a spoken reason rather than a silent no-op', async () => {
		const collection = createLiveWorkspaceEventCollection({
			events: eventClient({
				select: {
					kind: 'outcome',
					terminal: true,
					correlationId: eventId(9),
					receipt: { id: eventId(10), operationName: 'event.select', operationVersion: 1 },
					outcome: { kind: 'event.stale_event_set', class: 'stale_revision', retryable: false,
						detailSchemaVersion: 1 } as never
				}
			})
		});
		expect(await collection.switchEvent(eventId(2))).toEqual({
			ok: false,
			reason: 'The workspace’s events changed while you were looking. Reload and try again.'
		});
	});

	test('offers createEvent only where the composition supplies one', async () => {
		expect(createLiveWorkspaceEventCollection({ events: eventClient({}) }).createEvent)
			.toBeUndefined();
		const withCreate = createLiveWorkspaceEventCollection({
			events: eventClient({}),
			createEvent: async () => ({ ok: true })
		});
		expect(typeof withCreate.createEvent).toBe('function');
	});
});
