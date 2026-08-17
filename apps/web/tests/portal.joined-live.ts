import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the participant portal cutover as the browser sees
 * it: the live entry ceremony (non-enumerating link request, dev-only issued
 * link, single-use and newest-wins semantics), the attributed-identity resume
 * onto the live snapshot, a portal-confirmed engagement that survives reload
 * as server truth, lane isolation for a second person, and the structural
 * unaddressability of anyone else's data.
 *
 * One shared ephemeral backend serves every project, so names carry the
 * project name and the vocabulary minted here is retired at the end (the
 * reviewers smoke later in the same project proves coverage over the active
 * vocabulary population).
 */

const rawToken = 'browser-test-owner-session-token';
const secret = 'browser-test-secret-that-is-at-least-thirty-two-bytes';
const DEV_ISSUED_LINK_PATH = '/api/portal/entry/dev/issued-link';

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

async function addOwnerCookie(context: {
	addCookies(cookies: readonly {
		name: string; value: string; domain: string; path: string;
		httpOnly: boolean; secure: boolean; sameSite: 'Lax';
	}[]): Promise<void>;
}, baseURL: string): Promise<void> {
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

/** Mints this project's track and format through the live Settings surface. */
async function ensureVocabulary(page: Page, trackName: string, formatName: string): Promise<void> {
	await page.goto('/app/settings/program');
	const basics = page.getByRole('region', { name: 'Program basics' });
	await expect(basics).toBeVisible();
	if (await basics.getByText(trackName, { exact: true }).count() === 0) {
		await basics.getByLabel('Track name').fill(trackName);
		await basics.getByRole('button', { name: 'Add track' }).click();
		await expect(basics.getByText(trackName, { exact: true })).toBeVisible();
	}
	if (await basics.getByText(formatName, { exact: true }).count() === 0) {
		await basics.getByLabel('Format name').fill(formatName);
		await basics.getByRole('button', { name: 'Add format' }).click();
		await expect(basics.getByText(formatName, { exact: true })).toBeVisible();
	}
}

/** Opens this project's CFP at its format pool so an accept can graduate. */
async function ensureOpenForm(page: Page, formName: string, formatName: string): Promise<void> {
	await page.goto('/app/forms');
	const list = page.getByRole('region', { name: 'Forms' });
	await expect(list).toBeVisible();
	if (await list.getByText(formName, { exact: true }).count() > 0) return;
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
	await expect(page.getByRole('button', { name: 'Close form', exact: true })).toBeVisible();
}

/** A real direct entry through the live dialog, into the review inbox. */
async function addSubmission(page: Page, input: {
	readonly name: string;
	readonly email: string;
	readonly title: string;
	readonly trackName: string;
	readonly formatName: string;
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

/** Accept on Decisions: the same commit graduates the session and seeds the invited engagement. */
async function acceptSubmission(page: Page, title: string, trackName: string): Promise<void> {
	await page.goto('/app/decisions');
	const verdicts = page.getByRole('group', { name: `Set decision for “${title}”` });
	await expect(verdicts).toBeVisible({ timeout: 15000 });
	await verdicts.getByRole('button', { name: 'Accept', exact: true }).click();
	const confirmation = page.getByRole('dialog', { name: 'Accept 1 submission?' });
	if (await confirmation.count()) {
		await confirmation.getByRole('combobox', { name: title }).selectOption({ label: trackName });
		await confirmation.getByRole('button', { name: 'Accept 1', exact: true }).click();
	}
	const decidedRow = page.getByRole('row', {
		name: new RegExp(title.replace(/[()]/g, '\\$&'))
	});
	await expect(decidedRow.getByText('Accepted', { exact: true })).toBeVisible({ timeout: 15_000 });
}

async function requestPortalLink(page: Page, email: string): Promise<void> {
	await page.getByLabel('Email address').fill(email);
	await page.getByRole('button', { name: 'Email me a magic link' }).click();
	await expect(page.getByText(email)).toBeVisible(); // check-your-email echo
}

/** The dev delivery control: the actually issued link for this address. */
async function issuedLink(request: APIRequestContext, email: string): Promise<string> {
	const response = await request.post(DEV_ISSUED_LINK_PATH, { data: { email } });
	expect(response.ok()).toBe(true);
	const body = await response.json() as { kind: string; url?: string };
	expect(body.kind).toBe('issued');
	expect(body.url).toMatch(/^\/portal\/auth\/complete\?/);
	return body.url as string;
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/portal');
	await expect(page).toHaveURL(/\/portal\/sign-in/); // anonymous lane bounces to entry
	await requestPortalLink(page, email);
	const url = await issuedLink(page.request, email);
	await page.goto(url);
	await expect(page).toHaveURL(/\/portal(\?.*)?$/); // completed ceremony lands home
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

// Runs even when a test above failed: the vocabulary this spec minted must
// never outlive it as an active entry (the reviewers smoke later in this
// project proves coverage over the active vocabulary population).
test.afterAll(async ({ browser }, testInfo) => {
	const baseURL = `http://127.0.0.1:${process.env.JOOEVENTS_BROWSER_TEST_PORT ?? '4184'}`;
	const context = await browser.newContext({ baseURL });
	await addOwnerCookie(context, baseURL);
	const page = await context.newPage();
	await page.goto('/app/settings/program');
	const basics = page.getByRole('region', { name: 'Program basics' });
	await expect(basics).toBeVisible();
	for (const name of [
		`Portal track ${testInfo.project.name}`,
		`Portal format ${testInfo.project.name}`
	]) {
		const menu = basics.getByRole('button', { name: `More actions for ${name}` });
		const present = await menu.waitFor({ state: 'visible', timeout: 10_000 })
			.then(() => true, () => false);
		if (!present) continue;
		await menu.click();
		await basics.getByRole('button', { name: `Retire ${name}` }).click();
		await expect(basics.getByRole('button', { name: `Restore ${name}` })).toBeVisible();
	}
	await context.close();
});

test('the magic-link ceremony resumes the intake-attributed identity onto the live portal', async ({
	page
}, testInfo) => {
	const project = testInfo.project.name;
	const title = `Portal talk (${project})`;
	const speaker = `Portal Speaker ${project}`;
	const email = `portal.${project}@joined.example`;

	await ensureEvent(page);
	await ensureVocabulary(page, `Portal track ${project}`, `Portal format ${project}`);
	await ensureOpenForm(page, `Portal CFP ${project}`, `Portal format ${project}`);
	await addSubmission(page, {
		name: speaker,
		email,
		title,
		trackName: `Portal track ${project}`,
		formatName: `Portal format ${project}`
	});
	await acceptSubmission(page, title, `Portal track ${project}`);

	await signIn(page, email);
	// Live world, no sample fallback anywhere on it.
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);
	await expect(page.getByText(/Sample data/)).toHaveCount(0);
	// The intake-attributed identity sees their own world: the accepted talk's
	// engagement, served from the participant lane.
	await expect(page.getByText(title).first()).toBeVisible({ timeout: 15000 });
	await expectNoDocumentOverflow(page);
});

test('an invitation answered in the portal is server truth and survives reload', async ({
	page
}, testInfo) => {
	const project = testInfo.project.name;
	const title = `Portal talk (${project})`;
	const email = `portal.${project}@joined.example`;

	await signIn(page, email);
	await expect(page.getByText(title).first()).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: 'Yes, I can speak' }).first().click();
	await expect(page.getByText(/You confirmed/).first()).toBeVisible({ timeout: 15000 });
	await page.reload();
	await expect(page.getByText('Confirmed').first()).toBeVisible({ timeout: 15000 });
});

test('a link is single-use: the second follow refuses honestly', async ({
	page,
	browser,
	baseURL
}, testInfo) => {
	const email = `portal.${testInfo.project.name}@joined.example`;
	await page.goto('/portal/sign-in');
	await requestPortalLink(page, email);
	const url = await issuedLink(page.request, email);
	await page.goto(url);
	await expect(page).toHaveURL(/\/portal(\?.*)?$/);
	const second = await browser.newContext({ baseURL: baseURL ?? undefined });
	const other = await second.newPage();
	await other.goto(url);
	await expect(other.getByText(/already used/i).first()).toBeVisible();
	await second.close();
});

test('newest wins: requesting again revokes the prior unused link', async ({ page }, testInfo) => {
	const email = `portal.${testInfo.project.name}@joined.example`;
	await page.goto('/portal/sign-in');
	await requestPortalLink(page, email);
	const first = await issuedLink(page.request, email);
	await page.getByRole('button', { name: 'Try another address' }).click();
	await requestPortalLink(page, email);
	const second = await issuedLink(page.request, email);
	expect(second).not.toBe(first);
	await page.goto(first); // superseded → the honest no-longer-valid lane copy
	await expect(page.getByText(/no longer valid/i).first()).toBeVisible();
	await page.goto(second);
	await expect(page).toHaveURL(/\/portal(\?.*)?$/);
});

test('sign out ends the lane-separate session; the next visit is anonymous', async ({
	page
}, testInfo) => {
	const email = `portal.${testInfo.project.name}@joined.example`;
	await signIn(page, email);
	await page.getByRole('button', { name: 'Your account' }).click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/portal\/sign-in/);
	await page.goto('/portal');
	await expect(page).toHaveURL(/\/portal\/sign-in/); // authority re-evaluated per request
});

test('another person sees only their own world, and nobody is addressable by key', async ({
	page,
	browser,
	baseURL
}, testInfo) => {
	const project = testInfo.project.name;
	const title = `Portal talk (${project})`;
	const stranger = `stranger.${project}@joined.example`;

	// A second, unattributed address completes its own non-enumerating ceremony
	// and gets an honest empty portal: none of the speaker's world leaks.
	const second = await browser.newContext({ baseURL: baseURL ?? undefined });
	const other = await second.newPage();
	await other.goto('/portal/sign-in');
	await requestPortalLink(other, stranger);
	const url = await issuedLink(other.request, stranger);
	await other.goto(url);
	await expect(other).toHaveURL(/\/portal(\?.*)?$/);
	// Anchor on the served portal before asserting absences, so an in-flight
	// read can never pass them vacuously.
	await expect(
		other.getByRole('heading', { name: 'Joined Aggregates Event' })
	).toBeVisible({ timeout: 15000 });
	await expect(other.getByText(title)).toHaveCount(0);
	await expect(other.getByText(`Portal Speaker ${project}`)).toHaveCount(0);
	// The lane is structurally unaddressable: person-keyed addressing does not
	// exist as a request shape even for a signed-in participant. Probed from
	// the page itself so the lane cookie rides exactly as the portal sends it.
	const addressedStatus = await other.evaluate(async () => {
		const response = await fetch('/api/portal/snapshot?personId=someone-else');
		return response.status;
	});
	expect(addressedStatus).toBe(400);
	await second.close();

	const anonymous = await browser.newContext({ baseURL: baseURL ?? undefined });
	const bare = await anonymous.request.get('/api/portal/snapshot');
	expect(bare.status()).toBe(401);
	await anonymous.close();
	void page;
});
