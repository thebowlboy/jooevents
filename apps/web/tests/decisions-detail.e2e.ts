import { expect, test } from '@playwright/test';

/**
 * The deciding room: the decision table's candidates opened one at a time
 * over the pass — the same submission detail the queue shows plus the
 * committed reviews behind the row's average, with the verdict beside the
 * evidence it judges and previous/next walking the table's own order. Deciding
 * never requires leaving the pass, and the pass never disappears under a
 * screen-tall insert.
 */

test.describe('the deciding room', () => {
	test('a candidate opens over the pass with its evidence, reviews, and verdicts', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the disclosure contract');

		await page.goto('/app/decisions');

		const door = page.getByRole('button', { name: /Open .*Deterministic Replay.* for deciding/ });
		await expect(door).toBeVisible({ timeout: 15000 });
		await expect(door).toHaveAttribute('aria-haspopup', 'dialog');
		await door.click();

		const room = page.getByRole('dialog', { name: /Deterministic Replay/ });
		await expect(room).toBeVisible();
		await expect(page).toHaveURL(/\/app\/decisions\?submission=sub-301$/);

		// Evidence first, the classification ledger after it — every value with
		// its label — and the verdict actions beside the evidence they judge.
		for (const label of ['Speaker', 'Abstract', 'Materials', 'Track', 'Reviews', 'Decision']) {
			await expect(room.getByText(label, { exact: true })).toBeVisible();
		}
		for (const verdict of ['Accept', 'Waitlist', 'Decline']) {
			await expect(room.getByRole('button', { name: verdict, exact: true })).toBeVisible();
		}

		// The reviews arrive with words, scores, and identity as plan-local
		// labels — the caller's own committed review is the one named exception.
		await expect(room.getByText('Committed reviews', { exact: true })).toBeVisible();
		await expect(room.getByText('You', { exact: true })).toBeVisible();
		await expect(
			room.getByText(
				'Best infrastructure submission this year. Ask for the replay tooling link in the speaker pack.'
			)
		).toBeVisible();
		await expect(room.getByText(/^Reviewer [A-Z]$/)).toHaveCount(4);

		// The traversal bar says where the pass stands.
		await expect(room.getByText(/Candidate 1 of \d+/)).toBeVisible();

		// Only a committed review of my own can anchor the line-up; it stacks
		// over the room, and Escape steps back out one surface at a time.
		const lineup = room.getByRole('button', { name: 'Line up with my other reviews' });
		await lineup.click();
		await expect(page).toHaveURL(/\?submission=sub-301&lineup=sub-301$/);
		const comparison = page.getByRole('dialog', { name: /Line-up:.*Deterministic Replay/ });
		await expect(comparison).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(comparison).toBeHidden();
		await expect(page).toHaveURL(/\?submission=sub-301$/);
		await expect(room).toBeVisible();
		await expect(lineup).toBeFocused();

		// Closing the room clears the address and hands the pass back.
		await page.keyboard.press('Escape');
		await expect(room).toBeHidden();
		await expect(page).toHaveURL('/app/decisions');
	});

	test('j walks the pass and a verdict advances it to the next undecided candidate', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'the keyed pass is a desktop contract');

		await page.goto('/app/decisions');
		await expect(
			page.getByRole('button', { name: /Open .*Deterministic Replay.* for deciding/ })
		).toBeVisible({ timeout: 15000 });

		// From the table, j starts the pass on the first candidate still waiting.
		await page.keyboard.press('j');
		const first = page.getByRole('dialog', { name: /Deterministic Replay/ });
		await expect(first).toBeVisible();

		// Walking is one act of reading: the address follows without stacking a
		// history entry per step.
		const before = await page.evaluate(() => history.length);
		await page.keyboard.press('j');
		await expect(page.getByRole('dialog', { name: /Type Systems/ })).toBeVisible();
		await page.keyboard.press('k');
		await expect(first).toBeVisible();
		expect(await page.evaluate(() => history.length)).toBe(before);

		// A verdict is the same receipted move the row makes — and the room
		// advances to the candidate now standing where this one stood.
		await page.keyboard.press('a');
		await expect(page.getByRole('dialog', { name: /Type Systems/ })).toBeVisible({
			timeout: 10000
		});
		await expect(
			page.getByRole('status').filter({ hasText: 'Accepted “Deterministic Replay' })
		).toBeVisible();

		// The pass visibly shrank while the room stayed open.
		await expect(page.getByRole('dialog').getByText(/8 still to decide/)).toBeVisible();
	});

	test('a candidate without my committed review shows labeled peers and no line-up door', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the labeling contract');

		await page.goto('/app/decisions');

		const door = page.getByRole('button', { name: /Open .*Durable Agent Jobs.* for deciding/ });
		await expect(door).toBeVisible({ timeout: 15000 });
		await door.click();

		const room = page.getByRole('dialog', { name: /Durable Agent Jobs/ });
		await expect(room.getByText('Committed reviews', { exact: true })).toBeVisible();
		// Five committed reviews behind a 4.6 average of 5 — the list and the
		// cell above it tell one story.
		await expect(room.getByText(/^Reviewer [A-Z]$/)).toHaveCount(5);
		await expect(room.getByText('You', { exact: true })).toHaveCount(0);
		await expect(room.getByRole('button', { name: 'Line up with my other reviews' })).toHaveCount(0);
	});

	test('the phone line-up closes back to the open room', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'the stacked-dialog contract is phone-specific');

		await page.goto('/app/decisions');
		const door = page.getByRole('button', { name: /Open .*Deterministic Replay.* for deciding/ });
		await expect(door).toBeVisible({ timeout: 15000 });
		await door.click();

		const room = page.getByRole('dialog', { name: /Deterministic Replay for Agent Failures/ });
		await expect(room).toBeVisible();
		const lineup = room.getByRole('button', { name: 'Line up with my other reviews' });
		await lineup.click();

		const comparison = page.getByRole('dialog', { name: /Line-up:.*Deterministic Replay/ });
		await expect(comparison).toBeVisible();
		await expect(page).toHaveURL(/\?submission=sub-301&lineup=sub-301$/);
		await expect(page.locator('dialog[open]')).toHaveCount(2);

		await page.keyboard.press('Escape');
		await expect(comparison).toBeHidden();
		await expect(room).toBeVisible();
		await expect(lineup).toBeFocused();
		await expect(page).toHaveURL(/\?submission=sub-301$/);
	});

	test('?submission= opens the room on that candidate, and closing reveals its row', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the arrival contract');

		await page.goto('/app/decisions?submission=sub-301');

		const room = page.getByRole('dialog', { name: /Deterministic Replay/ });
		await expect(room).toBeVisible({ timeout: 15000 });
		await expect(room.getByText('Abstract', { exact: true })).toBeVisible();

		// Leaving the room leaves a clean address, with the candidate's row on
		// screen where the pass resumes.
		await page.keyboard.press('Escape');
		await expect(room).toBeHidden();
		await expect(page).toHaveURL('/app/decisions');
		await expect(page.locator('[data-submission="sub-301"]')).toBeVisible();
	});
});
