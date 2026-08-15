import { describe, expect, test } from 'bun:test';
import type { OrganizerFileOverviewDto, ResourceShareDto } from '@jooevents/contracts/files';
import { createLiveFilesPagePort } from './files-page-port.live';
import type { FilesLiveRequestInput } from './live-shared';
import { filesLiveManifestFixture } from './manifest-fixture';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const AT = '2026-08-14T09:00:00.000Z';
const scope = { workspaceId: id(1), eventId: id(2) };
const engagementId = id(10);
const correlationId = '018f6f00-0000-7000-8000-0000000000cc';
const manifest = filesLiveManifestFixture();

const overview: OrganizerFileOverviewDto = {
	schemaVersion: 1,
	scope,
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
			displayFilename: 'deck.pdf',
			contentType: 'application/pdf',
			byteSize: 1000,
			sha256: 'a'.repeat(64),
			storageProvider: 'filesystem',
			storageKey: 'blobs/aa',
			lifecycle: 'available',
			scan: { provider: 'none', verdict: 'released', checkedAt: null },
			version: 1,
			createdAt: AT,
			updatedAt: AT
		}
	}],
	shares: [],
	requests: []
};

const shareDto: ResourceShareDto = {
	schemaVersion: 1,
	id: id(300),
	scope,
	title: 'Speaker kit',
	audience: { kind: 'all_confirmed' },
	createdByUserId: id(21),
	state: 'active',
	version: 1,
	createdAt: AT,
	revokedAt: null
};

interface Call {
	readonly path: string;
	readonly method: string;
	readonly body?: unknown;
}

function scripted(script: (call: Call) => unknown) {
	const calls: Call[] = [];
	return {
		calls,
		request: async (input: FilesLiveRequestInput) => {
			const call: Call = {
				path: input.path,
				method: input.method,
				...(input.body !== undefined ? { body: input.body } : {})
			};
			calls.push(call);
			return { kind: 'success' as const, data: script(call) };
		}
	};
}

const roster = {
	list: async () => [
		{ id: engagementId, name: 'Nadia Okafor', sessions: [{ title: 'Edge talk' }] }
	]
};

describe('createLiveFilesPagePort', () => {
	test('read joins the overview with roster labels; a failed catalog degrades dates', async () => {
		const requester = scripted((call) => {
			if (call.path === '/api/events/current/files') {
				return { kind: 'success', data: overview, correlationId };
			}
			if (call.path === '/api/events/current/deadlines') {
				return {
					kind: 'outcome',
					outcome: {
						class: 'conflict', kind: 'deadline.unavailable', retryable: true,
						subjects: [], detail: null, detailSchemaVersion: 1
					},
					correlationId
				};
			}
			throw new Error(`unexpected ${call.path}`);
		});
		const port = createLiveFilesPagePort({ manifest, roster, request: requester.request });
		const view = await port.read();
		expect(view.received[0]).toMatchObject({
			label: { speaker: 'Nadia Okafor', session: 'Edge talk' }
		});
		expect(view.deadlineChoices).toHaveLength(0);
		expect(view.engagementChoices).toEqual([
			{ engagementId, speaker: 'Nadia Okafor', session: 'Edge talk' }
		]);
	});

	test('a failed roster degrades labels, never the page', async () => {
		const requester = scripted((call) => {
			if (call.path === '/api/events/current/files') {
				return { kind: 'success', data: overview, correlationId };
			}
			return {
				kind: 'outcome',
				outcome: {
					class: 'conflict', kind: 'deadline.unavailable', retryable: true,
					subjects: [], detail: null, detailSchemaVersion: 1
				},
				correlationId
			};
		});
		const port = createLiveFilesPagePort({
			manifest,
			roster: { list: async () => { throw new Error('roster down'); } },
			request: requester.request
		});
		const view = await port.read();
		expect(view.received[0]?.label.session).toContain(engagementId.slice(0, 8));
	});

	test('createRequest posts the typed ask with a minted id and deadline reference', async () => {
		const requester = scripted((call) => {
			if (call.path === '/api/events/current/files/requests/create') {
				const body = call.body as { requestId: string; what: string; deadlineId: string };
				return {
					kind: 'success',
					data: {
						action: 'request.create',
						request: {
							schemaVersion: 1,
							id: body.requestId,
							scope,
							engagementId,
							what: body.what,
							instructions: null,
							deadlineId: body.deadlineId,
							state: 'open',
							fulfillingAttachmentId: null,
							createdByUserId: id(21),
							version: 1,
							createdAt: AT,
							updatedAt: AT
						},
						deadline: null,
						idempotent: false
					},
					receipt: { id: correlationId, operationName: 'file.request.create', operationVersion: 1 },
					correlationId
				};
			}
			throw new Error(`unexpected ${call.path}`);
		});
		const port = createLiveFilesPagePort({ manifest, roster, request: requester.request });
		const outcome = await port.createRequest({
			engagementId,
			what: 'Your final slide deck',
			instructions: null,
			deadlineId: id(500)
		});
		expect(outcome.ok).toBe(true);
		const body = requester.calls[0]?.body as { engagementId: string; deadlineId: string };
		expect(body.engagementId).toBe(engagementId);
		expect(body.deadlineId).toBe(id(500));
	});

	test('a stale detach surfaces its code; share create returns the server-echoed id', async () => {
		const requester = scripted((call) => {
			if (call.path === '/api/events/current/files/attachments/detach') {
				return {
					kind: 'outcome',
					outcome: {
						class: 'policy_violation',
						kind: 'file.command_refused',
						retryable: false,
						subjects: [],
						detail: { action: 'attachment.detach', code: 'stale_attachment' },
						detailSchemaVersion: 1
					},
					terminal: false,
					correlationId
				};
			}
			if (call.path === '/api/events/current/files/shares/create') {
				const body = call.body as { resourceShareId: string };
				return {
					kind: 'success',
					data: {
						action: 'share.create',
						share: { ...shareDto, id: body.resourceShareId },
						idempotent: false
					},
					receipt: { id: correlationId, operationName: 'file.share.create', operationVersion: 1 },
					correlationId
				};
			}
			throw new Error(`unexpected ${call.path}`);
		});
		const port = createLiveFilesPagePort({ manifest, roster, request: requester.request });
		const detached = await port.detach({ attachmentId: id(200), expectedVersion: 1 });
		expect(detached).toEqual({ ok: false, reason: 'stale_attachment' });
		const created = await port.createShare({
			title: 'Speaker kit',
			audience: { kind: 'all_confirmed' }
		});
		expect(created.ok).toBe(true);
		if (created.ok) expect(created.data.shareId).toMatch(/^[0-9a-f-]{36}$/);
	});

	test('the download route derives from the operator lane prefix', () => {
		const port = createLiveFilesPagePort({
			manifest,
			roster,
			request: async () => ({ kind: 'error', error: { code: 'network_unavailable', retryable: true } })
		});
		expect(port.downloadPath(id(100)))
			.toBe(`/api/events/current/files/download/${id(100)}`);
	});
});
