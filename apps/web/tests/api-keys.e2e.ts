import { expect, test, type Page } from '@playwright/test';

const panel = (page: Page) => page.getByRole('region', { name: 'API keys' });

async function open(page: Page) {
	await page.goto('/app/settings/api-keys');
	await expect(panel(page)).toBeVisible({ timeout: 15000 });
}

async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

test('the key list groups active before retired, badges only exceptions, and never overflows', async ({
	page
}) => {
	await open(page);
	// Fixture keys, active group first with the band naming the resting state.
	await expect(panel(page).getByText('Claude assistant')).toBeVisible();
	await expect(panel(page).getByText('Production dashboard')).toBeVisible();
	await expect(panel(page).getByText('Never expires')).toBeVisible();
	await expect(panel(page).getByRole('heading', { name: /Revoked and expired/ })).toBeVisible();
	await expect(panel(page).getByText('Old export script')).toBeVisible();
	// The expiring fixture carries the caution state in words; healthy rows carry none.
	await expect(panel(page).getByText(/Expires in \d+ days/)).toBeVisible();
	// Hints identify keys without ever re-showing a secret.
	await expect(panel(page).getByText('jooak1_Vk8j…')).toBeVisible();
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('creation leads with profiles, drifts to Custom on any flipped switch, and shows the secret once', async ({
	page
}) => {
	await open(page);
	await panel(page).getByRole('button', { name: 'New API key' }).click();

	const dialog = page.getByRole('dialog', { name: 'New API key' });
	await expect(dialog).toBeVisible();
	// The profile tiles are the easy path; Assistant is preselected.
	await expect(dialog.getByRole('radio', { name: 'Assistant' })).toBeChecked();
	await expect(dialog.getByRole('radio', { name: 'Full access' })).toBeVisible();
	await expect(dialog.getByRole('radio', { name: 'Dashboard' })).toBeVisible();
	await expect(dialog.getByRole('radio', { name: 'Schedule display' })).toBeVisible();
	// The summary restates the preset grant before anything is minted.
	await expect(dialog.getByText('Reads and proposes · 5 permissions · All events', { exact: false })).toBeVisible();
	await dialog.getByLabel('Expires').selectOption('never');
	await expect(dialog.getByRole('status')).toContainText('Never expires');

	// Granular is the disclosure beneath, grouped by the catalog's own areas.
	await dialog.getByRole('button', { name: 'Adjust individual permissions' }).click();
	await expect(dialog.getByRole('checkbox', { name: 'Speakers' })).toBeVisible();
	await expect(dialog.getByText('Sensitive').first()).toBeVisible();
	await expect(dialog.getByText('Consequential').first()).toBeVisible();
	// An unheld permission is shown and marked, never hidden.
	await expect(
		dialog.getByText("You don't hold this today, so the key won't either until you do.")
	).toBeVisible();

	// One flipped switch moves the tile to Custom, naming what it was based on.
	// The visible label is the tap target a person actually has.
	await dialog
		.locator('label.ui-switch', { hasText: 'See private contact details' })
		.click();
	await expect(dialog.getByRole('radio', { name: 'Custom' })).toBeChecked();
	await expect(dialog.getByText('Based on Assistant, adjusted below.')).toBeVisible();

	// Mint, and the secret appears exactly once, in the show-once dialog.
	await dialog.getByRole('textbox', { name: 'Name' }).fill('Playwright key');
	await dialog.getByRole('button', { name: 'Create key' }).click();
	const secret = page.getByRole('dialog', { name: 'Your new API key' });
	await expect(secret).toBeVisible();
	await expect(secret.getByText(/jooak1_[A-Za-z0-9_-]{43}/)).toBeVisible();
	await secret.getByRole('button', { name: 'Done' }).click();
	// The list gains the key; the secret never renders in it.
	await expect(panel(page).getByText('Playwright key', { exact: true })).toBeVisible();
	const listedSecret = await panel(page).getByText(/jooak1_[A-Za-z0-9_-]{43}/).count();
	expect(listedSecret).toBe(0);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('revoke arms in place before it fires, and the key moves to the retired group', async ({
	page
}) => {
	await open(page);
	const revoke = panel(page).getByRole('button', { name: 'Revoke Lobby screen' });
	await revoke.click();
	await expect(revoke).toHaveText('Revoke?');
	await revoke.click();
	await expect(
		panel(page).getByRole('heading', { name: /Revoked and expired \(2\)/ })
	).toBeVisible();
	await expect(panel(page).getByRole('button', { name: 'Revoke Lobby screen' })).toHaveCount(0);
});

test('the key rows stack as records with touch-sized controls at phone width', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'phone composition only');
	await open(page);
	// The narrow composition is the card list, not a squeezed table.
	await expect(panel(page).locator('.card').first()).toBeVisible();
	const create = panel(page).getByRole('button', { name: 'New API key' });
	const createBox = await create.boundingBox();
	expect(createBox?.height ?? 0).toBeGreaterThanOrEqual(40);
	const rotate = panel(page).getByRole('button', { name: 'Rotate Claude assistant' });
	const rotateBox = await rotate.boundingBox();
	expect(rotateBox?.height ?? 0).toBeGreaterThanOrEqual(40);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});
