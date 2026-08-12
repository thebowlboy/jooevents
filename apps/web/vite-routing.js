import { BACKEND_ROUTE_PROXY_PATTERNS } from '@jooevents/contracts/route-namespaces';

/**
 * @param {string} [target]
 * @returns {Record<string, { target: string }>}
 */
export function createBackendProxyConfig(target = 'http://127.0.0.1:5177') {
  return Object.fromEntries(
    BACKEND_ROUTE_PROXY_PATTERNS.map((pattern) => [pattern, { target }])
  );
}
