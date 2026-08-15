/**
 * The Settings group's disclosure behaviour, as a value.
 *
 * The rail is one column: Settings expands in place into its sections rather
 * than opening a second navigation surface. Expansion and keyboard movement are
 * decided here so the shell only applies the answer, and so both can be proven
 * without a browser.
 */

import { isSettingsPath, settingsSections } from '$lib/features/settings/sections';

/**
 * Whether the group stands open. The route decides — a person inside Settings
 * sees where they are — until they say otherwise; the shell drops the manual
 * answer on navigation, so the route decides again on the next surface.
 */
export function settingsNavExpanded(input: {
	readonly pathname: string;
	readonly toggled: boolean | null;
}): boolean {
	return input.toggled ?? isSettingsPath(input.pathname);
}

/** Focus rows: 0 is the group's disclosure control, 1..n are its sections. */
export function settingsNavRows(expanded: boolean): number {
	return expanded ? settingsSections.length + 1 : 1;
}

export type SettingsNavIntent =
	| { readonly kind: 'expand'; readonly focus?: number }
	| { readonly kind: 'collapse'; readonly focus?: number }
	| { readonly kind: 'focus'; readonly focus: number };

/**
 * What a key press means inside the group, or nothing when the press belongs to
 * the page. The rest of the rail is a plain list of links reached by Tab, so
 * arrow keys only move within this group and never take the tab stop away from
 * a row the person can already reach.
 */
export function settingsNavKeydown(input: {
	readonly key: string;
	readonly row: number;
	readonly expanded: boolean;
}): SettingsNavIntent | null {
	const { key, row, expanded } = input;
	const last = settingsNavRows(expanded) - 1;
	switch (key) {
		case 'ArrowDown':
			if (row === 0 && !expanded) return { kind: 'expand', focus: 1 };
			return row < last ? { kind: 'focus', focus: row + 1 } : null;
		case 'ArrowUp':
			return row > 0 ? { kind: 'focus', focus: row - 1 } : null;
		case 'ArrowRight':
			return row === 0 && !expanded ? { kind: 'expand' } : null;
		case 'ArrowLeft':
			if (row === 0) return expanded ? { kind: 'collapse' } : null;
			return { kind: 'collapse', focus: 0 };
		case 'Escape':
			return expanded && row > 0 ? { kind: 'collapse', focus: 0 } : null;
		case 'Home':
			return row > 0 ? { kind: 'focus', focus: 0 } : null;
		case 'End':
			return expanded && row < last ? { kind: 'focus', focus: last } : null;
		default:
			return null;
	}
}
