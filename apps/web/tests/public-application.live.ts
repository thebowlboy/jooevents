import { expect, test, type Page } from '@playwright/test';

/**
 * The public CFP answering experience, live composition, mocked at the HTTP
 * boundary: the served form read plus the application ceremony lane
 * (mint → begin → autosave → submit). The browser talks to the same paths the
 * real server publishes; everything behind them is fulfilled here, so these
 * tests exercise the page, the port, the session machine, and the client
 * exactly as production wires them.
 */

const formId = '018f6f00-0000-7000-8000-0000000000f0';
const formVersionId = '018f6f00-0000-7000-8000-0000000000f2';
const submissionId = '018f6f00-0000-7000-8000-0000000000f9';
const titleFieldId = '018f6f00-0000-7000-8000-0000000000a1';
const emailFieldId = '018f6f00-0000-7000-8000-0000000000a2';
const abstractFieldId = '018f6f00-0000-7000-8000-0000000000a3';
const continuation = `gsr_${'a'.repeat(43)}`;

const servedForm = {
	schemaVersion: 1,
	formId,
	formVersionId,
	formVersionNumber: 3,
	name: 'Speak at the Summit',
	confirmation: 'Thanks — the programme team reads every proposal.',
	target: { kind: 'general_pool' },
	availability: { kind: 'evergreen' },
	fields: [
		{
			kind: 'text',
			id: titleFieldId,
			label: 'Talk title',
			help: null,
			required: true,
			initiallyVisible: true,
			position: 0,
			maximumLength: 500
		},
		{
			kind: 'email',
			id: emailFieldId,
			label: 'Contact email',
			help: null,
			required: true,
			initiallyVisible: true,
			position: 1,
			maximumLength: 320
		},
		{
			kind: 'textarea',
			id: abstractFieldId,
			label: 'Abstract',
			help: 'A paragraph is plenty.',
			required: false,
			initiallyVisible: true,
			position: 2,
			maximumLength: 10_000
		}
	],
	rules: []
};

interface CeremonyLog {
	saves: { readonly answers: readonly { fieldId: string; value?: string }[] }[];
	submits: { readonly idempotencyKey: string }[];
}

function json(body: unknown): { status: number; contentType: string; body: string } {
	return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

function notPublished(): unknown {
	return {
		kind: 'outcome',
		outcome: {
			class: 'conflict',
			kind: 'release.not_published',
			retryable: false,
			subjects: [],
			detail: null,
			detailSchemaVersion: 1
		},
		correlationId: '018f6f00-0000-7000-8000-0000000000cc'
	};
}

function draftStatus(version: number): unknown {
	return {
		schemaVersion: 1,
		formId,
		formVersionId,
		draftVersion: version,
		status: 'in_progress',
		answeredFieldIds: [],
		submittedSubmissionId: null,
		updatedAt: '2026-08-14T12:00:00.000Z'
	};
}

const receipt = {
	id: '018f6f00-0000-7000-8000-0000000000ee',
	operationName: 'intake.public.application',
	operationVersion: 1
};

async function mockCeremony(
	page: Page,
	options: { submitDelayMs?: number } = {}
): Promise<CeremonyLog> {
	const log: CeremonyLog = { saves: [], submits: [] };
	let draftVersion = 0;
	await page.route('**/api/public/schedule/current', (route) => route.fulfill(json(notPublished())));
	await page.route('**/api/public/speakers/current', (route) => route.fulfill(json(notPublished())));
	// The released presentation reads the port now performs beside the served
	// data: schedule and speakers stay unpublished; the apply surface serves.
	await page.route('**/api/public/schedule/presentation', (route) =>
		route.fulfill(json(notPublished()))
	);
	await page.route('**/api/public/speakers/presentation', (route) =>
		route.fulfill(json(notPublished()))
	);
	await page.route('**/api/public/forms/presentation', (route) =>
		route.fulfill(
			json({
				kind: 'success',
				data: {
					schemaVersion: 1,
					surfaceKind: 'apply',
					surfaceReleaseNumber: 2,
					manifest: { schemaVersion: 1, heading: 'Speak at the Summit', intro: null },
					styleSetReleaseNumber: 1,
					style: {
						name: 'Released brand',
						canvas: '#f4f1ed',
						surface: '#ffffff',
						text: '#29231f',
						action: '#a14e42',
						radius: 8,
						controlHeight: 38
					}
				},
				correlationId: '018f6f00-0000-7000-8000-0000000000cf'
			})
		)
	);
	await page.route('**/api/public/forms/current*', (route) =>
		route.fulfill(
			json({
				kind: 'success',
				data: servedForm,
				correlationId: '018f6f00-0000-7000-8000-0000000000cd'
			})
		)
	);
	await page.route('**/api/public/forms/application/continuations', (route) =>
		route.fulfill(json({ kind: 'issued', continuation, expiresAt: '2026-08-14T12:30:00.000Z' }))
	);
	await page.route('**/api/public/forms/application/mutate', async (route) => {
		const body = route.request().postDataJSON() as {
			action: 'begin' | 'save' | 'submit';
			input: { answers?: { fieldId: string; value?: string }[] };
		};
		const correlationId = '018f6f00-0000-7000-8000-0000000000ce';
		if (body.action === 'submit' && options.submitDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, options.submitDelayMs));
		}
		if (body.action === 'begin') {
			draftVersion = 1;
			return route.fulfill(
				json({
					kind: 'success',
					data: { action: 'begin', draft: draftStatus(draftVersion) },
					receipt,
					correlationId
				})
			);
		}
		if (body.action === 'save') {
			draftVersion += 1;
			log.saves.push({ answers: body.input.answers ?? [] });
			return route.fulfill(
				json({
					kind: 'success',
					data: { action: 'save', draft: draftStatus(draftVersion) },
					receipt,
					correlationId
				})
			);
		}
		log.submits.push({
			idempotencyKey: route.request().headers()['idempotency-key'] ?? ''
		});
		return route.fulfill(
			json({
				kind: 'success',
				data: {
					action: 'submit',
					submission: {
						schemaVersion: 1,
						submissionId,
						formId,
						formVersionId,
						submittedAt: '2026-08-14T12:10:00.000Z'
					}
				},
				receipt,
				correlationId
			})
		);
	});
	return log;
}

async function openApply(page: Page): Promise<void> {
	await page.goto(`/s/apply?scope=form%3A${formId}`);
	await expect(page.locator('.apply__title')).toContainText('Speak at the Summit', {
		timeout: 15000
	});
}

test('the served call takes answers, autosaving quietly', async ({ page }) => {
	const log = await mockCeremony(page);
	await openApply(page);

	// The live surface replaced the read-only notice.
	await expect(page.locator('.public__notice')).toHaveCount(0);
	const status = page.locator('.apply__save');
	await expect(status).toHaveText('Answers save as you go.');

	const title = page.getByLabel(/Talk title/);
	await expect(title).toBeEnabled();
	await title.fill('Intent, drafted');
	await expect(status).toHaveText('Saving…');
	await expect(status).toHaveText('Saved', { timeout: 15000 });
	expect(log.saves.at(-1)?.answers).toEqual([
		{ kind: 'text', fieldId: titleFieldId, value: 'Intent, drafted' }
	]);

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('an unacceptable answer refuses inline and never enters the draft', async ({ page }) => {
	const log = await mockCeremony(page);
	await openApply(page);

	const email = page.getByLabel(/Contact email/);
	await email.fill('not-an-address');
	await email.blur();
	const error = page.locator('.apply__error');
	await expect(error).toHaveText('Enter an email address like name@example.com.');
	await expect(email).toHaveAttribute('aria-invalid', 'true');

	// Correcting it clears the refusal in place.
	await email.fill('ada@example.org');
	await expect(error).toHaveCount(0);

	// Whatever autosave ran, no save ever carried the malformed address.
	for (const save of log.saves) {
		expect(save.answers.every((answer) => answer.value !== 'not-an-address')).toBe(true);
	}
});

test('a blocked submit points at the missing answers instead of sending', async ({ page }) => {
	const log = await mockCeremony(page);
	await openApply(page);

	await page.getByRole('button', { name: 'Submit application' }).click();
	await expect(page.locator('.apply__note--refused')).toContainText('2 questions need attention');
	await expect(page.locator('.apply__error')).toHaveCount(2);
	await expect(page.getByLabel(/Talk title/)).toBeFocused();
	expect(log.submits).toHaveLength(0);
});

test('the embed document drives the identical ceremony, not a second form', async ({ page }) => {
	const log = await mockCeremony(page);
	await page.goto(`/embed/apply?scope=form%3A${formId}`);
	await expect(page.locator('.apply__title')).toContainText('Speak at the Summit', {
		timeout: 15000
	});

	// Same surface, same session machine, same lane: an edit autosaves through
	// the one mutate path the standalone page uses.
	await page.getByLabel(/Talk title/).fill('Embedded intent');
	await expect(page.locator('.apply__save')).toHaveText('Saved', { timeout: 15000 });
	expect(log.saves.at(-1)?.answers).toEqual([
		{ kind: 'text', fieldId: titleFieldId, value: 'Embedded intent' }
	]);
});

test('a completed call submits once and lands on the served confirmation', async ({ page }) => {
	const log = await mockCeremony(page);
	await openApply(page);

	await page.getByLabel(/Talk title/).fill('Intent, drafted');
	await page.getByLabel(/Contact email/).fill('ada@example.org');
	await page.getByRole('button', { name: 'Submit application' }).click();

	const done = page.locator('.apply__done');
	await expect(done).toBeVisible({ timeout: 15000 });
	await expect(done).toContainText('Application received');
	// The organizer's own confirmation copy, verbatim — nothing promised that
	// the product does not do.
	await expect(done).toContainText('Thanks — the programme team reads every proposal.');
	await expect(page.locator('.apply__submit')).toHaveCount(0);

	// The transition hands the keyboard to the confirmation, so the next Tab
	// stop is the panel's one action.
	await expect(done).toBeFocused();

	// The application-owned door: one action, the participant entry route, no
	// submission data, email, or token in the address, same tab on the hosted page.
	const door = page.getByRole('link', { name: 'See your application' });
	await expect(door).toBeVisible();
	await expect(door).toHaveAttribute('href', '/portal/sign-in');
	await expect(door).not.toHaveAttribute('target', /.+/);
	await expect(done).toContainText(
		'We’ll ask for your email and send a sign-in link. No password.'
	);

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);

	expect(log.submits).toHaveLength(1);
	expect(log.submits[0]?.idempotencyKey.length).toBeGreaterThan(0);
});

test('a submit in flight refuses a second activation', async ({ page }) => {
	const log = await mockCeremony(page, { submitDelayMs: 700 });
	await openApply(page);

	await page.getByLabel(/Talk title/).fill('Intent, drafted');
	await page.getByLabel(/Contact email/).fill('ada@example.org');
	const submit = page.getByRole('button', { name: /Submit|Submitting/ });
	await submit.click();
	// The press was taken: the control reports it and cannot be pressed again.
	await expect(submit).toBeDisabled();
	await expect(submit).toHaveAttribute('aria-busy', 'true');
	await expect(page.locator('.apply__done')).toBeVisible({ timeout: 15000 });
	expect(log.submits).toHaveLength(1);
});

test('the embed presentation opens the participant door in a top-level tab', async ({ page }) => {
	const log = await mockCeremony(page);
	await page.goto(`/embed/apply?scope=form%3A${formId}`);
	await expect(page.locator('.apply__title')).toContainText('Speak at the Summit', {
		timeout: 15000
	});

	await page.getByLabel(/Talk title/).fill('Embedded intent');
	await page.getByLabel(/Contact email/).fill('ada@example.org');
	await page.getByRole('button', { name: 'Submit application' }).click();
	await expect(page.locator('.apply__done')).toBeVisible({ timeout: 15000 });

	// Inside a host's frame the door never signs in embedded: it opens the
	// canonical route top-level, and the address still carries nothing.
	const door = page.getByRole('link', { name: 'See your application' });
	await expect(door).toHaveAttribute('href', '/portal/sign-in');
	await expect(door).toHaveAttribute('target', '_blank');
	await expect(door).toHaveAttribute('rel', 'noopener');
	expect(log.submits).toHaveLength(1);
});
