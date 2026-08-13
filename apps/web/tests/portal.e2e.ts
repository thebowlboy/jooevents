import { expect, test, type Page } from '@playwright/test';

/**
 * The speaker portal, walked the way a speaker walks it: arrive from an email,
 * find what is waiting, act on it, and be able to read afterwards what happened.
 *
 * Each scenario is one participant's whole world, chosen by cookie before the
 * first load, so a flow never depends on a change another test made.
 */

async function useScenario(page: Page, key: string) {
	await page.context().addCookies([
		{ name: 'je-portal-scenario', value: key, domain: '127.0.0.1', path: '/' },
		{ name: 'je-portal-auth', value: 'active', domain: '127.0.0.1', path: '/' }
	]);
}

async function openPortal(page: Page, key: string) {
	await useScenario(page, key);
	await page.goto('/portal');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 });
}

test('the home surface names the event, the deadline, and only what is waiting', async ({ page }) => {
	await openPortal(page, 'accepted');

	await expect(page.getByRole('heading', { level: 1, name: 'AI Engineer NYC 2026' })).toBeVisible();
	// The event is named once, by the page. The bar carries only the way home and
	// the account, so the one persistent line is not spent repeating the heading.
	await expect(page.locator('header.bar')).not.toContainText('AI Engineer NYC 2026');
	// Both halves of a deadline: an instant with its timezone, and the distance.
	const deadline = page.locator('.event__call');
	await expect(deadline).toContainText('call for speakers closed Jun 30, 23:59 EDT —');
	// The sentence is about proposals only, so it cannot contradict the late task
	// directly below it that still accepts work.
	await expect(deadline).toContainText('No new proposals, and no changes to the ones you sent.');

	const strip = page.getByRole('region', { name: 'Waiting on you' });
	await expect(strip).toBeVisible();
	await expect(strip).toContainText('Confirm you can speak at “Context Caching Without Tears”');
	await expect(strip).toContainText('“AV requirements” was due');
	// A talk already accepted and told is a state, not an errand.
	await expect(strip).not.toContainText('Context caching');

	// Every state word on the page is a badge, never plain grey text.
	await expect(page.getByText('Invited', { exact: true })).toBeVisible();
});

test('an invitation is answered where its consequences are, and the answer is attributed', async ({
	page
}) => {
	await openPortal(page, 'accepted');

	const strip = page.getByRole('region', { name: 'Waiting on you' });
	await strip.getByRole('button', { name: /^Confirm/ }).click();

	// The address carries which record was asked for, so the link is shareable.
	await expect(page).toHaveURL(/\?engagement=eng-101/);

	await page.getByRole('button', { name: 'Yes, I can speak' }).click();

	const receipt = page.getByRole('status').filter({ hasText: 'Confirmed “Context Caching Without Tears”' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(page.getByText(/^You confirmed on /)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Ask to cancel' })).toHaveAttribute(
		'aria-disabled',
		'true'
	);
	await expect(page.getByText(/alerts the organizers; nothing about your session changes/)).toBeVisible();
	await expect(strip).not.toContainText('Confirm you can speak at');
});

test('a task completes explicitly, an upload keeps its versions, and a closed one says so', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the checklist contract');
	await openPortal(page, 'accepted');

	const travel = page.locator('li.task').filter({ hasText: 'Confirm your travel details' });
	// Completing a task is never "Confirm" — that verb answers the speaking
	// invitation on the same page, and the two must stay distinguishable.
	await expect(travel.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
	await travel.getByRole('button', { name: 'Mark as done' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Marked “Confirm your travel details” done' })
	).toBeVisible({ timeout: 10000 });
	await expect(travel.getByText('Done', { exact: true })).toBeVisible();

	// A form this build does not serve keeps its control and its reason.
	const av = page.locator('li.task').filter({ hasText: 'AV requirements' });
	await expect(av.getByRole('button', { name: 'Answer questions' })).toHaveAttribute(
		'aria-disabled',
		'true'
	);
	await expect(page.getByText('The questions for this task do not open here yet.')).toBeVisible();

	// An upload adds a version rather than replacing what was sent before.
	const slides = page.locator('li.task').filter({ hasText: 'Slides draft' });
	await slides.locator('input[type=file]').setInputFiles({
		name: 'slides-draft.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.4 draft')
	});
	await expect(slides.getByText('slides-draft.pdf')).toBeVisible({ timeout: 10000 });
	await expect(slides.getByText(/Version 1 · /)).toBeVisible();

	const headshot = page.locator('li.task').filter({ hasText: 'Headshot upload' });
	await expect(headshot.getByText(/Version 2 · /)).toBeVisible();
	await expect(headshot).toContainText('will confirm once they have checked it');
});

test('a submission shows the pinned record, corrects in place, and appends to its history', async ({
	page
}) => {
	await openPortal(page, 'submitted');

	await page.getByRole('link', { name: /Typed Tool Contracts/ }).click();
	await expect(page).toHaveURL(/\/portal\/submissions\/sub-201$/);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Typed Tool Contracts');
	await expect(page.getByText('The questions are the ones you answered and do not change')).toBeVisible();

	const history = page.getByRole('region', { name: 'What has happened' });
	await expect(history).toContainText('You submitted this talk.');

	await page.getByRole('button', { name: 'Correct an answer' }).click();
	await expect(page).toHaveURL(/\?edit=1/);

	const abstract = page.getByLabel('Abstract');
	await abstract.fill('A corrected abstract, said plainly.');
	await page.getByRole('button', { name: 'Save these changes' }).click();

	const receipt = page.getByRole('status').filter({ hasText: 'Saved your changes to' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(page.getByText('A corrected abstract, said plainly.')).toBeVisible();
	// The record only ever grows: the correction is appended, nothing is rewritten.
	await expect(history).toContainText('You submitted this talk.');
	await expect(history).toContainText('You edited this submission.');

	// The receipt hands back the compensating change, not just a message.
	await receipt.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByText(/^How we made tool-calling agents coordinate/)).toBeVisible({
		timeout: 10000
	});
});

test('withdrawing arms in place, and a decided submission is locked with its reason', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the ceremony contract');
	await openPortal(page, 'submitted');

	await page.getByRole('link', { name: /What We Broke Migrating/ }).click();
	const withdraw = page.getByRole('region', { name: 'Withdraw this' });
	await withdraw.getByRole('button', { name: 'Withdraw', exact: true }).click();
	// Armed, not fired: standing it down leaves the submission exactly as it was.
	await withdraw.getByRole('button', { name: 'Keep it in' }).click();
	await expect(withdraw.getByRole('button', { name: 'Withdraw', exact: true })).toBeVisible();

	await withdraw.getByRole('button', { name: 'Withdraw', exact: true }).click();
	await withdraw.getByRole('button', { name: 'Yes, withdraw it' }).click();
	const receipt = page.getByRole('status').filter({ hasText: 'Withdrew “What We Broke' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	await expect(receipt).toContainText('Email them if this was a mistake.');
	await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(page.getByText('You withdrew this submission, so it is no longer being considered.')).toBeVisible();

	// A decision closes the record, and the reason is on the page before anyone tries.
	await useScenario(page, 'accepted');
	await page.goto('/portal/submissions/sub-101');
	await expect(page.getByText('A decision has been made, so what you sent stays as it is.')).toBeVisible({
		timeout: 15000
	});
	await expect(page.getByRole('button', { name: 'Correct an answer' })).toHaveCount(0);
});

test('another look is offered once per submission and refused structurally at the ceiling', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the refusal contract');
	await openPortal(page, 'declined');

	// Nobody is waiting on an appeal, so the strip says what it is: an option
	// still open, not an obligation.
	const strip = page.getByRole('region', { name: 'Still open to you' });
	await strip.getByRole('link', { name: 'Ask for another look' }).first().click();
	await expect(page).toHaveURL(/\/portal\/submissions\/sub-301\?appeal=1$/);

	await page.getByLabel('What should they know?').fill('The room size was the objection; I can do the short version.');
	await page.getByRole('button', { name: 'Send this to the organizers' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Asked for another look at' })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByRole('heading', { name: 'You asked for another look' })).toBeVisible();

	// The ceiling is the operation's to enforce; the surface renders the refusal
	// it returns rather than guessing at it.
	await page.getByRole('link', { name: 'What you sent' }).click();
	await page.getByRole('link', { name: /Retries Considered Harmful/ }).click();
	await page.getByRole('button', { name: 'Ask for another look' }).click();
	await page.getByLabel('What should they know?').fill('One more, please.');
	await page.getByRole('button', { name: 'Send this to the organizers' }).click();
	await expect(
		page.getByText('You have used every request for another look at this event.')
	).toBeVisible({ timeout: 10000 });
});

test('a locked profile field reads as a value with a way to ask a human', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the locked-field contract');
	await useScenario(page, 'accepted');
	await page.goto('/portal/profile');

	await expect(page.getByRole('heading', { level: 1, name: 'Your details' })).toBeVisible({
		timeout: 15000
	});
	await expect(page.getByText('This comes from the address you signed in with.').first()).toBeVisible();
	await expect(page.getByText('Fixed now that this talk is in the program.')).toBeVisible();

	await page.getByRole('button', { name: 'Request a change' }).first().click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Asked the organizers to change your' })
	).toBeVisible({ timeout: 10000 });
	await expect(page.getByText('You have asked the organizers to change this.')).toBeVisible();

	// An editable field saves quietly and hands back the words that were there.
	const headline = page.getByLabel('Headline');
	await headline.fill('Infrastructure, Nordic Web — caching');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Saved your headline' })).toBeVisible({
		timeout: 10000
	});
});

test('the portal fits a phone without the document scrolling sideways', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openPortal(page, 'accepted');

	const overflow = async () =>
		page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(await overflow()).toBeLessThanOrEqual(1);

	await page.getByRole('link', { name: /Context Caching Without Tears/ }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Context Caching');
	expect(await overflow()).toBeLessThanOrEqual(1);

	await page.goto('/portal/profile');
	await expect(page.getByRole('heading', { level: 1, name: 'Your details' })).toBeVisible({
		timeout: 15000
	});
	expect(await overflow()).toBeLessThanOrEqual(1);
});

test('signing out is confirmed before anything local moves', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'one viewport covers the sign-out contract');
	await openPortal(page, 'accepted');

	await page.getByRole('button', { name: 'Your account' }).click();
	await expect(page.getByText('maya@nordicweb.dev')).toBeVisible();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/portal\/sign-in/, { timeout: 15000 });
});
