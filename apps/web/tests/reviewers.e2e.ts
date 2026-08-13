import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The Reviewers surface: the roster with typed scope chips (generalist =
 * absence of scope, rendered as words), the multi-address invite with per-line
 * outcomes, the scope editor's consequential write with receipt + undo, the
 * coverage panel's count-as-door onto the page's own `?scope=` filter, the Q30
 * "need another reviewer" badge rendered only while uncovered, the `?reviewer=`
 * arrival, and the schedule pool's programmed-only contract.
 *
 * The flight dataset carries six reviewers: two generalists (Sofia, Marc),
 * three scoped actives (Jonas → infra track, Tomás → infra track + collecting
 * panel, Elif → workshop format), and one invited with an initial scope
 * (Priya → Evals & Reliability). Jonas holds 1 uncovered review, Elif holds 2.
 */

/** The roster renders twice — a table and, below a breakpoint, cards; the
 * visible one is the subject everywhere. */
const rosterOf = (page: Page) =>
	page.locator('.roster__table, .roster__cards').filter({ visible: true });

/** Resolved rows only: skeleton fills are aria-hidden, the expanded detail tr
 * is presentation of one row rather than a row of its own. */
const rowsOf = (page: Page) =>
	rosterOf(page).locator(
		'tbody tr:not(.detail-row):not([aria-hidden="true"]), li.card:not([aria-hidden="true"])'
	);

/** One reviewer's scope cell in whichever composition is laid out. */
const scopeCellOf = (row: Locator) => row.locator('td:nth-child(3), .card__scope');

/** The generalist words per composition: the table's "Reviews" column header
 * starts the sentence its cells complete with "Everything"; a card has no
 * header, so it carries the whole "Reviews everything". */
const everything = (project: string) =>
	project === 'mobile' ? 'Reviews everything' : 'Everything';

async function openRoster(page: Page, path = '/app/reviewers') {
	await page.goto(path);
	await expect(rowsOf(page).first()).toBeVisible({ timeout: 15000 });
}

// The roster under test is the flight dataset's six-reviewer cast described
// above; the tests that need a different scenario re-pin their own cookie.
test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: 'je-scenario', value: 'flight', url: baseURL ?? 'http://127.0.0.1:4173' }
	]);
});

test('the roster renders scope as typed chips, and a generalist in plain words', async ({
	page
}, testInfo) => {
	await openRoster(page);
	await expect(page.getByRole('heading', { level: 1, name: 'Reviewers' })).toBeVisible();
	const rows = rowsOf(page);
	await expect(rows).toHaveCount(6);

	// A generalist is the absence of scope: words, never an invented chip.
	const sofia = rows.filter({ hasText: 'Sofia Berg' });
	await expect(scopeCellOf(sofia)).toHaveText(everything(testInfo.project.name));
	await expect(scopeCellOf(sofia).locator('.ui-badge')).toHaveCount(0);
	await expect(scopeCellOf(rows.filter({ hasText: 'Marc Dubois' }))).toHaveText(
		everything(testInfo.project.name)
	);

	// Typed refs render in the referenced entity's own voice: a track chip
	// carries the track's accent…
	const priya = rows.filter({ hasText: 'Priya Nair' });
	await expect(scopeCellOf(priya).locator('.ui-badge--lavender')).toContainText(
		'Evals & Reliability'
	);
	await expect(priya.locator('.ui-badge--info').filter({ hasText: 'Invited' })).toBeVisible();

	// …a format chip stays neutral, and a session chip names its lifecycle.
	await expect(scopeCellOf(rows.filter({ hasText: 'Elif Aydın' }))).toContainText(
		'Workshop'
	);
	const tomas = rows.filter({ hasText: 'Tomás Rivera' });
	await expect(scopeCellOf(tomas)).toContainText('Models & Infrastructure');
	await expect(scopeCellOf(tomas)).toContainText('Panel: Durable Agent Infrastructure');
	await expect(scopeCellOf(tomas).locator('.ui-badge--info')).toHaveText('Collecting');

	// The filter chips promise the populations they open.
	await expect(page.locator('.chips__tab').filter({ hasText: 'All' })).toContainText('6');
	await expect(page.locator('.chips__tab').filter({ hasText: 'Invited' })).toContainText('1');

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('inviting two addresses reports each line, leaves an honest receipt, and grows the roster', async ({
	page
}, testInfo) => {
	await openRoster(page);
	await expect(rowsOf(page)).toHaveCount(6);

	await page.getByRole('button', { name: 'Invite reviewers' }).click();
	const dialog = page.getByRole('dialog', { name: 'Invite reviewers' });
	await expect(dialog).toBeVisible();
	// The copy never claims an email went out: recorded is not sent.
	await expect(dialog).toContainText('recording the invitation does not email anyone');
	// The role is fixed, shown with its plain description rather than a picker.
	await expect(dialog).toContainText('Speaker Reviewer');

	await dialog
		.getByRole('textbox', { name: 'Email addresses' })
		.fill('maria.keller@example.org, noah.brand@example.org');
	await dialog.getByRole('button', { name: 'Record invitations' }).click();

	// Per-line outcomes lead the dialog after the press.
	await expect(dialog.getByText('2 recorded.')).toBeVisible({ timeout: 10000 });
	const lines = dialog.locator('.line');
	await expect(lines).toHaveCount(2);
	await expect(lines.filter({ hasText: 'maria.keller@example.org' }).locator('.ui-badge')).toHaveText('Recorded');
	await expect(lines.filter({ hasText: 'noah.brand@example.org' }).locator('.ui-badge')).toHaveText('Recorded');

	// The receipt is not undoable and says what to do instead.
	const receipt = page.getByRole('status').filter({ hasText: 'Recorded 2 reviewer invitations' });
	await expect(receipt).toBeVisible();
	await expect(receipt).toContainText('Withdraw one by removing the reviewer from the roster.');
	await expect(receipt.getByRole('button', { name: 'Undo' })).toHaveCount(0);

	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(dialog).not.toBeVisible();

	// The roster grew by both: invited, and generalists until narrowed.
	const rows = rowsOf(page);
	await expect(rows).toHaveCount(8);
	const maria = rows.filter({ hasText: 'maria.keller@example.org' });
	await expect(maria.locator('.ui-badge--info').filter({ hasText: 'Invited' })).toBeVisible();
	await expect(scopeCellOf(maria)).toHaveText(everything(testInfo.project.name));
	await expect(page.locator('.chips__tab').filter({ hasText: 'All' })).toContainText('8');
});

test('scoping a generalist commits with a receipt whose undo restores the generalist words exactly', async ({
	page
}, testInfo) => {
	await openRoster(page);
	const sofia = rowsOf(page).filter({ hasText: 'Sofia Berg' });
	await expect(scopeCellOf(sofia)).toHaveText(everything(testInfo.project.name));

	await rosterOf(page).getByRole('button', { name: 'Details for Sofia Berg' }).click();
	const editor = rosterOf(page).locator('.detail');
	await expect(editor).toBeVisible();
	// The editor names the default in plain words before anything is selected.
	await expect(editor).toContainText('Reviews everything — every submission in each plan');

	const option = editor.getByRole('button', { name: 'Agents & Tools', exact: true });
	await expect(option).toHaveAttribute('aria-pressed', 'false');
	await option.click();
	await expect(option).toHaveAttribute('aria-pressed', 'true');
	await editor.getByRole('button', { name: 'Apply scope' }).click();

	// One consequential write, one receipt, compensating undo.
	const receipt = page
		.getByRole('status')
		.filter({ hasText: 'Scoped Sofia Berg to Agents & Tools' });
	await expect(receipt).toBeVisible({ timeout: 10000 });
	const cell = scopeCellOf(sofia);
	await expect(cell.locator('.ui-badge--sea')).toContainText('Agents & Tools', {
		timeout: 10000
	});

	await receipt.getByRole('button', { name: 'Undo' }).click();
	// Exactly the generalist words again — no chip left behind — and the open
	// editor's draft resyncs to the restored truth instead of claiming a
	// pending edit.
	await expect(cell).toHaveText(everything(testInfo.project.name), { timeout: 10000 });
	await expect(cell.locator('.ui-badge')).toHaveCount(0);
	await expect(editor.getByRole('button', { name: 'Agents & Tools', exact: true })).toHaveAttribute(
		'aria-pressed',
		'false'
	);
});

test('a coverage reviewers count doors into this page scoped, and dismissing clears the address', async ({
	page
}) => {
	await openRoster(page);

	const coverage = page.getByRole('region', { name: 'Review coverage' });
	await expect(coverage).toContainText('2 generalists review everything');

	// Jonas and Tomás hold the infrastructure track: its row's count is a door.
	await coverage
		.locator('.row')
		.filter({ hasText: 'Models & Infrastructure' })
		.getByRole('link', { name: '2 scoped reviewers' })
		.click();
	await expect(page).toHaveURL(/\/app\/reviewers\?scope=track(:|%3A)trk-infra$/);

	// The destination names the filter applied on the operator's behalf…
	await expect(page.getByText('Scoped to Models & Infrastructure')).toBeVisible();
	// …shows only the holders of that ref, and recounts on the scoped population.
	const rows = rowsOf(page);
	await expect(rows).toHaveCount(2);
	await expect(rows.filter({ hasText: 'Jonas Weber' })).toBeVisible();
	await expect(rows.filter({ hasText: 'Tomás Rivera' })).toBeVisible();
	await expect(page.locator('.chips__tab').filter({ hasText: 'All' })).toContainText('2');

	// One press gives the whole roster back and cleans the address.
	await page.getByRole('button', { name: /Clear this filter/ }).click();
	await expect(page).toHaveURL(/\/app\/reviewers$/);
	await expect(rows).toHaveCount(6);
	await expect(page.getByText('Scoped to Models & Infrastructure')).toHaveCount(0);
});

test('selecting a track marks its sessions included — reason reachable, never toggleable — and deselecting frees them', async ({
	page
}) => {
	await openRoster(page);
	await rosterOf(page).getByRole('button', { name: 'Details for Sofia Berg' }).click();
	const editor = rosterOf(page).locator('.detail');
	const sessionsGroup = editor.getByRole('group', { name: 'Sessions' });
	const panel = sessionsGroup.getByRole('button', {
		name: /Panel: Durable Agent Infrastructure/
	});

	// Sessions are categorized by their track before anything is selected.
	await expect(
		sessionsGroup.getByRole('group', { name: 'Models & Infrastructure sessions' })
	).toBeVisible();
	await expect(panel).toHaveAttribute('aria-pressed', 'false');

	// Selecting the track covers its sessions: checked as soft members of the
	// selection family — the included tint class — no longer individually
	// toggleable, each naming its cause inline so the state reads without a
	// press and never rides on color alone.
	await editor.getByRole('button', { name: 'Models & Infrastructure', exact: true }).click();
	await expect(panel).toHaveAttribute('aria-pressed', 'true');
	await expect(panel).toHaveAttribute('aria-disabled', 'true');
	await expect(panel).toContainText('via track');
	await expect(
		sessionsGroup
			.getByRole('group', { name: 'Models & Infrastructure sessions' })
			.locator('.option--included')
	).toHaveCount(3);

	// Three-way separability: plain, included, and explicitly selected chips
	// carry pairwise different computed backgrounds — included sits in the
	// selection family, equal to neither neighbour — while its title keeps the
	// full ink of a plain chip, not a disabled grey.
	const queues = sessionsGroup.getByRole('button', { name: /LLM Review Queues/ });
	await queues.click();
	await expect(queues).toHaveAttribute('aria-pressed', 'true');
	const lightning = sessionsGroup.getByRole('button', { name: /Lightning Talks: Eval Fails/ });
	const styleOf = (chip: Locator) =>
		chip.evaluate((el) => {
			const style = getComputedStyle(el);
			return { background: style.backgroundColor, ink: style.color };
		});
	const [plain, included, explicit] = await Promise.all([
		styleOf(lightning),
		styleOf(panel),
		styleOf(queues)
	]);
	expect(included.background).not.toBe(plain.background);
	expect(included.background).not.toBe(explicit.background);
	expect(explicit.background).not.toBe(plain.background);
	expect(included.ink).toBe(plain.ink);
	// The explicit pick was borrowed for the comparison; hand it back.
	await queues.click();
	await expect(queues).toHaveAttribute('aria-pressed', 'false');

	// Pressing an included session is the question "why is this checked?" —
	// answered in place, with nothing toggled. `force` because the control is
	// aria-disabled, which a person can still press — that is the point.
	await panel.click({ force: true });
	await expect(sessionsGroup.getByText('Included with Models & Infrastructure')).toBeVisible();
	await expect(panel).toHaveAttribute('aria-pressed', 'true');
	await expect(editor.getByRole('button', { name: 'Apply scope' })).toBeEnabled();

	// Deselecting the track returns its sessions to plain toggleable state…
	await editor.getByRole('button', { name: 'Models & Infrastructure', exact: true }).click();
	await expect(panel).toHaveAttribute('aria-pressed', 'false');
	await expect(panel).not.toHaveAttribute('aria-disabled', 'true');
	// …and the same press now toggles an explicit ref both ways.
	await panel.click();
	await expect(panel).toHaveAttribute('aria-pressed', 'true');
	await panel.click();
	await expect(panel).toHaveAttribute('aria-pressed', 'false');

	// A format ref implies the same way, in its own words.
	await editor.getByRole('button', { name: 'Workshop', exact: true }).click();
	const workshop = sessionsGroup.getByRole('button', { name: /AI Interface Audits That Stick/ });
	await expect(workshop).toHaveAttribute('aria-disabled', 'true');
	await expect(workshop).toContainText('via format');
	await workshop.click({ force: true });
	await expect(sessionsGroup.getByText('Included with Workshop')).toBeVisible();

	// When the session's track joins the selection, both now cover it: the
	// inline cause names the track — track wins — and the fuller reason line
	// names both.
	await editor.getByRole('button', { name: 'Agents & Tools', exact: true }).click();
	await expect(workshop).toContainText('via track');
	await expect(
		sessionsGroup.getByText('Included with Agents & Tools and Workshop')
	).toBeVisible();
});

test('an explicit session ref beside its covering track stays removable, noted that the track also covers it', async ({
	page
}) => {
	await openRoster(page);
	await rosterOf(page).getByRole('button', { name: 'Details for Tomás Rivera' }).click();
	const editor = rosterOf(page).locator('.detail');
	const panel = editor
		.getByRole('group', { name: 'Sessions' })
		.getByRole('button', { name: /Panel: Durable Agent Infrastructure/ });

	// Tomás holds the track and the session ref: the explicit ref renders as a
	// normal removable selection, with the quiet note about the union.
	await expect(panel).toHaveAttribute('aria-pressed', 'true');
	await expect(panel).not.toHaveAttribute('aria-disabled', 'true');
	await expect(panel).toContainText('also covered by Models & Infrastructure');

	// Removing the explicit ref leaves the session covered — now included
	// through the track: still checked, no longer toggleable, and the chip
	// itself names the cause.
	await panel.click();
	await expect(panel).toHaveAttribute('aria-pressed', 'true');
	await expect(panel).toHaveAttribute('aria-disabled', 'true');
	await expect(panel).toContainText('via track');
	await expect(editor.getByRole('button', { name: 'Apply scope' })).toBeEnabled();

	// Reset restores the committed union exactly.
	await editor.getByRole('button', { name: 'Reset' }).click();
	await expect(panel).not.toHaveAttribute('aria-disabled', 'true');
	await expect(panel).toContainText('also covered by Models & Infrastructure');
});

test('the sessions filter narrows the track groups; selection and included states survive; clearing restores', async ({
	page
}) => {
	await openRoster(page);
	await rosterOf(page).getByRole('button', { name: 'Details for Sofia Berg' }).click();
	const editor = rosterOf(page).locator('.detail');
	const sessionsGroup = editor.getByRole('group', { name: 'Sessions' });
	const filter = sessionsGroup.getByRole('searchbox', { name: 'Filter sessions by title' });

	// Build both states first: an included group and an explicit pick.
	await editor.getByRole('button', { name: 'Models & Infrastructure', exact: true }).click();
	const queues = sessionsGroup.getByRole('button', { name: /LLM Review Queues/ });
	await queues.click();
	await expect(queues).toHaveAttribute('aria-pressed', 'true');
	await expect(sessionsGroup.getByRole('button')).toHaveCount(12);

	await filter.fill('panel');
	// The line reports what matched, in which corpus, for the settled words.
	await expect(sessionsGroup.getByText('3 of 12 session titles match “panel”.')).toBeVisible();
	await expect(sessionsGroup.getByRole('button')).toHaveCount(3);
	// A track group with no matching titles leaves entirely.
	await expect(
		sessionsGroup.getByRole('group', { name: 'Evals & Reliability sessions' })
	).toHaveCount(0);
	// Included state survives the narrowing.
	const panel = sessionsGroup.getByRole('button', {
		name: /Panel: Durable Agent Infrastructure/
	});
	await expect(panel).toHaveAttribute('aria-pressed', 'true');
	await expect(panel).toHaveAttribute('aria-disabled', 'true');

	// Zero matches is an honest answer naming the query and the corpus.
	await filter.fill('zzz');
	await expect(sessionsGroup.getByText('No session titles match “zzz”.')).toBeVisible();
	await expect(sessionsGroup.getByRole('button')).toHaveCount(0);

	// Clearing restores every group, and the pick hidden by the filter — an
	// explicit ref outside the narrowed set — survived the whole trip.
	await filter.fill('');
	await expect(sessionsGroup.getByRole('button')).toHaveCount(12);
	await expect(queues).toHaveAttribute('aria-pressed', 'true');
	await expect(panel).toHaveAttribute('aria-disabled', 'true');

	// The open editor, at its fullest — every group, a selection, an included
	// set — never widens the document.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('the column header reads "Reviews", the editor asks "What they review", and removal demotes to the footer', async ({
	page
}, testInfo) => {
	await openRoster(page);
	if (testInfo.project.name === 'desktop') {
		await expect(page.locator('.roster__table thead th').nth(2)).toHaveText('Reviews');
	}
	await rosterOf(page).getByRole('button', { name: 'Details for Sofia Berg' }).click();
	const editor = rosterOf(page).locator('.detail');
	await expect(editor.getByRole('heading', { name: 'What they review' })).toBeVisible();
	// The explainer teaches the term scope inline instead of assuming it.
	await expect(editor).toContainText('the set becomes the reviewer’s scope');
	// The old section headings are gone with the composition they organized:
	// the editor leads, and removal is the quiet footer row — destructive
	// voice intact, same confirmation ceremony.
	await expect(editor.getByRole('heading', { name: 'Scope' })).toHaveCount(0);
	await expect(editor.getByRole('heading', { name: 'Roster' })).toHaveCount(0);
	await expect(
		editor.locator('.detail__footer').getByRole('button', { name: 'Remove from roster' })
	).toBeVisible();
});

test("a collecting session's coverage count carries implied coverage, and its door opens the same population", async ({
	page
}) => {
	await openRoster(page);
	const coverage = page.getByRole('region', { name: 'Review coverage' });
	const panelRow = coverage
		.locator('.row')
		.filter({ hasText: 'Panel: Durable Agent Infrastructure' });
	// Jonas covers through his track ref, Tomás through the track and the
	// session ref itself — one reviewer, counted once. The lightning slot's
	// only implying holder is still invited, so it stays honestly at zero.
	await expect(panelRow.getByRole('link', { name: '2 scoped reviewers' })).toBeVisible();
	await expect(
		coverage
			.locator('.row')
			.filter({ hasText: 'Lightning Talks: Eval Fails in Production' })
			.getByRole('link', { name: '0 scoped reviewers' })
	).toBeVisible();

	// The door and the list agree (the R1/Q23 contract): the session address
	// shows the reviewers whose scope implies coverage — exactly the two the
	// count claimed.
	await panelRow.getByRole('link', { name: '2 scoped reviewers' }).click();
	await expect(page).toHaveURL(/\/app\/reviewers\?scope=session(:|%3A)ses-11$/);
	await expect(page.getByText('Scoped to Panel: Durable Agent Infrastructure')).toBeVisible();
	const rows = rowsOf(page);
	await expect(rows).toHaveCount(2);
	await expect(rows.filter({ hasText: 'Jonas Weber' })).toBeVisible();
	await expect(rows.filter({ hasText: 'Tomás Rivera' })).toBeVisible();
	await expect(page.locator('.chips__tab').filter({ hasText: 'All' })).toContainText('2');

	// Dismissing gives the whole roster back.
	await page.getByRole('button', { name: /Clear this filter/ }).click();
	await expect(rows).toHaveCount(6);
});

test('exactly the rows holding uncovered reviews carry the "need another reviewer" badge', async ({
	page
}, testInfo) => {
	await openRoster(page);
	const rows = rowsOf(page);
	await expect(rows).toHaveCount(6);

	// Q30's grammar verbatim, only while uncovered: Jonas holds 1, Elif holds 2.
	const jonas = rows.filter({ hasText: 'Jonas Weber' });
	const elif = rows.filter({ hasText: 'Elif Aydın' });
	await expect(jonas).toContainText('1 need another reviewer');
	await expect(elif).toContainText('2 need another reviewer');
	await expect(
		rosterOf(page).locator('.ui-badge--warning').filter({ hasText: 'need another reviewer' })
	).toHaveCount(2);

	if (testInfo.project.name === 'desktop') {
		// The badge explains itself in conflict-of-interest words — never a term
		// of art like "recused" — and keeps the denominator promise out loud.
		const trigger = jonas.getByRole('button', { name: '1 need another reviewer — why' });
		await trigger.click();
		const panel = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('1 review nobody is covering');
		await expect(panel).toContainText('stepped back from 1 because of a conflict of interest');
		await expect(panel).toContainText('stay in their assigned count');
		await expect(panel).not.toContainText(/recused/i);
		await page.keyboard.press('Escape');
	}
});

test('the badge is absent from a scenario without coverage gaps', async ({
	page,
	context,
	baseURL
}) => {
	await context.addCookies([
		{ name: 'je-scenario', value: 'opening', url: baseURL ?? 'http://127.0.0.1:4173' }
	]);
	await openRoster(page);

	const rows = rowsOf(page);
	await expect(rows).toHaveCount(2);
	// No roster row carries the badge (the filter chip naming the view stays).
	await expect(rosterOf(page).getByText('need another reviewer')).toHaveCount(0);
	// Rendered only while uncovered: the view of that state counts zero here.
	await expect(
		page.locator('.chips__tab').filter({ hasText: 'Need another reviewer' }).locator('.chips__count')
	).toHaveText('0');
});

test('a scope ref to a retired format keeps rendering, flagged — in the chip, the editor, and coverage', async ({
	page,
	context,
	baseURL
}) => {
	// Quiet seeds Tomás with a union naming the retired lightning format.
	await context.addCookies([
		{ name: 'je-scenario', value: 'quiet', url: baseURL ?? 'http://127.0.0.1:4173' }
	]);
	await openRoster(page);

	const tomas = rowsOf(page).filter({ hasText: 'Tomás Rivera' });
	const chip = scopeCellOf(tomas).locator('.ui-badge').filter({ hasText: 'Lightning' });
	await expect(chip).toBeVisible();
	// The quiet flag: still rendering, no longer offered.
	await expect(chip).toContainText('retired');

	// The editor keeps the selected retired entry so it can be taken back out…
	await rosterOf(page).getByRole('button', { name: 'Details for Tomás Rivera' }).click();
	const editor = rosterOf(page).locator('.detail');
	const retiredOption = editor.getByRole('button', { name: /Lightning/ });
	await expect(retiredOption).toHaveAttribute('aria-pressed', 'true');
	await expect(retiredOption).toContainText('retired');

	// …and coverage keeps the row while the ref exists, flagged for re-scoping.
	const coverage = page.getByRole('region', { name: 'Review coverage' });
	const row = coverage.locator('.row').filter({ hasText: 'Lightning' });
	await expect(row).toContainText('retired — consider re-scoping');
	await expect(row.getByRole('link', { name: '1 scoped reviewer' })).toBeVisible();
});

test('a ?reviewer= deep link lands with that row open on its scope editor', async ({ page }) => {
	await page.goto('/app/reviewers?reviewer=mem-7');

	// The link's promise: Elif's row arrives open, not a list to search.
	const toggle = rosterOf(page).getByRole('button', { name: 'Details for Elif Aydın' });
	await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 15000 });
	const editor = rosterOf(page).locator('.detail');
	await expect(editor).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Apply scope' })).toBeVisible();
	// The draft mirrors her committed scope.
	await expect(
		editor.getByRole('button', { name: 'Workshop', exact: true })
	).toHaveAttribute('aria-pressed', 'true');
	await expect(page).toHaveURL(/reviewer=mem-7/);
});

/**
 * Who owns a press inside a reviewer row. The row — the table tr wide, the
 * card summary narrow — is the pointer's door to the scope editor, so the
 * dead space between the controls stops being a dead zone. The chevron stays
 * the one focusable `aria-expanded` switch, every control inside the row
 * keeps its own press, and a text selection is never answered with a toggle.
 */
test.describe('a reviewer row as a press target', () => {
	/** The name in whichever composition is laid out: ordinary text, not a
	 * control, so a press there falls through to the row. */
	const nameOf = (row: Locator) => row.locator('.who strong, .card__name');

	test('the row itself opens the scope editor, and the same press closes it', async ({ page }) => {
		await openRoster(page);
		const row = rowsOf(page).filter({ hasText: 'Sofia Berg' });
		const chevron = row.getByRole('button', { name: 'Details for Sofia Berg' });
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');

		await nameOf(row).click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'true');
		await expect(rosterOf(page).locator('.detail')).toBeVisible();

		// The same door swings both ways.
		await nameOf(row).click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
		await expect(rosterOf(page).locator('.detail')).toHaveCount(0);
	});

	test('the email copy control wins the press: it copies, and the row stays shut', async ({
		page
	}) => {
		await openRoster(page);
		const row = rowsOf(page).filter({ hasText: 'Sofia Berg' });
		const chevron = row.getByRole('button', { name: 'Details for Sofia Berg' });

		await row.getByRole('button', { name: 'Copy email address' }).click();
		// The control answered with its own confirmation…
		await expect(row.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
		// …and the row did not answer at all.
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
		await expect(rosterOf(page).locator('.detail')).toHaveCount(0);
	});

	test('plain text inside the open editor is not a door back shut', async ({ page }) => {
		await openRoster(page);
		const row = rowsOf(page).filter({ hasText: 'Sofia Berg' });
		const chevron = row.getByRole('button', { name: 'Details for Sofia Berg' });
		await nameOf(row).click();
		const editor = rosterOf(page).locator('.detail');
		await expect(editor).toBeVisible();

		// The editor is presentation of the open row, not a second press target.
		await editor.getByText(/every submission in each plan they join/).click();
		await expect(chevron).toHaveAttribute('aria-expanded', 'true');
		await expect(editor).toBeVisible();
	});

	test('drag-selecting the email leaves the row exactly as it was', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name === 'mobile', 'a mouse drag is a fine-pointer gesture');
		await openRoster(page);
		const row = rowsOf(page).filter({ hasText: 'Sofia Berg' });
		const chevron = row.getByRole('button', { name: 'Details for Sofia Berg' });
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');

		const email = row.locator('.ui-copy__value');
		const box = await email.boundingBox();
		if (!box) throw new Error('the email value is not laid out');
		const y = box.y + box.height / 2;
		await page.mouse.move(box.x + 2, y);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width - 2, y, { steps: 10 });
		await page.mouse.up();

		// The drag really took a selection…
		expect(await page.evaluate(() => document.getSelection()?.toString() ?? '')).not.toBe('');
		// …and releasing it toggled nothing.
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
		await expect(rosterOf(page).locator('.detail')).toHaveCount(0);
	});

	test('the card summary is the door on touch, and the copy control still wins', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'the card composition is the narrow one');
		await openRoster(page);
		const card = rowsOf(page).filter({ hasText: 'Marc Dubois' });
		const chevron = card.getByRole('button', { name: 'Details for Marc Dubois' });

		// The tags line is summary, not control: a tap there opens the editor.
		await card.locator('.card__tags').tap();
		await expect(chevron).toHaveAttribute('aria-expanded', 'true');
		await expect(card.locator('.card__detail')).toBeVisible();
		await card.locator('.card__tags').tap();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');

		await card.getByRole('button', { name: 'Copy email address' }).tap();
		await expect(card.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
		await expect(chevron).toHaveAttribute('aria-expanded', 'false');
	});
});

test('the schedule pool keeps collecting slots apart from programmed content', async ({
	page
}) => {
	await page.goto('/app/schedule');

	const pool = page.getByRole('region', { name: 'Program', exact: true });
	await expect(pool).toBeVisible({ timeout: 15000 });
	// The two still-collecting slots are reviewer-scope targets. They render
	// in the pool under their own group — never mixed in with the programmed
	// sessions waiting for a slot.
	const unplaced = pool.getByRole('region', { name: 'Unplaced', exact: true });
	await expect(unplaced).toContainText('Typed Tool Contracts Between Agents That Never Meet');
	await expect(unplaced).not.toContainText('Panel: Durable Agent Infrastructure');
	await expect(unplaced).not.toContainText('Lightning Talks: Eval Fails in Production');
	const collecting = pool.getByRole('region', { name: 'Collecting proposals', exact: true });
	await expect(collecting).toContainText('Panel: Durable Agent Infrastructure');
	await expect(collecting).toContainText('Lightning Talks: Eval Fails in Production');
});
