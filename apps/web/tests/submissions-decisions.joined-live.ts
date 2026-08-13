import { expect, test, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the Wave-2 decision spine as the browser sees it:
 * the tuned Submissions surface committing a real organizer direct entry
 * through `submission.direct_entry.create.draft` + the changeset lifecycle
 * (and refetching, never optimistically echoing), then the tuned Decisions
 * surface carrying the same row through the full visible loop — undecided,
 * accept-with-spawn committed through `decision.decide.draft`, and the
 * spawned session appearing in the schedule's program pool.
 *
 * One shared ephemeral backend serves every project, so names carry the
 * project name and the vocabulary minted here is retired at the end (the
 * reviewers smoke in the next project needs no active coverage targets).
 * The open CFP form each project creates remains — an open form is ordinary
 * workspace state every later test tolerates.
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

/**
 * Mints this project's track and format through the live Settings vocabulary
 * surface, so the form target and the entry's selects have real entries.
 */
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

/**
 * Opens a call for proposals when this project has not opened its own yet:
 * the standard application created through the live Forms surface, targeted
 * at this project's format pool (the category pin is what the Decision
 * spine's candidate source lifts for spawn), and opened (publish + open)
 * through the same changeset lifecycle.
 */
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
	// Creation lands on the questions page; opening publishes the definition.
	await page.getByRole('button', { name: 'Open form', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Close form', exact: true })).toBeVisible();
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

// Runs even when a test above failed: the reviewers smoke in the next project
// needs no active coverage targets, so the vocabulary this spec minted must
// never outlive it as an active entry. The base URL is rebuilt exactly the
// way the joined config builds it — `project.use` does not carry the
// config-root `use.baseURL`.
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
	await page.goto('/app/settings');
	const basics = page.getByRole('region', { name: 'Program basics' });
	await expect(basics).toBeVisible();
	for (const name of [
		`Joined track ${testInfo.project.name}`,
		`Joined entry format ${testInfo.project.name}`
	]) {
		// Wait out the list's own loading before deciding the entry is absent
		// (a failed run may genuinely never have minted it).
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

test('the direct-entry dialog commits a real submission and the list refetches it', async ({
	page
}, testInfo) => {
	const project = testInfo.project.name;
	const entryTitle = `Joined direct entry (${project})`;
	const trackName = `Joined track ${project}`;
	const entryFormat = `Joined entry format ${project}`;

	await ensureEvent(page);
	await ensureVocabulary(page, trackName, entryFormat);
	await ensureOpenForm(page, `Joined CFP ${project}`, entryFormat);

	await page.goto('/app/submissions');
	await expect(page.getByRole('navigation', { name: 'Submission trays' })).toBeVisible();
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Add submission' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Add a submission' });
	await dialog.getByLabel('Name').fill(`Speaker ${project}`);
	await dialog.getByLabel('Email').fill(`speaker.${project}@joined.example`);
	// Required fields carry a visual asterisk in their label text; the
	// accessible name stays the plain word, so the textbox role is the lookup.
	await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(entryTitle);

	// This project's own minted vocabulary is the selected track and format.
	await dialog.getByRole('combobox', { name: 'Track' }).selectOption({ label: trackName });
	await dialog.getByRole('combobox', { name: 'Format' }).selectOption({ label: entryFormat });

	// A typed refusal names its remedy instead of a generic retry line: the
	// accepted-at-creation disposition has no live owner yet, and the modal
	// surfaces the port's own copy rather than flattening it onto "Try again".
	// (The radio input itself is the visually hidden 1px control, so the press
	// lands on its visible label copy — the same target a person touches.)
	await dialog.getByText('Accepted right away', { exact: true }).click();
	await expect(dialog.getByRole('radio', { name: /Accepted right away/ })).toBeChecked();
	await dialog.getByRole('button', { name: 'Add accepted talk' }).click();
	await expect(dialog.getByText(
		'Accepting at creation is not available in this live workspace yet. Add it to the inbox, then accept it on Decisions.'
	)).toBeVisible();

	// The offered exit works in the same dialog: back to the inbox disposition.
	await dialog.getByText('Review inbox', { exact: true }).click();
	await dialog.getByRole('button', { name: 'Add to inbox' }).click();
	await expect(dialog).not.toBeVisible();

	// The row on screen is the canonical refetch, provenance and all — never
	// an optimistic echo of the dialog's own input. The provenance phrase is
	// matched exactly so the title (which contains the words) cannot satisfy it.
	const row = page.getByRole('row', { name: new RegExp(entryTitle.replace(/[()]/g, '\\$&')) });
	await expect(row.getByText(entryTitle, { exact: true })).toBeVisible();
	await expect(row.getByText('direct entry', { exact: true })).toBeVisible();
	await expect(row.getByText('Not decided')).toBeVisible();

	// Reload: the submission is canonical state, not page memory.
	await page.reload();
	await expect(page.getByText(entryTitle).first()).toBeVisible();
});

test('decisions carries the entry through accept-with-spawn into the program pool', async ({
	page
}, testInfo) => {
	const entryTitle = `Joined direct entry (${testInfo.project.name})`;

	await page.goto('/app/decisions');
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	// The direct entry sits undecided in the pass.
	await expect(page.getByText('Still to decide', { exact: true })).toBeVisible();
	const verdicts = page.getByRole('group', { name: `Set decision for “${entryTitle}”` });
	await expect(verdicts).toBeVisible();

	// Accept: a consequential decide committed through the changeset
	// lifecycle; a general-pool entry spawns its session in the same commit.
	await verdicts.getByRole('button', { name: 'Accept', exact: true }).click();
	await expect(page.getByText('Decided', { exact: true })).toBeVisible();
	const decidedRow = page.getByRole('row', {
		name: new RegExp(entryTitle.replace(/[()]/g, '\\$&'))
	});
	await expect(decidedRow.getByText('Accepted', { exact: true })).toBeVisible();

	// The notify door opens onto the typed refusal, never onto a dialog that
	// pretends the projection may still arrive: the recorded copy renders in
	// place of the loading shell, Send stays disabled, nothing is faked as
	// sent. (The door is the pass banner or, once every candidate is decided,
	// the finale's send button — both open the same dialog.)
	await page.getByRole('button', { name: /Compose notifications|decision notice/ }).first().click();
	const notify = page.getByRole('dialog', { name: 'Compose decision notifications' });
	await expect(notify).toBeVisible();
	await expect(notify.getByText(
		'Decision notifications are not available in this live workspace yet. Decisions are recorded; nothing has been sent.'
	)).toBeVisible();
	await expect(notify.getByRole('button', { name: /^Send/ })).toBeDisabled();
	await notify.getByRole('button', { name: 'Cancel' }).click();
	await expect(notify).not.toBeVisible();

	// The spawned session is canonical program state: it appears in the
	// schedule pool under the submission's own title, session identity served
	// by the catalog. (The vocabulary minted by this spec is retired in the
	// afterAll hook, failure or not.)
	await page.goto('/app/schedule');
	await expect(
		page.getByRole('region', { name: 'Program' }).getByText(entryTitle, { exact: true })
	).toBeVisible();
});
