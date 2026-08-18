import { expect, test, type Page } from '@playwright/test';

/**
 * Focused joined smoke for the newly mounted live Reviewers aggregate
 * (reviewer_roster.snapshot.read behind the tuned roster, load counts from
 * the organizer-served review snapshot, coverage served only as its proven
 * empty population).
 *
 * The joined harness serves one shared ephemeral backend for every project in
 * the run, so this spec creates the event only when the workspace is still
 * first-run. The schedule smoke retires the vocabulary it mints precisely so
 * this roster's `coverage: []` claim stays provable on every project's pass.
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

async function expectNoDocumentOverflow(page: Page): Promise<void> {
	expect(await page.evaluate(() => ({
		document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		body: document.body.scrollWidth > document.body.clientWidth
	}))).toEqual({ document: false, body: false });
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

async function mountVacancyScenario(page: Page) {
	const [teamResponse, rosterResponse, reviewResponse] = await Promise.all([
		page.request.get('/api/workspace/team'),
		page.request.get('/api/events/current/reviewer-roster'),
		page.request.get('/api/events/current/review/snapshot')
	]);
	expect(teamResponse.ok()).toBe(true);
	expect(rosterResponse.ok()).toBe(true);
	expect(reviewResponse.ok()).toBe(true);
	const teamPayload = await teamResponse.json();
	const rosterPayload = await rosterResponse.json();
	const reviewPayload = await reviewResponse.json();
	const owner = teamPayload.data.members.find((member: { kind: string }) => member.kind === 'member');
	if (!owner) throw new Error('Joined owner member missing.');

	const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
	const vacatedReviewerId = id(201);
	const replacementReviewerId = id(202);
	const blockedReviewerId = id(203);
	const replacementMembershipId = id(211);
	const blockedMembershipId = id(212);
	const replacementUserId = id(213);
	const blockedUserId = id(214);
	const roundId = id(220);
	const assignmentId = id(221);
	const replacementAssignmentId = id(222);
	const submissionId = id(223);
	const criterionId = id(224);
	const correlationId = id(230);
	const receiptId = id(231);
	const resolvedByUserId = id(232);
	const ownerSubject = {
		kind: 'workspace_membership',
		id: owner.id,
		version: owner.version
	};
	const capabilityIds = [
		'event.read', 'speaker.directory.read', 'submission.read',
		'submission.score', 'submission.comment', 'schedule.read'
	];
	const reviewer = (reviewerId: string, subject: typeof ownerSubject, displayName: string) => ({
		reviewerId,
		recordVersion: 1,
		projectionVersion: 1,
		status: 'active',
		accessSubject: subject,
		authority: {
			schemaVersion: 1,
			scope: rosterPayload.data.scope,
			rosterSubject: subject,
			currentSubject: subject,
			state: 'active',
			version: 1,
			digestSha256: 'a'.repeat(64),
			capabilityIds,
			evidenceIds: [`browser:${reviewerId}`],
			displayName
		},
		displayName,
		reviews: []
	});
	const replacementSubject = { kind: 'workspace_membership' as const, id: replacementMembershipId, version: 1 };
	const blockedSubject = { kind: 'workspace_membership' as const, id: blockedMembershipId, version: 1 };

	await page.route('**/api/workspace/team', (route) => route.fulfill({
		json: {
			...teamPayload,
			data: {
				...teamPayload.data,
				members: [
					owner,
					{
						...owner, id: replacementMembershipId, userId: replacementUserId,
						name: 'Morgan Lee', email: 'morgan.lee@example.test'
					},
					{
						...owner, id: blockedMembershipId, userId: blockedUserId,
						name: 'Sam Rivera', email: 'sam.rivera@example.test'
					}
				].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
			}
		}
	}));
	await page.route('**/api/events/current/reviewer-roster', (route) => route.fulfill({
		json: {
			...rosterPayload,
			data: {
				...rosterPayload.data,
				reviewers: [
					reviewer(vacatedReviewerId, ownerSubject, owner.name),
					reviewer(replacementReviewerId, replacementSubject, 'Morgan Lee'),
					reviewer(blockedReviewerId, blockedSubject, 'Sam Rivera')
				]
			}
		}
	}));

	let resolved = false;
	let submitted: unknown;
	const plan = () => ({
		id: roundId,
		ordinal: 1,
		name: 'Round 1',
		state: 'open',
		version: 1,
		scaleMax: 5,
		deadlineEffectiveAt: '2027-06-11T00:00:00.000Z',
		criteria: [{
			id: criterionId, key: 'overall', label: 'Overall', position: 0,
			weightBps: 10_000, scaleMin: 1, scaleMax: 5
		}],
		anonymized: true,
		antiAnchoring: true,
		done: 0,
		total: 1,
		reviewers: resolved
			? [
				{ reviewerId: vacatedReviewerId, displayName: owner.name, assigned: 0, done: 0, steppedBack: 1, awaitingReassignment: 0 },
				{ reviewerId: replacementReviewerId, displayName: 'Morgan Lee', assigned: 1, done: 0, steppedBack: 0, awaitingReassignment: 0 },
				{ reviewerId: blockedReviewerId, displayName: 'Sam Rivera', assigned: 0, done: 0, steppedBack: 0, awaitingReassignment: 0 }
			]
			: [
				{
					reviewerId: vacatedReviewerId,
					displayName: owner.name,
					assigned: 1,
					done: 0,
					steppedBack: 1,
					awaitingReassignment: 1,
					uncovered: [{
						assignmentId,
						assignmentVersion: 2,
						roundId,
						submissionId,
						title: 'Designing durable queues',
						remainingReviewers: 0,
						replacementCandidates: [
							{ reviewerId: replacementReviewerId, displayName: 'Morgan Lee', assigned: 0, scopeMatch: true },
							{ reviewerId: blockedReviewerId, displayName: 'Sam Rivera', assigned: 0, scopeMatch: false, conflict: 'Outside this reviewer’s current scope' }
						]
					}]
				},
				{ reviewerId: replacementReviewerId, displayName: 'Morgan Lee', assigned: 0, done: 0, steppedBack: 0, awaitingReassignment: 0 },
				{ reviewerId: blockedReviewerId, displayName: 'Sam Rivera', assigned: 0, done: 0, steppedBack: 0, awaitingReassignment: 0 }
			]
	});
	await page.route('**/api/events/current/review/snapshot', (route) => route.fulfill({
		json: {
			...reviewPayload,
			data: { schemaVersion: 1, viewer: { kind: 'organizer' }, plans: [plan()], standings: {} }
		}
	}));
	await page.route('**/api/events/current/review/assignments/vacancy', async (route) => {
		submitted = await route.request().postDataJSON();
		const input = submitted as { action: 'assign_replacement' | 'accept_coverage' };
		resolved = true;
		await route.fulfill({
			json: {
				kind: 'success',
				data: input.action === 'assign_replacement'
					? {
						action: input.action,
						resolution: {
							schemaVersion: 1, scope: rosterPayload.data.scope, kind: 'replacement',
							vacatedAssignmentId: assignmentId,
							replacementAssignmentId,
							replacementReviewerId,
							resolvedByUserId,
							resolvedAt: '2027-06-01T00:00:00.000Z'
						},
						replacement: {
							schemaVersion: 1, scope: rosterPayload.data.scope, id: replacementAssignmentId,
							roundId, submissionId, reviewerId: replacementReviewerId,
							version: 1, state: 'assigned', assignedAt: '2027-06-01T00:00:00.000Z'
						}
					}
					: {
						action: input.action,
						resolution: {
							schemaVersion: 1, scope: rosterPayload.data.scope, kind: 'coverage_accepted',
							vacatedAssignmentId: assignmentId,
							resolvedByUserId,
							resolvedAt: '2027-06-01T00:00:00.000Z'
						}
					},
				receipt: {
					id: receiptId,
					operationName: 'review.assignment.vacancy.change',
					operationVersion: 1
				},
				correlationId
			}
		});
	});
	return {
		assignmentId,
		replacementReviewerId,
		submitted: () => submitted
	};
}

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

test('an organizer assigns an in-scope replacement and closes the vacancy', async ({ page }, testInfo) => {
	await ensureEvent(page);
	const scenario = await mountVacancyScenario(page);
	await page.goto('/app/reviewers');

	const vacancy = page.getByRole('button', { name: '1 need another reviewer — why' });
	await expect(vacancy).toBeVisible();
	if (testInfo.project.name === 'mobile') {
		const target = await vacancy.evaluate((button) => {
			const box = button.getBoundingClientRect();
			const owns = (node: Element | null) => node === button || (node !== null && button.contains(node));
			return {
				height: Number.parseFloat(getComputedStyle(button, '::after').blockSize),
				top: owns(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2 - 21)),
				bottom: owns(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2 + 21))
			};
		});
		expect(target).toEqual({ height: 44, top: true, bottom: true });
	}
	await vacancy.click();
	await page.getByRole('button', { name: 'Assign reviewer' }).first().click();

	const dialog = page.getByRole('dialog', { name: 'Assign a replacement reviewer' });
	await expect(dialog.getByText('Morgan Lee', { exact: true })).toBeVisible();
	await expect(dialog.getByText('Sam Rivera', { exact: true })).toBeVisible();
	await expect(dialog.getByText('Outside this reviewer’s current scope', { exact: true })).toBeVisible();
	await expect(dialog.getByRole('radio', { name: /Morgan Lee/ })).toBeChecked();
	await expect(dialog.getByRole('radio', { name: /Sam Rivera/ })).toBeDisabled();
	await dialog.getByRole('button', { name: 'Assign reviewer' }).click();

	await expect(page.getByText('Morgan Lee now covers “Designing durable queues”.', { exact: true })).toBeVisible();
	expect(scenario.submitted()).toEqual({
		action: 'assign_replacement',
		assignmentId: scenario.assignmentId,
		expectedAssignmentVersion: 2,
		replacementReviewerId: scenario.replacementReviewerId
	});
	await expect(page.getByRole('button', { name: '1 need another reviewer — why' })).toHaveCount(0);
	await expectNoDocumentOverflow(page);
});

test('an organizer explicitly accepts reduced coverage and retires only that slot', async ({ page }) => {
	await ensureEvent(page);
	const scenario = await mountVacancyScenario(page);
	await page.goto('/app/reviewers');

	await page.getByRole('button', { name: '1 need another reviewer — why' }).click();
	await page.getByRole('button', { name: 'Accept coverage' }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Accept the current coverage?' });
	await expect(dialog.getByText(
		'“Designing durable queues” will continue with 0 reviewers. This retires the open review slot; it does not claim another review was completed.',
		{ exact: true }
	)).toBeVisible();
	await dialog.getByRole('button', { name: 'Accept coverage' }).click();

	await expect(page.getByText('Current review coverage accepted for “Designing durable queues”.', { exact: true })).toBeVisible();
	expect(scenario.submitted()).toEqual({
		action: 'accept_coverage',
		assignmentId: scenario.assignmentId,
		expectedAssignmentVersion: 2
	});
	await expect(page.getByRole('button', { name: '1 need another reviewer — why' })).toHaveCount(0);
	await expectNoDocumentOverflow(page);
});

test('live reviewers records an invitation and retains it across reload', async ({ page }, testInfo) => {
	await ensureEvent(page);
	await page.goto('/app/reviewers');
	const email = `joined-smoke-${testInfo.project.name}@example.test`;

	// The joined composition reserves workspace access and registers that
	// subject in the roster. The address is discovery input, never authority.
	await page.getByRole('button', { name: 'Invite reviewers' }).first().click();
	const invite = page.getByRole('dialog', { name: 'Invite reviewers' });
	await invite.getByRole('textbox', { name: 'Email addresses' }).fill(email);
	await invite.getByRole('button', { name: 'Record invitations' }).click();
	await expect(invite.getByText('1 recorded.', { exact: true })).toBeVisible();
	await expect(invite.getByText(email, { exact: true })).toBeVisible();
	await expect(invite.getByText('Recorded', { exact: true })).toBeVisible();
	await invite.getByRole('button', { name: 'Done' }).click();
	await expect(page.getByText(email, { exact: true }).filter({ visible: true })).toHaveCount(1);

	// Reload: the reservation remains represented by its retained roster row.
	await page.reload();
	await expect(page.getByText(email, { exact: true }).filter({ visible: true })).toHaveCount(1);

	await expectNoDocumentOverflow(page);
});

test('a reviewer without disclosed contact has no empty copy control', async ({ page }) => {
	await ensureEvent(page);

	const teamResponse = await page.request.get('/api/workspace/team');
	expect(teamResponse.ok()).toBe(true);
	const teamPayload = await teamResponse.json();
	expect(teamPayload.kind).toBe('success');
	const owner = teamPayload.data.members.find(
		(member: { kind: string }) => member.kind === 'member'
	);
	expect(owner).toBeTruthy();

	const rosterResponse = await page.request.get('/api/events/current/reviewer-roster');
	expect(rosterResponse.ok()).toBe(true);
	const rosterPayload = await rosterResponse.json();
	expect(rosterPayload.kind).toBe('success');

	const reviewerId = '00000000-0000-4000-8000-000000000091';
	const subject = {
		kind: 'workspace_membership',
		id: owner.id,
		version: owner.version
	};
	const reviewer = {
		reviewerId,
		recordVersion: 1,
		projectionVersion: 1,
		status: 'active',
		accessSubject: subject,
		authority: {
			schemaVersion: 1,
			scope: rosterPayload.data.scope,
			rosterSubject: subject,
			currentSubject: subject,
			state: 'active',
			version: 1,
			digestSha256: 'a'.repeat(64),
			capabilityIds: [
				'event.read',
				'speaker.directory.read',
				'submission.read',
				'submission.score',
				'submission.comment',
				'schedule.read'
			],
			evidenceIds: ['browser:no-contact-reviewer'],
			displayName: 'Avery Stone'
		},
		displayName: 'Avery Stone',
		reviews: []
	};

	await page.route('**/api/events/current/reviewer-roster', (route) => route.fulfill({
		json: {
			...rosterPayload,
			data: { ...rosterPayload.data, reviewers: [reviewer] }
		}
	}));
	// The roster identity remains visible, but the organizer Team projection
	// deliberately has no matching subject and therefore discloses no address.
	await page.route('**/api/workspace/team', (route) => route.fulfill({
		json: {
			...teamPayload,
			data: {
				...teamPayload.data,
				members: teamPayload.data.members.filter(
					(member: { id: string }) => member.id !== owner.id
				)
			}
		}
	}));

	await page.goto('/app/reviewers');
	await expect(page.getByText('Avery Stone', { exact: true }).filter({ visible: true })).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Copy email address' })).toHaveCount(0);
	await expectNoDocumentOverflow(page);
});
