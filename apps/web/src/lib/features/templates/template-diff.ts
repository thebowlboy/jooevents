import {
	isSurfaceTemplate,
	type AnyTemplate,
	type MessageTemplate,
	type SurfaceBlock,
	type SurfaceTemplate,
	type TemplateBlock,
	type TextStyle
} from '../../api/types';
import { styleDelta, type StyleUnitKind } from './text-style';

/**
 * A structural account of what a draft changes against its base: one entry per
 * added, removed, or edited piece, in document order. The diff is computed from
 * the two block arrays alone — it is the review surface for an agent-drafted
 * revision, so it must be deterministic and derived only from the data being
 * reviewed.
 */
export interface TemplateDiffEntry {
	kind: 'added' | 'removed' | 'edited';
	/** What changed: `Subject`, a block-type label (`Heading`, `Hero`, ...), or a suffixed field (`Schedule layout · grouping`). */
	target: string;
	/** The text the base carried; present on edits and text-carrying removals. */
	before?: string;
	/** The text the draft carries; present on edits and text-carrying additions. */
	after?: string;
}

/**
 * How one block vocabulary turns into diff entries. The alignment machinery
 * below is shared; message and surface blocks differ only in these three
 * accounts of themselves.
 */
interface BlockDiffSpec<T extends { type: string }> {
	/** The label an added/removed block carries in the strip. */
	label(block: T): string;
	/** The text shown beside an added/removed block's label; '' shows none. */
	text(block: T): string;
	/** Entries for two same-type blocks that paired up as an edit. */
	edited(before: T, after: T): TemplateDiffEntry[];
}

function signature(block: unknown): string {
	return JSON.stringify(block);
}

/**
 * Diffs two block arrays. Identical blocks anchor the alignment (longest common
 * subsequence); between anchors, blocks of the same type pair up in order as
 * edits, and what remains unpaired is an addition or a removal.
 */
function diffBlockLists<T extends { type: string }>(
	base: T[],
	draft: T[],
	spec: BlockDiffSpec<T>
): TemplateDiffEntry[] {
	const n = base.length;
	const m = draft.length;
	const common: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			common[i][j] =
				signature(base[i]) === signature(draft[j])
					? common[i + 1][j + 1] + 1
					: Math.max(common[i + 1][j], common[i][j + 1]);
		}
	}

	const entries: TemplateDiffEntry[] = [];
	let pendingBase: T[] = [];
	let pendingDraft: T[] = [];

	const flush = () => {
		const removedOnly: T[] = [];
		for (const gone of pendingBase) {
			const partner = pendingDraft.findIndex((candidate) => candidate.type === gone.type);
			if (partner >= 0) {
				const [came] = pendingDraft.splice(partner, 1);
				entries.push(...spec.edited(gone, came));
			} else {
				removedOnly.push(gone);
			}
		}
		for (const gone of removedOnly) {
			const text = spec.text(gone);
			entries.push({ kind: 'removed', target: spec.label(gone), ...(text ? { before: text } : {}) });
		}
		for (const came of pendingDraft) {
			const text = spec.text(came);
			entries.push({ kind: 'added', target: spec.label(came), ...(text ? { after: text } : {}) });
		}
		pendingBase = [];
		pendingDraft = [];
	};

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (signature(base[i]) === signature(draft[j])) {
			flush();
			i += 1;
			j += 1;
		} else if (common[i + 1][j] >= common[i][j + 1]) {
			pendingBase.push(base[i]);
			i += 1;
		} else {
			pendingDraft.push(draft[j]);
			j += 1;
		}
	}
	while (i < n) pendingBase.push(base[i++]);
	while (j < m) pendingDraft.push(draft[j++]);
	flush();

	return entries;
}

// ---------------------------------------------------------------------------
// Message blocks

const blockLabel: Record<TemplateBlock['type'], string> = {
	heading: 'Heading',
	paragraph: 'Paragraph',
	details: 'Details',
	button: 'Button',
	divider: 'Divider'
};

/** The comparable text a block carries; a divider carries none. */
function blockText(block: TemplateBlock): string {
	switch (block.type) {
		case 'heading':
		case 'paragraph':
			return block.text;
		case 'button':
			return block.label;
		case 'details':
			return block.rows.map((row) => `${row.label}: ${row.value}`).join(' · ');
		case 'divider':
			return '';
	}
}

/** Entries for one property-by-property style tag change: `Heading · size`, 24px → 28px. */
function styleEntries(
	target: string,
	unitKind: StyleUnitKind,
	before?: TextStyle,
	after?: TextStyle
): TemplateDiffEntry[] {
	return styleDelta(unitKind, before, after).map((change) => ({
		kind: 'edited' as const,
		target: `${target} · ${change.prop}`,
		before: change.before,
		after: change.after
	}));
}

const messageSpec: BlockDiffSpec<TemplateBlock> = {
	label: (block) => blockLabel[block.type],
	text: blockText,
	edited: (before, after) => {
		const entries: TemplateDiffEntry[] = [];
		if (blockText(before) !== blockText(after)) {
			entries.push({
				kind: 'edited',
				target: blockLabel[before.type],
				before: blockText(before),
				after: blockText(after)
			});
		}
		if (
			(before.type === 'heading' && after.type === 'heading') ||
			(before.type === 'paragraph' && after.type === 'paragraph')
		) {
			entries.push(...styleEntries(blockLabel[before.type], before.type, before.style, after.style));
		}
		return entries;
	}
};

export function diffBlocks(base: TemplateBlock[], draft: TemplateBlock[]): TemplateDiffEntry[] {
	return diffBlockLists(base, draft, messageSpec);
}

/** The full per-change list a draft carries: the subject first, then blocks. */
export function diffTemplate(base: MessageTemplate, draft: MessageTemplate): TemplateDiffEntry[] {
	const entries: TemplateDiffEntry[] = [];
	if (base.subject !== draft.subject) {
		entries.push({ kind: 'edited', target: 'Subject', before: base.subject, after: draft.subject });
	}
	entries.push(...diffBlocks(base.blocks, draft.blocks));
	return entries;
}

// ---------------------------------------------------------------------------
// Surface blocks

type ScheduleDaysBlock = Extract<SurfaceBlock, { type: 'schedule-days' }>;

/** The listing's display options, diffed field by field when a pair edits. */
const listingOptions = ['grouping', 'showRoom', 'showTrack', 'showSpeakers', 'density'] as const;

function optionText(value: ScheduleDaysBlock[(typeof listingOptions)[number]]): string {
	return typeof value === 'boolean' ? (value ? 'on' : 'off') : value;
}

function surfaceLabel(block: SurfaceBlock): string {
	switch (block.type) {
		case 'hero':
			return 'Hero';
		case 'schedule-days':
			return 'Schedule layout';
		case 'form-section':
			return `Section: ${block.title}`;
		case 'note':
			return 'Note';
	}
}

function surfaceText(block: SurfaceBlock, labelOf: (ref: string) => string): string {
	switch (block.type) {
		case 'hero':
			return block.title;
		case 'schedule-days':
			return `grouped by ${block.grouping}`;
		case 'form-section':
			return block.fieldRefs.map(labelOf).join(' · ');
		case 'note':
			return block.text;
	}
}

/**
 * Entries for a same-type surface pair: edited fields are listed one by one
 * (`Schedule layout · grouping`, `Hero · intro`), and a section's question
 * changes are named by field label, never by ref id.
 */
function editedSurfacePair(
	before: SurfaceBlock,
	after: SurfaceBlock,
	labelOf: (ref: string) => string
): TemplateDiffEntry[] {
	const entries: TemplateDiffEntry[] = [];
	if (before.type === 'hero' && after.type === 'hero') {
		if (before.title !== after.title) {
			entries.push({ kind: 'edited', target: 'Hero · title', before: before.title, after: after.title });
		}
		if (before.intro !== after.intro) {
			entries.push({ kind: 'edited', target: 'Hero · intro', before: before.intro, after: after.intro });
		}
		entries.push(...styleEntries('Hero · title', 'hero-title', before.titleStyle, after.titleStyle));
		entries.push(...styleEntries('Hero · intro', 'hero-intro', before.introStyle, after.introStyle));
	} else if (before.type === 'schedule-days' && after.type === 'schedule-days') {
		for (const option of listingOptions) {
			if (before[option] !== after[option]) {
				entries.push({
					kind: 'edited',
					target: `Schedule layout · ${option}`,
					before: optionText(before[option]),
					after: optionText(after[option])
				});
			}
		}
	} else if (before.type === 'form-section' && after.type === 'form-section') {
		if (before.title !== after.title) {
			entries.push({
				kind: 'edited',
				target: `Section: ${before.title} · title`,
				before: before.title,
				after: after.title
			});
		}
		if ((before.description ?? '') !== (after.description ?? '')) {
			entries.push({
				kind: 'edited',
				target: `Section: ${after.title} · description`,
				before: before.description ?? '',
				after: after.description ?? ''
			});
		}
		for (const ref of after.fieldRefs.filter((ref) => !before.fieldRefs.includes(ref))) {
			entries.push({ kind: 'added', target: `Section: ${after.title}`, after: labelOf(ref) });
		}
		for (const ref of before.fieldRefs.filter((ref) => !after.fieldRefs.includes(ref))) {
			entries.push({ kind: 'removed', target: `Section: ${after.title}`, before: labelOf(ref) });
		}
		// Same questions, different order: show the order itself.
		const beforeKept = before.fieldRefs.filter((ref) => after.fieldRefs.includes(ref));
		const afterKept = after.fieldRefs.filter((ref) => before.fieldRefs.includes(ref));
		if (entries.length === 0 && beforeKept.join(' ') !== afterKept.join(' ')) {
			entries.push({
				kind: 'edited',
				target: `Section: ${after.title}`,
				before: beforeKept.map(labelOf).join(' · '),
				after: afterKept.map(labelOf).join(' · ')
			});
		}
	} else if (before.type === 'note' && after.type === 'note') {
		if (before.text !== after.text) {
			entries.push({ kind: 'edited', target: 'Note', before: before.text, after: after.text });
		}
		entries.push(...styleEntries('Note', 'note', before.style, after.style));
	}
	return entries;
}

/**
 * The surface counterpart of {@link diffTemplate}: the same aligned block diff
 * over surface blocks. Field labels resolve against both pools, draft first,
 * so a question the draft just minted still names itself.
 */
export function diffSurfaceTemplate(
	base: SurfaceTemplate,
	draft: SurfaceTemplate
): TemplateDiffEntry[] {
	const labels = new Map<string, string>();
	for (const field of base.fields ?? []) labels.set(field.id, field.label);
	for (const field of draft.fields ?? []) labels.set(field.id, field.label);
	const labelOf = (ref: string) => labels.get(ref) ?? ref;
	const entries = diffBlockLists(base.blocks, draft.blocks, {
		label: surfaceLabel,
		text: (block) => surfaceText(block, labelOf),
		edited: (before, after) => editedSurfacePair(before, after, labelOf)
	});
	// A question's requiredness lives in the field pool, not in any block; a
	// flip would otherwise be invisible to the review surface.
	for (const field of draft.fields ?? []) {
		const prior = base.fields?.find((candidate) => candidate.id === field.id);
		if (prior && prior.required !== field.required) {
			entries.push({
				kind: 'edited',
				target: `Question: ${field.label}`,
				before: prior.required ? 'required' : 'optional',
				after: field.required ? 'required' : 'optional'
			});
		}
	}
	return entries;
}

/** One entry point for the editor: dispatches on the template kind. */
export function diffAnyTemplate(base: AnyTemplate, draft: AnyTemplate): TemplateDiffEntry[] {
	if (isSurfaceTemplate(base) && isSurfaceTemplate(draft)) return diffSurfaceTemplate(base, draft);
	if (!isSurfaceTemplate(base) && !isSurfaceTemplate(draft)) return diffTemplate(base, draft);
	// A draft is only ever diffed against its own template, so kinds cannot mix;
	// returning nothing keeps the contract total.
	return [];
}
