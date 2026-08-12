import { expect, test, type Page } from '@playwright/test';

/**
 * The Templates area: the starter template list, the URL-addressed editor with
 * its agent iteration loop (classify → stream → diff → apply), revision
 * history with restore, the surfaces and brand tabs, and the locked nav state
 * before an event exists.
 */

const FRESH = 'fresh';

/** The sidebar is a drawer on touch; navigation assertions open it first. */
async function reachNav(page: Page, projectName: string) {
	if (projectName !== 'mobile') return;
	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
}

/** Runs one quick iteration round and applies it, returning at revision 2. */
async function applyQuickRound(page: Page) {
	const input = page.getByPlaceholder('Tell it what to change…');
	await input.fill('Make it warmer');
	await page.getByRole('button', { name: 'Send' }).click();

	await expect(page.locator('.editor__state')).toContainText('Draft', { timeout: 15000 });
	await page.getByRole('button', { name: 'Apply', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Applied revision 2 to “Decision — accepted”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
}

test('the starter list shows all six templates with purpose, flows, and revision', async ({ page }) => {
	await page.goto('/app/templates');

	const list = page.getByRole('region', { name: 'Message templates' });
	await expect(list).toContainText('Decision — accepted', { timeout: 15000 });
	await expect(list.locator('.tpl-row')).toHaveCount(6);
	await expect(list).toContainText('Decision — waitlisted');
	await expect(list).toContainText('Decision — declined');
	await expect(list).toContainText('Speaker invitation');
	await expect(list).toContainText('Task reminder');
	await expect(list).toContainText('Schedule announcement');
	// Each row carries its revision and the flows that send with it.
	await expect(list.getByText('rev 1').first()).toBeVisible();
	await expect(list.getByText('Decision notification').first()).toBeVisible();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('opening a template lands in the editor with the branded preview, merge chips, and footer', async ({ page }) => {
	await page.goto('/app/templates');
	const list = page.getByRole('region', { name: 'Message templates' });
	await expect(list).toContainText('Decision — accepted', { timeout: 15000 });

	await list.locator('.tpl-row').filter({ hasText: 'Decision — accepted' }).click();
	await expect(page).toHaveURL(/\/app\/templates\?template=tpl-decision-accepted$/);

	const preview = page.getByRole('region', { name: 'Message preview' });
	await expect(preview).toBeVisible();
	// Merge tokens render as labelled sample chips, never raw {{tokens}}.
	await expect(preview.locator('[aria-label^="Merge field:"]').first()).toBeVisible();
	await expect(preview.getByText('Maya Lindqvist').first()).toBeVisible();
	await expect(preview).not.toContainText('{{speaker.name}}');
	// The renderer-owned footer names the event and why the mail arrived.
	await expect(preview).toContainText('AI Engineer NYC 2026');
	await expect(preview).toContainText(/receiving this as a speaker\/submitter/);
});

test('an instruction routes, streams a draft, shows the structural diff, and applies as a new revision', async ({ page }) => {
	await page.goto('/app/templates?template=tpl-decision-accepted');
	await expect(page.getByRole('heading', { name: 'Decision — accepted' })).toBeVisible({ timeout: 15000 });

	const input = page.getByPlaceholder('Tell it what to change…');
	const send = page.getByRole('button', { name: 'Send' });
	// Empty instruction: nothing to send.
	await expect(send).toBeDisabled();

	await input.fill('Make it warmer');
	await expect(send).toBeEnabled();
	await send.click();

	// The routing decision renders as a quiet badge with its reason in words.
	await expect(page.locator('.bar__profile')).toContainText('Quick touch', { timeout: 10000 });
	await expect(page.locator('.bar__routing')).toContainText('Wording-only change');
	// While drafting the send is disabled and the stream reports live tokens.
	await expect(send).toBeDisabled();
	await expect(page.locator('.bar__progress')).toContainText(/tokens/, { timeout: 10000 });

	// Done: the preview flips to the draft and the diff strip appears.
	await expect(page.locator('.editor__state')).toContainText('Draft', { timeout: 15000 });
	const diff = page.getByRole('region', { name: 'What changed' });
	await expect(diff).toBeVisible();
	await expect(diff).toContainText('Edited');
	await expect(diff).toContainText('Paragraph');
	await expect(diff.getByRole('button', { name: 'Refine' })).toBeVisible();
	await expect(diff.getByRole('button', { name: 'Discard' })).toBeVisible();

	// The Before/After reveal: After is the default and shows the drafted text;
	// Before swaps the same reserved container to the committed copy.
	const preview = page.getByRole('region', { name: 'Message preview' });
	const before = page.getByRole('button', { name: 'Before', exact: true });
	const after = page.getByRole('button', { name: 'After', exact: true });
	await expect(after).toHaveAttribute('aria-pressed', 'true');
	await expect(preview).toContainText('genuinely good to be writing to you');
	// Document-space position of the toggle: swapping sides must not move it.
	const togglePlace = () =>
		page.evaluate(() => {
			const el = document.querySelector('.editor__sides');
			return el ? el.getBoundingClientRect().top + window.scrollY : -1;
		});
	const placeOnAfter = await togglePlace();

	await before.click();
	await expect(before).toHaveAttribute('aria-pressed', 'true');
	await expect(preview).toContainText('is confirmed for');
	await expect(preview).not.toContainText('genuinely good to be writing to you');
	// Before is flagged as the committed copy, and nothing moved: the toggle
	// sits exactly where it was.
	await expect(page.locator('.editor__state')).toContainText('Current');
	expect(Math.abs((await togglePlace()) - placeOnAfter)).toBeLessThanOrEqual(1);

	await after.click();
	await expect(preview).toContainText('genuinely good to be writing to you');
	await expect(preview).not.toContainText('is confirmed for');
	// The diff strip's long before→after lines wrap inside the rail; they never
	// widen the document.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);

	// Apply commits it as revision 2, with a receipt that can undo.
	await diff.getByRole('button', { name: 'Apply', exact: true }).click();
	const receipt = page
		.getByRole('status')
		.filter({ hasText: /Applied revision 2 to “Decision — accepted”/ });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(receipt.getByRole('button', { name: 'Undo' })).toBeVisible();
	// The revision dropdown now names the applied copy as current.
	const revisions = page.getByLabel('Revision history');
	await expect(revisions).toHaveValue('2');
	await expect(revisions.locator('option', { hasText: 'rev 2 · current' })).toHaveCount(1);
	await expect(page.locator('.editor__state')).toContainText('revision 2');
});

test('an older revision reads back from the history dropdown and restores on top', async ({ page }) => {
	await page.goto('/app/templates?template=tpl-decision-accepted');
	await expect(page.getByRole('heading', { name: 'Decision — accepted' })).toBeVisible({ timeout: 15000 });
	await applyQuickRound(page);

	// One compact control: the closed dropdown names the current copy, each
	// option is a single line of who revised and why.
	const revisions = page.getByLabel('Revision history');
	await expect(revisions.locator('option', { hasText: 'rev 1 — you · Starter' })).toHaveCount(1);

	// Picking revision 1 is a read-only view of what it said.
	await revisions.selectOption('1');
	await expect(page.locator('.editor__state')).toContainText('Viewing revision 1 — read only');

	await page.getByRole('button', { name: 'Restore this version' }).click();
	const receipt = page
		.getByRole('status')
		.filter({ hasText: /Restored revision 1 of “Decision — accepted”/ });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	// History moves forward: the restore is revision 3, not a rewrite.
	await expect(revisions).toHaveValue('3');
	await expect(revisions.locator('option', { hasText: 'rev 3 · current' })).toHaveCount(1);
	await expect(page.locator('.editor__state')).toContainText('revision 3');
});

test('suggestion chips fill the input, and a pinned model routes as your pick', async ({ page }) => {
	await page.goto('/app/templates?template=tpl-decision-accepted');
	await expect(page.getByRole('heading', { name: 'Decision — accepted' })).toBeVisible({ timeout: 15000 });

	// The assistant panel identity carries the loop; its starter chips sit
	// under the input while there is nothing to report.
	const assistant = page.getByRole('region', { name: 'Change it with AI' });
	await expect(assistant).toBeVisible();
	const chip = assistant.getByRole('button', { name: 'Warmer tone' });
	await expect(chip).toBeVisible({ timeout: 10000 });
	await expect(assistant.getByRole('button', { name: 'Add a deadline row' })).toBeVisible();

	// Pressing a chip fills and focuses the input — it never sends by itself —
	// and the filled input hands the chips' slot back to status.
	await chip.click();
	const input = page.getByPlaceholder('Tell it what to change…');
	await expect(input).toHaveValue('Warmer tone');
	await expect(input).toBeFocused();
	await expect(chip).toBeHidden();
	await expect(page.locator('.bar__progress')).not.toContainText('tokens');

	// The model select defaults to the routing choice; a pinned model bypasses
	// routing and the badge credits the pick.
	const model = page.getByLabel('Model');
	await expect(model).toHaveValue('auto');
	await model.selectOption({ label: 'Opus 5' });
	await page.getByRole('button', { name: 'Send' }).click();
	await expect(page.locator('.bar__profile')).toContainText('Your pick · Opus 5', { timeout: 10000 });
	await expect(page.locator('.editor__state')).toContainText('Draft', { timeout: 20000 });
});

test('a template deep link lands directly in its editor', async ({ page }) => {
	await page.goto('/app/templates?template=tpl-task-reminder');
	await expect(page.getByRole('heading', { name: 'Task reminder' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('region', { name: 'Message preview' })).toBeVisible();
});

test('the brand tab is addressable', async ({ page }) => {
	await page.goto('/app/templates?tab=brand');
	await expect(page.getByRole('region', { name: 'Event brand' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('button', { name: 'Save brand' })).toBeVisible();
});

test('the surfaces tab lists both surfaces as rows that open their editors', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces');
	const list = page.getByRole('region', { name: 'Public surfaces' });
	await expect(list).toContainText('Public schedule', { timeout: 15000 });
	await expect(list.locator('.tpl-row')).toHaveCount(2);
	await expect(list).toContainText('Speaker application form');
	// Each row carries its revision and the surfaces that render from it.
	await expect(list.getByText('rev 1').first()).toBeVisible();
	await expect(list).toContainText('Public schedule · standalone & embed');
	await expect(list).toContainText('CFP form · standalone & embed');
	// The honest line: publishing routes are not here yet.
	await expect(list).toContainText(
		'Standalone and embed routes publish from these surfaces — arriving with the public-surfaces slice.'
	);

	await list.locator('.tpl-row').filter({ hasText: 'Public schedule' }).click();
	await expect(page).toHaveURL(/template=srf-schedule/);
	await expect(page.getByRole('heading', { name: 'Public schedule' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Surface preview' })).toBeVisible();
});

test('the schedule surface editor previews the real program grouped by day', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces&template=srf-schedule');
	await expect(page.getByRole('heading', { name: 'Public schedule' })).toBeVisible({ timeout: 15000 });

	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('AI Engineer NYC 2026 schedule', { timeout: 15000 });
	// The preview renders the scenario's actual placed program, not sample copy.
	await expect(preview).toContainText('Context Caching Without Tears');
	await expect(preview).toContainText('Opening Keynote: AI Engineering Beyond the Demo');
	// Grouped by day: the two event days head the groups.
	await expect(preview.locator('.schedule__group-heading').filter({ hasText: 'Tue Oct 13' })).toBeVisible();
	await expect(preview.locator('.schedule__group-heading').filter({ hasText: 'Wed Oct 14' })).toBeVisible();
	// An unplaced session never appears on the published surface.
	await expect(preview).not.toContainText('Typed Tool Contracts Between Agents That Never Meet');

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('a schedule surface instruction routes comprehensive, diffs the grouping, and applies', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces&template=srf-schedule');
	await expect(page.getByRole('heading', { name: 'Public schedule' })).toBeVisible({ timeout: 15000 });

	const input = page.getByPlaceholder('Tell it what to change…');
	await input.fill('group tracks together');
	await page.getByRole('button', { name: 'Send' }).click();

	// A structural surface instruction routes to the full pass.
	await expect(page.locator('.bar__profile')).toContainText('Full pass', { timeout: 10000 });
	await expect(page.locator('.bar__routing')).toContainText('Structural change across blocks');

	// The diff names the edited option, before → after.
	await expect(page.locator('.editor__state')).toContainText('Draft', { timeout: 30000 });
	const diff = page.getByRole('region', { name: 'What changed' });
	await expect(diff).toContainText('Edited');
	await expect(diff).toContainText('Schedule layout · grouping');
	await expect(diff.locator('.diff__before')).toContainText('day');
	await expect(diff.locator('.diff__after')).toContainText('track');

	await diff.getByRole('button', { name: 'Apply', exact: true }).click();
	const receipt = page
		.getByRole('status')
		.filter({ hasText: /Applied revision 2 to “Public schedule”/ });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(receipt.getByRole('button', { name: 'Undo' })).toBeVisible();
	await expect(page.getByLabel('Revision history')).toHaveValue('2');

	// The committed preview now groups by track: vocabulary names head the groups.
	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview.locator('.schedule__group-heading').filter({ hasText: 'Agents & Tools' })).toBeVisible();
	await expect(
		preview.locator('.schedule__group-heading').filter({ hasText: 'Models & Infrastructure' })
	).toBeVisible();
});

test('the application form editor renders sections with inert fields and the consent checkbox', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces&template=srf-application-form');
	await expect(page.getByRole('heading', { name: 'Speaker application form' })).toBeVisible({ timeout: 15000 });

	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('Speak at AI Engineer NYC 2026', { timeout: 15000 });
	await expect(preview).toContainText('About you');
	await expect(preview).toContainText('Your talk');

	// The fields preview as the artifact but stay inert: labelled and disabled.
	const email = preview.getByLabel(/^Email/);
	await expect(email).toBeVisible();
	await expect(email).toBeDisabled();
	const consent = preview.getByRole('checkbox');
	await expect(consent).toBeDisabled();
	await expect(preview).toContainText('I agree to the code of conduct');
	// Selects resolve their options from the field pool (pronouns, format, and track).
	await expect(preview.locator('select')).toHaveCount(3);
	await expect(preview.locator('select').first()).toBeDisabled();
});

test('a form chip drafts real field work that lands in the registry on apply', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the registry-sync contract');
	await page.goto('/app/templates?tab=surfaces&template=srf-application-form');
	await expect(page.getByRole('heading', { name: 'Speaker application form' })).toBeVisible({
		timeout: 15000
	});

	// The form's starter chips are field work; pressing one fills the input.
	const assistant = page.getByRole('region', { name: 'Change it with AI' });
	const chip = assistant.getByRole('button', { name: 'Add a travel question' });
	await expect(chip).toBeVisible({ timeout: 10000 });
	await chip.click();
	await expect(page.getByPlaceholder('Tell it what to change…')).toHaveValue('Add a travel question');
	await page.getByRole('button', { name: 'Send' }).click();

	// The draft's After side asks the new question in the form preview…
	await expect(page.locator('.editor__state')).toContainText('Draft', { timeout: 30000 });
	const preview = page.getByRole('region', { name: 'Surface preview' });
	const travelLabel = preview.locator('label').filter({ hasText: 'Travel plans' });
	await expect(travelLabel).toBeVisible();
	// …and the diff names it by label. Draft only: Before does not ask it.
	await expect(page.getByRole('region', { name: 'What changed' })).toContainText('Travel plans');
	await page.getByRole('button', { name: 'Before', exact: true }).click();
	await expect(travelLabel).toHaveCount(0);
	await page.getByRole('button', { name: 'After', exact: true }).click();
	await expect(travelLabel).toBeVisible();

	await page.getByRole('region', { name: 'What changed' }).getByRole('button', { name: 'Apply', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Applied revision 2 to “Speaker application form”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(travelLabel).toBeVisible();

	// The question is now a registry fact: Settings → Speaker fields lists it
	// where the advisor placed it — in the logistics run, after the last
	// logistics field and before materials. In-app navigation keeps the
	// session's working copy alive.
	await page.locator('.side__link[href="/app/settings"]').click();
	const panel = page.getByRole('region', { name: 'Speaker fields' });
	await expect(panel.getByRole('heading', { name: 'Speaker fields' })).toBeVisible({ timeout: 15000 });
	await expect(panel.getByRole('listitem').filter({ hasText: 'Travel plans' })).toBeVisible({
		timeout: 15000
	});
	const names = await panel.locator('.frow__label').allInnerTexts();
	const travel = names.indexOf('Travel plans');
	expect(travel).toBeGreaterThan(names.indexOf('Dietary needs'));
	expect(travel).toBeLessThan(names.indexOf('Headshot'));
});

test('a surface revision restores as a new revision on top', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces&template=srf-schedule');
	await expect(page.getByRole('heading', { name: 'Public schedule' })).toBeVisible({ timeout: 15000 });

	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('Main Stage', { timeout: 15000 });

	// A quick round that hides the rooms, applied as revision 2.
	const input = page.getByPlaceholder('Tell it what to change…');
	await input.fill('Hide the rooms');
	await page.getByRole('button', { name: 'Send' }).click();
	await expect(page.locator('.editor__state')).toContainText('Draft', { timeout: 15000 });
	const diff = page.getByRole('region', { name: 'What changed' });
	await expect(diff).toContainText('Schedule layout · showRoom');
	await diff.getByRole('button', { name: 'Apply', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Applied revision 2 to “Public schedule”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(preview).not.toContainText('Main Stage');

	// Reading revision 1 is a read-only view; restoring moves history forward.
	await page.getByLabel('Revision history').selectOption('1');
	await expect(page.locator('.editor__state')).toContainText('Viewing revision 1 — read only');
	await page.getByRole('button', { name: 'Restore this version' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Restored revision 1 of “Public schedule”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByLabel('Revision history')).toHaveValue('3');
	await expect(preview).toContainText('Main Stage');
});

test('the schedule page doors into the public schedule template editor', async ({ page }) => {
	await page.goto('/app/schedule');
	const door = page.getByRole('link', { name: 'Public schedule template — Templates' });
	await expect(door).toBeVisible({ timeout: 15000 });
	await door.click();

	await expect(page).toHaveURL(/\/app\/templates\?tab=surfaces&template=srf-schedule/);
	await expect(page.getByRole('heading', { name: 'Public schedule' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('region', { name: 'Surface preview' })).toBeVisible();
});

test('before an event exists, Templates sits locked in the navigation', async ({ page, context, baseURL }, testInfo) => {
	await context.addCookies([
		{ name: 'je-scenario', value: FRESH, url: baseURL ?? 'http://127.0.0.1:4173' }
	]);

	await page.goto('/app');
	await reachNav(page, testInfo.project.name);

	const nav = page.getByRole('navigation', { name: 'Workspace' });
	const locked = nav.locator('.side__link--locked').filter({ hasText: 'Templates' });
	await expect(locked).toBeVisible({ timeout: 15000 });
	// Locked means not a link: there is nothing to follow yet.
	await expect(nav.getByRole('link', { name: 'Templates' })).toHaveCount(0);
});
