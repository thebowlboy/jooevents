import { describe, expect, test } from 'bun:test';
import { isLegalShortLabel, scopeAccessibleName, type Scope } from './scopes';

const scope = (partial: Partial<Scope>): Scope => ({ value: 'inbox', label: 'Inbox', ...partial });

describe('scope labels', () => {
	test('a scope with no abbreviation is always legal', () => {
		expect(isLegalShortLabel(scope({}))).toBe(true);
	});

	// Narrow space may take letters. It may not take the word: the visible
	// text has to be contained in the accessible name, and a person saying
	// "tap Aside" and a screen reader saying "Set aside" must be the same
	// control.
	test('an abbreviation must read as the same word', () => {
		expect(isLegalShortLabel(scope({ label: 'Set aside', short: 'Aside' }))).toBe(true);
		expect(isLegalShortLabel(scope({ label: 'Discarded', short: 'Discard' }))).toBe(true);
		expect(isLegalShortLabel(scope({ label: 'Set aside', short: 'Later' }))).toBe(false);
		expect(isLegalShortLabel(scope({ label: 'Set aside', short: '' }))).toBe(false);
	});

	test('an abbreviation that is not shorter is not an abbreviation', () => {
		expect(isLegalShortLabel(scope({ label: 'Inbox', short: 'Inbox' }))).toBe(false);
	});

	test('the count is part of what is being chosen between', () => {
		expect(scopeAccessibleName(scope({ label: 'Discarded', count: 4 }))).toBe('Discarded, 4');
		expect(scopeAccessibleName(scope({ label: 'Discarded', count: 0 }))).toBe('Discarded, 0');
		expect(scopeAccessibleName(scope({ label: 'Discarded' }))).toBe('Discarded');
	});
});
