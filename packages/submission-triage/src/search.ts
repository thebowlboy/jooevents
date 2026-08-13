import type { SubmissionTriageProjectionDto } from '@jooevents/contracts/submission-triage';

const ATOMIC_FOLDS: Readonly<Record<string, string>> = Object.freeze({
  ø: 'o', Ø: 'o', ı: 'i', İ: 'i', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd',
  þ: 'th', Þ: 'th', ß: 'ss', ẞ: 'ss', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ŋ: 'n', Ŋ: 'n', ħ: 'h', Ħ: 'h', ŧ: 't', Ŧ: 't', ĸ: 'k', ſ: 's'
});

export interface SubmissionTriageSearchTerm {
  readonly folded: string;
  readonly phrase: boolean;
}

export interface SubmissionTriageParsedSearch {
  readonly raw: string;
  readonly terms: readonly SubmissionTriageSearchTerm[];
}

export interface SubmissionTriageSearchMatch {
  /** Lower sorts first; stable submission id is the required tie-break. */
  readonly rank: number;
}

export function foldSubmissionTriageSearchText(value: string): string {
  let folded = '';
  let pendingSeparator = false;
  for (const char of value) {
    const expanded = ATOMIC_FOLDS[char]
      ?? char.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
    for (const out of expanded.toLocaleLowerCase('en')) {
      if (/[a-z0-9]/u.test(out)) {
        if (pendingSeparator && folded.length > 0) folded += ' ';
        pendingSeparator = false;
        folded += out;
      } else {
        pendingSeparator = true;
      }
    }
  }
  return folded;
}

export function parseSubmissionTriageSearch(raw: string): SubmissionTriageParsedSearch {
  const terms: SubmissionTriageSearchTerm[] = [];
  const seen = new Set<string>();
  for (const [, quoted, bare] of raw.matchAll(/"([^"]*)"?|(\S+)/gu)) {
    const folded = foldSubmissionTriageSearchText(quoted ?? bare ?? '');
    if (!folded) continue;
    const phrase = quoted !== undefined;
    const key = `${phrase ? 'p' : 'w'}:${folded}`;
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(Object.freeze({ folded, phrase }));
    }
  }
  return Object.freeze({ raw, terms: Object.freeze(terms) });
}

/**
 * Mirrors the tuned row matcher over fields present in the safe projection.
 * Email/contact is deliberately absent; a withheld field cannot influence the
 * result set and disclose itself through membership.
 */
export function matchSubmissionTriageProjection(
  row: SubmissionTriageProjectionDto,
  query: SubmissionTriageParsedSearch
): SubmissionTriageSearchMatch | null {
  if (query.terms.length === 0) return null;
  const fields = [
    { text: row.source.summary.title ?? '', weight: 0 },
    { text: row.source.abstract ?? '', weight: 1 },
    { text: row.source.summary.primaryParticipantName ?? '', weight: 0 }
  ].map((field) => ({ ...field, folded: foldSubmissionTriageSearchText(field.text) }));
  let best = Number.POSITIVE_INFINITY;
  for (const term of query.terms) {
    let termHit = false;
    for (const field of fields) {
      let from = 0;
      for (;;) {
        const at = field.folded.indexOf(term.folded, from);
        if (at < 0) break;
        const end = at + term.folded.length;
        const startsWord = at === 0 || field.folded[at - 1] === ' ';
        const endsWord = end === field.folded.length || field.folded[end] === ' ';
        if (!term.phrase || (startsWord && endsWord)) {
          termHit = true;
          best = Math.min(best, startsWord ? field.weight : field.weight + 2);
        }
        from = at + 1;
      }
    }
    if (!termHit) return null;
  }
  return Object.freeze({ rank: best });
}
