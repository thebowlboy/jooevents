import { describe, expect, test } from 'bun:test';
import { classifyField, groupLadder, suggestPlacement } from './placement';
import type { FieldGroup, FieldKind, RegistryField } from './types';

/** A minimal registry field: only what the advisor reads (group, label) plus identity. */
function field(id: string, group: FieldGroup, label = id, kind: FieldKind = 'text'): RegistryField {
	return { id, kind, label, required: {}, collectAt: ['apply'], group, position: 0 };
}

/** Positions mirror indexes, as the api maintains them. */
function ordered(...fields: RegistryField[]): RegistryField[] {
	return fields.map((entry, index) => ({ ...entry, position: index }));
}

describe('the group ladder', () => {
	test('runs identity → consent, with consent last', () => {
		expect(groupLadder).toEqual([
			'identity',
			'contact',
			'presence',
			'talk',
			'logistics',
			'materials',
			'other',
			'consent'
		]);
	});
});

describe('classifyField — kind rules first', () => {
	test('email and phone are contact', () => {
		expect(classifyField('email', 'Backup address')).toBe('contact');
		expect(classifyField('phone', 'Mobile')).toBe('contact');
	});

	test('url is presence', () => {
		expect(classifyField('url', 'Portfolio')).toBe('presence');
	});

	test('date and datetime are logistics', () => {
		expect(classifyField('date', 'Departure')).toBe('logistics');
		expect(classifyField('datetime', 'Arrival')).toBe('logistics');
	});

	test('file is materials', () => {
		expect(classifyField('file', 'Anything at all')).toBe('materials');
	});

	test('a consent-worded checkbox is consent, under any of its wordings', () => {
		for (const label of [
			'I consent to being photographed',
			'I agree to the terms',
			'I accept the code of conduct',
			'Permission to publish my slides',
			'My session may be recorded'
		]) {
			expect(classifyField('checkbox', label)).toBe('consent');
		}
	});

	test('a checkbox without consent wording falls through to the label rules', () => {
		expect(classifyField('checkbox', 'First time speaking?')).toBe('other');
		expect(classifyField('checkbox', 'Bringing your own slides?')).toBe('materials');
	});

	test('kind outranks label: a datetime called “Session start” is still logistics', () => {
		expect(classifyField('datetime', 'Session start')).toBe('logistics');
	});
});

describe('classifyField — label keywords, then the fallback', () => {
	test('travel wording is logistics', () => {
		for (const label of ['Travel budget', 'Arrival airport', 'Departure city', 'Visa letter needed?', 'Dietary needs', 'Hotel nights']) {
			expect(classifyField('text', label)).toBe('logistics');
		}
	});

	test('person wording is identity', () => {
		for (const label of ['Short bio', 'Pronouns', 'Preferred name', 'Headline']) {
			expect(classifyField('text', label)).toBe('identity');
		}
	});

	test('materials wording is materials', () => {
		for (const label of ['Slides link', 'Deck outline', 'Workshop materials', 'Headshot notes']) {
			expect(classifyField('text', label)).toBe('materials');
		}
	});

	test('network wording is presence', () => {
		for (const label of ['Twitter handle', 'LinkedIn', 'GitHub username', 'Website', 'Social handles']) {
			expect(classifyField('text', label)).toBe('presence');
		}
	});

	test('session wording is talk', () => {
		for (const label of ['Alternate title', 'Abstract', 'Format preference', 'Track choice', 'Topic area', 'Session level']) {
			expect(classifyField('text', label)).toBe('talk');
		}
	});

	test('anything unrecognized is other', () => {
		expect(classifyField('text', 'Favorite color')).toBe('other');
		expect(classifyField('textarea', 'How did you hear about us?')).toBe('other');
	});
});

describe('suggestPlacement — anchoring after the last group-mate', () => {
	test('lands after the last field of its group, with the reason naming that anchor', () => {
		const current = ordered(
			field('a', 'identity', 'Your name'),
			field('b', 'logistics', 'Arrival date'),
			field('c', 'consent', 'I agree to the code of conduct')
		);
		const placement = suggestPlacement({ kind: 'text', label: 'Hotel preference' }, current);
		expect(placement).toEqual({
			index: 2,
			group: 'logistics',
			reason: 'Placed with the other logistics questions, after “Arrival date”.'
		});
	});

	test('funky order: a contact field the user parked inside the talk section anchors the next contact field there', () => {
		// The user interleaved: identity, talk, contact-inside-talk, talk, consent.
		const current = ordered(
			field('name', 'identity', 'Your name'),
			field('title', 'talk', 'Talk title'),
			field('email', 'contact', 'Email', 'email'),
			field('abstract', 'talk', 'Abstract'),
			field('consent', 'consent', 'I agree to the code of conduct', 'checkbox')
		);
		const placement = suggestPlacement({ kind: 'phone', label: 'Mobile' }, current);
		// After the parked email — wherever the user put it — not at a canonical
		// contact slot near the top.
		expect(placement.index).toBe(3);
		expect(placement.group).toBe('contact');
		expect(placement.reason).toBe('Placed with the other contact questions, after “Email”.');
	});

	test('multiple group-mates: the anchor is the last one in user order', () => {
		const current = ordered(
			field('t1', 'talk', 'Talk title'),
			field('loc', 'identity', 'Where you’re based'),
			field('t2', 'talk', 'Abstract')
		);
		expect(suggestPlacement({ kind: 'select', label: 'Track' }, current).index).toBe(3);
	});
});

describe('suggestPlacement — no group-mate', () => {
	test('empty registry: index 0', () => {
		expect(suggestPlacement({ kind: 'text', label: 'Anything' }, [])).toEqual({
			index: 0,
			group: 'other',
			reason: 'Placed as the first question.'
		});
	});

	test('starts the nearest following ladder group present', () => {
		// No presence fields; the next present group down the ladder is talk.
		const current = ordered(
			field('name', 'identity', 'Your name'),
			field('title', 'talk', 'Talk title'),
			field('consent', 'consent', 'I agree to the code of conduct', 'checkbox')
		);
		const placement = suggestPlacement({ kind: 'url', label: 'Portfolio' }, current);
		expect(placement.index).toBe(1);
		expect(placement.group).toBe('presence');
		expect(placement.reason).toBe(
			'First links & social question — placed just before the talk questions.'
		);
	});

	test('with only consent following, lands before the first consent field', () => {
		const current = ordered(
			field('name', 'identity', 'Your name'),
			field('consent', 'consent', 'I agree to the code of conduct', 'checkbox')
		);
		const placement = suggestPlacement({ kind: 'textarea', label: 'Favorite color' }, current);
		expect(placement.index).toBe(1);
		expect(placement.group).toBe('other');
		expect(placement.reason).toBe(
			'First general question — placed just before the consent questions.'
		);
	});

	test('nothing following on the ladder: lands at the end', () => {
		const current = ordered(field('name', 'identity', 'Your name'), field('title', 'talk', 'Talk title'));
		const placement = suggestPlacement({ kind: 'file', label: 'Slides' }, current);
		expect(placement).toEqual({
			index: 2,
			group: 'materials',
			reason: 'First materials question — placed at the end of the list.'
		});
	});

	test('a first consent field lands at the very end', () => {
		const current = ordered(field('name', 'identity', 'Your name'), field('title', 'talk', 'Talk title'));
		expect(suggestPlacement({ kind: 'checkbox', label: 'I agree to the code of conduct' }, current)).toEqual({
			index: 2,
			group: 'consent',
			reason: 'Placed at the end — consent always comes last.'
		});
	});
});

describe('suggestPlacement never re-sorts', () => {
	test('the input list, its order, and its positions are untouched — only an index comes back', () => {
		const current = ordered(
			field('title', 'talk', 'Talk title'),
			field('name', 'identity', 'Your name'), // deliberately "wrong" ladder order
			field('email', 'contact', 'Email', 'email')
		);
		const snapshot = structuredClone(current);
		const placement = suggestPlacement({ kind: 'text', label: 'Short bio' }, current);
		expect(current).toEqual(snapshot);
		// The identity anchor is respected where the user put it, ladder be damned.
		expect(placement.index).toBe(2);
		expect(placement.group).toBe('identity');
	});
});
