/**
 * Making a table survive becoming a record.
 *
 * The phone record in `components.css` is pure CSS on purpose: every
 * `.ui-table` in the product inherits it with no page change, including
 * surfaces nobody is editing this week. But changing a table's `display` costs
 * two things CSS cannot give back, and this is what gives them back:
 *
 * 1. **Semantics.** Engines drop the implicit table roles when the display
 *    type changes, so a row stops being announced as a row. Stating the roles
 *    explicitly restores exactly what the markup already meant — they are
 *    redundant while the table is a table, and load-bearing the moment it is
 *    not.
 *
 * 2. **Labels.** A stacked cell is a value with its question missing. The
 *    column name is already in the document, one `thead` away, so mirroring it
 *    onto each cell as `data-label` costs a page nothing and turns a pile of
 *    values back into a record. A page that wants a shorter phone label sets
 *    `data-label` itself; an explicit one is never overwritten.
 *
 * Both are re-applied when rows change, because rows arrive from a query.
 */

/** Cells whose role in the record is structural: they carry no labelled line. */
const ROLE_CELL_CLASSES = [
	'ui-pick-cell',
	'ui-cell--rail',
	'ui-cell--lead',
	'ui-cell--state',
	'ui-cell--trail',
	'ui-cell--detail'
];

/**
 * Normalise one header cell into the label a record line shows: collapsed
 * whitespace, and empty where the header carries no word of its own. A header
 * that exists only to hold a control or a visually-hidden name ("Details")
 * labels nothing, and printing "DETAILS: ⌄" beside a chevron is noise.
 */
export function columnLabel(headerText: string): string {
	return headerText.replace(/\s+/g, ' ').trim();
}

/** The header row's labels, in column order. */
export function columnLabels(headerTexts: readonly string[]): string[] {
	return headerTexts.map(columnLabel);
}

/**
 * Whether a cell takes a labelled record line.
 *
 * Structural cells (the rail, the promoted state, the trailing affordance) are
 * placed rather than stacked, spanning cells are their own block, and a cell
 * the page has already labelled keeps its own word.
 */
export function shouldLabelCell(input: {
	classes: readonly string[];
	colSpan: number;
	hasOwnLabel: boolean;
	label: string;
}): boolean {
	if (input.hasOwnLabel) return false;
	if (input.colSpan > 1) return false;
	if (input.label.length === 0) return false;
	return !input.classes.some((name) => ROLE_CELL_CLASSES.includes(name));
}

function applyRoles(table: HTMLTableElement): void {
	table.setAttribute('role', 'table');
	for (const group of table.querySelectorAll(':scope > thead, :scope > tbody, :scope > tfoot')) {
		group.setAttribute('role', 'rowgroup');
	}
	for (const row of table.querySelectorAll(':scope > * > tr')) {
		row.setAttribute('role', 'row');
		for (const cell of row.children) {
			if (cell.tagName === 'TH') {
				const inHead = cell.closest('thead') !== null;
				cell.setAttribute('role', inHead ? 'columnheader' : 'rowheader');
			} else if (cell.tagName === 'TD') {
				cell.setAttribute('role', 'cell');
			}
		}
	}
}

function applyLabels(table: HTMLTableElement): void {
	const headerRow = table.querySelector(':scope > thead > tr:last-of-type');
	if (!headerRow) return;
	const labels = columnLabels(Array.from(headerRow.children, (cell) => cell.textContent ?? ''));

	for (const row of table.querySelectorAll(':scope > tbody > tr')) {
		let column = 0;
		for (const cell of row.children) {
			const element = cell as HTMLTableCellElement;
			const span = Math.max(1, element.colSpan || 1);
			const label = labels[column] ?? '';
			const hasOwnLabel = element.dataset.recordLabel === undefined && element.hasAttribute('data-label');

			if (shouldLabelCell({ classes: Array.from(element.classList), colSpan: span, hasOwnLabel, label })) {
				element.setAttribute('data-label', label);
				// Remembered so a later pass can tell its own work from a page's.
				element.dataset.recordLabel = '';
			} else if (!hasOwnLabel && element.dataset.recordLabel !== undefined) {
				element.removeAttribute('data-label');
				delete element.dataset.recordLabel;
			}
			column += span;
		}
	}
}

/**
 * Attachment form: `<table class="ui-table" {@attach recordTable()}>`.
 *
 * Idempotent, and safe to leave on a table that never narrows: at column
 * widths the roles restate what the element already is and `data-label` is
 * never rendered.
 */
export function recordTable() {
	return (node: Element) => {
		const table = node as HTMLTableElement;
		let queued = false;

		const sync = () => {
			queued = false;
			applyRoles(table);
			applyLabels(table);
		};

		// Rows arrive from a query and are re-keyed on every filter change, so
		// the pass is scheduled rather than run once — and coalesced, because a
		// re-render touches every row.
		const observer = new MutationObserver(() => {
			if (queued) return;
			queued = true;
			queueMicrotask(sync);
		});

		sync();
		observer.observe(table, { childList: true, subtree: true });
		return () => observer.disconnect();
	};
}
