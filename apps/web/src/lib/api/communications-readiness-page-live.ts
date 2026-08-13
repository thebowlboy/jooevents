import type { CommunicationsProviderReadPort } from './communications-provider-read-port';
import {
	communicationsReadinessFailure,
	type CommunicationsReadinessPagePort
} from './communications-readiness-page-port';

/** Adapts only the mounted readiness read; it cannot reach connection setup or effects. */
export function createLiveCommunicationsReadinessPagePort(input: {
	readonly provider: Pick<CommunicationsProviderReadPort, 'source' | 'getReadiness'>;
}): CommunicationsReadinessPagePort {
	if (input.provider.source.kind !== 'live') {
		throw new TypeError('live_communications_readiness_source_required');
	}
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		async read(options: { readonly signal?: AbortSignal } = {}) {
			const result = await input.provider.getReadiness(
				{},
				options.signal ? { signal: options.signal } : {}
			);
			return result.kind === 'success' ? result : communicationsReadinessFailure(result);
		}
	});
}
