const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
} as const;

const htmlPages = new Map<string, string>([
  ['/', '/index.html'],
  ['/agents/quickstart', '/agents/quickstart.html'],
  ['/agents/operating-model', '/agents/operating-model.html'],
  ['/agents/recipes', '/agents/recipes.html']
]);

const markdownAlternates = new Map<string, string>([
  ['/', '/index.md'],
  ['/agents/quickstart', '/agents/quickstart.md'],
  ['/agents/operating-model', '/agents/operating-model.md'],
  ['/agents/recipes', '/agents/recipes.md']
]);

function canonicalPage(pathname: string): string | undefined {
  for (const [page, htmlAsset] of htmlPages) {
    if (pathname === htmlAsset) return page;
  }
  return undefined;
}

function assetRequest(request: Request, assetPath: string): Request {
  const url = new URL(request.url);
  url.pathname = assetPath;
  url.search = '';
  return new Request(url, request);
}

function contentTypeFor(pathname: string, fallback: string | null): string | null {
  if (pathname.endsWith('.md') || pathname.endsWith('.txt')) return 'text/markdown; charset=utf-8';
  return fallback;
}

function discoveryLink(pathname: string): string | undefined {
  const markdown = markdownAlternates.get(pathname);
  if (!markdown) return undefined;
  return `</llms.txt>; rel="describedby", <${markdown}>; rel="alternate"; type="text/markdown"`;
}

/** Serves public Markdown and compiled HTML docs without an SPA fallback. */
export async function handleRequest(request: Request, environment: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const url = new URL(request.url);
  const canonical = canonicalPage(url.pathname);
  if (canonical !== undefined) {
    url.pathname = canonical;
    return Response.redirect(url.toString(), 308);
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
    return Response.redirect(url.toString(), 308);
  }

  const assetPath = htmlPages.get(url.pathname) ?? url.pathname;
  const response = await environment.ASSETS.fetch(assetRequest(request, assetPath));
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  const contentType = contentTypeFor(assetPath, headers.get('content-type'));
  if (contentType !== null) headers.set('content-type', contentType);
  const link = discoveryLink(url.pathname);
  if (link !== undefined) headers.set('link', link);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
