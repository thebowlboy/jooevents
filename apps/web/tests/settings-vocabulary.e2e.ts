import { expect, test, type Locator, type Page } from '@playwright/test';

const panelOf = (page: Page) => page.getByRole('region', { name: 'Program basics' });

/** A clipped explanation still has a 1px box, so width is what separates the states. */
async function shownWidth(locator: Locator): Promise<number> {
	const box = await locator.boundingBox();
	return box?.width ?? 0;
}

test('a used entry shows its usage and explains the delete it will not offer', async ({
	page
}, testInfo) => {
	await page.goto('/app/settings/program');
	const panel = panelOf(page);

	// The three lists are separately headed and described; the old umbrella note
	// that lectured about referential integrity is gone.
	await expect(panel.getByRole('heading', { name: 'Rooms' })).toBeVisible({ timeout: 15000 });
	await expect(panel.getByRole('heading', { name: 'Tracks' })).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Formats' })).toBeVisible();
	await expect(panel).toContainText('Where sessions happen.');
	await expect(panel).toContainText('Content lanes you group talks into.');
	await expect(panel).toContainText('Session shapes and their default lengths');
	await expect(panel).not.toContainText('every form');
	await expect(panel).not.toContainText('removal is refused');

	const row = panel.getByRole('listitem').filter({ hasText: 'Agents & Tools' });
	await expect(row).toContainText(/\d+ submissions/);

	// The control the system would refuse stays visible, stays focusable, and
	// carries the reason it would answer with.
	const control = row.getByRole('button', { name: 'Delete Agents & Tools' });
	await expect(control).toHaveAttribute('aria-disabled', 'true');
	const reason = row.locator('p[id^="vocab-note-"]');
	expect(await shownWidth(reason)).toBeLessThanOrEqual(2);

	if (testInfo.project.name === 'desktop') {
		// Where there is a pointer, keyboard focus alone reaches the reason.
		await control.focus();
		await expect(control).toBeFocused();
		expect(await shownWidth(reason)).toBeGreaterThan(80);
	}

	// Pressing it answers instead of attempting a refusal. `force` because the
	// control is aria-disabled, which a person can still press — that is the
	// whole point of not using `disabled`.
	await control.click({ force: true });
	expect(await shownWidth(reason)).toBeGreaterThan(80);
	await expect(reason).toContainText('reference this track');
	await expect(reason).toContainText('Retire it to stop new use');
	await expect(panel.getByRole('status')).toContainText('reference this track');
	await expect(row).toBeVisible();
});

test('an unused entry offers a delete that removes it', async ({ page }) => {
	await page.goto('/app/settings/program');
	const panel = panelOf(page);
	await expect(panel.getByRole('heading', { name: 'Tracks' })).toBeVisible({ timeout: 15000 });

	// No dataset is guaranteed to hold an unused entry, so the test makes one.
	await panel.getByLabel('Track name').fill('Fireside');
	await panel.getByRole('button', { name: 'Add track' }).click();

	const row = panel.getByRole('listitem').filter({ hasText: 'Fireside' });
	await expect(row).toContainText('not used yet');
	await expect(page.getByRole('status').filter({ hasText: 'Added track “Fireside”' })).toBeVisible();

	const control = row.getByRole('button', { name: 'Delete Fireside' });
	await expect(control).not.toHaveAttribute('aria-disabled', 'true');
	await control.click();
	await expect(row).toHaveCount(0);
	await expect(page.getByRole('status').filter({ hasText: 'Deleted track “Fireside”' })).toBeVisible();
});

test('retiring keeps the entry rendering and takes it out of what is offered', async ({
	page
}, testInfo) => {
	await page.goto('/app/settings/program');
	const panel = panelOf(page);
	const row = panel.getByRole('listitem').filter({ hasText: 'Evals & Reliability' });
	await expect(row).toBeVisible({ timeout: 15000 });

	await row.hover();
	await row.getByRole('button', { name: 'More actions for Evals & Reliability' }).click();
	await row.getByRole('button', { name: 'Retire Evals & Reliability' }).click();

	await expect(row).toContainText('retired');
	await expect(row.getByRole('button', { name: 'Restore Evals & Reliability' })).toBeVisible();
	const receipt = page.getByRole('status').filter({ hasText: 'Retired track “Evals & Reliability”' });
	await expect(receipt).toBeVisible();

	if (testInfo.project.name === 'desktop') {
		// A retired track is no longer offered for new use; the submissions it
		// already carries keep naming it.
		await page
			.getByRole('navigation', { name: 'Workspace', exact: true })
			.getByRole('link', { name: 'Submissions' })
			.click();
		const filter = page.getByLabel('Filter by track');
		await expect(filter).toBeVisible();
		await expect(filter.getByRole('option', { name: 'Evals & Reliability' })).toHaveCount(0);
		await expect(page.getByRole('table')).toContainText('Evals & Reliability');

		// The rail opens the area; the way back to this section is the surface's
		// own tabs and then Program.
		const settingsNav = page.getByRole('navigation', { name: 'Workspace controls' });
		await settingsNav.getByRole('link', { name: 'Settings', exact: true }).click();
		await page
			.getByRole('navigation', { name: 'Settings sections' })
			.getByRole('link', { name: 'Program', exact: true })
			.click();
		await expect(panelOf(page).getByRole('heading', { name: 'Tracks' })).toBeVisible({ timeout: 15000 });
	}

	// Restore is the inverse, and the receipt's undo is the same operation.
	const restoredRow = panelOf(page).getByRole('listitem').filter({ hasText: 'Evals & Reliability' });
	await restoredRow.getByRole('button', { name: 'Restore Evals & Reliability' }).click();
	await expect(restoredRow).not.toContainText('retired');
});
