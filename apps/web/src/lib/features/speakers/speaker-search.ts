import type { SpeakerRow } from '$lib/api/types';

/**
 * Search only the roster fields already disclosed to this client. An address
 * withheld by the live port is an empty string and therefore cannot become a
 * side channel through search.
 */
export function speakerMatchesSearch(row: Pick<SpeakerRow, 'name' | 'email'>, query: string): boolean {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
	if (terms.length === 0) return true;
	const disclosed = `${row.name} ${row.email}`.toLocaleLowerCase();
	return terms.every((term) => disclosed.includes(term));
}
