import { expect, test, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the live Schedule aggregate (session.catalog.read +
 * session.change, placement snapshot, the live Program Vocabulary, the
 * whole-population proposal counter, and — since the Wave-2 geometry join —
 * the day grid derived from the event's own settings trio).
 *
 * The joined harness serves one shared ephemeral backend for every project in
 * the run, so this spec is written to be re-runnable against its own residue:
 * the event is created only when the workspace is still first-run, the shared
 * room is added only while the board still shows its no-grid state, and names
 * minted here carry the project name. The inline-minted format is retired at
 * the end on purpose — the live Reviewers surface can serve `coverage: []`
 * only while no active track/format/collecting-session target exists, so this
 * spec must not leave an active vocabulary entry behind for the reviewers
 * smoke in the next project.
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

test('live schedule renders the settings-derived grid, publication state, and a placed session', async ({
	page
}, testInfo) => {
	const formatName = `Joined format ${testInfo.project.name}`;
	const sessionTitle = `Joined smoke session (${testInfo.project.name})`;

	await ensureEvent(page);
	await page.goto('/app/schedule');

	// Geometry honesty both ways: the derived day list exists (the event's own
	// dates under the seeded 09:00–18:00/30 trio), but without a room there is
	// still no grid to draw — and the first project adds the shared room
	// through the honest blank state's own form.
	// The blank state names the supply that is actually missing rather than
	// claiming the schedule is empty.
	const dayGroup = page.getByRole('group', { name: 'Schedule day' });
	const blank = page.getByRole('heading', { level: 2, name: 'The board has no rooms yet' });
	await expect(blank.or(dayGroup).first()).toBeVisible();
	if (await blank.isVisible()) {
		await page.getByLabel('Room name').fill('Joined Hall');
		await page.getByLabel('Seats').fill('120');
		await page.getByRole('button', { name: 'Add room' }).click();
	}

	// The rendered grid: day columns from the event's own date range —
	// 2027-05-04..06 — and the seeded 09:00 window on the time rail. Never a
	// browser-locale guess; these labels are UTC-derived on the served keys.
	await expect(dayGroup).toBeVisible();
	await expect(dayGroup.getByRole('button', { name: 'Tue May 4' })).toBeVisible();
	await expect(dayGroup.getByRole('button', { name: 'Wed May 5' })).toBeVisible();
	await expect(dayGroup.getByRole('button', { name: 'Thu May 6' })).toBeVisible();
	const grid = page.locator('section[aria-label="Schedule grid"]');
	await expect(grid).toBeVisible();
	await expect(grid.getByText('09:00', { exact: true }).first()).toBeVisible();
	await expect(page.getByText(/Mid-flight|Decision crunch|All clear/)).toHaveCount(0);
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	// The joined runtime is shared across specs, so the board arrives either
	// unpublished or already carrying the canonical release read's Published
	// state. Where the control stands, it opens the real reviewed lane: one
	// draft request states what the release carries and which names it makes
	// public, and nothing reaches public state until the second press.
	const publish = page.getByRole('button', { name: 'Publish', exact: true });
	const published = page.getByText('Published', { exact: true });
	await expect(publish.or(published).first()).toBeVisible();
	if (await publish.isVisible()) {
		await publish.click();
		const review = page.getByRole('region', { name: /^Review release \d+$/ });
		await expect(review).toBeVisible({ timeout: 15000 });
		await expect(review.getByText('Nothing is public yet.')).toBeVisible();
		// The disclosure is the point of the ceremony: the names the commit
		// copies into public state are stated before the press, never after.
		await expect(review.getByRole('heading', { name: /^\d+ speaker names? becomes? public$/ }))
			.toBeVisible();
		// Standing it down leaves the board exactly as it was.
		await review.getByRole('button', { name: 'Cancel' }).click();
		await expect(review).toHaveCount(0);
		await expect(publish).toBeVisible();
	}

	// Consequential path: create a session through the dialog. The fresh event
	// has no formats, so the dialog's inline vocabulary mint is part of the
	// same flow (live Program Vocabulary draft -> propose -> commit). The
	// rendered board offers the door twice (board head and pool panel); either
	// opens the same dialog.
	await page.getByRole('button', { name: 'New session…' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New session' });
	await dialog.getByRole('textbox', { name: 'Title' }).fill(sessionTitle);
	await dialog.getByRole('button', { name: 'New format' }).click();
	await dialog.getByLabel('New format name').fill(formatName);
	await dialog.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(dialog.getByText(`“${formatName}” added to the event's formats and selected.`))
		.toBeVisible();
	await dialog.getByRole('button', { name: 'Create', exact: true }).click();

	// The created session lands in the program pool from the canonical catalog.
	const pool = page.getByRole('region', { name: 'Program' });
	await expect(pool.getByText(sessionTitle, { exact: true })).toBeVisible();

	// Place it: aim from the pool, take the first served opening, and commit
	// through the one direct placement operation.
	await pool.getByRole('button', { name: `Place “${sessionTitle}”` }).click();
	await page.getByRole('button', { name: /^Opening / }).first().click();
	const confirm = page.getByRole('dialog', { name: 'Place session' });
	await expect(confirm).toBeVisible();
	await confirm.getByRole('button', { name: /^Place session/ }).click();
	await expect(confirm).not.toBeVisible();
	await expect(grid.getByText(sessionTitle, { exact: true })).toBeVisible();

	// Reload: the placement is canonical state rendered from the derived
	// geometry, not page memory.
	await page.reload();
	await expect(page.getByRole('group', { name: 'Schedule day' })).toBeVisible();
	await expect(page.locator('section[aria-label="Schedule grid"]')
		.getByText(sessionTitle, { exact: true })).toBeVisible();
	await expectNoDocumentOverflow(page);

	// Leave no active coverage target behind (see the header comment): retire
	// the format this run minted through the live Settings vocabulary surface.
	await page.goto('/app/settings/program');
	const basics = page.getByRole('region', { name: 'Program basics' });
	await expect(basics.getByText(formatName, { exact: true })).toBeVisible();
	await basics.getByRole('button', { name: `More actions for ${formatName}` }).click();
	await basics.getByRole('button', { name: `Retire ${formatName}` }).click();
	// A retired entry offers Restore in place of the retire menu.
	await expect(basics.getByRole('button', { name: `Restore ${formatName}` })).toBeVisible();
});
