import { expect, test } from '@playwright/test';

/**
 * What a committed review is allowed to know, and what it is not.
 *
 * Committing is the event that earns peer content: before it, the card carries
 * the lock sentence and nothing about the crowd; after it, the same card gains
 * the standing group, the marks, and the way out to the rest of my own scoring.
 * Every claim on the way is a press-and-focus disclosure, so each step here is
 * also an assertion that no meaning is hover-only.
 */

const CRUNCH = 'crunch';

test.describe('the default round', () => {
	test('committing is what reveals standing; an open card carries the lock instead', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the reveal contract');

		await page.goto('/app/review');

		const committed = page
			.getByRole('listitem')
			.filter({ hasText: 'Durable Agent Jobs: A Queueing Confession' });
		await expect(committed).toBeVisible({ timeout: 15000 });
		await expect(committed.getByText('Standing in track')).toBeVisible();

		// The strip is the button: the exact claim behind it is one press away.
		const mark = committed.getByRole('button', { name: /standing details$/ });
		await expect(mark).toBeVisible({ timeout: 15000 });
		await expect(mark).toHaveAttribute('aria-expanded', 'false');
		await mark.click();

		const panelId = await mark.getAttribute('aria-controls');
		const panel = page.locator(`#${panelId}`);
		await expect(panel).toBeVisible();
		// The number a person quotes, what it is worth, and what it was read against.
		await expect(panel).toContainText('4.1 average of 2 reviews');
		await expect(panel).toContainText(/Higher than \d+% of \d+ scored/);
		await expect(panel).toContainText(/median \d+\.\d of \d+ scored/);
		await page.keyboard.press('Escape');
		await expect(mark).toHaveAttribute('aria-expanded', 'false');

		// An uncommitted review has no crowd to stand in, and the card says so
		// rather than showing an aggregate its own score has not paid for.
		const open = page
			.getByRole('listitem')
			.filter({ hasText: 'Hands-on: AI Interface Audits That Stick' });
		await expect(open.getByText('Peer reviews unlock when you commit your own.')).toBeVisible();
		await expect(open.getByText('Standing in track')).toHaveCount(0);
		await expect(open.getByRole('button', { name: /standing details/ })).toHaveCount(0);
	});

	test('each mark on the scale says which decision it is, and the thresholds are one press away', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the naming contract');

		await page.goto('/app/review');
		const card = page
			.getByRole('listitem')
			.filter({ hasText: 'Hands-on: AI Interface Audits That Stick' });
		await expect(card).toBeVisible({ timeout: 15000 });

		// The anchor word travels with the digit, so the control reaches speech
		// input and a screen reader by what the number means.
		for (const name of ['1 Pass', '2 Weak', '3 Solid', '4 Strong', '5 Must-have']) {
			await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
		}

		const guide = card.getByRole('button', { name: /^What the numbers mean/ });
		await expect(guide).toHaveAttribute('aria-expanded', 'false');
		await guide.click();
		await expect(guide).toHaveAttribute('aria-expanded', 'true');

		const panelId = await guide.getAttribute('aria-controls');
		const panel = page.locator(`#${panelId}`);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('1 Pass');
		await expect(panel).toContainText('You would trade another accepted talk to keep it.');

		// Escape closes and hands focus back to the mark that opened it.
		await page.keyboard.press('Escape');
		await expect(guide).toHaveAttribute('aria-expanded', 'false');
		await expect(guide).toBeFocused();
	});

	test('a scored row quotes its average and keeps the population behind it', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the evidence contract');

		await page.goto('/app/submissions');
		const row = page.getByRole('row', { name: /Durable Agent Jobs/ });
		await expect(row).toBeVisible({ timeout: 15000 });

		const figure = row.getByRole('button', { name: /standing details$/ });
		await expect(figure).toBeVisible({ timeout: 15000 });
		await figure.click();

		const panelId = await figure.getAttribute('aria-controls');
		const panel = page.locator(`#${panelId}`);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText(/median \d+\.\d of \d+ scored/);
		await expect(panel).toContainText('4.1 average of 2 reviews');
	});
});

test.describe('a shortlist round at scale', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		// The shortlist scenario is the one where several of my own reviews are
		// committed, so a line-up has something to line up.
		await context.addCookies([
			{ name: 'je-scenario', value: CRUNCH, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

	test('a committed review lines up over the queue, and both the line-up and its slice are the address', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'two-column composition contract');

		await page.goto('/app/review');
		const card = page.getByRole('listitem').filter({ hasText: 'Type Systems for Tool-Calling Agents' });
		await expect(card).toBeVisible({ timeout: 15000 });

		// Comparing is a closer look at the queue, not a departure from it: the
		// line-up opens over the queue and says so in the address.
		await card.getByRole('button', { name: 'Line up with my other reviews' }).click();
		await expect(page).toHaveURL(/\/app\/review\?lineup=sub-302$/);
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('Line-up: “Type Systems for Tool-Calling Agents”');

		// The reference stays put beside the field it is compared against; the
		// narrow summary bar it stands in for is retired at this width.
		const anchor = page.getByRole('region', { name: 'Anchor', exact: true });
		await expect(anchor).toContainText('Type Systems for Tool-Calling Agents', { timeout: 15000 });
		await expect(page.locator('.bar')).toBeHidden();
		const pinned = await page.evaluate(
			() => getComputedStyle(document.querySelector('.anchor') as Element).position
		);
		expect(pinned).toBe('sticky');

		const list = page.getByRole('region', { name: 'Reviews compared against the anchor' });
		await expect(list.getByRole('listitem')).toHaveCount(1, { timeout: 15000 });
		await expect(list).toContainText('Panel: When Should Models Run at the Edge?');

		// Widening the slice is a destination, not a toggle: it changes the address.
		await page
			.getByRole('group', { name: 'Comparison slice' })
			.getByRole('button', { name: 'All my reviews' })
			.click();
		await expect(page).toHaveURL(/\/app\/review\?lineup=sub-302&slice=all$/);
		await expect(list.getByRole('listitem')).toHaveCount(3, { timeout: 15000 });
		await expect(list).toContainText('Deterministic Replay for Agent Failures');

		// And Back is how the move is taken back, list included.
		await page.goBack();
		await expect(page).toHaveURL(/\/app\/review\?lineup=sub-302$/);
		await expect(list.getByRole('listitem')).toHaveCount(1, { timeout: 15000 });
		await expect(list).not.toContainText('Deterministic Replay for Agent Failures');

		// Once more, and the line-up itself is what Back takes back: the queue is
		// still there, exactly as it was left.
		await page.goBack();
		await expect(dialog).toBeHidden();
		await expect(page).toHaveURL(/\/app\/review$/);
		await expect(card).toBeVisible();

		// Escape is the same exit from the keyboard, and it leaves the same address.
		await card.getByRole('button', { name: 'Line up with my other reviews' }).click();
		await expect(dialog).toBeVisible();
		await expect(page).toHaveURL(/\/app\/review\?lineup=sub-302$/);
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page).toHaveURL(/\/app\/review$/);

		// So is a press outside it — a surface you were only looking at is left the
		// moment you stop looking.
		await card.getByRole('button', { name: 'Line up with my other reviews' }).click();
		await expect(dialog).toBeVisible();
		await page.mouse.click(8, 500);
		await expect(dialog).toBeHidden();
		await expect(page).toHaveURL(/\/app\/review$/);
	});

	test('the line-up keeps its own address for a direct link', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the addressability contract');

		// The route is what a scoped link points at, so it renders the same
		// comparison without the queue behind it.
		await page.goto('/app/review/lineup?anchor=sub-302&slice=all');
		await expect(page.getByRole('heading', { name: 'Line-up', exact: true })).toBeVisible();
		await expect(page.getByRole('region', { name: 'Anchor', exact: true })).toContainText(
			'Type Systems for Tool-Calling Agents',
			{ timeout: 15000 }
		);
		const list = page.getByRole('region', { name: 'Reviews compared against the anchor' });
		await expect(list.getByRole('listitem')).toHaveCount(3, { timeout: 15000 });
	});

	test('a revision names the score it replaced, and the receipt puts it back', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the receipt contract');

		await page.goto('/app/review?lineup=sub-302&slice=all');
		const list = page.getByRole('region', { name: 'Reviews compared against the anchor' });
		const card = list.getByRole('listitem').filter({ hasText: 'Panel: When Should Models Run at the Edge?' });
		await expect(card).toBeVisible({ timeout: 15000 });
		await expect(card.locator('.score__value')).toHaveText('4');

		await card.getByRole('button', { name: 'Revise score' }).click();
		await card.getByRole('group', { name: 'New score' }).getByRole('button', { name: '2', exact: true }).click();
		await card.getByRole('button', { name: 'Commit revision' }).click();

		// A changed score is only checkable beside the one it replaced.
		const receipt = page
			.getByRole('status')
			.filter({ hasText: 'Revised your review of “Panel: When Should Models Run at the Edge?”' });
		await expect(receipt).toBeVisible({ timeout: 10000 });
		await expect(receipt).toContainText('4 → 2');
		await expect(card.locator('.score__value')).toHaveText('2');
		await expect(card.getByText('Revised after reveal')).toBeVisible();

		await receipt.getByRole('button', { name: 'Undo' }).click();
		await expect(card.locator('.score__value')).toHaveText('4', { timeout: 10000 });
		await expect(card.getByText('Revised after reveal')).toHaveCount(0);
	});

	test('the anchor is settable where the comparison is, and the queue card carries the new score out', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the revise contract');

		await page.goto('/app/review?lineup=sub-302');
		const anchor = page.getByRole('region', { name: 'Anchor', exact: true });
		await expect(anchor).toContainText('Type Systems for Tool-Calling Agents', { timeout: 15000 });
		await expect(anchor.locator('.score__value')).toHaveText('4');

		// The review a person came to settle is settable with every comparison in
		// view, which is the only place the evidence for the change is.
		await anchor.getByRole('button', { name: 'Revise score' }).click();
		await anchor
			.getByRole('group', { name: 'New score' })
			.getByRole('button', { name: '2', exact: true })
			.click();
		await anchor.getByRole('button', { name: 'Commit revision' }).click();

		const receipt = page
			.getByRole('status')
			.filter({ hasText: 'Revised your review of “Type Systems for Tool-Calling Agents”' });
		await expect(receipt).toBeVisible({ timeout: 10000 });
		await expect(receipt).toContainText('4 → 2');
		await expect(anchor.locator('.score__value')).toHaveText('2');

		// Closing hands the queue card the score that was just settled.
		await page.getByRole('button', { name: 'Close dialog' }).click();
		await expect(page).toHaveURL(/\/app\/review$/);
		const queueCard = page
			.getByRole('listitem')
			.filter({ hasText: 'Type Systems for Tool-Calling Agents' });
		await expect(queueCard.locator('.verdict__score')).toHaveText('2');

		// And the receipt survives the close, so the undo is still the way back.
		const pageReceipt = page
			.getByRole('status')
			.filter({ hasText: 'Revised your review of “Type Systems for Tool-Calling Agents”' });
		await pageReceipt.getByRole('button', { name: 'Undo' }).click();
		await expect(queueCard.locator('.verdict__score')).toHaveText('4', { timeout: 10000 });
	});

	test('a spent mark keeps its place and says where all three went', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the refusal contract');

		await page.goto('/app/review');
		const card = page.getByRole('listitem').filter({ hasText: 'Panel: When Should Models Run at the Edge?' });
		await expect(card).toBeVisible({ timeout: 15000 });

		// The refusal is a state of the control that would have acted, and it stays
		// focusable so a keyboard can reach the reason.
		const spent = card.getByRole('button', { name: /^Top pick on .* — why this mark is unavailable/ });
		await expect(spent).toHaveAttribute('aria-disabled', 'true', { timeout: 15000 });
		// Unavailable, not `disabled`: the keyboard still reaches it, which is the
		// only way the reason is readable at all.
		await spent.focus();
		await expect(spent).toBeFocused();
		await page.keyboard.press('Enter');

		const panelId = await spent.getAttribute('aria-controls');
		const panel = page.locator(`#${panelId}`);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('Deterministic Replay for Agent Failures');
		await expect(panel).toContainText('Type Systems for Tool-Calling Agents');
		await expect(panel).toContainText('Agent Handoffs: Who Owns the Write?');
		await expect(panel).toContainText('unpin one first');
	});

	test('the line-up takes the whole phone screen instead of pushing the document sideways', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'touch-viewport composition contract');

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app/review?lineup=sub-302&slice=all');

		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('region', { name: 'Anchor', exact: true })).toContainText(
			'Type Systems for Tool-Calling Agents',
			{ timeout: 15000 }
		);
		const list = page.getByRole('region', { name: 'Reviews compared against the anchor' });
		await expect(list.getByRole('listitem')).toHaveCount(3, { timeout: 15000 });

		// One column, and the anchor's identity is kept in view by the summary bar
		// that replaces the sticky reference at this width. Where there is no room
		// beside it, the comparison is the screen.
		await expect(page.locator('.bar')).toBeVisible();
		const metrics = await page.evaluate(() => {
			const dialog = document.querySelector('dialog[open]') as HTMLElement;
			const box = dialog.getBoundingClientRect();
			return {
				dialogWidth: Math.round(box.width),
				dialogHeight: Math.round(box.height),
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight,
				scrollWidth: document.documentElement.scrollWidth,
				clientWidth: document.documentElement.clientWidth,
				columns: getComputedStyle(document.querySelector('.lineup') as Element).gridTemplateColumns
			};
		});
		expect(metrics.columns.split(' ')).toHaveLength(1);
		expect(metrics.dialogWidth).toBe(metrics.viewportWidth);
		expect(metrics.dialogHeight).toBeGreaterThanOrEqual(metrics.viewportHeight - 1);
		expect(metrics.scrollWidth).toBe(metrics.clientWidth);
	});

	test('the line-up route stacks on a phone too', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'touch-viewport composition contract');

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app/review/lineup?anchor=sub-302&slice=all');

		await expect(page.getByRole('region', { name: 'Anchor', exact: true })).toContainText(
			'Type Systems for Tool-Calling Agents',
			{ timeout: 15000 }
		);
		await expect(page.locator('.bar')).toBeVisible();
		const metrics = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
			columns: getComputedStyle(document.querySelector('.lineup') as Element).gridTemplateColumns
		}));
		expect(metrics.columns.split(' ')).toHaveLength(1);
		expect(metrics.scrollWidth).toBe(metrics.clientWidth);
	});
});
