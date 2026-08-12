import { afterEach, describe, expect, test } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKEND_ROUTE_NAMESPACES } from '@jooevents/contracts/route-namespaces';
import {
  createProductionRequestHandler,
  createRuntimeRequestHandler,
  resolveBunListenerConfiguration,
  StaticBuildError,
  type WebFetchHandler
} from './request-handler';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true });
  }
});

function buildFixture(): { readonly directory: string; readonly root: string } {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-static-routing-'));
  temporaryDirectories.push(directory);
  const root = join(directory, 'build');
  mkdirSync(join(root, '_app', 'immutable'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>JooEvents shell</title>');
  writeFileSync(join(root, 'robots.txt'), 'User-agent: *\nDisallow: /app\n');
  writeFileSync(join(root, '_app', 'immutable', 'app.A1B2.js'), 'globalThis.__assetLoaded = true;');
  return { directory, root };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://example.test${path}`, init);
}

describe('production request routing', () => {
  test('delegates every reserved root and subpath before the SPA fallback', async () => {
    const fixture = buildFixture();
    const observed: string[] = [];
    const backend: WebFetchHandler = (incoming) => {
      observed.push(new URL(incoming.url).pathname);
      return new Response('<!doctype html><title>unsafe backend fallback</title>', {
        status: 404,
        headers: { 'content-type': 'text/html', 'x-correlation-id': 'corr_route_404' }
      });
    };
    const handler = createProductionRequestHandler({ backend, buildDirectory: fixture.root });

    for (const namespace of BACKEND_ROUTE_NAMESPACES) {
      for (const path of [namespace.root, `${namespace.root}/unknown`]) {
        const response = await handler(request(path, { headers: { accept: 'text/html' } }));
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(response.headers.get('x-correlation-id')).toBe('corr_route_404');
        expect(await response.text()).not.toContain('JooEvents shell');
      }
    }

    expect(observed).toHaveLength(BACKEND_ROUTE_NAMESPACES.length * 2);
  });

  test('preserves a backend structured 404 and recognizes encoded namespace separators', async () => {
    const fixture = buildFixture();
    let calls = 0;
    const handler = createProductionRequestHandler({
      buildDirectory: fixture.root,
      backend: () => {
        calls += 1;
        return Response.json({ code: 'domain_record_not_found' }, { status: 404 });
      }
    });

    const response = await handler(request('/api%2Fmissing', { headers: { accept: 'text/html' } }));
    expect(calls).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'domain_record_not_found' });
  });

  test('serves real files before navigation fallback with deliberate cache policy', async () => {
    const fixture = buildFixture();
    const handler = createProductionRequestHandler({
      buildDirectory: fixture.root,
      backend: () => Response.json({ ok: true })
    });

    const asset = await handler(request('/_app/immutable/app.A1B2.js'));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toContain('__assetLoaded');

    const publicFile = await handler(request('/robots.txt', { headers: { accept: 'text/html' } }));
    expect(publicFile.status).toBe(200);
    expect(publicFile.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(await publicFile.text()).toContain('User-agent');
  });

  test('uses the shell only for non-backend GET or HEAD HTML navigations', async () => {
    const fixture = buildFixture();
    const handler = createProductionRequestHandler({
      buildDirectory: fixture.root,
      backend: () => Response.json({ code: 'unexpected_backend_call' }, { status: 500 })
    });

    for (const path of ['/', '/app/schedule', '/auth/complete', '/apiary', '/mcpp']) {
      const response = await handler(request(path, { headers: { accept: 'text/html,application/xhtml+xml' } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
      expect(await response.text()).toContain('JooEvents shell');
    }

    const head = await handler(request('/forms/application', { method: 'HEAD', headers: { accept: 'text/html' } }));
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');

    const dataRequest = await handler(request('/app/schedule', { headers: { accept: 'application/json' } }));
    expect(dataRequest.status).toBe(404);
    expect(dataRequest.headers.get('content-type')).toContain('text/plain');

    const htmlFetch = await handler(request('/app/schedule', {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'cors' }
    }));
    expect(htmlFetch.status).toBe(404);

    const post = await handler(request('/app/schedule', { method: 'POST', headers: { accept: 'text/html' } }));
    expect(post.status).toBe(404);
    expect(await post.text()).not.toContain('JooEvents shell');
  });

  test('refuses malformed paths, symlinks, and hardlinks instead of disclosing files', async () => {
    const fixture = buildFixture();
    const secret = join(fixture.directory, 'secret.txt');
    writeFileSync(secret, 'classified fixture value');
    symlinkSync(secret, join(fixture.root, 'linked.txt'));
    linkSync(secret, join(fixture.root, 'hardlinked.txt'));

    const handler = createProductionRequestHandler({
      buildDirectory: fixture.root,
      backend: () => Response.json({ ok: true })
    });

    for (const path of ['/linked.txt', '/hardlinked.txt']) {
      const response = await handler(request(path));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('classified fixture value');
    }

    const malformed = await handler(request('/api%5Cunknown', { headers: { accept: 'text/html' } }));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toContain('application/json');
    expect(await malformed.text()).not.toContain('JooEvents shell');
  });

  test('fails production composition when the static build or direct shell is absent', () => {
    const fixture = buildFixture();
    expect(() => createProductionRequestHandler({ backend: () => new Response(), buildDirectory: join(fixture.directory, 'missing') }))
      .toThrow(StaticBuildError);

    const noShell = join(fixture.directory, 'no-shell');
    mkdirSync(noShell);
    expect(() => createProductionRequestHandler({ backend: () => new Response(), buildDirectory: noShell }))
      .toThrow('index.html');
  });
});

describe('Bun runtime routing selection', () => {
  test('keeps development Hono-only on loopback and production one-origin on the public listener', async () => {
    expect(resolveBunListenerConfiguration({})).toEqual({
      mode: 'development',
      hostname: '127.0.0.1',
      port: 5177,
      development: true
    });
    expect(resolveBunListenerConfiguration({ NODE_ENV: 'production' })).toEqual({
      mode: 'production',
      hostname: '0.0.0.0',
      port: 5176,
      development: false
    });

    const backend: WebFetchHandler = () => Response.json({ source: 'hono' });
    const development = createRuntimeRequestHandler({
      mode: 'development',
      backend,
      buildDirectory: '/a/build/that/is/not-needed-in-development'
    });
    expect(development).toBe(backend);
    expect(await (await development(request('/app'))).json()).toEqual({ source: 'hono' });
  });

  test('accepts a bounded explicit port and rejects invalid values', () => {
    expect(resolveBunListenerConfiguration({ JOOEVENTS_INTERNAL_HTTP_PORT: '6200' }).port).toBe(6200);
    for (const value of ['0', '65536', '1.5', 'not-a-port']) {
      expect(() => resolveBunListenerConfiguration({ JOOEVENTS_INTERNAL_HTTP_PORT: value })).toThrow(
        'JOOEVENTS_INTERNAL_HTTP_PORT'
      );
    }
  });
});
