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

test('live review paints assigned candidate evidence from the reviewer-safe snapshot', async ({
	page
}) => {
	await ensureEvent(page);
	const id = (value: number) =>
		`00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
	const reviewerId = id(201);
	const roundId = id(202);
	const submissionId = id(203);

	// This focused browser seam keeps the real live composition and contract
	// decoder in play while substituting the authority projection a signed-in
	// reviewer would receive. It mutates no shared retained state, so the joined
	// suite's later projects remain independent.
	await page.route('**/api/events/current/review/snapshot*', async (route) => {
		const response = await route.fetch();
		const envelope = await response.json();
		await route.fulfill({ response, json: {
			...envelope,
			data: {
				schemaVersion: 1,
				viewer: { kind: 'reviewer', reviewerId },
				plans: [{
					id: roundId,
					ordinal: 1,
					name: 'Round 1',
					state: 'open',
					version: 1,
					scaleMax: 5,
					deadlineEffectiveAt: '2027-05-03T23:59:59.000Z',
					criteria: [{
						id: id(204), key: 'overall', label: 'Overall', position: 0,
						weightBps: 10_000, scaleMin: 1, scaleMax: 5
					}],
					anonymized: true,
					antiAnchoring: true,
					done: 0,
					total: 1,
					reviewers: [{
						reviewerId, displayName: 'Reviewer A', assigned: 1, done: 0,
						steppedBack: 0, awaitingReassignment: 0
					}]
				}],
				reviewerScope: [],
				queue: [{
					assignmentId: id(205),
					roundId,
					submissionId,
					assignmentVersion: 1,
					candidate: {
						submissionId,
						version: 1,
						title: 'The retained queue is the detail source',
						abstract: 'Reviewers can judge this candidate without entering the organizer inbox.',
						submittedAt: '2027-04-20T09:00:00.000Z',
						resources: [{
							resourceId: id(206), name: 'Proposal deck', kind: 'slides', detail: 'PDF'
						}]
					},
					draft: { version: 1, score: 4, comment: 'Promising direction' },
					committed: false,
					revisions: []
				}],
				standings: {}
			}
		} });
	});

	await page.goto('/app/review');
	await expect(page.getByRole('heading', { name: 'The retained queue is the detail source' }))
		.toBeVisible();
	await expect(page.getByText(
		'Reviewers can judge this candidate without entering the organizer inbox.'
	)).toBeVisible();
	await expect(page.getByText('Proposal deck')).toBeVisible();
	await expect(page.getByText('Reviewer A')).toHaveCount(0);
	await expect(page.getByText('Nothing is assigned to you.')).toHaveCount(0);
	await expectNoDocumentOverflow(page);
});
