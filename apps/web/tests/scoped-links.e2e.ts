import { expect, test } from '@playwright/test';

/**
 * The orientation grammar, end to end: a fact carries its scope to the rows it
 * names, the destination says which scope it is showing, and one press returns
 * the full list. The address is the carrier throughout, so every step here is
 * also an assertion that filter state is restorable.
 */

test('an attention row lands on its own rows, says so, and gives them all back', async ({ page }) => {
	await page.goto('/app');

	const row = page
		.getByRole('listitem')
		.filter({ hasText: 'accepted submissions not yet notified' });
	await expect(row).toBeVisible({ timeout: 15000 });

	// The scope in the sentence survives the click.
	await row.getByRole('link', { name: /Compose notifications/ }).click();
	await expect(page).toHaveURL(/\/app\/decisions\?scope=unnotified$/);

	const candidates = page.getByRole('region', { name: 'Candidates' });
	const rows = candidates.locator('tbody tr');
	await expect(rows).toHaveCount(3, { timeout: 15000 });
	await expect(candidates).toContainText('Typed Tool Contracts Between Agents That Never Meet');
	// An already-notified decision is not part of the scope.
	await expect(candidates).not.toContainText('Context Caching Without Tears');

	// The destination names the filter it applied on the operator's behalf.
	const chip = page.getByText('Decided · not yet notified');
	await expect(chip).toBeVisible();

	// One press returns the whole list, and the address goes back to clean.
	await page.getByRole('button', { name: /Clear this filter/ }).click();
	await expect(page).toHaveURL(/\/app\/decisions$/);
	await expect(candidates).toContainText('Context Caching Without Tears');
	expect(await rows.count()).toBeGreaterThan(3);
	await expect(page.getByText('Decided · not yet notified')).toHaveCount(0);
});

test('a submissions address restores the tray and the search it names', async ({ page }) => {
	await page.goto('/app/submissions?tray=discarded&search=Crypto');

	const discarded = page.getByRole('button', { name: /Discarded/ });
	await expect(discarded).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
	await expect(page.getByRole('searchbox', { name: 'Search submissions' })).toHaveValue('Crypto');

	const list = page.getByRole('region', { name: 'Submissions' });
	await expect(list.locator('tbody tr')).toHaveCount(1);
	await expect(list).toContainText('Crypto Wealth Secrets 2026');

	// Changing a filter is a change of address, so the view stays shareable.
	await page.getByRole('button', { name: /Inbox/ }).click();
	await expect(page).toHaveURL(/\/app\/submissions\?search=Crypto$/);
	// An empty result names the query it ran and the corpus it ran against,
	// rather than reporting an absence it never established.
	await expect(list).toContainText('No submission here matches');
	await expect(list).toContainText('Crypto');
	await expect(list).toContainText('Searched title, abstract, and speaker');
});

test('a signal chip explains itself from the keyboard, and Escape gives focus back', async ({ page }) => {
	await page.goto('/app/submissions');

	const chip = page.getByRole('button', { name: /On-topic 0\.94 — why this signal/ });
	await expect(chip).toBeVisible({ timeout: 15000 });
	await expect(chip).toHaveAttribute('aria-expanded', 'false');

	await chip.press('Enter');
	await expect(chip).toHaveAttribute('aria-expanded', 'true');
	const panelId = await chip.getAttribute('aria-controls');
	const panel = page.locator(`#${panelId}`);
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Abstract cites concrete production invalidation graphs');
	await expect(panel).toContainText('confidence 0.94');
	// The same words reach a screen reader through the surface's polite region.
	await expect(page.getByRole('status').filter({ hasText: 'Screen run #2' })).toBeAttached();

	await page.keyboard.press('Escape');
	await expect(chip).toHaveAttribute('aria-expanded', 'false');
	await expect(chip).toBeFocused();
});

test('a received task is accepted from its own cell and the receipt takes it back', async ({ page }) => {
	await page.goto('/app/tasks');

	const cell = page.getByRole('button', { name: /Received — Headshot upload from Ravi Chandran/ });
	await expect(cell).toBeVisible({ timeout: 15000 });

	// Press, confirm in place, commit.
	await cell.click();
	await page.getByRole('button', { name: 'Accept as complete' }).click();

	const receipt = page
		.getByRole('status')
		.filter({ hasText: 'Accepted “Headshot upload” from Ravi Chandran' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(cell).toHaveCount(0);

	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(
		page.getByRole('button', { name: /Received — Headshot upload from Ravi Chandran/ })
	).toBeVisible({ timeout: 10000 });
});

test('a speaker row opens the task matrix already scoped to that speaker', async ({ page }) => {
	await page.goto('/app/speakers');

	// One composition is on screen per width: the table at desktop, the cards on
	// touch. Both carry the same expansion, so the visible one is the subject.
	const roster = page.getByRole('region', { name: 'Speaker roster' });
	await expect(roster).toContainText('Elena Petrova', { timeout: 15000 });
	const disclosure = roster.getByRole('button', { name: 'Details for Elena Petrova' });
	await disclosure.click();

	// The expansion answers "which ones", and the rail answers "now deal with them".
	await expect(roster.getByText('AV requirements form').filter({ visible: true })).toBeVisible();
	await roster.getByRole('link', { name: 'Open in Tasks' }).click();

	await expect(page).toHaveURL(/\/app\/tasks\?speaker=spk-7&filter=overdue$/);
	await expect(page.getByText('Overdue · Elena Petrova')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: /Clear this filter/ }).click();
	await expect(page).toHaveURL(/\/app\/tasks$/);
	await expect(page.getByText('Overdue · Elena Petrova')).toHaveCount(0);
});
