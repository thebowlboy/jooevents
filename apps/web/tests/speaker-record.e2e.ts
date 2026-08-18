import { expect, test } from '@playwright/test';

/**
 * Everything the product holds on one person, on one page.
 *
 * The contract this suite holds: the record route resolves and renders live-known
 * truth or a typed absence; a received form's answers are readable *before* the
 * control that accepts them; a cancellation request leads the page and its one
 * remedy is the walk's own URL; and the acts commit through the same operations
 * the task board uses, receipt and undo included.
 *
 * The cast is the mid-flight scenario:
 *
 * | Person | id | What the record demonstrates |
 * | --- | --- | --- |
 * | Maya Lindqvist | `spk-1` | `cancel_requested` leading the page; the walk door; settled material that stays readable |
 * | Lukas Brandt | `spk-5` | the received **Travel details** form with its answers; accept, receipt, undo |
 * | Ravi Chandran | `spk-6` | a received **upload** as a file card; on the lineup but showing as TBA |
 * | Elena Petrova | `spk-7` | a bounced address; three overdue tasks; a portal draft that is never rendered; a received row whose material cannot be read |
 * | Daniel Kim | `spk-8` | a **waived** deliverable with who and when |
 * | Sofia Berg | `spk-4` | the boring record: everything settled, the calm sentence |
 * | Amara Okafor | `spk-2` | `invited`; a decided proposal nobody has been told about |
 * | Astrid Holm | `spk-9` | `declined` — the record as archive |
 */

const FLIGHT = 'flight';

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: 'je-scenario', value: FLIGHT, url: baseURL ?? 'http://127.0.0.1:4173' }
	]);
});

const record = (page: import('@playwright/test').Page) =>
	page.getByRole('region', { name: 'Speaker record' });

test('the record route renders one person whole, in the design’s fixed order', async ({ page }) => {
	await page.goto('/app/speakers/spk-5');

	const surface = record(page);
	await expect(surface.getByRole('heading', { name: 'Lukas Brandt', level: 2 })).toBeVisible({
		timeout: 15000
	});

	// `Name <address>` as display punctuation; copy still carries the raw email.
	await expect(surface).toContainText('Lukas Brandt <lukas@perfpanel.se>');

	// Seven sections, in the order the record design fixes.
	const headings = surface.getByRole('heading', { level: 3 });
	await expect(headings).toHaveText([
		'Needs attention',
		'Speaking commitments',
		'Deliverables',
		'Communications',
		'Program content',
		'History'
	]);

	// The rail keeps Speakers selected: a record belongs to the surface listing it.
	await expect(page.getByRole('link', { name: /^Speakers/ })).toHaveAttribute(
		'aria-current',
		'page'
	);
});

test('the header cue composes standing, when, where — each arm only when its fact exists', async ({
	page
}) => {
	await page.goto('/app/speakers/spk-5');
	const surface = record(page);
	await expect(surface).toContainText('confirmed', { timeout: 15000 });
	// Placed on the grid, so the slot arms render; the flight scenario has no
	// published release, so the publication arm does not.
	await expect(surface).toContainText('Main Stage');
	await expect(surface).not.toContainText('public since release');

	// Provenance, in the attribution grammar, always present.
	await expect(surface).toContainText('Direct entry by Linnea Koski.');

	// An invited person with no placement gets standing alone.
	await page.goto('/app/speakers/spk-2');
	await expect(record(page)).toContainText('invited', { timeout: 15000 });
});

test('a received form’s answers are readable, and travel details are readable at last', async ({
	page
}) => {
	await page.goto('/app/speakers/spk-5');
	const surface = record(page);
	await expect(surface).toContainText('Deliverables', { timeout: 15000 });

	// The defect this page exists to end: the answers render in place, above the
	// control that would accept them.
	await expect(surface).toContainText('Travel details');
	await expect(surface).toContainText('Arriving');
	await expect(surface).toContainText('Mon Oct 12, 18:40 — LH 462 into JFK');
	await expect(surface).toContainText('Dietary requirements');
	await expect(surface).toContainText('Severe walnut allergy');

	// A question they passed on is a fact about the form, not a missing row.
	await expect(surface).toContainText('They left this blank.');

	// The material precedes the act on screen, not merely somewhere on the page.
	const answers = surface.getByText('Mon Oct 12, 18:40 — LH 462 into JFK');
	const accept = surface.getByRole('button', { name: 'Accept as complete' }).first();
	await expect(accept).toBeEnabled();
	const answersBox = await answers.boundingBox();
	const acceptBox = await accept.boundingBox();
	expect(answersBox!.y).toBeLessThan(acceptBox!.y);
});

test('accepting commits through the shared act, leaves a receipt, and undoes exactly', async ({
	page
}) => {
	await page.goto('/app/speakers/spk-5');
	const surface = record(page);
	await expect(surface).toContainText('Received', { timeout: 15000 });

	await surface.getByRole('button', { name: 'Accept as complete' }).first().click();

	await expect(surface).toContainText('Accepted by you');
	await expect(page.getByText('Accepted “Travel details” from Lukas Brandt')).toBeVisible();
	// The material survives acceptance: the archive is the point.
	await expect(surface).toContainText('Severe walnut allergy');

	await page.getByRole('button', { name: /Undo/ }).click();
	await expect(surface.getByRole('button', { name: 'Accept as complete' }).first()).toBeEnabled();
	await expect(surface).not.toContainText('Accepted by you');
});

test('no accept control renders above unviewable content', async ({ page }) => {
	await page.goto('/app/speakers/spk-7');
	const surface = record(page);
	await expect(surface).toContainText('Slides draft', { timeout: 15000 });

	// The control stays visible and carries its reason — hiding it would delete
	// the "why", and accepting unread material is what this page ends.
	const accept = surface.getByRole('button', { name: 'Accept as complete' });
	await expect(accept).toHaveAttribute('aria-disabled', 'true');
	await expect(surface).toContainText('nothing to accept yet');
});

test('a portal draft is never rendered; the row says not yet submitted', async ({ page }) => {
	await page.goto('/app/speakers/spk-7');
	const surface = record(page);
	await expect(surface).toContainText('Headshot upload', { timeout: 15000 });

	await expect(surface).toContainText('Not yet submitted.');
	// The fixture holds Elena's autosave; nothing of it reaches this surface.
	await expect(surface).not.toContainText('Aug 12, 22:41');
});

test('a cancellation request leads the record, and its one remedy is the walk', async ({ page }) => {
	await page.goto('/app/speakers/spk-1');
	const surface = record(page);
	await expect(surface).toContainText('Maya Lindqvist asked to cancel.', { timeout: 15000 });

	// Leading: it is the first attention row on the page.
	const rows = surface.locator('.attention__row');
	await expect(rows.first()).toContainText('asked to cancel');
	await expect(surface).toContainText('client emergency', { ignoreCase: true });

	// The door is the walk's URL, and the page carries exactly one of it — the
	// header's one primary action. The record never re-implements a walk step,
	// so no accept-cancellation control exists here.
	const door = surface.getByRole('link', { name: 'Review cancellation…' });
	await expect(door).toHaveCount(1);
	await expect(door).toHaveAttribute('href', '/app/speakers?panel=cancellation&engagement=spk-1');
	await expect(surface.getByRole('button', { name: /Accept cancellation/ })).toHaveCount(0);

	// And the request's own words are stated once, on the row that owns them.
	await expect(surface.getByText(/client emergency/i)).toHaveCount(1);

	// The outbound guard renders beside the compose door.
	await expect(surface).toContainText('Nothing goes out to Maya Lindqvist until');
});

test('a bounced address, overdue work, and an unsent result rank by consequence', async ({
	page
}) => {
	await page.goto('/app/speakers/spk-7');
	const surface = record(page);
	await expect(surface).toContainText('Needs attention', { timeout: 15000 });

	const titles = surface.locator('.attention__title');
	await expect(titles.first()).toContainText('never received');
	await expect(surface).toContainText('3 tasks are past their due date.');
	await expect(
		surface.getByRole('link', { name: 'Send a reminder' }).first()
	).toHaveAttribute('href', '/app/tasks?speaker=spk-7&filter=overdue');
});

test('a person in good standing gets the calm sentence, and that is the success state', async ({
	page
}) => {
	await page.goto('/app/speakers/spk-4');
	const surface = record(page);
	await expect(surface).toContainText('Nothing needs you for Sofia Berg.', { timeout: 15000 });
});

test('an unconfirmed engagement offers the one next step, and names who is waiting', async ({
	page
}) => {
	await page.goto('/app/speakers/spk-2');
	const surface = record(page);
	await expect(surface).toContainText('Amara Okafor has not said yes yet.', { timeout: 15000 });
	await expect(surface).toContainText('has not been told the result of their proposal');

	await surface.getByRole('button', { name: 'Record confirmation' }).click();
	await expect(surface).toContainText('Confirmed');
	await expect(surface).not.toContainText('has not said yes yet');
});

test('a terminal engagement is an archive: no attention, material intact', async ({ page }) => {
	await page.goto('/app/speakers/spk-9');
	const surface = record(page);
	await expect(surface.getByRole('heading', { name: 'Astrid Holm', level: 2 })).toBeVisible({
		timeout: 15000
	});
	await expect(surface).toContainText('Nothing is outstanding. This record is kept as it stands.');
	await expect(surface.getByRole('button', { name: 'Record confirmation' })).toHaveCount(0);
});

test('a waived deliverable says who waived it and when, and claims no content', async ({ page }) => {
	await page.goto('/app/speakers/spk-8');
	const surface = record(page);
	await expect(surface).toContainText('Waived', { timeout: 15000 });
	await expect(surface).toContainText('Waived by you');
});

test('sessions carry the full placement line and link to the slot', async ({ page }) => {
	await page.goto('/app/speakers/spk-6');
	const surface = record(page);
	await expect(surface).toContainText('Opening Keynote', { timeout: 15000 });
	const session = surface.getByRole('link', { name: /Opening Keynote/ });
	await expect(session).toHaveAttribute('href', '/app/schedule?session=ses-1');
	await expect(surface).toContainText(' · Main Stage');
});

test('the thread is the whole thread, newest first, with each entry’s own outcome', async ({
	page
}) => {
	await page.goto('/app/speakers/spk-1');
	const surface = record(page);
	await expect(surface).toContainText('Communications', { timeout: 15000 });

	const entries = surface.locator('.thread__entry');
	await expect(entries).toHaveCount(2);
	await expect(entries.first()).toContainText('Speaker onboarding — what happens next');
	await expect(entries.first()).toContainText('Delivered');

	await expect(surface.getByRole('link', { name: 'Write to Maya Lindqvist' })).toHaveAttribute(
		'href',
		'/app/messages?compose=1&person=spk-1'
	);
});

test('published profile renders as the public roster renders it, TBA included', async ({ page }) => {
	await page.goto('/app/speakers/spk-6');
	const surface = record(page);
	await expect(surface).toContainText('Published profile', { timeout: 15000 });
	// Ravi is on the lineup with nothing approved: the record says so rather than
	// inventing a biography.
	await expect(surface).toContainText('without a biography');

	await page.goto('/app/speakers/spk-5');
	await expect(record(page)).toContainText('not on the public lineup', { timeout: 15000 });
});

test('history renders its absence as itself, never an invented timeline', async ({ page }) => {
	await page.goto('/app/speakers/spk-5');
	const surface = record(page);
	await expect(surface).toContainText('History', { timeout: 15000 });
	await expect(surface).toContainText('A per-person history is not');
	await expect(surface.getByRole('link', { name: 'Pulse' })).toBeVisible();
});

test('an address that names no engagement is answered as itself', async ({ page }) => {
	await page.goto('/app/speakers/spk-never-existed');
	const surface = record(page);
	await expect(surface).toContainText('No speaker record matches this address', {
		timeout: 15000
	});
	await expect(surface.getByRole('link', { name: 'Open Speakers' })).toBeVisible();
});

test('every person-shaped door resolves to the one record URL', async ({ page }) => {
	// The roster row expansion.
	await page.goto('/app/speakers');
	const roster = page.getByRole('region', { name: 'Speaker roster' });
	await roster
		.getByRole('button', { name: 'Details for Maya Lindqvist' })
		.filter({ visible: true })
		.click();
	await expect(
		roster.getByRole('link', { name: 'Open record' }).filter({ visible: true }).first()
	).toHaveAttribute('href', '/app/speakers/spk-1');

	// The Tasks matrix speaker name's peek keeps working, and its door moved too.
	await page.goto('/app/tasks');
	await page.getByRole('button', { name: 'Maya Lindqvist — speaker profile' }).first().click();
	await expect(
		page.getByRole('link', { name: 'Open record — opens in new window' })
	).toHaveAttribute('href', '/app/speakers/spk-1');
});

test('the record stacks without horizontal overflow at a touch width', async ({
	page
}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'the narrow composition owns this contract');

	await page.goto('/app/speakers/spk-5');
	await expect(record(page)).toContainText('Travel details', { timeout: 15000 });

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);

	// Consequential actions survive the narrow viewport rather than being dropped.
	await expect(page.getByRole('button', { name: 'Accept as complete' }).first()).toBeVisible();
	const box = await page.getByRole('button', { name: 'Accept as complete' }).first().boundingBox();
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
});
