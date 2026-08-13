import { expect, test, type Page } from '@playwright/test';

const panelOf = (page: Page) => page.getByRole('region', { name: 'Speaker fields' });

async function openSettings(page: Page) {
	await page.goto('/app/settings');
	const panel = panelOf(page);
	await expect(panel.getByRole('heading', { name: 'Speaker fields' })).toBeVisible({
		timeout: 15000
	});
	// The heading renders while the list is still a waiting shell; the rows have
	// arrived once the first label resolves.
	await expect(panel.locator('.frow__label').first()).toBeVisible({ timeout: 15000 });
	return panel;
}

/** The sidebar is static chrome at desktop width and a drawer on touch. */
async function reachNav(page: Page, projectName: string) {
	if (projectName !== 'mobile') return;
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
}

/**
 * Leaves settings and comes back through in-app navigation. The screen state
 * is discarded with the page, so whatever renders on return is what the
 * workspace actually committed — not what a component was still holding.
 */
async function leaveAndReturn(page: Page, projectName: string) {
	await reachNav(page, projectName);
	await page.locator('.side__link[href="/app/speakers"]').click();
	await expect(page.getByRole('heading', { level: 1, name: 'Speakers' })).toBeVisible({
		timeout: 15000
	});
	await reachNav(page, projectName);
	await page.locator('.side__link[href="/app/settings"]').click();
	await expect(panelOf(page).getByRole('heading', { name: 'Speaker fields' })).toBeVisible({
		timeout: 15000
	});
}

test('the registry renders grouped by the ladder, with kind chips and context marks', async ({
	page
}) => {
	const panel = await openSettings(page);

	await expect(panel).toContainText('Every form draws from this one list.');

	// Quiet group headings appear only where a group has fields, following the
	// rows' own order — the baseline has no "General" run, so no such heading.
	await expect(panel.locator('.fgroup__label')).toHaveText([
		'Identity',
		'Contact',
		'Links & social',
		'Talk',
		'Logistics',
		'Materials',
		'Consent'
	]);

	// A row carries its label, kind chip, and per-context marks; a context that
	// requires an answer says so on the mark itself.
	const name = panel.getByRole('listitem').filter({ hasText: 'Your name' });
	await expect(name.locator('.frow__kind')).toHaveText('text');
	const applyMark = name.getByRole('button', { name: 'Ask “Your name” on the application' });
	await expect(applyMark).toHaveAttribute('aria-pressed', 'true');
	await expect(applyMark).toContainText('*');
	await expect(
		name.getByRole('button', { name: 'Ask “Your name” on the speaker profile' })
	).toHaveAttribute('aria-pressed', 'true');

	// Declared but upload-disabled: a file field states the fact quietly.
	const headshot = panel.getByRole('listitem').filter({ hasText: 'Headshot' });
	await expect(headshot).toContainText('Uploads activate with media storage');

	// The section never widens the document; rows wrap instead.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('a new field lands where the advisor put it and the reason shows by the row', async ({
	page
}) => {
	const panel = await openSettings(page);

	await panel.getByLabel('Label', { exact: true }).fill('Arrival airport');
	await panel.getByRole('button', { name: 'Add field' }).click();

	const row = panel.getByRole('listitem').filter({ hasText: 'Arrival airport' });
	await expect(row).toBeVisible();
	// The advisor's one-sentence reason renders as a quiet note by the new row.
	await expect(row).toContainText('Placed with the other logistics questions');

	// "arrival" classifies as logistics: the row joined that run — after the
	// travel-date field, before the materials that follow — under an existing
	// heading, not a new one.
	const names = await panel.locator('.frow__label').allInnerTexts();
	const airport = names.indexOf('Arrival airport');
	expect(airport).toBeGreaterThan(names.indexOf('Arrival date'));
	expect(airport).toBeLessThan(names.indexOf('Headshot'));
	await expect(panel.locator('.fgroup__label')).toHaveCount(7);

	// The commit leaves a receipt whose undo compensates the add.
	const receipt = page.getByRole('status').filter({ hasText: 'Added field “Arrival airport”' });
	await expect(receipt).toBeVisible();
	await expect(receipt.getByRole('button', { name: 'Undo' })).toBeVisible();

	// The placement note is context for the arrival; the next action retires it.
	await row.getByRole('button', { name: 'Ask “Arrival airport” at onboarding' }).click();
	await expect(row).not.toContainText('Placed with the other logistics questions');
});

test('toggling where a field is asked commits and persists', async ({ page }, testInfo) => {
	const panel = await openSettings(page);

	const dietary = panel.getByRole('listitem').filter({ hasText: 'Dietary needs' });
	const applyMark = dietary.getByRole('button', { name: 'Ask “Dietary needs” on the application' });
	await expect(applyMark).toHaveAttribute('aria-pressed', 'false');
	await applyMark.click();
	await expect(applyMark).toHaveAttribute('aria-pressed', 'true');
	await expect(
		page.getByRole('status').filter({ hasText: 'Now asking “Dietary needs” on the application' }).first()
	).toBeVisible();

	const onboardMark = dietary.getByRole('button', { name: 'Ask “Dietary needs” at onboarding' });
	await expect(onboardMark).toHaveAttribute('aria-pressed', 'true');
	await onboardMark.click();
	await expect(onboardMark).toHaveAttribute('aria-pressed', 'false');

	await leaveAndReturn(page, testInfo.project.name);
	const returned = panelOf(page).getByRole('listitem').filter({ hasText: 'Dietary needs' });
	await expect(
		returned.getByRole('button', { name: 'Ask “Dietary needs” on the application' })
	).toHaveAttribute('aria-pressed', 'true');
	await expect(
		returned.getByRole('button', { name: 'Ask “Dietary needs” at onboarding' })
	).toHaveAttribute('aria-pressed', 'false');
});

test('the locked email field shows its lock and refuses removal with the reason', async ({
	page
}) => {
	const panel = await openSettings(page);

	const email = panel.getByRole('listitem').filter({ hasText: 'Email' });
	await expect(email.getByRole('img', { name: 'Locked' })).toBeVisible();

	// The control stays reachable and says it will not succeed; pressing it is
	// the question, and the refusal that comes back is the answer.
	const remove = email.getByRole('button', { name: 'Remove “Email”' });
	await expect(remove).toHaveAttribute('aria-disabled', 'true');
	await remove.click({ force: true });
	await expect(email).toContainText('cannot be removed from the application');
	await expect(email.locator('.frow__label')).toHaveText('Email');
});

test('the reorder handle owns the order — arrow keys move, and the order survives leaving and returning', async ({
	page
}, testInfo) => {
	const panel = await openSettings(page);

	const before = await panel.locator('.frow__label').allInnerTexts();
	const at = before.indexOf('Talk title');
	expect(at).toBeGreaterThan(-1);
	expect(before[at + 1]).toBe('Abstract');

	// The keyboard path is the drag's equal: one arrow press, one step.
	const grip = panel.getByRole('button', { name: 'Reorder “Talk title” — drag, or press the arrow keys' });
	await grip.focus();
	await grip.press('ArrowDown');
	await expect(panel.locator('.frow__label').nth(at)).toHaveText('Abstract');
	await expect(panel.locator('.frow__label').nth(at + 1)).toHaveText('Talk title');
	await expect(
		page.getByRole('status').filter({ hasText: 'Moved “Talk title” down' }).first()
	).toBeVisible();
	// Focus travels with the moved row.
	await expect(grip).toBeFocused();

	await leaveAndReturn(page, testInfo.project.name);
	const returned = panelOf(page).locator('.frow__label');
	await expect(returned.nth(at)).toHaveText('Abstract');
	await expect(returned.nth(at + 1)).toHaveText('Talk title');

	const gripBack = panelOf(page).getByRole('button', {
		name: 'Reorder “Talk title” — drag, or press the arrow keys'
	});
	await gripBack.focus();
	await gripBack.press('ArrowUp');
	await expect(returned.nth(at)).toHaveText('Talk title');
	await expect(returned.nth(at + 1)).toHaveText('Abstract');
});

test('a workspace without an event shows the start panel alone — no fields section', async ({
	page,
	context,
	baseURL
}) => {
	await context.addCookies([
		{ name: 'je-scenario', value: 'fresh', url: baseURL ?? 'http://127.0.0.1:4173' }
	]);

	await page.goto('/app/settings');
	await expect(page.getByRole('region', { name: 'No event yet' })).toBeVisible({ timeout: 15000 });
	await expect(panelOf(page)).toHaveCount(0);
});
