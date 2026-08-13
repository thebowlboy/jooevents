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
			name: /Details for .*Durable Agent Jobs/
		});
		await expect(expander).toBeVisible({ timeout: 15000 });
		await expect(expander).toHaveAttribute('aria-expanded', 'false');
		await expander.click();
		await expect(expander).toHaveAttribute('aria-expanded', 'true');

		const detail = page.locator('.detail-row');
		await expect(detail).toBeVisible();
		await expect(detail.getByRole('heading', { name: 'Abstract' })).toBeVisible();

		// The reviews arrive with words, scores, and identity as plan-local
		// labels — the caller's own committed review is the one named exception.
		await expect(detail.getByRole('heading', { name: 'Reviews' })).toBeVisible();
		await expect(detail.getByText('You', { exact: true })).toBeVisible();
		await expect(
			detail.getByText('Strong war story; verify the outbox section fits 30 minutes.')
		).toBeVisible();
		await expect(detail.getByText(/^Reviewer [A-Z]$/)).toHaveCount(1);

		// Only a committed review of my own can anchor the line-up, so this row
		// carries the door and it points at the scoped comparison.
		const lineup = detail.getByRole('link', { name: 'Line up with my other reviews' });
		await expect(lineup).toHaveAttribute('href', '/app/review/lineup?anchor=sub-104&slice=track');

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
			name: /Details for .*Context Caching Without Tears/
		});
		await expect(expander).toBeVisible({ timeout: 15000 });
		await expander.click();

		const detail = page.locator('.detail-row');
		await expect(detail.getByRole('heading', { name: 'Reviews' })).toBeVisible();
		// Three committed reviews behind a 4.6 average of 3 — the list and the
		// cell above it tell one story.
		await expect(detail.getByText(/^Reviewer [A-Z]$/)).toHaveCount(3);
		await expect(detail.getByText('You', { exact: true })).toHaveCount(0);
		await expect(detail.getByRole('link', { name: 'Line up with my other reviews' })).toHaveCount(0);
	});

	test('?submission= lands on that candidate row, open and marked', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the arrival contract');

		await page.goto('/app/decisions?submission=sub-101');

		const expander = page.getByRole('button', {
			name: /Details for .*Context Caching Without Tears/
		});
		await expect(expander).toBeVisible({ timeout: 15000 });
		await expect(expander).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('.detail-row').getByRole('heading', { name: 'Abstract' })).toBeVisible();

		// Opening a different row is the operator's own move, so the scope leaves
		// the address rather than re-asserting the link's arrival on reload.
		await page.getByRole('button', { name: /Details for .*Durable Agent Jobs/ }).click();
		await expect(page).toHaveURL('/app/decisions');
	});
});
