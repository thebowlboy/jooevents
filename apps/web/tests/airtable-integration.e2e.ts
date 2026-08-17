import { expect, test } from '@playwright/test';

async function documentOverflow(page: import('@playwright/test').Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
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
