import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const rawToken = 'browser-test-owner-session-token';
const secret = 'browser-test-secret-that-is-at-least-thirty-two-bytes';
const DEV_ISSUED_LINK_PATH = '/api/portal/entry/dev/issued-link';

async function signedSessionValue(): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
	return `${rawToken}.${Buffer.from(signature).toString('base64')}`;
}

async function addOwnerCookie(context: { addCookies(cookies: readonly {
		name: string; value: string; domain: string; path: string;
		httpOnly: boolean; secure: boolean; sameSite: 'Lax';
	}[]): Promise<void> }, baseURL: string): Promise<void> {
	const origin = new URL(baseURL);
	await context.addCookies([{
		name: 'better-auth.session_token', value: await signedSessionValue(),
		domain: origin.hostname, path: '/', httpOnly: true, secure: false, sameSite: 'Lax'
	}]);
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

async function ensureVocabulary(page: Page, trackName: string, formatName: string): Promise<void> {
	const loaded = page.waitForResponse((response) =>
		new URL(response.url()).pathname === '/api/events/current/program-vocabulary'
		&& response.request().method() === 'GET'
	);
	await page.goto('/app/settings/program');
	const basics = page.getByRole('region', { name: 'Program basics' });
	await expect(basics).toBeVisible();
	await loaded;
	if (await basics.getByText(trackName, { exact: true }).count() === 0) {
		await basics.getByLabel('Track name').fill(trackName);
		await basics.getByRole('button', { name: 'Add track' }).click();
		await expect(basics.getByText(trackName, { exact: true }).first()).toBeVisible();
	}
	if (await basics.getByText(formatName, { exact: true }).count() === 0) {
		await basics.getByLabel('Format name').fill(formatName);
		await basics.getByRole('button', { name: 'Add format' }).click();
		await expect(basics.getByText(formatName, { exact: true }).first()).toBeVisible();
	}
}

async function createAndPublishForm(
	page: Page,
	formName: string,
	formatName: string
): Promise<string> {
	await page.goto('/app/forms');
	const forms = page.getByRole('region', { name: 'Forms' });
	await expect(forms).toBeVisible();
	let card = forms.locator('.card').filter({ hasText: formName });
	if (await card.count() === 0) {
		await page.getByRole('button', { name: 'New form' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'New form' });
		await dialog.getByLabel('Name').fill(formName);
		await dialog.getByRole('combobox', { name: 'Collects for' }).click();
		await page.getByRole('option', { name: /A category pool/ }).click();
		await dialog.getByLabel('Which track or format').selectOption({ label: formatName });
		await dialog.getByRole('button', { name: 'Create form' }).click();
		await page.getByRole('button', { name: 'Publish and open', exact: true }).click();
		const review = page.getByRole('dialog', { name: 'Review publication' });
		await expect(review).toBeVisible();
		await review.getByRole('button', { name: 'Publish and open', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Close form', exact: true })).toBeVisible({
			timeout: 15_000
		});

		const publishPage = page.getByRole('link', { name: 'Publish the page in Templates' });
		if (await publishPage.count()) {
			await publishPage.click();
			await expect(page.getByRole('heading', { name: 'Speaker application' })).toBeVisible();
			const publish = page.getByRole('button', { name: /^(?:Publish|Published)$/ });
			await expect(publish).toBeVisible();
			if ((await publish.textContent()) !== 'Published') {
				await publish.click();
				await expect(page.getByRole('button', { name: 'Published', exact: true })).toBeVisible({
					timeout: 15_000
				});
			}
		}
		await page.goto('/app/forms');
		card = page.getByRole('region', { name: 'Forms' }).locator('.card').filter({ hasText: formName });
	}
	await expect(card).toBeVisible();
	await card.getByRole('link', { name: 'Questions' }).click();
	const address = page.locator('.conf__address-url');
	await expect(address).toBeVisible({ timeout: 15_000 });
	const href = await address.getAttribute('href');
	if (!href) throw new Error('Published application address missing.');
	return href;
}

async function proveSecondOpenFormIsNotClaimedLive(
	page: Page,
	formName: string,
	formatName: string
): Promise<void> {
	await page.goto('/app/forms');
	await page.getByRole('button', { name: 'New form' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'New form' });
	await dialog.getByLabel('Name').fill(formName);
	await dialog.getByRole('combobox', { name: 'Collects for' }).click();
	await page.getByRole('option', { name: /A category pool/ }).click();
	await dialog.getByLabel('Which track or format').selectOption({ label: formatName });
	await dialog.getByRole('button', { name: 'Create form' }).click();
	await page.getByRole('button', { name: 'Publish and open', exact: true }).click();
	await page.getByRole('dialog', { name: 'Review publication' })
		.getByRole('button', { name: 'Publish and open', exact: true }).click();

	const address = page.locator('.conf__address');
	await expect(address).toContainText(
		'The application page is published for a different form',
		{ timeout: 15_000 }
	);
	await expect(address).toContainText('This address turns visitors away');
	await expect(address.locator('.conf__address-url')).toHaveCount(0);

	// Keep the shared joined fixture tidy for the next viewport.
	await page.getByRole('button', { name: 'Close form', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Reopen form', exact: true })).toBeVisible();
}

async function addForeignSubmission(page: Page, input: {
	name: string; email: string; title: string; trackName: string; formatName: string;
}): Promise<void> {
	await page.goto('/app/submissions');
	await expect(page.getByRole('radiogroup', { name: 'Submission trays' })).toBeVisible();
	await page.getByRole('button', { name: 'Add submission' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Add a submission' });
	await dialog.getByLabel('Name').fill(input.name);
	await dialog.getByLabel('Email').fill(input.email);
	await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(input.title);
	await dialog.getByRole('combobox', { name: 'Track' }).selectOption({ label: input.trackName });
	await dialog.getByRole('combobox', { name: 'Format' }).selectOption({ label: input.formatName });
	await dialog.getByText('Review inbox', { exact: true }).click();
	await dialog.getByRole('button', { name: 'Add to inbox' }).click();
	await expect(dialog).not.toBeVisible();
}

async function issuedLink(request: APIRequestContext, email: string): Promise<string> {
	const response = await request.post(DEV_ISSUED_LINK_PATH, { data: { email } });
	expect(response.ok()).toBe(true);
	const body = await response.json() as { kind: string; url?: string };
	expect(body.kind).toBe('issued');
	expect(body.url).toMatch(/^\/portal\/auth\/complete\?/);
	return body.url as string;
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, baseURL }) => {
	if (!baseURL) throw new TypeError('Joined live browser base URL is required.');
	await addOwnerCookie(context, baseURL);
});

test('an anonymous application becomes the same participant’s visible proposal after mailbox proof', async ({
	page,
	context
}, testInfo) => {
	const project = testInfo.project.name;
	const trackName = 'External track joined';
	const formatName = 'External format joined';
	const formName = 'External CFP joined';
	const title = `Agent-shaped events (${project})`;
	const email = `external.${project}.${crypto.randomUUID()}@joined.example`;
	const foreignTitle = `Somebody else’s proposal (${project})`;

	await ensureEvent(page);
	await ensureVocabulary(page, trackName, formatName);
	const publicAddress = await createAndPublishForm(page, formName, formatName);
	await proveSecondOpenFormIsNotClaimedLive(
		page,
		`Unpinned CFP ${project} ${crypto.randomUUID()}`,
		formatName
	);
	await addForeignSubmission(page, {
		name: 'Foreign Speaker',
		email: `foreign.${project}.${crypto.randomUUID()}@joined.example`,
		title: foreignTitle,
		trackName,
		formatName
	});

	// The application lane starts anonymous; an organizer session must not be
	// what makes the public form or its later participant authority work.
	await context.clearCookies();
	await page.goto(publicAddress);
	await expect(page.getByRole('form', { name: formName })).toBeVisible({ timeout: 15_000 });
	await page.getByLabel('Your name').fill(`External Speaker ${project}`);
	await page.getByLabel('Headline').fill('Conference speaker');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Talk title').fill(title);
	await page.getByLabel('Abstract').fill('A practical session about event operations for agent users.');
	await page.getByLabel('Format').selectOption({ label: formatName });
	await page.getByLabel('Track').selectOption({ label: trackName });
	await page.getByRole('checkbox').check();
	await expect(page.getByRole('button', { name: 'Submit application' })).toBeEnabled();
	await page.getByRole('button', { name: 'Submit application' }).click();

	await expect(page.getByText('Application received', { exact: true })).toBeVisible({ timeout: 15_000 });
	const door = page.getByRole('link', { name: 'See your application' });
	await expect(door).toHaveAttribute('href', '/portal/sign-in');
	await expect(door).not.toHaveAttribute('href', /email|token|person|submission/i);
	await expectNoDocumentOverflow(page);

	await door.click();
	await expect(page).toHaveURL(/\/portal\/sign-in$/);
	await page.getByLabel('Email address').fill(email);
	await page.getByRole('button', { name: 'Email me a magic link' }).click();
	await expect(page.getByText(email)).toBeVisible();
	const link = await issuedLink(page.request, email);
	await page.goto(link);
	await expect(page.getByRole('heading', { name: 'What you sent' })).toBeVisible({ timeout: 15_000 });
	const ownRow = page.getByRole('link').filter({ hasText: title });
	await expect(ownRow).toBeVisible();
	await expect(ownRow).toContainText('Received');
	await expect(page.getByText(foreignTitle, { exact: true })).toHaveCount(0);
	await expect(page.getByText(/Organizer notes|Review score|Internal decision/i)).toHaveCount(0);
	await expectNoDocumentOverflow(page);
});
