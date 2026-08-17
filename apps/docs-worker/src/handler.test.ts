import { describe, expect, test } from 'bun:test';
import { handleRequest } from './handler';

async function manifest(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

const environment = {
  ASSETS: {
    fetch: async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/missing') return new Response('Not found', { status: 404 });
      return new Response(`asset:${pathname}`, {
        headers: { 'content-type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }
      });
    }
  }
} as Env;

describe('JooEvents docs Worker', () => {
  test('serves canonical human pages with discovery and revalidation headers', async () => {
    const response = await handleRequest(new Request('https://docs.jooevents.com/agents/quickstart'), environment);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('asset:/agents/quickstart.html');
    expect(response.headers.get('link')).toContain('</llms.txt>; rel="describedby"');
    expect(response.headers.get('link')).toContain('</agents/quickstart.md>; rel="alternate"');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });

  test('serves Markdown with an explicit text/markdown type', async () => {
    const response = await handleRequest(new Request('https://docs.jooevents.com/agents/quickstart.md'), environment);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  test('redirects extension and trailing-slash variants to the canonical human URL', async () => {
    const extension = await handleRequest(new Request('https://docs.jooevents.com/agents/quickstart.html'), environment);
    const slash = await handleRequest(new Request('https://docs.jooevents.com/agents/quickstart/'), environment);

    expect(extension.status).toBe(308);
    expect(extension.headers.get('location')).toBe('https://docs.jooevents.com/agents/quickstart');
    expect(slash.status).toBe(308);
    expect(slash.headers.get('location')).toBe('https://docs.jooevents.com/agents/quickstart');
  });

  test('returns a real missing-asset response rather than an HTML fallback', async () => {
    const response = await handleRequest(new Request('https://docs.jooevents.com/missing'), environment);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  test('allows only GET and HEAD', async () => {
    const response = await handleRequest(new Request('https://docs.jooevents.com/llms.txt', { method: 'POST' }), environment);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  test('keeps public discovery manifests concise, absolute, and free of private paths', async () => {
    const [docsManifest, productManifest] = await Promise.all([
      manifest('../../../docs/llms.txt'),
      manifest('../../splash-worker/public/llms.txt')
    ]);

    for (const value of [docsManifest, productManifest]) {
      expect(value.startsWith('# ')).toBe(true);
      expect(value).toContain('\n## ');
      expect(value).not.toMatch(/private\/|mac-mini|sardine-lionfish/);
      for (const match of value.matchAll(/\]\(([^)]+)\)/g)) {
        expect(match[1]).toMatch(/^https:\/\//);
      }
    }
  });
});
