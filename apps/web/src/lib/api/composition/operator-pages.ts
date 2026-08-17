import {
	firstSettingsSection,
	type SettingsSectionKey
} from '$lib/features/settings/sections';

export const operatorPageIds = Object.freeze([
	'overview',
	/*
	 * Pulse is a quiet destination: addressed at /app/pulse and entered from
	 * the Overview's key-numbers band, without a rail row of its own.
	 */
	'pulse',
	'submissions',
	'review',
	'review_lineup',
	'decisions',
	'speakers',
	'reviewers',
	'tasks',
	'files',
	'schedule',
	'communications',
	'forms',
	'templates',
	'embeds',
	'approvals',
	/*
	 * Settings is a group of sections, each its own address. The group id stays
	 * for `/app/settings` itself, which opens on the first section.
	 */
	'settings',
	'settings_event',
	'settings_program',
	'settings_team',
	'settings_email',
	'settings_api_keys',
	'settings_about'
] as const);

export type OperatorPageId = (typeof operatorPageIds)[number];

const settingsPages: Readonly<Partial<Record<OperatorPageId, SettingsSectionKey>>> = Object.freeze({
	settings: firstSettingsSection.key,
	settings_event: 'event',
	settings_program: 'program',
	settings_team: 'team',
	settings_email: 'email',
	settings_api_keys: 'api_keys',
	settings_about: 'about'
});

export function isSettingsPage(area: OperatorPageId): boolean {
	return settingsPages[area] !== undefined;
}

/** The settings section a page id presents. */
export function settingsSectionOf(area: OperatorPageId): SettingsSectionKey {
	const section = settingsPages[area];
	if (!section) throw new RangeError(`${area} is not a settings section.`);
	return section;
}
