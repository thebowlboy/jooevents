import type { SafeApiError } from '../client';
import {
	resolveParticipantHttpBinding,
	type ParticipantHttpBindingResolution
} from '../portal/live/participant-http-binding';
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
	filesIdempotencyKey,
	filesLanePrefix,
	newFilesRecordId,
	portalEngagementFilesQuery,
	portalEngagementFilesWireSchema,
	uploadBytesPath,
	FILES_PORTAL_COMMAND_EXPECTATIONS,
	FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION,
	type FilesCommandAction,
	type FilesPortalCommandAction
} from './wire';
import {
	PortalFilesReadError,
	type PortalFilesOutcome,
	type PortalFilesPort,
	type PortalFilesRefusalReason,
	type PortalUploadResult,
	type UploadSourceFile
} from './portal-files-port';
import { admitUploadCandidate, displayFilename, projectPortalMaterials } from './view-models';

/**
 * Live fulfillment of the portal files port over the participant lane. Paths
 * come only from the browser-safe manifest's `participant_http` bindings;
 * every answer is validated against the published contract before it is
 * believed; and the whole D2 upload loop — intent, bytes, client-side
 * SHA-256, confirm, attach, optional request fulfilment — runs as one act
 * with typed refusals at every step. Pure live: no sample state.
 */

export type PortalFilesManifestLoadResult =
	| { readonly kind: 'success'; readonly manifest: unknown }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError };

interface ResolvedPortalFilesBindings {
	readonly read: ParticipantHttpBindingResolution;
	readonly commands: Readonly<Record<FilesPortalCommandAction, ParticipantHttpBindingResolution>>;
	/** Derived from the resolved upload-intent path; carries bytes and downloads. */
	readonly lanePrefix: string | null;
}

function resolveBindings(rawManifest: unknown): ResolvedPortalFilesBindings {
	const manifest = laneScopedManifest(rawManifest, 'participant_http');
	const commands = Object.fromEntries(
		(Object.keys(FILES_PORTAL_COMMAND_EXPECTATIONS) as FilesPortalCommandAction[]).map(
			(action) => [
				action,
				resolveParticipantHttpBinding({
					manifest,
					expected: FILES_PORTAL_COMMAND_EXPECTATIONS[action]
				})
			]
		)
	) as Record<FilesPortalCommandAction, ParticipantHttpBindingResolution>;
	const intent = commands['upload.intent'];
	return Object.freeze({
		read: resolveParticipantHttpBinding({
			manifest,
			expected: FILES_PORTAL_ENGAGEMENT_FILES_EXPECTATION
		}),
		commands: Object.freeze(commands),
		lanePrefix: intent.kind === 'available' ? filesLanePrefix(intent.path) : null
	});
}

const NOT_SERVED = Object.freeze({ ok: false, reason: 'not_served' } as const);
const UNCONFIRMED = Object.freeze({ ok: false, reason: 'request_unconfirmed' } as const);

function refusalOutcome(
	result: Exclude<FilesCommandRunResult<FilesCommandAction>, { kind: 'success' }>
): { readonly ok: false; readonly reason: PortalFilesRefusalReason } {
	switch (result.kind) {
		case 'refused':
			return { ok: false, reason: result.code };
		case 'denied':
			return { ok: false, reason: 'not_yours' };
		case 'event_required':
			// The portal lane is constructed with a fixed event; a missing event
			// is indistinguishable from the capability not being served.
			return { ok: false, reason: 'not_served' };
		case 'unconfirmed':
			return UNCONFIRMED;
	}
}

export function createLivePortalFilesPort(input: {
	readonly loadManifest: () => Promise<PortalFilesManifestLoadResult>;
	readonly request?: FilesLiveRequester;
	readonly transfer?: UploadByteTransfer;
	readonly newRecordId?: () => string;
	readonly newIdempotencyKey?: (action: FilesCommandAction) => string;
}): PortalFilesPort {
	const request = input.request ?? defaultFilesRequester;
	const transfer = input.transfer ?? createXhrUploadByteTransfer();
	const newRecordId = input.newRecordId ?? newFilesRecordId;
	const newKey = input.newIdempotencyKey ?? filesIdempotencyKey;

	let pending: Promise<
		| { readonly kind: 'ready'; readonly bindings: ResolvedPortalFilesBindings }
		| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	> | null = null;

	function resolve() {
		pending ??= input.loadManifest().then(
			(result) => {
				if (result.kind !== 'success') {
					// The next call gets a fresh chance instead of a cached failure.
					pending = null;
					return { kind: 'transport_error' as const, error: result.error };
				}
				return { kind: 'ready' as const, bindings: resolveBindings(result.manifest) };
			},
			() => {
				pending = null;
				return {
					kind: 'transport_error' as const,
					error: { code: 'network_unavailable', retryable: true }
				};
			}
		);
		return pending;
	}

	/** The last resolved prefix, for the synchronous download-path answer. */
	let knownLanePrefix: string | null = null;

	async function command<Action extends FilesPortalCommandAction>(
		bindings: ResolvedPortalFilesBindings,
		action: Action,
		body: unknown
	): Promise<FilesCommandRunResult<Action> | { readonly kind: 'not_served' }> {
		const binding = bindings.commands[action];
		if (binding.kind !== 'available') return { kind: 'not_served' };
		return runFilesCommand({
			action,
			path: binding.path,
			body,
			idempotencyKey: newKey(action),
			request
		});
	}

	async function fulfillRequest(
		bindings: ResolvedPortalFilesBindings,
		attachmentId: string,
		requestReference: { readonly id: string; readonly version: number } | undefined
	): Promise<boolean> {
		if (!requestReference) return true;
		const fulfilled = await command(bindings, 'request.fulfill', {
			requestId: requestReference.id,
			attachmentId,
			expectedVersion: requestReference.version
		});
		return fulfilled.kind === 'success';
	}

	return Object.freeze({
		async materials(engagementId: string) {
			const resolution = await resolve();
			if (resolution.kind === 'transport_error') {
				throw new PortalFilesReadError({
					code: resolution.error.code,
					retryable: resolution.error.retryable
				});
			}
			knownLanePrefix = resolution.bindings.lanePrefix;
			if (resolution.bindings.read.kind !== 'available') {
				throw new PortalFilesReadError({
					code: resolution.bindings.read.reason,
					retryable: false
				});
			}
			const query = portalEngagementFilesQuery(engagementId);
			if (query === null) {
				throw new PortalFilesReadError({ code: 'invalid_request', retryable: false });
			}
			const read = await runFilesRead({
				path: `${resolution.bindings.read.path}?${query}`,
				wireSchema: portalEngagementFilesWireSchema,
				request
			});
			if (read.kind === 'failed') {
				throw new PortalFilesReadError({ code: read.code, retryable: read.retryable });
			}
			if (read.data.engagementId !== engagementId) {
				throw new PortalFilesReadError({ code: 'invalid_contract', retryable: true });
			}
			return projectPortalMaterials(read.data);
		},

		async upload(uploadInput: {
			readonly engagementId: string;
			readonly file: UploadSourceFile;
			readonly request?: { readonly id: string; readonly version: number };
			readonly onProgress?: Parameters<UploadByteTransfer['send']>[0]['onProgress'];
		}): Promise<PortalFilesOutcome<PortalUploadResult>> {
			// The D3 gate, stated before any byte moves.
			const admission = admitUploadCandidate(uploadInput.file);
			if (admission.kind === 'refused') return { ok: false, reason: admission.code };

			const resolution = await resolve();
			if (resolution.kind === 'transport_error') return UNCONFIRMED;
			const bindings = resolution.bindings;
			knownLanePrefix = bindings.lanePrefix;
			if (bindings.lanePrefix === null) return NOT_SERVED;

			// 1. Register the intent; caps and the type gate bite here.
			const intentId = newRecordId();
			const registered = await command(bindings, 'upload.intent', {
				intentId,
				purpose: uploadInput.request ? 'request_fulfillment' : 'engagement_material',
				displayFilename: displayFilename(uploadInput.file.name),
				contentType: admission.contentType,
				declaredByteSize: uploadInput.file.size
			});
			if (registered.kind === 'not_served') return NOT_SERVED;
			if (registered.kind !== 'success') return refusalOutcome(registered);
			if (registered.data.intent.id !== intentId) return UNCONFIRMED;

			// 2. Stream the exact bytes to the admitted intent.
			const bytePath = uploadBytesPath(bindings.lanePrefix, intentId);
			if (bytePath === null) return UNCONFIRMED;
			const sent = await transfer.send({
				path: bytePath,
				blob: uploadInput.file.blob,
				contentType: admission.contentType,
				...(uploadInput.onProgress ? { onProgress: uploadInput.onProgress } : {})
			});
			if (sent.kind === 'failed') return { ok: false, reason: 'upload_interrupted' };

			// 3. Confirm with the client's own hash of those bytes.
			const assetId = newRecordId();
			const sha256 = await sha256HexOfBlob(uploadInput.file.blob);
			const confirmed = await command(bindings, 'upload.confirm', {
				intentId,
				assetId,
				sha256
			});
			if (confirmed.kind === 'not_served') return NOT_SERVED;
			if (confirmed.kind !== 'success') return refusalOutcome(confirmed);
			if (confirmed.data.asset.id !== assetId) return UNCONFIRMED;

			// 4. Attach to this engagement.
			const attachmentId = newRecordId();
			const attached = await command(bindings, 'attachment.attach', {
				attachmentId,
				subject: { kind: 'engagement', engagementId: uploadInput.engagementId },
				assetId
			});
			if (attached.kind === 'not_served') return NOT_SERVED;
			if (attached.kind !== 'success') return refusalOutcome(attached);

			// 5. Optionally mark the named request fulfilled. The file has landed
			//    either way; a failed fulfilment is reported, never hidden.
			const requestFulfilled = await fulfillRequest(
				bindings,
				attached.data.attachment.id,
				uploadInput.request
			);
			return {
				ok: true,
				data: {
					attachmentId: attached.data.attachment.id,
					assetId,
					requestFulfilled
				}
			};
		},

		async attachLink(linkInput: {
			readonly engagementId: string;
			readonly provider: 'drive' | 'dropbox' | 'url';
			readonly label: string;
			readonly url: string;
			readonly request?: { readonly id: string; readonly version: number };
		}): Promise<PortalFilesOutcome<PortalUploadResult>> {
			const resolution = await resolve();
			if (resolution.kind === 'transport_error') return UNCONFIRMED;
			const bindings = resolution.bindings;
			knownLanePrefix = bindings.lanePrefix;
			const attachmentId = newRecordId();
			const attached = await command(bindings, 'attachment.link', {
				attachmentId,
				subject: { kind: 'engagement', engagementId: linkInput.engagementId },
				link: {
					provider: linkInput.provider,
					label: linkInput.label,
					url: linkInput.url
				}
			});
			if (attached.kind === 'not_served') return NOT_SERVED;
			if (attached.kind !== 'success') return refusalOutcome(attached);
			const requestFulfilled = await fulfillRequest(
				bindings,
				attached.data.attachment.id,
				linkInput.request
			);
			return {
				ok: true,
				data: {
					attachmentId: attached.data.attachment.id,
					assetId: null,
					requestFulfilled
				}
			};
		},

		downloadPath(assetId: string): string | null {
			if (knownLanePrefix === null) return null;
			return assetDownloadPath(knownLanePrefix, assetId);
		}
	});
}
