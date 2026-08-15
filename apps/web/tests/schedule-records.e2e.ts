import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The schedule as a *record* surface: what the board says when it cannot be
 * drawn, what the pool says when nothing can be placed on it, and how both
 * read on a phone.
 *
 * The defect these pin: the board's blank state said "Nothing is scheduled
 * yet" for every way its gate can fail — including a board holding committed
 * placements the serving layer refused to draw — and offered a room form to a
 * board whose rooms were never the problem. Meanwhile every unplaced row still
 * grew a "Place…" control that opened a mode with no grid in it, so pressing
 * it produced zero openings and no visible change.
 *
 * The mid-flight scenario is pinned where a drawn board is the subject; the
 * blank-board cases build a brand-new event, which is the one sample state
 * with real days and no rooms.
 */

const FLIGHT = 'flight';

function program(page: Page) {
	return page.getByRole('region', { name: 'Program', exact: true });
}

/** A fresh event: days derived from its dates, and no room to draw them in. */
async function createEvent(page: Page, name: string) {
	await page.goto('/app');
	await expect(page.getByRole('button', { name: 'Switch event' })).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: 'Switch event' }).click();
	await page.getByRole('button', { name: 'New event' }).click();
	const dialog = page.getByRole('dialog', { name: 'New event' });
	await dialog.getByLabel('Name').fill(name);
	await page.locator('#new-event-start').fill('2027-09-09');
	await page.locator('#new-event-start').press('Enter');
	await page.locator('#new-event-end').fill('2027-09-10');
	await page.locator('#new-event-end').press('Enter');
	await dialog.getByRole('button', { name: 'Create event' }).click();
	await expect(page).toHaveURL(/\/app$/, { timeout: 15000 });
	await expect(page.locator('.side__event-name')).toHaveText(name, { timeout: 15000 });
}

test('a board with no rooms names the room, not the schedule, and opens the form that supplies it', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the blank-state contract');

	await createEvent(page, 'Roomless Days 2027');
	await page.goto('/app/schedule');

	const board = page.getByRole('region', { name: 'Schedule grid' });
	await expect(board.getByRole('heading', { level: 2 })).toHaveText('The board has no rooms yet', {
		timeout: 15000
	});

	// The days exist and the state says so; the old copy claimed the whole
	// schedule was empty and named nothing that could be done about it.
	await expect(board).toContainText('The days are ready. A room gives them their first column.');
	await expect(page.getByRole('group', { name: 'Schedule day' })).toBeVisible();

	// The way in is here, and the door to the *other* supply is not offered,
	// because the other supply is not what is missing.
	await expect(page.getByLabel('Room name')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add room' })).toBeVisible();
	await expect(board.getByRole('link', { name: /dates and day window/ })).toHaveCount(0);
	await expect(board).not.toContainText('Nothing is scheduled yet');
});

test('with no grid to place on, the pool says why once instead of offering a control that cannot work', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the placement-gate contract');

	await createEvent(page, 'Nothing Placeable 2027');
	await page.goto('/app/schedule');
	await expect(program(page)).toBeVisible({ timeout: 15000 });

	// An empty pool has nothing waiting on the grid, so there is nothing to
	// explain and the panel stays quiet.
	await expect(program(page).locator('.panel__blocked')).toHaveCount(0);

	// One session, created from the panel's own door — now something *is*
	// waiting on a grid that does not exist.
	await page.locator('#new-session-door-panel').click();
	const dialog = page.getByRole('dialog', { name: 'New session' });
	await dialog.getByLabel('Title').fill('Opening remarks');
	await dialog.getByRole('button', { name: 'New format' }).click();
	await dialog.getByLabel('New format').fill('Talk');
	await dialog.getByRole('button', { name: 'Add', exact: true }).click();
	await dialog.getByRole('button', { name: 'Create', exact: true }).click();

	const row = program(page).locator('.pool__row').filter({ hasText: 'Opening remarks' });
	await expect(row).toBeVisible({ timeout: 15000 });

	// Said once, where the rows are.
	await expect(program(page).locator('.panel__blocked')).toHaveText(
		'Nothing can be placed yet: the board has no rooms. Add one above and these sessions become placeable.'
	);
	// And not repeated as a dead control on every row.
	await expect(page.getByRole('button', { name: /^Place / })).toHaveCount(0);
	// The row's other doors are untouched — the gate is about placement only.
	await expect(row.getByRole('button', { name: /^Speakers on / })).toBeVisible();
});

test.describe('the mid-flight board', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		await context.addCookies([
			{ name: 'je-scenario', value: FLIGHT, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

	test('the grid scrolls inside its own wrapper, keyboard-reachable and named — the document never does', async ({
		page
	}) => {
		await page.goto('/app/schedule');
		const wrap = page.locator('.board-wrap');
		await expect(wrap).toBeVisible({ timeout: 15000 });

		// The numeric-grid opt-out: columns kept, affordance and reach owed.
		await expect(wrap).toHaveClass(/ui-table-wrap--scroll/);
		await expect(wrap).toHaveAttribute('role', 'region');
		await expect(wrap).toHaveAttribute('tabindex', '0');
		await expect(wrap).toHaveAccessibleName(/scrolls sideways/);

		// The wrapper is what overflows. The document is not.
		const geometry = await wrap.evaluate((node) => ({
			wrapScroll: node.scrollWidth,
			wrapClient: node.clientWidth,
			docScroll: document.documentElement.scrollWidth,
			docClient: document.documentElement.clientWidth
		}));
		expect(geometry.docScroll).toBe(geometry.docClient);

		// Keyboard reach is the reason for the tabindex: focus it and scroll.
		await wrap.focus();
		await expect(wrap).toBeFocused();
		if (geometry.wrapScroll > geometry.wrapClient) {
			for (let press = 0; press < 6; press += 1) await page.keyboard.press('ArrowRight');
			await expect.poll(async () => wrap.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
		}
	});

	test('a pool row reads as a record at both widths, and its detail changes presentation, not content', async ({
		page
	}, testInfo) => {
		await page.goto('/app/schedule');
		const row = page.locator('#pool-ses-13');
		await expect(row).toBeVisible({ timeout: 15000 });

		// The identifying line wraps rather than truncating, and the scan keys
		// carry the track as a chip rather than a run-on string.
		await expect(row.locator('.pool__title')).toHaveText(
			'Closing Keynote — speaker to be announced'
		);
		await expect(row.locator('.ui-track__label')).toHaveText('Agents & Tools');

		// Every control on the row sits inside the viewport — no row scrolls
		// sideways and no control is clipped away.
		const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
		for (const control of await row.locator('.pool__actions .ui-button').all()) {
			const box = await control.boundingBox();
			expect(box).not.toBeNull();
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(clientWidth + 1);
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(clientWidth);

		// The disclosure carries the labelled facts the two-line row compresses,
		// plus the people the pool row never named.
		const door = row.getByRole('button', { name: /^Details of / });
		await expect(door).toHaveAttribute('aria-expanded', 'false');
		await door.click();

		const detail =
			testInfo.project.name === 'mobile'
				? page.getByRole('dialog', { name: 'Closing Keynote — speaker to be announced' })
				: row.locator('.ui-detail');
		await expect(detail).toBeVisible();
		await expect(detail).toContainText('Not placed yet');
		await expect(detail).toContainText('No speakers yet');
		await expect(detail).toContainText('In the program');

		if (testInfo.project.name === 'mobile') {
			// A phone promotes the same content to a full-screen sheet, and its
			// own dismissal must clear the row's expanded state.
			await expect(page.locator('.ui-sheet')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.locator('.ui-sheet')).toBeHidden();
		} else {
			// Desktop keeps the inline expansion beside the list it belongs to.
			await expect(page.locator('.ui-sheet')).toHaveCount(0);
			await row.getByRole('button', { name: /^Hide details of / }).click();
			await expect(row.locator('.ui-detail')).toHaveCount(0);
		}
		await expect(row.getByRole('button', { name: /^Details of / })).toHaveAttribute(
			'aria-expanded',
			'false'
		);
	});

	test('destructive-but-secondary reads quiet; filled danger waits for the confirming press', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the emphasis contract');

		await page.goto('/app/schedule');
		// A card reveals its controls on hover, so the press starts there.
		const card = page.locator('#placed-ses-2');
		await expect(card).toBeVisible({ timeout: 15000 });
		await card.hover();

		const remove = card.getByRole('button', { name: /^Remove “/ });
		await expect(remove).toHaveClass(/ui-button--danger-quiet/);
		await expect(remove).not.toHaveClass(/ui-button--danger(\s|$)/);

		// Arming turns the card's own face into the question; *that* press is the
		// primary action of the surface asking it, so it is filled.
		await remove.click();
		const confirm = card.getByRole('button', { name: /— confirm$/ });
		await expect(confirm).toBeVisible();
		await expect(confirm).toHaveClass(/ui-button--danger\b/);
		await expect(confirm).not.toHaveClass(/danger-quiet/);

		// Standing down leaves the placement exactly as it was.
		await page.keyboard.press('Escape');
		await expect(confirm).toHaveCount(0);
		await expect(card).toBeVisible();
	});

	test('the conflicts list carries tone and word together, and never a column of solid badges', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the tone contract');

		await page.goto('/app/schedule');
		const conflicts = page.getByRole('region', { name: 'Conflicts' });
		await expect(conflicts).toBeVisible({ timeout: 15000 });

		// Colour is never the only carrier: every badge states its word.
		const badges = conflicts.locator('.ui-badge');
		await expect(badges.first()).toBeVisible();
		for (const badge of await badges.all()) {
			await expect(badge).toHaveText(/Blocking|Warning/);
		}
		// Blocking reads danger, warning reads caution — from the shared map.
		await expect(conflicts.locator('.ui-badge--danger').first()).toBeVisible();
		await expect(conflicts.locator('.ui-badge--warning').first()).toBeVisible();
		// The emphasis budget belongs to the cards that have to move, not to a
		// column restating what the cards already say.
		await expect(conflicts.locator('.ui-badge--solid')).toHaveCount(0);
	});
});
