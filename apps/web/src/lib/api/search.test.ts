import { describe, expect, test } from 'bun:test';
import {
	compareMatches,
	fold,
	foldSearchText,
	highlight,
	matchFields,
	parseSearch,
	type SearchableField
} from './search';

const body = (text: string, weight: 'primary' | 'secondary' = 'secondary'): SearchableField => ({
	text,
	space: 'body',
	weight
});
const identity = (text: string): SearchableField => ({
	text,
	space: 'identity',
	weight: 'primary'
});

describe('fold', () => {
	test('decomposes accents to their base letter', () => {
		expect(fold('José Ramírez')).toBe('jose ramirez');
		expect(fold('Ana Þórsdóttir')).toBe('ana thorsdottir');
	});

	// The regression this whole map exists for: NFKD leaves atomic letters
	// alone, so without it someone typing "Sorensen" is told there is no such
	// person rather than shown one.
	test('folds letters NFKD cannot decompose', () => {
		expect(fold('Mikkel Sørensen')).toBe('mikkel sorensen');
		expect(fold('Elif Aydın')).toBe('elif aydin');
		expect(fold('Łukasz Nowak')).toBe('lukasz nowak');
		expect(fold('Đorđe Petrović')).toBe('dorde petrovic');
		expect(fold('Straße')).toBe('strasse');
		expect(fold('Ægir Œuvre')).toBe('aegir oeuvre');
	});

	test('collapses punctuation and whitespace to single separators', () => {
		expect(fold('  Ops — “at scale”:  2026!  ')).toBe('ops at scale 2026');
		expect(fold('CI/CD')).toBe('ci cd');
	});

	test('holds no leading or trailing separator', () => {
		expect(fold('...hello...')).toBe('hello');
	});

	test('maps every folded character back to a source index', () => {
		const { folded, map } = foldSearchText('Straße!');
		expect(folded).toBe('strasse');
		expect(map).toHaveLength(folded.length);
		// Both characters of the expansion point at the single source `ß`.
		expect(map[folded.indexOf('ss')]).toBe(4);
		expect(map[folded.indexOf('ss') + 1]).toBe(4);
	});
});

describe('parseSearch', () => {
	test('splits on whitespace and folds each term', () => {
		expect(parseSearch('Kubernetes  Sørensen').terms).toEqual([
			{ folded: 'kubernetes', phrase: false },
			{ folded: 'sorensen', phrase: false }
		]);
	});

	test('groups a quoted phrase', () => {
		expect(parseSearch('"at scale" ops').terms).toEqual([
			{ folded: 'at scale', phrase: true },
			{ folded: 'ops', phrase: false }
		]);
	});

	// The field re-parses on every keystroke, so a half-typed phrase is the
	// normal state of the input rather than something to report.
	test('treats an unclosed quote as closing at the end', () => {
		expect(parseSearch('"at sca').terms).toEqual([{ folded: 'at sca', phrase: true }]);
	});

	test('drops duplicates and terms that fold to nothing', () => {
		expect(parseSearch('ops ops --- ops').terms).toEqual([{ folded: 'ops', phrase: false }]);
	});

	test('an empty query has no terms', () => {
		expect(parseSearch('   ').terms).toEqual([]);
		expect(matchFields([body('anything')], parseSearch(''))).toBeNull();
	});
});

describe('matchFields', () => {
	const fields = [body('Scaling Kubernetes', 'primary'), body('Running stateful workloads')];

	test('matches a prefix inside a word', () => {
		expect(matchFields(fields, parseSearch('kube'))).not.toBeNull();
	});

	test('matches an infix', () => {
		expect(matchFields(fields, parseSearch('ernet'))).not.toBeNull();
	});

	test('a phrase matches only on word boundaries', () => {
		expect(matchFields(fields, parseSearch('"stateful workloads"'))).not.toBeNull();
		expect(matchFields(fields, parseSearch('"tateful"'))).toBeNull();
	});

	// Each added word must remove rows, never add them.
	test('every term must hit, across the record rather than within one field', () => {
		expect(matchFields(fields, parseSearch('kubernetes stateful'))).not.toBeNull();
		expect(matchFields(fields, parseSearch('kubernetes absent'))).toBeNull();
	});

	test('never matches across a field boundary', () => {
		expect(matchFields(fields, parseSearch('"kubernetes running"'))).toBeNull();
	});

	test('a boundary hit outranks an infix hit', () => {
		const boundary = matchFields([body('Kubernetes', 'primary')], parseSearch('kube'));
		const infix = matchFields([body('Prekubernetes', 'primary')], parseSearch('kube'));
		expect(boundary!.rank).toBeLessThan(infix!.rank);
	});

	test('a primary hit outranks a secondary hit at the same boundary', () => {
		const primary = matchFields([body('Ops at scale', 'primary')], parseSearch('ops'));
		const secondary = matchFields([body('Ops at scale', 'secondary')], parseSearch('ops'));
		expect(primary!.rank).toBeLessThan(secondary!.rank);
	});
});

describe('identity partition', () => {
	const withPerson = [body('Scaling Kubernetes', 'primary'), identity('Mikkel Sørensen')];

	test('reports which space produced the match', () => {
		expect([...matchFields(withPerson, parseSearch('sorensen'))!.spaces]).toEqual(['identity']);
		expect([...matchFields(withPerson, parseSearch('kubernetes'))!.spaces]).toEqual(['body']);
	});

	// The blind-review guarantee: a caller under a blind policy passes body
	// fields only, and a name then finds nothing — the result set itself cannot
	// disclose who wrote the submission.
	test('a name cannot match when identity fields are withheld', () => {
		const blind = withPerson.filter((field) => field.space === 'body');
		expect(matchFields(blind, parseSearch('sorensen'))).toBeNull();
		expect(matchFields(blind, parseSearch('kubernetes'))).not.toBeNull();
	});
});

describe('highlight', () => {
	test('splits a field into matched and unmatched segments', () => {
		const match = matchFields([body('Scaling Kubernetes')], parseSearch('kube'))!;
		const ranges = match.fields[0]!.ranges;
		expect(highlight('Scaling Kubernetes', ranges)).toEqual([
			{ text: 'Scaling ', match: false },
			{ text: 'Kube', match: true },
			{ text: 'rnetes', match: false }
		]);
	});

	// Folding is not length-preserving, so a range taken from folded
	// coordinates would land the marks off by the width of the expansion.
	test('marks the source characters an expanded fold came from', () => {
		const match = matchFields([body('Straße')], parseSearch('strasse'))!;
		expect(highlight('Straße', match.fields[0]!.ranges)).toEqual([
			{ text: 'Straße', match: true }
		]);
	});

	// `kube` covers [0,4) and `bern` covers [2,6); one mark spanning "Kubern"
	// reads as one hit, where two abutting marks read as two.
	test('merges overlapping ranges from separate terms', () => {
		const match = matchFields([body('Kubernetes')], parseSearch('kube bern'))!;
		expect(match.fields[0]!.ranges).toEqual([{ start: 0, end: 6 }]);
	});

	test('an unmatched field renders as one plain segment', () => {
		expect(highlight('Untouched', [])).toEqual([{ text: 'Untouched', match: false }]);
	});
});

describe('compareMatches', () => {
	test('orders by rank, then by the stable key', () => {
		const one = matchFields([body('Ops', 'primary')], parseSearch('ops'))!;
		const two = matchFields([body('Ops', 'secondary')], parseSearch('ops'))!;
		expect(compareMatches({ match: one, key: 'z' }, { match: two, key: 'a' })).toBeLessThan(0);
		expect(compareMatches({ match: one, key: 'b' }, { match: one, key: 'a' })).toBeGreaterThan(0);
		expect(compareMatches({ match: one, key: 'a' }, { match: one, key: 'a' })).toBe(0);
	});
});
