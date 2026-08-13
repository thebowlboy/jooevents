const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
} as const;

export async function handleRequest(request: Request, environment: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === 'www.jooevents.com') {
    url.hostname = 'jooevents.com';
    return Response.redirect(url.toString(), 308);
  }

  const response = await environment.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);

  // Public asset names are stable, so revalidate every response to avoid serving
  // a new document with stale CSS after a deployment.
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
