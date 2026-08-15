import { expect, test, type Page, type TestInfo } from '@playwright/test';

const FROM = 'program@aie-demo.example';
/** U+202E, the right-to-left override a spoofed sender name hides behind. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);

const panel = (page: Page) => page.getByRole('region', { name: 'Email sender' });
const senderName = (page: Page) => page.getByLabel('Sender name');
const replyTo = (page: Page) => page.getByLabel('Reply-to address');
const preview = (page: Page) => page.getByRole('group', { name: 'Next message' });
const save = (page: Page) => panel(page).getByRole('button', { name: 'Save' });

async function open(page: Page) {
	await page.goto('/app/settings/email');
	await expect(save(page)).toBeVisible({ timeout: 15000 });
}

/**
 * In-app navigation, because a fresh document reload would restart the sample
 * transport and lose the very commit these tests are checking survived.
 */
async function visitSection(page: Page, label: string, testInfo: TestInfo) {
	if (testInfo.project.name === 'mobile') {
		await page.getByRole('button', { name: 'Open navigation' }).click();
		// The drawer takes focus when it has finished opening; its links are not
		// stable to click until then.
		await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
	}
	await page
		.getByRole('navigation', { name: 'Settings' })
		.getByRole('link', { name: label, exact: true })
		.click();
}

test('the from address is stated as installation configuration, not offered as a field', async ({
	page
}) => {
	await open(page);

	await expect(panel(page)).toContainText(FROM);
	// Two boxes exactly: the from address is a fact on this page, never a control.
	await expect(panel(page).getByRole('textbox')).toHaveCount(2);
	await expect(panel(page).getByText('Set once for this installation')).toBeVisible();
	await expect(panel(page).getByRole('button', { name: /SPF and DKIM/ })).toBeVisible();
	// Nothing is edited yet, so there is nothing to save.
	await expect(save(page)).toBeDisabled();
});

test('the preview follows the boxes, and a save is reflected on the next visit', async ({
	page
}, testInfo) => {
	await open(page);
	// The empty box's placeholder is the installation's own name, so the preview
	// is checked against it rather than against one scenario's wording.
	const installationName = await senderName(page).getAttribute('placeholder');
	expect(installationName).toBeTruthy();
	await expect(preview(page)).toContainText(`${installationName} <${FROM}>`);
	await expect(preview(page)).toContainText('Replies come back to the From address');

	await senderName(page).fill('Deep Dish Conf');
	await replyTo(page).fill('talks@deepdish.example');

	// Live, before anything is committed.
	await expect(preview(page)).toContainText(`Deep Dish Conf <${FROM}>`);
	await expect(preview(page)).toContainText('talks@deepdish.example');
	await expect(save(page)).toBeEnabled();

	await save(page).click();
	await expect(panel(page).getByText('Saved', { exact: true })).toBeVisible();
	await expect(save(page)).toBeDisabled();

	// Leave the section and come back: the values are the workspace's now.
	await visitSection(page, 'Team', testInfo);
	await expect(page.getByRole('region', { name: 'Team' })).toBeVisible({ timeout: 15000 });
	await visitSection(page, 'Email', testInfo);
	await expect(save(page)).toBeVisible({ timeout: 15000 });

	await expect(senderName(page)).toHaveValue('Deep Dish Conf');
	await expect(replyTo(page)).toHaveValue('talks@deepdish.example');
	await expect(preview(page)).toContainText(`Deep Dish Conf <${FROM}>`);
	await expect(save(page)).toBeDisabled();
});

test('a saved sender change is reverted by its receipt', async ({ page }) => {
	await open(page);
	const installationName = await senderName(page).getAttribute('placeholder');

	await senderName(page).fill('Deep Dish Conf');
	await save(page).click();
	await expect(panel(page).getByText('Saved', { exact: true })).toBeVisible();

	// The receipt names the object it acted on and offers the compensating save.
	await expect(page.getByText('Changed the workspace email sender')).toBeVisible();
	await page.getByRole('button', { name: 'Undo' }).click();

	await expect(senderName(page)).toHaveValue('');
	await expect(preview(page)).toContainText(`${installationName} <${FROM}>`);
	await expect(save(page)).toBeDisabled();
});

test('a reply-to carrying a second address is refused in words, on its own box', async ({
	page
}) => {
	await open(page);

	await replyTo(page).fill('talks@deepdish.example, spoof@evil.example');
	await save(page).click();

	await expect(
		panel(page).getByText('Enter one reply-to address on its own — no name, brackets, or list.')
	).toBeVisible();
	await expect(replyTo(page)).toHaveAttribute('aria-invalid', 'true');
	await expect(replyTo(page)).toBeFocused();
	// Refused, so nothing was committed and the value still differs from saved.
	await expect(save(page)).toBeEnabled();
	await expect(senderName(page)).toHaveValue('');
	await expect(panel(page)).not.toContainText('reply_to');
});

test('a sender name carrying an invisible direction mark is refused on its own box', async ({
	page
}) => {
	await open(page);

	await senderName(page).fill(`Deep${RTL_OVERRIDE}Dish`);
	await expect(save(page)).toBeEnabled();
	await save(page).click();

	await expect(
		panel(page).getByText('Sender names can’t contain invisible or text-direction characters.')
	).toBeVisible();
	await expect(senderName(page)).toHaveAttribute('aria-invalid', 'true');
	await expect(senderName(page)).toBeFocused();
	// The refusal names the value, never the check that produced it.
	await expect(panel(page)).not.toContainText('bidi');
	await expect(panel(page)).not.toContainText('policy_violation');
});

test('an invalid reply-to address reads as guidance rather than a code', async ({ page }) => {
	await open(page);

	await replyTo(page).fill('not-an-address');
	await save(page).click();

	await expect(panel(page).getByText('That isn’t a valid email address.')).toBeVisible();
	await expect(panel(page)).not.toContainText('reply_to');
});
