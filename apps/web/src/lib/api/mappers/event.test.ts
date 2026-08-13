import { describe, expect, test } from 'bun:test';
import { currentEventProjectionSchema } from '@jooevents/contracts';
import { mapCurrentEvent } from './event';

const eventId = '018f7d5a-4b3c-7abc-8def-0123456789ab';

describe('Event canonical-to-view mapping', () => {
	test('keeps a genuine no-event projection distinct from an empty Event', () => {
		const source = currentEventProjectionSchema.parse({
			schemaVersion: 1,
			kind: 'no_event',
			eventSetVersion: 1
		});
		expect(mapCurrentEvent(source)).toEqual({ kind: 'no_event', eventSetVersion: 1 });
	});

	test('preserves every canonical Event field without aliasing transport objects', () => {
		const source = currentEventProjectionSchema.parse({
			schemaVersion: 1,
			kind: 'current_event',
			eventSetVersion: 2,
			event: {
				id: eventId,
				name: 'JooEvents Assembly',
				timezone: 'Asia/Singapore',
				startDate: '2027-03-18',
				endDate: '2027-03-20',
				version: 1
			}
		});
		const view = mapCurrentEvent(source);
		expect(view).toEqual({
			kind: 'current_event',
			eventSetVersion: 2,
			event: {
				id: eventId,
				name: 'JooEvents Assembly',
				timezone: 'Asia/Singapore',
				startDate: '2027-03-18',
				endDate: '2027-03-20',
				version: 1
			}
		});
		if (view.kind !== 'current_event' || source.kind !== 'current_event') {
			throw new TypeError('expected_current_event');
		}
		expect(view.event).not.toBe(source.event);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.event)).toBe(true);
	});
});

