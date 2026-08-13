import type {
	emailProviderConfigurationReadInputSchema,
	emailProviderReadinessGetInputSchema,
	StructuredOutcome
} from '@jooevents/contracts';
import type { z } from 'zod';
import type { SafeApiError } from './client';
import type { OperatorHttpBindingUnavailableReason } from './operations/operator-http-binding';
import type {
	EmailProviderConnectionView,
	EmailProviderReadinessView
} from './view-models/communications-provider-read';

export type EmailProviderConnectionReadRequest = z.input<
	typeof emailProviderConfigurationReadInputSchema
>;
export type EmailProviderReadinessReadRequest = z.input<
	typeof emailProviderReadinessGetInputSchema
>;

export type CommunicationProviderReadOperation =
	| 'communication.provider_connection.read'
	| 'communication.email_readiness.read';

export type CommunicationProviderReadUnavailable = {
	readonly kind: 'unavailable';
	readonly operation: CommunicationProviderReadOperation;
	readonly reason: OperatorHttpBindingUnavailableReason;
};

export type CommunicationProviderReadResult<Data> =
	| { readonly kind: 'success'; readonly data: Data; readonly correlationId: string }
	| { readonly kind: 'outcome'; readonly outcome: StructuredOutcome; readonly correlationId: string }
	| { readonly kind: 'transport_error'; readonly error: SafeApiError }
	| CommunicationProviderReadUnavailable;

/** Read-only, provider-neutral browser capability. It exposes no checks, tests, or sends. */
export interface CommunicationsProviderReadPort {
	readonly source: { readonly kind: 'live' };

	getConnection(
		input: EmailProviderConnectionReadRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationProviderReadResult<EmailProviderConnectionView>>;

	getReadiness(
		input?: EmailProviderReadinessReadRequest,
		options?: { readonly signal?: AbortSignal }
	): Promise<CommunicationProviderReadResult<EmailProviderReadinessView>>;
}
