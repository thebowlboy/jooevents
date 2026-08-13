import { describe, expect, test } from 'bun:test';
import flight from './sample/flight';
import { createSampleOverviewPagePort } from './overview-page-port.sample';

describe('sample Overview page port', () => {
	test('preserves the populated resettable scenario and strips only live idempotency metadata', async () => {
		const createCalls: unknown[] = [];
		const port = createSampleOverviewPagePort({
			scenario: { key: flight.key, name: flight.name, description: flight.description },
			api: {
				workspace: {
					async summary() { return flight.summary; },
					summarySnapshot() { return flight.summary; },
					async createEvent(input) {
						createCalls.push(input);
						return { ok: true as const };
					}
				}
			}
		});

		const snapshot = port.snapshot();
		if (!snapshot) throw new Error('expected_sample_snapshot');
		expect(snapshot).toMatchObject({
			event: flight.summary.event,
			stats: flight.summary.stats,
			attention: flight.summary.attention,
			deadlines: flight.summary.deadlines,
			activity: flight.summary.activity,
			trays: flight.summary.trays,
			sections: {
				attention: { kind: 'available' },
				pipeline: { kind: 'available' },
				deadlines: { kind: 'available' },
				activity: { kind: 'available' },
				trays: { kind: 'available' }
			}
		});
		expect(snapshot.pipeline).toEqual(
			flight.summary.pipeline.map((stage) => ({
				...stage,
				availability: { kind: 'available' }
			}))
		);
		expect(await port.read()).toEqual({ kind: 'success', data: snapshot });

		expect(await port.createEvent({
			name: 'New event',
			timezone: 'Asia/Singapore',
			startDate: '2027-06-10',
			endDate: '2027-06-12',
			idempotencyKey: 'browser-only-key'
		})).toEqual({ ok: true });
		expect(createCalls).toEqual([{
			name: 'New event',
			timezone: 'Asia/Singapore',
			startDate: '2027-06-10',
			endDate: '2027-06-12'
		}]);
	});
});
