import { describe, expect, test } from 'bun:test';
import { handleRequest } from './handler';

const environment = {
  ASSETS: {
    fetch: async () => new Response('<!doctype html><title>JooEvents</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }
} as Env;

describe('JooEvents splash Worker', () => {
  test('redirects www to the canonical apex', async () => {
    const response = await handleRequest(new Request('https://www.jooevents.com/demo?from=www'), environment);
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://jooevents.com/demo?from=www');
  });

  test('serves the splash with restrictive browser headers', async () => {
    const response = await handleRequest(new Request('https://jooevents.com/'), environment);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toContain('must-revalidate');
    expect(response.headers.get('link')).toBe('</llms.txt>; rel="describedby"');
  });

  test('revalidates stable stylesheet URLs after every deployment', async () => {
    const response = await handleRequest(new Request('https://jooevents.com/styles.css?v=20260813-2'), environment);
    const cacheControl = response.headers.get('cache-control');

    expect(cacheControl).toBe('public, max-age=0, must-revalidate');
    expect(cacheControl).not.toContain('stale-while-revalidate');
  });

  test('serves the discovery manifest as Markdown', async () => {
    const response = await handleRequest(new Request('https://jooevents.com/llms.txt'), environment);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  test('publishes a visible documentation entry point', async () => {
    const source = await Bun.file(new URL('../public/index.html', import.meta.url)).text();

    expect(source).toContain('href="https://docs.jooevents.com/"');
    expect(source).toContain('API documentation');
  });
});
