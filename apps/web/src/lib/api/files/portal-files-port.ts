import { createContext } from 'svelte';
import type { FileLinkProvider } from '@jooevents/contracts/files';
import type { FilesCommandRefusalCode } from './wire';
import type { PortalMaterialsView } from './view-models';
import type { UploadProgress } from './upload-transfer';

/**
 * The speaker portal's files capability: the Materials section of one
 * engagement. Reads may throw (`PortalFilesReadError`) — the section renders
 * a failed state with retry. Changes never throw: every path resolves to a
 * typed outcome, because refusals render inline and the portal has no catch
 * boundary.
 */

/** One file as a surface hands it over, framework- and DOM-event-free. */
export interface UploadSourceFile {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly blob: Blob;
}

/**
 * Why a portal files change did not land, as a code. Sentences live with the
 * surface's reviewed copy; codes travel.
 */
export type PortalFilesRefusalReason =
	| FilesCommandRefusalCode
	/** The transfer of bytes itself failed; the file was not stored. */
	| 'upload_interrupted'
	/** This capability is not served by the composed manifest. */
	| 'not_served'
	/** The lane refused: not the participant's engagement, or access changed. */
	| 'not_yours'
	/** No trustworthy server answer exists; reload states where things stand. */
	| 'request_unconfirmed';

export type PortalFilesOutcome<Data = undefined> =
	| { readonly ok: true; readonly data: Data }
	| { readonly ok: false; readonly reason: PortalFilesRefusalReason };

export interface PortalUploadResult {
	/** The uploaded file, as the refreshed materials read will also report it. */
	readonly attachmentId: string;
	/** Null exactly for link attachments, which carry no blob. */
	readonly assetId: string | null;
	/** False when the upload landed but the named request could not be marked done. */
	readonly requestFulfilled: boolean;
}

export class PortalFilesReadError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(failure: { readonly code: string; readonly retryable: boolean }) {
		super(`portal files read failed: ${failure.code}`);
		this.name = 'PortalFilesReadError';
		this.code = failure.code;
		this.retryable = failure.retryable;
	}
}

export interface PortalFilesPort {
	/** The Materials projection for one engagement the participant is related to. */
	materials(engagementId: string): Promise<PortalMaterialsView>;

	/**
	 * The whole upload loop — register intent, stream bytes, confirm hash,
	 * attach to the engagement, and optionally fulfill one open request — as a
	 * single act with progress. Every refusal is a typed outcome.
	 */
	upload(input: {
		readonly engagementId: string;
		readonly file: UploadSourceFile;
		readonly request?: { readonly id: string; readonly version: number };
		readonly onProgress?: (progress: UploadProgress) => void;
	}): Promise<PortalFilesOutcome<PortalUploadResult>>;

	/** D6 link-attach: a typed https link, never fetched by the server. */
	attachLink(input: {
		readonly engagementId: string;
		readonly provider: FileLinkProvider;
		readonly label: string;
		readonly url: string;
		readonly request?: { readonly id: string; readonly version: number };
	}): Promise<PortalFilesOutcome<PortalUploadResult>>;

	/** The inert download route for one of this lane's assets; null when unserved. */
	downloadPath(assetId: string): string | null;
}

export const [usePortalFilesPort, setPortalFilesPort] = createContext<PortalFilesPort>();
