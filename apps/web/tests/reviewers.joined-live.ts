import { expect, test, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the newly mounted live Reviewers aggregate
 * (reviewer_roster.snapshot.read behind the tuned roster, load counts from
 * the organizer-served review snapshot, coverage served only as its proven
 * empty population).
 *
 * The joined harness serves one shared ephemeral backend for every project in
 * the run, so this spec creates the event only when the workspace is still
 * first-run. The schedule smoke retires the vocabulary it mints precisely so
 * this roster's `coverage: []` claim stays provable on every project's pass.
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

test('live reviewers renders the empty roster and the typed invite refusal', async ({ page }) => {
	await ensureEvent(page);
	await page.goto('/app/reviewers');

	// The canonical roster is empty and says which kind of empty this is.
	await expect(page.getByText('No reviewers yet', { exact: true })).toBeVisible();
	await expect(page.getByText(/Mid-flight|Decision crunch|All clear/)).toHaveCount(0);
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	// Typed refusal: email-keyed reviewer authority is forbidden by design, so
	// every invited line reports the served refusal instead of a silent no-op
	// or an invented roster row.
	await page.getByRole('button', { name: 'Invite reviewers' }).first().click();
	const invite = page.getByRole('dialog', { name: 'Invite reviewers' });
	await invite.getByRole('textbox', { name: 'Email addresses' })
		.fill('joined-smoke-reviewer@example.test');
	await invite.getByRole('button', { name: 'Record invitations' }).click();
	await expect(invite.getByText('0 recorded, 1 not recorded.')).toBeVisible();
	await expect(invite.getByText(
		'Inviting reviewers by email is not available in this live workspace yet. '
		+ 'Reviewer access is reserved through workspace member admission.'
	)).toBeVisible();
	await invite.getByRole('button', { name: 'Cancel' }).click();

	// Reload: the roster stays the served empty population, untouched by the
	// refused invitations.
	await page.reload();
	await expect(page.getByText('No reviewers yet', { exact: true })).toBeVisible();

	await expectNoDocumentOverflow(page);
});

test('a reviewer without disclosed contact has no empty copy control', async ({ page }) => {
	await ensureEvent(page);

	const teamResponse = await page.request.get('/api/workspace/team');
	expect(teamResponse.ok()).toBe(true);
	const teamPayload = await teamResponse.json();
	expect(teamPayload.kind).toBe('success');
	const owner = teamPayload.data.members.find(
		(member: { kind: string }) => member.kind === 'member'
	);
	expect(owner).toBeTruthy();

	const rosterResponse = await page.request.get('/api/events/current/reviewer-roster');
	expect(rosterResponse.ok()).toBe(true);
	const rosterPayload = await rosterResponse.json();
	expect(rosterPayload.kind).toBe('success');

	const reviewerId = '00000000-0000-4000-8000-000000000091';
	const subject = {
		kind: 'workspace_membership',
		id: owner.id,
		version: owner.version
	};
	const reviewer = {
		reviewerId,
		recordVersion: 1,
		projectionVersion: 1,
		status: 'active',
		accessSubject: subject,
		authority: {
			schemaVersion: 1,
			scope: rosterPayload.data.scope,
			rosterSubject: subject,
			currentSubject: subject,
			state: 'active',
			version: 1,
			digestSha256: 'a'.repeat(64),
			capabilityIds: [
				'event.read',
				'speaker.directory.read',
				'submission.read',
				'submission.score',
				'submission.comment',
				'schedule.read'
			],
			evidenceIds: ['browser:no-contact-reviewer'],
			displayName: 'Avery Stone'
		},
		displayName: 'Avery Stone',
		reviews: []
	};

	await page.route('**/api/events/current/reviewer-roster', (route) => route.fulfill({
		json: {
			...rosterPayload,
			data: { ...rosterPayload.data, reviewers: [reviewer] }
		}
	}));
	// The roster identity remains visible, but the organizer Team projection
	// deliberately has no matching subject and therefore discloses no address.
	await page.route('**/api/workspace/team', (route) => route.fulfill({
		json: {
			...teamPayload,
			data: {
				...teamPayload.data,
				members: teamPayload.data.members.filter(
					(member: { id: string }) => member.id !== owner.id
				)
			}
		}
	}));

	await page.goto('/app/reviewers');
	await expect(page.getByText('Avery Stone', { exact: true }).filter({ visible: true })).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Copy email address' })).toHaveCount(0);
	await expectNoDocumentOverflow(page);
});
