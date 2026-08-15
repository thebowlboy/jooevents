import { expect, test } from '@playwright/test';

test('remove arms, then fires, then hands back an undo that names its target', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the receipt contract');

	await page.goto('/app/schedule');
	const card = page.locator('#placed-ses-2');
	await expect(card).toBeVisible({ timeout: 15000 });

	// First press arms: the card's own face becomes the question; nothing is
	// removed yet, and Keep stands the whole thing down.
	await card.hover();
	await card.getByRole('button', { name: 'Remove “Streaming Agent UIs Without a State Machine Meltdown” from the schedule' }).click();
	const veil = card.getByRole('group', { name: 'Remove “Streaming Agent UIs Without a State Machine Meltdown” from the schedule?' });
	await expect(veil).toBeVisible();
	await veil.getByRole('button', { name: 'Keep “Streaming Agent UIs Without a State Machine Meltdown” on the schedule' }).click();
	await expect(veil).toHaveCount(0);
	await expect(card).toBeVisible();

	// Armed again, the explicit confirm removes and leaves a receipt naming the
	// exact object.
	await card.hover();
	await card.getByRole('button', { name: 'Remove “Streaming Agent UIs Without a State Machine Meltdown” from the schedule' }).click();
	await card.getByRole('button', { name: 'Remove “Streaming Agent UIs Without a State Machine Meltdown” — confirm' }).click();
	const receipt = page.getByRole('status').filter({ hasText: 'Removed “Streaming Agent UIs Without a State Machine Meltdown”' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(card).toHaveCount(0);

	// Undo restores the placement in its exact slot.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('#placed-ses-2')).toBeVisible({ timeout: 10000 });
});

test('an irreversible send leaves a receipt that says why it cannot be undone', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the receipt contract');

	await page.goto('/app/decisions');
	await expect(page.getByRole('table')).toContainText('Streaming Agent UIs Without a State Machine Meltdown', { timeout: 15000 });

	await page.getByRole('button', { name: 'Send their results' }).click();
	const dialog = page.getByRole('dialog', { name: /notification/i });
	await dialog.getByRole('button', { name: /Send \d+ emails/ }).click();

	const receipt = page.getByRole('status').filter({ hasText: /Sent \d+ decision notification/ });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(receipt).toContainText('cannot be recalled');
	await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0);
});
