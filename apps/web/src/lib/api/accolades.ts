import type { AccoladeDef, AccoladeKey } from './types';
import type { ReviewAccoladeKeyDto } from '@jooevents/contracts/reviews';

const ACCOLADE_WIRE_PREFIX = 'accolade.';

export function accoladePortKey(key: ReviewAccoladeKeyDto): AccoladeKey {
	return key.slice(ACCOLADE_WIRE_PREFIX.length) as AccoladeKey;
}

export function accoladeWireKey(key: AccoladeKey): ReviewAccoladeKeyDto {
	return `${ACCOLADE_WIRE_PREFIX}${key}` as ReviewAccoladeKeyDto;
}

/**
 * The accolades a reviewer may pin. Two of them are capped, because a mark
 * that can be given to everything ranks nothing.
 */
export const accoladeCatalog: AccoladeDef[] = [
	{ key: 'top_pick', label: 'Top pick', cap: 3 },
	{ key: 'hidden_gem', label: 'Hidden gem', cap: 3 },
	{ key: 'crowd_draw', label: 'Crowd draw' },
	{ key: 'bold_bet', label: 'Bold bet' }
];

export function accoladeDef(key: AccoladeKey): AccoladeDef | undefined {
	return accoladeCatalog.find((entry) => entry.key === key);
}

/** “A”, “A” and “B”, “A”, “B”, and “C” — a refusal names what is in the way. */
export function nameList(titles: string[]): string {
	const quoted = titles.map((title) => `“${title}”`);
	if (quoted.length <= 1) return quoted.join('');
	if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
	return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
}

/**
 * The one sentence a spent capped key refuses with. Composed in exactly one
 * place so the refusal a pin answers with and the unavailability a surface
 * shows ahead of it can never drift apart.
 */
export function composeCapRefusal(def: AccoladeDef, holderTitles: string[]): string {
	return `${def.label} is capped at ${def.cap} and already on ${nameList(holderTitles)} — unpin one first.`;
}
