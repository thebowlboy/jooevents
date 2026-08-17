import {
	emailDeliverabilityCheckProjectionSchema,
	emailProviderDiagnosticTestProjectionSchema,
	emailProviderReadinessCheckProjectionSchema,
	emailSetupGuideProjectionSchema,
	type EmailDeliverabilityCheckProjection,
	type EmailProviderDiagnosticTestProjection,
	type EmailProviderReadinessCheckProjection,
	type EmailSetupGuideProjection
} from '@jooevents/contracts';
import { z } from 'zod';
import { requestJson, type ApiResult } from '../client';

/**
 * Browser client for the owner-lane provider-setup executors. These are the
 * hand-mounted external-effect routes (readiness check, diagnostic send,
 * advisory DNS deliverability, manifest setup guide) that exist only while a
 * provider is configured; an installation without one answers `not_available`
 * rather than pretending the capability exists.
 */

export type ProviderSetupResult<Data> =
	| { readonly kind: 'completed'; readonly data: Data }
	| { readonly kind: 'refused' }
	| { readonly kind: 'not_available' }
	| { readonly kind: 'transport_error'; readonly retryable: boolean };

export type ProviderTestSendResult =
	| ProviderSetupResult<EmailProviderDiagnosticTestProjection>
	| { readonly kind: 'invalid_recipient' };

/**
 * A configured provider whose from-address has no checkable public domain is
 * a completed advisory answer, not an absent capability — it must never be
 * folded into `not_available`, which surfaces claim means "no provider".
 */
export type ProviderDeliverabilityResult =
	| ProviderSetupResult<EmailDeliverabilityCheckProjection>
	| { readonly kind: 'sender_domain_unavailable' };

export interface CommunicationsProviderSetupPort {
	readonly source: { readonly kind: 'live' };
	getSetupGuide(options?: {
		readonly signal?: AbortSignal;
	}): Promise<ProviderSetupResult<EmailSetupGuideProjection>>;
	runReadinessCheck(options?: {
		readonly signal?: AbortSignal;
	}): Promise<ProviderSetupResult<EmailProviderReadinessCheckProjection>>;
	checkDeliverability(options?: {
		readonly signal?: AbortSignal;
	}): Promise<ProviderDeliverabilityResult>;
	sendDiagnosticTest(recipient: string, options?: {
		readonly signal?: AbortSignal;
	}): Promise<ProviderTestSendResult>;
}

/** Provider and DNS I/O run behind these routes; give them more than the default window. */
const EXECUTOR_TIMEOUT_MS = 25_000;

function failure(result: Extract<ApiResult<unknown>, { readonly kind: 'error' }>):
	| { readonly kind: 'refused' }
	| { readonly kind: 'not_available' }
	| { readonly kind: 'transport_error'; readonly retryable: boolean } {
	if (result.error.code === 'http_401' || result.error.code === 'http_403') {
		return { kind: 'refused' };
	}
	// An unmounted route (no configured provider) or its typed 409 refusal.
	// `route_not_found` is the backend's JSON 404 envelope for absent routes.
	if (
		result.error.code === 'route_not_found'
		|| result.error.code === 'http_404'
		|| result.error.code === 'http_409'
	) {
		return { kind: 'not_available' };
	}
	return { kind: 'transport_error', retryable: result.error.retryable };
}

async function execute<Wire, Data>(input: {
	readonly path: string;
	readonly method: 'GET' | 'POST';
	readonly schema: z.ZodType<Wire>;
	readonly unwrap: (wire: Wire) => Data;
	readonly body?: unknown;
	readonly signal?: AbortSignal;
}): Promise<ProviderSetupResult<Data>> {
	const result = await requestJson({
		path: input.path,
		method: input.method,
		schema: input.schema,
		timeoutMs: EXECUTOR_TIMEOUT_MS,
		...(input.body === undefined ? {} : { body: input.body }),
		...(input.signal ? { signal: input.signal } : {})
	});
	if (result.kind === 'error') return failure(result);
	return { kind: 'completed', data: input.unwrap(result.data) };
}

export function createCommunicationsProviderSetupLivePort(): CommunicationsProviderSetupPort {
	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		getSetupGuide(options = {}) {
			return execute({
				path: '/api/communications/email-setup-guide',
				method: 'GET',
				schema: z.object({
					kind: z.literal('completed'),
					guide: emailSetupGuideProjectionSchema
				}),
				unwrap: (wire) => wire.guide,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		runReadinessCheck(options = {}) {
			return execute({
				path: '/api/communications/email-readiness/check',
				method: 'POST',
				schema: z.object({
					kind: z.literal('completed'),
					check: emailProviderReadinessCheckProjectionSchema
				}),
				unwrap: (wire) => wire.check,
				...(options.signal ? { signal: options.signal } : {})
			});
		},

		async checkDeliverability(options = {}) {
			const result = await requestJson({
				path: '/api/communications/email-deliverability/check',
				method: 'POST',
				timeoutMs: EXECUTOR_TIMEOUT_MS,
				schema: z.union([
					z.object({
						kind: z.literal('completed'),
						deliverability: emailDeliverabilityCheckProjectionSchema
					}),
					z.object({ kind: z.literal('sender_domain_unavailable') })
				]),
				...(options.signal ? { signal: options.signal } : {})
			});
			if (result.kind === 'error') return failure(result);
			if (result.data.kind === 'sender_domain_unavailable') {
				return { kind: 'sender_domain_unavailable' as const };
			}
			return { kind: 'completed' as const, data: result.data.deliverability };
		},

		async sendDiagnosticTest(recipient: string, options = {}) {
			const result = await requestJson({
				path: '/api/communications/email-diagnostic/send-test',
				method: 'POST',
				body: { recipient },
				timeoutMs: EXECUTOR_TIMEOUT_MS,
				schema: z.object({
					kind: z.literal('completed'),
					diagnostic: emailProviderDiagnosticTestProjectionSchema
				}),
				...(options.signal ? { signal: options.signal } : {})
			});
			if (result.kind === 'error') {
				return result.error.code === 'http_422'
					? { kind: 'invalid_recipient' as const }
					: failure(result);
			}
			return { kind: 'completed' as const, data: result.data.diagnostic };
		}
	} satisfies CommunicationsProviderSetupPort);
}
