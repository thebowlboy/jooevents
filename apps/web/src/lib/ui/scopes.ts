/**
 * The vocabulary behind `ScopeFilter`.
 *
 * A scope set answers "which population am I looking at". Getting that wrong
 * is not a cosmetic failure — an operator who cannot see the `Late` tray does
 * not know that late submissions exist. So the primitive's contract is that
 * every member stays visible and reachable, and the only thing narrow space is
 * allowed to take is *letters*.
 */

import type { IconComponent } from './status-icons';

export interface Scope {
	/** The value written to state and to the URL. Never abbreviated. */
	value: string;
	/** The scope's name. This is the accessible name, at every width. */
	label: string;
	/**
	 * A shorter face for narrow widths. It must read as the same word — a
	 * substring of `label`, case-insensitively — because the visible text has
	 * to be contained in the accessible name (WCAG 2.5.3), and because a
	 * person saying "tap Aside" and a screen reader saying "Set aside" must be
	 * recognisably the same control.
	 */
	short?: string;
	/** How many records the scope holds. Omitted where the number is unknown. */
	count?: number;
	/** Recognition support from the shared vocabulary; always `aria-hidden`. */
	icon?: IconComponent;
}

/**
 * Whether a scope's abbreviation is a legal face for its name. Enforced in a
 * unit test rather than at runtime: an illegal pair is an authoring mistake,
 * and failing the build is more useful than failing in the browser.
 */
export function isLegalShortLabel(scope: Scope): boolean {
	if (scope.short === undefined) return true;
	const short = scope.short.trim();
	if (short.length === 0) return false;
	if (short.length >= scope.label.trim().length) return false;
	return scope.label.toLowerCase().includes(short.toLowerCase());
}

/**
 * What assistive technology hears. The count joins the name because it is part
 * of what the person is choosing between — "Discarded, 4" and "Discarded, 0"
 * are different decisions — and it joins in the order it is read on screen.
 */
export function scopeAccessibleName(scope: Scope): string {
	return scope.count === undefined ? scope.label : `${scope.label}, ${scope.count}`;
}
