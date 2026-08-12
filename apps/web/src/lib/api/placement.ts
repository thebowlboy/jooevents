import type { FieldGroup, FieldKind, RegistryField } from './types';

/**
 * The deterministic placement advisor: where a new field should land in the
 * registry list, answered instantly from the field's kind and label. This is a
 * seam — placement always goes through {@link suggestPlacement}, so a slower,
 * smarter advisor can later refine a suggestion behind the same interface
 * without the fast answer ever going away.
 *
 * Positions are user-owned: the advisor only ever proposes an insertion index
 * into the current order. It never re-sorts existing fields.
 */

/** The canonical group order. Consent is last on purpose: signing before reading is the one order everyone recognizes as wrong. */
export const groupLadder: FieldGroup[] = [
	'identity',
	'contact',
	'presence',
	'talk',
	'logistics',
	'materials',
	'other',
	'consent'
];

/** What one placement answer carries: where, into which group, and why — in one plain sentence. */
export interface PlacementSuggestion {
	/** Insertion index into the current position-ordered list. */
	index: number;
	group: FieldGroup;
	reason: string;
}

/** A checkbox worded like an agreement is consent, whatever it is called. */
const consentLabel = /\b(consent|agree|code of conduct|permission|recorded)/i;

/** Label keyword rules, applied in order after the kind rules. */
const labelRules: { pattern: RegExp; group: FieldGroup }[] = [
	{ pattern: /\b(travel|arrival|departure|visa|dietary|hotel)/i, group: 'logistics' },
	{ pattern: /\b(bio|pronoun|name|headline)/i, group: 'identity' },
	{ pattern: /\b(slide|deck|material|headshot)/i, group: 'materials' },
	{ pattern: /\b(twitter|linkedin|github|website|social)/i, group: 'presence' },
	{ pattern: /\b(title|abstract|format|track|topic|session)/i, group: 'talk' }
];

/**
 * Assigns a new field its ladder group. Kind rules answer first — a kind
 * states what the answer *is*, which outranks what the label calls it — then
 * label keywords, falling back to `other`. Deterministic and total: every
 * field gets a group.
 */
export function classifyField(kind: FieldKind, label: string): FieldGroup {
	if (kind === 'email' || kind === 'phone') return 'contact';
	if (kind === 'url') return 'presence';
	if (kind === 'date' || kind === 'datetime') return 'logistics';
	if (kind === 'file') return 'materials';
	if (kind === 'checkbox' && consentLabel.test(label)) return 'consent';
	for (const rule of labelRules) {
		if (rule.pattern.test(label)) return rule.group;
	}
	return 'other';
}

/** How a group names itself inside a placement reason. */
const groupNoun: Record<FieldGroup, string> = {
	identity: 'identity',
	contact: 'contact',
	presence: 'links & social',
	talk: 'talk',
	logistics: 'logistics',
	materials: 'materials',
	other: 'general',
	consent: 'consent'
};

/**
 * Where a new field should enter the list `current` (position-ordered). The
 * anchor is the last existing field of the same group, wherever the user put
 * it — interleaved groups move the anchor with them. Without a group-mate, the
 * field starts ahead of the nearest following ladder group present; with
 * nothing following either, it lands at the end. Consent's ladder seat is
 * last, so anything unanchored still lands before the consent fields.
 */
export function suggestPlacement(
	field: { kind: FieldKind; label: string },
	current: RegistryField[]
): PlacementSuggestion {
	const group = classifyField(field.kind, field.label);
	const noun = groupNoun[group];

	if (current.length === 0) {
		return { index: 0, group, reason: 'Placed as the first question.' };
	}

	for (let i = current.length - 1; i >= 0; i -= 1) {
		if (current[i].group === group) {
			return {
				index: i + 1,
				group,
				reason: `Placed with the other ${noun} questions, after “${current[i].label}”.`
			};
		}
	}

	// No group-mate: the start of the nearest following ladder group present.
	// Consent sits last on the ladder, so this scan is also what keeps any
	// unanchored field ahead of the consent fields.
	for (let step = groupLadder.indexOf(group) + 1; step < groupLadder.length; step += 1) {
		const following = groupLadder[step];
		const index = current.findIndex((entry) => entry.group === following);
		if (index >= 0) {
			return {
				index,
				group,
				reason: `First ${noun} question — placed just before the ${groupNoun[following]} questions.`
			};
		}
	}

	return {
		index: current.length,
		group,
		reason:
			group === 'consent'
				? 'Placed at the end — consent always comes last.'
				: `First ${noun} question — placed at the end of the list.`
	};
}
