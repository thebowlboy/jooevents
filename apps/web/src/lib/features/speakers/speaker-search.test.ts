import { describe, expect, test } from 'bun:test';
import { speakerMatchesSearch } from './speaker-search';

const speaker = { name: 'Ada Lovelace', email: 'ada@example.org' };

describe('speakerMatchesSearch', () => {
	test('matches disclosed names and addresses without case sensitivity', () => {
		expect(speakerMatchesSearch(speaker, 'love')).toBe(true);
		expect(speakerMatchesSearch(speaker, 'ADA@EXAMPLE')).toBe(true);
		expect(speakerMatchesSearch(speaker, 'ada example.org')).toBe(true);
	});

	test('does not manufacture a match for a withheld address', () => {
		expect(speakerMatchesSearch({ name: 'Ada Lovelace', email: '' }, 'example.org')).toBe(false);
	});
});
