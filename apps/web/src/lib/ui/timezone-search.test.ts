import { describe, expect, test } from 'bun:test';
import {
	browseTimezoneOptions,
	deviceTimezoneOption,
	normalizeTimezoneSearch,
	searchTimezones,
	timezoneOffsetLabel,
	timezoneOffsetMinutes
} from './timezone-search';

describe('timezone search', () => {
	test('treats separators, casing, and human spacing as equivalent', () => {
		expect(normalizeTimezoneSearch(' NEW _York ')).toBe('new york');
		expect(searchTimezones('NEW _York')[0]?.id).toBe('America/New_York');
		expect(searchTimezones('newyork')[0]?.id).toBe('America/New_York');
		expect(searchTimezones('america newyork')[0]?.id).toBe('America/New_York');
	});

	test('ranks small transposition and omission typos correctly', () => {
		expect(searchTimezones('new yrok')[0]?.id).toBe('America/New_York');
		expect(searchTimezones('singapre')[0]?.id).toBe('Asia/Singapore');
		expect(searchTimezones('los angles')[0]?.id).toBe('America/Los_Angeles');
	});

	test('indexes common city, region, and abbreviation aliases', () => {
		expect(searchTimezones('nyc')[0]?.id).toBe('America/New_York');
		expect(searchTimezones('eastern time')[0]?.id).toBe('America/New_York');
		expect(searchTimezones('zulu')[0]?.id).toBe('UTC');
	});

	test('finds zones by country name, principal zone first', () => {
		expect(searchTimezones('malaysia')[0]?.id).toBe('Asia/Kuala_Lumpur');
		expect(searchTimezones('germany')[0]?.id).toBe('Europe/Berlin');
		expect(searchTimezones('united states')[0]?.id).toBe('America/New_York');
		expect(searchTimezones('brazil')[0]?.id).toBe('America/Sao_Paulo');
		expect(searchTimezones('vietnam')[0]?.id).toBe('Asia/Ho_Chi_Minh');
		expect(searchTimezones('uk')[0]?.id).toBe('Europe/London');
	});

	test('tolerates typos in country names', () => {
		expect(searchTimezones('malasia')[0]?.id).toBe('Asia/Kuala_Lumpur');
		expect(searchTimezones('germny')[0]?.id).toBe('Europe/Berlin');
	});

	test('finds zones by GMT or UTC offset', () => {
		const gmt8 = searchTimezones('gmt+8').map((option) => option.id);
		expect(gmt8).toContain('Asia/Singapore');
		expect(searchTimezones('+05:30')[0]?.id).toBe('Asia/Kolkata');
		expect(searchTimezones('utc+0').map((option) => option.id)).toContain('UTC');
		// Zones with no daylight saving keep a stable offset year-round.
		expect(searchTimezones('gmt-5').map((option) => option.id)).not.toContain('Asia/Singapore');
	});

	test('reports stable offsets for zones without daylight saving', () => {
		expect(timezoneOffsetMinutes('Asia/Singapore')).toBe(480);
		expect(timezoneOffsetMinutes('Asia/Kolkata')).toBe(330);
		expect(timezoneOffsetMinutes('UTC')).toBe(0);
		expect(timezoneOffsetLabel('Asia/Singapore')).toBe('GMT+8');
		expect(timezoneOffsetLabel('Asia/Kolkata')).toBe('GMT+5:30');
		expect(timezoneOffsetLabel('UTC')).toBe('GMT+0');
	});

	test('browse list covers every zone, offset ascending, hub cities leading their group', () => {
		const options = browseTimezoneOptions();
		expect(options.length).toBeGreaterThan(300);

		const offsets = options.map((option) => timezoneOffsetMinutes(option.id) ?? Infinity);
		for (let index = 1; index < offsets.length; index += 1) {
			expect(offsets[index]).toBeGreaterThanOrEqual(offsets[index - 1]);
		}

		// Within an offset group the curated hub comes first (stable, DST-free zones).
		const ids = options.map((option) => option.id);
		expect(ids.indexOf('Asia/Singapore')).toBeLessThan(ids.indexOf('Asia/Brunei'));
		expect(ids.indexOf('Asia/Kolkata')).toBeLessThan(ids.indexOf('Asia/Colombo'));
	});

	test('resolves the device timezone to a known option', () => {
		const option = deviceTimezoneOption();
		expect(option).toBeDefined();
		expect(option?.id).toBeTruthy();
	});
});
