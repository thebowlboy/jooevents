import { expect, test } from '@playwright/test';

/**
 * The placement mode: the grid is the interface. Entering from "Place…" expands
 * the board to every day with openings highlighted; a click proposes a snapped
 * time; the confirm dialog is the commit step whose typed time is the precision
 * path; breaks are typed reservations whose edges the aim snaps against.
 *
 * The flight dataset leaves exactly one session unscheduled ("Typed Tool
 * Contracts…", 30 min) and reserves 12:00–13:00 lunch in every room.
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

	// The neighbour verbs are the recovery: one press returns the time flush
	// before the thing the warning names, no arithmetic.
	await dialog.getByRole('button', { name: 'Right before “Lunch”' }).click();
	await expect(dialog.getByLabel('Starts')).toHaveValue('11:30');
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
