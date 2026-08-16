import { expect, test } from '@playwright/test';

/**
 * The task matrix's open-cell geometry. The measured defect: the speaker cell
 * was `display: grid`, which broke it out of the table-cell model — its bottom
 * border painted at its own content's height, so the moment an opened task
 * cell grew the row, the separator stranded mid-row under the name.
 */

test('an opened task cell grows the whole row, separator included', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the matrix is the desktop composition');

	await page.goto('/app/tasks');
	const row = page.locator('tbody tr').filter({ hasText: 'Lukas Brandt' });
	await expect(row).toBeVisible({ timeout: 15000 });

	const speakerCell = row.locator('.matrix__speaker-cell');
	const closedRow = await row.boundingBox();

	await row.getByRole('button', { name: /^Overdue — Headshot upload/ }).click();
	await expect(row.getByRole('button', { name: /Mark waived/ })).toBeVisible();

	const openRow = await row.boundingBox();
	const cellBox = await speakerCell.boundingBox();
	expect(openRow && closedRow && openRow.height > closedRow.height).toBe(true);
	// The speaker cell spans the grown row: its box — and with it the border it
	// paints — ends where the row ends, not where its own text does.
	expect(openRow && cellBox && Math.abs(cellBox.height - openRow.height) < 2).toBe(true);
});
