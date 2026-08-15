import { describe, expect, test } from 'bun:test';
import { statusIcon, type StatusIconKey } from './status-icons';
import { badgeFor, statusTone, statusToneClass } from './status-tones';

describe('status tone vocabulary', () => {
	test('every state carrying a glyph also declares a loudness', () => {
		const glyphKeys = Object.keys(statusIcon) as StatusIconKey[];
		const toneKeys = Object.keys(statusTone);
		expect(toneKeys.sort()).toEqual(glyphKeys.sort());
	});

	test('the vocabulary is exactly five words', () => {
		expect(Object.keys(statusToneClass).sort()).toEqual([
			'caution',
			'info',
			'negative',
			'neutral',
			'positive'
		]);
	});

	test('every declared tone resolves to a palette family that exists', () => {
		const families = new Set(['success', 'danger', 'warning', 'info', 'neutral']);
		for (const tone of Object.values(statusTone)) {
			expect(families.has(statusToneClass[tone])).toBe(true);
		}
	});

	// The defect this map exists to prevent: "Result not sent" rendered soft amber
	// on one surface and solid amber on another. Tone is a property of the
	// state, so both surfaces must now read it from the same place.
	test('one state resolves to one tone and one glyph', () => {
		expect(badgeFor('unnotified')).toEqual({ tone: 'caution', icon: statusIcon.unnotified });
		expect(badgeFor('accepted')).toEqual({ tone: 'positive', icon: statusIcon.accepted });
		expect(badgeFor('declined')).toEqual({ tone: 'negative', icon: statusIcon.declined });
		expect(badgeFor('waitlisted')).toEqual({ tone: 'caution', icon: statusIcon.waitlisted });
		expect(badgeFor('notStarted')).toEqual({ tone: 'neutral', icon: statusIcon.notStarted });
	});

	// Emphasis is a decision about a region, not about a state. If a tone ever
	// grows an `emphasis` field, a column of seven solid badges becomes
	// expressible again — which is the thing that shipped.
	test('a tone carries no emphasis of its own', () => {
		for (const key of Object.keys(statusTone) as StatusIconKey[]) {
			expect(Object.keys(badgeFor(key)).sort()).toEqual(['icon', 'tone']);
		}
	});
});
