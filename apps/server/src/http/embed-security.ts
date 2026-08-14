import {
  deriveSurfaceFrameAncestors,
  FRAME_ANCESTORS_DENY_ALL,
  surfaceKindSchema,
  type SurfaceKind
} from '@jooevents/contracts';

/**
 * Response framing policy for HTML documents served by the Bun runtime.
 *
 * Every HTML navigation carries an explicit `Content-Security-Policy:
 * frame-ancestors` response header: `/embed/<kind>` documents serve exactly
 * the surface's stored parent-origin allowlist, and every other HTML
 * document — the operator app, hosted public pages, unknown embed paths — is
 * `'none'`. The policy must be a response header; a `meta` policy cannot
 * carry `frame-ancestors` at all. Resolution fails closed: a missing surface,
 * an unknown kind, an empty allowlist, or a failing policy source all deny
 * framing rather than serving an unstated policy.
 */

/**
 * Reads the current stored framing allowlist for one surface kind, per
 * request — framing policy is mutable event configuration, so it is never
 * cached across requests here. `undefined` means the surface has never been
 * published and nothing may frame it.
 */
export interface EmbedFramingPolicySource {
  readSurfaceFrameOrigins(
    kind: SurfaceKind
  ): Promise<readonly string[] | undefined> | readonly string[] | undefined;
}

export type HtmlFramingClassification =
  | { readonly kind: 'embed'; readonly surfaceKind: SurfaceKind }
  | { readonly kind: 'embed_unknown' }
  | { readonly kind: 'app' };

/** Classifies one decoded pathname for framing purposes. */
export function classifyHtmlFramingPath(pathname: string): HtmlFramingClassification {
  if (pathname !== '/embed' && !pathname.startsWith('/embed/')) {
    return Object.freeze({ kind: 'app' });
  }
  const segment = pathname === '/embed'
    ? ''
    : pathname.slice('/embed/'.length).split('/', 1)[0] ?? '';
  const kind = surfaceKindSchema.safeParse(segment);
  return kind.success
    ? Object.freeze({ kind: 'embed', surfaceKind: kind.data })
    : Object.freeze({ kind: 'embed_unknown' });
}

/**
 * The deny-all header pair. `X-Frame-Options: DENY` accompanies exactly the
 * deny-all policy for legacy engines; it cannot express an allowlist, so an
 * allowlisted embed response carries the CSP header alone.
 */
export function denyAllHtmlSecurityHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    'content-security-policy': `frame-ancestors ${FRAME_ANCESTORS_DENY_ALL}`,
    'x-frame-options': 'DENY'
  });
}

/** Resolves the security headers one HTML document at `pathname` must carry. */
export async function resolveHtmlSecurityHeaders(input: {
  readonly pathname: string;
  readonly framing: EmbedFramingPolicySource;
}): Promise<Readonly<Record<string, string>>> {
  const classification = classifyHtmlFramingPath(input.pathname);
  if (classification.kind !== 'embed') return denyAllHtmlSecurityHeaders();
  let ancestors: string = FRAME_ANCESTORS_DENY_ALL;
  try {
    const origins = await input.framing.readSurfaceFrameOrigins(classification.surfaceKind);
    if (origins !== undefined) {
      ancestors = deriveSurfaceFrameAncestors({
        kind: classification.surfaceKind,
        allowedFrameOrigins: origins
      });
    }
  } catch {
    ancestors = FRAME_ANCESTORS_DENY_ALL;
  }
  return ancestors === FRAME_ANCESTORS_DENY_ALL
    ? denyAllHtmlSecurityHeaders()
    : Object.freeze({ 'content-security-policy': `frame-ancestors ${ancestors}` });
}

/** True when a `Content-Type` value names an HTML document. */
export function isHtmlResponseContentType(contentType: string | null): boolean {
  return contentType !== null
    && contentType.split(';', 1)[0]!.trim().toLowerCase() === 'text/html';
}

/** Stamps resolved security headers onto a response's header set. */
export function applyHtmlSecurityHeaders(
  headers: Headers,
  resolved: Readonly<Record<string, string>>
): void {
  for (const [name, value] of Object.entries(resolved)) headers.set(name, value);
}
