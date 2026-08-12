import { expect, test } from '@playwright/test';

test('timezone picker browses on open, searches, and commits a pointer selection', async ({ page }, testInfo) => {
	await page.goto('/app/settings');

	const trigger = page.getByRole('combobox', { name: 'Timezone' });
	await expect(trigger).toBeVisible({ timeout: 15000 });
	await expect(trigger).toContainText('New York');
	await expect(trigger).toContainText(/GMT[+-]\d/);

	// Opening with a value browses the full list instead of filtering to it.
	await trigger.click();
	const search = page.getByRole('combobox', { name: 'Search timezones' });
	// A touch keyboard would cover the list, so only fine pointers autofocus search.
	if (testInfo.project.name === 'desktop') await expect(search).toBeFocused();
	const options = page.getByRole('option');
	expect(await options.count()).toBeGreaterThan(5);
	await expect(
		page.getByRole('option', { name: /New York America\/New_York/ })
	).toHaveAttribute('aria-selected', 'true');

	// Search accepts human spelling and commits on click.
	await search.fill('losangeles');
	const losAngeles = options.first();
	await expect(losAngeles).toHaveAccessibleName(/Los Angeles America\/Los_Angeles/);
	await losAngeles.click();
	await expect(trigger).toContainText('Los Angeles');
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('listbox')).toHaveCount(0);

	// Typo tolerance plus keyboard commit.
	await trigger.click();
	await search.fill('singapre');
	await expect(options.first()).toHaveAccessibleName(/Singapore Asia\/Singapore/);
	await search.press('Enter');
	await expect(trigger).toContainText('Singapore');
	await expect(trigger).toContainText('GMT+8');
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');

	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
});

test('timezone picker finds zones by country and by GMT offset', async ({ page }) => {
	await page.goto('/app/settings');

	const trigger = page.getByRole('combobox', { name: 'Timezone' });
	await expect(trigger).toBeVisible({ timeout: 15000 });
	await trigger.click();

	const search = page.getByRole('combobox', { name: 'Search timezones' });
	const options = page.getByRole('option');
	await search.fill('malaysia');
	await expect(options.first()).toHaveAccessibleName(/Kuala Lumpur Asia\/Kuala_Lumpur/);

	await search.fill('gmt+5:30');
	await expect(options.first()).toHaveAccessibleName(/Kolkata Asia\/Kolkata/);

	await search.fill('not a real timezone');
	await expect(page.getByText(/No timezone found/)).toBeVisible();

	// Escape closes without committing and returns focus to the trigger.
	await search.press('Escape');
	await expect(trigger).toContainText('New York');
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('timezone picker opens from the keyboard and seeds typed characters', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'hardware-keyboard entry path');

	await page.goto('/app/settings');

	const trigger = page.getByRole('combobox', { name: 'Timezone' });
	await expect(trigger).toBeVisible({ timeout: 15000 });

	await trigger.focus();
	await trigger.press('t');
	const search = page.getByRole('combobox', { name: 'Search timezones' });
	await expect(search).toBeFocused();
	await expect(search).toHaveValue('t');
	await search.pressSequentially('okyo');
	await expect(page.getByRole('option').first()).toHaveAccessibleName(/Tokyo Asia\/Tokyo/);
	await search.press('Enter');
	await expect(trigger).toContainText('Tokyo');
	await expect(trigger).toBeFocused();
});
