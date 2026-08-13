import { expect, test, type Page } from '@playwright/test';

/**
 * The shell's one identity mark: the top-bar account menu (identity, email
 * change with dual confirmation, the coming-soon security region, confirmed
 * sign-out), and the sidebar event switcher it left the sidebar to.
 */

async function openWorkspace(page: Page) {
	await page.goto('/app');
	await expect(page.getByRole('button', { name: 'Your account' })).toBeVisible({ timeout: 15000 });
}

async function openMenu(page: Page) {
	await openWorkspace(page);
	await page.getByRole('button', { name: 'Your account' }).click();
}

test('identity renders once, in the account menu, resolved from the workspace', async ({
	page
}) => {
	await openMenu(page);

	// The menu is the identity: name and email as one tight group.
	const menu = page.locator('.menu');
	await expect(menu.locator('.menu__name')).toHaveText('Jere K.');
	await expect(menu.locator('.menu__email')).toHaveText('jere@aie-demo.example');

	// The old sidebar identity chip is gone — one mark, not two: the sidebar
	// carries no avatar, the top bar carries exactly one.
	await expect(page.locator('.side .ui-avatar')).toHaveCount(0);
	await expect(page.locator('.top .ui-avatar')).toHaveCount(1);
});

test('the security region explains once; its rows are reachable, badged, and inert', async ({
	page
}) => {
	await openMenu(page);

	await expect(
		page.getByText('Password and two-factor sign-in arrive with a later slice', { exact: false })
	).toBeVisible();
	const password = page.getByRole('button', { name: 'Password' });
	const otp = page.getByRole('button', { name: 'Two-factor (OTP)' });
	await expect(password).toHaveAttribute('aria-disabled', 'true');
	await expect(otp).toHaveAttribute('aria-disabled', 'true');
	// aria-disabled, not disabled: the rows stay focusable so the reason is reachable.
	await password.focus();
	await expect(password).toBeFocused();
	await expect(page.getByText('Coming soon')).toHaveCount(2);
});

test('an email change pends on both confirmations, and cancel compensates it', async ({
	page
}) => {
	await openMenu(page);
	await page.getByRole('button', { name: 'Change email address' }).click();
	const dialog = page.getByRole('dialog', { name: 'Change email address' });
	await expect(dialog).toBeVisible();

	// An expected refusal is a value, stated on the field.
	await dialog.getByLabel('New email address').fill('jere@aie-demo.example');
	await dialog.getByRole('button', { name: 'Send confirmations' }).click();
	await expect(dialog.getByText('This is already your address')).toBeVisible();

	await dialog.getByLabel('New email address').fill('jere@next.example');
	await dialog.getByRole('button', { name: 'Send confirmations' }).click();

	// The dialog becomes the record of the change in flight: both mailboxes, badged.
	await expect(dialog.getByText('Confirmation sent')).toHaveCount(2);
	await expect(dialog.getByText('approves the change')).toBeVisible();
	await expect(dialog.getByText('proves the new address is yours')).toBeVisible();
	await dialog.getByRole('button', { name: 'Done' }).click();

	// The menu carries the pending fact and the standing way back in.
	await page.getByRole('button', { name: 'Your account' }).click();
	await expect(page.getByText('Change to jere@next.example pending', { exact: false })).toBeVisible();
	await page.getByRole('button', { name: 'Review email change' }).click();

	// Cancel is the compensator: the dialog returns to a fresh request.
	await dialog.getByRole('button', { name: 'Cancel change' }).click();
	await expect(dialog.getByRole('button', { name: 'Send confirmations' })).toBeVisible();
	await expect(dialog.getByText('Confirmation sent')).toHaveCount(0);
});

test('sign out ends the session before the UI moves, landing on sign-in', async ({ page }) => {
	await openMenu(page);
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/sign-in\?notice=signed_out/, { timeout: 15000 });
});

test('the sidebar chip switches between the workspace events', async ({ page }, testInfo) => {
	await openWorkspace(page);
	if (testInfo.project.name === 'mobile') {
		await page.getByRole('button', { name: 'Open navigation' }).click();
		await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
	}

	await expect(page.locator('.side__event-name')).toHaveText('AI Engineer NYC 2026');
	await page.getByRole('button', { name: 'Switch event' }).click();

	// The list loaded with the shell, so the picker opens already answered.
	await expect(page.locator('.evswitch')).not.toHaveAttribute('aria-busy', 'true');

	// Options are served live; the current event is marked, not accented.
	const current = page.getByRole('button', { name: /AI Engineer NYC 2026/ });
	await expect(current).toHaveAttribute('aria-pressed', 'true');
	const london = page.getByRole('button', { name: /AI Engineer London 2027/ });
	await expect(london).toContainText('Mar 3–4, 2027 · London');

	// Creation lives in this flow, a real button at rest.
	await expect(page.getByRole('button', { name: 'New event' })).toBeEnabled();

	// A switch re-scopes every surface at once.
	await london.click();
	await expect(page.locator('.side__event-name')).toHaveText('AI Engineer London 2027', {
		timeout: 15000
	});

	if (testInfo.project.name === 'mobile') {
		await page.getByRole('button', { name: 'Open navigation' }).click();
	}
	await page.getByRole('button', { name: 'Switch event' }).click();
	await page.getByRole('button', { name: /AI Engineer NYC 2026/ }).click();
	await expect(page.locator('.side__event-name')).toHaveText('AI Engineer NYC 2026', {
		timeout: 15000
	});
});

test('a new event is created from the switcher, and the workspace arrives on it', async ({
	page
}, testInfo) => {
	await openWorkspace(page);
	if (testInfo.project.name === 'mobile') {
		await page.getByRole('button', { name: 'Open navigation' }).click();
		await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
	}
	await page.getByRole('button', { name: 'Switch event' }).click();
	await page.getByRole('button', { name: 'New event' }).click();

	const dialog = page.getByRole('dialog', { name: 'New event' });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Name').fill('DevOps Days Helsinki 2027');

	// Dates validate where they are entered; the refusal is a value in place.
	await page.locator('#new-event-start').fill('2027-09-09');
	await page.locator('#new-event-start').press('Enter');
	await page.locator('#new-event-end').fill('2027-09-08');
	await page.locator('#new-event-end').press('Enter');
	await expect(dialog.getByText('The end date cannot fall before the start date.')).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Create event' })).toBeDisabled();

	await page.locator('#new-event-end').fill('2027-09-10');
	await page.locator('#new-event-end').press('Enter');
	await dialog.getByRole('button', { name: 'Create event' }).click();

	// Creation's receipt is the arrival: the workspace re-scopes to the new
	// event and lands on its overview.
	await expect(page).toHaveURL(/\/app$/, { timeout: 15000 });
	await expect(page.locator('.side__event-name')).toHaveText('DevOps Days Helsinki 2027', {
		timeout: 15000
	});

	// Every area is open and empty rather than locked or faked.
	await page.goto('/app/forms');
	await expect(page.getByRole('heading', { name: 'No forms yet' })).toBeVisible({
		timeout: 15000
	});
	await page.goto('/app/settings');
	await expect(page.locator('#event-name')).toHaveValue('DevOps Days Helsinki 2027', {
		timeout: 15000
	});

	// The switcher lists it beside the sample events, marked current.
	if (testInfo.project.name === 'mobile') {
		await page.getByRole('button', { name: 'Open navigation' }).click();
	}
	await page.getByRole('button', { name: 'Switch event' }).click();
	await expect(
		page.getByRole('button', { name: /DevOps Days Helsinki 2027/ })
	).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: /AI Engineer NYC 2026/ }).click();
	await expect(page.locator('.side__event-name')).toHaveText('AI Engineer NYC 2026', {
		timeout: 15000
	});
});
