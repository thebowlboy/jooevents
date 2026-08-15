import { expect, test } from '@playwright/test';

// A slowed sample transport makes the pending-tier treatments assertable; at the
// default latency they resolve inside the grace tier and deliberately leave no
// trace.
test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ context, baseURL }) => {
	const url = baseURL ?? 'http://127.0.0.1:4173';
	// Paged residency keeps every list read on the transport. Under the default
	// resident mode a tray or filter switch answers locally from the held scope
	// and resolves inside the grace tier, which correctly leaves no treatment to
	// assert — these tests pin the mode where the timing contract is reachable.
	await context.addCookies([
		{ name: 'je-latency', value: '800', url },
		{ name: 'je-residency', value: 'paged', url }
	]);
});

test('a reload dims the rows in place instead of blanking to skeletons', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport is enough for the timing contract');

	await page.goto('/app/submissions');
	const wrap = page.locator('.ui-table-wrap');
	await expect(page.getByRole('table')).toContainText('Deterministic Replay for Agent Failures', { timeout: 10000 });

	await page
		.getByRole('radiogroup', { name: 'Submission trays' })
		.getByText('Set aside', { exact: true })
		.click();

	// While the set-aside tray loads, the inbox rows stay mounted and dimmed.
	await expect(wrap).toHaveClass(/is-refreshing/);
	await expect(page.getByRole('table')).toContainText('Deterministic Replay for Agent Failures');
	await expect(wrap.locator('.ui-skeleton')).toHaveCount(0);

	// Resolution swaps content and releases the treatment.
	await expect(page.getByRole('table')).toContainText('Scale Your Dev Team With Our AI Copilot', { timeout: 10000 });
	await expect(wrap).not.toHaveClass(/is-refreshing/);
});

test('a decision dims only its own row while the rest of the table stays live', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport is enough for the timing contract');

	await page.goto('/app/decisions');
	const wrap = page.locator('.table-region .ui-table-wrap');
	await expect(wrap.getByRole('table')).toContainText('Deterministic Replay for Agent Failures', { timeout: 15000 });

	const row = page.getByRole('row', { name: /Deterministic Replay for Agent Failures/ });
	const other = page.getByRole('row', { name: /Type Systems for Tool-Calling Agents/ });
	await row.getByRole('button', { name: 'Accept' }).click();

	// The committed row dims and goes inert; the whole-surface reload treatment
	// never fires for a single row's commit, and other rows stay actionable.
	await expect(row).toHaveClass(/is-deciding/);
	await expect(wrap).not.toHaveClass(/is-refreshing/);
	await expect(other.getByRole('button', { name: 'Accept' })).toBeEnabled();

	// Resolution releases the row with the decision applied.
	await expect(row.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true', {
		timeout: 10000
	});
	await expect(row).not.toHaveClass(/is-deciding/);
});

test('decision skeletons hold the exact geometry of what they stand in for', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'reference-viewport geometry contract');

	await page.goto('/app/decisions');
	const measure = () =>
		page.evaluate(() => ({
			banner: document.querySelector('.banner')?.getBoundingClientRect().height ?? 0,
			note: document.querySelector('.head__note')?.getBoundingClientRect().height ?? 0,
			// The first resolved tr is a station group header now; the skeleton
			// stands in for data rows, so measure the first of those.
			row: document.querySelector('tbody tr:not(.station)')?.getBoundingClientRect().height ?? 0,
			tableTop: document.querySelector('.ui-table-wrap')?.getBoundingClientRect().y ?? 0
		}));

	await page.locator('.banner .skeleton-line').first().waitFor({ timeout: 10000 });
	const skeleton = await measure();
	expect(skeleton.banner).toBeGreaterThan(0);
	await expect(page.getByRole('table')).toContainText('Deterministic Replay for Agent Failures', { timeout: 15000 });
	const resolved = await measure();

	expect(Math.abs(resolved.banner - skeleton.banner)).toBeLessThanOrEqual(2);
	expect(Math.abs(resolved.note - skeleton.note)).toBeLessThanOrEqual(2);
	expect(Math.abs(resolved.row - skeleton.row)).toBeLessThanOrEqual(2);
	expect(Math.abs(resolved.tableTop - skeleton.tableTop)).toBeLessThanOrEqual(2);
});

test('the one waiting role select marks itself while its siblings merely disable', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport is enough for the timing contract');

	await page.goto('/app/settings/team');
	const selects = page.getByRole('combobox', { name: /^Role for / });
	await expect(selects.first()).toBeEnabled({ timeout: 10000 });

	await page.getByRole('combobox', { name: 'Role for Jonas Weber' }).selectOption('Scheduler');

	await expect(page.locator('.ui-select-wait__spinner')).toHaveCount(1);
	await expect(page.getByRole('combobox', { name: 'Role for Jonas Weber' })).toHaveAttribute('aria-busy', 'true');
	await expect(page.getByRole('combobox', { name: 'Role for Sofia Berg' })).toBeDisabled();

	await expect(page.locator('.ui-select-wait__spinner')).toHaveCount(0, { timeout: 10000 });
	await expect(page.getByRole('combobox', { name: 'Role for Jonas Weber' })).toHaveValue('Scheduler');
});
