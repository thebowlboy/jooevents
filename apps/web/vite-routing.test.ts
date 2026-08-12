import { describe, expect, test } from 'bun:test';
import { BACKEND_ROUTE_NAMESPACES } from '@jooevents/contracts/route-namespaces';
import { createBackendProxyConfig } from './vite-routing.js';

describe('Vite backend proxy routing', () => {
  test('proxies every reserved root and subpath to loopback without rewriting', () => {
    const proxy = createBackendProxyConfig();
    expect(Object.keys(proxy)).toHaveLength(BACKEND_ROUTE_NAMESPACES.length);

    for (const namespace of BACKEND_ROUTE_NAMESPACES) {
      const matchingEntry = Object.entries(proxy).find(([pattern]) => new RegExp(pattern).test(`${namespace.root}/kept/path?x=1`));
      expect(matchingEntry).toBeDefined();
      expect(matchingEntry?.[1]).toEqual({ target: 'http://127.0.0.1:5177' });
      expect(matchingEntry?.[1]).not.toHaveProperty('rewrite');
      expect(Object.keys(proxy).some((pattern) => new RegExp(pattern).test(`${namespace.root}?x=1`))).toBe(true);
    }
  });

  test('does not proxy namespace lookalikes that belong to browser navigation', () => {
    const patterns = Object.keys(createBackendProxyConfig());
    for (const namespace of BACKEND_ROUTE_NAMESPACES) {
      expect(patterns.some((pattern) => new RegExp(pattern).test(`${namespace.root}-browser-page`))).toBe(false);
    }
  });
});
