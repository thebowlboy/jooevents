export interface DemoWorkerEnvironment {
	readonly ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

function responseHeaders(response: Response): Headers {
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', 'private, no-store');
	headers.set('Content-Security-Policy', "frame-ancestors 'none'");
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	headers.set('Referrer-Policy', 'no-referrer');
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('X-Frame-Options', 'DENY');
	headers.set('X-Robots-Tag', 'noindex, nofollow');
	return headers;
}

export async function handleDemoRequest(
	request: Request,
	environment: DemoWorkerEnvironment
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/') {
		const location = new URL('/app', url);
		const response = Response.redirect(location, 302);
		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders(response)
		});
	}

	const asset = await environment.ASSETS.fetch(request);
	return new Response(asset.body, {
		status: asset.status,
		statusText: asset.statusText,
		headers: responseHeaders(asset)
	});
}

export default {
	fetch: handleDemoRequest
};
