import type { SafeApiError } from '../../client';
import {
	createPortalOperationsLiveClient,
	type PortalLiveRequester,
	type PortalOperationsLiveClient
} from './operations-client';

/**
 * A `PortalOperationsLiveClient` over a manifest that has not been fetched
 * yet. The portal root must set its gateway synchronously during component
 * init, before any asynchronous work can finish, so the manifest read is
 * folded into the first operation call instead: one loader run is shared by
 * every concurrent caller, a loaded manifest is kept for the session, and a
 * failed load is answered as the honest transport error of the call that hit
 * it — then retried by the next call rather than freezing the portal behind
 * one bad read.
 */

export type PortalManifestLoadResult =
	| { readonly kind: 'success'; readonly manifest: unknown }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError };

export function createDeferredPortalOperationsClient(input: {
	readonly loadManifest: () => Promise<PortalManifestLoadResult>;
	readonly request?: PortalLiveRequester;
}): PortalOperationsLiveClient {
	let pending: Promise<
		| { readonly kind: 'ready'; readonly client: PortalOperationsLiveClient }
		| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	> | null = null;

	function resolveClient() {
		pending ??= input.loadManifest().then(
			(result) => {
				if (result.kind !== 'success') {
					// The next call gets a fresh chance instead of a cached failure.
					pending = null;
					return { kind: 'transport_error' as const, error: result.error };
				}
				return {
					kind: 'ready' as const,
					client: createPortalOperationsLiveClient({
						manifest: result.manifest,
						...(input.request ? { request: input.request } : {})
					})
				};
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

	const deferred: PortalOperationsLiveClient = {
		async readSnapshot(options: { readonly signal?: AbortSignal } = {}) {
			const resolution = await resolveClient();
			if (resolution.kind === 'transport_error') {
				return { kind: 'transport_error', error: resolution.error };
			}
			return resolution.client.readSnapshot(options);
		},
		async respondToEngagement(
			request: Parameters<PortalOperationsLiveClient['respondToEngagement']>[0],
			idempotencyKey: string,
			options: { readonly signal?: AbortSignal } = {}
		) {
			const resolution = await resolveClient();
			if (resolution.kind === 'transport_error') {
				return { kind: 'transport_error', error: resolution.error };
			}
			return resolution.client.respondToEngagement(request, idempotencyKey, options);
		}
	};
	return Object.freeze(deferred);
}
