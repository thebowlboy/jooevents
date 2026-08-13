import { describe, expect, test } from 'bun:test';
import { navGroups, navModel, overviewItem, settingsItem } from './navigation';

const organizer = { kind: 'organizer' } as const;
const reviewer = { kind: 'reviewer', reviewerId: 'mem-2' } as const;

describe('the rail, by whose authority it is rendered', () => {
	test('an organizer keeps the shared model unchanged', () => {
		const model = navModel(organizer);
		expect(model.groups).toBe(navGroups);
		expect(model.overview).toBe(overviewItem);
		expect(model.settings).toBe(settingsItem);
		expect(model.home).toBe(overviewItem.href);
	});

	test('a reviewer sees the one area they hold, and no others', () => {
		const model = navModel(reviewer);
		const keys = model.groups.flatMap((group) => group.items.map((item) => item.key));
		expect(keys).toEqual(['review']);
		// Absent rather than locked: the locked treatment promises "not yet".
		expect(model.overview).toBeUndefined();
		expect(model.settings).toBeUndefined();
		// Empty groups leave no dangling label behind their filtered-out items.
		expect(model.groups).toHaveLength(1);
		expect(model.groups[0].items).toHaveLength(1);
	});

	test("the wordmark lands a reviewer on their own surface, not the organizer's", () => {
		expect(navModel(reviewer).home).toBe('/app/review');
	});

	test('filtering leaves the shared model untouched for the next reader', () => {
		const before = navGroups.map((group) => group.items.length);
		navModel(reviewer);
		expect(navGroups.map((group) => group.items.length)).toEqual(before);
	});
});
