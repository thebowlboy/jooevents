import { expect, test } from '@playwright/test';

/**
 * The way into form authoring arrives where the organizer already is, keyed
 * to state (04 §2 direction note, 2026-08-13): a brand-new event's empty
 * submissions inbox nudges toward opening a call for proposals (CFP) with a
 * door straight into the creation act; once a form is open, the same empty
 * inbox switches to sharing. Filtered and search empties never nudge.
 */

/** Creates a fresh event, so no form is open and nothing has arrived. */
async function createEvent(page: import('@playwright/test').Page, name: string) {
	await page.goto('/app');
	await expect(page.getByRole('button', { name: 'Switch event' })).toBeVisible({
		timeout: 15000
	});
	await page.getByRole('button', { name: 'Switch event' }).click();
	await page.getByRole('button', { name: 'New event' }).click();
	const dialog = page.getByRole('dialog', { name: 'New event' });
	await dialog.getByLabel('Name').fill(name);
	await page.locator('#new-event-start').fill('2027-09-09');
	await page.locator('#new-event-start').press('Enter');
	await page.locator('#new-event-end').fill('2027-09-10');
	await page.locator('#new-event-end').press('Enter');
	await dialog.getByRole('button', { name: 'Create event' }).click();
	await expect(page).toHaveURL(/\/app$/, { timeout: 15000 });
	await expect(page.locator('.side__event-name')).toHaveText(name, { timeout: 15000 });
}

test('an empty inbox with no open form nudges toward the CFP, and the door lands inside creation', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the nudge contract');

	await createEvent(page, 'DevOps Days Tallinn 2027');

	// The Overview already points the same way, in the same words.
	await expect(page.getByText('Open your call for proposals (CFP)').first()).toBeVisible();

	await page.getByRole('link', { name: 'Submissions' }).click();
	const empty = page.locator('.empty');
	await expect(
		empty.getByText("No submissions yet — your call for proposals (CFP) isn't open.")
	).toBeVisible({ timeout: 15000 });

	// The secondary path keeps the direct-entry vocabulary and stays a control.
	await expect(empty.getByRole('button', { name: 'Add submission' })).toBeVisible();

	// The door is the creation act itself, not an area name to decode.
	await empty.getByRole('link', { name: 'Open a call for proposals' }).click();
	await expect(page).toHaveURL(/\/app\/forms\?new=1$/);
	const formDialog = page.getByRole('dialog', { name: 'New form' });
	await expect(formDialog).toBeVisible({ timeout: 15000 });
	await expect(formDialog).toContainText('call for proposals (CFP)');

	// Dismissing leaves a clean address, so a reload cannot reopen it.
	await page.keyboard.press('Escape');
	await expect(formDialog).toBeHidden();
	await expect(page).toHaveURL(/\/app\/forms$/);
});

test('with a form open but nothing arrived, the empty inbox switches to sharing', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the state fork');

	await createEvent(page, 'DevOps Days Riga 2027');

	// Create the standard application and walk it to open.
	await page.goto('/app/forms?new=1');
	const formDialog = page.getByRole('dialog', { name: 'New form' });
	await expect(formDialog).toBeVisible({ timeout: 15000 });
	await formDialog.getByLabel('Name').fill('Call for proposals');
	await formDialog.getByRole('button', { name: 'Create form' }).click();
	await expect(
		page.getByRole('heading', { level: 1, name: 'Call for proposals' })
	).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: 'Open form' }).click();

	await page.getByRole('link', { name: 'Submissions' }).click();
	const empty = page.locator('.empty');
	await expect(
		empty.getByText('Your call for proposals (CFP) is open — nothing has arrived yet.')
	).toBeVisible({ timeout: 15000 });
	await expect(empty.getByRole('link', { name: 'Open Forms' })).toBeVisible();
});
