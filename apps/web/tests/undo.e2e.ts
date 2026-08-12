import { expect, test } from '@playwright/test';

test('remove arms, then fires, then hands back an undo that names its target', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the receipt contract');

	await page.goto('/app/schedule');
	const card = page.locator('#placed-ses-2');
	await expect(card).toBeVisible({ timeout: 15000 });

	// First press arms; nothing is removed yet.
	const removeButton = card.getByRole('button', { name: /Remove/ });
	await card.hover();
	await removeButton.click();
	await expect(card.getByRole('button', { name: /Press again to remove/ })).toBeVisible();
	await expect(card).toBeVisible();

	// Second press removes and leaves a receipt naming the exact object.
	await card.getByRole('button', { name: /Press again to remove/ }).click();
	const receipt = page.getByRole('status').filter({ hasText: 'Removed “Context Caching Without Tears”' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(card).toHaveCount(0);

	// Undo restores the placement in its exact slot.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('#placed-ses-2')).toBeVisible({ timeout: 10000 });
});

test('an irreversible send leaves a receipt that says why it cannot be undone', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the receipt contract');

	await page.goto('/app/decisions');
	await expect(page.getByRole('table')).toContainText('Context Caching Without Tears', { timeout: 15000 });

	await page.getByRole('button', { name: 'Compose notifications' }).click();
	const dialog = page.getByRole('dialog', { name: /notification/i });
	await dialog.getByRole('button', { name: /Send \d+ emails/ }).click();

	const receipt = page.getByRole('status').filter({ hasText: /Sent \d+ decision notification/ });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(receipt).toContainText('cannot be recalled');
	await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0);
});
