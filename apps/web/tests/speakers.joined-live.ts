import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the Wave-3 engagement vertical as the browser sees
 * it: accepting a submission on the tuned Decisions surface seeds that
 * speaker's `invited` engagement in the same commit, the live Speakers roster
 * serves it (name, disclosed address, session, state), `record_confirmation`
 * commits through `engagement.change@1` with
 * organizer attribution on the committed head, and a lineup mutation surfaces
 * its typed BLOCKED-13 refusal instead of pretending a lineup owner exists.
 *
 * One shared ephemeral backend serves every project, so names carry the
 * project name and the vocabulary minted here is retired at the end. Rows
 * seeded by other projects stay on the roster; every assertion is scoped to
 * this project's own row.
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
	await page.getByRole('button', { name: 'Open form', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Close form', exact: true })).toBeVisible();
}

/**
 * This project's roster record, whichever composition is laid out: the table
 * row at desktop widths, the card (a list item) on touch. The composition
 * that is not rendered is display:none and outside the accessibility tree,
 * so exactly one of the two locators resolves.
 */
function rosterRecord(page: Page, speakerName: string): Locator {
	return page
		.getByRole('row', { name: new RegExp(speakerName) })
		.or(page.getByRole('listitem').filter({ hasText: speakerName }));
}

test.describe.configure({ mode: 'serial' });

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

// Runs even when a test above failed: the vocabulary this spec minted must
// never outlive it as an active entry (the reviewers smoke in the next
// project needs no active coverage targets).
test.afterAll(async ({ browser }, testInfo) => {
	const baseURL = `http://127.0.0.1:${process.env.JOOEVENTS_BROWSER_TEST_PORT ?? '4184'}`;
	const origin = new URL(baseURL);
	const context = await browser.newContext({ baseURL });
	await context.addCookies([{
		name: 'better-auth.session_token',
		value: await signedSessionValue(),
		domain: origin.hostname,
		path: '/',
		httpOnly: true,
		secure: false,
		sameSite: 'Lax'
	}]);
	const page = await context.newPage();
	await page.goto('/app/settings/program');
	const basics = page.getByRole('region', { name: 'Program basics' });
	await expect(basics).toBeVisible();
	for (const name of [
		`Speakers track ${testInfo.project.name}`,
		`Speakers entry format ${testInfo.project.name}`
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

test('an accepted submission appears on the live roster as an invited engagement', async ({
	page
}, testInfo) => {
	const project = testInfo.project.name;
	const entryTitle = `Speakers roster entry (${project})`;
	const speakerName = `Roster Speaker ${project}`;
	const speakerEmail = `roster.${project}@joined.example`;

	await ensureEvent(page);
	await ensureVocabulary(page, `Speakers track ${project}`, `Speakers entry format ${project}`);
	await ensureOpenForm(page, `Speakers CFP ${project}`, `Speakers entry format ${project}`);

	// A real direct entry through the live dialog, into the review inbox.
	await page.goto('/app/submissions');
	await expect(page.getByRole('radiogroup', { name: 'Submission trays' })).toBeVisible();
	await page.getByRole('button', { name: 'Add submission' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Add a submission' });
	await dialog.getByLabel('Name').fill(speakerName);
	await dialog.getByLabel('Email').fill(speakerEmail);
	await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(entryTitle);
	await dialog.getByRole('combobox', { name: 'Track' }).selectOption({ label: `Speakers track ${project}` });
	await dialog.getByRole('combobox', { name: 'Format' }).selectOption({ label: `Speakers entry format ${project}` });
	await dialog.getByText('Review inbox', { exact: true }).click();
	await dialog.getByRole('button', { name: 'Add to inbox' }).click();
	await expect(dialog).not.toBeVisible();

	// Accept on Decisions: the same commit graduates the session and seeds the
	// speaker's invited engagement (nothing is notified by it).
	await page.goto('/app/decisions');
	const verdicts = page.getByRole('group', { name: `Set decision for “${entryTitle}”` });
	await expect(verdicts).toBeVisible({ timeout: 15000 });
	await verdicts.getByRole('button', { name: 'Accept', exact: true }).click();
	const decidedRow = page.getByRole('row', {
		name: new RegExp(entryTitle.replace(/[()]/g, '\\$&'))
	});
	await expect(decidedRow.getByText('Accepted', { exact: true })).toBeVisible();

	// The roster serves the engagement the accept seeded — canonical state,
	// no sample fallback, joined with session identity and the disclosed
	// address of the submission's contact.
	await page.goto('/app/speakers');
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);
	const record = rosterRecord(page, speakerName);
	await expect(record).toBeVisible({ timeout: 15000 });
	await expect(record).toContainText('Invited');
	await expect(record).toContainText(speakerEmail);
	await expect(record).toContainText(entryTitle);

	// The invited row owes the organizer a next step: the details panel offers
	// exactly the organizer-recorded confirmation act. (The roster renders a
	// table and a card composition; only the laid-out one is visible.)
	await page.getByRole('button', { name: `Details for ${speakerName}` }).click();
	await expect(
		page.getByText(/Speakers confirm from their own portal link/).filter({ visible: true })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Record confirmation' })).toBeVisible();

	// The live roster must hold its composition at every project width —
	// desktop, compact desktop, and touch — without document overflow.
	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
});

test('record confirmation commits with organizer attribution and survives reload', async ({
	page
}, testInfo) => {
	const speakerName = `Roster Speaker ${testInfo.project.name}`;

	// Pin the committed attribution through the served snapshot: whatever this
	// press confirms must be the one newly confirmed engagement, attributed to
	// the recording organizer, never to the speaker.
	const before = await page.request.get('/api/events/current/engagements');
	expect(before.ok()).toBe(true);
	const beforeBody = await before.json() as {
		data: { engagements: readonly { id: string; state: string }[] };
	};
	const confirmedBefore = new Set(
		beforeBody.data.engagements
			.filter((engagement) => engagement.state === 'confirmed')
			.map((engagement) => engagement.id)
	);

	await page.goto('/app/speakers');
	const record = rosterRecord(page, speakerName);
	await expect(record).toBeVisible({ timeout: 15000 });
	await page.getByRole('button', { name: `Details for ${speakerName}` }).click();
	await page.getByRole('button', { name: 'Record confirmation' }).click();

	// The roster repaints from a canonical refetch, and the reload proves the
	// commit was server state, not page memory.
	await expect(record).toContainText('Confirmed', { timeout: 15000 });
	await page.reload();
	await expect(rosterRecord(page, speakerName)).toContainText('Confirmed', { timeout: 15000 });

	const after = await page.request.get('/api/events/current/engagements');
	expect(after.ok()).toBe(true);
	const afterBody = await after.json() as {
		data: {
			engagements: readonly {
				id: string;
				state: string;
				confirmation: {
					attribution: string;
					recordedByUserId: string | null;
				} | null;
			}[];
		};
	};
	const newlyConfirmed = afterBody.data.engagements.filter(
		(engagement) => engagement.state === 'confirmed' && !confirmedBefore.has(engagement.id)
	);
	expect(newlyConfirmed).toHaveLength(1);
	expect(newlyConfirmed[0]?.confirmation?.attribution).toBe('organizer_recorded');
	expect(newlyConfirmed[0]?.confirmation?.recordedByUserId).not.toBeNull();
});

test('a lineup mutation surfaces its typed refusal', async ({ page }, testInfo) => {
	const speakerName = `Roster Speaker ${testInfo.project.name}`;

	await page.goto('/app/speakers?view=lineup');
	// The confirmed speaker's roster reference is publicly visible, so the row
	// sits on the lineup; taking it off has no live owner and must refuse with
	// the recorded copy — never silently no-op.
	const lineupRow = page
		.getByRole('region', { name: 'On the lineup' })
		.getByRole('listitem')
		.filter({ hasText: speakerName });
	await expect(lineupRow).toBeVisible({ timeout: 15000 });
	await lineupRow.getByRole('button', { name: 'Take off' }).click();
	await expect(page.getByRole('alert')).toContainText(
		'Changing who appears on the public lineup is not available in this live workspace yet.'
	);
	// The row stays exactly where it was: the refusal changed nothing.
	await expect(lineupRow).toBeVisible();
});
