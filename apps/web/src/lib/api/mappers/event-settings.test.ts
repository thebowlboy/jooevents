import { describe, expect, test } from 'bun:test';
import { eventSettingsSchema } from '@jooevents/contracts';
import { formatEventSettingsDateRange, mapEventSettings } from './event-settings';

const eventId = '00000000-0000-4000-8000-000000000001';

describe('Event Settings canonical-to-browser mapping', () => {
	test('preserves the six canonical values and hidden guards while deriving only dates', () => {
		const source = eventSettingsSchema.parse({
			schemaVersion: 1,
			eventId,
			eventSetVersion: 3,
			eventVersion: 7,
			name: 'JooEvents Assembly',
			timezone: 'Asia/Singapore',
			startDate: '2027-03-18',
			endDate: '2027-03-20',
			location: 'Suntec Convention Centre',
			venueNote: 'Registration opens on Level 2.'
		});

		expect(mapEventSettings(source)).toEqual({
			eventId,
			eventSetVersion: 3,
			eventVersion: 7,
			name: 'JooEvents Assembly',
			timezone: 'Asia/Singapore',
			startDate: '2027-03-18',
			endDate: '2027-03-20',
			location: 'Suntec Convention Centre',
			venueNote: 'Registration opens on Level 2.',
			dates: 'Mar 18–20, 2027'
		});
		expect(Object.isFrozen(mapEventSettings(source))).toBe(true);
	});

	test('formats same-day, cross-month, and cross-year ranges without host-timezone drift', () => {
		expect(formatEventSettingsDateRange('2027-03-18', '2027-03-18'))
			.toBe('Mar 18, 2027');
		expect(formatEventSettingsDateRange('2027-03-31', '2027-04-02'))
			.toBe('Mar 31 – Apr 2, 2027');
		expect(formatEventSettingsDateRange('2027-12-31', '2028-01-02'))
			.toBe('Dec 31, 2027 – Jan 2, 2028');
	});
});
