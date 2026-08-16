import { expect, test, type Page } from '@playwright/test';

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
 * The Forms area and its seam with the application surface: forms decide what
 * is asked (a checklist over the one shared registry — include/exclude,
 * per-form requiredness, vocabulary-option exposure), the surface decides how
 * it looks and previews whichever form the address names, and the two link to
 * each other through doors that carry the form in the URL.
 */

async function openForms(page: Page) {
	await page.goto('/app/forms');
	await expect(page.getByRole('region', { name: 'Forms' })).toContainText('Call for Proposals', {
		timeout: 15000
	});
}

/** The visible receipt (the sr-only status line repeats its words for assistive tech). */
function receiptOf(page: Page, text: string) {
	return page.locator('.receipt', { hasText: text });
}

async function openConfigurator(page: Page, formId: string, name: string) {
	await page.goto(`/app/forms?form=${formId}`);
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('region', { name: 'Questions' }).locator('.qrow__label').first()).toBeVisible({
		timeout: 15000
	});
}

test('form cards derive their question counts and open enabled doors', async ({ page }) => {
	await openForms(page);
	const cards = page.getByRole('region', { name: 'Forms' });

	// Derived, never hand-written: the standard CFP asks the full apply set.
	const cfp = cards.locator('.card').filter({ hasText: 'Call for Proposals' });
	await expect(cfp).toContainText('15 questions');
	const panel = cards.locator('.card').filter({ hasText: 'Panelist Application' });
	await expect(panel).toContainText('6 questions');

	// Both doors act — no disabled stubs.
	await expect(cfp.getByRole('link', { name: 'Questions' })).toBeVisible();
	await expect(cfp.getByRole('link', { name: 'Preview' })).toHaveAttribute(
		'href',
		'/app/templates?tab=surfaces&template=srf-application-form&form=form-cfp'
	);

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('ticks stage locally and commit together on Apply, with forward correction copy', async ({
	page
}) => {
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	// Unticking is instant in the checklist — the group count follows the draft —
	// but the form itself has not changed: the header still counts 14.
	await page.getByLabel('Ask “Where you’re based” on this form').uncheck();
	await expect(page.locator('.qgroup__label').first()).toContainText('2 of 3 asked');
	await expect(page.locator('.conf__meta')).toContainText('15 questions');

	// The commit sits with the change; the floating twin offers it meanwhile.
	const applyRow = page.locator('.applyrow');
	await expect(applyRow).toContainText('Apply 1 change');
	await applyRow.getByRole('button', { name: 'Apply 1 change' }).click();

	const receipt = receiptOf(page, 'Applied 1 question change to Call for Proposals');
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(page.locator('.conf__meta')).toContainText('14 questions');
	await expect(applyRow).toHaveCount(0);

	await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(receipt).toContainText('Edit the current questions and apply another change');
	await page.getByLabel('Ask “Where you’re based” on this form').check();
	await page.locator('.applyrow').getByRole('button', { name: 'Apply 1 change' }).click();
	await expect(page.locator('.conf__meta')).toContainText('15 questions', { timeout: 10000 });
	await expect(page.getByLabel('Ask “Where you’re based” on this form')).toBeChecked();
});

test('the floating Apply bar shows while the in-flow row is out of view, and yields to it', async ({
	page
}) => {
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	// Nothing pending, nothing offered.
	await expect(page.locator('.applybar')).not.toHaveClass(/applybar--in/);

	// A tick near the top leaves the in-flow Apply row below the fold; the
	// floating twin carries the commit until that row is reachable.
	await page.getByLabel('Ask “Where you’re based” on this form').uncheck();
	await expect(page.locator('.applybar')).toHaveClass(/applybar--in/, { timeout: 5000 });

	await page.locator('.applyrow').scrollIntoViewIfNeeded();
	await expect(page.locator('.applybar')).not.toHaveClass(/applybar--in/, { timeout: 5000 });

	// Discard drops the session; both commits disappear.
	await page.locator('.applyrow').getByRole('button', { name: 'Discard changes' }).click();
	await expect(page.locator('.applyrow')).toHaveCount(0);
	await expect(page.getByLabel('Ask “Where you’re based” on this form')).toBeChecked();
});

test('the locked email question is always asked, with its standing reason in place', async ({
	page
}) => {
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	const box = page.getByLabel('Ask “Email” on this form');
	await expect(box).toBeChecked();
	await expect(box).toBeDisabled();
	await expect(page.getByText('Email is the application’s key — every form asks it.')).toBeVisible();
});

test('per-form requiredness overrides stage in the draft and clear without a commit', async ({
	page
}) => {
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	// Staging the override marks the deviation immediately — no commit yet.
	const row = page.locator('.qrow', { hasText: 'Headline' });
	await row.getByLabel('Required').uncheck();
	const useDefault = row.getByRole('button', { name: 'Use shared default' });
	await expect(useDefault).toBeVisible();
	await expect(page.locator('.applyrow')).toContainText('Apply 1 change');

	// Returning to the shared default empties the session; nothing to apply.
	await useDefault.click();
	await expect(useDefault).not.toBeVisible();
	await expect(row.getByLabel('Required')).toBeChecked();
	await expect(page.locator('.applyrow')).toHaveCount(0);
});

test('a sourced question offers the live vocabulary, and exposure narrows it per form', async ({
	page
}) => {
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	const row = page.locator('.qrow', { hasText: 'Track' });
	await expect(row).toContainText('Options come from your tracks');
	await expect(row).toContainText('offering all 3, new tracks included');

	await row.getByRole('button', { name: 'Choose options' }).click();
	await row.getByLabel('Models & Infrastructure').uncheck();
	await expect(row).toContainText('offering 2 of 3 · new tracks stay hidden');
	await page.locator('.applyrow').getByRole('button', { name: 'Apply 1 change' }).click();
	await expect(receiptOf(page, 'Applied 1 question change to Call for Proposals')).toBeVisible({
		timeout: 10000
	});

	// Back to the live default is a staged act like any other.
	await row.getByRole('button', { name: 'Offer all, future ones too' }).click();
	await expect(row).toContainText('offering all 3, new tracks included');
	await page.locator('.applyrow').getByRole('button', { name: 'Apply 1 change' }).click();
	await expect(page.locator('.applyrow')).toHaveCount(0, { timeout: 10000 });
});

test('a question added here is scoped to this form and placed by the advisor', async ({ page }) => {
	await openConfigurator(page, 'form-panel', 'Agent Reliability Panelist Application');

	await page.getByLabel('Label').fill('Your angle on reliability');
	await page.getByRole('button', { name: 'Add question' }).click();

	const row = page.locator('.qrow', { hasText: 'Your angle on reliability' });
	await expect(row).toBeVisible({ timeout: 10000 });
	await expect(row).toContainText('Only this form');
	// The advisor speaks once, on arrival.
	await expect(row.locator('.qrow__placed')).toBeVisible();

	// Scoped means scoped: the open CFP's checklist never rows it. In-app
	// navigation keeps the workspace; a reload would start a fresh sample.
	await page.getByRole('link', { name: 'All forms' }).click();
	await page
		.getByRole('region', { name: 'Forms' })
		.locator('.card')
		.filter({ hasText: 'Call for Proposals' })
		.getByRole('link', { name: 'Questions' })
		.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Call for Proposals' })).toBeVisible({
		timeout: 15000
	});
	await expect(page.locator('.qrow__label').first()).toBeVisible({ timeout: 15000 });
	await expect(page.locator('.qrow', { hasText: 'Your angle on reliability' })).toHaveCount(0);

	// Clean up through the same door it was made in.
	await page.getByRole('link', { name: 'All forms' }).click();
	await page
		.getByRole('region', { name: 'Forms' })
		.locator('.card')
		.filter({ hasText: 'Panelist Application' })
		.getByRole('link', { name: 'Questions' })
		.click();
	const made = page.locator('.qrow', { hasText: 'Your angle on reliability' });
	await expect(made).toBeVisible({ timeout: 15000 });
	await made.getByRole('button', { name: 'Remove “Your angle on reliability”' }).click();
	await expect(made).toHaveCount(0, { timeout: 10000 });
});

test('a real drag reorders the questions — vertical, committed on drop, undone by the receipt', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the pointer drag is covered once; keyboard covers both');
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	const labels = page.locator('.qrow__label');
	const before = await labels.allInnerTexts();
	const from = before.indexOf('Talk title');
	expect(before[from + 1]).toBe('Abstract');

	// Grab the handle and pull the row below its neighbour; the drop commits.
	const grip = page.getByRole('button', { name: 'Reorder “Talk title” — drag, or press the arrow keys' });
	const gripBox = (await grip.boundingBox())!;
	const targetRow = page.locator('.qrow', { hasText: 'Abstract' });
	const targetBox = (await targetRow.boundingBox())!;
	await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(gripBox.x + gripBox.width / 2, targetBox.y + targetBox.height + 4, {
		steps: 8
	});
	await page.mouse.up();

	await expect(labels.nth(from)).toHaveText('Abstract', { timeout: 10000 });
	await expect(labels.nth(from + 1)).toHaveText('Talk title');
	const receipt = receiptOf(page, 'Moved “Talk title” before “Format”');
	await expect(receipt).toBeVisible({ timeout: 10000 });

	// Order is registry truth, so the preview serves it too — and undo restores.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(labels.nth(from)).toHaveText('Talk title', { timeout: 10000 });
	await expect(labels.nth(from + 1)).toHaveText('Abstract');
});

test('arrow keys on the handle reorder one step per press, focus travelling with the row', async ({
	page
}) => {
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	const labels = page.locator('.qrow__label');
	const before = await labels.allInnerTexts();
	const at = before.indexOf('Website');
	expect(before[at + 1]).toBe('LinkedIn');

	const grip = page.getByRole('button', { name: 'Reorder “Website” — drag, or press the arrow keys' });
	await grip.focus();
	await grip.press('ArrowDown');
	await expect(labels.nth(at)).toHaveText('LinkedIn', { timeout: 10000 });
	await expect(labels.nth(at + 1)).toHaveText('Website');
	await expect(grip).toBeFocused();

	await grip.press('ArrowUp');
	await expect(labels.nth(at)).toHaveText('Website', { timeout: 10000 });
	await expect(labels.nth(at + 1)).toHaveText('LinkedIn');
});

test('the surface previews the form the address names, and the doors carry it both ways', async ({
	page
}) => {
	// Arrive through the card's Preview door, as an operator would.
	await openForms(page);
	await page
		.getByRole('region', { name: 'Forms' })
		.locator('.card')
		.filter({ hasText: 'Panelist Application' })
		.getByRole('link', { name: 'Preview' })
		.click();

	await expect(page).toHaveURL(/tab=surfaces&template=srf-application-form&form=form-panel/);
	const lens = page.getByLabel('Previewing as');
	await expect(lens).toHaveValue('form-panel', { timeout: 15000 });

	// The preview is the actual form: excluded questions are gone, kept ones render.
	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('Email', { timeout: 15000 });
	await expect(preview).not.toContainText('Track');
	await expect(preview.getByText('Headline')).toBeVisible();

	// Switching the lens is instant and lands in the address.
	await lens.selectOption('');
	await expect(page).not.toHaveURL(/form=/);
	await expect(preview.getByText('Track')).toBeVisible();

	await lens.selectOption('form-evergreen');
	await expect(page).toHaveURL(/form=form-evergreen/);
	// Exposure narrows the served select to the form's two tracks.
	const trackSelect = preview.locator('select').filter({ has: page.locator('option', { hasText: 'Agents & Tools' }) });
	await expect(trackSelect.locator('option')).toHaveCount(3); // Select… + 2 exposed tracks
	await expect(trackSelect.locator('option', { hasText: 'Models & Infrastructure' })).toHaveCount(0);

	// The door back to the form side carries the same form.
	await page.getByRole('link', { name: 'Configure its questions' }).click();
	await expect(page).toHaveURL(/\/app\/forms\?form=form-evergreen/);
	await expect(
		page.getByRole('heading', { level: 1, name: 'Speak at a Future AI Engineer Event' })
	).toBeVisible({ timeout: 15000 });
});

test('a new form starts as the standard application and opens on its questions', async ({
	page
}) => {
	await openForms(page);
	await page.getByRole('button', { name: 'New form' }).click();

	await page.getByLabel('Name').fill('Lightning talk applications');
	// The target choice describes itself: each option carries its consequence.
	await page.getByRole('combobox', { name: 'Collects for' }).click();
	const pool = page.getByRole('option', { name: /A category pool/ });
	await expect(pool).toContainText('no scheduled day yet');
	await pool.click();
	// A category target names its category: the reference field appears with the
	// choice, already valid — the first live track is preselected.
	const category = page.getByLabel('Which track or format');
	await expect(category).toBeVisible();
	await category.selectOption({ label: 'Models & Infrastructure' });
	await page.getByRole('button', { name: 'Create form' }).click();

	await expect(
		page.getByRole('heading', { level: 1, name: 'Lightning talk applications' })
	).toBeVisible({ timeout: 15000 });
	// Complete from the start: the full apply set, ready to trim — and the
	// target's reference resolves to its live name.
	await expect(page.locator('.conf__meta')).toContainText('15 questions');
	await expect(page.locator('.conf__meta')).toContainText(
		'Collects for the Models & Infrastructure track'
	);
	await expect(page.locator('.conf__title')).toContainText('Draft');
});

test('a session target is offered from live collecting sessions and lands on the form', async ({
	page
}) => {
	await openForms(page);
	await page.getByRole('button', { name: 'New form' }).click();

	await page.getByLabel('Name').fill('Panelists for the infra panel');
	await page.getByRole('combobox', { name: 'Collects for' }).click();
	// The option exists only because sessions are actually collecting proposals.
	await page.getByRole('option', { name: /One specific session/ }).click();
	const session = page.getByLabel('Which session');
	await expect(session).toBeVisible();
	await session.selectOption({ label: 'Panel: Durable Agent Infrastructure' });
	await page.getByRole('button', { name: 'Create form' }).click();

	await expect(
		page.getByRole('heading', { level: 1, name: 'Panelists for the infra panel' })
	).toBeVisible({ timeout: 15000 });
	await expect(page.locator('.conf__meta')).toContainText(
		'Collects proposals for “Panel: Durable Agent Infrastructure”'
	);
});

test('the close date is edited where the form is configured, with forward correction copy', async ({
	page
}) => {
	await openConfigurator(page, 'form-cfp', 'Call for Proposals');

	// The open CFP carries its close date; moving it commits immediately.
	const closes = page.locator('#form-closes');
	await expect(closes).not.toHaveValue('');
	await closes.fill('2027-06-30');
	await closes.press('Enter');
	const receipt = receiptOf(page, '“Call for Proposals” now closes Jun 30, 2027');
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(closes).toHaveValue('2027-06-30');

	// Destructive but secondary: danger ink and a danger-toned border on a quiet
	// base, never the filled red that belongs to a confirming press in a dialog
	// — and never the ghost that hid the consequence altogether. The region's
	// one accent-dominant slot stays with the lifecycle commit beside it.
	const removeClose = page.getByRole('button', { name: 'Remove close date' });
	await expect(removeClose).toHaveClass(/ui-button--danger-quiet/);
	await expect(removeClose).not.toHaveClass(/ui-button--danger\s/);
	await expect(page.locator('.conf__intake .ui-button--danger:not(.ui-button--danger-quiet)')).toHaveCount(0);

	// Removing it is the evergreen state, said in words on the card list.
	await removeClose.click();
	await expect(receiptOf(page, 'Removed the close date')).toBeVisible({ timeout: 10000 });
	await expect(closes).toHaveValue('');
	await expect(page.getByRole('button', { name: 'Remove close date' })).toHaveCount(0);

	const removed = receiptOf(page, 'Removed the close date');
	await expect(removed.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(removed).toContainText('Edit the current close date and apply another change');
	await closes.fill('2027-06-30');
	await closes.press('Enter');
	await expect(closes).toHaveValue('2027-06-30', { timeout: 10000 });
});

test('the lifecycle walks forward beside the close date: open, close, reopen', async ({ page }) => {
	await openForms(page);
	await page.getByRole('button', { name: 'New form' }).click();
	await page.getByLabel('Name').fill('Lifecycle rehearsal');
	await page.getByRole('button', { name: 'Create form' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Lifecycle rehearsal' })).toBeVisible({
		timeout: 15000
	});
	await expect(page.locator('.conf__title')).toContainText('Draft');

	// Publication is a visible two-press owner review; closing it performs no write.
	await page.getByRole('button', { name: 'Publish and open' }).click();
	const review = page.getByRole('dialog', { name: 'Review publication' });
	await expect(review).toContainText('Lifecycle rehearsal');
	await expect(review.getByText('Open', { exact: true })).toBeVisible();
	await review.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.locator('.conf__title')).toContainText('Draft');
	await page.getByRole('button', { name: 'Publish and open' }).click();
	await page.getByRole('dialog', { name: 'Review publication' })
		.getByRole('button', { name: 'Publish and open' }).click();
	const opened = receiptOf(page, 'Published and opened “Lifecycle rehearsal”');
	await expect(opened).toBeVisible({ timeout: 10000 });
	await expect(opened.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(page.locator('.conf__title')).toContainText('Open');

	await page.getByRole('button', { name: 'Close form' }).click();
	await expect(receiptOf(page, 'Closed “Lifecycle rehearsal”')).toBeVisible({ timeout: 10000 });
	await expect(page.locator('.conf__title')).toContainText('Closed');

	await page.getByRole('button', { name: 'Reopen form' }).click();
	await expect(receiptOf(page, 'Reopened “Lifecycle rehearsal”')).toBeVisible({ timeout: 10000 });
	await expect(page.locator('.conf__title')).toContainText('Open');
});
