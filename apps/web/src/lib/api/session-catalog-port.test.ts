import { describe, expect, test } from 'bun:test';
import { sessionAuthorInputSchema } from '@jooevents/contracts/sessions';
import type { SessionAuthorRequest } from './session-catalog-port';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);

const guards = Object.freeze({
	expectedCatalogVersion: 7,
	expectedCatalogDigestSha256: digest('e')
});

describe('session catalog port request contract', () => {
	test('the executable author schema carries the forward-only transition rule', () => {
		const base = {
			action: 'transition',
			...guards,
			sessionId: id(20),
			expectedSessionVersion: 1,
			expectedSessionDigestSha256: digest('d')
		};
		expect(sessionAuthorInputSchema.safeParse({ ...base, to: 'collecting' }).success).toBe(true);
		expect(sessionAuthorInputSchema.safeParse({ ...base, to: 'programmed' }).success).toBe(true);
		// Backwards to 'draft' and the internal 'restore' are not authorable inputs.
		expect(sessionAuthorInputSchema.safeParse({ ...base, to: 'draft' }).success).toBe(false);
		expect(sessionAuthorInputSchema.safeParse({ ...base, to: 'restore' }).success).toBe(false);
		expect(
			sessionAuthorInputSchema.safeParse({ action: 'restore', ...guards }).success
		).toBe(false);
	});

	test('create input canonicalizes title spacing and id casing before any request', () => {
		const request: SessionAuthorRequest = {
			action: 'create',
			...guards,
			title: '  Opening   keynote ',
			plannedDurationMinutes: 45,
			lifecycle: 'collecting',
			formatId: id(10).toUpperCase(),
			trackId: null
		};
		const parsed = sessionAuthorInputSchema.parse(request);
		if (parsed.action !== 'create') throw new TypeError('Expected a create input.');
		expect(parsed.title).toBe('Opening keynote');
		expect(parsed.formatId).toBe(id(10));
		expect(parsed.trackId).toBeNull();
		// Durations bind to the canonical five-minute planning grain.
		expect(
			sessionAuthorInputSchema.safeParse({ ...request, plannedDurationMinutes: 44 }).success
		).toBe(false);
	});
});
