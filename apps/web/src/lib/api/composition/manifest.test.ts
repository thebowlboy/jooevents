import { afterEach, describe, expect, test } from 'bun:test';
import { loadLiveOperationManifest } from './manifest';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

afterEach(() => {
	globalThis.fetch = originalFetch;
	Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

function installBrowser(payload: unknown, status = 200): void {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { setTimeout, clearTimeout }
	});
	globalThis.fetch = Object.assign(
		async (request: RequestInfo | URL) => {
			expect(String(request)).toBe('/api/operations/manifest');
			return new Response(JSON.stringify(payload), {
				status,
				headers: { 'content-type': 'application/json' }
			});
		},
		{ preconnect: (_url: string | URL) => undefined }
	);
}

describe('live operation manifest client', () => {
	test('loads only a contract-valid relative-origin manifest', async () => {
		const manifest = {
			schemaVersion: 1 as const,
			registryDigestSha256: 'a'.repeat(64),
			operations: []
		};
		installBrowser(manifest);
		expect(await loadLiveOperationManifest()).toEqual({ kind: 'success', manifest });
	});

	test('keeps invalid or unavailable metadata in the transport branch', async () => {
		installBrowser({ unexpected: true });
		expect(await loadLiveOperationManifest()).toMatchObject({
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});
});
