import { describe, expect, test } from 'bun:test';
import type {
	FileAssetDto,
	FileAttachmentDto,
	FileRequestDto,
	FileUploadIntentDto,
	PortalEngagementFilesDto
} from '@jooevents/contracts/files';
import type { FilesLiveRequestInput } from './live-shared';
import { filesLiveManifestFixture } from './manifest-fixture';
import { createLivePortalFilesPort } from './portal-files-port.live';
import type { UploadByteResult, UploadByteTransfer } from './upload-transfer';
import { sha256HexOfBlob } from './upload-transfer';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const AT = '2026-08-14T09:00:00.000Z';
const scope = { workspaceId: id(1), eventId: id(2) };
const engagementId = id(10);
const correlationId = '018f6f00-0000-7000-8000-0000000000cc';

const manifest = filesLiveManifestFixture();
const loadManifest = async () => ({ kind: 'success' as const, manifest });

function receipt(operationName: string) {
	return { id: correlationId, operationName, operationVersion: 1 };
}

function intentDto(intentId: string, byteSize: number): FileUploadIntentDto {
	return {
		schemaVersion: 1,
		id: intentId,
		scope,
		uploader: { kind: 'participant', participantIdentityId: id(20) },
		purpose: 'request_fulfillment',
		displayFilename: 'deck.pdf',
		contentType: 'application/pdf',
		declaredByteSize: byteSize,
		maximumByteSize: 100_000_000,
		storageProvider: 'filesystem',
		storageKey: `blobs/${intentId}`,
		state: 'pending',
		storedByteSize: null,
		storedSha256: null,
		createdAt: AT,
		expiresAt: '2026-08-14T10:00:00.000Z'
	};
}

function assetDto(assetId: string, sha256: string, byteSize: number): FileAssetDto {
	return {
		schemaVersion: 1,
		id: assetId,
		scope,
		uploader: { kind: 'participant', participantIdentityId: id(20) },
		purpose: 'request_fulfillment',
		displayFilename: 'deck.pdf',
		contentType: 'application/pdf',
		byteSize,
		sha256,
		storageProvider: 'filesystem',
		storageKey: `blobs/${assetId}`,
		lifecycle: 'available',
		scan: { provider: 'none', verdict: 'released', checkedAt: null },
		version: 1,
		createdAt: AT,
		updatedAt: AT
	};
}

function attachmentDto(attachmentId: string, assetId: string): FileAttachmentDto {
	return {
		schemaVersion: 1,
		id: attachmentId,
		scope,
		subject: { kind: 'engagement', engagementId },
		content: { kind: 'asset', assetId },
		attachedBy: { kind: 'participant', participantIdentityId: id(20) },
		state: 'attached',
		version: 1,
		attachedAt: AT,
		detachedAt: null
	};
}

function requestDto(state: 'open' | 'fulfilled', fulfillingAttachmentId: string | null): FileRequestDto {
	return {
		schemaVersion: 1,
		id: id(400),
		scope,
		engagementId,
		what: 'Your final slide deck',
		instructions: null,
		deadlineId: null,
		state,
		fulfillingAttachmentId,
		createdByUserId: id(21),
		version: 2,
		createdAt: AT,
		updatedAt: AT
	};
}

const emptyFiles: PortalEngagementFilesDto = {
	schemaVersion: 1,
	engagementId,
	attachments: [],
	requests: [requestDto('open', null)]
};

interface Call {
	readonly path: string;
	readonly method: string;
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

function scriptedRequester(script: (call: Call) => unknown) {
	const calls: Call[] = [];
	return {
		calls,
		request: async (input: FilesLiveRequestInput) => {
			const call: Call = {
				path: input.path,
				method: input.method,
				...(input.body !== undefined ? { body: input.body } : {}),
				...(input.idempotencyKey !== undefined
					? { idempotencyKey: input.idempotencyKey }
					: {})
			};
			calls.push(call);
			const answer = script(call);
			if (answer instanceof Error) {
				return { kind: 'error' as const, error: { code: 'network_unavailable', retryable: true } };
			}
			return { kind: 'success' as const, data: answer };
		}
	};
}

function storedTransfer(
	sentPaths: string[],
	result: UploadByteResult = { kind: 'stored' }
): UploadByteTransfer {
	return {
		async send(input) {
			sentPaths.push(input.path);
			input.onProgress?.({ transferredBytes: input.blob.size, totalBytes: input.blob.size });
			return result;
		}
	};
}

const FILE_BYTES = new Blob([new TextEncoder().encode('PDF bytes')], {
	type: 'application/pdf'
});

function uploadFile() {
	return { name: 'Final deck.pdf', type: 'application/pdf', size: FILE_BYTES.size, blob: FILE_BYTES };
}

describe('createLivePortalFilesPort', () => {
	test('materials reads the manifest-resolved path with the subject query', async () => {
		const requester = scriptedRequester(() => ({
			kind: 'success',
			data: emptyFiles,
			correlationId
		}));
		const port = createLivePortalFilesPort({ loadManifest, request: requester.request });
		const view = await port.materials(engagementId);
		expect(requester.calls[0]?.path).toBe(
			`/api/portal/engagements/files?engagementId=${engagementId}`
		);
		expect(view.openRequests).toHaveLength(1);
		expect(view.yours).toHaveLength(0);
	});

	test('the whole upload loop runs intent → bytes → confirm → attach → fulfill', async () => {
		const minted: string[] = [];
		const newRecordId = () => {
			const value = id(9000 + minted.length);
			minted.push(value);
			return value;
		};
		const sentBytes: string[] = [];
		const expectedSha = await sha256HexOfBlob(FILE_BYTES);
		const requester = scriptedRequester((call) => {
			if (call.path.endsWith('/uploads/intent')) {
				const body = call.body as { intentId: string; declaredByteSize: number };
				return {
					kind: 'success',
					data: {
						action: 'upload.intent',
						intent: intentDto(body.intentId, body.declaredByteSize),
						idempotent: false
					},
					receipt: receipt('file.upload.intent'),
					correlationId
				};
			}
			if (call.path.endsWith('/uploads/confirm')) {
				const body = call.body as { assetId: string; sha256: string };
				expect(body.sha256).toBe(expectedSha);
				return {
					kind: 'success',
					data: {
						action: 'upload.confirm',
						asset: assetDto(body.assetId, body.sha256, FILE_BYTES.size),
						idempotent: false
					},
					receipt: receipt('file.upload.confirm'),
					correlationId
				};
			}
			if (call.path.endsWith('/attachments/attach')) {
				const body = call.body as { attachmentId: string; assetId: string };
				return {
					kind: 'success',
					data: {
						action: 'attachment.attach',
						attachment: attachmentDto(body.attachmentId, body.assetId),
						idempotent: false
					},
					receipt: receipt('file.attachment.attach'),
					correlationId
				};
			}
			if (call.path.endsWith('/requests/fulfill')) {
				const body = call.body as { attachmentId: string };
				return {
					kind: 'success',
					data: { action: 'request.fulfill', request: requestDto('fulfilled', body.attachmentId) },
					receipt: receipt('file.request.fulfill'),
					correlationId
				};
			}
			throw new Error(`unexpected call ${call.path}`);
		});
		const port = createLivePortalFilesPort({
			loadManifest,
			request: requester.request,
			transfer: storedTransfer(sentBytes),
			newRecordId
		});
		const outcome = await port.upload({
			engagementId,
			file: uploadFile(),
			request: { id: id(400), version: 2 }
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.data.requestFulfilled).toBe(true);
		// Bytes went to the intent's own byte route under the lane prefix.
		expect(sentBytes).toEqual([`/api/portal/files/uploads/${minted[0]}/bytes`]);
		// Every command carried its own idempotency key.
		const keys = requester.calls.map((call) => call.idempotencyKey);
		expect(new Set(keys).size).toBe(keys.length);
		// The fulfil step named the attachment the attach step created.
		const fulfil = requester.calls.find((call) => call.path.endsWith('/requests/fulfill'));
		expect((fulfil?.body as { attachmentId: string }).attachmentId).toBe(minted[2] ?? '');
	});

	test('a server refusal surfaces as its typed code, and nothing streams', async () => {
		const sentBytes: string[] = [];
		const requester = scriptedRequester((call) => {
			if (call.path.endsWith('/uploads/intent')) {
				return {
					kind: 'outcome',
					outcome: {
						class: 'policy_violation',
						kind: 'file.command_refused',
						retryable: false,
						subjects: [],
						detail: { action: 'upload.intent', code: 'file_too_large' },
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				};
			}
			throw new Error(`unexpected call ${call.path}`);
		});
		const port = createLivePortalFilesPort({
			loadManifest,
			request: requester.request,
			transfer: storedTransfer(sentBytes)
		});
		const outcome = await port.upload({ engagementId, file: uploadFile() });
		expect(outcome).toEqual({ ok: false, reason: 'file_too_large' });
		expect(sentBytes).toHaveLength(0);
	});

	test('the type gate refuses before any request leaves', async () => {
		const requester = scriptedRequester(() => {
			throw new Error('nothing may be sent');
		});
		const port = createLivePortalFilesPort({ loadManifest, request: requester.request });
		const video = await port.upload({
			engagementId,
			file: { name: 'demo.mp4', type: 'video/mp4', size: 10, blob: FILE_BYTES }
		});
		expect(video).toEqual({ ok: false, reason: 'video_refused_use_link' });
		const html = await port.upload({
			engagementId,
			file: { name: 'page.html', type: 'text/html', size: 10, blob: FILE_BYTES }
		});
		expect(html).toEqual({ ok: false, reason: 'content_type_refused' });
		expect(requester.calls).toHaveLength(0);
	});

	test('a failed byte stream answers upload_interrupted and never confirms', async () => {
		const requester = scriptedRequester((call) => {
			if (call.path.endsWith('/uploads/intent')) {
				const body = call.body as { intentId: string; declaredByteSize: number };
				return {
					kind: 'success',
					data: {
						action: 'upload.intent',
						intent: intentDto(body.intentId, body.declaredByteSize),
						idempotent: false
					},
					receipt: receipt('file.upload.intent'),
					correlationId
				};
			}
			throw new Error(`unexpected call ${call.path}`);
		});
		const sent: string[] = [];
		const port = createLivePortalFilesPort({
			loadManifest,
			request: requester.request,
			transfer: storedTransfer(sent, { kind: 'failed', retryable: true })
		});
		const outcome = await port.upload({ engagementId, file: uploadFile() });
		expect(outcome).toEqual({ ok: false, reason: 'upload_interrupted' });
		expect(requester.calls.some((call) => call.path.endsWith('/uploads/confirm'))).toBe(false);
	});

	test('link-attach posts the typed link and reports an unfulfilled ask honestly', async () => {
		const requester = scriptedRequester((call) => {
			if (call.path.endsWith('/attachments/link')) {
				const body = call.body as { attachmentId: string };
				return {
					kind: 'success',
					data: {
						action: 'attachment.link',
						attachment: {
							...attachmentDto(body.attachmentId, id(999)),
							content: {
								kind: 'link',
								link: { provider: 'drive', label: 'Demo video', url: 'https://example.com/v' }
							}
						},
						idempotent: false
					},
					receipt: receipt('file.attachment.link'),
					correlationId
				};
			}
			if (call.path.endsWith('/requests/fulfill')) {
				return {
					kind: 'outcome',
					outcome: {
						class: 'policy_violation',
						kind: 'file.command_refused',
						retryable: false,
						subjects: [],
						detail: { action: 'request.fulfill', code: 'stale_request' },
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				};
			}
			throw new Error(`unexpected call ${call.path}`);
		});
		const port = createLivePortalFilesPort({ loadManifest, request: requester.request });
		const outcome = await port.attachLink({
			engagementId,
			provider: 'drive',
			label: 'Demo video',
			url: 'https://example.com/v',
			request: { id: id(400), version: 2 }
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.data.assetId).toBeNull();
			expect(outcome.data.requestFulfilled).toBe(false);
		}
		const link = requester.calls.find((call) => call.path.endsWith('/attachments/link'));
		expect((link?.body as { link: { provider: string } }).link.provider).toBe('drive');
	});

	test('an access denial reads as not_yours, never as success or a raw code', async () => {
		const requester = scriptedRequester((call) => {
			if (call.path.endsWith('/attachments/link')) {
				return {
					kind: 'outcome',
					outcome: {
						class: 'access_denied',
						kind: 'file.portal.not_related',
						retryable: false,
						subjects: [],
						detail: null,
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				};
			}
			throw new Error(`unexpected call ${call.path}`);
		});
		const port = createLivePortalFilesPort({ loadManifest, request: requester.request });
		const outcome = await port.attachLink({
			engagementId,
			provider: 'url',
			label: 'Notes',
			url: 'https://example.com/n'
		});
		expect(outcome).toEqual({ ok: false, reason: 'not_yours' });
	});

	test('an unserved manifest answers a typed absence, not a guessed path', async () => {
		const empty = { schemaVersion: 1, registryDigestSha256: 'a'.repeat(64), operations: [] };
		const requester = scriptedRequester(() => {
			throw new Error('nothing may be sent');
		});
		const port = createLivePortalFilesPort({
			loadManifest: async () => ({ kind: 'success' as const, manifest: empty }),
			request: requester.request
		});
		await expect(port.materials(engagementId)).rejects.toMatchObject({
			name: 'PortalFilesReadError',
			retryable: false
		});
		const outcome = await port.upload({ engagementId, file: uploadFile() });
		expect(outcome).toEqual({ ok: false, reason: 'not_served' });
	});
});
