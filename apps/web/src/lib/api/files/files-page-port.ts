import type { FileLinkProvider, ResourceShareAudienceDto } from '@jooevents/contracts/files';
import type { FilesCommandRefusalCode } from './wire';
import type { OrganizerFilesView } from './view-models';
import type { UploadProgress } from './upload-transfer';
import type { UploadSourceFile } from './portal-files-port';

/**
 * The organizer Files surface: everything received against this event,
 * organizer-shared resources with their audiences, and the typed asks (D9
 * file requests) riding the existing deadline catalog.
 *
 * Reads throw `FilesPageReadError`; the page renders a retryable failed
 * state. Commands resolve typed outcomes and never throw — refusals are
 * ordinary answers the surface must show in place.
 */

export type FilesPageRefusalReason =
	| FilesCommandRefusalCode
	| 'upload_interrupted'
	| 'not_served'
	| 'not_authorized'
	/** The workspace has no current event to attach files to. */
	| 'event_required'
	| 'request_unconfirmed';

export type FilesPageOutcome<Data = undefined> =
	| { readonly ok: true; readonly data: Data }
	| { readonly ok: false; readonly reason: FilesPageRefusalReason };

export class FilesPageReadError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(failure: { readonly code: string; readonly retryable: boolean }) {
		super(`files page read failed: ${failure.code}`);
		this.name = 'FilesPageReadError';
		this.code = failure.code;
		this.retryable = failure.retryable;
	}
}

export interface FilesPagePort {
	/** The joined surface view: received uploads, shares, requests, and composer choices. */
	read(): Promise<OrganizerFilesView>;

	createRequest(input: {
		readonly engagementId: string;
		readonly what: string;
		readonly instructions: string | null;
		readonly deadlineId: string | null;
	}): Promise<FilesPageOutcome>;

	withdrawRequest(input: {
		readonly requestId: string;
		readonly expectedVersion: number;
	}): Promise<FilesPageOutcome>;

	/** Creates the share record; materials attach separately and recoverably. */
	createShare(input: {
		readonly title: string;
		readonly audience: ResourceShareAudienceDto;
	}): Promise<FilesPageOutcome<{ readonly shareId: string }>>;

	revokeShare(input: {
		readonly shareId: string;
		readonly expectedVersion: number;
	}): Promise<FilesPageOutcome>;

	/** Uploads one file (organizer caps) and attaches it to the share. */
	uploadShareFile(input: {
		readonly shareId: string;
		readonly file: UploadSourceFile;
		readonly onProgress?: (progress: UploadProgress) => void;
	}): Promise<FilesPageOutcome>;

	attachShareLink(input: {
		readonly shareId: string;
		readonly provider: FileLinkProvider;
		readonly label: string;
		readonly url: string;
	}): Promise<FilesPageOutcome>;

	/** Detach is the compensation of attach; blobs stay refcounted (D7). */
	detach(input: {
		readonly attachmentId: string;
		readonly expectedVersion: number;
	}): Promise<FilesPageOutcome>;

	/** Re-attach one already-confirmed asset — the undo of a file detach. */
	reattach(input: {
		readonly subject:
			| { readonly kind: 'engagement'; readonly engagementId: string }
			| { readonly kind: 'resource_share'; readonly resourceShareId: string };
		readonly assetId: string;
	}): Promise<FilesPageOutcome>;

	/** Re-attach one link — the undo of a link detach. */
	relink(input: {
		readonly subject:
			| { readonly kind: 'engagement'; readonly engagementId: string }
			| { readonly kind: 'resource_share'; readonly resourceShareId: string };
		readonly provider: FileLinkProvider;
		readonly label: string;
		readonly url: string;
	}): Promise<FilesPageOutcome>;

	/** The inert download route for one asset; null when unserved. */
	downloadPath(assetId: string): string | null;
}
