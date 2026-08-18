import { expect, test } from '@playwright/test';

/**
 * Who submitted this, answered from the row it was submitted on.
 *
 * The contract has three halves worth holding: a name with a profile behind it
 * is a control, a name without one is a word; the profile says what the person
 * is to *this* event, not only what they say about themselves; and the
 * presentation follows the pointer — an anchored panel where there is room
 * beside the row, a dialog where there is not.
 */

const CRUNCH = 'crunch';
const FLIGHT = 'flight';

// The peek's cast is the mid-flight scenario's: Maya's authored profile, the
// plain names beside it, and the anonymized round. The double-submitter
// describe below re-pins the crowded scenario it needs.
test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: 'je-scenario', value: FLIGHT, url: baseURL ?? 'http://127.0.0.1:4173' }
	]);
});

test('a profiled submitter opens beside the row, and Escape gives the name back', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'anchored-panel presentation contract');

	await page.goto('/app/submissions');

	const trigger = page.getByRole('button', { name: 'Maya Lindqvist — speaker profile' });
	await expect(trigger).toBeVisible({ timeout: 15000 });
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');

	// Press, not hover: the disclosure has to be reachable from the keyboard.
	await trigger.press('Enter');
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');

	const panelId = await trigger.getAttribute('aria-controls');
	const panel = page.locator(`#${panelId}`);
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('cache correctness');
	await expect(panel).toContainText('Stockholm, Sweden');

	// The addresses that let someone be assessed are real destinations, not
	// decoration, and each says which network it belongs to before its handle.
	const x = panel.getByRole('link', { name: 'X: @maya_lindqvist' });
	await expect(x).toHaveAttribute('href', 'https://x.com/maya_lindqvist');
	await expect(x).toHaveAttribute('target', '_blank');
	await expect(x).toHaveAttribute('rel', /noopener/);
	await expect(panel.getByRole('link', { name: 'LinkedIn: maya-lindqvist' })).toHaveAttribute(
		'href',
		'https://www.linkedin.com/in/maya-lindqvist'
	);
	await expect(panel.getByRole('link', { name: 'Website: nordicweb.dev' })).toHaveAttribute(
		'href',
		'https://nordicweb.dev'
	);

	// And they come first, ahead of where she lives: the owner's call is that the
	// opening line of a profile is what lets you assess the person.
	const reading = await panel.innerText();
	expect(reading.indexOf('@maya_lindqvist')).toBeGreaterThan(-1);
	expect(reading.indexOf('@maya_lindqvist')).toBeLessThan(reading.indexOf('Stockholm, Sweden'));

	// What she is to this event: the count, the session she already holds, and
	// the way to her roster entry — scoped to her row, not to the roster.
	await expect(panel).toContainText(/\d+ submissions? this event/);
	// The peek's in-app doors open a new window — the quick look never costs the
	// table its place — and each says so in its own name, not only its glyph.
	const sessionLink = panel.getByRole('link', {
		name: 'Context Caching Without Tears — opens in new window'
	});
	await expect(sessionLink).toHaveAttribute('href', '/app/schedule?session=ses-2');
	await expect(sessionLink).toHaveAttribute('target', '_blank');
	// A placed session says when and where without costing a trip to Schedule —
	// the question a cancellation makes urgent. Real text, so it is read out
	// with the title rather than hidden in the link's name.
	await expect(panel).toContainText('Tue Oct 13 · 10:30–11:00 · Main Stage');
	const recordLink = panel.getByRole('link', { name: 'Open record — opens in new window' });
	await expect(recordLink).toHaveAttribute('href', '/app/speakers/spk-1');
	await expect(recordLink).toHaveAttribute('target', '_blank');

	// The panel is painted over the row but still descends from it, so a press on
	// its own words has to belong to the profile — not to the row's detail
	// expansion hiding behind it.
	await panel.getByText('cache correctness').click();
	await expect(panel).toBeVisible();
	await expect(page.locator('tr.detail-row')).toHaveCount(0);

	await page.keyboard.press('Escape');
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await expect(trigger).toBeFocused();
});

test('the peek’s door lands on that speaker’s own record', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the door contract');

	await page.goto('/app/submissions');

	const trigger = page.getByRole('button', { name: 'Maya Lindqvist — speaker profile' });
	await expect(trigger).toBeVisible({ timeout: 15000 });
	await trigger.click();

	const panelId = await trigger.getAttribute('aria-controls');

	// The door opens a new window, so the submissions table keeps its place; the
	// arrival is asserted in the window the door actually opened.
	const popupPromise = page.context().waitForEvent('page');
	await page
		.locator(`#${panelId}`)
		.getByRole('link', { name: 'Open record — opens in new window' })
		.click();
	const record_page = await popupPromise;

	await expect(record_page).toHaveURL(/\/app\/speakers\/spk-1$/);
	await expect(page).toHaveURL(/\/app\/submissions$/);

	// A record's own page is the whole answer, so nothing needs marking: the
	// heading names her, and the record opens on what is wrong.
	const record = record_page.getByRole('region', { name: 'Speaker record' });
	await expect(record.getByRole('heading', { name: 'Maya Lindqvist', level: 2 })).toBeVisible({
		timeout: 15000
	});
	await expect(record_page.getByText('Maya Lindqvist asked to cancel.')).toBeVisible();
});

test('a speaker address opens their row wherever the roster is a card', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'the card composition owns narrow widths');

	// The address is the contract, so a link that arrives from anywhere — pasted,
	// shared, produced by an agent — has to land the same way. Below the
	// breakpoint the roster is a list of cards, and the arrival goes to the
	// composition that is actually on screen rather than the hidden table.
	await page.goto('/app/speakers?speaker=spk-1');

	const roster = page.getByRole('region', { name: 'Speaker roster' });
	// The reworked roster highlights the arrival and keeps the record one press
	// away; the card's own open control is the focusable door.
	await expect(
		roster.getByRole('link', { name: "Open Maya Lindqvist's record" }).filter({ visible: true })
	).toHaveAttribute('href', '/app/speakers/spk-1', { timeout: 15000 });
	await expect(roster.locator('[data-speaker="spk-1"]').filter({ visible: true })).toBeFocused();
});

test('a submitter with no profile stays a word, not a control', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the affordance contract');

	await page.goto('/app/submissions');

	const list = page.getByRole('region', { name: 'Submissions' });
	await expect(list).toContainText('Amara Okafor', { timeout: 15000 });
	// Nothing was written about her, so nothing on the row offers to show it.
	await expect(page.getByRole('button', { name: /Amara Okafor/ })).toHaveCount(0);

	// A pair on one submission, one of each kind, still reads as one line.
	await expect(list).toContainText('Elif Aydın, Marc Dubois');
	await expect(page.getByRole('button', { name: 'Elif Aydın — speaker profile' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Marc Dubois/ })).toHaveCount(0);
});

test('a blind review plan gains no way to look the submitter up', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the anonymity contract');

	await page.goto('/app/review');
	await expect(page.getByText('Anonymized')).toBeVisible({ timeout: 15000 });

	// The queue cards name no submitter at all under a blind plan, so there is
	// nothing for the peek to attach to.
	const queue = page.getByRole('region', { name: 'My queue' });
	await expect(queue.getByRole('button', { name: /speaker profile/ })).toHaveCount(0);
});

/**
 * The same contract, wherever a name is shown to someone allowed to see it: the
 * name is the control, a name with nothing behind it is a word, and the answer
 * arrives without leaving the surface that raised the question.
 */

test('a candidate row answers who submitted it', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the adoption contract');

	await page.goto('/app/decisions');

	const candidates = page.getByRole('region', { name: 'Candidates' });
	const trigger = candidates.getByRole('button', { name: 'Maya Lindqvist — speaker profile' });
	await expect(trigger).toBeVisible({ timeout: 15000 });

	await trigger.press('Enter');
	const panelId = await trigger.getAttribute('aria-controls');
	const panel = page.locator(`#${panelId}`);
	await expect(panel).toContainText('cache correctness');
	await expect(panel).toContainText(/\d+ submissions? this event/);

	// Nothing was written about her, so her candidate row keeps a plain name.
	await expect(candidates).toContainText('Amara Okafor');
	await expect(candidates.getByRole('button', { name: /Amara Okafor/ })).toHaveCount(0);
});

test('a task row answers who the outstanding work belongs to', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the matrix owns wide widths');

	await page.goto('/app/tasks');

	const board = page.getByRole('region', { name: 'Speaker tasks' });
	const trigger = board.getByRole('button', { name: 'Maya Lindqvist — speaker profile' });
	await expect(trigger).toBeVisible({ timeout: 15000 });

	await trigger.press('Enter');
	const panelId = await trigger.getAttribute('aria-controls');
	await expect(page.locator(`#${panelId}`)).toContainText('cache correctness');

	// On the roster, with tasks of his own, and nothing written about him. His
	// cells are named after him — that is the matrix doing its job — so what has
	// to be absent is a profile to open, not every control that says his name.
	await expect(board).toContainText('Lukas Brandt');
	await expect(board.getByRole('button', { name: /Lukas Brandt — speaker profile/ })).toHaveCount(
		0
	);
});

test('a placed session answers who is on it, from the card', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the board is a wide-width composition');

	// The card clips itself to its slot span, so the profile has to escape it:
	// the panel is painted in the top layer, not inside the card's overflow.
	const card = page.locator('#placed-ses-2');
	await page.goto('/app/schedule');
	await expect(card).toBeVisible({ timeout: 15000 });

	const trigger = card.getByRole('button', { name: 'Maya Lindqvist — speaker profile' });
	await trigger.press('Enter');
	const panelId = await trigger.getAttribute('aria-controls');
	const panel = page.locator(`#${panelId}`);
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('cache correctness');
	await expect(panel).toContainText('Stockholm, Sweden');

	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();

	// The keynote's speaker is on the roster with nothing written about him, so
	// that card names him and offers nothing to open.
	const keynote = page.locator('#placed-ses-1');
	await expect(keynote).toContainText('Ravi Chandran');
	await expect(keynote.getByRole('button', { name: /Ravi Chandran/ })).toHaveCount(0);
});

test.describe('a submitter who wrote in twice', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		// The crowded scenario is the one where the same address arrives on more
		// than one submission, which is the whole reason the count is stated.
		await context.addCookies([
			{ name: 'je-scenario', value: CRUNCH, url: baseURL ?? 'http://127.0.0.1:4173' }
		]);
	});

	test('is counted across this event, from either of their rows', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the counting contract');

		await page.goto('/app/submissions');

		const trigger = page.getByRole('button', { name: 'Marc Dubois — speaker profile' }).first();
		await expect(trigger).toBeVisible({ timeout: 15000 });
		await trigger.click();

		const panelId = await trigger.getAttribute('aria-controls');
		const panel = page.locator(`#${panelId}`);
		await expect(panel).toContainText('2 submissions this event');
		await expect(panel).toContainText('Lyon, France');
	});
});

test('the peek takes the screen where there is no room beside the row', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'coarse-pointer presentation contract');

	await page.goto('/app/submissions');

	const trigger = page.getByRole('button', { name: 'Maya Lindqvist — speaker profile' });
	await expect(trigger).toBeVisible({ timeout: 15000 });
	await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
	await trigger.click();

	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	// The same facts in the same order, in the presentation this width can hold.
	await expect(dialog).toContainText('cache correctness');
	await expect(dialog.getByRole('link', { name: 'X: @maya_lindqvist' })).toHaveAttribute(
		'href',
		'https://x.com/maya_lindqvist'
	);
	const reading = await dialog.innerText();
	expect(reading.indexOf('@maya_lindqvist')).toBeLessThan(reading.indexOf('Stockholm, Sweden'));
	await expect(dialog).toContainText(/\d+ submissions? this event/);
	await expect(dialog).toContainText('Context Caching Without Tears');

	// Same rule at this width: the dialog's own content is not a press on the row.
	await dialog.getByText('cache correctness').click();
	await expect(dialog).toBeVisible();
	await expect(page.locator('tr.detail-row')).toHaveCount(0);

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
});
