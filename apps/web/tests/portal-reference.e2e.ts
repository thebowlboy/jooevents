import { expect, test, type Page } from '@playwright/test';

/**
 * The participant surface's workbench references. They exist so a state can be
 * inspected without walking a journey to reach it, which only holds if they
 * keep rendering the shipped components with working sample fulfillment.
 */

function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	return errors;
}

test('the portal reference shows every row state, including the one that cannot act', async ({
	page
}) => {
	const errors = watchErrors(page);
	await page.goto('/design-system/participant-portal');

	await expect(page.getByRole('heading', { level: 1 })).toContainText('What a speaker sees');

	// The badge vocabulary, one tone per state, never plain grey words.
	for (const label of ['Received', 'Being read', 'Accepted', 'Waitlisted', 'To do', 'Done', 'Late']) {
		await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
	}

	// The live checklist behaves: completing is explicit and receipted.
	const live = page.locator('li.task').filter({ hasText: 'Confirm your travel details' });
	await live.getByRole('button', { name: 'Mark as done' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Marked “Confirm your travel details” done' })
	).toBeVisible({ timeout: 10000 });

	// The hard-closed row keeps its control and points at the reason.
	const closed = page.locator('li.task').filter({ hasText: 'Signed speaker agreement' });
	await expect(closed.getByRole('button', { name: 'Upload' })).toHaveAttribute(
		'aria-disabled',
		'true'
	);
	await expect(closed).toContainText('no longer accepts anything');

	// The timeline is the envelope, appended in order.
	const history = page.locator('.history').first();
	await expect(history).toContainText('You submitted this talk.');
	await expect(history).toContainText('The organizers told you this talk was accepted.');

	// Both appeal states, and the composer opening in place.
	await expect(page.getByRole('heading', { name: 'Ask for another look' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'You asked for another look' })).toBeVisible();
	await page.getByRole('button', { name: 'Ask for another look' }).click();
	await expect(page.getByRole('button', { name: 'Send this to the organizers' })).toBeVisible();

	expect(errors).toEqual([]);
});

test('the portal reference fits a phone without the document scrolling sideways', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/design-system/participant-portal');
	await expect(page.getByRole('heading', { level: 1 })).toContainText('What a speaker sees');
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(1);
});

test('the shell reference renders the portal chrome at default density', async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto('/design-system/portal-shell');

	await expect(page.getByRole('heading', { level: 1, name: 'AI Engineer NYC 2026' })).toBeVisible({
		timeout: 15000
	});
	// One column, no rail, and a bar that does not repeat the page's heading.
	await expect(page.locator('header.bar')).not.toContainText('AI Engineer NYC 2026');
	await expect(page.getByRole('button', { name: 'Your account' })).toBeVisible();
	await expect(page.locator('html')).not.toHaveAttribute('data-density', 'compact');
	expect(errors).toEqual([]);
});

test('the sign-in link reference carries both lanes and their different acknowledgements', async ({
	page
}) => {
	const errors = watchErrors(page);
	await page.goto('/design-system/entry-links');

	// It opens on the resting operator specimen: both choices at once, magic
	// link first, the method named once above its plain field.
	await expect(page.getByLabel('Email address')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Magic link' })).toBeVisible();
	await expect(
		page.getByText("We'll email you a link that signs you in — no password, nothing to remember.")
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Email me a magic link' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();

	// The arrow-key switcher still walks the set, and the resolver specimen next
	// door shows the footprint the resting card arrives into.
	await page.keyboard.press('ArrowLeft');
	await expect(page.getByLabel('Checking access')).toBeVisible();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('heading', { name: 'Magic link' })).toBeVisible();

	await page.getByRole('button', { name: 'Operator · acknowledged' }).click();
	await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
	await expect(
		page.getByText('If an account exists for this address, a magic link is on its way.')
	).toBeVisible();

	await page.getByRole('button', { name: 'Speaker · one field' }).click();
	await expect(page.getByRole('heading', { name: 'Magic link' })).toBeVisible();
	await expect(page.getByRole('button', { name: /with Google/ })).toHaveCount(0);

	await page.getByRole('button', { name: 'Speaker · acknowledged' }).click();
	await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
	await expect(
		page.getByText('We just emailed you a magic link. If the address is new here, it creates your access.')
	).toBeVisible();

	await page.getByRole('button', { name: 'Speaker · spent link' }).click();
	await expect(page.getByRole('heading', { name: 'That link has expired' })).toBeVisible();

	expect(errors).toEqual([]);
});
