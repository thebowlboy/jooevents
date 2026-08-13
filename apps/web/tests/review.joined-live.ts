import { expect, test, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the newly mounted live Review aggregate
 * (review.snapshot.read + review.round.setup.read behind the tuned page,
 * with the surface's authority projection coming from the snapshot's own
 * served viewer discriminator).
 *
 * The joined harness serves one shared ephemeral backend for every project in
 * the run, so this spec creates the event only when the workspace is still
 * first-run and asserts a surface that stays true against its own residue: no
 * round is ever opened here, and no reviewer is ever registered.
 */

const rawToken = 'browser-test-owner-session-token';
const secret = 'browser-test-secret-that-is-at-least-thirty-two-bytes';

async function signedSessionValue(): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
	return `${rawToken}.${Buffer.from(signature).toString('base64')}`;
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
}

/** Creates the shared event through the first-run dialog when none exists yet. */
async function ensureEvent(page: Page): Promise<void> {
	await page.goto('/app');
	const firstRun = page.getByRole('button', { name: 'Fill in details myself' });
	const pipeline = page.getByRole('region', { name: 'Pipeline' });
	await expect(firstRun.or(pipeline).first()).toBeVisible();
	if (await pipeline.isVisible()) return;
	await firstRun.click();
	const dialog = page.getByRole('dialog', { name: 'New event' });
	await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Joined Aggregates Event');
	await dialog.locator('#new-event-start').fill('2027-05-04');
	await dialog.locator('#new-event-start').press('Enter');
	await dialog.locator('#new-event-end').fill('2027-05-06');
	await dialog.locator('#new-event-end').press('Enter');
	await dialog.getByRole('button', { name: 'Create event' }).click();
	await expect(pipeline).toBeVisible();
}

test.beforeEach(async ({ context, baseURL }) => {
	if (!baseURL) throw new TypeError('Joined live browser base URL is required.');
	const origin = new URL(baseURL);
	await context.addCookies([{
		name: 'better-auth.session_token',
		value: await signedSessionValue(),
		domain: origin.hostname,
		path: '/',
		httpOnly: true,
		secure: false,
		sameSite: 'Lax'
	}]);
});

test('live review resolves the served organizer viewer and loads the no-round setup surface', async ({
	page
}) => {
	await ensureEvent(page);
	await page.goto('/app/review');

	// The organizer no-round surface: the snapshot served the organizer
	// projection (a reviewer would get the one-paragraph version with no setup
	// facts), and the round-setup read supplied the roster counts behind it.
	await expect(page.getByRole('heading', { level: 2, name: 'No review round yet' }))
		.toBeVisible();
	await expect(page.getByText('Review is one path: open the round,', { exact: false }))
		.toBeVisible();
	await expect(page.getByText('Nobody is on the review roster yet', { exact: false }))
		.toBeVisible();
	await expect(page.getByRole('link', { name: 'Invite reviewers' })).toBeVisible();

	// Honest refusal-by-design: with zero active reviewers the served counts
	// leave nothing to open, so no "Open the review round" action exists —
	// the prerequisite is offered instead of a disabled wish.
	await expect(page.getByRole('button', { name: 'Open the review round' })).toHaveCount(0);

	// No sample fallback anywhere on the surface.
	await expect(page.getByText(/Mid-flight|Decision crunch|All clear/)).toHaveCount(0);
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	// Reload: the same served state returns, not page memory.
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'No review round yet' }))
		.toBeVisible();
	await expect(page.getByText('Nobody is on the review roster yet', { exact: false }))
		.toBeVisible();

	await expectNoDocumentOverflow(page);
});
