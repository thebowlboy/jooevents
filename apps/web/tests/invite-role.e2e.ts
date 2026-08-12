import { expect, test } from '@playwright/test';

test('inviting a member explains each role before and after the choice', async ({ page }, testInfo) => {
	await page.goto('/app/settings');

	await page.getByRole('button', { name: 'Invite member' }).click();
	const dialog = page.getByRole('dialog', { name: 'Invite a member' });
	await expect(dialog).toBeVisible();

	// The default role is already explained without opening anything.
	const roleField = dialog.getByRole('combobox', { name: 'Role' });
	await expect(roleField).toContainText('Viewer');
	await expect(dialog.getByText(/Read-only: event details/)).toBeVisible();

	// Opening the picker shows every role with its description alongside.
	await roleField.click();
	const roleList = page.getByRole('listbox', { name: 'Roles' });
	const options = roleList.getByRole('option');
	await expect(options).toHaveCount(7);
	await expect(
		roleList.getByRole('option', { name: /Speaker Reviewer Reads, scores, and comments/ })
	).toBeVisible();
	await expect(
		roleList.getByRole('option', { name: /Workspace Admin Full control of the workspace/ })
	).toBeVisible();

	if (testInfo.project.name !== 'desktop') {
		// Touch gets a readable sheet with its own dismiss.
		await expect(page.getByRole('button', { name: 'Close roles list' })).toBeVisible();
	}

	// Choosing updates both the trigger and the explanation under the field.
	await roleList.getByRole('option', { name: /Speaker Reviewer/ }).click();
	await expect(roleField).toContainText('Speaker Reviewer');
	await expect(dialog.getByText(/No private contact details and no accept\/reject/)).toBeVisible();
	await expect(roleList).toHaveCount(0);

	// The choice flows into the invitation itself.
	await dialog.getByRole('textbox', { name: 'Email address' }).fill('reviewer@example.com');
	await dialog.getByRole('button', { name: 'Send invitation' }).click();
	await expect(dialog).not.toBeVisible();
	// Desktop lists members in a table; touch uses cards — assert on the text.
	await expect(page.getByText('reviewer@example.com', { exact: true })).toBeVisible();
});

test('the role picker is keyboard-operable inside the modal without closing it', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'hardware-keyboard path');

	await page.goto('/app/settings');
	await page.getByRole('button', { name: 'Invite member' }).click();
	const dialog = page.getByRole('dialog', { name: 'Invite a member' });

	const roleField = dialog.getByRole('combobox', { name: 'Role' });
	await roleField.click();
	const roleList = page.getByRole('listbox', { name: 'Roles' });
	await expect(roleList).toBeVisible();

	// Escape closes only the picker; the modal stays.
	await roleField.press('Escape');
	await expect(roleList).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await expect(roleField).toBeFocused();

	// Arrow + typeahead selection.
	await roleField.press('ArrowDown');
	await roleField.press('s');
	await roleField.press('Enter');
	await expect(roleField).toContainText(/Speaker Manager|Speaker Reviewer|Scheduler/);
	await expect(dialog).toBeVisible();
});
