import { expect, test } from '@playwright/test';

async function documentOverflow(page: import('@playwright/test').Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

async function blockGap(
	page: import('@playwright/test').Page,
	before: string,
	after: string
): Promise<number> {
	return page.evaluate(({ before, after }) => {
		const leading = document.querySelector(before);
		const trailing = document.querySelector(after);
		if (!(leading instanceof HTMLElement) || !(trailing instanceof HTMLElement)) {
			throw new Error('airtable_spacing_targets_missing');
		}
		return trailing.getBoundingClientRect().top - leading.getBoundingClientRect().bottom;
	}, { before, after });
}

test('Airtable explains the shared-team outcome and keeps each area direction explicit', async ({
	page
}) => {
	await page.goto('/app/integrations/airtable?panel=shared');
	await expect(page.getByRole('heading', { level: 2, name: 'Airtable' })).toBeVisible({
		timeout: 15_000
	});

	await expect(page.getByText(/A live base your Airtable team can work in/)).toBeVisible();
	await expect(page.getByText(/protected changes are restored or become review requests/i)).toBeVisible();

	const taskDirection = page.getByRole('combobox', { name: 'Direction for Speaker tasks' });
	await expect(taskDirection).toHaveText(/Work from Airtable/);
	await expect(page.getByText('1 field can update JooEvents')).toBeVisible();
	await taskDirection.click();
	await expect(page.getByText(/JooEvents values stay current in Airtable; edits there do not change the app/)).toBeVisible();
	await expect(page.getByText(/Approved fields can update JooEvents; protected changes become review requests/)).toBeVisible();
	await page.keyboard.press('Escape');

	const scheduleDirection = page.getByRole('combobox', { name: 'Direction for Schedule' });
	await expect(scheduleDirection).toHaveText(/Keep Airtable updated/);
	await expect(page.getByText(/Review scores, private notes, and sign-in or access data never go to Airtable/)).toBeVisible();
	const history = page.locator('#history');
	await expect(history.locator('.history-kind').filter({ hasText: /^From Airtable$/ })).toBeVisible();
	await expect(history.locator('.history-kind').filter({ hasText: /^Restored$/ })).toBeVisible();
	await expect(history.locator('.history-kind').filter({ hasText: /^Sharing$/ })).toBeVisible();
	await expect(history.getByText('2 hours ago', { exact: true })).toBeVisible();
	await expect(history.getByText('1 day ago', { exact: true })).toBeVisible();
	await expect(history.getByText('4 days ago', { exact: true })).toBeVisible();
	await expect(history.locator('.history-row__summary strong').first()).toHaveText('Dana Ryu');
	await expect(history.locator('.change').first().getByText('Before', { exact: true })).toBeVisible();
	await expect(history.locator('.change').first().getByText('After', { exact: true })).toBeVisible();

	const headerGap = await blockGap(page, '.airtable-head', '#waiting');
	const sectionGap = await blockGap(page, '#waiting', '#shared');
	expect(headerGap).toBeGreaterThanOrEqual(16);
	expect(headerGap).toBeLessThanOrEqual(20);
	expect(sectionGap).toBe(headerGap);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('the Airtable working surface re-composes without document overflow on touch', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'touch-width composition');
	await page.goto('/app/integrations/airtable?panel=shared');
	await expect(page.getByRole('heading', { level: 2, name: 'Airtable' })).toBeVisible({
		timeout: 15_000
	});
	await expect(page.getByRole('combobox', { name: 'Direction for Speaker tasks' })).toBeVisible();
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});
