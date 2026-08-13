import type { SafeApiError } from './client';
import type {
	CommunicationProviderReadResult,
	CommunicationsProviderReadPort
} from './communications-provider-read-port';
import type { EmailProviderReadinessView } from './view-models/communications-provider-read';

export type CommunicationsReadinessFailure =
	| {
			readonly kind: 'access_denied';
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'unavailable';
			readonly correlationId?: string;
	  }
	| {
			readonly kind: 'transport_error';
			readonly error: SafeApiError;
	  };

export type CommunicationsReadinessResult =
	| {
			readonly kind: 'success';
			readonly data: EmailProviderReadinessView;
			readonly correlationId: string;
	  }
	| CommunicationsReadinessFailure;

/** Narrow tuned-page capability: one factual read and no authoring or provider effects. */
export interface CommunicationsReadinessPagePort {
	readonly source: { readonly kind: 'live' };
	read(options?: { readonly signal?: AbortSignal }): Promise<CommunicationsReadinessResult>;
}

export function communicationsReadinessFailure(
	result: Exclude<
		Awaited<ReturnType<CommunicationsProviderReadPort['getReadiness']>>,
		{ readonly kind: 'success' }
	>
): CommunicationsReadinessFailure {
	if (result.kind === 'outcome') {
		return result.outcome.class === 'access_denied'
			? { kind: 'access_denied', correlationId: result.correlationId }
			: { kind: 'unavailable', correlationId: result.correlationId };
	}
	if (result.kind === 'unavailable') return { kind: 'unavailable' };
	return { kind: 'transport_error', error: result.error };
}

export type ProviderReadinessResult = CommunicationProviderReadResult<EmailProviderReadinessView>;
