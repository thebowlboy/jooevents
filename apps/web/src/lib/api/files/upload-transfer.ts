import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * The byte lane of the D2 two-phase upload: after `file.upload.intent` admits
 * a file, its exact bytes stream to the intent's byte route, and the confirm
 * step then proves what was sent with the client's own SHA-256 of those same
 * bytes. Hashing is pure JS (`@noble/hashes`) on purpose — `crypto.subtle`
 * exists only in secure contexts, and the shared development origin is plain
 * HTTP, so a WebCrypto-only hash would silently fail exactly where the team
 * actually works.
 */

/** Streaming SHA-256 of a blob's bytes, hex-encoded lowercase. */
export async function sha256HexOfBlob(blob: Blob): Promise<string> {
	const hasher = sha256.create();
	const reader = blob.stream().getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		hasher.update(value);
	}
	return bytesToHex(hasher.digest());
}

export interface UploadProgress {
	readonly transferredBytes: number;
	readonly totalBytes: number;
}

export type UploadByteResult =
	| { readonly kind: 'stored' }
	| { readonly kind: 'failed'; readonly retryable: boolean };

export interface UploadByteTransfer {
	send(input: {
		readonly path: string;
		readonly blob: Blob;
		readonly contentType: string;
		readonly onProgress?: (progress: UploadProgress) => void;
	}): Promise<UploadByteResult>;
}

/**
 * XHR carries the bytes because it is the one browser transport with upload
 * progress events. Any 2xx answer means the server stored and hashed the
 * stream; everything else is a failure the caller reports in reviewed words —
 * response bodies are never interface copy.
 */
export function createXhrUploadByteTransfer(): UploadByteTransfer {
	return Object.freeze({
		send(input: {
			readonly path: string;
			readonly blob: Blob;
			readonly contentType: string;
			readonly onProgress?: (progress: UploadProgress) => void;
		}): Promise<UploadByteResult> {
			return new Promise((resolve) => {
				const request = new XMLHttpRequest();
				request.open('PUT', input.path);
				request.setRequestHeader('content-type', input.contentType);
				request.upload.onprogress = (event) => {
					if (!event.lengthComputable) return;
					input.onProgress?.({ transferredBytes: event.loaded, totalBytes: event.total });
				};
				request.onload = () => {
					if (request.status >= 200 && request.status < 300) {
						resolve({ kind: 'stored' });
						return;
					}
					resolve({ kind: 'failed', retryable: request.status >= 500 });
				};
				request.onerror = () => resolve({ kind: 'failed', retryable: true });
				request.ontimeout = () => resolve({ kind: 'failed', retryable: true });
				request.send(input.blob);
			});
		}
	});
}
