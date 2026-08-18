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

test('the assistant panel is present but paused: coming soon named, controls inert, no chips', async ({ page }) => {
	await page.goto('/app/templates?template=tpl-decision-accepted');
	await expect(page.getByRole('heading', { name: 'Decision — accepted' })).toBeVisible({ timeout: 15000 });

	// The panel keeps its place and says why it does nothing yet.
	const assistant = page.getByRole('region', { name: 'Change it with AI' });
	await expect(assistant).toBeVisible();
	await expect(assistant).toContainText('Coming soon');
	await expect(assistant).toContainText('describe a change here');

	// Every control is inert — input, send, and the model pick.
	await expect(page.getByPlaceholder('Tell it what to change…')).toBeDisabled();
	await expect(assistant.getByRole('button', { name: 'Send' })).toBeDisabled();
	await expect(page.getByLabel('Model')).toBeDisabled();

	// The starter suggestion chips are gone, not merely hidden.
	await expect(assistant.locator('.bar__chip')).toHaveCount(0);
	await expect(assistant.getByRole('button', { name: 'Warmer tone' })).toHaveCount(0);
});

test('an older revision reads back from the history dropdown and restores on top', async ({ page }) => {
	await page.goto('/app/templates?template=tpl-decision-accepted');
	await expect(page.getByRole('heading', { name: 'Decision — accepted' })).toBeVisible({ timeout: 15000 });

	// Revision 2 comes from the direct lane: one inline edit, committed on Done.
	const preview = page.getByRole('region', { name: 'Message preview' });
	await expect(preview).toContainText('You’re in', { timeout: 15000 });
	await page.locator('[data-edit="blocks.0.text"]').click({ position: { x: 12, y: 12 } });
	const editorPanel = page.locator('.ied');
	await editorPanel.getByRole('textbox').fill('Welcome aboard, {{speaker.name}}');
	await editorPanel.getByRole('button', { name: 'Done' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Edited heading in “Decision — accepted”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByLabel('Revision history')).toHaveValue('2');

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

test('the surfaces tab lists every surface as a row that opens its editor', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces');
	const list = page.getByRole('region', { name: 'Public surfaces' });
	await expect(list).toContainText('Public schedule', { timeout: 15000 });
	await expect(list.locator('.tpl-row')).toHaveCount(3);
	await expect(list).toContainText('Speaker roster');
	await expect(list).toContainText('Speaker application form');
	// Each row carries its revision and the surfaces that render from it.
	await expect(list.getByText('rev 1').first()).toBeVisible();
	await expect(list).toContainText('Public schedule · standalone & embed');
	await expect(list).toContainText('Speaker roster · standalone & embed');
	await expect(list).toContainText('CFP form · standalone & embed');
	// This list owns what a page says; the code that carries it onto somebody
	// else's site is one door away, per row and in the closing line.
	await expect(
		list.locator('.tpl-pair', { hasText: 'Public schedule' }).getByRole('link')
	).toHaveAttribute('href', '/app/embeds?embed=srf-schedule');
	await expect(list.getByRole('link', { name: 'Embeds' })).toHaveAttribute('href', '/app/embeds');

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
	// Selects resolve their options from the field pool (format and track);
	// their choices are the live event vocabularies.
	await expect(preview.locator('select')).toHaveCount(2);
	await expect(preview.locator('select').first()).toBeDisabled();
});

test('a surface revision restores as a new revision on top', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces&template=srf-schedule');
	await expect(page.getByRole('heading', { name: 'Public schedule' })).toBeVisible({ timeout: 15000 });

	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('Main Stage', { timeout: 15000 });

	// Revision 2 comes from the direct lane: retitle the hero inline.
	await page.locator('[data-edit="blocks.0.title"]').click({ position: { x: 12, y: 12 } });
	const editorPanel = page.locator('.ied');
	await editorPanel.getByRole('textbox').fill('The program, hour by hour');
	await editorPanel.getByRole('button', { name: 'Done' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Edited title in “Public schedule”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByLabel('Revision history')).toHaveValue('2');
	await expect(preview).toContainText('The program, hour by hour');

	// Reading revision 1 is a read-only view; restoring moves history forward.
	await page.getByLabel('Revision history').selectOption('1');
	await expect(page.locator('.editor__state')).toContainText('Viewing revision 1 — read only');
	await page.getByRole('button', { name: 'Restore this version' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Restored revision 1 of “Public schedule”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByLabel('Revision history')).toHaveValue('3');
	await expect(preview).not.toContainText('The program, hour by hour');
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

	const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
	const locked = nav.locator('.side__link--locked').filter({ hasText: 'Templates' });
	await expect(locked).toBeVisible({ timeout: 15000 });
	// Locked means not a link: there is nothing to follow yet.
	await expect(nav.getByRole('link', { name: 'Templates' })).toHaveCount(0);
});

/**
 * Section insertion and removal, reached without a pointer.
 *
 * The edge affordances are a fine-pointer accelerator and are deliberately out
 * of the tab order, so the keyboard's whole path runs through the block editor
 * it can already reach: open a section, Add below, choose a kind, and the new
 * section's editor is already open to type into.
 */
test('a section can be added and removed from the keyboard alone', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'keyboard-path contract');

	await page.goto('/app/templates?template=tpl-schedule-announcement');
	await expect(page.getByRole('heading', { name: 'Schedule announcement' })).toBeVisible({
		timeout: 15000
	});
	const preview = page.getByRole('region', { name: 'Message preview' });
	await expect(preview).toContainText('The schedule is out', { timeout: 15000 });

	// The teaching line only claims editability where a press is answered.
	await expect(page.locator('.editor__state')).toContainText('click any text to edit it.');

	// Open the first section's editor with the keyboard, not a click.
	await page.locator('[data-edit="blocks.0.text"]').focus();
	await page.keyboard.press('Enter');
	const editor = page.locator('.ied');
	await expect(editor).toBeVisible();

	// The insertion path that needs no hover.
	await editor.getByRole('button', { name: 'Add below' }).click();
	const menu = page.getByRole('menu', { name: 'Add a section' });
	await expect(menu).toBeVisible();
	// Focus is already in the menu, so the choice is one Enter away.
	await expect(menu.getByRole('menuitem', { name: 'Heading' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(menu.getByRole('menuitem', { name: 'Paragraph' })).toBeFocused();
	await page.keyboard.press('Enter');

	// The new section is committed as its own revision, and its editor opened
	// on it — insert-then-type is one gesture.
	await expect(
		page.getByRole('status').filter({ hasText: /Added a paragraph in “Schedule announcement”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(preview).toContainText('Write the message here');
	await expect(page.locator('.ied')).toBeVisible();

	// Removal arms in place inside the same editor: the second press is the
	// whole ceremony a bounded, undoable change needs.
	const remove = page.locator('.ied').getByRole('button', { name: 'Remove section' });
	await remove.click();
	await expect(page.locator('.ied').getByRole('button', { name: 'Remove?' })).toBeVisible();
	await page.locator('.ied').getByRole('button', { name: 'Remove?' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Removed the paragraph in “Schedule announcement”/ })
	).toBeVisible({ timeout: 10000 });
	await expect(preview).not.toContainText('Write the message here');
});

/**
 * The artifact stays the artifact at rest: insertion controls exist only while
 * the preview is editable, and the hover affordances never carry meaning alone.
 */
test('the end control is the always-findable entry, and a read-only view has none', async ({
	page
}) => {
	await page.goto('/app/templates?template=tpl-schedule-announcement');
	const preview = page.getByRole('region', { name: 'Message preview' });
	await expect(preview).toContainText('The schedule is out', { timeout: 15000 });

	// Persistent, not hover-revealed — what a first-time author actually finds.
	await expect(preview.getByRole('button', { name: '+ Add section' })).toBeVisible();

	// A read-only view needs an earlier revision to read: mint revision 2 with
	// one inline edit, exactly as the restore journey does.
	await page.locator('[data-edit="blocks.0.text"]').click({ position: { x: 12, y: 12 } });
	const editorPanel = page.locator('.ied');
	await editorPanel.getByRole('textbox').fill('The schedule is live');
	await editorPanel.getByRole('button', { name: 'Done' }).click();
	await expect(page.getByLabel('Revision history')).toHaveValue('2', { timeout: 10000 });

	// A revision read is inert: no insertion anywhere on it.
	await page.getByLabel('Revision history').selectOption('1');
	await expect(page.locator('.editor__state')).toContainText('read only');
	await expect(preview.getByRole('button', { name: '+ Add section' })).toHaveCount(0);
	await expect(preview.locator('.email__insert')).toHaveCount(0);
});

/**
 * Surface templates keep their own vocabulary: their specialised blocks are
 * edited through knob editors, and the message-section menu does not describe
 * them.
 */
test('a surface template offers no message-section insertion', async ({ page }) => {
	await page.goto('/app/templates?tab=surfaces&template=srf-schedule');
	await expect(page.getByRole('heading', { name: 'Public schedule' })).toBeVisible({
		timeout: 15000
	});
	const preview = page.getByRole('region', { name: 'Surface preview' });
	await expect(preview).toContainText('AI Engineer NYC 2026 schedule', { timeout: 15000 });
	await expect(page.getByRole('button', { name: '+ Add section' })).toHaveCount(0);
});
