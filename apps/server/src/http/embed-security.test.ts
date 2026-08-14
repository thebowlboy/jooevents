import { describe, expect, test } from 'bun:test';
import type { SurfaceKind } from '@jooevents/contracts';
import {
  applyHtmlSecurityHeaders,
  classifyHtmlFramingPath,
  denyAllHtmlSecurityHeaders,
  isHtmlResponseContentType,
  resolveHtmlSecurityHeaders,
  type EmbedFramingPolicySource
} from './embed-security';

const ORIGINS = ['https://conference.example.com', 'https://www.example.org'] as const;

function framingWith(
  lists: Partial<Record<SurfaceKind, readonly string[]>>
): EmbedFramingPolicySource {
  return {
    readSurfaceFrameOrigins(kind) {
      return lists[kind];
    }
  };
}

describe('HTML framing path classification', () => {
  test('recognizes exactly the embed surface kinds', () => {
    expect(classifyHtmlFramingPath('/embed/schedule'))
      .toEqual({ kind: 'embed', surfaceKind: 'schedule' });
    expect(classifyHtmlFramingPath('/embed/speakers/anything'))
      .toEqual({ kind: 'embed', surfaceKind: 'speakers' });
    expect(classifyHtmlFramingPath('/embed/apply'))
      .toEqual({ kind: 'embed', surfaceKind: 'apply' });
    expect(classifyHtmlFramingPath('/embed')).toEqual({ kind: 'embed_unknown' });
    expect(classifyHtmlFramingPath('/embed/')).toEqual({ kind: 'embed_unknown' });
    expect(classifyHtmlFramingPath('/embed/v1/joo-embed.js')).toEqual({ kind: 'embed_unknown' });
    expect(classifyHtmlFramingPath('/embed/operator')).toEqual({ kind: 'embed_unknown' });
    for (const path of ['/', '/app/schedule', '/s/schedule', '/embedded', '/forms/apply']) {
      expect(classifyHtmlFramingPath(path)).toEqual({ kind: 'app' });
    }
  });
});

describe('HTML security header resolution', () => {
  test('embed documents serve the surface allowlist; empty or absent denies all', async () => {
    const framing = framingWith({ schedule: ORIGINS, speakers: [] });
    expect(await resolveHtmlSecurityHeaders({ pathname: '/embed/schedule', framing })).toEqual({
      'content-security-policy':
        'frame-ancestors https://conference.example.com https://www.example.org'
    });
    // Empty allowlist: deny-all, with the legacy header alongside.
    expect(await resolveHtmlSecurityHeaders({ pathname: '/embed/speakers', framing }))
      .toEqual(denyAllHtmlSecurityHeaders());
    // Never-published surface (no stored head): deny-all.
    expect(await resolveHtmlSecurityHeaders({ pathname: '/embed/apply', framing }))
      .toEqual(denyAllHtmlSecurityHeaders());
  });

  test('every kind is allowlist-gated the same way', async () => {
    for (const kind of ['schedule', 'speakers', 'apply'] as const) {
      const denied = await resolveHtmlSecurityHeaders({
        pathname: `/embed/${kind}`,
        framing: framingWith({ [kind]: [] })
      });
      expect(denied).toEqual(denyAllHtmlSecurityHeaders());
      const allowed = await resolveHtmlSecurityHeaders({
        pathname: `/embed/${kind}`,
        framing: framingWith({ [kind]: ORIGINS })
      });
      expect(allowed).toEqual({
        'content-security-policy':
          'frame-ancestors https://conference.example.com https://www.example.org'
      });
      expect('x-frame-options' in allowed).toBe(false);
    }
  });

  test('non-embed HTML and unknown embed paths always deny framing', async () => {
    const framing = framingWith({ schedule: ORIGINS, speakers: ORIGINS, apply: ORIGINS });
    for (const pathname of ['/', '/app/settings', '/s/schedule', '/embed', '/embed/unknown']) {
      expect(await resolveHtmlSecurityHeaders({ pathname, framing }))
        .toEqual(denyAllHtmlSecurityHeaders());
    }
  });

  test('a corrupt stored list or a failing source fails closed', async () => {
    expect(await resolveHtmlSecurityHeaders({
      pathname: '/embed/schedule',
      framing: framingWith({ schedule: ['https://conference.example.com', '*'] })
    })).toEqual(denyAllHtmlSecurityHeaders());
    // Entries carrying header-significant bytes must never reach the header:
    // ';' would graft a directive, ',' would split the policy in two.
    expect(await resolveHtmlSecurityHeaders({
      pathname: '/embed/apply',
      framing: framingWith({ apply: ['https://evil.example;x'] })
    })).toEqual(denyAllHtmlSecurityHeaders());
    expect(await resolveHtmlSecurityHeaders({
      pathname: '/embed/apply',
      framing: framingWith({ apply: ['https://a,b.com', 'https://partner.example.com'] })
    })).toEqual(denyAllHtmlSecurityHeaders());
    expect(await resolveHtmlSecurityHeaders({
      pathname: '/embed/schedule',
      framing: {
        readSurfaceFrameOrigins() {
          throw new Error('database unavailable');
        }
      }
    })).toEqual(denyAllHtmlSecurityHeaders());
  });

  test('headers stamp HTML responses only', () => {
    expect(isHtmlResponseContentType('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlResponseContentType('TEXT/HTML')).toBe(true);
    expect(isHtmlResponseContentType('application/javascript')).toBe(false);
    expect(isHtmlResponseContentType('text/plain; charset=utf-8')).toBe(false);
    expect(isHtmlResponseContentType(null)).toBe(false);
    const headers = new Headers({ 'content-type': 'text/html' });
    applyHtmlSecurityHeaders(headers, denyAllHtmlSecurityHeaders());
    expect(headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(headers.get('x-frame-options')).toBe('DENY');
  });
});
