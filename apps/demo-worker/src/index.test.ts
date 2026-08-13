import { describe, expect, test } from 'bun:test';
import { handleDemoRequest, type DemoWorkerEnvironment } from './index';

function environment(): DemoWorkerEnvironment {
	return {
		ASSETS: {
			async fetch(request) {
				return new Response(`asset:${new URL(request.url).pathname}`, {
					headers: { 'Content-Type': 'text/html' }
				});
			}
		}
	};
}

describe('Cloudflare demo Worker', () => {
	test('redirects the root request into the login-free app', async () => {
		const response = await handleDemoRequest(new Request('https://demo.example/'), environment());
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://demo.example/app');
	});

	test('serves assets with private demo headers', async () => {
		const response = await handleDemoRequest(
			new Request('https://demo.example/app/schedule'),
			environment()
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('asset:/app/schedule');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
		expect(response.headers.get('www-authenticate')).toBeNull();
	});
});
