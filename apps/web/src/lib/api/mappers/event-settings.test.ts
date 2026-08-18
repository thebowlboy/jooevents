import { describe, expect, test } from 'bun:test';
import { eventSettingsSchema } from '@jooevents/contracts';
import { formatEventSettingsDateRange, mapEventSettings } from './event-settings';

const eventId = '00000000-0000-4000-8000-000000000001';

/**
 * Reads an expectation with ordinary spaces against the non-breaking bytes a
 * date actually carries, so the assertion stays legible and still proves the
 * span cannot break across two lines.
 */
const span = (text: string): string =>
	text.replaceAll(' ', '\u00a0').replace(/(\d)\u2013(\d)/gu, '$1\u2060\u2013\u2060$2');

describe('Event Settings canonical-to-browser mapping', () => {
	test('preserves the nine canonical values and hidden guards while deriving only dates', () => {
		const source = eventSettingsSchema.parse({
			schemaVersion: 1,
			eventId,
			eventSetVersion: 3,
			eventVersion: 7,
			profileContentReview: false,
			name: 'JooEvents Assembly',
			timezone: 'Asia/Singapore',
			startDate: '2027-03-18',
			endDate: '2027-03-20',
			location: 'Suntec Convention Centre',
			venueNote: 'Registration opens on Level 2.',
			dayStart: '09:00',
			dayEnd: '18:00',
			slotMinutes: 30
		});

		expect(mapEventSettings(source)).toEqual({
			eventId,
			eventSetVersion: 3,
			eventVersion: 7,
			profileContentReview: false,
			name: 'JooEvents Assembly',
			timezone: 'Asia/Singapore',
			startDate: '2027-03-18',
			endDate: '2027-03-20',
			location: 'Suntec Convention Centre',
			venueNote: 'Registration opens on Level 2.',
			dayStart: '09:00',
			dayEnd: '18:00',
			slotMinutes: 30,
			dates: span('18–20 Mar 2027')
		});
		expect(Object.isFrozen(mapEventSettings(source))).toBe(true);

		expect(mapEventSettings(eventSettingsSchema.parse({
			...source,
			dayStart: null,
			dayEnd: null,
			slotMinutes: null
		}))).toMatchObject({ dayStart: null, dayEnd: null, slotMinutes: null });
	});

	test('formats same-day, cross-month, and cross-year ranges without host-timezone drift', () => {
		expect(formatEventSettingsDateRange('2027-03-18', '2027-03-18'))
			.toBe(span('18 Mar 2027'));
		expect(formatEventSettingsDateRange('2027-03-31', '2027-04-02'))
			.toBe(span('31 Mar – 2 Apr 2027'));
		expect(formatEventSettingsDateRange('2027-12-31', '2028-01-02'))
			.toBe(span('31 Dec 2027 – 2 Jan 2028'));
	});

	test('names the absence rather than echoing an unreadable date back', () => {
		expect(formatEventSettingsDateRange('', '')).toBe('Dates not set');
		expect(formatEventSettingsDateRange('2027-02-30', '2027-13-01')).toBe('Dates not set');
	});
});
