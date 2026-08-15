import { expect, test } from '@playwright/test';

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

test.beforeEach(async ({ context, baseURL }) => {
	if (!baseURL) throw new TypeError('Event browser base URL is required.');
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

test('first Event joins the tuned live Settings interactions through registered operations', async ({
	page
}) => {
	const posts: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
	});

	await page.goto('/app');
	await expect(page.getByRole('heading', {
		level: 2,
		name: 'Welcome to JooEvents'
	})).toBeVisible();
	await page.getByRole('button', { name: 'Fill in details myself' }).click();
	const newEvent = page.getByRole('dialog', { name: 'New event' });
	await newEvent.getByRole('textbox', { name: 'Name', exact: true }).fill('Joined Settings Event');
	await newEvent.locator('#new-event-start').fill('2027-03-10');
	await newEvent.locator('#new-event-start').press('Enter');
	await newEvent.locator('#new-event-end').fill('2027-03-12');
	await newEvent.locator('#new-event-end').press('Enter');
	await newEvent.getByRole('button', { name: 'Create event' }).click();
	await expect(page.getByRole('region', { name: 'Pipeline' })).toBeVisible();
	await expect(page.getByText('Event-stage progress is not available yet.').first()).toBeVisible();
	await expect(page.getByRole('region', { name: 'Needs attention' })
		.getByText('Attention signals are not available yet.')).toBeVisible();

	// Settings is a group of sections, each its own address; the group address
	// opens on the first of them.
	await page.goto('/app/settings');
	await expect(page).toHaveURL(/\/app\/settings\/event$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Event identity' })).toBeVisible();
	await expect(page.getByLabel('Event name')).toHaveValue('Joined Settings Event');

	await page.getByLabel('Event name').fill('Joined Settings Event Updated');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

	await page.getByRole('navigation', { name: 'Settings' })
		.getByRole('link', { name: 'Program', exact: true })
		.click();
	await expect(page.getByRole('region', { name: 'Program basics' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Speaker fields' })).toBeVisible();
	await page.getByLabel('Track name').fill('Browser joined track');
	await page.getByRole('button', { name: 'Add track' }).click();
	await expect(page.getByText('Browser joined track', { exact: true })).toBeVisible();

	await page.getByRole('navigation', { name: 'Settings' })
		.getByRole('link', { name: 'Team', exact: true })
		.click();
	await expect(page.getByRole('region', { name: 'Team' })).toBeVisible();
	await page.getByRole('button', { name: 'Invite member' }).click();
	const invite = page.getByRole('dialog', { name: 'Invite a member' });
	await invite.getByRole('textbox', { name: 'Email address' })
		.fill('browser-reviewer@example.test');
	await invite.getByRole('button', { name: 'Send invitation' }).click();
	const team = page.getByRole('region', { name: 'Team' });
	await expect(team.getByText('browser-reviewer@example.test', { exact: true })).toBeVisible();
	await expect(team.getByRole('status').filter({
		hasText: 'Invitation recorded for browser-reviewer@example.test. Delivery is awaiting activation.'
	})).toBeVisible();

	// Each section re-reads its own committed state from its own address.
	await page.reload();
	await expect(page.getByRole('region', { name: 'Team' })
		.getByText('browser-reviewer@example.test', { exact: true })).toBeVisible();
	await page.goto('/app/settings/event');
	await expect(page.getByLabel('Event name')).toHaveValue('Joined Settings Event Updated');
	await page.goto('/app/settings/program');
	await expect(page.getByText('Browser joined track', { exact: true })).toBeVisible();
	await expect(page.getByText(/Mid-flight|Decision crunch|All clear/)).toHaveCount(0);
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	expect(posts).toEqual([
		'/api/events/drafts/create',
		'/api/changesets/proposals',
		'/api/changesets/commits',
		'/api/events/current/settings/drafts/update',
		'/api/changesets/proposals',
		'/api/changesets/commits',
		'/api/events/current/program-vocabulary/drafts/create',
		'/api/changesets/proposals',
		'/api/changesets/commits',
		'/api/workspace/team/invitations/drafts',
		'/api/changesets/proposals',
		'/api/changesets/commits'
	]);
	expect(posts).not.toContain('/api/events');
	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
});
