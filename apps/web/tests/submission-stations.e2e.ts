import { expect, test } from '@playwright/test';

/**
 * The stations-and-arrival contract (design record 23): residence is custody,
 * progress is projection. The inbox groups rows by what each still needs and
 * doors every group to the surface that acts on it; the decision table is a
 * pass that visibly shrinks and hands off when it finishes; arrival is worded
 * on every row, and New marks what arrived since the operator last looked.
 *
 * Cookie-less loads serve the crunch scenario: 14 candidates, 9 undecided,
 * 5 decided (4 needing notice), one late arrival since the last visit.
 */

test('the inbox groups rows by station, in funnel order, with doors', async ({ page }) => {
	await page.goto('/app/submissions');

	const list = page.getByRole('region', { name: 'Submissions' });
	const headers = list.locator('tr.station');
	await expect(headers).toHaveCount(4, { timeout: 15000 });

	// Funnel order, counts computed from the rows on screen. Decided and Done
	// are separate rungs, so a group's claim is true of every row under it.
	await expect(headers.nth(0)).toContainText('In review');
	await expect(headers.nth(0)).toContainText('3');
	await expect(headers.nth(1)).toContainText('Decision needed');
	await expect(headers.nth(1)).toContainText('5');
	await expect(headers.nth(2)).toContainText('Results not sent');
	await expect(headers.nth(2)).toContainText('4');
	await expect(headers.nth(3)).toContainText('Done');
	await expect(headers.nth(3)).toContainText('1');

	// Each header doors to the surface that acts on its rows (R2: the same
	// URLs the nav and the Overview attention item use).
	await expect(headers.nth(0).getByRole('link', { name: 'See review →' })).toHaveAttribute(
		'href',
		'/app/review'
	);
	await expect(headers.nth(1).getByRole('link', { name: 'Decide →' })).toHaveAttribute(
		'href',
		'/app/decisions'
	);
	await headers.nth(2).getByRole('link', { name: 'Send results →' }).click();
	await expect(page).toHaveURL(/\/app\/decisions\?scope=unnotified$/);
	await expect(page.getByText('Results not sent').first()).toBeVisible();
});

test('unfinished rows state their relevant clock, and New marks what arrived since the last visit', async ({
	page
}) => {
	await page.goto('/app/submissions');
	const list = page.getByRole('region', { name: 'Submissions' });
	await expect(list.locator('tr.row').first()).toBeVisible({ timeout: 15000 });

	// Every row states its arrival in the one constant Received slot — the
	// timeline the arrival groups are sorted by, readable straight down the
	// column. The only other clock a row may run, an unsent result's decision
	// age, stays in the metadata sentence and names itself.
	await expect(list.locator('tr.row .when .arrived').first()).toHaveText(
		/(?:just now|\d+ min ago|\d+ h ago|yesterday|\d+ days? ago|\d+ weeks? ago|\d+ months? ago|[A-Z][a-z]{2} \d)/
	);

	// Crunch's inbox has taken nothing new since the operator's previous
	// visit, so no inbox row wears the mark — absence is a claim too.
	await expect(list.locator('tr.row .when').getByText('New', { exact: true })).toHaveCount(0);

	// The one arrival since that visit sits in the late tray: older than a
	// day, but new to this operator — the since-your-last-visit arm. The mark
	// rides beside the arrival fact it qualifies.
	// The trays are a radio group now, so the chip's own face is what is pressed
	// and the checked radio is what says which population is showing.
	const trays = page.getByRole('radiogroup', { name: 'Submission trays' });
	await trays.getByText('Late', { exact: true }).click();
	await expect(trays.getByRole('radio', { name: /^Late/ })).toBeChecked();
	const lateRow = list.locator('tr.row').filter({ hasText: 'Sandboxing Tool Calls' });
	await expect(lateRow.locator('.when').getByText('New', { exact: true })).toBeVisible();
	// And a row that just arrived cannot already carry committed reviews.
	await expect(lateRow).toContainText('No reviews yet');
});

test('a decided row expands to say where it went, and the door lands there', async ({
	page
}, testInfo) => {
	await page.goto('/app/submissions');
	const list = page.getByRole('region', { name: 'Submissions' });
	const row = list.locator('tr.row').filter({ hasText: 'Streaming Agent UIs' });
	await expect(row).toBeVisible({ timeout: 15000 });
	await row.getByRole('button', { name: /Details for/ }).click();

	// Acceptance landed somewhere visible; the expansion carries the durable
	// door there long after the receipt's toast expired.
	const origin = list.locator('.detail__origin');
	await expect(origin).toContainText('Streaming Agent UIs Without a State Machine Meltdown');
	await expect(origin).toHaveAttribute('href', '/app/schedule?session=ses-2');

	// Touch keeps the same address; only the wide table walks it here — the
	// link sits inside the table's own horizontal scroll on small screens.
	if (testInfo.project.name === 'desktop') {
		await origin.click();
		await expect(page).toHaveURL(/\/app\/schedule\?session=ses-2$/);
	}
});

test('a verdict moves the row down into Decided and the pace copy ticks', async ({ page }) => {
	await page.goto('/app/decisions');

	const candidates = page.getByRole('region', { name: 'Candidates' });
	await expect(candidates).toContainText('9 of 14 candidates still to decide', { timeout: 15000 });

	const row = candidates.locator('tr.row').filter({ hasText: 'Deterministic Replay' });
	await row.getByRole('button', { name: 'Accept', exact: true }).click();

	// The working set shrinks and the row lands one group down — recovery is
	// the receipt plus the row's visible landing place, not a confirm.
	await expect(candidates).toContainText('8 of 14 candidates still to decide');
	const headers = candidates.locator('tr.station');
	await expect(headers.nth(0)).toContainText('Still to decide');
	await expect(headers.nth(0)).toContainText('8');
	await expect(headers.nth(1)).toContainText('Decided');
	await expect(headers.nth(1)).toContainText('6');
	const receipt = page.getByRole('status').filter({ hasText: 'Accepted “Deterministic Replay' });
	await expect(receipt).toBeVisible();

	// Undo travels it straight back.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(candidates).toContainText('9 of 14 candidates still to decide');
});

test('finishing the pass hands off: notices, placement, waitlist — doors, not automation', async ({
	page
}) => {
	await page.goto('/app/decisions');
	const candidates = page.getByRole('region', { name: 'Candidates' });
	await expect(candidates.locator('tr.row').first()).toBeVisible({ timeout: 15000 });

	// Decide everything at once through the bulk path's existing confirm.
	await page.getByRole('checkbox', { name: 'Select all candidates' }).check();
	await page.getByRole('toolbar', { name: 'Bulk decisions' }).getByRole('button', { name: 'Accept' }).click();
	await page.getByRole('dialog').getByRole('button', { name: /Accept 14/ }).click();

	// The finale takes the working set's empty slot; the ambient banner
	// yields so the send keeps exactly one door on the page.
	const finale = candidates.locator('.finale');
	await expect(finale).toContainText('Every candidate is decided.', { timeout: 15000 });
	await expect(finale.getByRole('button', { name: 'Send their results' })).toBeVisible();
	await expect(finale.getByRole('link', { name: /Place \d+ sessions/ })).toHaveAttribute(
		'href',
		'/app/schedule?tray=unplaced'
	);
	await expect(page.getByText('not yet sent to the submitter')).toHaveCount(0);
	await expect(candidates).toContainText('All 14 candidates decided');
});

test('j/k walk the pass and a/w/d decide the open row from the keyboard', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'keyboard flow is a desktop contract');

	await page.goto('/app/decisions');
	const candidates = page.getByRole('region', { name: 'Candidates' });
	await expect(candidates.locator('tr.row').first()).toBeVisible({ timeout: 15000 });

	// j opens the first row of the pass; d declines it in place.
	await page.keyboard.press('j');
	await expect(candidates.locator('tr.row.is-open')).toContainText('Deterministic Replay');
	await page.keyboard.press('d');
	await expect(
		page.getByRole('status').filter({ hasText: 'Declined “Deterministic Replay' })
	).toBeVisible();
	await expect(candidates).toContainText('8 of 14 candidates still to decide');
});
