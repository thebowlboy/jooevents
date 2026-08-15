import { expect, test } from '@playwright/test';

/**
 * Who owns a press inside a submission row.
 *
 * The row is the pointer's door to the detail, so the dead space between the
 * controls stops being a dead zone. Everything that can be pressed on its own
 * still wins: a checkbox selects, a signal disclosure explains, the chevron
 * toggles. And the accessible tree is unchanged by all of it — the chevron
 * remains the single control carrying `aria-expanded`, with no competing role
 * or tab stop on the row itself.
 */

test.describe('a submission row as a press target', () => {
	test('a track keeps the same canonical pill when its record opens', async ({ page }) => {
		await page.goto('/app/submissions');
		const row = page.locator('tr.row').filter({ has: page.locator('.ui-track') }).first();
		await expect(row).toBeVisible({ timeout: 15000 });

		const rowChip = row.locator('.ui-track');
		const label = (await rowChip.innerText()).trim();
		const rowClass = await rowChip.getAttribute('class');
		const rowFill = await rowChip.evaluate((element) => getComputedStyle(element).backgroundColor);

		await row.getByRole('button', { name: /^Details for/ }).click();
		// Desktop renders inline; the phone promotes the same content into a
		// native dialog. The host is the stable semantic seam across both.
		const detail = page.locator('.ui-detail-host').last();
		await expect(detail).toBeVisible();
		const trackField = detail
			.locator('.ui-detail__field')
			.filter({ has: page.getByText('Track', { exact: true }) });
		const detailChip = trackField.locator('.ui-track');

		await expect(detailChip).toHaveText(label);
		expect(await detailChip.getAttribute('class')).toBe(rowClass);
		expect(await detailChip.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
			rowFill
		);
	});

	test('dead space in the row opens the detail, and opens it again shut', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the pointer-target contract');

		await page.goto('/app/submissions');
		const row = page.getByRole('row', { name: /Type Systems for Tool-Calling Agents/ });
		await expect(row).toBeVisible({ timeout: 15000 });

		const chevron = row.getByRole('button', { name: /^Details for/ });
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');

		// This row carries no signals, so its signals cell is exactly the empty
		// space the chevron used to be the only way out of.
		await row.getByRole('cell').nth(2).click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'true');
		await expect(
			page.getByText('Where type systems help tool-calling agents, where schemas become ceremony')
		).toBeVisible();

		// The same door swings both ways.
		await row.getByRole('cell').nth(2).click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
	});

	test('the row gains no role and no tab stop of its own', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the accessible-tree contract');

		await page.goto('/app/submissions');
		const row = page.getByRole('row', { name: /Type Systems for Tool-Calling Agents/ });
		await expect(row).toBeVisible({ timeout: 15000 });

		// A bigger target for the pointer is not a second switch for anyone else:
		// the row stays a row, and the chevron stays the one thing that says open.
		// `role="row"` is the table's own semantics restated — redundant while the
		// table is a table, and load-bearing the moment the record re-composes.
		expect(await row.getAttribute('tabindex')).toBeNull();
		expect(['row', null]).toContain(await row.getAttribute('role'));
		await expect(row.getByRole('button', { name: /^Details for/ })).toHaveCount(1);
	});

	test('a control inside the row wins the press and leaves the row shut', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the pointer-target contract');

		await page.goto('/app/submissions');
		const row = page.getByRole('row', { name: /Deterministic Replay for Agent Failures/ });
		await expect(row).toBeVisible({ timeout: 15000 });

		const chevron = row.getByRole('button', { name: /^Details for/ });
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');

		// The signal chip is a disclosure of its own; pressing it reveals its
		// reason and must not also drag the whole detail open underneath it.
		const chip = row.getByRole('button', { name: /^On-topic 0\.95 — why this signal/ });
		await chip.click();
		const panelId = await chip.getAttribute('aria-controls');
		await expect(page.locator(`#${panelId}`)).toBeVisible();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
		await page.keyboard.press('Escape');

		// So does the checkbox: selecting a row is not opening it.
		const box = row.getByRole('checkbox');
		await box.click();
		await expect(box).toBeChecked();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
		await box.click();
		await expect(box).not.toBeChecked();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
	});

	test('the chevron is still the switch, and it still says which state it is in', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the disclosure contract');

		await page.goto('/app/submissions');
		const row = page.getByRole('row', { name: /Deterministic Replay for Agent Failures/ });
		await expect(row).toBeVisible({ timeout: 15000 });

		const chevron = row.getByRole('button', { name: /^Details for/ });
		await chevron.click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'true');
		// Every value in the detail carries its label; the abstract's is one of them.
		await expect(page.locator('.ui-detail').getByText('Abstract', { exact: true })).toBeVisible();

		// Pressing it a second time closes it once, not twice: the row underneath
		// the chevron does not get a turn at the same press.
		await chevron.click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
		await expect(page.locator('.ui-detail')).toHaveCount(0);

		// And the keyboard reaches the same switch, unchanged.
		await chevron.press('Enter');
		await expect(chevron).toHaveAttribute('aria-expanded', 'true');
		await expect(chevron).toBeFocused();
	});
});

test('a scored row quotes its average without a denominator beside it', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the figure contract');

	await page.goto('/app/submissions');
	const row = page.getByRole('row', { name: /Deterministic Replay for Agent Failures/ });
	await expect(row).toBeVisible({ timeout: 15000 });

	// “4.7 / 5” reads as a score out of five. The count belongs to the sentence
	// in the panel, which can say what it means.
	const cell = row.getByRole('cell').nth(3);
	const figure = cell.getByRole('button', { name: /standing details$/ });

	// Wait for the settled cell before reading it. The average renders twice: a
	// plain figure while the standings read is outstanding, then the mark once it
	// lands. Asserting without waiting tests whichever arrived first, which is a
	// race decided by machine load — and it was passing on the *pending* branch,
	// so the contract it claims to cover was never actually checked.
	await expect(figure).toBeVisible({ timeout: 15000 });

	// `useInnerText` because the mark's markup leaves whitespace around the
	// figure that `textContent` keeps and a regex will not forgive. What is under
	// test is that the cell says "4.7" and not "4.7 / 5"; the indentation of the
	// template is not part of that contract.
	await expect(cell).toHaveText(/^\d\.\d$/, { useInnerText: true, timeout: 15000 });
	await figure.click();
	const panelId = await figure.getAttribute('aria-controls');
	await expect(page.locator(`#${panelId}`)).toContainText(/average of \d+ reviews?/);
});
