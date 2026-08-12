export const BACKEND_ROUTE_NAMESPACES = [
  { kind: 'discovery', root: '/.well-known' },
  { kind: 'api', root: '/api' },
  { kind: 'mcp', root: '/mcp' },
  { kind: 'webhook', root: '/webhooks' },
  { kind: 'health', root: '/health' }
] as const;

export type BackendRouteNamespace = (typeof BACKEND_ROUTE_NAMESPACES)[number];
export type BackendRouteNamespaceKind = BackendRouteNamespace['kind'];
export type BackendRouteNamespaceRoot = BackendRouteNamespace['root'];

export type RoutePathClassification =
  | { readonly kind: 'backend'; readonly pathname: string; readonly namespace: BackendRouteNamespace }
  | { readonly kind: 'frontend'; readonly pathname: string }
  | { readonly kind: 'invalid' };

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodedBytePattern(character: string): string {
  const encoded = character.charCodeAt(0).toString(16).padStart(2, '0');
  return [...encoded].map((digit) => /[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit).join('');
}

function proxyRootPattern(root: BackendRouteNamespaceRoot): string {
  return [...root].map((character, index) => {
    if (index === 0) return '/';
    return `(?:${escapeRegularExpression(character)}|%${encodedBytePattern(character)})`;
  }).join('');
}

/**
 * Vite treats plain proxy keys as prefix matches. These boundary-aware patterns keep
 * similarly named browser routes such as `/apiary` and `/mcpp` in the frontend.
 */
export const BACKEND_ROUTE_PROXY_PATTERNS = BACKEND_ROUTE_NAMESPACES.map(
  ({ root }) => `^${proxyRootPattern(root)}(?:/|%2[fF]|\\?|$)`
) as readonly string[];

/** Classifies a URL pathname after one standards-compatible percent-decoding pass. */
export function classifyRoutePath(pathname: string): RoutePathClassification {
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) {
    return { kind: 'invalid' };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: 'invalid' };
  }

  if (
    !decoded.startsWith('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.includes('//') ||
    decoded.includes('?') ||
    decoded.includes('#') ||
    [...decoded].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return { kind: 'invalid' };
  }

  for (const namespace of BACKEND_ROUTE_NAMESPACES) {
    if (decoded === namespace.root || decoded.startsWith(`${namespace.root}/`)) {
      return { kind: 'backend', pathname: decoded, namespace };
    }
  }

  return { kind: 'frontend', pathname: decoded };
}
