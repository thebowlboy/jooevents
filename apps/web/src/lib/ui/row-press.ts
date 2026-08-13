/**
 * Who owns a press inside an expandable row.
 *
 * A row that opens its own detail claims only the space its controls leave
 * over, and it claims that space for the pointer alone: the row gains no
 * role and no tab stop, and the chevron inside it stays the one focusable
 * switch carrying `aria-expanded`. This module is the boundary of that
 * claim, shared so every surface with pressable rows draws it in the same
 * place — a table row and a card summary answer a press by the same rules.
 */

/**
 * Everything in a row that can be pressed on its own. A press landing on one
 * of these — or anywhere inside one — belongs to it, so a checkbox, a copy
 * control, a badge popover and the chevron all keep their press, and the row
 * can safely claim the space left over.
 *
 * The surfaces those disclosures open over the row count too. A panel or a
 * dialog is painted in the top layer but still descends from the row in the
 * DOM, so without naming them here a press on a panel's own words would also
 * toggle the detail hidden behind it.
 */
export const INTERACTIVE =
	'a, button, input, label, select, textarea, [role="button"], .ui-popover__panel, dialog';

/**
 * Whether a press on the row belongs to something other than the row: to one
 * of its own controls, or to a selection. Dragging across an email or a name
 * ends in the same click a press does, and a person who just selected text
 * has already said what they wanted — a non-collapsed selection means the
 * row keeps still.
 */
export function shouldIgnoreRowPress(event: MouseEvent): boolean {
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest(INTERACTIVE)) return true;
	const selection = document.getSelection();
	return selection !== null && !selection.isCollapsed;
}
