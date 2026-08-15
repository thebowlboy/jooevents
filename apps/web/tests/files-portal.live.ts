import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * The speaker upload loop, live composition, mocked at the HTTP boundary: the
 * portal boots against a served manifest whose schema digests are recomputed
 * from the real contracts (via `scripts/emit-files-manifest-fixture.ts`), so
 * the browser exercises binding resolution, the two-phase upload with inline
 * hashing, request fulfilment, link-attach, and the reviewed failure copy
 * exactly as production wires them.
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

const FILE_TEXT = 'PDF bytes for the final deck';
const FILE_SHA = createHash('sha256').update(FILE_TEXT).digest('hex');

const participantContext = {
	state: 'active',
	participant: { id: id(20), displayName: 'Nadia Okafor', email: 'nadia@example.com' },
	event: {
		id: id(2),
		name: 'Autumn Summit 2026',
		timezone: 'Europe/Helsinki',
		cfpClosesAt: '2026-09-20T23:59:00.000Z',
		closePolicy: 'soft'
	}
};

const snapshot = {
	schemaVersion: 1,
	participant: participantContext.participant,
	event: participantContext.event,
	submissions: [],
	engagements: [{
		id: engagementId,
		sessionId: id(11),
		sessionTitle: 'Streaming at the edge',
		submissionId: null,
		status: 'invited',
		invitedAt: AT,
		respondBy: null,
		confirmation: null,
		speakers: [{ participantId: id(20), displayName: 'Nadia Okafor' }]
	}],
	tasks: [],
	files: [],
	resources: [],
	profile: { fields: [] }
};

interface ServerState {
	openRequest: boolean;
	attachments: unknown[];
}

function requestDto(state: ServerState) {
	return {
		schemaVersion: 1,
		id: id(400),
		scope,
		engagementId,
		what: 'Your final slide deck',
		instructions: 'Export as PDF if you can.',
		deadlineId: id(500),
		state: state.openRequest ? 'open' : 'fulfilled',
		fulfillingAttachmentId: state.openRequest ? null : id(901),
		createdByUserId: id(21),
		version: 2,
		createdAt: AT,
		updatedAt: AT
	};
}

function resourceAttachment() {
	return {
		attachment: {
			schemaVersion: 1,
			id: id(700),
			scope,
			subject: { kind: 'resource_share', resourceShareId: id(300) },
			content: { kind: 'asset', assetId: id(701) },
			attachedBy: { kind: 'operator_user', userId: id(21) },
			state: 'attached',
			version: 1,
			attachedAt: AT,
			detachedAt: null
		},
		asset: {
			schemaVersion: 1,
			id: id(701),
			scope,
			uploader: { kind: 'operator_user', userId: id(21) },
			purpose: 'resource_share_material',
			displayFilename: 'Slide template.pdf',
			contentType: 'application/pdf',
			byteSize: 842_000,
			sha256: 'b'.repeat(64),
			storageProvider: 'filesystem',
			storageKey: 'blobs/template',
			lifecycle: 'available',
			scan: { provider: 'none', verdict: 'released', checkedAt: null },
			version: 1,
			createdAt: AT,
			updatedAt: AT
		}
	};
}

function json(body: unknown): { status: number; contentType: string; body: string } {
	return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

function receipt(operationName: string) {
	return { id: correlationId, operationName, operationVersion: 1 };
}

function refusal(action: string, code: string) {
	return {
		kind: 'outcome',
		outcome: {
			class: 'policy_violation',
			kind: 'file.command_refused',
			retryable: false,
			subjects: [],
			detail: { action, code },
			detailSchemaVersion: 1
		},
		terminal: false,
		correlationId
	};
}

async function bootPortal(page: Page, state: ServerState): Promise<void> {
	await page.route('**/api/me/participant-context', (route) =>
		route.fulfill(json(participantContext)));
	await page.route('**/api/operations/manifest', (route) => route.fulfill(json(manifest)));
	await page.route('**/api/portal/snapshot', (route) =>
		route.fulfill(json({ kind: 'success', data: snapshot, correlationId })));
	await page.route('**/api/portal/engagements/files*', (route) =>
		route.fulfill(json({
			kind: 'success',
			data: {
				schemaVersion: 1,
				engagementId,
				attachments: [resourceAttachment(), ...state.attachments],
				requests: [requestDto(state)]
			},
			correlationId
		})));
}

/** The happy loop's command mocks: intent → bytes → confirm → attach → fulfill. */
async function mockUploadCommands(page: Page, state: ServerState, log: {
	intents: unknown[]; confirms: unknown[]; attaches: unknown[]; fulfills: unknown[];
}): Promise<void> {
	await page.route('**/api/portal/files/uploads/intent', async (route) => {
		const body = route.request().postDataJSON() as {
			intentId: string; displayFilename: string; contentType: string; declaredByteSize: number;
			purpose: string;
		};
		log.intents.push(body);
		await route.fulfill(json({
			kind: 'success',
			data: {
				action: 'upload.intent',
				intent: {
					schemaVersion: 1,
					id: body.intentId,
					scope,
					uploader: { kind: 'participant', participantIdentityId: id(20) },
					purpose: body.purpose,
					displayFilename: body.displayFilename,
					contentType: body.contentType,
					declaredByteSize: body.declaredByteSize,
					maximumByteSize: 100_000_000,
					storageProvider: 'filesystem',
					storageKey: `blobs/${body.intentId}`,
					state: 'pending',
					storedByteSize: null,
					storedSha256: null,
					createdAt: AT,
					expiresAt: '2026-08-14T10:00:00.000Z'
				},
				idempotent: false
			},
			receipt: receipt('file.upload.intent'),
			correlationId
		}));
	});
	await page.route('**/api/portal/files/uploads/*/bytes', (route) =>
		route.fulfill(json({ stored: true })));
	await page.route('**/api/portal/files/uploads/confirm', async (route) => {
		const body = route.request().postDataJSON() as { assetId: string; sha256: string };
		log.confirms.push(body);
		await route.fulfill(json({
			kind: 'success',
			data: {
				action: 'upload.confirm',
				asset: {
					schemaVersion: 1,
					id: body.assetId,
					scope,
					uploader: { kind: 'participant', participantIdentityId: id(20) },
					purpose: 'request_fulfillment',
					displayFilename: 'Final deck.pdf',
					contentType: 'application/pdf',
					byteSize: FILE_TEXT.length,
					sha256: body.sha256,
					storageProvider: 'filesystem',
					storageKey: `blobs/${body.assetId}`,
					lifecycle: 'available',
					scan: { provider: 'none', verdict: 'released', checkedAt: null },
					version: 1,
					createdAt: AT,
					updatedAt: AT
				},
				idempotent: false
			},
			receipt: receipt('file.upload.confirm'),
			correlationId
		}));
	});
	await page.route('**/api/portal/files/attachments/attach', async (route) => {
		const body = route.request().postDataJSON() as {
			attachmentId: string; assetId: string; subject: unknown;
		};
		log.attaches.push(body);
		state.attachments.push({
			attachment: {
				schemaVersion: 1,
				id: body.attachmentId,
				scope,
				subject: { kind: 'engagement', engagementId },
				content: { kind: 'asset', assetId: body.assetId },
				attachedBy: { kind: 'participant', participantIdentityId: id(20) },
				state: 'attached',
				version: 1,
				attachedAt: '2026-08-14T09:30:00.000Z',
				detachedAt: null
			},
			asset: {
				schemaVersion: 1,
				id: body.assetId,
				scope,
				uploader: { kind: 'participant', participantIdentityId: id(20) },
				purpose: 'request_fulfillment',
				displayFilename: 'Final deck.pdf',
				contentType: 'application/pdf',
				byteSize: FILE_TEXT.length,
				sha256: FILE_SHA,
				storageProvider: 'filesystem',
				storageKey: `blobs/${body.assetId}`,
				lifecycle: 'available',
				scan: { provider: 'none', verdict: 'released', checkedAt: null },
				version: 1,
				createdAt: AT,
				updatedAt: AT
			}
		});
		await route.fulfill(json({
			kind: 'success',
			data: {
				action: 'attachment.attach',
				attachment: {
					schemaVersion: 1,
					id: body.attachmentId,
					scope,
					subject: { kind: 'engagement', engagementId },
					content: { kind: 'asset', assetId: body.assetId },
					attachedBy: { kind: 'participant', participantIdentityId: id(20) },
					state: 'attached',
					version: 1,
					attachedAt: '2026-08-14T09:30:00.000Z',
					detachedAt: null
				},
				idempotent: false
			},
			receipt: receipt('file.attachment.attach'),
			correlationId
		}));
	});
	await page.route('**/api/portal/files/requests/fulfill', async (route) => {
		const body = route.request().postDataJSON() as {
			requestId: string; attachmentId: string; expectedVersion: number;
		};
		log.fulfills.push(body);
		state.openRequest = false;
		await route.fulfill(json({
			kind: 'success',
			data: {
				action: 'request.fulfill',
				request: {
					...requestDto(state),
					state: 'fulfilled',
					fulfillingAttachmentId: body.attachmentId,
					version: 3
				}
			},
			receipt: receipt('file.request.fulfill'),
			correlationId
		}));
	});
}

test('a speaker uploads a deck against the ask: intent, bytes, hash, attach, fulfil', async ({ page }) => {
	const state: ServerState = { openRequest: true, attachments: [] };
	const log = { intents: [], confirms: [], attaches: [], fulfills: [] } as {
		intents: unknown[]; confirms: unknown[]; attaches: unknown[]; fulfills: unknown[];
	};
	await bootPortal(page, state);
	await mockUploadCommands(page, state, log);

	await page.goto('/portal');
	const materials = page.locator('.materials');
	await expect(materials.getByText('Your final slide deck')).toBeVisible();
	await expect(materials.getByText('Export as PDF if you can.')).toBeVisible();
	// The organizer-shared resource, with honest provenance and no safety badge.
	await expect(materials.getByText('Slide template.pdf')).toBeVisible();

	const chooserPromise = page.waitForEvent('filechooser');
	await materials.getByRole('button', { name: 'Upload a file' }).click();
	const chooser = await chooserPromise;
	await chooser.setFiles({
		name: 'Final deck.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from(FILE_TEXT)
	});

	await expect(materials.getByText('Uploaded “Final deck.pdf”.')).toBeVisible();
	// The refreshed list carries the file with its size and scan honesty.
	await expect(materials.getByText('Final deck.pdf', { exact: true })).toBeVisible();
	await expect(materials.getByText(/not virus-scanned/)).toBeVisible();
	// The settled ask leaves the open list.
	await expect(materials.getByText('Your final slide deck')).toHaveCount(0);

	// The wire carried the loop in order, with the client's own hash.
	expect(log.intents).toHaveLength(1);
	expect(log.intents[0]).toMatchObject({
		purpose: 'request_fulfillment',
		contentType: 'application/pdf',
		declaredByteSize: FILE_TEXT.length
	});
	expect(log.confirms).toHaveLength(1);
	expect((log.confirms[0] as { sha256: string }).sha256).toBe(FILE_SHA);
	expect(log.attaches[0]).toMatchObject({
		subject: { kind: 'engagement', engagementId }
	});
	expect(log.fulfills[0]).toMatchObject({ requestId: id(400), expectedVersion: 2 });

	// The download link points at the lane's inert download route.
	const assetId = (log.confirms[0] as { assetId: string }).assetId;
	await expect(
		materials.locator(`a[href="/api/portal/files/assets/${assetId}/download"]`)
	).toHaveText('Download');
});

test('refusals speak reviewed sentences, and an interrupted upload retries', async ({ page }) => {
	const state: ServerState = { openRequest: true, attachments: [] };
	await bootPortal(page, state);

	// First: the server refuses the size at registration.
	let intentMode: 'too_large' | 'admit' = 'too_large';
	let byteMode: 'fail' | 'ok' = 'fail';
	const confirms: unknown[] = [];
	await page.route('**/api/portal/files/uploads/intent', async (route) => {
		const body = route.request().postDataJSON() as { intentId: string };
		if (intentMode === 'too_large') {
			await route.fulfill(json(refusal('upload.intent', 'file_too_large')));
			return;
		}
		await route.fulfill(json({
			kind: 'success',
			data: {
				action: 'upload.intent',
				intent: {
					schemaVersion: 1,
					id: body.intentId,
					scope,
					uploader: { kind: 'participant', participantIdentityId: id(20) },
					purpose: 'request_fulfillment',
					displayFilename: 'Final deck.pdf',
					contentType: 'application/pdf',
					declaredByteSize: FILE_TEXT.length,
					maximumByteSize: 100_000_000,
					storageProvider: 'filesystem',
					storageKey: `blobs/${body.intentId}`,
					state: 'pending',
					storedByteSize: null,
					storedSha256: null,
					createdAt: AT,
					expiresAt: '2026-08-14T10:00:00.000Z'
				},
				idempotent: false
			},
			receipt: receipt('file.upload.intent'),
			correlationId
		}));
	});
	await page.route('**/api/portal/files/uploads/*/bytes', (route) =>
		byteMode === 'fail'
			? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
			: route.fulfill(json({ stored: true })));
	await page.route('**/api/portal/files/uploads/confirm', async (route) => {
		const body = route.request().postDataJSON() as { assetId: string; sha256: string };
		confirms.push(body);
		await route.fulfill(json(refusal('upload.confirm', 'hash_mismatch')));
	});

	await page.goto('/portal');
	const materials = page.locator('.materials');
	const upload = materials.getByRole('button', { name: 'Upload a file' });

	// Refused size: one reviewed sentence, no internals, no retry offer.
	const first = page.waitForEvent('filechooser');
	await upload.click();
	await (await first).setFiles({
		name: 'Final deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from(FILE_TEXT)
	});
	await expect(materials.getByText(/larger than this event accepts/)).toBeVisible();
	await expect(page.getByText(/file_too_large|policy_violation|refused/)).toHaveCount(0);
	await expect(materials.getByRole('button', { name: 'Try again' })).toHaveCount(0);

	// Interrupted bytes: the failure names itself and keeps the file for retry.
	intentMode = 'admit';
	const second = page.waitForEvent('filechooser');
	await upload.click();
	await (await second).setFiles({
		name: 'Final deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from(FILE_TEXT)
	});
	await expect(materials.getByText('The upload didn’t finish. Check your connection and try again.'))
		.toBeVisible();

	// Retry re-runs the loop with the same file — no re-picking.
	byteMode = 'ok';
	await materials.getByRole('button', { name: 'Try again' }).click();
	await expect(materials.getByText('The file changed while it was uploading. Try again.'))
		.toBeVisible();
	expect(confirms).toHaveLength(1);
	expect((confirms[0] as { sha256: string }).sha256).toBe(FILE_SHA);
});

test('link-attach posts the typed https link and reminds about access', async ({ page }) => {
	const state: ServerState = { openRequest: false, attachments: [] };
	await bootPortal(page, state);
	const links: unknown[] = [];
	await page.route('**/api/portal/files/attachments/link', async (route) => {
		const body = route.request().postDataJSON() as {
			attachmentId: string; link: { provider: string; label: string; url: string };
		};
		links.push(body);
		state.attachments.push({
			attachment: {
				schemaVersion: 1,
				id: body.attachmentId,
				scope,
				subject: { kind: 'engagement', engagementId },
				content: { kind: 'link', link: body.link },
				attachedBy: { kind: 'participant', participantIdentityId: id(20) },
				state: 'attached',
				version: 1,
				attachedAt: '2026-08-14T09:30:00.000Z',
				detachedAt: null
			},
			asset: null
		});
		await route.fulfill(json({
			kind: 'success',
			data: {
				action: 'attachment.link',
				attachment: {
					schemaVersion: 1,
					id: body.attachmentId,
					scope,
					subject: { kind: 'engagement', engagementId },
					content: { kind: 'link', link: body.link },
					attachedBy: { kind: 'participant', participantIdentityId: id(20) },
					state: 'attached',
					version: 1,
					attachedAt: '2026-08-14T09:30:00.000Z',
					detachedAt: null
				},
				idempotent: false
			},
			receipt: receipt('file.attachment.link'),
			correlationId
		}));
	});

	await page.goto('/portal');
	const materials = page.locator('.materials');
	await materials.getByRole('button', { name: 'Add a link instead' }).click();
	// The D6 reminder is stated before the attempt, not after it.
	await expect(materials.getByText(/Make sure the organizers can open it/)).toBeVisible();

	// A non-https link is refused in place before anything is sent.
	await materials.getByLabel('What it is').fill('Demo video (Drive)');
	await materials.getByLabel('Link', { exact: true }).fill('http://example.com/demo');
	await materials.getByRole('button', { name: 'Add link' }).click();
	await expect(materials.getByText('The link must start with https://')).toBeVisible();
	expect(links).toHaveLength(0);

	await materials.getByLabel('Link', { exact: true }).fill('https://drive.google.com/file/d/demo');
	await materials.getByRole('button', { name: 'Add link' }).click();
	await expect(materials.getByText('Added “Demo video (Drive)”.')).toBeVisible();
	expect(links[0]).toMatchObject({
		link: {
			provider: 'drive',
			label: 'Demo video (Drive)',
			url: 'https://drive.google.com/file/d/demo'
		}
	});
	// The refreshed list shows the link under the speaker's own files.
	await expect(materials.getByRole('link', { name: 'Open' })).toHaveAttribute(
		'href',
		'https://drive.google.com/file/d/demo'
	);

	// The document never scrolls sideways, on either viewport.
	expect(await page.evaluate(() =>
		document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
