import { describe, expect, test } from 'bun:test';
import {
  BACKEND_ROUTE_NAMESPACES,
  BACKEND_ROUTE_PROXY_PATTERNS,
  classifyRoutePath
} from './route-namespaces';

describe('reserved route namespace contract', () => {
  test('classifies every root and subpath without swallowing similar browser routes', () => {
    for (const namespace of BACKEND_ROUTE_NAMESPACES) {
      expect(classifyRoutePath(namespace.root)).toMatchObject({ kind: 'backend', namespace });
      expect(classifyRoutePath(`${namespace.root}/unknown`)).toMatchObject({ kind: 'backend', namespace });
      expect(classifyRoutePath(`${namespace.root}-browser-page`)).toEqual({
        kind: 'frontend',
        pathname: `${namespace.root}-browser-page`
      });
    }

    expect(classifyRoutePath('/')).toEqual({ kind: 'frontend', pathname: '/' });
    expect(classifyRoutePath('/app/schedule')).toEqual({ kind: 'frontend', pathname: '/app/schedule' });
  });

  test('classifies short sign-in link roots on segment boundaries only', () => {
    expect(classifyRoutePath('/a/xyz')).toMatchObject({
      kind: 'backend',
      namespace: { kind: 'auth-link', root: '/a' }
    });
    expect(classifyRoutePath('/p/xyz')).toMatchObject({
      kind: 'backend',
      namespace: { kind: 'portal-link', root: '/p' }
    });
    expect(classifyRoutePath('/about')).toEqual({ kind: 'frontend', pathname: '/about' });
    expect(classifyRoutePath('/apply')).toEqual({ kind: 'frontend', pathname: '/apply' });
    expect(classifyRoutePath('/app')).toEqual({ kind: 'frontend', pathname: '/app' });
    expect(classifyRoutePath('/portal')).toEqual({ kind: 'frontend', pathname: '/portal' });
  });

  test('recognizes one encoded path pass and fails malformed or backslash paths closed', () => {
    expect(classifyRoutePath('/%61pi/unknown')).toMatchObject({
      kind: 'backend',
      pathname: '/api/unknown',
      namespace: { kind: 'api', root: '/api' }
    });
    expect(classifyRoutePath('/api%2Funknown')).toMatchObject({ kind: 'backend', pathname: '/api/unknown' });
    expect(classifyRoutePath('/api%5Cunknown')).toEqual({ kind: 'invalid' });
    expect(classifyRoutePath('/api/%zz')).toEqual({ kind: 'invalid' });
    expect(classifyRoutePath('/api%3Fhidden')).toEqual({ kind: 'invalid' });
    expect(classifyRoutePath('//api/unknown')).toEqual({ kind: 'invalid' });
    expect(classifyRoutePath('api/unknown')).toEqual({ kind: 'invalid' });
  });

  test('derives boundary-aware Vite proxy patterns from the same namespace list', () => {
    expect(BACKEND_ROUTE_PROXY_PATTERNS).toHaveLength(BACKEND_ROUTE_NAMESPACES.length);

    for (const [index, namespace] of BACKEND_ROUTE_NAMESPACES.entries()) {
      const pattern = new RegExp(BACKEND_ROUTE_PROXY_PATTERNS[index]!);
      expect(pattern.test(namespace.root)).toBe(true);
      expect(pattern.test(`${namespace.root}?query=kept`)).toBe(true);
      expect(pattern.test(`${namespace.root}/child?query=kept`)).toBe(true);
      expect(pattern.test(`${namespace.root}%2Fchild`)).toBe(true);
      const encodedRoot = `${namespace.root.slice(0, 1)}%${namespace.root.charCodeAt(1).toString(16)}${namespace.root.slice(2)}`;
      expect(pattern.test(encodedRoot)).toBe(true);
      expect(pattern.test(`${namespace.root}-browser-page`)).toBe(false);
    }
  });
});
