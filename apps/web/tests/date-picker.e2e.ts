import { expect, test } from '@playwright/test';

test('date picker: constrained popover, year navigation, and the typed path', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'coarse pointers use the native picker');

	await page.goto('/app/settings');
	await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

	await page.getByRole('button', { name: 'Choose end date from calendar' }).click();
	const dialog = page.getByRole('dialog', { name: 'Choose end date' });
	await expect(dialog).toBeVisible();

	// The panel keeps one compact footprint and days before the event start are
	// disabled, not hidden.
	const box = await dialog.boundingBox();
	expect(box && box.width).toBeLessThanOrEqual(300);
	await expect(dialog.getByRole('button', { name: '11', exact: true })).toBeDisabled();

	// Any year is two taps from the day view.
	await dialog.getByRole('button', { name: /October 2026/ }).click();
	await dialog.getByRole('button', { name: '2026', exact: true }).click();
	await dialog.getByRole('button', { name: '2027', exact: true }).click();
	await dialog.getByRole('button', { name: 'Nov', exact: true }).click();
	await dialog.getByRole('button', { name: '5', exact: true }).click();
	await expect(page.locator('#event-end')).toHaveValue('2027-11-05');

	// Typing is a first-class path; out-of-range input is rejected, not clamped.
	await page.locator('#event-end').fill('2026-12-24');
	await page.locator('#event-end').press('Enter');
	await expect(page.locator('#event-end')).toHaveValue('2026-12-24');
	await page.locator('#event-end').fill('2026-01-01');
	await page.locator('#event-end').press('Enter');
	await expect(page.locator('#event-end')).toHaveAttribute('aria-invalid', 'true');
});
