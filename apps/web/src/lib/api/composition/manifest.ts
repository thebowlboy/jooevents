import { safeOperationManifestSchema, type SafeOperationManifest } from '@jooevents/contracts';
import { requestJson, type SafeApiError } from '../client';

export type LiveOperationManifestResult =
	| { readonly kind: 'success'; readonly manifest: SafeOperationManifest }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError };

/** Loads the one browser-safe manifest emitted by the server's sealed registry. */
export async function loadLiveOperationManifest(
	options: { readonly signal?: AbortSignal } = {}
): Promise<LiveOperationManifestResult> {
	const response = await requestJson({
		path: '/api/operations/manifest',
		method: 'GET',
		schema: safeOperationManifestSchema,
		...(options.signal ? { signal: options.signal } : {})
	});
	return response.kind === 'success'
		? { kind: 'success', manifest: response.data }
		: { kind: 'transport_error', error: response.error };
}

/**
 * Loads the portal files registry's own browser-safe manifest. The portal
 * files operations share their names with the operator lane's, so they live
 * in a second sealed registry the main manifest cannot carry; before a
 * current event exists the endpoint answers not_available, which reads as the
 * same typed absence any unserved capability has.
 */
export async function loadPortalFilesOperationManifest(
	options: { readonly signal?: AbortSignal } = {}
): Promise<LiveOperationManifestResult> {
	const response = await requestJson({
		path: '/api/portal/files/operations/manifest',
		method: 'GET',
		schema: safeOperationManifestSchema,
		...(options.signal ? { signal: options.signal } : {})
	});
	return response.kind === 'success'
		? { kind: 'success', manifest: response.data }
		: { kind: 'transport_error', error: response.error };
}
