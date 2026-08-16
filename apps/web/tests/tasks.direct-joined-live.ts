import { expect, test, type Page } from '@playwright/test';

/**
 * Acceptance-shaped join for the Task owner: the tuned browser surface sends
 * one `task.mutation@1` request, the runtime commits it, and the canonical
 * board read still contains it after a reload.
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

test('the Tasks page creates one definition through one direct request and reloads it', async ({
	page
}, testInfo) => {
	const taskName = `Joined task ${testInfo.project.name}`;
	let mutationCalls = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events/current/tasks') {
			mutationCalls += 1;
		}
	});

	await ensureEvent(page);
	await page.goto('/app/tasks');
	await page.getByRole('button', { name: /Create (a task definition|task)/ }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Create a task definition' });
	await dialog.getByRole('textbox', { name: 'Task name' }).fill(taskName);
	await dialog.getByLabel('Due date').fill('2027-05-05');
	await dialog.getByLabel('Due date').press('Enter');
	await dialog.getByRole('button', { name: 'Create task' }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByText(`${taskName} created for confirmed speakers.`, { exact: true })).toBeVisible();
	await expect.poll(() => mutationCalls).toBe(1);

	await page.reload();
	const response = await page.request.get('/api/events/current/tasks');
	expect(response.ok()).toBe(true);
	const result = await response.json() as {
		readonly kind: string;
		readonly data?: { readonly definitions?: ReadonlyArray<{ readonly current?: { readonly name?: string } }> };
	};
	expect(result.kind).toBe('success');
	expect(result.data?.definitions?.some((definition) => definition.current?.name === taskName)).toBe(true);
	expect(mutationCalls).toBe(1);
	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
});
