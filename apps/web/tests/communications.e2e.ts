import { expect, test } from '@playwright/test';

/**
 * The communications surface: work waiting on the operator sits in the
 * attention queue, everything authorized to leave sits in history with its
 * purpose and cause, and a person scope shows one speaker's own thread.
 *
 * Pinned to the mid-flight scenario: these tests assert its exact fixtures
 * (the onboarding bounces, the acceptance draft, Maya's thread), and which
 * story the hosted demo opens on must not decide what they see.
 */

test.use({
	storageState: {
		cookies: [
			{
				name: 'je-scenario',
				value: 'flight',
				domain: '127.0.0.1',
				path: '/',
				expires: -1,
				httpOnly: false,
				secure: false,
				sameSite: 'Lax'
			}
		],
		origins: []
	}
});

test('attention and history split the surface, and every history row states why it was sent', async ({ page }) => {
	await page.goto('/app/messages');
	await expect(page.getByRole('heading', { level: 1, name: 'Communications' })).toBeVisible();

	// The queue holds the actionable work: the acceptance draft and the bounces.
	const queue = page.getByRole('region', { name: 'Needs attention' });
	await expect(queue).toContainText('Draft awaiting your review', { timeout: 15000 });
	await expect(queue).toContainText('2 addresses bounced');

	// History carries provenance, not just state: purpose eyebrow plus cause.
	const history = page.getByRole('region', { name: 'History' });
	await expect(history).toContainText('Speaker onboarding');
	await expect(history).toContainText('18 speakers reached confirmed');
	// Drafts have not happened yet, so they are queue-only.
	await expect(history).not.toContainText('Draft awaiting');

	// Agent and policy authorship are marked; the operator's own is the default.
	await expect(history).toContainText('Agent-drafted');
	await expect(history).toContainText('Automatic');
});

test('the queue’s draft action opens the recipient-level review', async ({ page }) => {
	await page.goto('/app/messages');
	const queue = page.getByRole('region', { name: 'Needs attention' });
	await expect(queue).toContainText('Draft awaiting your review', { timeout: 15000 });

	await queue.getByRole('button', { name: 'Review & send' }).click();
	const dialog = page.getByRole('dialog', { name: 'Review & send' });
	await expect(dialog).toBeVisible();
	// The recipient table is the primary evidence: included rows and the
	// policy/fault distinctions stay rows, never bare counts.
	await expect(dialog).toContainText('Amara Okafor');
	await expect(dialog).toContainText('Address suppressed after a hard bounce');
	await expect(dialog.getByRole('button', { name: /Send \d+ emails/ })).toBeVisible();
});

test('review shows the first recipient’s whole email by default and rows switch whose copy shows', async ({ page }) => {
	await page.goto('/app/messages');
	const queue = page.getByRole('region', { name: 'Needs attention' });
	await expect(queue).toContainText('Draft awaiting your review', { timeout: 15000 });
	await queue.getByRole('button', { name: 'Review & send' }).click();
	const dialog = page.getByRole('dialog', { name: 'Review & send' });

	// The artifact is there from the start: the first included recipient's own
	// copy, merge fields resolved with her values.
	const amara = dialog.getByRole('region', { name: 'Email preview for Amara Okafor' });
	await expect(amara).toBeVisible();
	await expect(amara).toContainText('What Amara Okafor receives');
	await expect(amara).toContainText('Typed Tool Contracts Between Agents That Never Meet');

	// Pressing another included row switches whose copy is shown.
	await dialog.getByRole('button', { name: 'Preview the email for Priya Nair' }).click();
	const priya = dialog.getByRole('region', { name: 'Email preview for Priya Nair' });
	await expect(priya).toBeVisible();
	await expect(priya).toContainText('LLM Review Queues: Allocating Human Attention');
	await expect(amara).toHaveCount(0);

	// Excluded and blocked rows can never request content: their reasons stay
	// plain text, not presses.
	await expect(
		dialog.getByRole('button', { name: 'Preview the email for Rex Vault' })
	).toHaveCount(0);
	await expect(
		dialog.getByRole('button', { name: 'Preview the email for Deniz Kaya' })
	).toHaveCount(0);
});

test('a history row’s cause carries one door to the causal record', async ({ page }) => {
	await page.goto('/app/messages');
	const history = page.getByRole('region', { name: 'History' });
	await expect(history).toContainText('Speaker onboarding', { timeout: 15000 });

	// The onboarding send was caused by the confirmed roster; its cause line
	// ends with the one way there, carrying the scope in the URL.
	const row = history.locator('[data-message="msg-1"]');
	await expect(row.getByRole('link', { name: 'Open speakers' })).toHaveAttribute(
		'href',
		'/app/speakers?filter=confirmed'
	);
});

test('a person scope shows one speaker’s thread and the chip clears it', async ({ page }) => {
	await page.goto('/app/messages?person=spk-7');

	// Elena's own outcome is the point of the thread: her copy bounced even
	// though the batch reads sent.
	const history = page.getByRole('region', { name: 'History' });
	await expect(history).toContainText('Bounced', { timeout: 15000 });
	await expect(history).toContainText('Speaker onboarding');

	// The scope chip is the one-action reversal and the scope lives in the URL.
	await page.getByRole('button', { name: 'Stop showing only Elena Petrova' }).click();
	await expect(page).toHaveURL(/\/app\/messages$/);
	await expect(history).toContainText('18 speakers reached confirmed');
});

test('compose previews the chosen template as the recipients get it', async ({ page }) => {
	await page.goto('/app/messages?compose=1');
	const dialog = page.getByRole('dialog', { name: 'Compose message' });
	await expect(dialog).toBeVisible();

	// Blank start states there is nothing to preview yet, in the same footprint.
	await expect(dialog).toContainText('No template chosen');

	await dialog.getByLabel('Template').selectOption({ label: 'Decision — accepted' });
	// The rendered artifact appears: subject seeded from the template, merge
	// chips resolved to their declared samples.
	await expect(dialog.getByLabel('Subject')).toHaveValue(/Good news/);
	await expect(dialog.locator('.email__subject')).toContainText('Good news');
	await expect(dialog.getByRole('link', { name: /Edit template/ })).toHaveAttribute(
		'href',
		'/app/templates?template=tpl-decision-accepted'
	);

	// Audiences combine, so the control is a checkable set rather than a list of
	// alternatives. The count on each is served, not hardcoded: the flight
	// scenario this suite runs against has 5 confirmed speakers (crunch has 10).
	const audience = dialog.getByRole('group', { name: 'Audience' });
	await expect(audience).toContainText('Confirmed speakers · 5');
	// The first audience arrives picked, so a draft is one subject away.
	await expect(audience.getByRole('checkbox', { name: /Confirmed speakers/ })).toBeChecked();
});

test('“See the addresses” lands on the bounce evidence, in view, and the row can be corrected and resent', async ({ page }) => {
	await page.goto('/app/messages');
	const queue = page.getByRole('region', { name: 'Needs attention' });
	await expect(queue).toContainText('2 addresses bounced', { timeout: 15000 });

	// The pointer keeps its promise: the evidence row opens and is on screen.
	await queue.getByRole('button', { name: 'See the addresses' }).click();
	const bounces = page.locator('.bounces');
	await expect(bounces).toBeVisible();
	await expect(page).toHaveURL(/message=msg-1/);
	await expect
		.poll(async () => {
			const box = await bounces.boundingBox();
			const viewport = page.viewportSize();
			return box && viewport ? box.y >= 0 && box.y < viewport.height : false;
		}, { timeout: 3000 })
		.toBe(true);

	// The remedy is real: correct the address and resend that one copy.
	await bounces.getByRole('button', { name: 'Edit address for elena@sandboxworks.example' }).click();
	const field = bounces.getByLabel('Corrected address for elena@sandboxworks.example');
	await field.fill('elena@corrected.example');
	await bounces.getByRole('button', { name: 'Resend 1 email' }).click();

	// The bounce leaves the evidence, the counts move, and the receipt records
	// the irreversible send.
	await expect(bounces).not.toContainText('elena@sandboxworks.example');
	const history = page.getByRole('region', { name: 'History' });
	await expect(history).toContainText('17 delivered');
	await expect(history).toContainText('1 bounced');
	await expect(page.getByText(/Resent “Speaker onboarding — what happens next” to elena@corrected\.example/)).toBeVisible();

	// The attention queue is a derived projection: it recounts on its own.
	await expect(queue).toContainText('1 address bounced');
});

test('the roster expansion carries the speaker’s communications tail and a scoped compose door', async ({ page }) => {
	await page.goto('/app/speakers?speaker=spk-1');

	// The arrival opens Maya's row; her tail lists what she was sent.
	await expect(page.getByRole('heading', { level: 3, name: 'Communications' })).toBeVisible({
		timeout: 15000
	});
	// The roster lays out twice (table and cards); only the visible tail counts.
	await expect(
		page.getByText('Speaker invitation · Jul 21, 14:05').filter({ visible: true })
	).toBeVisible();

	const door = page.getByRole('link', { name: 'Open in Communications' });
	await expect(door).toHaveAttribute('href', '/app/messages?person=spk-1');
	const compose = page.getByRole('link', { name: 'Compose email' });
	await expect(compose).toHaveAttribute('href', '/app/messages?compose=1&person=spk-1');
});
