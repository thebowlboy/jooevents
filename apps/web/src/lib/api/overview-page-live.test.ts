import { describe, expect, test } from 'bun:test';
import {
	WORKSPACE_OVERVIEW_AREAS,
	workspaceOverviewProjectionSchema
} from '@jooevents/contracts/workspace-overview';
import type { EventProgramPort } from './event-program/port';
import type { WorkspaceOverviewPort } from './operations/workspace-overview-live';
import { formatDateRange } from '@jooevents/contracts';
import { createLiveOverviewPagePort } from './overview-page-live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

const areas = WORKSPACE_OVERVIEW_AREAS.map((area) => area === 'overview'
	? { area, status: 'available' as const, capabilities: ['workspace.overview.read'] }
	: { area, status: 'unavailable' as const, reason: 'not_implemented' as const });

function projection(overrides: Record<string, unknown> = {}) {
	return workspaceOverviewProjectionSchema.parse({
		schemaVersion: 1,
		event: {
			schemaVersion: 1,
			kind: 'current_event',
			eventSetVersion: 7,
			event: {
				id: id(1),
				name: 'Test Summit',
				timezone: 'Asia/Singapore',
				startDate: '2027-06-10',
				endDate: '2027-06-12',
				version: 3
			}
		},
		areas,
		metrics: {
			forms: { kind: 'exact', total: 5, draft: 1, open: 2, closed: 2 },
			submissions: { kind: 'exact', total: 12 },
			programVocabulary: {
				kind: 'exact',
				rooms: { total: 5, active: 4, retired: 1 },
				tracks: { total: 4, active: 3, retired: 1 },
				formats: { total: 4, active: 2, retired: 2 }
			},
			changesets: {
				kind: 'exact', total: 9, draft: 1, proposed: 1, committed: 6, discarded: 1
			}
		},
		history: {
			total: 1,
			truncated: false,
			threads: [{
				id: `changeset:${id(2)}`,
				domain: 'forms',
				root: { kind: 'changeset', changesetId: id(2), status: 'committed' },
				firstOccurredAt: '2026-08-13T02:50:00.000Z',
				lastOccurredAt: '2026-08-13T02:55:00.000Z',
				actors: ['agent'],
				surfaces: ['operator_http'],
				latestOperation: { name: 'intake.form.create', version: 1 },
				latestReceipt: {
					id: id(3), operationName: 'intake.form.create', operationVersion: 1
				},
				latestOutcome: { kind: 'success' },
				evidence: { timelineEntries: 3, receipts: 2 }
			}]
		},
		...overrides
	});
}

function overviewPort(data = projection()): WorkspaceOverviewPort {
	return {
		source: { kind: 'live' },
		async read() { return { kind: 'success', data, correlationId: id(4) }; }
	};
}

function eventPort(calls: unknown[]): EventProgramPort['event'] {
	return {
		async read() { throw new Error('not_used'); },
		async create(input, options) {
			calls.push({ input, options });
			return {
				kind: 'success',
				data: {
					eventSetVersion: input.expectedEventSetVersion + 1,
					event: {
						id: id(5), name: input.name, timezone: input.timezone,
						startDate: input.startDate, endDate: input.endDate, version: 1
					}
				},
				receipt: { id: id(6), operationName: 'event.create', operationVersion: 1 },
				correlationId: id(7)
			};
		}
	};
}

describe('live Overview page port', () => {
	test('projects exact metrics and grouped history without inventing missing operational sections', async () => {
		const port = createLiveOverviewPagePort({
			overview: overviewPort(),
			event: eventPort([])
		});
		expect(port.snapshot()).toBeNull();
		const result = await port.read();
		expect(result).toMatchObject({
			kind: 'success',
			data: {
				event: {
					name: 'Test Summit',
					// The one date vocabulary spells this, not the port: a span in the
					// same month says its month once and never breaks across a line,
					// which is why the expectation is the vocabulary's own output
					// rather than a hand-typed twin carrying ordinary spaces.
					dates: formatDateRange('2027-06-10', '2027-06-12'),
					timezone: 'Asia/Singapore'
				},
				arrivals: null,
				navCounts: { submissions: '12' },
				stats: [
					{ label: 'Forms', value: '5', sub: '2 open · 1 draft · 2 closed' },
					{ label: 'Submissions', value: '12', sub: '12 recorded submissions' },
					{ label: 'Program vocabulary', value: '13', sub: '9 active · 4 retired' },
					{ label: 'Changes', value: '9', sub: '6 committed · 2 in progress' }
				],
				attention: [],
				deadlines: [],
				trays: [],
				activity: [{
					id: `changeset:${id(2)}`,
					actor: 'agent',
					name: 'An agent',
					text: 'committed changes to forms',
					// The instant, not a rendering of it. The words are the date
					// vocabulary's job wherever the feed is drawn.
					at: '2026-08-13T02:55:00.000Z'
				}],
				sections: {
					attention: { kind: 'unavailable' },
					pipeline: { kind: 'unavailable' },
					deadlines: { kind: 'unavailable' },
					activity: { kind: 'available' },
					trays: { kind: 'unavailable' }
			}
			}
		});
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.pipeline).toHaveLength(7);
		expect(result.data.pipeline.every((stage) =>
			stage.state === 'unavailable'
			&& stage.headline === '—'
			&& stage.progress === undefined
			&& stage.paceTone === undefined
		)).toBe(true);
		expect(port.snapshot()).toEqual(result.data);
	});

	test('renders unavailable metrics as a reasoned dash, never a manufactured zero', async () => {
		const base = projection();
		const data = projection({
			metrics: {
				...base.metrics,
				forms: { kind: 'unavailable', reason: 'dependency_unavailable' }
			}
		});
		const result = await createLiveOverviewPagePort({
			overview: overviewPort(data),
			event: eventPort([])
		}).read();
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.stats[0]).toEqual({
			label: 'Forms', value: '—', sub: 'This number is not available yet.'
		});
	});

	test('uses the read event-set version and caller idempotency key for first-event creation', async () => {
		const calls: unknown[] = [];
		const noEvent = projection({
			event: { schemaVersion: 1, kind: 'no_event', eventSetVersion: 11 },
			metrics: {
				forms: { kind: 'unavailable', reason: 'event_required' },
				submissions: { kind: 'unavailable', reason: 'event_required' },
				programVocabulary: { kind: 'unavailable', reason: 'event_required' },
				changesets: { kind: 'unavailable', reason: 'event_required' }
			}
		});
		const port = createLiveOverviewPagePort({
			overview: overviewPort(noEvent),
			event: eventPort(calls)
		});
		expect(await port.createEvent({
			name: 'Too early', timezone: 'UTC', startDate: '2027-01-01', endDate: '2027-01-02',
			idempotencyKey: 'same-key'
		})).toEqual({ ok: false, reason: 'Reload the overview before creating an event.' });
		await port.read();
		expect(await port.createEvent({
			name: 'Created', timezone: 'UTC', startDate: '2027-01-01', endDate: '2027-01-02',
			idempotencyKey: 'same-key'
		})).toEqual({ ok: true });
		expect(calls).toEqual([{
			input: {
				expectedEventSetVersion: 11,
				name: 'Created', timezone: 'UTC', startDate: '2027-01-01', endDate: '2027-01-02'
			},
			options: { idempotencyKey: 'same-key' }
		}]);
	});

	test('keeps transport failure safe and distinct from canonical outcomes', async () => {
		const port = createLiveOverviewPagePort({
			overview: {
				source: { kind: 'live' },
				async read() {
					return {
						kind: 'transport_error',
						error: { code: 'network_unavailable', retryable: true, correlationId: id(8) }
					};
				}
			},
			event: eventPort([])
		});
		expect(await port.read()).toEqual({
			kind: 'transport_error', retryable: true, correlationId: id(8)
		});
	});
});
