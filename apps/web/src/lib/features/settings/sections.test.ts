import { describe, expect, test } from 'bun:test';
import {
	SETTINGS_ROOT,
	activeAnchorId,
	firstSettingsSection,
	isSettingsPath,
	settingsRail,
	settingsSectionAt,
	settingsSectionByKey,
	settingsSections
} from './sections';

describe('the settings registry', () => {
	test('names every section with a plain noun and its own address', () => {
		expect(settingsSections.map((section) => section.key)).toEqual([
			'event',
			'program',
			'team',
			'email',
			'about'
		]);
		expect(settingsSections.map((section) => section.label)).toEqual([
			'Event',
			'Program',
			'Team',
			'Email',
			'About'
		]);
		expect(settingsSections.map((section) => section.href)).toEqual([
			'/app/settings/event',
			'/app/settings/program',
			'/app/settings/team',
			'/app/settings/email',
			'/app/settings/about'
		]);
	});

	test('every anchor id is unique across the whole group', () => {
		const ids = settingsSections.flatMap((section) =>
			section.anchors.map((anchor) => anchor.id)
		);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test('the group address opens on the first section', () => {
		expect(firstSettingsSection).toBe(settingsSections[0]);
		expect(settingsSectionAt(SETTINGS_ROOT)).toBe(firstSettingsSection);
		expect(settingsSectionAt(`${SETTINGS_ROOT}/`)).toBe(firstSettingsSection);
	});

	test('a section address resolves to that section, and an unknown one to none', () => {
		expect(settingsSectionAt('/app/settings/team')?.key).toBe('team');
		expect(settingsSectionAt('/app/settings/team/')?.key).toBe('team');
		expect(settingsSectionAt('/app/settings/email')?.key).toBe('email');
		expect(settingsSectionAt('/app/settings/billing')).toBeUndefined();
		expect(settingsSectionAt('/app/speakers')).toBeUndefined();
	});

	test('the group owns its own subtree and nothing beside it', () => {
		expect(isSettingsPath('/app/settings')).toBe(true);
		expect(isSettingsPath('/app/settings/program')).toBe(true);
		expect(isSettingsPath('/app/settings-archive')).toBe(false);
		expect(isSettingsPath('/app/speakers')).toBe(false);
	});

	test('a key names exactly one section', () => {
		expect(settingsSectionByKey('program').href).toBe('/app/settings/program');
		expect(settingsSectionByKey('email').href).toBe('/app/settings/email');
		// @ts-expect-error the registry refuses a key it does not carry
		expect(() => settingsSectionByKey('billing')).toThrow(RangeError);
	});
});

describe('the on-this-page rail', () => {
	test('renders only where it has more than one destination to offer', () => {
		expect(settingsRail(settingsSectionByKey('program'))).toEqual({
			visible: true,
			entries: settingsSectionByKey('program').anchors
		});
		expect(settingsRail(settingsSectionByKey('event')).visible).toBe(false);
		expect(settingsRail(settingsSectionByKey('team')).visible).toBe(false);
		// Email's two editable values commit as one unit, so they are one panel.
		expect(settingsRail(settingsSectionByKey('email')).visible).toBe(false);
	});

	test('an unresolved section offers nothing rather than an empty frame', () => {
		expect(settingsRail(undefined)).toEqual({ visible: false, entries: [] });
	});

	test('the section being read is the last one whose top crossed the line', () => {
		const positions = [
			{ id: 'a', top: -220 },
			{ id: 'b', top: 40 },
			{ id: 'c', top: 780 }
		];
		expect(activeAnchorId(positions, 96)).toBe('b');
		expect(activeAnchorId(positions, -300)).toBe('a');
		expect(activeAnchorId(positions, 900)).toBe('c');
	});

	test('the first section holds the mark while the page is still above it', () => {
		expect(activeAnchorId([{ id: 'a', top: 400 }], 96)).toBe('a');
		expect(activeAnchorId([], 96)).toBeUndefined();
	});

	test('a section exactly on the line is the one being read', () => {
		expect(
			activeAnchorId(
				[
					{ id: 'a', top: 0 },
					{ id: 'b', top: 96 }
				],
				96
			)
		).toBe('b');
	});
});
