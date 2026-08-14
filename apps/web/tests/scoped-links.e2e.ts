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
		.getByRole('region', { name: 'Act now' })
		.filter({ hasText: 'decisions not yet notified' });
	await expect(row).toBeVisible({ timeout: 15000 });

	// The scope in the sentence survives the click.
	await row.getByRole('link', { name: /Compose notifications/ }).click();
	await expect(page).toHaveURL(/\/app\/decisions\?scope=unnotified$/);

	// Data rows by class: the station group headers share the table's rows.
	const candidates = page.getByRole('region', { name: 'Candidates' });
	const rows = candidates.locator('tr.row');
	await expect(rows).toHaveCount(4, { timeout: 15000 });
	await expect(candidates).toContainText('Typed Tool Contracts Between Agents That Never Meet');
	// An already-notified decision is not part of the scope.
	await expect(candidates).not.toContainText('Opening Keynote: AI Engineering Beyond the Demo');

	// The destination names the filter it applied on the operator's behalf.
	const chip = page.getByText('Decided · not yet notified');
	await expect(chip).toBeVisible();

	// One press returns the whole list, and the address goes back to clean.
	await page.getByRole('button', { name: /Clear this filter/ }).click();
	await expect(page).toHaveURL(/\/app\/decisions$/);
	await expect(candidates).toContainText('Opening Keynote: AI Engineering Beyond the Demo');
	expect(await rows.count()).toBeGreaterThan(4);
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

	const chip = page.getByRole('button', { name: /On-topic 0\.95 — why this signal/ });
	await expect(chip).toBeVisible({ timeout: 15000 });
	await expect(chip).toHaveAttribute('aria-expanded', 'false');

	await chip.press('Enter');
	await expect(chip).toHaveAttribute('aria-expanded', 'true');
	const panelId = await chip.getAttribute('aria-controls');
	const panel = page.locator(`#${panelId}`);
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Named tooling, reproducible method, and two concrete failures');
	await expect(panel).toContainText('confidence 0.95');
	// The same words reach a screen reader through the surface's polite region.
	await expect(page.getByRole('status').filter({ hasText: 'Screen run #8' })).toBeAttached();

	await page.keyboard.press('Escape');
	await expect(chip).toHaveAttribute('aria-expanded', 'false');
	await expect(chip).toBeFocused();
});

test('a received task is accepted from its own cell and the receipt takes it back', async ({
	page,
	context,
	baseURL
}) => {
	// Only the mid-flight scenario seeds a received-but-unaccepted upload, so the
	// premise pins that scenario rather than borrowing a different cell state.
	await context.addCookies([
		{ name: 'je-scenario', value: 'flight', url: baseURL ?? 'http://127.0.0.1:4173' }
	]);
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

// Sample-composition expectation, mode-scoped on purpose: the destination it
// asserts is the sample task matrix. In the live workspace the Speakers page
// is mounted but Tasks stays the honest LiveUnavailable surface (no task
// system is mounted), so this link lands on the unavailable page there — the
// live roster's own behavior is covered in speakers.joined-live.ts, and this
// spec must not be ported into the joined suite as-is.
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

	await expect(page).toHaveURL(/\/app\/tasks\?speaker=spk-4&filter=overdue$/);
	await expect(page.getByText('Overdue · Elena Petrova')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: /Clear this filter/ }).click();
	await expect(page).toHaveURL(/\/app\/tasks$/);
	await expect(page.getByText('Overdue · Elena Petrova')).toHaveCount(0);
});

/**
 * Where the arrival mark lands. The rule this covers is that the mark belongs
 * to whatever a person reads as "the record" — which in a table is the row, not
 * the addressable block inside a cell that the surface happened to use to find
 * it. Both halves were silently wrong before: the roster ringed a name, and the
 * decisions table, whose anchor was already the row, drew nothing at all
 * because a row could not host the mark.
 *
 * Timing matters here. The mark is held for `ARRIVAL_MIN_MS` and then released
 * by the first press, key, wheel, or real pointer travel — so these assertions
 * must not touch the page before making them.
 */
test('a scoped link marks the whole row, not the name inside it', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/app/reviewers?reviewer=mem-10');

	const roster = page.getByRole('region', { name: 'Reviewer roster' });
	const marked = roster.locator('tr.ui-arrival--row');
	await expect(marked).toHaveCount(1, { timeout: 15000 });
	await expect(marked).toContainText('Elif Aydın');
	// The band is drawn on the cells, which is the only shape a row can take it in.
	await expect(marked.locator('td').first()).toHaveCSS('position', 'relative');
	// The anchor keeps the caret and the scroll; it does not keep the ring.
	await expect(roster.locator('[data-reviewer].ui-arrival')).toHaveCount(0);
});

test('the decisions table marks the row a ?submission= link names', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/app/decisions?submission=sub-301');

	const candidates = page.getByRole('region', { name: 'Candidates' });
	const marked = candidates.locator('tr.ui-arrival--row');
	await expect(marked).toHaveCount(1, { timeout: 15000 });
	await expect(marked).toContainText('Deterministic Replay for Agent Failures');
});

test('a marked arrival shows one indicator, not a focus ring beside the mark', async ({ page }) => {
	await page.setViewportSize({ width: 760, height: 900 });
	await page.goto('/app/reviewers?reviewer=mem-10');

	// Narrow renders cards, where the host is the card itself and the focus ring
	// would otherwise be drawn around the same box the mark already rings.
	const card = page.locator('li.card.ui-arrival');
	await expect(card).toHaveCount(1, { timeout: 15000 });
	await expect(card).toHaveCSS('box-shadow', 'none');
});
