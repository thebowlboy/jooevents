import { describe, expect, test } from 'bun:test';
import { jsonEquivalent } from './json-equivalence';

describe('JSON equivalence', () => {
	test('ignores object insertion order at every depth while preserving array order', () => {
		expect(jsonEquivalent(
			{ action: 'publish', before: null, after: { id: 'release-1', number: 1 } },
			{ after: { number: 1, id: 'release-1' }, before: null, action: 'publish' }
		)).toBe(true);
		expect(jsonEquivalent({ values: ['a', 'b'] }, { values: ['b', 'a'] })).toBe(false);
	});

	test('rejects missing keys and changed primitive values', () => {
		expect(jsonEquivalent({ value: 1 }, { value: 1, extra: null })).toBe(false);
		expect(jsonEquivalent({ value: 1 }, { value: 2 })).toBe(false);
	});
});
