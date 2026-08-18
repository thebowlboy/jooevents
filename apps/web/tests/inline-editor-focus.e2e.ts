import { expect, test } from '@playwright/test';

/**
 * Click-to-edit means type-to-edit: opening a unit's editor lands focus in its
 * field with the caret ready, on both surfaces that mount the machinery.
 */
test('the templates editor focuses its field on open', async ({ page }) => {
	await page.goto('/app/templates?template=tpl-schedule-announcement');
	await expect(page.getByRole('region', { name: 'Message preview' })).toContainText(
		'The schedule is out',
		{ timeout: 15000 }
	);
	await page.locator('[data-edit="blocks.0.text"]').click({ position: { x: 12, y: 12 } });
	await expect(page.locator('.ied').getByRole('textbox').first()).toBeFocused();
});

test('the composer preview focuses its field on open, add-section included', async ({ page }) => {
	await page.goto('/app/messages?compose=1');
	const dialog = page.getByRole('dialog', { name: 'Compose message' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText('Your headline goes here')).toBeVisible({ timeout: 15000 });
	await dialog.locator('[data-edit="blocks.0.text"]').first().click();
	await expect(page.locator('.ied').getByRole('textbox').first()).toBeFocused();
	// Escape would close the whole composer (the recorded layering defect),
	// so the editor is dismissed by its own control.
	await page.locator('.ied').getByRole('button', { name: 'Cancel' }).click();

	// Insert-then-type is one gesture only when the new section's field is live.
	await dialog.getByRole('button', { name: '+ Add section' }).click();
	await page.getByRole('menuitem', { name: 'Paragraph' }).click();
	await expect(page.locator('.ied').getByRole('textbox').first()).toBeFocused();
});
