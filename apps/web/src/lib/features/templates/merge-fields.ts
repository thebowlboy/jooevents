import type { MergeFieldDef } from '../../api/types';

/**
 * One run of template text as a renderer consumes it: either literal words, or
 * a declared merge field with the label and sample the preview shows in its
 * place. An undeclared `{{token}}` stays literal text — the preview shows
 * exactly what the recipient would get, never an invented value.
 */
export type MergeSegment =
	| { kind: 'text'; text: string }
	| { kind: 'field'; key: string; label: string; sample: string };

const tokenPattern = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Every declared token occurrence in `text`, in order, with its span in the
 * raw string — the addressing scheme merge-chip editing uses: the n-th chip a
 * preview renders is the n-th entry here.
 */
export function declaredTokens(
	text: string,
	fields: MergeFieldDef[]
): { key: string; start: number; end: number }[] {
	const tokens: { key: string; start: number; end: number }[] = [];
	for (const match of text.matchAll(tokenPattern)) {
		if (!fields.some((field) => field.key === match[1])) continue;
		const start = match.index ?? 0;
		tokens.push({ key: match[1], start, end: start + match[0].length });
	}
	return tokens;
}

/** Splits template text into literal runs and resolved merge-field segments. */
export function segmentMergeText(text: string, fields: MergeFieldDef[]): MergeSegment[] {
	const segments: MergeSegment[] = [];
	let cursor = 0;
	for (const match of text.matchAll(tokenPattern)) {
		const index = match.index ?? 0;
		const field = fields.find((entry) => entry.key === match[1]);
		if (!field) continue;
		if (index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, index) });
		segments.push({ kind: 'field', key: field.key, label: field.label, sample: field.sample });
		cursor = index + match[0].length;
	}
	if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
	return segments;
}
