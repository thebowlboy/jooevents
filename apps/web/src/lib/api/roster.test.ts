import { describe, expect, test } from 'bun:test';
import { api } from './workspace';
import flight from './sample/flight';

/**
 * The public lineup: who appears, in what order, under which group — and the
 * boundary between the roster row an organizer works with and the card a
 * stranger's website receives.
 *
 * These run against the loaded scenario's live working copy, so each mutation
 * test restores what it moved; the ordering tests below depend on the seeded
 * sequence and would otherwise be order-dependent on each other.
 */

describe('public order', () => {
	test('a dataset states the lineup by listing rows in it; load materializes positions', async () => {
		const roster = await api.speakers.list();
		expect(roster.map((row) => row.id)).toEqual(flight.speakers.map((seed) => seed.id));
		expect(roster.map((row) => row.position)).toEqual(flight.speakers.map((_, index) => index));
	});

	test('a move renumbers the whole sequence — no gaps, no ties', async () => {
		const before = (await api.speakers.list()).map((row) => row.id);
		expect(await api.speakers.reorder('spk-6', 0)).toEqual({ ok: true });

		const after = await api.speakers.list();
		expect(after[0].id).toBe('spk-6');
		expect(after.map((row) => row.position)).toEqual(after.map((_, index) => index));
		// Everyone else keeps their relative order.
		expect(after.map((row) => row.id).filter((id) => id !== 'spk-6')).toEqual(
			before.filter((id) => id !== 'spk-6')
		);

		// Compensate: back to where it started.
		expect(await api.speakers.reorder('spk-6', before.indexOf('spk-6'))).toEqual({ ok: true });
		expect((await api.speakers.list()).map((row) => row.id)).toEqual(before);
	});

	test('an index past the end lands last rather than refusing', async () => {
		const before = (await api.speakers.list()).map((row) => row.id);
		await api.speakers.reorder('spk-1', 999);
		const after = (await api.speakers.list()).map((row) => row.id);
		expect(after.at(-1)).toBe('spk-1');

		await api.speakers.reorder('spk-1', before.indexOf('spk-1'));
		expect((await api.speakers.list()).map((row) => row.id)).toEqual(before);
	});

	test('moving somebody who is no longer on the roster is refused, not silently ignored', async () => {
		expect(await api.speakers.reorder('spk-nobody', 0)).toEqual({
			ok: false,
			reason: 'This speaker is no longer on the roster'
		});
	});
});

describe('the public projection', () => {
	test('carries only publishable facts — never the organizer-only ones', async () => {
		const cards = await api.speakers.publicRoster();
		expect(cards.length).toBeGreaterThan(0);
		for (const card of cards) {
			// The roster row's own fields must not travel: an address, task counts,
			// and a cancellation note are not the public's business, and a surface
			// handed the whole row could render them by accident.
			for (const leak of ['email', 'state', 'tasksDone', 'overdueTasks', 'note', 'position']) {
				expect(leak in card).toBe(false);
			}
		}
	});

	test('shows exactly the published people, in lineup order', async () => {
		const roster = await api.speakers.list();
		const cards = await api.speakers.publicRoster();
		expect(cards.map((card) => card.id)).toEqual(
			roster.filter((row) => row.publiclyVisible).map((row) => row.id)
		);
	});

	test('a published speaker whose content is unapproved appears, without a biography', async () => {
		// Dropping them would make the lineup's length depend on how far along the
		// organizer's admin is — the surprise a published page must not spring.
		const ravi = (await api.speakers.publicRoster()).find((card) => card.id === 'spk-6');
		expect(ravi).toBeDefined();
		expect(ravi!.provisional).toBe(true);
		expect(ravi!.headline).toBeUndefined();
		expect(ravi!.links).toEqual([]);
		// What is theirs regardless of approval still shows.
		expect(ravi!.name).toBe('Ravi Chandran');
		expect(ravi!.sessions.length).toBeGreaterThan(0);
	});

	test('an approved speaker carries what they wrote about themselves', async () => {
		const maya = (await api.speakers.publicRoster()).find((card) => card.id === 'spk-1');
		expect(maya!.provisional).toBe(false);
		expect(maya!.headline).toContain('Platform engineer');
		expect(maya!.location).toBe('Stockholm, Sweden');
		expect(maya!.links.length).toBeGreaterThan(0);
	});

	test('a published speaker nobody wrote a profile for renders as a name and their sessions', async () => {
		const daniel = (await api.speakers.publicRoster()).find((card) => card.id === 'spk-8');
		expect(daniel).toBeDefined();
		expect(daniel!.provisional).toBe(false);
		expect(daniel!.headline).toBeUndefined();
		expect(daniel!.sessions.length).toBeGreaterThan(0);
	});
});

describe('groups', () => {
	test('counts are derived from the roster, never authored beside it', async () => {
		const categories = await api.vocab.speakerCategories();
		const roster = await api.speakers.list();
		for (const category of categories) {
			expect(category.speakerCount).toBe(
				roster.filter((row) => row.categoryId === category.id).length
			);
		}
	});

	test('filing and unfiling one person moves only that person', async () => {
		const before = (await api.speakers.get('spk-8'))!.categoryId;
		expect(await api.speakers.setCategory('spk-8', 'spkcat-keynote')).toEqual({ ok: true });
		expect((await api.speakers.get('spk-8'))!.categoryId).toBe('spkcat-keynote');

		expect(await api.speakers.setCategory('spk-8', null)).toEqual({ ok: true });
		expect((await api.speakers.get('spk-8'))!.categoryId).toBeUndefined();

		expect(await api.speakers.setCategory('spk-8', before ?? null)).toEqual({ ok: true });
	});

	test('a group that does not exist is refused rather than stored', async () => {
		expect(await api.speakers.setCategory('spk-8', 'spkcat-nonsense')).toEqual({
			ok: false,
			reason: 'That group no longer exists'
		});
	});
});

describe('visibility', () => {
	test('publishing puts somebody on the lineup and taking them off removes them', async () => {
		const wasOn = (await api.speakers.publicRoster()).some((card) => card.id === 'spk-2');
		expect(wasOn).toBe(false);

		expect(await api.speakers.setVisibility('spk-2', true)).toEqual({ ok: true });
		expect((await api.speakers.publicRoster()).some((card) => card.id === 'spk-2')).toBe(true);

		expect(await api.speakers.setVisibility('spk-2', false)).toEqual({ ok: true });
		expect((await api.speakers.publicRoster()).some((card) => card.id === 'spk-2')).toBe(false);
	});
});

describe('what can be embedded', () => {
	test('the catalogue is derived from the surfaces that exist', async () => {
		const targets = await api.embeds.targets();
		const kinds = new Set(targets.map((entry) => entry.kind));
		expect(kinds.has('schedule')).toBe(true);
		expect(kinds.has('speaker-roster')).toBe(true);
		expect(kinds.has('application-form')).toBe(true);
	});

	test('every speaker group is its own target, counted from the published roster', async () => {
		const targets = await api.embeds.targets();
		const cards = await api.speakers.publicRoster();
		const grouped = targets.filter((entry) => entry.scope.kind === 'category');
		expect(grouped.length).toBeGreaterThan(0);
		for (const entry of grouped) {
			const scope = entry.scope;
			if (scope.kind !== 'category') throw new TypeError('expected a category scope');
			expect(entry.count).toBe(
				cards.filter((card) => card.categoryId === scope.categoryId).length
			);
		}
	});

	test('one form is one target, and only forms bind an origin allowlist', async () => {
		const targets = await api.embeds.targets();
		const forms = await api.forms.list();
		const formTargets = targets.filter((entry) => entry.kind === 'application-form');
		expect(formTargets.map((entry) => entry.name)).toEqual(forms.map((form) => form.name));
		expect(formTargets.every((entry) => entry.acceptsSubmissions)).toBe(true);
		expect(
			targets.filter((entry) => entry.kind !== 'application-form').some((e) => e.acceptsSubmissions)
		).toBe(false);
	});

	test('only a published speaker has an individual embed', async () => {
		const people = await api.embeds.speakerTargets();
		const cards = await api.speakers.publicRoster();
		expect(people.map((entry) => entry.name)).toEqual(cards.map((card) => card.name));
		for (const entry of people) expect(entry.scope.kind).toBe('speaker');
	});

	test('every target key is unique, because the address names one of them', async () => {
		const keys = [
			...(await api.embeds.targets()).map((entry) => entry.key),
			...(await api.embeds.speakerTargets()).map((entry) => entry.key)
		];
		expect(new Set(keys).size).toBe(keys.length);
	});
});
