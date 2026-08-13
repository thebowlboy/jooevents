import { expect, test } from '@playwright/test';

// Pinned to the mid-flight scenario: these tests assert its exact fixtures,
// and which story the hosted demo opens on must not decide what they see.
test.use({
	storageState: {
		cookies: [
			{
				name: 'je-scenario',
				value: 'flight',
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

/**
 * The placement mode: the grid is the interface. Entering from "Place…" expands
 * the board to every day with openings highlighted; a click proposes a snapped
 * time; the confirm dialog is the commit step whose typed time is the precision
 * path; breaks are typed reservations whose edges the aim snaps against.
 *
 * The flight dataset reserves 12:00–13:00 lunch in every room. Its Program
 * panel holds several unfinished sessions; "Typed Tool Contracts…" (30 min)
 * is the unplaced one these tests place. The panel's grouping, creation, and
 * attribution behavior is covered in program-roundup.e2e.ts.
 */

test('placing surfaces no new box: the pressed control becomes Cancel and the board stays put', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the mode contract');

	await page.goto('/app/schedule');
	const poolButton = page.getByRole('button', { name: 'Place “Typed Tool Contracts Between Agents That Never Meet”' });
	await expect(poolButton).toBeVisible({ timeout: 15000 });
	await expect(page.getByText('Lunch').first()).toBeVisible();
	const roomHeaders = await page.locator('.board__room').count();
	const boardBox = await page.locator('.board-wrap').boundingBox();

	await poolButton.click();

	// The exit is the very control that was pressed, transformed in place; the
	// board neither re-lays-out nor moves, and free space offers itself.
	const cancel = page.getByRole('button', {
		name: 'Cancel placing “Typed Tool Contracts Between Agents That Never Meet”'
	});
	await expect(cancel).toBeVisible();
	await expect(cancel).toContainText('Esc');
	expect(await page.locator('.board__room').count()).toBe(roomHeaders);
	const boardBoxPlacing = await page.locator('.board-wrap').boundingBox();
	expect(Math.abs((boardBoxPlacing?.y ?? 0) - (boardBox?.y ?? 0))).toBeLessThan(2);
	expect(await page.getByRole('button', { name: /^Opening / }).count()).toBeGreaterThan(0);
	// Desktop never shows the compact-viewport strip.
	await expect(page.locator('.mode-strip')).toBeHidden();

	// Aiming writes the shifted-to time onto the axis, and the ghost — where the
	// eyes are — carries the Esc cue; leaving the opening clears both.
	await page.getByRole('button', { name: 'Opening 10:00–10:30 — Main Stage, Tue Oct 13' }).hover();
	await expect(page.locator('.board__time-marker')).toHaveText('10:00');
	await expect(page.locator('.ghost .ghost__cue')).toContainText('Esc');
	await page.locator('.board__corner').hover();
	await expect(page.locator('.board__time-marker')).toHaveCount(0);

	// The day switcher is the cross-day map: each day counts its openings for the
	// session in hand, and switching swaps the board's day without leaving the mode.
	await expect(page.getByRole('button', { name: /Tue Oct 13 — \d+ openings for this session/ })).toBeVisible();
	const wednesday = page.getByRole('button', { name: /Wed Oct 14 — \d+ openings for this session/ });
	await expect(wednesday).toBeVisible();
	await wednesday.click();
	await expect(cancel).toBeVisible();
	await expect(page.getByRole('button', { name: /^Opening .* Wed Oct 14$/ }).first()).toBeVisible();
	await expect(page).toHaveURL(/day=day-2/);

	// Escape leaves the mode; the counts and the transformed control revert.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: /Place “Typed Tool Contracts/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /openings for this session/ })).toHaveCount(0);

	// A long aside can push the pool far below the calendar; pressing Place…
	// from down there brings the board back into view. The app scrolls
	// smoothly, so the position is polled until the scroll settles.
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await page.getByRole('button', { name: /Place “Typed Tool Contracts/ }).click();
	await expect(page.getByRole('button', { name: /Cancel placing/ })).toBeVisible();
	await expect
		.poll(() =>
			page
				.locator('section[aria-label="Schedule grid"]')
				.evaluate((el) => el.getBoundingClientRect().top)
		)
		.toBeGreaterThanOrEqual(0);
});

test('moving anchors its cancel on the origin card, where Move was pressed', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the move contract');

	await page.goto('/app/schedule');
	const card = page.locator('#placed-ses-2');
	await expect(card).toBeVisible({ timeout: 15000 });
	await card.hover();
	await card.getByRole('button', { name: 'Move “Context Caching Without Tears”', exact: true }).click();

	// The card becomes the origin marker carrying the mode's exit in place.
	const originCancel = page.getByRole('button', { name: 'Cancel moving “Context Caching Without Tears”' });
	await expect(originCancel).toBeVisible();
	await expect(originCancel).toContainText('Esc');
	await expect(page.getByText('· current slot')).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(page.locator('#placed-ses-2')).toBeVisible();
	await expect(originCancel).toHaveCount(0);
});

test('a move that lands back on its own slot cancels instead of asking', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the no-op contract');

	await page.goto('/app/schedule');
	const card = page.locator('#placed-ses-2');
	await expect(card).toBeVisible({ timeout: 15000 });
	await expect(card).toContainText('10:30–11:00');
	await card.hover();
	await card.getByRole('button', { name: 'Move “Context Caching Without Tears”', exact: true }).click();

	// Vacating its own slot merges it into the gap after the keynote, so the
	// opening spans 10:00–11:00 — but the origin marker still renders over its
	// own half of that span. The reachable route to "same spot" is the anchor
	// capture just above the marker's edge: aiming within ANCHOR_CAPTURE_MIN of
	// 10:30 snaps to 10:30, which is exactly where the session already is.
	const opening = page.getByRole('button', { name: 'Opening 10:00–11:00 — Main Stage, Tue Oct 13' });
	const openingBox = await opening.boundingBox();
	// The placed card is replaced by the origin marker for the duration of the
	// mode, so the marker is what carries the slot's geometry here.
	const originBox = await page.locator('.card--origin').boundingBox();
	const aimX = (openingBox?.x ?? 0) + (openingBox?.width ?? 0) / 2;
	const aimY = (originBox?.y ?? 0) - 4;
	await page.mouse.move(aimX, aimY);
	await expect(page.locator('.board__time-marker')).toHaveText('10:30');

	// No second rectangle over the slot: the marker already stands for "the
	// session is here", so it takes the aimed treatment and says what landing
	// does, instead of a ghost drawing the same rectangle on top of it.
	await expect(page.locator('.ghost')).toHaveCount(0);
	const marker = page.locator('.card--origin');
	await expect(marker).toHaveClass(/card--origin-aimed/);
	await expect(marker).toContainText('leave it here');

	await page.mouse.click(aimX, aimY);

	// No dialog, no commit, no receipt — and the mode is over.
	await expect(page.getByRole('button', { name: /Cancel moving/ })).toHaveCount(0);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Opening / })).toHaveCount(0);
	await expect(page.locator('#placed-ses-2')).toContainText('10:30–11:00');
	await expect(page.locator('p.ui-sr-only[role="status"]')).toHaveText(
		'Move cancelled — “Context Caching Without Tears” is already at Tue Oct 13 10:30, Main Stage.'
	);

	// Aiming clear of the capture window is a genuine move and still confirms.
	await card.hover();
	await card.getByRole('button', { name: 'Move “Context Caching Without Tears”', exact: true }).click();
	const again = await opening.boundingBox();
	await page.mouse.click((again?.x ?? 0) + (again?.width ?? 0) / 2, (again?.y ?? 0) + 4);
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page.getByRole('dialog')).toContainText('ends 10:30');
});

test('nudging the dialog’s time back onto the origin cancels rather than committing a no-op', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the no-op contract');

	await page.goto('/app/schedule');
	const card = page.locator('#placed-ses-2');
	await expect(card).toBeVisible({ timeout: 15000 });
	await card.hover();
	await card.getByRole('button', { name: 'Move “Context Caching Without Tears”', exact: true }).click();

	// Land the aim at the top of the opening (10:00), then walk the typed time
	// back to 10:30 — the path the aim itself cannot reach.
	const opening = page.getByRole('button', { name: 'Opening 10:00–11:00 — Main Stage, Tue Oct 13' });
	const box = await opening.boundingBox();
	await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 4);
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('ends 10:30');
	for (let step = 0; step < 6; step++) await dialog.getByRole('button', { name: '+5 min' }).click();
	await expect(dialog).toContainText('ends 11:00');

	await dialog.getByRole('button', { name: 'Move session' }).click();

	// Nothing was written: no receipt to undo, and the session never moved.
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Cancel moving/ })).toHaveCount(0);
	await expect(page.locator('#placed-ses-2')).toContainText('10:30–11:00');
	await expect(page.getByRole('button', { name: /^Undo/ })).toHaveCount(0);
});

test('aiming across the vacated slot holds the ghost instead of strobing it', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'a hit-test loop is a pointer defect');

	await page.goto('/app/schedule');
	const card = page.locator('#placed-ses-2');
	await expect(card).toBeVisible({ timeout: 15000 });
	await card.hover();
	await card.getByRole('button', { name: 'Move “Context Caching Without Tears”', exact: true }).click();

	const opening = page.getByRole('button', { name: 'Opening 10:00–11:00 — Main Stage, Tue Oct 13' });
	const openingBox = await opening.boundingBox();
	const originBox = await page.locator('.card--origin').boundingBox();
	const aimX = (openingBox?.x ?? 0) + (openingBox?.width ?? 0) / 2;

	// Just inside the vacated slot. Before the marker was made pointer-transparent
	// it took the cursor back off the opening — the aim cleared, the treatment
	// dropped, the opening re-entered, and the pair looped several times a second.
	await page.mouse.move(aimX, (originBox?.y ?? 0) + 8);
	await expect(page.locator('.card--origin-aimed')).toHaveCount(1);

	// Held still, the aim must be a fixed point: sample across several frames and
	// require one single state, not an alternation.
	const states = new Set<string>();
	for (let sample = 0; sample < 10; sample++) {
		await page.waitForTimeout(50);
		states.add(
			await page.evaluate(
				() =>
					`${document.querySelectorAll('.card--origin-aimed').length}|` +
					`${document.querySelectorAll('.ghost').length}|` +
					`${document.querySelectorAll('.opening:hover').length}`
			)
		);
	}
	expect([...states]).toEqual(['1|0|1']);

	// The marker's one control is the deliberate exception and still works.
	await page.getByRole('button', { name: 'Cancel moving “Context Caching Without Tears”' }).click();
	await expect(page.getByRole('button', { name: /^Opening / })).toHaveCount(0);
	await expect(page.locator('#placed-ses-2')).toContainText('10:30–11:00');
});

test('right-click on the board is the pointer’s way out of the mode', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the context menu is a pointer affordance');

	await page.goto('/app/schedule');
	const card = page.locator('#placed-ses-2');
	await expect(card).toBeVisible({ timeout: 15000 });
	await card.hover();
	await card.getByRole('button', { name: 'Move “Context Caching Without Tears”', exact: true }).click();

	const originCancel = page.getByRole('button', { name: 'Cancel moving “Context Caching Without Tears”' });
	await expect(originCancel).toBeVisible();

	// The mode ends and the session is untouched — a cancel, not a commit.
	await page.locator('.board-region').click({ button: 'right', position: { x: 8, y: 8 } });
	await expect(originCancel).toHaveCount(0);
	await expect(page.locator('#placed-ses-2')).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Opening / })).toHaveCount(0);
});

test('mobile: a bottom strip carries the mode name and its cancel', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'the strip is the compact-viewport treatment');

	await page.goto('/app/schedule');
	const poolButton = page.getByRole('button', { name: /Place “Typed Tool Contracts/ });
	await expect(poolButton).toBeVisible({ timeout: 15000 });
	await poolButton.click();

	const strip = page.locator('.mode-strip');
	await expect(strip).toBeVisible();
	await expect(strip).toContainText('Placing “Typed Tool Contracts');
	await strip.getByRole('button', { name: 'Cancel' }).click();
	await expect(strip).toHaveCount(0);
});

test('mobile: the confirm dialog keeps the neighbour verbs, introduced as the help they are', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'the verbs are the coarse-pointer treatment');

	await page.goto('/app/schedule');
	const poolButton = page.getByRole('button', { name: /Place “Typed Tool Contracts/ });
	await expect(poolButton).toBeVisible({ timeout: 15000 });
	await poolButton.click();

	// A tap carries a position but not precision; the dialog says so plainly
	// and offers the flush setters the desktop dialog no longer needs.
	await page.getByRole('button', { name: 'Opening 10:00–10:30 — Main Stage, Tue Oct 13' }).click();
	const dialog = page.getByRole('dialog', { name: 'Place session' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('If the tap landed a little off, snap it exactly:');
	await expect(
		dialog.getByRole('button', { name: /Right after “Opening Keynote/ })
	).toBeVisible();
});

test('an opening click confirms a snapped flush time, commits, and hands back undo', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the commit contract');

	await page.goto('/app/schedule');
	const poolButton = page.getByRole('button', { name: /Place “Typed Tool Contracts/ });
	await expect(poolButton).toBeVisible({ timeout: 15000 });
	await poolButton.click();

	// Main Stage on day 1 is free exactly 10:00–10:30 after the keynote; the
	// whole opening is one 30-minute fit, so any click lands flush at 10:00.
	await page.getByRole('button', { name: 'Opening 10:00–10:30 — Main Stage, Tue Oct 13' }).click();

	const dialog = page.getByRole('dialog', { name: 'Place session' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Tue Oct 13 · Main Stage');
	await expect(dialog).toContainText('Right after “Opening Keynote: AI Engineering Beyond the Demo”');
	await expect(dialog.getByLabel('Starts')).toHaveValue('10:00');
	await expect(dialog).toContainText('30 min · ends 10:30');

	await dialog.getByRole('button', { name: 'Place session' }).click();

	// The commit lands on the grid, the mode is over, and the receipt can undo.
	const card = page.locator('#placed-ses-7');
	await expect(card).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('button', { name: /Cancel placing “Typed Tool/ })).toHaveCount(0);
	const receipt = page.getByRole('status').filter({ hasText: 'Placed “Typed Tool Contracts' });
	await expect(receipt).toBeVisible();
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('#placed-ses-7')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Place “Typed Tool Contracts/ })).toBeVisible({
		timeout: 10000
	});
});

test('typed time is the escape hatch: running into a break warns without blocking', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the preflight contract');

	await page.goto('/app/schedule');
	const poolButton = page.getByRole('button', { name: /Place “Typed Tool Contracts/ });
	await expect(poolButton).toBeVisible({ timeout: 15000 });
	await poolButton.click();

	// Aiming never lands on a break — this opening ends flush before lunch —
	// but the confirm dialog's typed time may deliberately overlap it.
	await page.getByRole('button', { name: 'Opening 11:30–12:00 — Breakout Stage A, Tue Oct 13' }).click();
	const dialog = page.getByRole('dialog', { name: 'Place session' });
	await expect(dialog.getByLabel('Starts')).toHaveValue('11:30');

	await dialog.getByLabel('Starts').fill('11:50');
	await expect(dialog).toContainText('Runs into “Lunch” in Breakout Stage A');

	// On a fine pointer the typed time is the recovery — the neighbour verbs
	// are touch help and stay out of the desktop dialog entirely (owner
	// direction, 2026-08-13).
	await expect(dialog.getByRole('button', { name: 'Right before “Lunch”' })).toBeHidden();
	await dialog.getByLabel('Starts').fill('11:30');
	await expect(dialog).not.toContainText('Runs into “Lunch”');

	// A warning attaches; it does not block the commit — and Enter commits
	// straight from the time field, as the chip on the primary action promises.
	await dialog.getByLabel('Starts').fill('11:50');
	await expect(dialog).toContainText('Runs into “Lunch” in Breakout Stage A');
	await expect(dialog.getByRole('button', { name: 'Place session' })).toBeEnabled();
	await dialog.getByLabel('Starts').press('Enter');
	const card = page.locator('#placed-ses-7');
	await expect(card).toBeVisible({ timeout: 10000 });
	await expect(card.getByRole('button', { name: /Warning — why/ })).toBeVisible();
});

test('Add break reserves typed time across rooms and leaves an undo receipt', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the break tool');

	await page.goto('/app/schedule');
	await expect(page.locator('#placed-ses-2')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: 'Add break…' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add break' });
	await dialog.getByLabel('Label').fill('Coffee');
	await dialog.getByLabel('Starts').fill('15:00');
	await dialog.getByLabel('Length').selectOption('15');
	await dialog.getByRole('button', { name: 'Add break' }).click();

	// One action minted a break per room, on the board where they were typed.
	await expect(page.locator('.brk', { hasText: 'Coffee' })).toHaveCount(3, { timeout: 10000 });
	const receipt = page.getByRole('status').filter({ hasText: 'Added “Coffee” — Tue Oct 13 15:00, 3 rooms' });
	await expect(receipt).toBeVisible();
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('.brk', { hasText: 'Coffee' })).toHaveCount(0);
});
