import type { ProgramVocabularySafeDiff } from '@jooevents/contracts';

type DiffItem = Extract<ProgramVocabularySafeDiff, { action: 'create' }>['after'];

export interface ProgramVocabularyDiffRow {
	readonly key: string;
	readonly label: string;
	readonly before: string;
	readonly after: string;
}

const absent = 'Not present';

function kindLabel(kind: DiffItem['kind']): string {
	return kind === 'room' ? 'Room' : kind === 'track' ? 'Track' : 'Format';
}

function capacity(item: DiffItem): string {
	return item.kind === 'room' ? (item.capacity === null ? 'Not set' : `${item.capacity} seats`) : '—';
}

function addRow(
	rows: ProgramVocabularyDiffRow[],
	key: string,
	label: string,
	before: string,
	after: string,
	includeUnchanged = false
): void {
	if (includeUnchanged || before !== after) {
		rows.push(Object.freeze({ key, label, before, after }));
	}
}

function itemRows(
	rows: ProgramVocabularyDiffRow[],
	before: DiffItem | null,
	after: DiffItem | null,
	prefix: string,
	includeUnchanged = false
): void {
	const label = kindLabel(after?.kind ?? before!.kind);
	addRow(rows, `${prefix}:presence`, `${label}`, before ? 'Present' : absent, after ? 'Present' : absent);
	if (!before || !after) {
		const item = after ?? before!;
		addRow(rows, `${prefix}:name`, `${label} name`, before?.name ?? absent, after?.name ?? absent, true);
		addRow(rows, `${prefix}:status`, 'Status', before?.status ?? absent, after?.status ?? absent, true);
		if (item.kind === 'room') {
			addRow(rows, `${prefix}:capacity`, 'Capacity', before ? capacity(before) : absent, after ? capacity(after) : absent, true);
		}
		addRow(rows, `${prefix}:version`, 'Version', before ? String(before.version) : absent, after ? String(after.version) : absent, true);
		return;
	}
	addRow(rows, `${prefix}:name`, `${label} name`, before.name, after.name, includeUnchanged);
	addRow(rows, `${prefix}:status`, 'Status', before.status, after.status, includeUnchanged);
	if (before.kind === 'room' && after.kind === 'room') {
		addRow(rows, `${prefix}:capacity`, 'Capacity', capacity(before), capacity(after), includeUnchanged);
	}
	addRow(rows, `${prefix}:version`, 'Version', String(before.version), String(after.version), true);
}

/** Human-readable ledger shown beside the canonical structured vocabulary diff. */
export function programVocabularyDiffRows(
	diff: ProgramVocabularySafeDiff
): readonly ProgramVocabularyDiffRow[] {
	const rows: ProgramVocabularyDiffRow[] = [];
	switch (diff.action) {
		case 'create':
			itemRows(rows, null, diff.after, 'item', true);
			break;
		case 'edit':
		case 'retire':
		case 'restore':
			itemRows(rows, diff.before, diff.after, 'item');
			break;
		case 'delete':
			itemRows(rows, diff.before, null, 'item');
			addRow(rows, 'usage:current', 'Current references', String(diff.usage.current), '0', true);
			addRow(rows, 'usage:historical', 'Historical pins', String(diff.usage.historicalPins), '0', true);
			break;
		case 'merge':
		case 'merge_compensation':
			itemRows(rows, diff.sourceBefore, diff.sourceAfter, 'source');
			addRow(rows, 'destination', 'Merge destination', diff.sourceBefore.name, diff.target.name, true);
			addRow(rows, 'repoints', 'Current references repointed', '0', String(diff.liveRepoints), true);
			addRow(rows, 'history', 'Historical pins preserved', '0', String(diff.historicalPinsPreserved), true);
			break;
	}
	return Object.freeze(rows);
}
