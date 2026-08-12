import { expect, test, type Page } from '@playwright/test';

/**
 * Search on the submissions board.
 *
 * The behaviours under test are the ones a reader can be misled by: whether
 * typing acts without a gesture, whether the surface says what it searched, and
 * whether an empty result claims more than it looked at.
 */

const board = '/app/submissions';

async function open(page: Page, query = '') {
	await page.goto(query ? `${board}?search=${encodeURIComponent(query)}` : board);
	await expect(page.getByRole('table')).toBeVisible();
}

const field = (page: Page) => page.getByRole('searchbox', { name: 'Search submissions' });
const rows = (page: Page) => page.locator('tbody tr[class*="row"], tbody tr').filter({ has: page.locator('td') });

test.describe('submissions search', () => {
	test('narrows as you type, with no gesture and no history entry per word', async ({ page }) => {
		await open(page);
		const before = await page.evaluate(() => history.length);

		await field(page).fill('queueing');
		// Settled, not per-keystroke: the address catches up shortly after typing
		// stops rather than on blur or Enter.
		await expect(page).toHaveURL(/search=queueing/);
		await expect(page.getByText(/match/)).toBeVisible();

		// A filter pass is one act of reading. Eight characters must not become
		// eight destinations to press Back through.
		expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1);
	});

	test('Enter brings the pending write forward rather than submitting a form', async ({ page }) => {
		await open(page);
		await field(page).fill('queueing');
		await field(page).press('Enter');
		await expect(page).toHaveURL(/search=queueing/);
		// A form submit would have left the SPA route.
		await expect(page.getByRole('table')).toBeVisible();
	});

	test('says how many matched, of how many it examined, and which fields it read', async ({
		page
	}) => {
		await open(page, 'queueing');
		const status = page.locator('p.found');
		await expect(status).toBeVisible();
		await expect(status).toHaveAttribute('role', 'status');
		// Whitespace-tolerant throughout: the rendered text carries the template's
		// own newlines and tabs, which the browser collapses but textContent keeps.
		await expect(status).toContainText(/\d+\s+of\s+\d+\s+submissions?\s+match/);
		await expect(status).toContainText('“queueing”');
		await expect(status).toContainText('searched title, abstract, and speaker');
	});

	test('marks the matched span inside the row that carries it', async ({ page }) => {
		await open(page, 'queueing');
		const marks = page.locator('tbody mark.ui-marked');
		await expect(marks.first()).toBeVisible();
		await expect(marks.first()).toHaveText(/queueing/i);
	});

	// The regression the fold map exists for. Typing plain ASCII must reach a
	// name spelled with a letter NFKD cannot decompose.
	test('finds a name spelled with a letter that does not decompose', async ({ page }) => {
		await open(page, 'aydin');
		await expect(page.locator('p.found')).toContainText(/1\s+of\s+\d+\s+submission/);
		await expect(page.getByText('Hands-on: AI Interface Audits That Stick')).toBeVisible();
		// And the mark lands on the source spelling, not on a folded copy.
		await expect(page.locator('tbody mark.ui-marked').first()).toHaveText('Aydın');
	});

	// A marked title sits inside `.ui-table__primary`, which is a grid. Without a
	// single wrapping box each segment becomes its own grid row, and one title
	// renders as three stacked lines; inside a flex row it spreads them with the
	// container's gap instead. How many segments the match produced must never
	// be visible in the layout.
	test('a marked title hugs the matched word instead of stretching', async ({ page }) => {
		await open(page, 'hands');
		const title = page.locator('tbody .ui-table__primary').first();
		const mark = title.locator('mark.ui-marked');
		await expect(mark).toHaveCount(1);

		// Viewport-independent: on a narrow screen the title itself may wrap, which
		// is fine. What must never happen is the mark becoming a grid or flex item
		// and taking the full column width.
		const markBox = (await mark.boundingBox())!;
		const titleBox = (await title.boundingBox())!;
		expect(markBox.width).toBeLessThan(titleBox.width * 0.6);

		const line = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 24);
		expect(markBox.height).toBeLessThan(line * 1.6);
	});

	test('matches the abstract, and shows where it hit', async ({ page }) => {
		await open(page);
		await field(page).fill('queueing');
		await expect(page.locator('p.found')).toContainText(/match/);
	});

	test('an empty result names the query and the corpus instead of claiming absence', async ({
		page
	}) => {
		await open(page, 'zzzznotathing');
		const empty = page.locator('.empty');
		await expect(empty).toContainText('zzzznotathing');
		await expect(empty).toContainText('Searched title, abstract, and speaker');
		await expect(empty).toContainText(/across\s+\d+\s+submissions?\s+in\s+Inbox/);
	});

	// Typing is not a scope change. A person picking rows and then narrowing to
	// find the next one must keep the picks they already made.
	test('keeps a selection across a search that still holds the picked row', async ({ page }) => {
		await open(page, 'queueing');
		const pick = page.locator('tbody input[type="checkbox"]').first();
		await pick.check();
		await expect(pick).toBeChecked();

		// Extend the query so the same row still matches.
		await field(page).fill('queueing confession');
		await expect(page).toHaveURL(/search=queueing\+confession/);
		await expect(page.locator('tbody input[type="checkbox"]').first()).toBeChecked();
	});

	test('releases a pick whose row the new result set no longer holds', async ({ page }) => {
		await open(page, 'queueing');
		await page.locator('tbody input[type="checkbox"]').first().check();
		await field(page).fill('zzzznotathing');
		await expect(page.locator('.empty')).toBeVisible();
		await field(page).fill('queueing');
		await expect(page.locator('tbody input[type="checkbox"]').first()).not.toBeChecked();
	});

	test('a cleared search leaves a clean address and restores the tray', async ({ page }) => {
		await open(page, 'queueing');
		const matched = await rows(page).count();
		await field(page).fill('');
		await expect(page).not.toHaveURL(/search=/);
		await expect(page.locator('p.found')).toHaveCount(0);
		expect(await rows(page).count()).toBeGreaterThan(matched);
	});

	test('the query in the address survives a reload', async ({ page }) => {
		await open(page, 'queueing');
		await page.reload();
		await expect(field(page)).toHaveValue('queueing');
		await expect(page.locator('p.found')).toContainText('“queueing”');
	});
});
