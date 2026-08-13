import { expect, test } from '@playwright/test';

test('sample changes stay local, use the tuned interaction, and reset from one affordance', async ({
	page
}) => {
	const apiRequests: string[] = [];
	await page.route('**/api/**', (route) => {
		apiRequests.push(route.request().url());
		return route.abort('blockedbyclient');
	});

	await page.goto('/app/settings');
	await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
	const source = page.getByLabel('Sample data — what these numbers are');
	await expect(source).toBeVisible();
	await source.click();
	await expect(page.getByText('Mid-flight', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.getByLabel('Track name').fill('Browser proof track');
	await page.getByRole('button', { name: 'Add track' }).click();
	await expect(page.getByText('Browser proof track', { exact: true })).toBeVisible();

	await source.click();
	await page.getByRole('button', { name: 'Reset sample data' }).click();
	await expect(page.getByText('Browser proof track', { exact: true })).toHaveCount(0);
	await expect(page.getByLabel('Track name')).toBeVisible();

	expect(apiRequests).toEqual([]);
	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
});
