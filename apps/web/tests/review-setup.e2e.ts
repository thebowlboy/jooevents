import { expect, test } from '@playwright/test';

/**
 * Review setup is one path: open the round, and every submission in the inbox
 * goes to each reviewer whose scope covers it. The intent-first draft-a-plan
 * entry is a later, AI-assisted layer and offers no button today.
 */

test.use({
	storageState: {
		cookies: [
			{
				name: 'je-scenario',
				value: 'opening',
				domain: '127.0.0.1',
				path: '/',
				expires: -1,
				httpOnly: false,
				secure: false,
				sameSite: 'Lax'
			}
		],
		origins: []
	}
});

test('the no-round panel offers exactly one path and opening the round is real', async ({ page }) => {
	await page.goto('/app/review');

	// One path, stated plainly — the old two-button fork is gone.
	await expect(page.getByRole('heading', { name: 'No review round yet' })).toBeVisible({
		timeout: 15000
	});
	await expect(page.getByRole('button', { name: 'Describe your review process' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Configure manually' })).toHaveCount(0);
	await expect(page.getByText('1 reviewer ready · 9 submissions in the inbox')).toBeVisible();

	// The dialog states the hand-out as rows: Jonas is a generalist, so he
	// carries all nine; Priya has not accepted and is named as absent.
	await page.getByRole('button', { name: 'Open the review round' }).click();
	const dialog = page.getByRole('dialog', { name: 'Open the review round' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Jonas Weber');
	await expect(dialog).toContainText('9 submissions');
	await expect(dialog).toContainText('1 invited reviewer has not accepted yet');
	await expect(dialog).toContainText('Scores are 1–5 with anchored meanings');

	// Opening is the deliberate step, labelled by its consequence.
	await dialog.getByRole('button', { name: 'Open round 1 · 9 reviews' }).click();

	// The round takes over: header, meter at zero, and the roster with the
	// hand-out it promised.
	await expect(page.getByRole('heading', { name: 'Round 1 · all tracks' })).toBeVisible();
	await expect(page.getByText('0 of 9')).toBeVisible();
	const reviewers = page.getByRole('table').filter({ hasText: 'Reviewer' });
	await expect(reviewers).toContainText('Jonas Weber');
	await expect(reviewers).toContainText('0 / 9');

	// The organizer opened it without reviewing in it, and the queue says so.
	await expect(page.getByText('You are running this round rather than reviewing in it.')).toBeVisible();

	// The receipt records the act and takes it back cleanly while nothing has
	// been committed.
	await expect(page.getByText('Opened round 1 — 9 reviews across 1 reviewer')).toBeVisible();
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByRole('heading', { name: 'No review round yet' })).toBeVisible();
});

test('a reviewer with no round sees what is true for them and no setup controls', async ({ page, context }) => {
	await context.addCookies([
		{ name: 'je-viewer', value: 'reviewer', domain: '127.0.0.1', path: '/' }
	]);
	await page.goto('/app/review');

	await expect(page.getByRole('heading', { name: 'No review round yet' })).toBeVisible({
		timeout: 15000
	});
	await expect(page.getByText('Nothing is assigned to you.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open the review round' })).toHaveCount(0);
});
