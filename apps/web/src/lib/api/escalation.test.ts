import { afterEach, describe, expect, test } from 'bun:test';
import {
	criticalSituationFor,
	criticalSituations,
	escalationConfig,
	type CriticalSituationDef
} from './escalation';

const views: CriticalSituationDef['view'][] = ['tasks', 'speakers', 'schedule'];

/** Every test leaves the registry the way it ships: fully off. */
afterEach(() => {
	escalationConfig.enabled = false;
	for (const situation of criticalSituations) {
		escalationConfig.situations[situation.key] = false;
	}
});

describe('dormant tier', () => {
	test('ships with every switch off and every view calm', () => {
		expect(escalationConfig.enabled).toBe(false);
		for (const situation of criticalSituations) {
			expect(escalationConfig.situations[situation.key]).toBe(false);
		}
		for (const view of views) {
			expect(criticalSituationFor(view)).toBeNull();
		}
	});

	test('a situation switch without the master switch changes nothing', () => {
		escalationConfig.situations['deadline-imminent'] = true;
		for (const view of views) {
			expect(criticalSituationFor(view)).toBeNull();
		}
	});

	test('the master switch without a situation switch changes nothing', () => {
		escalationConfig.enabled = true;
		for (const view of views) {
			expect(criticalSituationFor(view)).toBeNull();
		}
	});
});

describe('activation', () => {
	test('master plus one situation escalates exactly that view', () => {
		escalationConfig.enabled = true;
		escalationConfig.situations['cancellation-unresolved'] = true;
		expect(criticalSituationFor('speakers')?.key).toBe('cancellation-unresolved');
		expect(criticalSituationFor('tasks')).toBeNull();
		expect(criticalSituationFor('schedule')).toBeNull();
	});

	test('two active situations on one view still surface exactly one, by catalog order', () => {
		// The shipped catalog keeps one situation per view, so the same-view case
		// is constructed: publish-blocked is pointed at tasks for this test only.
		const publishBlocked = criticalSituations.find(
			(situation) => situation.key === 'publish-blocked'
		);
		if (!publishBlocked) throw new Error('publish-blocked missing from the catalog');
		const shippedView = publishBlocked.view;
		publishBlocked.view = 'tasks';
		escalationConfig.enabled = true;
		escalationConfig.situations['deadline-imminent'] = true;
		escalationConfig.situations['publish-blocked'] = true;
		try {
			// deadline-imminent is earlier in the catalog, so it holds the view.
			expect(criticalSituationFor('tasks')?.key).toBe('deadline-imminent');
			// The displaced situation waits; it does not stack onto the view.
			expect(criticalSituationFor('schedule')).toBeNull();
			expect(criticalSituationFor('speakers')).toBeNull();
		} finally {
			publishBlocked.view = shippedView;
		}
	});

	test('the catalog carries its priority in its order', () => {
		expect(criticalSituations.map((situation) => situation.key)).toEqual([
			'deadline-imminent',
			'cancellation-unresolved',
			'publish-blocked'
		]);
	});
});
