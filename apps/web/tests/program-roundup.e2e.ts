import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The Program panel: the schedule pool grouped by what still stands between
 * each session and done — placed, peopled, decided. Sessions are created here,
 * acceptances graduate into it, attribution completes placeholders from the
 * speakers panel, and each remaining gap is a computed count with one door.
 */

const CRUNCH = 'crunch';
const FLIGHT = 'flight';

function program(page: Page) {
	return page.getByRole('region', { name: 'Program', exact: true });
}

function group(page: Page, name: string) {
	return program(page).getByRole('region', { name, exact: true });
}

// The pool fixtures here — the placeholder keynote, the two collecting
// containers, the graduating acceptances — are the mid-flight scenario's.
// The crunch describe below re-pins the held-slot scenario it needs.
test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: 'je-scenario', value: FLIGHT, url: baseURL ?? 'http://127.0.0.1:4173' }
	]);
});

test('the panel partitions the pool: each unfinished session renders once, its gaps named on the row', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the partition contract');

	await page.goto('/app/schedule');
	await expect(program(page)).toBeVisible({ timeout: 15000 });

	// Two unplaced programmed sessions and two collecting containers; groups
	// with nothing in them do not render, and no session renders twice.
	const unplaced = group(page, 'Unplaced');
	const collecting = group(page, 'Collecting proposals');
	await expect(unplaced.locator('.panel__count')).toHaveText('2');
	await expect(collecting.locator('.panel__count')).toHaveText('2');
	await expect(program(page).locator('.pool-group')).toHaveCount(2);
	await expect(program(page).locator('.pool__row')).toHaveCount(4);

	// The placeholder keynote sits in Unplaced once; its second gap rides the
	// row as a quiet fact, never as a second row.
	await expect(page.locator('#pool-ses-13')).toHaveCount(1);
	const keynote = unplaced.locator('#pool-ses-13');
	await expect(keynote).toContainText('Closing Keynote — speaker to be announced');
	await expect(keynote).toContainText('No speakers yet');

	// A collecting container's open-proposal count is the one door to deciding
	// them; zero is stated as a fact, not linked.
	const panelDoor = collecting
		.locator('#pool-ses-11')
		.getByRole('link', { name: '2 proposals to decide' });
	await expect(panelDoor).toHaveAttribute('href', '/app/decisions?target=ses-11');
	const lightning = collecting.locator('#pool-ses-12');
	await expect(lightning).toContainText('No proposals yet');
	await expect(lightning.getByRole('link')).toHaveCount(0);
});

test('New session commits with an undoable receipt; Create and place… arms the mode with the new session in hand', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the creation contract');

	await page.goto('/app/schedule');
	const newButton = program(page).getByRole('button', { name: 'New session…' });
	await expect(newButton).toBeVisible({ timeout: 15000 });
	await newButton.click();

	const dialog = page.getByRole('dialog', { name: 'New session' });
	await expect(dialog).toBeVisible();
	const form = dialog.locator('#new-session-form');

	// The editorial fact is the default start; a private sketch has no place
	// on the grid, so choosing it withdraws the place-through action.
	await expect(form.getByRole('radio', { name: 'In the program' })).toBeChecked();
	await form.getByRole('radio', { name: 'Private sketch' }).check();
	await expect(form.getByRole('button', { name: 'Create and place…' })).toHaveCount(0);
	await form.getByRole('radio', { name: 'In the program' }).check();
	await expect(form.getByRole('button', { name: 'Create and place…' })).toBeVisible();

	await form.getByLabel('Title').fill('Hallway Track: Unconference Hour');
	await form.getByRole('button', { name: 'Create', exact: true }).click();

	const receipt = page
		.getByRole('status')
		.filter({ hasText: 'Created “Hallway Track: Unconference Hour” — in the program' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(group(page, 'Unplaced').getByText('Hallway Track: Unconference Hour')).toBeVisible();

	// Nothing references the new session yet, so the receipt can unspawn it.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(program(page).getByText('Hallway Track: Unconference Hour')).toHaveCount(0, {
		timeout: 10000
	});

	// Create and place…: one creation, one placement — the commit lands and
	// the mode is already armed, no re-finding the session in a list.
	await newButton.click();
	await form.getByLabel('Title').fill('Sponsor Lightning Reel');
	await form.getByRole('button', { name: 'Create and place…' }).click();

	await expect(
		page.getByRole('button', { name: 'Cancel placing “Sponsor Lightning Reel”' })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('button', { name: /^Opening / }).first()).toBeVisible();

	// Escape stands the mode down; the created session waits in the pool.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Place “Sponsor Lightning Reel”' })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Opening / })).toHaveCount(0);
});

test('the board’s Add row is a second door to the same creation form, leading with Create and place…', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the door contract');

	await page.goto('/app/schedule');
	const boardButton = page.locator('.board-add').getByRole('button', { name: 'New session…' });
	await expect(boardButton).toBeVisible({ timeout: 15000 });
	await boardButton.click();

	// One dialog behind both doors, so they can never read as two features.
	// Standing at the board, the primary flips to place-through and Enter
	// drives it.
	const dialog = page.getByRole('dialog', { name: 'New session' });
	await expect(dialog).toBeVisible();
	const form = dialog.locator('#new-session-form');
	const actions = form.locator('.new-session__actions button');
	await expect(actions.first()).toHaveText('Create and place…');
	await expect(actions.first()).toHaveClass(/ui-button--primary/);

	await form.getByLabel('Title').fill('Community Demo Corner');
	await form.getByLabel('Title').press('Enter');
	await expect(
		page.getByRole('button', { name: 'Cancel placing “Community Demo Corner”' })
	).toBeVisible({ timeout: 10000 });
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Place “Community Demo Corner”' })).toBeVisible();

	// The panel door opens the same dialog, leading with Create — and a
	// dismissed draft survives: parking, not discarding.
	const panelButton = program(page).getByRole('button', { name: 'New session…' });
	await panelButton.click();
	await expect(dialog).toBeVisible();
	await expect(
		dialog.locator('.new-session__actions button').first()
	).toHaveText('Create');
	await form.getByLabel('Title').fill('Half-typed idea');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await panelButton.click();
	await expect(form.getByLabel('Title')).toHaveValue('Half-typed idea');
});

test('?tray= scopes the panel to one tray behind a visible chip, and Clear restores the grouped view', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the scope contract');

	await page.goto('/app/schedule?tray=needs-speakers');
	await expect(program(page)).toBeVisible({ timeout: 15000 });

	// The scope is named on the surface and only the tray's rows render; the
	// groups stand down while the filter holds.
	await expect(program(page).locator('.panel__scope .ui-badge')).toHaveText('Needs speakers');
	await expect(program(page).locator('.pool__row')).toHaveCount(1);
	await expect(page.locator('#pool-ses-13')).toContainText('Closing Keynote');
	await expect(program(page).locator('.pool-group')).toHaveCount(0);

	// One press gives the whole partition back and the address goes clean.
	await program(page).getByRole('button', { name: 'Clear the needs speakers scope' }).click();
	await expect(page).toHaveURL(/\/app\/schedule$/);
	await expect(program(page).locator('.pool-group')).toHaveCount(2);
	await expect(program(page).locator('.pool__row')).toHaveCount(4);
});

test('direct entry completes a placeholder: provenance lands on the roster, the gap leaves the row, and Overview stands down', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the attribution contract');

	// The roster gap surfaces first as a computed attention item whose door is
	// the panel scoped to exactly its rows.
	await page.goto('/app');
	const attention = page.getByRole('region', { name: 'Needs attention' });
	await expect(attention).toBeVisible({ timeout: 15000 });
	const item = attention
		.getByRole('listitem')
		.filter({ hasText: '1 program session needs speakers' });
	await expect(item).toBeVisible();
	const door = item.getByRole('link', { name: 'Review sessions' });
	await expect(door).toHaveAttribute('href', '/app/schedule?tray=needs-speakers');
	await door.click();
	await expect(page).toHaveURL(/\/app\/schedule\?tray=needs-speakers$/);
	await expect(page.locator('#pool-ses-13')).toBeVisible({ timeout: 15000 });

	// Work in the grouped view so the row can be watched as its gap closes.
	await program(page).getByRole('button', { name: 'Clear the needs speakers scope' }).click();
	await expect(page.locator('#pool-ses-13')).toContainText('No speakers yet');
	await page
		.locator('#pool-ses-13')
		.getByRole('button', { name: 'Speakers on “Closing Keynote — speaker to be announced”' })
		.click();

	// The dialog names its session and where it stands — the continuity cue.
	const speakers = page.getByRole('dialog', { name: 'Speakers' });
	await expect(speakers).toBeVisible();
	await expect(page).toHaveURL(/panel=speakers&session=ses-13/);
	await expect(speakers).toContainText('Closing Keynote — speaker to be announced');
	await expect(speakers).toContainText('not placed yet');
	await expect(speakers).toContainText('No speakers yet');

	// One query narrows every way in; the scope line keeps a short list honest.
	const search = speakers.getByLabel('Add people');
	await expect(search).toBeVisible();
	await search.fill('zzz-nobody');
	await expect(speakers).toContainText(/No one matches “zzz-nobody” across \d+\s+people/);
	await search.fill('');

	// Direct entry is one whole act — person, accepted record, attribution —
	// landing together under one undoable receipt.
	await speakers.getByRole('button', { name: 'Add a new person…' }).click();
	await speakers.getByLabel('Name').fill('Jordan Nakamura');
	await speakers.getByLabel('Email').fill('jordan@closing.example');
	await speakers.getByRole('button', { name: 'Add to session' }).click();

	const added = page.getByRole('status').filter({
		hasText: 'Added Jordan Nakamura to “Closing Keynote — speaker to be announced” — direct entry'
	});
	await expect(added).toBeVisible({ timeout: 10000 });
	const rosterRow = speakers
		.locator('.speakers__row')
		.filter({ hasText: 'Jordan Nakamura' })
		.filter({ hasText: 'direct entry' });
	await expect(rosterRow).toBeVisible();
	// A dialog is a stage, not a sidebar: leave it before travelling on.
	await page.keyboard.press('Escape');
	await expect(speakers).toBeHidden();
	await expect(page.locator('#pool-ses-13')).not.toContainText('No speakers yet');

	// The computed item reads zero and stops rendering — checked in the same
	// session through the app's own navigation.
	await page
		.getByRole('navigation', { name: 'Workspace' })
		.getByRole('link', { name: 'Overview' })
		.click();
	await expect(attention).toBeVisible({ timeout: 15000 });
	await expect(attention).toContainText('2 sessions await placement');
	await expect(attention).not.toContainText(/program sessions? needs? speakers/);

	// Removal arms in place before it commits, and the receipt takes it back.
	await page
		.getByRole('navigation', { name: 'Workspace' })
		.getByRole('link', { name: 'Schedule' })
		.click();
	await page
		.locator('#pool-ses-13')
		.getByRole('button', { name: 'Speakers on “Closing Keynote — speaker to be announced”' })
		.click();
	const panel = page.getByRole('dialog', { name: 'Speakers' });
	await expect(panel).toBeVisible({ timeout: 15000 });
	await expect(panel).toContainText('Closing Keynote — speaker to be announced');
	await panel
		.getByRole('button', {
			name: 'Remove Jordan Nakamura from “Closing Keynote — speaker to be announced”'
		})
		.click();
	const confirm = panel.getByRole('button', { name: 'Remove Jordan Nakamura — confirm' });
	await expect(confirm).toHaveText('Remove?');
	// Armed is not removed: the roster row is still standing.
	await expect(panel.locator('.speakers__row').filter({ hasText: 'Jordan Nakamura' })).toBeVisible();
	await confirm.click();

	const removed = page.getByRole('status').filter({
		hasText: 'Removed Jordan Nakamura from “Closing Keynote — speaker to be announced”'
	});
	await expect(removed).toBeVisible({ timeout: 10000 });
	await expect(
		panel.getByRole('button', { name: /Remove Jordan Nakamura/ })
	).toHaveCount(0);
	// In-dialog recovery exists without the toast: the removed person is
	// offered right back from the roster group.
	await expect(
		panel.locator('.speakers__row').filter({ hasText: 'Jordan Nakamura' })
	).toContainText('invited');

	// The toast sits behind the dialog's top layer, so undo from it means
	// leaving the stage first — one Escape, receipt still fresh.
	await page.keyboard.press('Escape');
	await expect(panel).toBeHidden();
	await expect(page.locator('#pool-ses-13')).toContainText('No speakers yet');
	await removed.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('#pool-ses-13')).not.toContainText('No speakers yet', {
		timeout: 10000
	});
});

test('accepting without a target spawns into the pool, the receipt carries the placement door, and undo unspawns', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the graduation contract');

	await page.goto('/app/decisions');
	const row = page.locator('tr[data-submission="sub-106"]');
	await expect(row).toBeVisible({ timeout: 15000 });
	await row.getByRole('button', { name: 'Accept', exact: true }).click();

	// The receipt names where the acceptance landed and keeps the batching
	// thread: the door opens the pool scoped to the placement debt.
	const receipt = page.getByRole('status').filter({
		hasText: 'Accepted “The Inference Bill Nobody Read” — added to the program pool'
	});
	await expect(receipt).toBeVisible({ timeout: 10000 });
	const door = receipt.getByRole('link', { name: 'Place it' });
	await expect(door).toHaveAttribute('href', '/app/schedule?tray=unplaced');

	// Undo first, while the receipt is fresh (it rests after a few seconds —
	// the trail surface, not this toast, is the long-lived undo home): the
	// compensated graduation takes the untouched spawn out of the pool.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(receipt).toHaveCount(0, { timeout: 10000 });
	await page.getByRole('link', { name: 'Schedule' }).click();
	const spawned = program(page)
		.locator('.pool__row')
		.filter({ hasText: 'The Inference Bill Nobody Read' });
	// The grouped (unscoped) view: the compensated spawn has left Unplaced,
	// restoring the seeded two; the collecting group is untouched beside it.
	await expect(
		page.getByRole('region', { name: 'Unplaced', exact: true }).locator('.pool__row')
	).toHaveCount(2, { timeout: 15000 });
	await expect(spawned).toHaveCount(0);

	// Accept again and walk the door this time; the pool arrives scoped to the
	// placement debt with the spawned session in it.
	await page.getByRole('link', { name: 'Decisions' }).click();
	await expect(row).toBeVisible({ timeout: 15000 });
	await row.getByRole('button', { name: 'Accept', exact: true }).click();
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await receipt.getByRole('link', { name: 'Place it' }).click();

	await expect(page).toHaveURL(/\/app\/schedule\?tray=unplaced$/);
	await expect(program(page).locator('.panel__scope .ui-badge')).toHaveText('Unplaced', {
		timeout: 15000
	});
	await expect(spawned).toBeVisible();
	await expect(program(page).locator('.pool__row')).toHaveCount(3);
});

test('accepting a proposal aimed at a collecting session graduates it: the container joins Unplaced with the proposer attributed', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the attach contract');

	await page.goto('/app/decisions');
	const row = page.locator('tr[data-submission="sub-104"]');
	await expect(row).toBeVisible({ timeout: 15000 });
	await row.getByRole('button', { name: 'Accept', exact: true }).click();

	const receipt = page.getByRole('status').filter({
		hasText: 'Accepted “Durable Agent Jobs: A Queueing Confession” — joined its session'
	});
	await expect(receipt).toBeVisible({ timeout: 10000 });

	// In the same session, the pool reflects the graduation: the container
	// left Collecting and now waits as an ordinary unplaced programmed row.
	await page
		.getByRole('navigation', { name: 'Workspace' })
		.getByRole('link', { name: 'Schedule' })
		.click();
	await expect(program(page)).toBeVisible({ timeout: 15000 });
	await expect(group(page, 'Unplaced').locator('#pool-ses-11')).toContainText(
		'Panel: Durable Agent Infrastructure'
	);
	await expect(group(page, 'Collecting proposals').locator('#pool-ses-11')).toHaveCount(0);
	await expect(group(page, 'Collecting proposals').locator('.pool__row')).toHaveCount(1);

	// The proposer rode the acceptance onto the roster, with provenance.
	await page
		.locator('#pool-ses-11')
		.getByRole('button', { name: 'Speakers on “Panel: Durable Agent Infrastructure”' })
		.click();
	const speakers = page.getByRole('dialog', { name: 'Speakers' });
	await expect(speakers).toBeVisible();
	await expect(speakers).toContainText('Panel: Durable Agent Infrastructure');
	const rosterRow = speakers.locator('.speakers__row').filter({ hasText: 'Tomás Rivera' });
	await expect(rosterRow).toContainText('via “Durable Agent Jobs: A Queueing Confession”');
});

test.describe('a crunch week', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		await context.addCookies([
			{ name: 'je-scenario', value: CRUNCH, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

	test('a placed collecting session is a held slot: dashed on the grid, grouped in the pool with its doors', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the held-slot contract');

		await page.goto('/app/schedule?day=day-2');

		// The grid card keeps its committed slot but says what it is waiting
		// on, in the hollow collecting voice rather than a roster line.
		const card = page.locator('#placed-ses-19');
		await expect(card).toBeVisible({ timeout: 15000 });
		await expect(card).toHaveClass(/card--collecting/);
		await expect(card).toContainText('Collecting — 2 proposals');

		// The pool row holds the slot rather than re-placing it, and carries
		// the one door to the decisions that would graduate it.
		const held = group(page, 'Held slots awaiting decisions');
		const row = held.locator('#pool-ses-19');
		await expect(row).toContainText('Panel: The Eval Budget Fight');
		await expect(row.getByRole('button', { name: /^Place / })).toHaveCount(0);
		await expect(row.getByRole('button', { name: 'Show on Wed Oct 14' })).toBeVisible();
		await expect(row.getByRole('link', { name: '2 proposals to decide' })).toHaveAttribute(
			'href',
			'/app/decisions?target=ses-19'
		);
	});
});
