/**
 * Text search: folding, parsing, matching, and ranking, defined once.
 *
 * This is the reference implementation of the search contract, and it lives in
 * shared code rather than inside a query adapter on purpose. Search behaviour is
 * user-visible — what folds to what, whether a partial word matches, and which
 * hit outranks which — so it is a product decision, not a storage detail. A
 * SQLite or PostgreSQL adapter answers the same parsed query and must agree
 * with these rules.
 *
 * Where two engines *cannot* agree, the contract is on properties rather than
 * on the sequence: BM25 and `ts_rank_cd` will never produce an identical
 * ordering, so what is guaranteed is that a matching row comes back, that a
 * title hit outranks a body-only hit, and that ties break on a stable key.
 * A conformance suite asserting exact ordering would only get weakened until it
 * meant nothing.
 */

/**
 * Letters `NFKD` cannot decompose, because they are atomic rather than a base
 * plus a combining mark. Without these, folding handles `José` and silently
 * fails `Sørensen` — and a search that finds neither the person nor an
 * explanation reads as absence rather than as a near miss.
 *
 * Expansions may be longer than one character (`ß` → `ss`); the offset map
 * built alongside the fold is what keeps highlight ranges pointing at the right
 * source characters when they are.
 */
const ATOMIC_FOLDS: Readonly<Record<string, string>> = {
	ø: 'o',
	Ø: 'o',
	ı: 'i',
	İ: 'i',
	ł: 'l',
	Ł: 'l',
	đ: 'd',
	Đ: 'd',
	ð: 'd',
	Ð: 'd',
	þ: 'th',
	Þ: 'th',
	ß: 'ss',
	ẞ: 'ss',
	æ: 'ae',
	Æ: 'ae',
	œ: 'oe',
	Œ: 'oe',
	ŋ: 'n',
	Ŋ: 'n',
	ħ: 'h',
	Ħ: 'h',
	ŧ: 't',
	Ŧ: 't',
	ĸ: 'k',
	ſ: 's'
};

/** Folded text plus, per folded character, the source index it came from. */
export interface FoldedText {
	readonly folded: string;
	/** `source[map[i]]` is the character folded position `i` was produced from. */
	readonly map: readonly number[];
}

/**
 * Folds text to its searchable form, keeping a map back to the source.
 *
 * The map exists so a match can be shown in the words the person actually
 * wrote. Folding is not length-preserving — `ß` becomes two characters, a
 * combining mark disappears, a run of punctuation collapses to one space — so
 * an index into the folded string is not an index into the source, and
 * highlighting from the wrong one lands the marks a character or two off.
 */
export function foldSearchText(value: string): FoldedText {
	let folded = '';
	const map: number[] = [];
	let pendingSeparator = false;

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index] as string;
		// The range is written as escapes rather than as literal combining marks:
		// spelled literally it is a run of invisible characters that any editor,
		// diff, or copy-paste can silently alter without the source looking wrong.
		const expanded = ATOMIC_FOLDS[char] ?? char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
		const lowered = expanded.toLocaleLowerCase('en');

		for (const out of lowered) {
			if (/[a-z0-9]/.test(out)) {
				// A separator only becomes a space once something follows it, so the
				// folded form never carries a leading or trailing one.
				if (pendingSeparator && folded.length > 0) {
					folded += ' ';
					map.push(index);
				}
				pendingSeparator = false;
				folded += out;
				map.push(index);
			} else {
				pendingSeparator = true;
			}
		}
	}

	return { folded, map };
}

/** The folded form alone, for callers with nothing to highlight. */
export function fold(value: string): string {
	return foldSearchText(value).folded;
}

/**
 * The two match spaces, kept apart because one of them can identify a person.
 *
 * Blind review is the shipped default, and speaker identity is one of its two
 * hidden axes. A reviewer who types a name into an unpartitioned search and
 * gets a submission back has deanonymised it without ever seeing an identity
 * field rendered — the result itself is the disclosure. So identity text is
 * matched separately and a caller under a blind policy simply does not pass it.
 *
 * This has to exist from the first version. It is not a field list that can be
 * narrowed later: every caller that has already been written against an
 * unpartitioned matcher would need re-auditing.
 */
export type SearchSpace = 'body' | 'identity';

/** How strongly a hit in this text counts. */
export type SearchWeight = 'primary' | 'secondary';

export interface SearchableField {
	readonly text: string;
	readonly space: SearchSpace;
	/** `primary` is what the row is called — a title, a person's name. */
	readonly weight: SearchWeight;
}

/** One term of a query. A phrase matches as written; a word may match a prefix. */
export interface SearchTerm {
	readonly folded: string;
	readonly phrase: boolean;
}

export interface ParsedSearch {
	readonly terms: readonly SearchTerm[];
	/** What the person typed, for echoing back in counts and empty states. */
	readonly raw: string;
}

/**
 * Parses a raw query into terms.
 *
 * Double quotes group words into a phrase; everything else splits on
 * whitespace. Terms combine with AND, which is what a person narrowing a list
 * expects — each word they add should remove rows, never add them.
 *
 * An unclosed quote is treated as closing at the end of the input rather than
 * as an error: the query is being re-parsed on every keystroke, so a half-typed
 * phrase is the normal state of the field, not a mistake to report.
 */
export function parseSearch(raw: string): ParsedSearch {
	const terms: SearchTerm[] = [];
	const seen = new Set<string>();

	for (const [, quoted, bare] of raw.matchAll(/"([^"]*)"?|(\S+)/g)) {
		const source = quoted ?? bare ?? '';
		const folded = fold(source);
		if (!folded) continue;
		const phrase = quoted !== undefined;
		const key = `${phrase ? 'p' : 'w'}:${folded}`;
		if (seen.has(key)) continue;
		seen.add(key);
		terms.push({ folded, phrase });
	}

	return { terms, raw };
}

/** A matched span, in source-string coordinates. */
export interface MatchRange {
	readonly start: number;
	readonly end: number;
}

export interface FieldMatch {
	readonly space: SearchSpace;
	readonly weight: SearchWeight;
	readonly ranges: readonly MatchRange[];
}

export interface SearchMatch {
	/** Lower sorts first. */
	readonly rank: number;
	/** Which spaces contributed, so a caller can tell why a row came back. */
	readonly spaces: ReadonlySet<SearchSpace>;
	/** Per-field spans, positionally aligned with the fields passed in. */
	readonly fields: readonly (FieldMatch | null)[];
}

/**
 * Rank tiers, best first. A word that starts a hit reads as a deliberate match;
 * one buried mid-word reads as a coincidence, so boundary hits sort above
 * infix hits before either field weight is considered.
 */
const RANK_PRIMARY_BOUNDARY = 0;
const RANK_SECONDARY_BOUNDARY = 1;
const RANK_PRIMARY_INFIX = 2;
const RANK_SECONDARY_INFIX = 3;
const RANK_NONE = Number.POSITIVE_INFINITY;

function tierFor(weight: SearchWeight, boundary: boolean): number {
	if (weight === 'primary') return boundary ? RANK_PRIMARY_BOUNDARY : RANK_PRIMARY_INFIX;
	return boundary ? RANK_SECONDARY_BOUNDARY : RANK_SECONDARY_INFIX;
}

/** Every occurrence of `needle` in `folded`, as folded-space ranges. */
function occurrences(folded: string, needle: string): { start: number; end: number }[] {
	const found: { start: number; end: number }[] = [];
	let from = 0;
	for (;;) {
		const at = folded.indexOf(needle, from);
		if (at < 0) return found;
		found.push({ start: at, end: at + needle.length });
		from = at + 1;
	}
}

/** Maps a folded-space range onto the source characters that produced it. */
function toSource(folded: FoldedText, range: { start: number; end: number }): MatchRange | null {
	const first = folded.map[range.start];
	const last = folded.map[range.end - 1];
	if (first === undefined || last === undefined) return null;
	return { start: first, end: last + 1 };
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
	if (ranges.length < 2) return ranges;
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: MatchRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end };
			continue;
		}
		merged.push(range);
	}
	return merged;
}

/**
 * Matches one record's fields against a parsed query.
 *
 * Every term must hit *somewhere* — the AND is across the record, not within a
 * single field, so "kubernetes sørensen" matches a talk whose title carries one
 * word and whose speaker carries the other. Returns null when any term has no
 * hit at all, which is what makes an added word narrow the list.
 *
 * A bare word matches a prefix or an infix; a quoted phrase matches only as
 * written. Neither ever matches across a field boundary.
 */
export function matchFields(
	fields: readonly SearchableField[],
	query: ParsedSearch
): SearchMatch | null {
	if (query.terms.length === 0) return null;

	const folded = fields.map((field) => foldSearchText(field.text));
	const perField: (MatchRange[] | null)[] = fields.map(() => null);
	const spaces = new Set<SearchSpace>();
	let best = RANK_NONE;

	for (const term of query.terms) {
		let hit = false;

		for (let index = 0; index < fields.length; index += 1) {
			const field = fields[index] as SearchableField;
			const text = folded[index] as FoldedText;
			if (!text.folded) continue;

			for (const span of occurrences(text.folded, term.folded)) {
				// A phrase must sit on word boundaries at both ends; a word only has
				// to start one, so typing "kube" still finds "Kubernetes".
				const startsWord = span.start === 0 || text.folded[span.start - 1] === ' ';
				const endsWord = span.end === text.folded.length || text.folded[span.end] === ' ';
				if (term.phrase && !(startsWord && endsWord)) continue;

				hit = true;
				spaces.add(field.space);
				best = Math.min(best, tierFor(field.weight, startsWord));

				const source = toSource(text, span);
				if (!source) continue;
				const existing = perField[index];
				if (existing) existing.push(source);
				else perField[index] = [source];
			}
		}

		if (!hit) return null;
	}

	return {
		rank: best,
		spaces,
		fields: fields.map((field, index) => {
			const ranges = perField[index];
			return ranges ? { space: field.space, weight: field.weight, ranges: mergeRanges(ranges) } : null;
		})
	};
}

/**
 * Splits text into rendered segments, marking the matched ones.
 *
 * Highlighting is the honest answer to "why is this row here" — and it teaches
 * the field scope without a legend, because a person sees the hit land in the
 * abstract and learns the abstract is searched.
 */
export interface HighlightSegment {
	readonly text: string;
	readonly match: boolean;
}

export function highlight(text: string, ranges: readonly MatchRange[]): HighlightSegment[] {
	if (ranges.length === 0) return [{ text, match: false }];
	const segments: HighlightSegment[] = [];
	let at = 0;
	for (const range of ranges) {
		if (range.start > at) segments.push({ text: text.slice(at, range.start), match: false });
		segments.push({ text: text.slice(range.start, range.end), match: true });
		at = range.end;
	}
	if (at < text.length) segments.push({ text: text.slice(at), match: false });
	return segments;
}

/**
 * Orders matched records: rank first, then the caller's own stable key.
 *
 * The tie-break is required rather than tidy. Two records at the same rank must
 * come back in the same order every time, or a re-read after a keystroke
 * reshuffles rows under the reader's cursor — and cursor pagination over an
 * unstable order silently skips and repeats rows.
 */
export function compareMatches(
	a: { match: SearchMatch; key: string },
	b: { match: SearchMatch; key: string }
): number {
	return a.match.rank - b.match.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
