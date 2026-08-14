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
 * Embeds and the public lineup.
 *
 * Two features that only make sense together: the lineup decides who appears
 * on the speaker page and in what order, and Embeds hands over the code that
 * puts that page — or the schedule, or one form, or one person — onto somebody
 * else's website. The assertions below are about the seams: that the order is
 * one fact every presentation reads, that the snippet is regenerated from the
 * choices rather than typed, that a mechanism states what it cannot do before
 * it is chosen, and that the doors between the three areas that own the three
 * halves of a public page all resolve.
 */

async function openLineup(page: Page) {
	await page.goto('/app/speakers?view=lineup');
	await expect(onLineup(page)).toBeVisible({ timeout: 15000 });
}

async function openEmbed(page: Page, key: string, name: string) {
	await page.goto(`/app/embeds?embed=${key}`);
	// Level 2: the shell's own h1 already names the area, exactly as the
	// Templates editor does for an open template.
	await expect(page.getByRole('heading', { level: 2, name })).toBeVisible({ timeout: 15000 });
}

/** Exact, because "Not on the lineup" is the other section and contains this name. */
function onLineup(page: Page) {
	return page.getByRole('region', { name: 'On the lineup', exact: true });
}

function lineupNames(page: Page) {
	return onLineup(page).locator('.lnrow__name');
}

test('the embeds picker lists every public page with what it would actually show', async ({
	page
}) => {
	await page.goto('/app/embeds');
	const pages = page.getByRole('region', { name: 'Pages' });
	await expect(pages).toContainText('The programme', { timeout: 15000 });
	await expect(pages).toContainText('The whole lineup');

	// The count is the fact worth knowing before pasting: four people are
	// published in this scenario, and a group target counts only its own.
	await expect(pages.locator('.pick', { hasText: 'The whole lineup' })).toContainText('4 speakers');
	await expect(pages.locator('.pick', { hasText: 'Keynotes' })).toContainText('1 speaker');

	// Forms are targets too, one per form, so the CFP embed is reachable from
	// the same place as everything else.
	await expect(page.getByRole('region', { name: 'Forms' })).toContainText('Call for Proposals');

	// And each published speaker has an embed of their own.
	await expect(page.getByRole('region', { name: 'One speaker' })).toContainText('Maya Lindqvist');

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('the snippet is generated from the choices, and the loader is separate from the element', async ({
	page
}) => {
	await openEmbed(page, 'srf-speaker-roster', 'The whole lineup');

	const code = page.locator('.snip__code');
	await expect(code.first()).toContainText('joo-embed.js');
	await expect(code.nth(1)).toContainText('<joo-embed');
	// Defaults are never spelled out: a default spec is one short line.
	await expect(code.nth(1)).not.toContainText('style-mode');
	await expect(code.nth(1)).not.toContainText('max-width');

	// Every non-default choice becomes one attribute.
	await page.locator('.ui-segmented__item', { hasText: '720px' }).click();
	await expect(code.nth(1)).toContainText('max-width="720"');
	await page.locator('.ui-segmented__item', { hasText: 'Centred' }).click();
	await expect(code.nth(1)).toContainText('align="center"');
	await page.locator('.ui-segmented__item', { hasText: 'Match my site' }).click();
	await expect(code.nth(1)).toContainText('style-mode="match-site"');
});

test('a delivery says what it cannot do before it is chosen, and the code changes with it', async ({
	page
}) => {
	await openEmbed(page, 'srf-speaker-roster', 'The whole lineup');

	// Inline can do both style modes, so nothing is claimed.
	await page.locator('.ui-segmented__item', { hasText: 'Match my site' }).click();
	await expect(page.locator('.rail__limit')).toHaveCount(0);

	// A frame is a separate document, so it cannot inherit the host's type —
	// stated in place rather than discovered after pasting.
	await page.locator('.deliv', { hasText: 'Frame' }).click();
	await expect(page.locator('.rail__limit')).toContainText('separate page');
	const code = page.locator('.snip__code');
	await expect(code).toHaveCount(1);
	await expect(code).toContainText('<iframe');
	await expect(code).toContainText('min-height:');
	// Never a fixed pixel width: the host's box decides how wide it runs.
	await expect(code).toContainText('width:100%');

});

test('the page states its own address as identity, above the embedding settings', async ({
	page
}) => {
	await openEmbed(page, 'srf-speaker-roster', 'The whole lineup');

	// It sits in the header, not among the settings: on a page called Embeds a
	// link needs a reason, and the reason is that the surface is already a page.
	const strip = page.locator('.standalone');
	await expect(strip).toContainText('It’s already a page');
	await expect(strip).toContainText('/s/speakers');
	await expect(strip.getByRole('link', { name: /Open it/ })).toHaveAttribute('href', '/s/speakers');
	// And it says why everything below it exists.
	await expect(strip).toContainText('only for putting it');

	// The copy control stands rather than waiting for a hover it may never get.
	await expect(strip.locator('.ui-copy__button')).toHaveCSS('opacity', '1');

	// A scoped embed carries the scoped address.
	await openEmbed(page, 'srf-speaker-roster%3Aspeaker%3Aspk-1', 'Maya Lindqvist');
	await expect(page.locator('.standalone')).toContainText('/s/speakers?scope=speaker%3Aspk-1');
});

test('the builder’s two columns open on the same line', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'the columns stack below the desktop breakpoint');
	await openEmbed(page, 'srf-speaker-roster', 'The whole lineup');

	// A `.card + .card` margin written for the picker's stack used to match the
	// rail here and push the whole right column down; spacing belongs to the
	// container that owns the stack, and the two headers reserve the same row.
	const boxes = await page.evaluate(() => {
		const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
		return {
			previewCard: top('.preview'),
			railCard: top('.rail'),
			previewHead: top('.preview__top'),
			railHead: top('.rail__title--lead')
		};
	});
	expect(Math.abs(boxes.previewCard - boxes.railCard)).toBeLessThanOrEqual(1);
	expect(Math.abs(boxes.previewHead - boxes.railHead)).toBeLessThanOrEqual(1);
});

test('search engines are off until the organizer turns them on, with a receipt', async ({ page }) => {
	await page.goto('/app/embeds');
	const findable = page.getByRole('region', { name: 'Search engines' });
	const toggle = findable.getByRole('switch', { name: /Let search engines find/ });
	await expect(toggle).not.toBeChecked({ timeout: 15000 });
	await expect(findable).toContainText('stay out of search results');

	// The switch is a label wrapping a visually-hidden input: a person presses
	// the label, and so does this.
	const label = findable.getByText('Let search engines find these pages');
	await label.click();
	await expect(toggle).toBeChecked();
	await expect(findable).toContainText('ask to be indexed');
	await expect(page.locator('.receipt', { hasText: 'Let search engines find' })).toBeVisible();

	// Turning it back off is the same commit in reverse.
	await label.click();
	await expect(toggle).not.toBeChecked();
	await expect(findable).toContainText('stay out of search results');

	// What the hosted page does with the setting is asserted on the page itself
	// below. It is not asserted across a navigation from here: the sample
	// transport lives in one document, so a full page load starts a fresh
	// workspace — a property of the fixture, not of the product.
});

test('a hosted page is the surface itself, with none of the console and no crawling', async ({
	page
}) => {
	await page.goto('/s/schedule');
	await expect(page.locator('.schedule__title')).toContainText('schedule', { timeout: 15000 });

	// Hidden from search until an organizer says otherwise.
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
	// None of the operator console reaches a visitor.
	await expect(page.getByRole('navigation', { name: 'Workspace' })).toHaveCount(0);
	// The real programme, not sample copy.
	await expect(page.locator('.schedule__session-title').first()).toBeVisible();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('the hosted lineup and one speaker are the same surface, narrowed by the address', async ({
	page
}) => {
	await page.goto('/s/speakers');
	await expect(page.locator('.roster__title')).toBeVisible({ timeout: 15000 });
	await expect(page.locator('.roster__name, .roster__profile-name')).toHaveCount(4);

	await page.goto('/s/speakers?scope=speaker%3Aspk-1');
	await expect(page.locator('.roster__profile-name')).toHaveText('Maya Lindqvist');
	// One person is a card: the page's own furniture stays with the page.
	await expect(page.locator('.roster__title')).toHaveCount(0);
});

test('the hosted call for proposals shows its questions and says it cannot take answers yet', async ({
	page
}) => {
	await page.goto('/s/apply?scope=form%3Aform-cfp');
	await expect(page.locator('.form__title')).toContainText('Speak at', { timeout: 15000 });
	// Real questions from the real registry.
	await expect(page.locator('.form__label').first()).toBeVisible();
	// And the one honest line, because controls that look live and lose the work
	// are the failure this notice exists to prevent.
	await expect(page.locator('.public__notice')).toContainText('Submitting isn’t switched on yet');

	// Without the port's application capability this is the display-only page:
	// every control disabled, no live answering surface, no autosave line.
	await expect(page.locator('.form__submit')).toBeDisabled();
	await expect(page.locator('.form__control').first()).toBeDisabled();
	await expect(page.locator('.apply__save')).toHaveCount(0);
	await expect(page.locator('.apply__submit')).toHaveCount(0);
});

test('an address that names no surface is a plain not-found, and stays out of search', async ({
	page
}) => {
	await page.goto('/s/nonsense');
	await expect(page.getByText('This page doesn’t exist.')).toBeVisible({ timeout: 15000 });
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});

test('every embed is refused until a site is named — framing is allowlist-only', async ({
	page
}) => {
	// Read-only surfaces bind the allowlist too: an empty list means the served
	// document denies all framing, so the builder says so before pasting.
	await openEmbed(page, 'srf-speaker-roster', 'The whole lineup');
	const where = page.getByRole('region', { name: 'Where it may appear' });
	await expect(where).toBeVisible();
	await expect(page.locator('.rail__error')).toContainText('Name at least one site');

	await openEmbed(page, 'srf-application-form%3Aform%3Aform-cfp', 'Call for Proposals');
	await expect(where).toBeVisible();
	await expect(page.locator('.rail__error')).toContainText('Name at least one site');

	// A value that is not an origin is refused in place rather than stored.
	await where.getByRole('textbox').fill('not a website');
	await where.getByRole('button', { name: 'Add' }).click();
	await expect(page.locator('.rail__error').first()).toContainText(
		'characters a site origin cannot carry'
	);

	// A path is no longer silently truncated: it refuses in place too.
	await where.getByRole('textbox').fill('conference.example.org/speakers');
	await where.getByRole('button', { name: 'Add' }).click();
	await expect(page.locator('.rail__error').first()).toContainText('without a path');

	// A bare host normalizes to a real origin, and the refusal clears.
	await where.getByRole('textbox').fill('conference.example.org');
	await where.getByRole('button', { name: 'Add' }).click();
	await expect(where).toContainText('https://conference.example.org');
	await expect(page.locator('.rail__error')).toHaveCount(0);
});

test('one speaker embeds as a card, not as a page', async ({ page }) => {
	await openEmbed(page, 'srf-speaker-roster%3Aspeaker%3Aspk-1', 'Maya Lindqvist');

	const host = page.locator('.host');
	await expect(host).toContainText('Maya Lindqvist');
	// The page's own furniture stays with the page: no hero, no footer.
	await expect(host).not.toContainText('Speaking at');
	await expect(page.locator('.preview__hint')).toContainText('card, not a page');

	// The scope rides the snippet as one flat attribute value.
	await expect(page.locator('.snip__code').nth(1)).toContainText('scope="speaker:spk-1"');
});

test('the lineup orders the roster, and the order is what every presentation reads', async ({
	page
}) => {
	await openLineup(page);
	await expect(lineupNames(page)).toHaveText([
		'Maya Lindqvist',
		'Sofia Berg',
		'Ravi Chandran',
		'Daniel Kim'
	]);

	// Keys are the equal path to the drag: one step per press, same commit.
	await page.locator('.lnrow', { hasText: 'Ravi Chandran' }).locator('.lnrow__grip').focus();
	await page.keyboard.press('ArrowUp');
	await expect(lineupNames(page)).toHaveText([
		'Maya Lindqvist',
		'Ravi Chandran',
		'Sofia Berg',
		'Daniel Kim'
	]);

	// A move is a commit, so it leaves a receipt that takes it back.
	const receipt = page.locator('.receipt', { hasText: 'Moved Ravi Chandran' });
	await expect(receipt).toBeVisible();

	// The public page reads that same order.
	await openEmbed(page, 'srf-speaker-roster', 'The whole lineup');
	const cards = page.locator('.host .roster__card .roster__name, .host .roster__profile-name');
	await expect(cards.first()).toContainText('Ravi Chandran');

	// Undo through the receipt restores it.
	await openLineup(page);
	await page.locator('.lnrow', { hasText: 'Ravi Chandran' }).locator('.lnrow__grip').focus();
	await page.keyboard.press('ArrowDown');
	await expect(lineupNames(page)).toHaveText([
		'Maya Lindqvist',
		'Sofia Berg',
		'Ravi Chandran',
		'Daniel Kim'
	]);
});

test('a speaker group is roster state: filing one person moves the count and the page', async ({
	page
}) => {
	await openLineup(page);
	const groups = page.getByRole('region', { name: 'Speaker groups' });
	await expect(groups.locator('.ui-badge', { hasText: 'Keynotes' })).toContainText('1');

	await page.locator('#lineup-cat-spk-8').selectOption('spkcat-keynote');
	await expect(groups.locator('.ui-badge', { hasText: 'Keynotes' })).toContainText('2');
	await expect(page.locator('.receipt', { hasText: 'Filed Daniel Kim under Keynotes' })).toBeVisible();

	// Put it back through the same control, so the scenario is unchanged for the
	// next test in this file.
	await page.locator('#lineup-cat-spk-8').selectOption('spkcat-talk');
	await expect(groups.locator('.ui-badge', { hasText: 'Keynotes' })).toContainText('1');
});

test('the three areas that own a public page each name the other two', async ({ page }) => {
	// From the embed: wording, brand, and who appears.
	await openEmbed(page, 'srf-speaker-roster', 'The whole lineup');
	await expect(page.getByRole('link', { name: 'Change the wording and layout' })).toHaveAttribute(
		'href',
		'/app/templates?tab=surfaces&template=srf-speaker-roster'
	);
	await expect(page.getByRole('link', { name: 'Change the colours and fonts' })).toHaveAttribute(
		'href',
		'/app/templates?tab=brand'
	);
	await expect(
		page.getByRole('link', { name: 'Change who appears, and in what order' })
	).toHaveAttribute('href', '/app/speakers?view=lineup');

	// From the surfaces list: one embed door per surface, resolving to the same
	// address as every other route into it.
	await page.goto('/app/templates?tab=surfaces');
	const surfaces = page.getByRole('region', { name: 'Public surfaces' });
	await expect(surfaces).toContainText('Speaker roster', { timeout: 15000 });
	await expect(
		surfaces.locator('.tpl-pair', { hasText: 'Speaker roster' }).getByRole('link')
	).toHaveAttribute('href', '/app/embeds?embed=srf-speaker-roster');

	// From the lineup.
	await openLineup(page);
	await expect(page.getByRole('link', { name: 'Embed the lineup' })).toHaveAttribute(
		'href',
		'/app/embeds?embed=srf-speaker-roster'
	);
});

test('the roster surface is a template like the others, with its own layout knobs', async ({
	page
}) => {
	await page.goto('/app/templates?tab=surfaces&template=srf-speaker-roster');
	await expect(page.getByRole('heading', { name: 'Speaker roster' })).toBeVisible({
		timeout: 15000
	});

	// The listing is one addressable unit; a press opens its knobs, not a person.
	await page.locator('[data-edit]').filter({ hasText: 'Keynotes' }).first().click();
	const editor = page.getByRole('dialog').or(page.locator('.ied'));
	await expect(editor).toContainText('Roster layout');
	await expect(editor).toContainText('Order and grouping come from');

	// Layout is a template decision, so it changes the preview in place.
	await editor.getByRole('button', { name: 'Rows' }).click();
	await expect(page.locator('.roster__items--list').first()).toBeVisible();
});
