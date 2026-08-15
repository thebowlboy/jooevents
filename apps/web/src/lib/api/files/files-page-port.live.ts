import {
	resolveOperatorHttpBinding,
	type OperatorHttpBindingResolution
} from '../operations/operator-http-binding';
import {
	defaultFilesRequester,
	laneScopedManifest,
	runFilesCommand,
	runFilesRead,
	type FilesCommandRunResult,
	type FilesLiveRequester
} from './live-shared';
import {
	createXhrUploadByteTransfer,
	sha256HexOfBlob,
	type UploadByteTransfer
} from './upload-transfer';
import {
	assetDownloadPath,
	deadlineCatalogWireSchema,
	filesIdempotencyKey,
	filesLanePrefix,
	newFilesRecordId,
	organizerFileOverviewWireSchema,
	uploadBytesPath,
	DEADLINE_CATALOG_READ_EXPECTATION,
	FILES_COMMAND_ACTIONS,
	FILES_ORGANIZER_OVERVIEW_EXPECTATION,
	FILES_OPERATOR_COMMAND_EXPECTATIONS,
	type FilesCommandAction
} from './wire';
import {
	FilesPageReadError,
	type FilesPageOutcome,
	type FilesPagePort,
	type FilesPageRefusalReason
} from './files-page-port';
import type { UploadSourceFile } from './portal-files-port';
import {
	admitUploadCandidate,
	displayFilename,
	projectOrganizerFiles,
	type EngagementLabelView
} from './view-models';

/**
 * Live fulfillment of the organizer Files surface over the operator lane. The
 * overview read is joined with the engagement roster (names for received
 * material) and the deadline catalog (the D9 ask's "by when" is a reference
 * into it) — both joins are tolerant: a failed side read degrades labels or
 * dates, never the page. Pure live: no sample state.
 */

/** The roster slice this port needs: engagement id, speaker name, session titles. */
export interface FilesRosterSource {
	list(): Promise<readonly {
		readonly id: string;
		readonly name: string;
		readonly sessions: readonly { readonly title: string }[];
	}[]>;
}

/** The vocabulary slice: track names for share audiences. */
export interface FilesTrackSource {
	tracks(): Promise<readonly { readonly id: string; readonly name: string }[]>;
}

const NOT_SERVED = Object.freeze({ ok: false, reason: 'not_served' } as const);
const UNCONFIRMED = Object.freeze({ ok: false, reason: 'request_unconfirmed' } as const);

function refusalOutcome(
	result: Exclude<FilesCommandRunResult<FilesCommandAction>, { kind: 'success' }>
): { readonly ok: false; readonly reason: FilesPageRefusalReason } {
	switch (result.kind) {
		case 'refused':
			return { ok: false, reason: result.code };
		case 'denied':
			return { ok: false, reason: 'not_authorized' };
		case 'event_required':
			return { ok: false, reason: 'event_required' };
		case 'unconfirmed':
			return UNCONFIRMED;
	}
}

export function createLiveFilesPagePort(input: {
	readonly manifest: unknown;
	readonly roster: FilesRosterSource;
	readonly vocabulary?: FilesTrackSource;
	readonly request?: FilesLiveRequester;
	readonly transfer?: UploadByteTransfer;
	readonly now?: () => number;
	readonly newRecordId?: () => string;
	readonly newIdempotencyKey?: (action: FilesCommandAction) => string;
}): FilesPagePort {
	const request = input.request ?? defaultFilesRequester;
	const transfer = input.transfer ?? createXhrUploadByteTransfer();
	const now = input.now ?? Date.now;
	const newRecordId = input.newRecordId ?? newFilesRecordId;
	const newKey = input.newIdempotencyKey ?? filesIdempotencyKey;

	const manifest = laneScopedManifest(input.manifest, 'operator_http');
	const commandBindings = Object.fromEntries(
		FILES_COMMAND_ACTIONS.map((action) => [
			action,
			resolveOperatorHttpBinding({
				manifest,
				expected: FILES_OPERATOR_COMMAND_EXPECTATIONS[action]
			})
		])
	) as Record<FilesCommandAction, OperatorHttpBindingResolution>;
	const overviewBinding = resolveOperatorHttpBinding({
		manifest,
		expected: FILES_ORGANIZER_OVERVIEW_EXPECTATION
	});
	const catalogBinding = resolveOperatorHttpBinding({
		manifest,
		expected: DEADLINE_CATALOG_READ_EXPECTATION
	});
	const intentBinding = commandBindings['upload.intent'];
	const lanePrefix = intentBinding.kind === 'available'
		? filesLanePrefix(intentBinding.path)
		: null;

	async function command<Action extends FilesCommandAction>(
		action: Action,
		body: unknown
	): Promise<FilesCommandRunResult<Action> | { readonly kind: 'not_served' }> {
		const binding = commandBindings[action];
		if (binding.kind !== 'available') return { kind: 'not_served' };
		return runFilesCommand({
			action,
			path: binding.path,
			body,
			idempotencyKey: newKey(action),
			request
		});
	}

	async function act<Action extends FilesCommandAction>(
		action: Action,
		body: unknown
	): Promise<FilesPageOutcome> {
		const result = await command(action, body);
		if (result.kind === 'not_served') return NOT_SERVED;
		if (result.kind !== 'success') return refusalOutcome(result);
		return { ok: true, data: undefined };
	}

	async function engagementLabels(): Promise<ReadonlyMap<string, EngagementLabelView>> {
		try {
			const rows = await input.roster.list();
			return new Map(rows.map((row) => [
				row.id,
				{
					speaker: row.name,
					session: row.sessions[0]?.title ?? 'No session yet'
				}
			]));
		} catch {
			// Labels degrade to short ids; the files themselves still render.
			return new Map();
		}
	}

	async function trackNames(): Promise<ReadonlyMap<string, string>> {
		if (!input.vocabulary) return new Map();
		try {
			const tracks = await input.vocabulary.tracks();
			return new Map(tracks.map((track) => [track.id, track.name]));
		} catch {
			return new Map();
		}
	}

	const port: FilesPagePort = {
		async read() {
			if (overviewBinding.kind !== 'available') {
				throw new FilesPageReadError({ code: overviewBinding.reason, retryable: false });
			}
			const [overview, labels, tracks, catalog] = await Promise.all([
				runFilesRead({
					path: overviewBinding.path,
					wireSchema: organizerFileOverviewWireSchema,
					request
				}),
				engagementLabels(),
				trackNames(),
				catalogBinding.kind === 'available'
					? runFilesRead({
							path: catalogBinding.path,
							wireSchema: deadlineCatalogWireSchema,
							request
						})
					: Promise.resolve(null)
			]);
			if (overview.kind === 'failed') {
				throw new FilesPageReadError({ code: overview.code, retryable: overview.retryable });
			}
			return projectOrganizerFiles({
				overview: overview.data,
				catalog: catalog !== null && catalog.kind === 'success' ? catalog.data : null,
				engagementLabels: labels,
				trackNames: tracks,
				now: now()
			});
		},

		createRequest: (requestInput) =>
			act('request.create', {
				requestId: newRecordId(),
				engagementId: requestInput.engagementId,
				what: requestInput.what,
				instructions: requestInput.instructions,
				deadlineId: requestInput.deadlineId
			}),

		withdrawRequest: (withdrawInput) =>
			act('request.withdraw', {
				requestId: withdrawInput.requestId,
				expectedVersion: withdrawInput.expectedVersion
			}),

		async createShare(shareInput) {
			const shareId = newRecordId();
			const created = await command('share.create', {
				resourceShareId: shareId,
				title: shareInput.title,
				audience: shareInput.audience
			});
			if (created.kind === 'not_served') return NOT_SERVED;
			if (created.kind !== 'success') return refusalOutcome(created);
			return { ok: true, data: { shareId: created.data.share.id } };
		},

		revokeShare: (revokeInput) =>
			act('share.revoke', {
				resourceShareId: revokeInput.shareId,
				expectedVersion: revokeInput.expectedVersion
			}),

		async uploadShareFile(uploadInput: {
			readonly shareId: string;
			readonly file: UploadSourceFile;
			readonly onProgress?: Parameters<UploadByteTransfer['send']>[0]['onProgress'];
		}): Promise<FilesPageOutcome> {
			const admission = admitUploadCandidate(uploadInput.file);
			if (admission.kind === 'refused') return { ok: false, reason: admission.code };
			if (lanePrefix === null) return NOT_SERVED;

			const intentId = newRecordId();
			const registered = await command('upload.intent', {
				intentId,
				purpose: 'resource_share_material',
				displayFilename: displayFilename(uploadInput.file.name),
				contentType: admission.contentType,
				declaredByteSize: uploadInput.file.size
			});
			if (registered.kind === 'not_served') return NOT_SERVED;
			if (registered.kind !== 'success') return refusalOutcome(registered);
			if (registered.data.intent.id !== intentId) return UNCONFIRMED;

			const bytePath = uploadBytesPath(lanePrefix, intentId);
			if (bytePath === null) return UNCONFIRMED;
			const sent = await transfer.send({
				path: bytePath,
				blob: uploadInput.file.blob,
				contentType: admission.contentType,
				...(uploadInput.onProgress ? { onProgress: uploadInput.onProgress } : {})
			});
			if (sent.kind === 'failed') return { ok: false, reason: 'upload_interrupted' };

			const assetId = newRecordId();
			const confirmed = await command('upload.confirm', {
				intentId,
				assetId,
				sha256: await sha256HexOfBlob(uploadInput.file.blob)
			});
			if (confirmed.kind === 'not_served') return NOT_SERVED;
			if (confirmed.kind !== 'success') return refusalOutcome(confirmed);
			if (confirmed.data.asset.id !== assetId) return UNCONFIRMED;

			return act('attachment.attach', {
				attachmentId: newRecordId(),
				subject: { kind: 'resource_share', resourceShareId: uploadInput.shareId },
				assetId
			});
		},

		attachShareLink: (linkInput) =>
			act('attachment.link', {
				attachmentId: newRecordId(),
				subject: { kind: 'resource_share', resourceShareId: linkInput.shareId },
				link: {
					provider: linkInput.provider,
					label: linkInput.label,
					url: linkInput.url
				}
			}),

		detach: (detachInput) =>
			act('attachment.detach', {
				attachmentId: detachInput.attachmentId,
				expectedVersion: detachInput.expectedVersion
			}),

		reattach: (reattachInput) =>
			act('attachment.attach', {
				attachmentId: newRecordId(),
				subject: reattachInput.subject,
				assetId: reattachInput.assetId
			}),

		relink: (relinkInput) =>
			act('attachment.link', {
				attachmentId: newRecordId(),
				subject: relinkInput.subject,
				link: {
					provider: relinkInput.provider,
					label: relinkInput.label,
					url: relinkInput.url
				}
			}),

		downloadPath(assetId: string): string | null {
			if (lanePrefix === null) return null;
			return assetDownloadPath(lanePrefix, assetId);
		}
	};
	return Object.freeze(port);
}
