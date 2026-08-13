import { describe, expect, test } from 'bun:test';
import { organizerEmailReadinessProjectionSchema } from '@jooevents/contracts';
import type { CommunicationsProviderReadPort } from './communications-provider-read-port';
import { createLiveCommunicationsReadinessPagePort } from './communications-readiness-page-live';

const correlationId = '00000000-0000-4000-8000-000000000701';

const unconfigured = organizerEmailReadinessProjectionSchema.parse({
	schemaVersion: 1,
	outbound: { state: 'unknown', nextStepCode: 'configure_email_provider' },
	callbacks: { state: 'not_supported' },
	inbound: { state: 'not_enabled' }
});

function provider(
	result: Awaited<ReturnType<CommunicationsProviderReadPort['getReadiness']>>,
	calls: unknown[] = []
): Pick<CommunicationsProviderReadPort, 'source' | 'getReadiness'> {
	return {
		source: { kind: 'live' },
		async getReadiness(input, options) {
			calls.push({ input, options });
			return result;
		}
	};
}

describe('live Communications readiness page adapter', () => {
	test('preserves canonical provider absence and invokes only readiness', async () => {
		const calls: unknown[] = [];
		const port = createLiveCommunicationsReadinessPagePort({
			provider: provider({ kind: 'success', data: unconfigured, correlationId }, calls)
		});
		const signal = new AbortController().signal;

		const result = await port.read({ signal });

		expect(result).toEqual({ kind: 'success', data: unconfigured, correlationId });
		expect(result.kind === 'success' && 'provider' in result.data).toBe(false);
		expect(calls).toEqual([{ input: {}, options: { signal } }]);
		expect(Object.keys(port)).toEqual(['source', 'read']);
	});

	test('keeps access denial, unavailable bindings, and transport failure distinct', async () => {
		const denied = createLiveCommunicationsReadinessPagePort({
			provider: provider({
				kind: 'outcome', correlationId,
				outcome: {
					class: 'access_denied', kind: 'authority.permission_denied', retryable: false,
					subjects: [], detail: null, detailSchemaVersion: 1
				}
			})
		});
		const unavailable = createLiveCommunicationsReadinessPagePort({
			provider: provider({
				kind: 'unavailable',
				operation: 'communication.email_readiness.read',
				reason: 'operation_not_registered'
			})
		});
		const transport = createLiveCommunicationsReadinessPagePort({
			provider: provider({
				kind: 'transport_error',
				error: { code: 'network_unavailable', retryable: true, correlationId }
			})
		});

		expect(await denied.read()).toEqual({ kind: 'access_denied', correlationId });
		expect(await unavailable.read()).toEqual({ kind: 'unavailable' });
		expect(await transport.read()).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true, correlationId }
		});
	});
});
