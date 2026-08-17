import { expect, test, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the Wave-2 decision spine as the browser sees it:
 * the tuned Submissions surface committing a real organizer direct entry
 * through `submission.direct_entry.create@1`
 * (and refetching, never optimistically echoing), then the tuned Decisions
 * surface carrying the same row through the full visible loop — undecided,
 * accept-with-spawn committed through `decision.decide@1`, and the
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

/**
 * Opens a call for proposals when this project has not opened its own yet:
 * the standard application created through the live Forms surface, targeted
 * at this project's format pool (the category pin is what the Decision
 * spine's candidate source lifts for spawn), and opened (publish + open)
 * through the same registered operation boundary.
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
	// Creation lands on the questions page; owner review publishes and opens it.
	await page.getByRole('button', { name: 'Publish and open', exact: true }).click();
	await page.getByRole('dialog', { name: 'Review publication' })
		.getByRole('button', { name: 'Publish and open', exact: true }).click();
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
	await page.goto('/app/settings/program');
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
	await expect(page.getByRole('radiogroup', { name: 'Submission trays' })).toBeVisible();
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
	await expect(row.getByText(/·\s*direct entry/)).toBeVisible();
	// The station band owns the shared actionable state; the row keeps the
	// quiet non-duplicated fact in its Decision cell.
	await expect(page.getByRole('row', { name: /Decision needed/ })).toBeVisible();
	await expect(row.getByText('No decision yet', { exact: true })).toBeVisible();

	// Reload: the submission is canonical state, not page memory.
	await page.reload();
	await expect(page.getByText(entryTitle).first()).toBeVisible();
});

test('decisions carries the entry through accept-with-spawn into the program pool', async ({
	page
}, testInfo) => {
	const entryTitle = `Joined direct entry (${testInfo.project.name})`;
	const trackName = `Joined track ${testInfo.project.name}`;

	await page.goto('/app/decisions');
	await expect(page.locator('[data-je-scenario]')).toHaveCount(0);

	// The direct entry sits undecided in the pass.
	await expect(page.getByText('Still to decide', { exact: true })).toBeVisible();
	const verdicts = page.getByRole('group', { name: `Set decision for “${entryTitle}”` });
	await expect(verdicts).toBeVisible();

	// Accept: a consequential decide committed through the direct operation
	// boundary; a general-pool entry spawns its session in the same commit.
	await verdicts.getByRole('button', { name: 'Accept', exact: true }).click();
	const confirmation = page.getByRole('dialog', { name: 'Accept 1 submission?' });
	if (await confirmation.count()) {
		await confirmation.getByRole('combobox', { name: entryTitle }).selectOption({ label: trackName });
		await confirmation.getByRole('button', { name: 'Accept 1', exact: true }).click();
	}
	await expect(page.getByText('Decided', { exact: true })).toBeVisible({ timeout: 15_000 });
	const decidedRow = page.getByRole('row', {
		name: new RegExp(entryTitle.replace(/[()]/g, '\\$&'))
	});
	await expect(decidedRow.getByText('Accepted', { exact: true })).toBeVisible({ timeout: 15_000 });

	// The notify door opens onto the real deliberate-send review: the seeded
	// acceptance template over the minted decision-set audience, this entry's
	// submitter resolved as a recipient (masked address — contact disclosure
	// is its own permission-gated read), and the honest sender line stating
	// that no outbound provider is activated. (The door is the pass banner or,
	// once every candidate is decided, the finale's send button — both open
	// the same dialog.)
	await page.getByRole('button', { name: 'Send their results' }).first().click();
	const notify = page.getByRole('dialog', { name: 'Compose decision notifications' });
	await expect(notify).toBeVisible();
	await expect(
		notify.getByText(`Speaker ${testInfo.project.name}`, { exact: true }).first()
	).toBeVisible();
	await expect(notify.getByText(
		'No outbound provider activated — deliveries will be recorded, not delivered'
	)).toBeVisible();

	// Send commits the adopted preview as an irreversible release batch
	// through `send_messages`; the dialog then states what that commit did,
	// read back from the delivery ledger — the release committed and nothing
	// delivered, never "N emails sent" over an inert provider.
	const send = notify.getByRole('button', { name: /^Send/ });
	await expect(send).toBeEnabled();
	await send.click();
	await expect(notify.getByText(/notifications? committed — nothing sent/)).toBeVisible();
	await expect(notify.getByText(
		/deliver(y|ies) recorded, none delivered: the outbound lane rejected them outright\./
	)).toBeVisible();
	await expect(notify.getByText(/Result not sent stays until an activated provider/)).toBeVisible();
	await expect(notify.getByText(/emails? sent/)).toHaveCount(0);
	await notify.getByRole('button', { name: 'Done' }).click();
	await expect(notify).not.toBeVisible();

	// The wire history carries the committed batch with the ledger truth: the
	// dispatch pass ran, only the deterministic fake is composed, and the
	// delivery is honestly, terminally not-delivered — zero accepted, delivery
	// evidence not supported, and the reason the deciding attempt recorded.
	const history = await page.request.get(
		'/api/events/current/communications/deliveries/history',
		{ headers: { 'x-correlation-id': crypto.randomUUID() } }
	);
	expect(history.status()).toBe(200);
	const historyBody = await history.json() as {
		kind: string;
		data: { rows: {
			state: string;
			stateReasonCode?: string;
			counts: { accepted: { value?: number }; delivered: { knowledge: string } };
		}[] };
	};
	expect(historyBody.kind).toBe('success');
	expect(historyBody.data.rows.length).toBeGreaterThan(0);
	for (const row of historyBody.data.rows) {
		expect(row.state).toBe('known_failed');
		expect(row.stateReasonCode).toBe('delivery.rejected_terminal');
		expect(row.counts.accepted.value).toBe(0);
		expect(row.counts.delivered.knowledge).toBe('not_supported');
	}

	// Result not sent stays honest: "notified" means
	// the decision was communicated, its evidence is provider-accepted
	// delivery, and with no provider activated no such evidence can exist —
	// after a full reload the send door still counts this decision (as the
	// pass banner or the finale's send button, whichever the pass renders).
	await page.reload();
	await expect(
		page.getByRole('button', { name: 'Send their results' }).first()
	).toBeVisible();

	// The spawned session is canonical program state: it appears in the
	// schedule pool under the submission's own title, session identity served
	// by the catalog. (The vocabulary minted by this spec is retired in the
	// afterAll hook, failure or not.)
	await page.goto('/app/schedule');
	await expect(
		page.getByRole('region', { name: 'Program' }).getByText(entryTitle, { exact: true })
	).toBeVisible();
});
