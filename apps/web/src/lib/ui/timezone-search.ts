import { COUNTRY_NAME_ALIASES, COUNTRY_ZONES } from './timezone-countries';

export interface TimezoneOption {
	id: string;
	label: string;
	region: string;
	searchTerms: readonly string[];
	searchTokens: readonly string[];
	searchCompacts: readonly string[];
	/** Normalized country names this zone belongs to. */
	countryTerms: readonly string[];
	/** Position of this zone within its country, most prominent first. */
	countryRank: number;
}

const PREFERRED_TIMEZONE_IDS: Readonly<Record<string, string>> = {
	'Africa/Asmera': 'Africa/Asmara',
	'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
	'America/Godthab': 'America/Nuuk',
	'Asia/Calcutta': 'Asia/Kolkata',
	'Asia/Katmandu': 'Asia/Kathmandu',
	'Asia/Rangoon': 'Asia/Yangon',
	'Asia/Saigon': 'Asia/Ho_Chi_Minh',
	'Atlantic/Faeroe': 'Atlantic/Faroe',
	'Europe/Kiev': 'Europe/Kyiv',
	'Pacific/Ponape': 'Pacific/Pohnpei',
	'Pacific/Truk': 'Pacific/Chuuk'
};

const REGION_LABELS: Readonly<Record<string, string>> = {
	Africa: 'Africa',
	America: 'Americas',
	Antarctica: 'Antarctica',
	Arctic: 'Arctic',
	Asia: 'Asia',
	Atlantic: 'Atlantic',
	Australia: 'Australia',
	Europe: 'Europe',
	Indian: 'Indian Ocean',
	Pacific: 'Pacific',
	UTC: 'Universal time'
};

export const COMMON_TIMEZONE_IDS = [
	'UTC',
	'America/New_York',
	'America/Chicago',
	'America/Denver',
	'America/Los_Angeles',
	'America/Toronto',
	'America/Vancouver',
	'America/Mexico_City',
	'America/Sao_Paulo',
	'Europe/London',
	'Europe/Paris',
	'Europe/Berlin',
	'Asia/Kolkata',
	'Asia/Singapore',
	'Asia/Hong_Kong',
	'Asia/Tokyo',
	'Australia/Sydney',
	'Pacific/Auckland'
] as const;

const SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
	UTC: ['universal time', 'coordinated universal time', 'gmt', 'zulu'],
	'America/New_York': ['new york city', 'nyc', 'us eastern', 'eastern time', 'est', 'edt'],
	'America/Chicago': ['us central', 'central time', 'cst', 'cdt'],
	'America/Denver': ['us mountain', 'mountain time', 'mst', 'mdt'],
	'America/Phoenix': ['arizona', 'mountain standard time', 'mst'],
	'America/Los_Angeles': ['los angeles', 'la', 'us pacific', 'pacific time', 'pst', 'pdt'],
	'America/Toronto': ['canada eastern', 'eastern time', 'est', 'edt'],
	'America/Vancouver': ['canada pacific', 'pacific time', 'pst', 'pdt'],
	'Europe/London': ['bst'],
	'Europe/Dublin': ['irish time'],
	'Europe/Paris': ['cet', 'cest', 'central european time'],
	'Asia/Kolkata': ['calcutta', 'india standard time', 'ist'],
	'Asia/Singapore': ['sg', 'singapore time', 'sst'],
	'Asia/Hong_Kong': ['hong kong time', 'hkt'],
	'Asia/Tokyo': ['japan standard time', 'jst'],
	'Asia/Ho_Chi_Minh': ['saigon'],
	'Australia/Sydney': ['australian eastern', 'aest', 'aedt'],
	'Pacific/Auckland': ['nzst', 'nzdt']
};

export function normalizeTimezoneSearch(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLocaleLowerCase('en')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function titleCasePart(value: string): string {
	return value
		.replace(/_/g, ' ')
		.split(' ')
		.filter(Boolean)
		.map((word) => word.charAt(0).toLocaleUpperCase('en') + word.slice(1))
		.join(' ');
}

function preferredId(id: string): string {
	return PREFERRED_TIMEZONE_IDS[id] ?? id;
}

/** Normalized country names per zone id, most prominent zone first per country. */
function countryIndex(): Map<string, { terms: string[]; rank: number }> {
	const index = new Map<string, { terms: string[]; rank: number }>();
	let displayNames: Intl.DisplayNames | undefined;
	try {
		displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
	} catch {
		displayNames = undefined;
	}
	for (const [code, zones] of Object.entries(COUNTRY_ZONES)) {
		const names = new Set<string>();
		const display = displayNames?.of(code);
		if (display && display !== code) names.add(normalizeTimezoneSearch(display));
		for (const alias of COUNTRY_NAME_ALIASES[code] ?? []) {
			names.add(normalizeTimezoneSearch(alias));
		}
		if (!names.size) continue;
		zones.forEach((zone, rank) => {
			const entry = index.get(zone) ?? { terms: [], rank };
			entry.terms.push(...names);
			entry.rank = Math.min(entry.rank, rank);
			index.set(zone, entry);
		});
	}
	return index;
}

const COUNTRY_INDEX = countryIndex();

export function createTimezoneOption(id: string): TimezoneOption {
	const parts = id.split('/');
	const topLevel = parts[0] ?? id;
	const label = id === 'UTC' ? 'UTC' : titleCasePart(parts.at(-1) ?? id);
	const region = REGION_LABELS[topLevel] ?? titleCasePart(topLevel);
	const locationPath = parts.slice(1).map(titleCasePart).join(' ');
	const country = COUNTRY_INDEX.get(id);
	const countryTerms = Array.from(new Set(country?.terms ?? []));
	const terms = Array.from(
		new Set(
			[id, label, region, locationPath, `${region} ${locationPath}`, ...(SEARCH_ALIASES[id] ?? [])]
				.map(normalizeTimezoneSearch)
				.filter(Boolean)
		)
	);
	const tokens = Array.from(
		new Set([...terms, ...countryTerms].flatMap((term) => term.split(' ')))
	);

	return {
		id,
		label,
		region,
		searchTerms: terms,
		searchTokens: tokens,
		searchCompacts: Array.from(new Set(terms.map((term) => term.replace(/\s/g, '')))),
		countryTerms,
		countryRank: country?.rank ?? 0
	};
}

function supportedTimezoneIds(): string[] {
	const supported =
		typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
	return Array.from(
		new Set(['UTC', ...COMMON_TIMEZONE_IDS, ...supported.map(preferredId)])
	).sort((a, b) => a.localeCompare(b, 'en'));
}

export const TIMEZONE_OPTIONS: readonly TimezoneOption[] = supportedTimezoneIds().map(
	createTimezoneOption
);

const TIMEZONE_BY_ID = new Map(TIMEZONE_OPTIONS.map((option) => [option.id, option]));

export function timezoneOptionFor(value: string): TimezoneOption | undefined {
	return TIMEZONE_BY_ID.get(preferredId(value));
}

export function displayTimezone(value: string): string {
	return timezoneOptionFor(value)?.label ?? value;
}

/** The zone this device reports, mapped onto a known option when possible. */
export function deviceTimezoneOption(): TimezoneOption | undefined {
	try {
		return timezoneOptionFor(Intl.DateTimeFormat().resolvedOptions().timeZone);
	} catch {
		return undefined;
	}
}

const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const OFFSET_MINUTES = new Map<string, { bucket: number; minutes: number | null }>();

/** Current UTC offset in minutes east, DST-aware; null for an unknown zone. */
export function timezoneOffsetMinutes(id: string): number | null {
	// Memoized per minute so DST transitions are honored without reformatting
	// every zone on every keystroke.
	const bucket = Math.floor(Date.now() / 60_000);
	const cached = OFFSET_MINUTES.get(id);
	if (cached && cached.bucket === bucket) return cached.minutes;

	let minutes: number | null = null;
	try {
		let formatter = OFFSET_FORMATTERS.get(id);
		if (!formatter) {
			formatter = new Intl.DateTimeFormat('en', { timeZone: id, timeZoneName: 'longOffset' });
			OFFSET_FORMATTERS.set(id, formatter);
		}
		const name = formatter
			.formatToParts(new Date())
			.find((part) => part.type === 'timeZoneName')?.value;
		const match = name ? /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name) : null;
		if (match) {
			minutes = match[1]
				? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
				: 0;
		}
	} catch {
		minutes = null;
	}
	OFFSET_MINUTES.set(id, { bucket, minutes });
	return minutes;
}

/** Short human offset such as `GMT+8`, `GMT+5:30`, or `GMT-4`; '' when unknown. */
export function timezoneOffsetLabel(id: string): string {
	const minutes = timezoneOffsetMinutes(id);
	if (minutes === null) return '';
	const sign = minutes < 0 ? '-' : '+';
	const absolute = Math.abs(minutes);
	const hours = Math.floor(absolute / 60);
	const rest = absolute % 60;
	return `GMT${sign}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/**
 * Reads an offset query such as `+8`, `-5:30`, `gmt+8`, `utc 2`, or `GMT+05:30`.
 * Runs on the raw query: normalization would strip the sign.
 */
function parseOffsetQuery(raw: string): number | null {
	const match = /^\s*(?:(gmt|utc)\s*([+-]?)|([+-]))\s*(\d{1,2})(?::?([0-5]\d))?\s*$/i.exec(raw);
	if (!match) return null;
	const sign = (match[2] || match[3]) === '-' ? -1 : 1;
	const hours = Number(match[4]);
	const minutes = Number(match[5] ?? 0);
	if (hours > 14) return null;
	return sign * (hours * 60 + minutes);
}

function typoAllowance(length: number): number {
	if (length <= 3) return 0;
	if (length <= 6) return 1;
	if (length <= 10) return 2;
	return 3;
}

/** Optimal-string-alignment distance with a hard cutoff for inexpensive typo matching. */
function editDistanceWithin(left: string, right: string, limit: number): number {
	if (left === right) return 0;
	if (limit === 0 || Math.abs(left.length - right.length) > limit) return limit + 1;

	const rows = Array.from({ length: left.length + 1 }, () =>
		Array<number>(right.length + 1).fill(0)
	);
	for (let index = 0; index <= left.length; index += 1) rows[index][0] = index;
	for (let index = 0; index <= right.length; index += 1) rows[0][index] = index;

	for (let row = 1; row <= left.length; row += 1) {
		let rowBest = limit + 1;
		for (let column = 1; column <= right.length; column += 1) {
			const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
			rows[row][column] = Math.min(
				rows[row - 1][column] + 1,
				rows[row][column - 1] + 1,
				rows[row - 1][column - 1] + substitution
			);
			if (
				row > 1 &&
				column > 1 &&
				left[row - 1] === right[column - 2] &&
				left[row - 2] === right[column - 1]
			) {
				rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + 1);
			}
			rowBest = Math.min(rowBest, rows[row][column]);
		}
		if (rowBest > limit) return limit + 1;
	}

	return rows[left.length][right.length] <= limit ? rows[left.length][right.length] : limit + 1;
}

function scoreOption(option: TimezoneOption, query: string): number | null {
	const queryCompact = query.replace(/\s/g, '');
	const queryTokens = query.split(' ');
	// A country hit ranks the country's zones by prominence, principal city first.
	const countryTie = option.countryRank * 0.001;

	if (option.searchTerms.includes(query)) return 0;
	if (option.searchCompacts.includes(queryCompact)) return 1;
	if (option.countryTerms.includes(query)) return 2 + countryTie;
	if (option.searchTerms.some((term) => term.startsWith(query))) return 4;
	if (option.searchCompacts.some((term) => term.startsWith(queryCompact))) return 5;
	if (option.countryTerms.some((term) => term.startsWith(query))) return 6 + countryTie;
	if (option.searchTerms.some((term) => term.includes(query))) return 8;
	if (option.searchCompacts.some((term) => term.includes(queryCompact))) return 9;
	if (option.countryTerms.some((term) => term.includes(query))) return 10 + countryTie;

	let fuzzyCost = 0;
	for (const queryToken of queryTokens) {
		const allowance = typoAllowance(queryToken.length);
		let best = allowance + 1;
		for (const candidate of option.searchTokens) {
			if (candidate.startsWith(queryToken)) {
				best = 0;
				break;
			}
			best = Math.min(best, editDistanceWithin(queryToken, candidate, allowance));
		}
		if (best > allowance) return null;
		fuzzyCost += best;
	}

	return 20 + fuzzyCost * 3;
}

const COMMON_RANK = new Map<string, number>(COMMON_TIMEZONE_IDS.map((id, index) => [id, index]));

function searchByOffset(minutes: number, limit: number): readonly TimezoneOption[] {
	return TIMEZONE_OPTIONS.filter((option) => timezoneOffsetMinutes(option.id) === minutes)
		.sort(
			(left, right) =>
				(COMMON_RANK.get(left.id) ?? Infinity) - (COMMON_RANK.get(right.id) ?? Infinity) ||
				left.label.localeCompare(right.label, 'en')
		)
		.slice(0, limit);
}

/** The curated browse list shown before any query is typed, in full. */
export function commonTimezoneOptions(): readonly TimezoneOption[] {
	return COMMON_TIMEZONE_IDS.map((id) => TIMEZONE_BY_ID.get(id)).filter(
		(option): option is TimezoneOption => option !== undefined
	);
}

/**
 * Every zone, ordered for browsing: current GMT offset ascending, the
 * recognizable hub cities leading their offset group, then alphabetical.
 * Zones whose offset cannot be computed sink to the end.
 */
export function browseTimezoneOptions(): readonly TimezoneOption[] {
	return [...TIMEZONE_OPTIONS].sort((left, right) => {
		const leftOffset = timezoneOffsetMinutes(left.id);
		const rightOffset = timezoneOffsetMinutes(right.id);
		return (
			(leftOffset ?? Infinity) - (rightOffset ?? Infinity) ||
			(COMMON_RANK.get(left.id) ?? Infinity) - (COMMON_RANK.get(right.id) ?? Infinity) ||
			left.label.localeCompare(right.label, 'en') ||
			left.id.localeCompare(right.id, 'en')
		);
	});
}

export function searchTimezones(query: string, limit = 12): readonly TimezoneOption[] {
	const offsetMinutes = parseOffsetQuery(query);
	if (offsetMinutes !== null) return searchByOffset(offsetMinutes, limit);

	const normalized = normalizeTimezoneSearch(query);
	if (!normalized) return commonTimezoneOptions().slice(0, limit);

	return TIMEZONE_OPTIONS.map((option) => ({ option, score: scoreOption(option, normalized) }))
		.filter(
			(result): result is { option: TimezoneOption; score: number } => result.score !== null
		)
		.sort(
			(left, right) =>
				left.score - right.score ||
				left.option.label.localeCompare(right.option.label, 'en') ||
				left.option.id.localeCompare(right.option.id, 'en')
		)
		.slice(0, limit)
		.map(({ option }) => option);
}
