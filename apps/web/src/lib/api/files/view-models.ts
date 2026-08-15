import type {
	DeadlineCatalogSnapshotDto
} from '@jooevents/contracts/deadlines';
import type {
	FileAttachmentViewDto,
	FileContentType,
	FileLinkProvider,
	FileRequestDto,
	FileRequestState,
	OrganizerFileOverviewDto,
	PortalEngagementFilesDto,
	ResourceShareDto
} from '@jooevents/contracts/files';

/**
 * Framework-free projections of the files vertical for both lanes. Everything
 * a component renders is decided here — partitioning, honesty about scan
 * state, sizes, ordering — so the Svelte layer only lays views out.
 */

// ---------------------------------------------------------------------------
// Shared item views
// ---------------------------------------------------------------------------

/**
 * L5 honesty about what scanning actually happened. `not_scanned` is the
 * truthful default of the `none` provider; there is no fake safety badge.
 */
export type FileScanHonesty = 'not_scanned' | 'scan_pending' | 'scanned' | 'blocked';

export type MaterialOrigin = 'you' | 'speaker' | 'organizers';

export interface MaterialFileView {
	readonly kind: 'file';
	readonly attachmentId: string;
	readonly attachmentVersion: number;
	readonly assetId: string;
	readonly name: string;
	readonly byteSize: number;
	readonly sizeLabel: string;
	readonly contentType: FileContentType;
	readonly scan: FileScanHonesty;
	/** A blocked asset is named, never served; everything else downloads inert. */
	readonly downloadable: boolean;
	readonly attachedAt: string;
	readonly origin: MaterialOrigin;
}

export interface MaterialLinkView {
	readonly kind: 'link';
	readonly attachmentId: string;
	readonly attachmentVersion: number;
	readonly provider: FileLinkProvider;
	readonly label: string;
	readonly url: string;
	readonly attachedAt: string;
	readonly origin: MaterialOrigin;
}

export type MaterialItemView = MaterialFileView | MaterialLinkView;

// ---------------------------------------------------------------------------
// Portal views
// ---------------------------------------------------------------------------

export interface PortalFileRequestView {
	readonly id: string;
	readonly version: number;
	readonly what: string;
	readonly instructions: string | null;
	readonly state: FileRequestState;
	/**
	 * The ask references a deadline in the event's catalog. The portal
	 * projection does not resolve the pin yet, so the date itself renders only
	 * once the served contract carries it; `hasDeadline` keeps the fact honest.
	 */
	readonly hasDeadline: boolean;
}

export interface PortalMaterialsView {
	readonly engagementId: string;
	readonly openRequests: readonly PortalFileRequestView[];
	readonly yours: readonly MaterialItemView[];
	readonly fromOrganizers: readonly MaterialItemView[];
}

// ---------------------------------------------------------------------------
// Organizer views
// ---------------------------------------------------------------------------

export interface EngagementLabelView {
	readonly speaker: string;
	readonly session: string;
}

export interface EngagementChoiceView extends EngagementLabelView {
	readonly engagementId: string;
}

export interface DeadlineChoiceView {
	readonly deadlineId: string;
	/** e.g. `2026-09-01 · proposals close`. */
	readonly label: string;
	readonly displayDate: string;
	readonly effectiveAt: string;
}

export interface OrganizerRequestView {
	readonly id: string;
	readonly version: number;
	readonly engagementId: string;
	readonly engagementLabel: EngagementLabelView;
	readonly what: string;
	readonly instructions: string | null;
	readonly state: FileRequestState;
	readonly deadline: DeadlineChoiceView | null;
	readonly overdue: boolean;
}

export interface OrganizerShareView {
	readonly id: string;
	readonly version: number;
	readonly title: string;
	readonly audience: ResourceShareDto['audience'];
	readonly audienceLabel: string;
	readonly state: ResourceShareDto['state'];
	readonly materials: readonly MaterialItemView[];
}

export interface OrganizerEngagementFilesView {
	readonly engagementId: string;
	readonly label: EngagementLabelView;
	readonly items: readonly MaterialItemView[];
	readonly openRequestCount: number;
}

export interface TrackChoiceView {
	readonly trackId: string;
	readonly name: string;
}

export interface OrganizerFilesView {
	readonly received: readonly OrganizerEngagementFilesView[];
	readonly shares: readonly OrganizerShareView[];
	readonly requests: readonly OrganizerRequestView[];
	readonly engagementChoices: readonly EngagementChoiceView[];
	readonly deadlineChoices: readonly DeadlineChoiceView[];
	readonly trackChoices: readonly TrackChoiceView[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Human byte sizes: whole KB below 1 MB, one decimal above. Sizes are facts a
 * speaker compares against a cap, so the unit stays decimal (matching how the
 * caps are stated: 100 MB, 1 GB).
 */
export function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
	if (bytes < 1000) return `${Math.round(bytes)} B`;
	if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
	if (bytes < 1_000_000_000) {
		return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;
	}
	return `${(bytes / 1_000_000_000).toFixed(1).replace(/\.0$/, '')} GB`;
}

// ---------------------------------------------------------------------------
// Client-side upload admission (the D3 gate, stated before the attempt)
// ---------------------------------------------------------------------------

export type UploadAdmission =
	| { readonly kind: 'admitted'; readonly contentType: FileContentType }
	| { readonly kind: 'refused'; readonly code: 'content_type_refused' | 'video_refused_use_link' };

const EXTENSION_CONTENT_TYPES: Readonly<Record<string, FileContentType>> = Object.freeze({
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	key: 'application/vnd.apple.keynote',
	zip: 'application/zip'
});

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv']);

/**
 * The allowlist decision the surface can make before any byte moves. The
 * extension decides (browser MIME types are unreliable for Keynote and PPTX);
 * a video is refused with its own reason because link-attach is its supported
 * home, not a workaround.
 */
export function admitUploadCandidate(candidate: {
	readonly name: string;
	readonly type: string;
}): UploadAdmission {
	const extension = candidate.name.toLowerCase().split('.').pop() ?? '';
	if (candidate.type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
		return { kind: 'refused', code: 'video_refused_use_link' };
	}
	const contentType = EXTENSION_CONTENT_TYPES[extension];
	if (!contentType) return { kind: 'refused', code: 'content_type_refused' };
	return { kind: 'admitted', contentType };
}

/**
 * Display-only filename cleanup toward the server's sanitized display schema:
 * whitespace normalized, path separators and control characters removed. The
 * server remains the authority; this only prevents the common refusals.
 */
export function displayFilename(name: string): string {
	const cleaned = name
		.normalize('NFC')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f/\\:]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/\.+$/, '');
	return (cleaned || 'file').slice(0, 200);
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function scanHonesty(view: FileAttachmentViewDto): FileScanHonesty {
	const asset = view.asset;
	if (asset === null) return 'not_scanned';
	if (asset.lifecycle === 'blocked') return 'blocked';
	if (asset.lifecycle === 'uploaded' || asset.lifecycle === 'pending_scan') return 'scan_pending';
	return asset.scan.provider === 'none' ? 'not_scanned' : 'scanned';
}

function materialItem(view: FileAttachmentViewDto, origin: MaterialOrigin): MaterialItemView {
	const attachment = view.attachment;
	if (attachment.content.kind === 'link') {
		return {
			kind: 'link',
			attachmentId: attachment.id,
			attachmentVersion: attachment.version,
			provider: attachment.content.link.provider,
			label: attachment.content.link.label,
			url: attachment.content.link.url,
			attachedAt: attachment.attachedAt,
			origin
		};
	}
	const asset = view.asset;
	if (asset === null) {
		// The contract's own superRefine forbids this; state it loudly if a
		// non-validating source ever reaches a projection.
		throw new TypeError('files_attachment_view_missing_asset');
	}
	const scan = scanHonesty(view);
	return {
		kind: 'file',
		attachmentId: attachment.id,
		attachmentVersion: attachment.version,
		assetId: asset.id,
		name: asset.displayFilename,
		byteSize: asset.byteSize,
		sizeLabel: formatByteSize(asset.byteSize),
		contentType: asset.contentType,
		scan,
		downloadable: scan !== 'blocked',
		attachedAt: attachment.attachedAt,
		origin
	};
}

function newestFirst(left: MaterialItemView, right: MaterialItemView): number {
	return left.attachedAt < right.attachedAt ? 1 : left.attachedAt > right.attachedAt ? -1 : 0;
}

function requestOrder(left: FileRequestDto, right: FileRequestDto): number {
	const rank = (state: FileRequestState) =>
		state === 'open' ? 0 : state === 'fulfilled' ? 1 : 2;
	const byState = rank(left.state) - rank(right.state);
	if (byState !== 0) return byState;
	return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
}

/** The speaker's Materials section for one engagement. */
export function projectPortalMaterials(dto: PortalEngagementFilesDto): PortalMaterialsView {
	const attached = dto.attachments.filter((view) => view.attachment.state === 'attached');
	const yours: MaterialItemView[] = [];
	const fromOrganizers: MaterialItemView[] = [];
	for (const view of attached) {
		// Organizer-shared resources arrive as resource-share subjects; anything
		// on the engagement itself is partitioned by who attached it.
		if (view.attachment.subject.kind === 'resource_share') {
			fromOrganizers.push(materialItem(view, 'organizers'));
		} else if (view.attachment.attachedBy.kind === 'participant') {
			yours.push(materialItem(view, 'you'));
		} else {
			fromOrganizers.push(materialItem(view, 'organizers'));
		}
	}
	return {
		engagementId: dto.engagementId,
		openRequests: [...dto.requests]
			.filter((request) => request.state === 'open')
			.sort(requestOrder)
			.map((request) => ({
				id: request.id,
				version: request.version,
				what: request.what,
				instructions: request.instructions,
				state: request.state,
				hasDeadline: request.deadlineId !== null
			})),
		yours: yours.sort(newestFirst),
		fromOrganizers: fromOrganizers.sort(newestFirst)
	};
}

function shortIdLabel(id: string): EngagementLabelView {
	return { speaker: 'Unlisted speaker', session: `Engagement ${id.slice(0, 8)}` };
}

function deadlineChoice(
	catalog: DeadlineCatalogSnapshotDto | null,
	deadlineId: string
): DeadlineChoiceView | null {
	const head = catalog?.deadlines.find((entry) => entry.id === deadlineId);
	if (!head || head.status !== 'active') return null;
	return {
		deadlineId: head.id,
		label: `${head.displayDate} · ${head.kind === 'cfp_close' ? 'proposals close' : 'reviews due'}`,
		displayDate: head.displayDate,
		effectiveAt: head.effectiveAt
	};
}

/** The organizer Files surface, joined with names and the deadline catalog. */
export function projectOrganizerFiles(input: {
	readonly overview: OrganizerFileOverviewDto;
	readonly catalog: DeadlineCatalogSnapshotDto | null;
	readonly engagementLabels: ReadonlyMap<string, EngagementLabelView>;
	readonly trackNames: ReadonlyMap<string, string>;
	readonly now: number;
}): OrganizerFilesView {
	const attached = input.overview.attachments
		.filter((view) => view.attachment.state === 'attached');

	const byEngagement = new Map<string, MaterialItemView[]>();
	const byShare = new Map<string, MaterialItemView[]>();
	for (const view of attached) {
		const subject = view.attachment.subject;
		if (subject.kind === 'engagement') {
			const origin: MaterialOrigin =
				view.attachment.attachedBy.kind === 'participant' ? 'speaker' : 'you';
			const items = byEngagement.get(subject.engagementId) ?? [];
			items.push(materialItem(view, origin));
			byEngagement.set(subject.engagementId, items);
		} else if (subject.kind === 'resource_share') {
			const items = byShare.get(subject.resourceShareId) ?? [];
			items.push(materialItem(view, 'you'));
			byShare.set(subject.resourceShareId, items);
		}
	}

	const label = (engagementId: string): EngagementLabelView =>
		input.engagementLabels.get(engagementId) ?? shortIdLabel(engagementId);

	const openRequestCounts = new Map<string, number>();
	for (const request of input.overview.requests) {
		if (request.state !== 'open') continue;
		openRequestCounts.set(
			request.engagementId,
			(openRequestCounts.get(request.engagementId) ?? 0) + 1
		);
	}

	const received: OrganizerEngagementFilesView[] = [...byEngagement.entries()]
		.map(([engagementId, items]) => ({
			engagementId,
			label: label(engagementId),
			items: items.sort(newestFirst),
			openRequestCount: openRequestCounts.get(engagementId) ?? 0
		}))
		.sort((left, right) => left.label.speaker.localeCompare(right.label.speaker));

	const audienceLabel = (share: ResourceShareDto): string => {
		switch (share.audience.kind) {
			case 'all_confirmed':
				return 'All confirmed speakers';
			case 'track':
				return input.trackNames.get(share.audience.trackId) ?? 'One track';
			case 'engagement': {
				const engagement = label(share.audience.engagementId);
				return `${engagement.speaker} · ${engagement.session}`;
			}
		}
	};

	const shares: OrganizerShareView[] = input.overview.shares
		.filter((share) => share.state === 'active')
		.map((share) => ({
			id: share.id,
			version: share.version,
			title: share.title,
			audience: share.audience,
			audienceLabel: audienceLabel(share),
			state: share.state,
			materials: (byShare.get(share.id) ?? []).sort(newestFirst)
		}))
		.sort((left, right) => left.title.localeCompare(right.title));

	const requests: OrganizerRequestView[] = [...input.overview.requests]
		.sort(requestOrder)
		.map((request) => {
			const deadline = request.deadlineId === null
				? null
				: deadlineChoice(input.catalog, request.deadlineId);
			return {
				id: request.id,
				version: request.version,
				engagementId: request.engagementId,
				engagementLabel: label(request.engagementId),
				what: request.what,
				instructions: request.instructions,
				state: request.state,
				deadline,
				overdue: request.state === 'open'
					&& deadline !== null
					&& Date.parse(deadline.effectiveAt) < input.now
			};
		});

	const deadlineChoices: DeadlineChoiceView[] = (input.catalog?.deadlines ?? [])
		.filter((head) => head.status === 'active')
		.map((head) => deadlineChoice(input.catalog, head.id))
		.filter((choice): choice is DeadlineChoiceView => choice !== null)
		.sort((left, right) => left.displayDate.localeCompare(right.displayDate));

	// Every engagement the roster names, plus any the overview already carries
	// material or asks for: an installation whose roster join is degraded still
	// offers the engagements it factually knows about, under their honest
	// short-id labels.
	const choiceIds = new Set<string>([
		...input.engagementLabels.keys(),
		...byEngagement.keys(),
		...input.overview.requests.map((request) => request.engagementId)
	]);
	const engagementChoices: EngagementChoiceView[] = [...choiceIds]
		.map((engagementId) => ({ engagementId, ...label(engagementId) }))
		.sort((left, right) => left.speaker.localeCompare(right.speaker)
			|| left.session.localeCompare(right.session));

	const trackChoices: TrackChoiceView[] = [...input.trackNames.entries()]
		.map(([trackId, name]) => ({ trackId, name }))
		.sort((left, right) => left.name.localeCompare(right.name));

	return { received, shares, requests, engagementChoices, deadlineChoices, trackChoices };
}
