import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Inline editing (click-to-edit) over template previews: the hover cue on
 * addressable units, the floating mini-editor beside the unit on a fine
 * pointer, the bottom sheet on touch, live-to-view editing (every change
 * re-renders the preview; commit stays on Done), commit semantics (one
 * revision per editor session, receipt with a working undo), merge-chip
 * swapping, the tiered numeric size picker with its clamped direct entry,
 * variable insertion, the schedule layout knobs, form-surface text and
 * registry-backed question edits, draft refinement while an AI round is open,
 * and the two close-without-applying paths (Escape, outside press).
 */

/** The floating/sheet mini-editor panel. */
function editor(page: Page): Locator {
	return page.locator('.ied');
}

async function openAccepted(page: Page) {
	await page.goto('/app/templates?template=tpl-decision-accepted');
	await expect(page.getByRole('heading', { name: 'Decision — accepted' })).toBeVisible({
		timeout: 15000
	});
	await expect(page.locator('[data-edit="blocks.0.text"]')).toBeVisible({ timeout: 15000 });
}

test('hovering a text run paints the dashed cue on that unit only', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'fine-pointer hover cue contract');
	await openAccepted(page);

	const heading = page.locator('[data-edit="blocks.0.text"]');
	// The affordance is a dashed outline that is transparent at rest — geometry
	// held, paint off — and takes muted ink under the pointer.
	await expect(heading).toHaveCSS('outline-style', 'dashed');
	const rest = await heading.evaluate((el) => getComputedStyle(el).outlineColor);
	await heading.hover({ position: { x: 12, y: 12 } });
	await expect
		.poll(async () => heading.evaluate((el) => getComputedStyle(el).outlineColor))
		.not.toBe(rest);
	// The unit under the pointer is the only one cued.
	const paragraph = page.locator('[data-edit="blocks.1.text"]');
	expect(await paragraph.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(rest);
});

test('clicking a heading opens the floating editor beside it and Done commits one revision with undo', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'anchored-panel presentation contract');
	await openAccepted(page);

	const heading = page.locator('[data-edit="blocks.0.text"]');
	// Near the start of the line: the press must land on the text run, not on
	// the merge chip the heading also carries.
	await heading.click({ position: { x: 12, y: 12 } });
	const panel = editor(page);
	await expect(panel).toBeVisible();
	await expect(page.getByRole('dialog', { name: 'Edit heading' })).toBeVisible();

	// Anchored, not covering: the panel sits fully below or fully above the unit.
	const unitBox = (await heading.boundingBox())!;
	const panelBox = (await panel.boundingBox())!;
	const below = panelBox.y >= unitBox.y + unitBox.height - 2;
	const above = panelBox.y + panelBox.height <= unitBox.y + 2;
	expect(below || above).toBe(true);

	// The input opens on the raw text, merge tokens included.
	const input = panel.getByRole('textbox');
	await expect(input).toHaveValue('You’re in, {{speaker.name}}');
	await input.fill('Welcome aboard, {{speaker.name}}');
	await panel.getByRole('button', { name: 'Done' }).click();

	// One revision, attributed to you, with a receipt that can undo.
	const receipt = page
		.getByRole('status')
		.filter({ hasText: /Edited heading in “Decision — accepted”/ });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(page.locator('[data-edit="blocks.0.text"]')).toContainText(
		'Welcome aboard, Maya Lindqvist'
	);
	const revisions = page.getByLabel('Revision history');
	await expect(revisions).toHaveValue('2');

	// Undo restores the prior wording — history moves forward to revision 3,
	// and the inline revision stays in history, attributed to you with its note.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(page.locator('[data-edit="blocks.0.text"]')).toContainText('You’re in', {
		timeout: 10000
	});
	await expect(page.locator('[data-edit="blocks.0.text"]')).not.toContainText('Welcome aboard');
	await expect(revisions).toHaveValue('3');
	await expect(revisions.locator('option', { hasText: 'rev 2 — you · Edited heading' })).toHaveCount(
		1
	);
});

test('Escape and an outside press close the editor without applying', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'fine-pointer close-path contract');
	await openAccepted(page);

	const heading = page.locator('[data-edit="blocks.0.text"]');
	const panel = editor(page);

	await heading.click({ position: { x: 12, y: 12 } });
	await expect(panel).toBeVisible();
	await panel.getByRole('textbox').fill('Discarded wording');
	await page.keyboard.press('Escape');
	await expect(panel).toHaveCount(0);
	await expect(heading).toContainText('You’re in');

	await heading.click({ position: { x: 12, y: 12 } });
	await expect(panel).toBeVisible();
	await panel.getByRole('textbox').fill('Discarded again');
	// A press outside the panel and the unit closes without applying.
	await page.getByRole('heading', { name: 'Decision — accepted' }).click();
	await expect(panel).toHaveCount(0);
	await expect(heading).toContainText('You’re in');
	await expect(page.getByLabel('Revision history')).toHaveValue('1');
});

test('typing live-updates the preview before Done, and Cancel snaps it back exactly', async ({ page }) => {
	await openAccepted(page);

	const heading = page.locator('[data-edit="blocks.0.text"]');
	await heading.click({ position: { x: 12, y: 12 } });
	const panel = editor(page);
	await expect(panel).toBeVisible();

	// The preview re-renders on the keystrokes: the artifact already says it…
	await panel.getByRole('textbox').fill('Live wording, {{speaker.name}}');
	await expect(heading).toContainText('Live wording, Maya Lindqvist');
	// …while nothing has committed: the editor stays open, history unmoved.
	await expect(panel).toBeVisible();
	await expect(page.getByLabel('Revision history')).toHaveValue('1');
	await expect(page.getByRole('status').filter({ hasText: /Edited heading/ })).toHaveCount(0);

	// Cancel drops the working copy: the pre-edit artifact returns exactly.
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel).toHaveCount(0);
	await expect(heading).toContainText('You’re in, Maya Lindqvist');
	await expect(heading).not.toContainText('Live wording');
	await expect(page.getByLabel('Revision history')).toHaveValue('1');
});

test('a press on the unit mid-edit keeps the session, and Done still commits', async ({ page }) => {
	await openAccepted(page);

	const heading = page.locator('[data-edit="blocks.0.text"]');
	await heading.click({ position: { x: 12, y: 12 } });
	const panel = editor(page);
	await expect(panel).toBeVisible();
	await panel.getByRole('textbox').fill('Welcome aboard, {{speaker.name}}');
	await expect(heading).toContainText('Welcome aboard');

	// Pointing back at the live words must not reseed the session…
	await heading.click({ position: { x: 12, y: 12 } });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('textbox')).toHaveValue('Welcome aboard, {{speaker.name}}');

	// …or hand Done the pending words as the opening value: it still commits.
	await panel.getByRole('button', { name: 'Done' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Edited heading in “Decision — accepted”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(heading).toContainText('Welcome aboard, Maya Lindqvist');
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
});

test('the size picker leads with recommended px, previews live, and the note says px', async ({ page }) => {
	await openAccepted(page);

	// The unstyled heading renders at the heading kind's base size.
	const heading = page.locator('[data-edit="blocks.0.text"]');
	await expect(heading).toHaveCSS('font-size', '24px');
	await heading.click({ position: { x: 12, y: 12 } });

	const panel = editor(page);
	await expect(page.getByRole('dialog', { name: 'Edit heading' })).toBeVisible();

	// A compact trigger names the current px; opening leads with Recommended.
	await panel.getByRole('button', { name: 'Size: 24 px' }).click();
	const listbox = panel.getByRole('listbox', { name: 'Text size' });
	await expect(listbox).toBeVisible();
	const recommended = listbox.getByRole('group', { name: 'Recommended' });
	await expect(recommended.getByRole('option')).toHaveCount(4);
	// The base names itself as the default, and the current value is selected.
	await expect(recommended.getByRole('option', { name: /24 px/ })).toContainText('Default');
	await expect(recommended.getByRole('option', { name: /24 px/ })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	// The full bounded range sits one step deeper.
	await expect(listbox.getByRole('group', { name: 'All sizes' }).getByRole('option', { name: '10 px' })).toHaveCount(1);

	// Picking a recommended step live-previews before any commit.
	await recommended.getByRole('option', { name: /28 px/ }).click();
	await expect(heading).toHaveCSS('font-size', '28px');
	await expect(panel).toBeVisible();
	await expect(page.getByLabel('Revision history')).toHaveValue('1');

	await panel.getByRole('button', { name: 'Done' }).click();
	// One revision through the same Done path, its note naming the px change.
	await expect(
		page
			.getByRole('status')
			.filter({ hasText: /Edited heading \(size: 24px → 28px\) in “Decision — accepted”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(heading).toHaveCSS('font-size', '28px');
	const revisions = page.getByLabel('Revision history');
	await expect(revisions).toHaveValue('2');

	// Undo compensates the style commit — the heading returns to its base px —
	// and the styled revision stays in history under its px-phrased note.
	await page
		.getByRole('status')
		.filter({ hasText: /size: 24px → 28px/ })
		.getByRole('button', { name: 'Undo' })
		.click();
	await expect(heading).toHaveCSS('font-size', '24px', { timeout: 10000 });
	await expect(revisions).toHaveValue('3');
	await expect(
		revisions.locator('option', { hasText: 'rev 2 — you · Edited heading (size: 24px → 28px)' })
	).toHaveCount(1);
});

test('direct size entry clamps into the bounded range: 200 becomes 72', async ({ page }) => {
	await openAccepted(page);

	const heading = page.locator('[data-edit="blocks.0.text"]');
	await heading.click({ position: { x: 12, y: 12 } });
	const panel = editor(page);
	await panel.getByRole('button', { name: /^Size:/ }).click();

	const custom = panel.getByLabel('Custom');
	await custom.fill('200');
	await custom.press('Enter');
	// Clamped, closed, and live: the trigger and the artifact both say 72.
	await expect(panel.getByRole('listbox', { name: 'Text size' })).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Size: 72 px' })).toBeVisible();
	await expect(heading).toHaveCSS('font-size', '72px');

	// Never committed: Cancel snaps the artifact back to its base.
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(heading).toHaveCSS('font-size', '24px');
	await expect(page.getByLabel('Revision history')).toHaveValue('1');
});

test('Escape closes the size picker first, then the editor', async ({ page }) => {
	await openAccepted(page);

	await page.locator('[data-edit="blocks.0.text"]').click({ position: { x: 12, y: 12 } });
	const panel = editor(page);
	await panel.getByRole('button', { name: /^Size:/ }).click();
	await expect(panel.getByRole('listbox', { name: 'Text size' })).toBeVisible();

	await page.keyboard.press('Escape');
	// The picker closed; the editor stayed.
	await expect(panel.getByRole('listbox', { name: 'Text size' })).toHaveCount(0);
	await expect(panel).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(panel).toHaveCount(0);
});

test('the Variables row inserts suggested and any declared key at the caret, live', async ({ page }) => {
	await openAccepted(page);

	// The checklist paragraph carries per-block suggestions and no tokens yet.
	const paragraph = page.locator('[data-edit="blocks.3.text"]');
	await paragraph.click();
	const panel = editor(page);
	await expect(page.getByRole('dialog', { name: 'Edit paragraph' })).toBeVisible();

	// A suggested chip is one press — a button named for its action: the token
	// lands in the text and the preview renders it as a merge sample
	// immediately, before any commit.
	await panel.getByRole('button', { name: 'Insert submission title' }).click();
	const input = panel.getByRole('textbox');
	await expect(input).toHaveValue(/\{\{submission\.title\}\}/);
	await expect(paragraph).toContainText('Context Caching Without Tears');
	await expect(page.getByLabel('Revision history')).toHaveValue('1');

	// Every declared key sits one step deeper; choosing inserts and resets.
	const all = panel.getByLabel('All variables');
	await all.selectOption('speaker.name');
	await expect(input).toHaveValue(/\{\{speaker\.name\}\}/);
	await expect(paragraph).toContainText('Maya Lindqvist');
	await expect(all).toHaveValue('');

	// Done commits the session as one revision.
	await panel.getByRole('button', { name: 'Done' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Edited paragraph in “Decision — accepted”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(paragraph).toContainText('Context Caching Without Tears');
	await expect(paragraph).toContainText('Maya Lindqvist');
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
});

test('a merge chip swaps to another declared field', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the picker contract');
	await openAccepted(page);

	// The paragraph's first chip renders the submission title sample.
	const chip = page.locator('[data-edit="blocks.1.merge.0"]');
	await expect(chip).toHaveText('Context Caching Without Tears');
	await chip.click();

	const panel = editor(page);
	await expect(page.getByRole('dialog', { name: 'Edit merge field' })).toBeVisible();
	await panel.getByRole('radio', { name: /Speaker name/ }).check();
	await panel.getByRole('button', { name: 'Done' }).click();

	await expect(
		page.getByRole('status').filter({ hasText: /Swapped a merge field in “Decision — accepted”/ })
	).toBeVisible({ timeout: 10000 });
	// The same address now renders the swapped field's sample.
	await expect(page.locator('[data-edit="blocks.1.merge.0"]')).toHaveText('Maya Lindqvist');
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
});

test('the schedule listing edits its layout knobs through one press', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the knobs contract');
	await page.goto('/app/templates?tab=surfaces&template=srf-schedule');
	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(
		preview.locator('.schedule__group-heading').filter({ hasText: 'Tue Oct 13' })
	).toBeVisible({ timeout: 15000 });

	await page.locator('[data-edit="blocks.1"]').click();
	const panel = editor(page);
	await expect(page.getByRole('dialog', { name: 'Edit schedule layout' })).toBeVisible();
	await panel.getByRole('button', { name: 'Track', exact: true }).click();
	await panel.getByRole('button', { name: 'Done' }).click();

	await expect(
		page.getByRole('status').filter({ hasText: /Edited schedule layout in “Public schedule”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
	// The committed preview now groups by track: vocabulary names head the groups.
	await expect(
		preview.locator('.schedule__group-heading').filter({ hasText: 'Agents & Tools' })
	).toBeVisible();
});

test('a form section title edits in place', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the form-text contract');
	await page.goto('/app/templates?tab=surfaces&template=srf-application-form');
	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('About you', { timeout: 15000 });

	await page.locator('[data-edit="blocks.1.title"]').click();
	const panel = editor(page);
	await expect(page.getByRole('dialog', { name: 'Edit section title' })).toBeVisible();
	// A surface declares no merge fields, so its editor carries no Variables
	// row — no empty chrome.
	await expect(panel.getByText('Variables')).toHaveCount(0);
	await panel.getByRole('textbox').fill('Who you are');
	await panel.getByRole('button', { name: 'Done' }).click();

	await expect(
		page
			.getByRole('status')
			.filter({ hasText: /Edited section title in “Speaker application form”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(preview).toContainText('Who you are');
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
});

test('a question edits the one registry, never a template revision', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the registry-door contract');
	await page.goto('/app/templates?tab=surfaces&template=srf-application-form');
	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('About you', { timeout: 15000 });

	await page.locator('[data-edit="fields.fld-email"]').click();
	const panel = editor(page);
	await expect(page.getByRole('dialog', { name: 'Edit question' })).toBeVisible();
	const label = panel.getByLabel('Label');
	await expect(label).toHaveValue('Email');
	await label.fill('Email address');
	await panel.getByRole('button', { name: 'Done' }).click();

	// Its own receipt, its own undo — and no template revision.
	const receipt = page
		.getByRole('status')
		.filter({ hasText: /Edited the “Email address” question/ });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(preview).toContainText('Email address');
	await expect(page.getByLabel('Revision history')).toHaveValue('1');

	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(preview).not.toContainText('Email address', { timeout: 10000 });
	await expect(preview.locator('label').filter({ hasText: 'Email' })).toBeVisible();
});

test('editing while an AI draft is open refines the draft: After changes, Before stays honest', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the draft-lane contract');
	await openAccepted(page);

	// Open a draft round first.
	await page.getByPlaceholder('Tell it what to change…').fill('Make it warmer');
	await page.getByRole('button', { name: 'Send' }).click();
	await expect(page.locator('.editor__state')).toContainText('Draft', { timeout: 15000 });

	// Edit the heading in place on the After side.
	await page.locator('[data-edit="blocks.0.text"]').click({ position: { x: 12, y: 12 } });
	const panel = editor(page);
	await panel.getByRole('textbox').fill('Welcome aboard, {{speaker.name}}');
	await panel.getByRole('button', { name: 'Done' }).click();

	// The draft absorbed it: no commit, no receipt, revision unmoved.
	const preview = page.getByRole('region', { name: 'Message preview' });
	await expect(preview).toContainText('Welcome aboard, Maya Lindqvist');
	await expect(page.locator('.editor__state')).toContainText('Draft');
	await expect(page.getByLabel('Revision history')).toHaveValue('1');
	await expect(page.getByRole('status').filter({ hasText: /Edited heading/ })).toHaveCount(0);

	// Before still shows the committed copy, untouched by the refinement.
	await page.getByRole('button', { name: 'Before', exact: true }).click();
	await expect(preview).toContainText('You’re in');
	await expect(preview).not.toContainText('Welcome aboard');
	await page.getByRole('button', { name: 'After', exact: true }).click();
	await expect(preview).toContainText('Welcome aboard, Maya Lindqvist');
});

test('a tap opens the bottom sheet with the unit above it, and the edit applies', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'coarse-pointer presentation contract');
	await openAccepted(page);

	// The checklist paragraph carries no merge chips, so a center tap always
	// lands on the text run itself.
	const paragraph = page.locator('[data-edit="blocks.3.text"]');
	await paragraph.click();

	// The same editor, docked as a sheet: full width, pinned to the bottom edge.
	const sheet = page.locator('.ied--sheet');
	await expect(sheet).toBeVisible();
	const viewport = page.viewportSize()!;
	const box = (await sheet.boundingBox())!;
	expect(box.y + box.height).toBeGreaterThanOrEqual(viewport.height - 2);
	expect(box.width).toBeGreaterThanOrEqual(viewport.width - 2);
	// Docked, not covering the screen: room stays above for the unit.
	expect(box.y).toBeGreaterThan(viewport.height * 0.25);

	await sheet.getByRole('textbox').fill('Short and sweet.');
	await sheet.getByRole('button', { name: 'Done' }).click();

	await expect(
		page.getByRole('status').filter({ hasText: /Edited paragraph in “Decision — accepted”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(page.locator('[data-edit="blocks.3.text"]')).toContainText('Short and sweet.');
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
});
