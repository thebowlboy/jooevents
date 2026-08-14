import { describe, expect, test } from 'bun:test';
import {
	DEV_ISSUED_LINK_PATH,
	fetchDevIssuedLink,
	type DevIssuedLinkRequester
} from './dev-issued-link';

function stubRequester(payload: unknown) {
	const calls: { path: string; method: string; body: unknown }[] = [];
	const request: DevIssuedLinkRequester = async (input) => {
		calls.push({ path: input.path, method: input.method, body: input.body });
		if (payload === null) {
			return { kind: 'error', error: { code: 'http_404', retryable: false } };
		}
		const parsed = input.schema.safeParse(payload);
		if (!parsed.success) {
			return { kind: 'error', error: { code: 'invalid_contract', retryable: true } };
		}
		return { kind: 'success', data: parsed.data };
	};
	return { calls, request };
}

describe('dev issued-link fixture control', () => {
	test('outside a dev build it is inert: no request is ever made', async () => {
		const { calls, request } = stubRequester({ kind: 'none' });
		// bun test runs without Vite's dev flag, so the default guard is the
		// production answer — exactly the posture a live build ships with.
		expect(await fetchDevIssuedLink({ email: 'maya@example.test' }, { request })).toEqual({
			kind: 'unavailable',
			reason: 'not_dev_build'
		});
		expect(
			await fetchDevIssuedLink(
				{ email: 'maya@example.test' },
				{ request, isDevBuild: () => false }
			)
		).toEqual({ kind: 'unavailable', reason: 'not_dev_build' });
		expect(calls).toHaveLength(0);
	});

	test('in a dev build it posts the address to the fixture-control path', async () => {
		const issued = {
			kind: 'issued',
			url: '/portal/auth/complete?token=plt1_example',
			expiresAt: '2026-08-14T12:15:00.000Z'
		};
		const { calls, request } = stubRequester(issued);
		expect(
			await fetchDevIssuedLink(
				{ email: 'maya@example.test' },
				{ request, isDevBuild: () => true }
			)
		).toEqual(issued as never);
		expect(calls).toEqual([
			{
				path: DEV_ISSUED_LINK_PATH,
				method: 'POST',
				body: { email: 'maya@example.test' }
			}
		]);
	});

	test('no live challenge is an honest none, not an error', async () => {
		const { request } = stubRequester({ kind: 'none' });
		expect(
			await fetchDevIssuedLink(
				{ email: 'maya@example.test' },
				{ request, isDevBuild: () => true }
			)
		).toEqual({ kind: 'none' });
	});

	test('only same-origin completion paths qualify for the dev affordance to follow', async () => {
		const { isPortalCompletionPath } = await import('./dev-issued-link');
		expect(isPortalCompletionPath('/portal/auth/complete?token=plt1_x')).toBe(true);
		expect(isPortalCompletionPath('https://evil.example/portal/auth/complete?token=x')).toBe(false);
		expect(isPortalCompletionPath('//evil.example/portal/auth/complete?token=x')).toBe(false);
		expect(isPortalCompletionPath('/portal/auth/complete')).toBe(false);
		expect(isPortalCompletionPath('/app')).toBe(false);
	});

	test('a missing control route stays a transport error, never a fabricated link', async () => {
		const { request } = stubRequester(null);
		expect(
			await fetchDevIssuedLink(
				{ email: 'maya@example.test' },
				{ request, isDevBuild: () => true }
			)
		).toEqual({
			kind: 'transport_error',
			error: { code: 'http_404', retryable: false }
		});
	});
});
