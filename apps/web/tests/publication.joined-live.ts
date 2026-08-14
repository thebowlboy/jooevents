import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the Wave-4 publication vertical as the browser
 * sees it: before any program release the hosted schedule serves the honest
 * not-published gate (never an empty page pretending to be published), a
 * committed `publish_schedule` release serves the confirmed-and-visible
 * program on `/s/schedule` and `/s/speakers`, the embed document renders the
 * same published surface, the hosted pages stay off the search index, and
 * every HTML document from this unwired-framing server carries the fail-closed
 * deny pair.
 *
 * One shared ephemeral backend serves every project: the release chain grows
 * across projects, so the pre-publish gate is asserted only while the world
 * is genuinely unpublished, and each publish pins the then-current release
 * number. Vocabulary minted here is retired at the end (the reviewers smoke
 * later in this project proves coverage over the active vocabulary
 * population).
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
	await page.goto('/app/settings');
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
	await page.getByRole('button', { name: 'Open form', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Close form', exact: true })).toBeVisible();
}

async function addSubmission(page: Page, input: {
	readonly name: string;
	readonly email: string;
	readonly title: string;
	readonly trackName: string;
	readonly formatName: string;
}): Promise<void> {
	await page.goto('/app/submissions');
	await expect(page.getByRole('navigation', { name: 'Submission trays' })).toBeVisible();
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

async function acceptSubmission(page: Page, title: string): Promise<void> {
	await page.goto('/app/decisions');
	const verdicts = page.getByRole('group', { name: `Set decision for “${title}”` });
	await expect(verdicts).toBeVisible({ timeout: 15000 });
	await verdicts.getByRole('button', { name: 'Accept', exact: true }).click();
	const decidedRow = page.getByRole('row', {
		name: new RegExp(title.replace(/[()]/g, '\\$&'))
	});
	await expect(decidedRow.getByText('Accepted', { exact: true })).toBeVisible();
}

/**
 * Places the programmed session on the grid through the live placement loop.
 * The schedule presentation renders placed sessions; an unplaced released
 * session is honestly absent from it, so the smoke publishes a placed one.
 */
async function placeSession(page: Page, title: string): Promise<void> {
	await page.goto('/app/schedule');
	const dayGroup = page.getByRole('group', { name: 'Schedule day' });
	const blank = page.getByRole('heading', { level: 2, name: 'Nothing is scheduled yet' });
	await expect(blank.or(dayGroup).first()).toBeVisible();
	if (await blank.isVisible()) {
		await page.getByLabel('Room name').fill('Release Hall');
		await page.getByLabel('Seats').fill('100');
		await page.getByRole('button', { name: 'Add room' }).click();
	}
	await expect(dayGroup).toBeVisible();
	const pool = page.getByRole('region', { name: 'Program' });
	await expect(pool.getByText(title, { exact: true })).toBeVisible({ timeout: 15000 });
	await pool.getByRole('button', { name: `Place “${title}”` }).click();
	await page.getByRole('button', { name: /^Opening / }).first().click();
	const confirm = page.getByRole('dialog', { name: 'Place session' });
	await expect(confirm).toBeVisible();
	await confirm.getByRole('button', { name: /^Place session/ }).click();
	await expect(confirm).not.toBeVisible();
	await expect(
		page.locator('section[aria-label="Schedule grid"]').getByText(title, { exact: true })
	).toBeVisible({ timeout: 15000 });
}

/** The invited engagement becomes confirmed-and-visible through the operator roster. */
async function recordConfirmation(page: Page, speakerName: string): Promise<void> {
	await page.goto('/app/speakers');
	const record = page
		.getByRole('row', { name: new RegExp(speakerName) })
		.or(page.getByRole('listitem').filter({ hasText: speakerName }));
	await expect(record).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: `Details for ${speakerName}` }).click();
	await page.getByRole('button', { name: 'Record confirmation' }).click();
	await expect(record).toContainText('Confirmed', { timeout: 15000 });
}

function apiHeaders(baseURL: string, idempotencyKey: string): Record<string, string> {
	return {
		origin: baseURL,
		'x-correlation-id': crypto.randomUUID(),
		'idempotency-key': idempotencyKey
	};
}

/** The current published release number, or null for the typed not-published absence. */
async function currentReleaseNumber(request: APIRequestContext): Promise<number | null> {
	const response = await request.get('/api/public/schedule/current');
	expect(response.status()).toBe(200);
	const body = await response.json() as {
		kind: string;
		data?: { releaseNumber: number };
		outcome?: { class: string; kind: string };
	};
	if (body.kind === 'success') return body.data?.releaseNumber ?? null;
	expect(body.kind).toBe('outcome');
	expect(body.outcome).toMatchObject({ class: 'conflict', kind: 'release.not_published' });
	return null;
}

/** Drafts, proposes, and commits one `publish_schedule` release through the real loop. */
async function publishSchedule(
	request: APIRequestContext,
	baseURL: string,
	expectedCurrentReleaseNumber: number | null
): Promise<void> {
	const key = `publication-smoke-${crypto.randomUUID()}`;
	const draftResponse = await request.post('/api/events/current/releases/drafts', {
		headers: apiHeaders(baseURL, `${key}-draft`),
		data: { action: 'publish_schedule', expectedCurrentReleaseNumber }
	});
	expect(draftResponse.status()).toBe(200);
	const draft = await draftResponse.json() as {
		kind: string;
		data?: {
			changesetId: string;
			revision: { id: string; digestSha256: string };
			safeDiff: { action: string };
		};
	};
	expect(draft.kind).toBe('success');
	if (draft.kind !== 'success' || !draft.data) throw new Error('Publish draft failed.');
	expect(draft.data.safeDiff.action).toBe('publish_schedule');
	const selector = {
		changesetId: draft.data.changesetId,
		revisionId: draft.data.revision.id,
		revisionDigest: draft.data.revision.digestSha256
	};
	const proposed = await request.post('/api/changesets/proposals', {
		headers: apiHeaders(baseURL, `${key}-propose`),
		data: { ...selector, expectedHeadVersion: 1 }
	});
	expect(proposed.status()).toBe(200);
	expect(await proposed.json()).toMatchObject({ kind: 'success', data: { action: 'propose' } });
	const committed = await request.post('/api/changesets/commits', {
		headers: apiHeaders(baseURL, `${key}-commit`),
		data: { ...selector, expectedHeadVersion: 2 }
	});
	expect(committed.status()).toBe(200);
	expect(await committed.json()).toMatchObject({ kind: 'success', data: { action: 'commit' } });
}

async function expectNoindex(page: Page): Promise<void> {
	await expect(
		page.locator('meta[name="robots"][content="noindex, nofollow"]').first()
	).toHaveCount(1);
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
	await page.goto('/app/settings');
	const basics = page.getByRole('region', { name: 'Program basics' });
	await expect(basics).toBeVisible();
	for (const name of [
		`Release track ${testInfo.project.name}`,
		`Release format ${testInfo.project.name}`
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

test('the hosted schedule serves the honest gate before publish, then the released program', async ({
	page,
	baseURL
}, testInfo) => {
	if (!baseURL) throw new TypeError('Joined live browser base URL is required.');
	const project = testInfo.project.name;
	const title = `Released keynote (${project})`;
	const speaker = `Release Speaker ${project}`;
	const email = `release.${project}@joined.example`;

	await ensureEvent(page);
	await ensureVocabulary(page, `Release track ${project}`, `Release format ${project}`);
	await ensureOpenForm(page, `Release CFP ${project}`, `Release format ${project}`);
	await addSubmission(page, {
		name: speaker,
		email,
		title,
		trackName: `Release track ${project}`,
		formatName: `Release format ${project}`
	});
	await acceptSubmission(page, title);
	await recordConfirmation(page, speaker);
	await placeSession(page, title);

	// The shared release chain may already exist from an earlier project's
	// pass; the honest gate is asserted only while the world is genuinely
	// unpublished, and the publish pins whatever number is current.
	const before = await currentReleaseNumber(page.request);
	if (before === null) {
		await page.goto('/s/schedule');
		await expect(page.getByText(/isn’t published yet/).first()).toBeVisible();
		await expect(page.getByText(title)).toHaveCount(0);
		await expectNoindex(page);
	}

	await publishSchedule(page.request, baseURL, before);

	// The hosted schedule serves the released program: the confirmed-and-
	// visible speaker's name, the released title, and no search indexing.
	await page.goto('/s/schedule');
	await expect(page.getByText(title).first()).toBeVisible({ timeout: 15000 });
	await expect(page.getByText(speaker).first()).toBeVisible();
	await expectNoindex(page);
	await expectNoDocumentOverflow(page);

	// The speakers page is the union of visible released appearances.
	await page.goto('/s/speakers');
	await expect(page.getByText(speaker).first()).toBeVisible({ timeout: 15000 });
	await expectNoindex(page);
	await expectNoDocumentOverflow(page);
});

test('the embed document renders the same published surface, content-sized', async ({
	page
}, testInfo) => {
	const project = testInfo.project.name;
	const title = `Released keynote (${project})`;

	await page.goto('/embed/schedule');
	await expect(page.getByText(title).first()).toBeVisible({ timeout: 15000 });
	await expectNoindex(page);
	await expectNoDocumentOverflow(page);

	// An embed address that names no surface is honest about it.
	await page.goto('/embed/unknown');
	await expect(page.getByText('This embed doesn’t exist.')).toBeVisible();
});

test('every HTML document from this unwired-framing server fails closed against framing', async ({
	page
}) => {
	// The joined browser server composes no embed-framing source, so the
	// production handler's fail-closed default governs every HTML response —
	// the operator app, the hosted pages, and the embed documents alike.
	for (const path of ['/app/schedule', '/s/schedule', '/embed/schedule']) {
		const response = await page.request.get(path, { headers: { accept: 'text/html' } });
		expect(response.status()).toBe(200);
		const headers = response.headers();
		expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
		expect(headers['x-frame-options']).toBe('DENY');
	}
	// The loader itself is an asset, not a framed document: no framing policy.
	const loader = await page.request.get('/embed/v1/joo-embed.js');
	expect(loader.status()).toBe(200);
	expect(loader.headers()['content-type']).toContain('javascript');
});
