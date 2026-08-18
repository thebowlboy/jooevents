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
	// This event has several tracks. Operational creation stays disabled until
	// the organizer makes the one classification the event cannot infer.
	await expect(form.getByLabel('Track')).toHaveValue('');
	await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
	await form.getByLabel('Track').selectOption({ label: 'Agents & Tools' });
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
	await form.getByLabel('Track').selectOption({ label: 'Agents & Tools' });
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
	await form.getByLabel('Track').selectOption({ label: 'Agents & Tools' });
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

test('a trackless private sketch must be classified before it can enter or be placed in the program', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the track repair loop');

	await page.goto('/app/schedule');
	const panel = program(page);
	await expect(panel).toBeVisible({ timeout: 15000 });
	await panel.getByRole('button', { name: 'New session…' }).click();

	const create = page.getByRole('dialog', { name: 'New session' });
	const form = create.locator('#new-session-form');
	await form.getByLabel('Title').fill('Unclassified private sketch');
	await form.getByRole('radio', { name: 'Private sketch' }).check();
	await expect(form.getByLabel('Track')).toHaveValue('');
	await form.getByRole('button', { name: 'Create', exact: true }).click();

	const row = panel.locator('.pool__row').filter({ hasText: 'Unclassified private sketch' });
	await expect(row).toBeVisible({ timeout: 10000 });
	await expect(row.getByRole('button', { name: 'Place “Unclassified private sketch”' }))
		.toHaveCount(0);
	await row.getByRole('button', { name: 'Add “Unclassified private sketch” to the program' })
		.click();

	const repair = page.getByRole('dialog', {
		name: 'Choose a track for “Unclassified private sketch”'
	});
	await expect(repair).toBeVisible();
	await expect(repair.getByRole('button', { name: 'Save track' })).toBeDisabled();
	await repair.getByLabel('Track').selectOption({ label: 'Agents & Tools' });
	await repair.getByRole('button', { name: 'Save track' }).click();
	await expect(repair).toBeHidden();

	// Repair is its own reviewed change. The sketch remains private until the
	// organizer makes the original lifecycle change again.
	await expect(row.locator('.ui-track__label')).toHaveText('Agents & Tools');
	await row.getByRole('button', { name: 'Add “Unclassified private sketch” to the program' })
		.click();
	await expect(group(page, 'Unplaced').getByText('Unclassified private sketch')).toBeVisible({
		timeout: 10000
	});
});

test('?tray= renames the panel to the tray it scopes, and Clear restores the grouped view', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the scope contract');

	await page.goto('/app/schedule?tray=needs-speakers');
	await expect(program(page)).toBeVisible({ timeout: 15000 });

	// The scope is the panel's own heading while it holds — the arriving person
	// reads the name they clicked where the panel's name normally is — and the
	// count counts the rows underneath it, not the whole pool. Only that one
	// carrier: no chip repeating the heading beside it.
	await expect(program(page).locator('.panel__head h2')).toHaveText('Needs speakers');
	await expect(program(page).locator('.panel__head .panel__count')).toHaveText('1');
	await expect(program(page).locator('.panel__scope .ui-badge')).toHaveCount(0);

	// Only the tray's rows render; the groups stand down while the filter holds.
	await expect(program(page).locator('.pool__row')).toHaveCount(1);
	await expect(page.locator('#pool-ses-13')).toContainText('Closing Keynote');
	await expect(program(page).locator('.pool-group')).toHaveCount(0);

	// One press gives the whole partition back, name and denominator with it,
	// and the address goes clean.
	await program(page).getByRole('button', { name: 'Clear the needs speakers scope' }).click();
	await expect(page).toHaveURL(/\/app\/schedule$/);
	await expect(program(page).locator('.panel__head h2')).toHaveText('Program');
	await expect(program(page).locator('.panel__head .panel__count')).toHaveText('4');
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
		.getByRole('navigation', { name: 'Workspace', exact: true })
		.getByRole('link', { name: 'Overview' })
		.click();
	await expect(attention).toBeVisible({ timeout: 15000 });
	await expect(attention).toContainText('2 sessions await placement');
	await expect(attention).not.toContainText(/program sessions? needs? speakers/);

	// Removal arms in place before it commits, and the receipt takes it back.
	await page
		.getByRole('navigation', { name: 'Workspace', exact: true })
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

test('accepting without a target spawns into the pool, and correction stays forward-only', async ({ page }, testInfo) => {
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

	// Graduation has durable downstream state, so the receipt offers no
	// compensation. The organizer corrects the decision with another verdict.
	await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(receipt).toContainText('Choose another result if this decision needs correcting.');
	await door.click();
	await expect(page).toHaveURL(/\/app\/schedule\?tray=unplaced$/);
	const spawned = program(page)
		.locator('.pool__row')
		.filter({ hasText: 'The Inference Bill Nobody Read' });
	await expect(spawned).toBeVisible({ timeout: 15000 });

	// A later waitlist is the explicit forward correction. The guarded Decision
	// operation retracts the acceptance-created program consequence from current
	// state; no browser before-image or compensation chooses that result.
	await page.getByRole('link', { name: 'Decisions' }).click();
	await expect(row).toBeVisible({ timeout: 15000 });
	await row.getByRole('button', { name: 'Waitlist', exact: true }).click();
	const correction = page.getByRole('status').filter({
		hasText: 'Waitlisted “The Inference Bill Nobody Read”'
	});
	await expect(correction).toBeVisible({ timeout: 10000 });
	await expect(correction.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await page.getByRole('link', { name: 'Schedule' }).click();
	await expect(page).toHaveURL(/\/app\/schedule$/);
	await expect(spawned).toHaveCount(0);
	await expect(
		page.getByRole('region', { name: 'Unplaced', exact: true }).locator('.pool__row')
	).toHaveCount(2);
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
		.getByRole('navigation', { name: 'Workspace', exact: true })
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

	test('a tray arrival marks its placed sessions on the grid, where they are cards among cards', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the arrival contract');

		// Held slots are placed by definition, so this tray's answer exists twice:
		// as a scoped pool row, and as a card in a grid full of similar cards. The
		// mark is asserted first — it is deliberately transient, released once the
		// person takes over.
		await page.goto('/app/schedule?day=day-2&tray=undecided-in-place');
		await expect(page.locator('#placed-ses-19')).toHaveClass(/ui-arrival/, { timeout: 15000 });

		// The same standing treatment every arrival uses, not a second highlight
		// invented for this one: the card keeps its own state classes.
		await expect(page.locator('#placed-ses-19')).toHaveClass(/card--collecting/);

		// And the panel answers by name, for the same arrival.
		await expect(program(page).locator('.panel__head h2')).toHaveText(
			'Held slots awaiting decisions'
		);
		await expect(program(page).locator('.pool__row')).toHaveCount(1);
		await expect(program(page).locator('#pool-ses-19')).toBeVisible();
	});
});
