import { expect, test, type Page } from '@playwright/test';

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

async function ensureEvent(page: Page): Promise<void> {
	await page.goto('/app');
	const firstRun = page.getByRole('button', { name: 'Fill in details myself' });
	const pipeline = page.getByRole('region', { name: 'Pipeline' });
	await expect(firstRun.or(pipeline).first()).toBeVisible();
	if (await pipeline.isVisible()) return;
	await firstRun.click();
	const dialog = page.getByRole('dialog', { name: 'New event' });
	await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Joined Live Event');
	await dialog.locator('#new-event-start').fill('2027-06-10');
	await dialog.locator('#new-event-start').press('Enter');
	await dialog.locator('#new-event-end').fill('2027-06-12');
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

test('real same-origin runtime exposes live data and no sample fallback', async ({
	page
}, testInfo) => {
	await page.goto('/app');

	await expect(page.getByRole('img', { name: 'JooEvents' }).first()).toBeVisible();
	if (testInfo.project.name === 'desktop') {
		// The joined server is shared across specs. Either this is the first
		// desktop spec, or an earlier acceptance journey already created the Event.
		const welcome = page.getByRole('heading', { level: 2, name: 'Welcome to JooEvents' });
		const pipeline = page.getByRole('region', { name: 'Pipeline' });
		await expect(welcome.or(pipeline).first()).toBeVisible();
		if (await welcome.isVisible()) {
			await expect(page.getByRole('button', { name: 'Fill in details myself' })).toBeEnabled();
		}
	}
	await expect(page.getByText(/Mid-flight|Decision crunch|All clear/)).toHaveCount(0);
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);
	await ensureEvent(page);

	// Communications mounts the complete live page: all three regions resolve
	// through registered reads and none falls back to the sample scenario.
	if ((page.viewportSize()?.width ?? 0) < 720) {
		await page.getByRole('button', { name: 'Open navigation' }).click();
	}
	await page.getByRole('link', { name: 'Communications', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Communications' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'History' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Email delivery' })).toBeVisible();
	await expect(page.getByText(/\bdelivered\b/i)).toHaveCount(0);

	await expectNoDocumentOverflow(page);
});

test('touch navigation is modal, traps focus, and restores the page on close', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'touch drawer behavior');
	await page.goto('/app');

	const open = page.getByRole('button', { name: 'Open navigation' });
	await open.click();

	const drawer = page.getByRole('dialog', { name: 'Navigation' });
	const close = drawer.getByRole('button', { name: 'Close navigation' });
	const firstLink = drawer.getByRole('link', { name: 'JooEvents' });
	// The Settings row is the rail's one door to the area — its sections live on
	// the surface itself — so it is the drawer's final focusable control.
	const lastControl = drawer.getByRole('link', { name: 'Settings', exact: true });
	await expect(drawer).toBeVisible();
	await expect(open).toHaveAttribute('aria-expanded', 'true');
	await expect(close).toBeFocused();
	await expect(page.locator('.body[inert]')).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => ({
		root: document.documentElement.style.overflow,
		body: document.body.style.overflow
	}))).toEqual({ root: 'hidden', body: 'hidden' });

	await page.keyboard.press('Shift+Tab');
	await expect(firstLink).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(lastControl).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(firstLink).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden();
	await expect(open).toHaveAttribute('aria-expanded', 'false');
	await expect(open).toBeFocused();
	await expect.poll(() => page.evaluate(() => ({
		root: document.documentElement.style.overflow,
		body: document.body.style.overflow
	}))).toEqual({ root: '', body: '' });
	await expectNoDocumentOverflow(page);
});
