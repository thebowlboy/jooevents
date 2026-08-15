import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * The organizer share + request loop, live composition, mocked at the HTTP
 * boundary: the Files surface boots against a served manifest with real
 * digests, reads the joined overview + deadline catalog, creates a typed ask
 * riding an existing catalog deadline, shares a resource with a link, and
 * withdraws with an in-place arm — receipts and reviewed refusals included.
 */

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(
	execSync('bun scripts/emit-files-manifest-fixture.ts', { cwd: webRoot }).toString()
) as { operations: unknown[] };

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const AT = '2026-08-14T09:00:00.000Z';
const scope = { workspaceId: id(1), eventId: id(2) };
const engagementId = id(10);
const correlationId = '018f6f00-0000-7000-8000-0000000000cc';

const access = {
	state: 'active',
	user: { id: 'user_ada', displayName: 'Ada Lovelace' },
	workspace: { id: 'workspace_summit', name: 'Summit Operations' }
};

const catalog = {
	schemaVersion: 1,
	scope,
	version: 3,
	digestSha256: 'b'.repeat(64),
	deadlines: [{
		schemaVersion: 1,
		id: id(500),
		scope,
		kind: 'cfp_close',
		version: 2,
		digestSha256: 'c'.repeat(64),
		gracePolicy: 'soft',
		createdByUserId: id(21),
		createdAt: AT,
		updatedByUserId: id(21),
		updatedAt: AT,
		status: 'active',
		displayDate: '2026-09-01',
		effectiveAt: '2026-09-02T00:00:00.000Z',
		boundary: {
			profile: {
				key: 'deadline.calendar-date.event-local-end-exclusive',
				version: 1,
				digestSha256: 'd'.repeat(64)
			},
			eventTimezone: 'Europe/Helsinki',
			eventVersion: 1,
			localBoundaryDate: '2026-09-01'
		}
	}]
};

interface ServerState {
	requests: Record<string, unknown>[];
	shares: Record<string, unknown>[];
	attachments: Record<string, unknown>[];
}

function seededState(): ServerState {
	return {
		requests: [],
		shares: [],
		attachments: [{
			attachment: {
				schemaVersion: 1,
				id: id(200),
				scope,
				subject: { kind: 'engagement', engagementId },
				content: { kind: 'asset', assetId: id(100) },
				attachedBy: { kind: 'participant', participantIdentityId: id(20) },
				state: 'attached',
				version: 1,
				attachedAt: AT,
				detachedAt: null
			},
			asset: {
				schemaVersion: 1,
				id: id(100),
				scope,
				uploader: { kind: 'participant', participantIdentityId: id(20) },
				purpose: 'engagement_material',
				displayFilename: 'Edge networking deck.pdf',
				contentType: 'application/pdf',
				byteSize: 4_200_000,
				sha256: 'a'.repeat(64),
				storageProvider: 'filesystem',
				storageKey: 'blobs/deck',
				lifecycle: 'available',
				scan: { provider: 'none', verdict: 'released', checkedAt: null },
				version: 1,
				createdAt: AT,
				updatedAt: AT
			}
		}]
	};
}

function json(body: unknown): { status: number; contentType: string; body: string } {
	return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

function receipt(operationName: string) {
	return { id: correlationId, operationName, operationVersion: 1 };
}

async function bootFiles(page: Page, state: ServerState): Promise<void> {
	await page.route('**/api/me/access-context', (route) => route.fulfill(json(access)));
	await page.route('**/api/operations/manifest', (route) => route.fulfill(json(manifest)));
	await page.route('**/api/events/current/deadlines', (route) =>
		route.fulfill(json({ kind: 'success', data: catalog, correlationId })));
	await page.route('**/api/events/current/files', (route) =>
		route.fulfill(json({
			kind: 'success',
			data: {
				schemaVersion: 1,
				scope,
				attachments: state.attachments,
				shares: state.shares,
				requests: state.requests
			},
			correlationId
		})));
}

test('the ask loop: create against a catalog deadline, see it land, withdraw it', async ({ page }) => {
	const state = seededState();
	const created: unknown[] = [];
	const withdrawn: unknown[] = [];
	await bootFiles(page, state);
	await page.route('**/api/events/current/files/requests/create', async (route) => {
		const body = route.request().postDataJSON() as {
			requestId: string; engagementId: string; what: string;
			instructions: string | null; deadlineId: string | null;
		};
		created.push(body);
		const request = {
			schemaVersion: 1,
			id: body.requestId,
			scope,
			engagementId: body.engagementId,
			what: body.what,
			instructions: body.instructions,
			deadlineId: body.deadlineId,
			state: 'open',
			fulfillingAttachmentId: null,
			createdByUserId: id(21),
			version: 1,
			createdAt: AT,
			updatedAt: AT
		};
		state.requests.push(request);
		await route.fulfill(json({
			kind: 'success',
			data: {
				action: 'request.create',
				request,
				deadline: body.deadlineId === null ? null : {
					id: id(500), version: 2, digestSha256: 'c'.repeat(64),
					effectiveAt: '2026-09-02T00:00:00.000Z', displayDate: '2026-09-01',
					gracePolicy: 'soft'
				},
				idempotent: false
			},
			receipt: receipt('file.request.create'),
			correlationId
		}));
	});
	await page.route('**/api/events/current/files/requests/withdraw', async (route) => {
		const body = route.request().postDataJSON() as { requestId: string; expectedVersion: number };
		withdrawn.push(body);
		const request = state.requests.find((entry) => entry.id === body.requestId);
		if (request) {
			request.state = 'withdrawn';
			request.version = 2;
		}
		await route.fulfill(json({
			kind: 'success',
			data: { action: 'request.withdraw', request: { ...request, state: 'withdrawn', version: 2 } },
			receipt: receipt('file.request.withdraw'),
			correlationId
		}));
	});

	await page.goto('/app/files');
	await expect(page.getByRole('heading', { name: 'Requested files' })).toBeVisible();
	// The received deck is already there, grouped under its engagement.
	await expect(page.getByText('1 file', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Ask for a file' }).click();
	await page.getByLabel(/From/).selectOption({ index: 1 });
	await page.getByLabel(/What/).fill('Your final slide deck');
	await page.getByLabel(/By when/).selectOption({ label: '2026-09-01 · proposals close' });
	await page.getByLabel(/Instructions/).fill('Export as PDF if you can.');
	await page.getByRole('button', { name: 'Send the ask' }).click();

	// The commit leaves a receipt and the list shows the ask with its date.
	await expect(page.getByText('Asked for “Your final slide deck”')).toBeVisible();
	const askRow = page.locator('.request', { hasText: 'Your final slide deck' });
	await expect(askRow.getByText('Open')).toBeVisible();
	await expect(askRow.getByText('by 2026-09-01')).toBeVisible();
	expect(created[0]).toMatchObject({
		engagementId,
		what: 'Your final slide deck',
		instructions: 'Export as PDF if you can.',
		deadlineId: id(500)
	});

	// Withdraw arms in place before it acts — one press never destroys.
	await askRow.getByRole('button', { name: 'Withdraw', exact: true }).click();
	expect(withdrawn).toHaveLength(0);
	await askRow.getByRole('button', { name: 'Withdraw?' }).click();
	await expect(page.getByText('Withdrew the ask for “Your final slide deck”')).toBeVisible();
	expect(withdrawn[0]).toMatchObject({ expectedVersion: 1 });
	await expect(page.locator('.request', { hasText: 'Your final slide deck' }).getByText('Withdrawn'))
		.toBeVisible();
});

test('the share loop: create for all confirmed, attach a link, see the audience named', async ({ page }) => {
	const state = seededState();
	const sharesCreated: unknown[] = [];
	const linksAttached: unknown[] = [];
	await bootFiles(page, state);
	await page.route('**/api/events/current/files/shares/create', async (route) => {
		const body = route.request().postDataJSON() as {
			resourceShareId: string; title: string; audience: { kind: string };
		};
		sharesCreated.push(body);
		const share = {
			schemaVersion: 1,
			id: body.resourceShareId,
			scope,
			title: body.title,
			audience: body.audience,
			createdByUserId: id(21),
			state: 'active',
			version: 1,
			createdAt: AT,
			revokedAt: null
		};
		state.shares.push(share);
		await route.fulfill(json({
			kind: 'success',
			data: { action: 'share.create', share, idempotent: false },
			receipt: receipt('file.share.create'),
			correlationId
		}));
	});
	await page.route('**/api/events/current/files/attachments/link', async (route) => {
		const body = route.request().postDataJSON() as {
			attachmentId: string;
			subject: { kind: string; resourceShareId: string };
			link: { provider: string; label: string; url: string };
		};
		linksAttached.push(body);
		const attachment = {
			schemaVersion: 1,
			id: body.attachmentId,
			scope,
			subject: body.subject,
			content: { kind: 'link', link: body.link },
			attachedBy: { kind: 'operator_user', userId: id(21) },
			state: 'attached',
			version: 1,
			attachedAt: '2026-08-14T09:30:00.000Z',
			detachedAt: null
		};
		state.attachments.push({ attachment, asset: null });
		await route.fulfill(json({
			kind: 'success',
			data: { action: 'attachment.link', attachment, idempotent: false },
			receipt: receipt('file.attachment.link'),
			correlationId
		}));
	});

	await page.goto('/app/files');
	await page.getByRole('button', { name: 'Share a resource' }).click();
	await page.getByLabel(/Name/).fill('Speaker kit');
	await page.getByLabel(/Who sees it/).selectOption('all_confirmed');
	await page.getByRole('button', { name: 'Share it' }).click();

	await expect(page.getByText('Shared “Speaker kit”')).toBeVisible();
	const shareRow = page.locator('.share', { hasText: 'Speaker kit' });
	await expect(shareRow.getByText('All confirmed speakers')).toBeVisible();
	await expect(shareRow.getByText('Nothing attached yet.')).toBeVisible();
	expect(sharesCreated[0]).toMatchObject({
		title: 'Speaker kit',
		audience: { kind: 'all_confirmed' }
	});

	await shareRow.getByRole('button', { name: 'Attach link' }).click();
	await shareRow.getByLabel('What it is').fill('AV guide (Drive)');
	await shareRow.getByLabel('Link', { exact: true }).fill('https://drive.google.com/file/d/av');
	await shareRow.getByRole('button', { name: 'Add link' }).click();

	await expect(page.getByText('Attached “AV guide (Drive)”')).toBeVisible();
	await expect(shareRow.getByText('AV guide (Drive)')).toBeVisible();
	expect(linksAttached[0]).toMatchObject({
		subject: { kind: 'resource_share' },
		link: {
			provider: 'drive',
			label: 'AV guide (Drive)',
			url: 'https://drive.google.com/file/d/av'
		}
	});

	// Received drill-in: the engagement group expands to the deck with scan honesty.
	await page.getByRole('button', { name: /1 file/ }).click();
	await expect(page.getByText('Edge networking deck.pdf')).toBeVisible();
	await expect(page.getByText(/4\.2 MB · not virus-scanned/)).toBeVisible();
	await expect(page.locator(`a[href="/api/events/current/files/assets/${id(100)}/download"]`))
		.toHaveText('Download');

	// The document never scrolls sideways, on either viewport.
	expect(await page.evaluate(() =>
		document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
