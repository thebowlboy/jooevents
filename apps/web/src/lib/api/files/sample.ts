import type { FileContentType, FileLinkProvider, ResourceShareAudienceDto } from '@jooevents/contracts/files';
import type { FilesPagePort, FilesPageOutcome } from './files-page-port';
import type {
	PortalFilesOutcome,
	PortalFilesPort,
	PortalUploadResult,
	UploadSourceFile
} from './portal-files-port';
import {
	admitUploadCandidate,
	displayFilename,
	formatByteSize,
	type DeadlineChoiceView,
	type EngagementChoiceView,
	type MaterialItemView,
	type OrganizerFilesView,
	type OrganizerRequestView,
	type OrganizerShareView,
	type PortalMaterialsView
} from './view-models';

/**
 * Sample fulfilment of both files ports: deterministic in-memory state so the
 * demo scenarios exercise the same surfaces the live lanes serve — the same
 * ports, the same refusal vocabulary, no fetch. State lives per created port
 * and resets with the composition, like the other sample ports.
 */

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const NOW = '2026-08-14T09:00:00.000Z';

let sequence = 4000;
function nextId(): string {
	return id((sequence += 1));
}

function sampleFile(input: {
	readonly name: string;
	readonly byteSize: number;
	readonly contentType: FileContentType;
	readonly origin: MaterialItemView['origin'];
}): MaterialItemView {
	return {
		kind: 'file',
		attachmentId: nextId(),
		attachmentVersion: 1,
		assetId: nextId(),
		assetVersion: 1,
		name: input.name,
		byteSize: input.byteSize,
		sizeLabel: formatByteSize(input.byteSize),
		contentType: input.contentType,
		scan: 'not_scanned',
		downloadable: true,
		attachedAt: NOW,
		origin: input.origin
	};
}

export function createSamplePortalFilesPort(): PortalFilesPort {
	const materialsByEngagement = new Map<string, {
		yours: MaterialItemView[];
		fromOrganizers: MaterialItemView[];
		openRequests: {
			id: string; version: number; what: string;
			instructions: string | null; hasDeadline: boolean;
		}[];
	}>();

	function state(engagementId: string) {
		let existing = materialsByEngagement.get(engagementId);
		if (!existing) {
			existing = {
				yours: [],
				fromOrganizers: [
					sampleFile({
						name: 'Slide template.pdf',
						byteSize: 842_000,
						contentType: 'application/pdf',
						origin: 'organizers'
					})
				],
				openRequests: [{
					id: nextId(),
					version: 1,
					what: 'Your final slide deck',
					instructions: 'Export as PDF if you can — it keeps fonts intact.',
					hasDeadline: true
				}]
			};
			materialsByEngagement.set(engagementId, existing);
		}
		return existing;
	}

	function view(engagementId: string): PortalMaterialsView {
		const entry = state(engagementId);
		return {
			engagementId,
			openRequests: entry.openRequests.map((request) => ({ ...request, state: 'open' as const })),
			yours: [...entry.yours],
			fromOrganizers: [...entry.fromOrganizers]
		};
	}

	function settleRequest(
		entry: ReturnType<typeof state>,
		request: { readonly id: string } | undefined
	): boolean {
		if (!request) return true;
		const index = entry.openRequests.findIndex((open) => open.id === request.id);
		if (index >= 0) entry.openRequests.splice(index, 1);
		return index >= 0;
	}

	return Object.freeze({
		async materials(engagementId: string) {
			return view(engagementId);
		},
		async upload(input: {
			readonly engagementId: string;
			readonly file: UploadSourceFile;
			readonly request?: { readonly id: string; readonly version: number };
			readonly onProgress?: (progress: { transferredBytes: number; totalBytes: number }) => void;
		}): Promise<PortalFilesOutcome<PortalUploadResult>> {
			const admission = admitUploadCandidate(input.file);
			if (admission.kind === 'refused') return { ok: false, reason: admission.code };
			// The sample lane enforces the default speaker cap so the refusal
			// surface is demonstrable without a server.
			if (input.file.size > 100_000_000) return { ok: false, reason: 'file_too_large' };
			input.onProgress?.({ transferredBytes: input.file.size, totalBytes: input.file.size });
			const entry = state(input.engagementId);
			const item = sampleFile({
				name: displayFilename(input.file.name),
				byteSize: input.file.size,
				contentType: admission.contentType,
				origin: 'you'
			});
			entry.yours.unshift(item);
			const requestFulfilled = settleRequest(entry, input.request);
			if (item.kind !== 'file') throw new TypeError('sample_upload_item_invalid');
			return {
				ok: true,
				data: { attachmentId: item.attachmentId, assetId: item.assetId, requestFulfilled }
			};
		},
		async attachLink(input: {
			readonly engagementId: string;
			readonly provider: FileLinkProvider;
			readonly label: string;
			readonly url: string;
			readonly request?: { readonly id: string; readonly version: number };
		}): Promise<PortalFilesOutcome<PortalUploadResult>> {
			const entry = state(input.engagementId);
			const item: MaterialItemView = {
				kind: 'link',
				attachmentId: nextId(),
				attachmentVersion: 1,
				provider: input.provider,
				label: input.label,
				url: input.url,
				attachedAt: NOW,
				origin: 'you'
			};
			entry.yours.unshift(item);
			const requestFulfilled = settleRequest(entry, input.request);
			return {
				ok: true,
				data: { attachmentId: item.attachmentId, assetId: null, requestFulfilled }
			};
		},
		downloadPath(): string | null {
			// Sample assets have no bytes behind them; an honest absence beats a
			// dead link.
			return null;
		}
	});
}

export function createSampleFilesPagePort(input?: {
	readonly engagements?: readonly EngagementChoiceView[];
}): FilesPagePort {
	const engagements: readonly EngagementChoiceView[] = input?.engagements ?? [
		{ engagementId: id(3101), speaker: 'Nadia Okafor', session: 'Streaming at the edge' },
		{ engagementId: id(3102), speaker: 'Priya Raman', session: 'Postgres without fear' }
	];
	const deadlines: readonly DeadlineChoiceView[] = [{
		deadlineId: id(3201),
		label: '2026-09-01 · proposals close',
		displayDate: '2026-09-01',
		effectiveAt: '2026-09-02T00:00:00.000Z'
	}];
	const tracks = [{ trackId: id(3301), name: 'Engineering' }];

	const first = engagements[0];
	const received = new Map<string, MaterialItemView[]>(
		first
			? [[first.engagementId, [sampleFile({
					name: 'Edge networking deck.pdf',
					byteSize: 4_200_000,
					contentType: 'application/pdf',
					origin: 'speaker'
				})]]]
			: []
	);
	const shares: OrganizerShareView[] = [];
	const requests: OrganizerRequestView[] = [];

	function ok(): FilesPageOutcome {
		return { ok: true, data: undefined };
	}

	function label(engagementId: string) {
		return engagements.find((choice) => choice.engagementId === engagementId)
			?? { engagementId, speaker: 'Unlisted speaker', session: `Engagement ${engagementId.slice(0, 8)}` };
	}

	return Object.freeze({
		async read(): Promise<OrganizerFilesView> {
			return {
				received: [...received.entries()].map(([engagementId, items]) => ({
					engagementId,
					label: label(engagementId),
					items: [...items],
					openRequestCount: requests
						.filter((request) => request.engagementId === engagementId
							&& request.state === 'open').length
				})),
				shares: shares.map((share) => ({ ...share, materials: [...share.materials] })),
				requests: [...requests],
				engagementChoices: [...engagements],
				deadlineChoices: [...deadlines],
				trackChoices: [...tracks]
			};
		},
		async createRequest(requestInput: {
			readonly engagementId: string;
			readonly what: string;
			readonly instructions: string | null;
			readonly deadlineId: string | null;
		}) {
			const deadline = deadlines.find((choice) => choice.deadlineId === requestInput.deadlineId) ?? null;
			requests.unshift({
				id: nextId(),
				version: 1,
				engagementId: requestInput.engagementId,
				engagementLabel: label(requestInput.engagementId),
				what: requestInput.what,
				instructions: requestInput.instructions,
				state: 'open',
				deadline,
				overdue: false
			});
			return ok();
		},
		async withdrawRequest(withdrawInput: { readonly requestId: string; readonly expectedVersion: number }) {
			const index = requests.findIndex((request) => request.id === withdrawInput.requestId);
			if (index < 0) return { ok: false as const, reason: 'request_missing' as const };
			requests.splice(index, 1);
			return ok();
		},
		async createShare(shareInput: { readonly title: string; readonly audience: ResourceShareAudienceDto }) {
			const shareId = nextId();
			shares.unshift({
				id: shareId,
				version: 1,
				title: shareInput.title,
				audience: shareInput.audience,
				audienceLabel: shareInput.audience.kind === 'all_confirmed'
					? 'All confirmed speakers'
					: shareInput.audience.kind === 'track'
						? tracks.find((track) => shareInput.audience.kind === 'track'
								&& track.trackId === shareInput.audience.trackId)?.name ?? 'One track'
						: (() => {
							const engagement = label(shareInput.audience.engagementId);
							return `${engagement.speaker} · ${engagement.session}`;
						})(),
				state: 'active',
				materials: []
			});
			return { ok: true as const, data: { shareId } };
		},
		async revokeShare(revokeInput: { readonly shareId: string; readonly expectedVersion: number }) {
			const index = shares.findIndex((share) => share.id === revokeInput.shareId);
			if (index < 0) return { ok: false as const, reason: 'share_missing' as const };
			shares.splice(index, 1);
			return ok();
		},
		async uploadShareFile(uploadInput: {
			readonly shareId: string;
			readonly file: UploadSourceFile;
			readonly onProgress?: (progress: { transferredBytes: number; totalBytes: number }) => void;
		}) {
			const admission = admitUploadCandidate(uploadInput.file);
			if (admission.kind === 'refused') return { ok: false as const, reason: admission.code };
			if (uploadInput.file.size > 250_000_000) return { ok: false as const, reason: 'file_too_large' as const };
			const share = shares.find((entry) => entry.id === uploadInput.shareId);
			if (!share) return { ok: false as const, reason: 'share_missing' as const };
			uploadInput.onProgress?.({
				transferredBytes: uploadInput.file.size,
				totalBytes: uploadInput.file.size
			});
			(share.materials as MaterialItemView[]).unshift(sampleFile({
				name: displayFilename(uploadInput.file.name),
				byteSize: uploadInput.file.size,
				contentType: admission.contentType,
				origin: 'you'
			}));
			return ok();
		},
		async attachShareLink(linkInput: {
			readonly shareId: string;
			readonly provider: FileLinkProvider;
			readonly label: string;
			readonly url: string;
		}) {
			const share = shares.find((entry) => entry.id === linkInput.shareId);
			if (!share) return { ok: false as const, reason: 'share_missing' as const };
			(share.materials as MaterialItemView[]).unshift({
				kind: 'link',
				attachmentId: nextId(),
				attachmentVersion: 1,
				provider: linkInput.provider,
				label: linkInput.label,
				url: linkInput.url,
				attachedAt: NOW,
				origin: 'you'
			});
			return ok();
		},
		async detach(detachInput: { readonly attachmentId: string; readonly expectedVersion: number }) {
			for (const items of received.values()) {
				const index = items.findIndex((item) => item.attachmentId === detachInput.attachmentId);
				if (index >= 0) {
					items.splice(index, 1);
					return ok();
				}
			}
			for (const share of shares) {
				const items = share.materials as MaterialItemView[];
				const index = items.findIndex((item) => item.attachmentId === detachInput.attachmentId);
				if (index >= 0) {
					items.splice(index, 1);
					return ok();
				}
			}
			return { ok: false as const, reason: 'attachment_missing' as const };
		},
		async reattach() {
			return ok();
		},
		async relink() {
			return ok();
		},
		downloadPath(): string | null {
			return null;
		}
	});
}
