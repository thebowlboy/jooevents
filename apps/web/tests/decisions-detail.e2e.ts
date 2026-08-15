import { expect, test } from '@playwright/test';

/**
 * The decision table's row expansion: the same submission detail the queue
 * shows, plus the committed reviews behind the row's average — so deciding
 * never requires leaving the pass down the table to learn what was said.
 */

test.describe('decisions row expansion', () => {
	test('a row opens to the submission and every committed review', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the disclosure contract');

		await page.goto('/app/decisions');

		const expander = page.getByRole('button', {
			name: /Details for .*Deterministic Replay/
		});
		await expect(expander).toBeVisible({ timeout: 15000 });
		await expect(expander).toHaveAttribute('aria-expanded', 'false');
		await expander.click();
		await expect(expander).toHaveAttribute('aria-expanded', 'true');

		const detail = page.locator('.detail-row');
		await expect(detail).toBeVisible();
		// Every value carries its label, and the field order follows the list's
		// own columns: who submitted it, its track, what review says, where the
		// decision stands — then the long-form blocks that have no column.
		for (const label of ['Speaker', 'Track', 'Reviews', 'Decision', 'Abstract']) {
			await expect(detail.getByText(label, { exact: true })).toBeVisible();
		}

		// The reviews arrive with words, scores, and identity as plan-local
		// labels — the caller's own committed review is the one named exception.
		await expect(detail.getByText('Committed reviews', { exact: true })).toBeVisible();
		await expect(detail.getByText('You', { exact: true })).toBeVisible();
		await expect(
			detail.getByText(
				'Best infrastructure submission this year. Ask for the replay tooling link in the speaker pack.'
			)
		).toBeVisible();
		await expect(detail.getByText(/^Reviewer [A-Z]$/)).toHaveCount(4);

		// Only a committed review of my own can anchor the line-up. Comparing is
		// part of this decision pass, so it opens over the row instead of taking
		// the organizer away from the table; its scope remains addressable.
		const lineup = detail.getByRole('button', { name: 'Line up with my other reviews' });
		await lineup.click();
		await expect(page).toHaveURL(/\/app\/decisions\?lineup=sub-301$/);
		const dialog = page.getByRole('dialog', { name: /Line-up:.*Deterministic Replay/ });
		await expect(dialog).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Candidates' })).toBeVisible();

		// Escape restores the same expanded decision row and the control that
		// opened the comparison, so the primary pass resumes exactly in place.
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page).toHaveURL('/app/decisions');
		await expect(detail).toBeVisible();
		await expect(lineup).toBeFocused();

		// Pressing the row's own controls belongs to them, never to the expansion.
		await expander.click();
		await expect(detail).toHaveCount(0);
	});

	test('a row without my committed review shows labeled peers and no line-up door', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the labeling contract');

		await page.goto('/app/decisions');

		const expander = page.getByRole('button', {
			name: /Details for .*Durable Agent Jobs/
		});
		await expect(expander).toBeVisible({ timeout: 15000 });
		await expander.click();

		const detail = page.locator('.detail-row');
		await expect(detail.getByText('Committed reviews', { exact: true })).toBeVisible();
		// Five committed reviews behind a 4.6 average of 5 — the list and the
		// cell above it tell one story.
		await expect(detail.getByText(/^Reviewer [A-Z]$/)).toHaveCount(5);
		await expect(detail.getByText('You', { exact: true })).toHaveCount(0);
		await expect(detail.getByRole('button', { name: 'Line up with my other reviews' })).toHaveCount(0);
	});

	test('the phone line-up closes back to the open detail sheet', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'the stacked-dialog contract is phone-specific');

		await page.goto('/app/decisions');
		const expander = page.getByRole('button', {
			name: /Details for .*Deterministic Replay/
		});
		await expect(expander).toBeVisible({ timeout: 15000 });
		await expander.click();

		const sheet = page.locator('dialog.ui-sheet');
		await expect(sheet).toBeVisible();
		const lineup = sheet.getByRole('button', { name: 'Line up with my other reviews' });
		await lineup.click();

		const comparison = page.getByRole('dialog', { name: /Line-up:.*Deterministic Replay/ });
		await expect(comparison).toBeVisible();
		await expect(page).toHaveURL(/\/app\/decisions\?lineup=sub-301$/);
		await expect(page.locator('dialog[open]')).toHaveCount(2);

		await page.keyboard.press('Escape');
		await expect(comparison).toBeHidden();
		await expect(sheet).toBeVisible();
		await expect(lineup).toBeFocused();
		await expect(page).toHaveURL('/app/decisions');
	});

	test('?submission= lands on that candidate row, open and marked', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the arrival contract');

		await page.goto('/app/decisions?submission=sub-301');

		const expander = page.getByRole('button', {
			name: /Details for .*Deterministic Replay/
		});
		await expect(expander).toBeVisible({ timeout: 15000 });
		await expect(expander).toHaveAttribute('aria-expanded', 'true');
		await expect(
			page.locator('.detail-row').getByText('Abstract', { exact: true })
		).toBeVisible();

		// Opening a different row is the operator's own move, so the scope leaves
		// the address rather than re-asserting the link's arrival on reload.
		await page.getByRole('button', { name: /Details for .*Durable Agent Jobs/ }).click();
		await expect(page).toHaveURL('/app/decisions');
	});
});
