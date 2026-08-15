import { describe, expect, test } from 'bun:test';
import { settingsSections } from '$lib/features/settings/sections';
import { settingsNavExpanded, settingsNavKeydown, settingsNavRows } from './settings-nav';

const rows = settingsSections.length + 1;

describe('when the Settings group stands open', () => {
	test('the route decides while nobody has said otherwise', () => {
		expect(settingsNavExpanded({ pathname: '/app/settings/team', toggled: null })).toBe(true);
		expect(settingsNavExpanded({ pathname: '/app/settings', toggled: null })).toBe(true);
		expect(settingsNavExpanded({ pathname: '/app/speakers', toggled: null })).toBe(false);
	});

	test('a person who has toggled it holds that answer over the route', () => {
		expect(settingsNavExpanded({ pathname: '/app/speakers', toggled: true })).toBe(true);
		expect(settingsNavExpanded({ pathname: '/app/settings/team', toggled: false })).toBe(false);
	});

	test('a collapsed group offers one focus row, an open one a row per section', () => {
		expect(settingsNavRows(false)).toBe(1);
		expect(settingsNavRows(true)).toBe(rows);
	});
});

describe('keyboard movement inside the group', () => {
	test('down from a closed group opens it and lands on the first section', () => {
		expect(settingsNavKeydown({ key: 'ArrowDown', row: 0, expanded: false })).toEqual({
			kind: 'expand',
			focus: 1
		});
	});

	test('down and up walk the open group and stop at its ends', () => {
		expect(settingsNavKeydown({ key: 'ArrowDown', row: 0, expanded: true })).toEqual({
			kind: 'focus',
			focus: 1
		});
		expect(settingsNavKeydown({ key: 'ArrowUp', row: 2, expanded: true })).toEqual({
			kind: 'focus',
			focus: 1
		});
		// The rail is a plain list of links, so movement never wraps past the
		// group and never steals the press from the page.
		expect(settingsNavKeydown({ key: 'ArrowDown', row: rows - 1, expanded: true })).toBeNull();
		expect(settingsNavKeydown({ key: 'ArrowUp', row: 0, expanded: true })).toBeNull();
	});

	test('right opens without moving, left closes and returns to the group', () => {
		expect(settingsNavKeydown({ key: 'ArrowRight', row: 0, expanded: false })).toEqual({
			kind: 'expand'
		});
		expect(settingsNavKeydown({ key: 'ArrowRight', row: 0, expanded: true })).toBeNull();
		expect(settingsNavKeydown({ key: 'ArrowLeft', row: 0, expanded: true })).toEqual({
			kind: 'collapse'
		});
		expect(settingsNavKeydown({ key: 'ArrowLeft', row: 3, expanded: true })).toEqual({
			kind: 'collapse',
			focus: 0
		});
	});

	test('escape from a section closes the group and gives focus back to it', () => {
		expect(settingsNavKeydown({ key: 'Escape', row: 2, expanded: true })).toEqual({
			kind: 'collapse',
			focus: 0
		});
		// Nothing to close: the press belongs to whatever else is listening.
		expect(settingsNavKeydown({ key: 'Escape', row: 0, expanded: true })).toBeNull();
		expect(settingsNavKeydown({ key: 'Escape', row: 0, expanded: false })).toBeNull();
	});

	test('home and end reach the ends of the open group', () => {
		expect(settingsNavKeydown({ key: 'Home', row: 3, expanded: true })).toEqual({
			kind: 'focus',
			focus: 0
		});
		expect(settingsNavKeydown({ key: 'End', row: 0, expanded: true })).toEqual({
			kind: 'focus',
			focus: rows - 1
		});
		expect(settingsNavKeydown({ key: 'End', row: 0, expanded: false })).toBeNull();
	});

	test('ordinary typing is not the group’s business', () => {
		expect(settingsNavKeydown({ key: 'a', row: 0, expanded: true })).toBeNull();
		expect(settingsNavKeydown({ key: 'Enter', row: 1, expanded: true })).toBeNull();
		expect(settingsNavKeydown({ key: ' ', row: 0, expanded: false })).toBeNull();
	});
});
