/**
 * The settings destinations.
 *
 * One entry here is the whole registration: the left rail's Settings group, the
 * routes under `/app/settings`, the document titles, and each page's
 * on-this-page rail all read this list, so a section cannot exist in one of them
 * and be missing from another. Names are plain nouns — the word someone hunting
 * for the setting would say out loud.
 */

export type SettingsSectionKey = 'event' | 'program' | 'team' | 'email' | 'about';

/** One in-page destination: the element it scrolls to, and what it is called. */
export interface SettingsAnchor {
	readonly id: string;
	readonly label: string;
}

export interface SettingsSection {
	readonly key: SettingsSectionKey;
	readonly label: string;
	readonly href: string;
	/** In document order; the rail highlights by reading order, not by id. */
	readonly anchors: readonly SettingsAnchor[];
}

/** The group's own address. It opens on the first section rather than a page. */
export const SETTINGS_ROOT = '/app/settings';

export const settingsSections: readonly SettingsSection[] = Object.freeze([
	Object.freeze({
		key: 'event',
		label: 'Event',
		href: `${SETTINGS_ROOT}/event`,
		anchors: Object.freeze([
			Object.freeze({ id: 'settings-event-identity', label: 'Event identity' })
		])
	}),
	Object.freeze({
		key: 'program',
		label: 'Program',
		href: `${SETTINGS_ROOT}/program`,
		/*
		 * Rooms, tracks, and formats sit side by side at desktop width, so they
		 * share one scroll position and cannot be separate rail destinations.
		 * The rail addresses the two panels a person actually scrolls between.
		 */
		anchors: Object.freeze([
			Object.freeze({ id: 'settings-program-basics', label: 'Program basics' }),
			Object.freeze({ id: 'settings-speaker-fields', label: 'Speaker fields' })
		])
	}),
	Object.freeze({
		key: 'team',
		label: 'Team',
		href: `${SETTINGS_ROOT}/team`,
		anchors: Object.freeze([Object.freeze({ id: 'settings-team', label: 'Team' })])
	}),
	/*
	 * Email is workspace-scoped, so it reads before any event exists. Its two
	 * editable values commit as one optimistic-concurrency unit against one
	 * head version, so they are one panel and one anchor: splitting them into
	 * two rail destinations would mean two saves that overwrite each other.
	 */
	Object.freeze({
		key: 'email',
		label: 'Email',
		href: `${SETTINGS_ROOT}/email`,
		anchors: Object.freeze([Object.freeze({ id: 'settings-email-sender', label: 'Sender' })])
	}),
	/*
	 * About describes the software rather than the workspace, so it reads before
	 * any event exists. Its panel renders under `ATTRIBUTION_PLACEMENT.about`:
	 * turning that off must drop this entry too, or the rail keeps a door onto
	 * an empty room.
	 */
	Object.freeze({
		key: 'about',
		label: 'About',
		href: `${SETTINGS_ROOT}/about`,
		anchors: Object.freeze([Object.freeze({ id: 'settings-about', label: 'About' })])
	})
] as const);

/** Where `/app/settings` lands: the first section, never a page of its own. */
export const firstSettingsSection: SettingsSection = settingsSections[0];

function normalize(pathname: string): string {
	const path = pathname.split('?')[0].split('#')[0];
	return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** True for the group's own address and for every section beneath it. */
export function isSettingsPath(pathname: string): boolean {
	const path = normalize(pathname);
	return path === SETTINGS_ROOT || path.startsWith(`${SETTINGS_ROOT}/`);
}

/**
 * The section a path presents. The group address resolves to the first section
 * so selection and rail are answered before the redirect has run; an address
 * under the group that names no section resolves to nothing.
 */
export function settingsSectionAt(pathname: string): SettingsSection | undefined {
	const path = normalize(pathname);
	if (path === SETTINGS_ROOT) return firstSettingsSection;
	return settingsSections.find((section) => section.href === path);
}

export function settingsSectionByKey(key: SettingsSectionKey): SettingsSection {
	const section = settingsSections.find((entry) => entry.key === key);
	if (!section) throw new RangeError(`No settings section named ${key}.`);
	return section;
}

export interface SettingsRail {
	/**
	 * A single-entry rail is the page's own heading said twice, so it does not
	 * render and the page keeps the width the entry would have cost.
	 */
	readonly visible: boolean;
	readonly entries: readonly SettingsAnchor[];
}

export function settingsRail(section: SettingsSection | undefined): SettingsRail {
	const entries = section?.anchors ?? [];
	return { visible: entries.length > 1, entries };
}

/**
 * The section being read: the last one whose top has crossed the reading line,
 * or the first while the page is still above all of them. `positions` are in
 * document order and measured against the viewport, so the caller decides where
 * the reading line sits under the sticky top bar.
 */
export function activeAnchorId(
	positions: readonly { readonly id: string; readonly top: number }[],
	readingLine: number
): string | undefined {
	let active = positions[0]?.id;
	for (const position of positions) {
		if (position.top > readingLine) break;
		active = position.id;
	}
	return active;
}
