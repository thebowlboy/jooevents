import { describe, expect, test } from 'bun:test';
import {
  acceptEmbedChildMessage,
  acceptEmbedHostMessage,
  deriveSurfaceFrameAncestors,
  embedChildMessageSchema,
  embedHostMessageSchema,
  FRAME_ANCESTORS_DENY_ALL,
  generateEmbedSnippet,
  type EmbedSnippetRequest,
  type SurfaceKind
} from './index';

const ORIGINS = ['https://conference.example.com', 'https://www.example.org'] as const;
const KINDS: readonly SurfaceKind[] = ['schedule', 'speakers', 'apply'];

describe('frame-ancestors derivation', () => {
  test('every surface kind is allowlist-only and an empty allowlist denies all', () => {
    for (const kind of KINDS) {
      expect(deriveSurfaceFrameAncestors({ kind, allowedFrameOrigins: [] }))
        .toBe(FRAME_ANCESTORS_DENY_ALL);
      expect(deriveSurfaceFrameAncestors({ kind, allowedFrameOrigins: ORIGINS }))
        .toBe('https://conference.example.com https://www.example.org');
    }
  });

  test('a non-normalized or wildcard entry fails the whole policy closed', () => {
    for (const poisoned of [
      ['https://conference.example.com', '*'],
      ['https://Conference.example.com'],
      ['https://conference.example.com/page'],
      ['conference.example.com'],
      // Header-significant bytes: ';' starts a directive, ',' splits policies.
      ['https://evil.example;x'],
      ['https://a,b.com', 'https://conference.example.com'],
      ['https://*.example.com']
    ]) {
      expect(deriveSurfaceFrameAncestors({ kind: 'apply', allowedFrameOrigins: poisoned }))
        .toBe(FRAME_ANCESTORS_DENY_ALL);
    }
  });

  test('an unknown kind denies all', () => {
    expect(deriveSurfaceFrameAncestors({
      kind: 'operator' as SurfaceKind,
      allowedFrameOrigins: ORIGINS
    })).toBe(FRAME_ANCESTORS_DENY_ALL);
  });
});

describe('embed message contract', () => {
  const envelope = { protocolVersion: 1, embedId: 'embed-1' } as const;

  test('frame messages carry only the presentation vocabulary', () => {
    expect(embedChildMessageSchema.safeParse({ kind: 'ready', ...envelope }).success).toBe(true);
    expect(embedChildMessageSchema.safeParse({
      kind: 'height_changed', ...envelope, heightPx: 640
    }).success).toBe(true);
    expect(embedChildMessageSchema.safeParse({
      kind: 'navigate', ...envelope, path: '/s/apply?scope=form:cfp-2026'
    }).success).toBe(true);
    expect(embedChildMessageSchema.safeParse({
      kind: 'submission_complete', ...envelope
    }).success).toBe(true);
  });

  test('non-presentation payloads are unrepresentable', () => {
    for (const smuggled of [
      { kind: 'ready', ...envelope, sessionToken: 'abc' },
      { kind: 'ready', ...envelope, formValues: { email: 'a@example.com' } },
      { kind: 'height_changed', ...envelope, heightPx: 640, css: 'body{}' },
      { kind: 'navigate', ...envelope, path: 'https://evil.example.com/phish' },
      { kind: 'navigate', ...envelope, path: '/api/public/schedule/current' },
      { kind: 'speaker_record', ...envelope, name: 'Ada' },
      { kind: 'height_changed', ...envelope, heightPx: 10_000_000 },
      { kind: 'ready', protocolVersion: 2, embedId: 'embed-1' }
    ]) {
      expect(embedChildMessageSchema.safeParse(smuggled).success).toBe(false);
    }
    expect(embedHostMessageSchema.safeParse({
      kind: 'host_context', ...envelope, colorScheme: 'dark', locale: 'en-GB'
    }).success).toBe(true);
    for (const smuggled of [
      { kind: 'host_context', ...envelope, colorScheme: 'dark', locale: null, css: '.x{}' },
      { kind: 'host_context', ...envelope, colorScheme: '#ff0000', locale: null },
      { kind: 'set_cookie', ...envelope, value: 'session=1' }
    ]) {
      expect(embedHostMessageSchema.safeParse(smuggled).success).toBe(false);
    }
  });

  test('acceptance requires the exact configured origin in both directions', () => {
    const message = { kind: 'ready', ...envelope };
    expect(acceptEmbedChildMessage({
      data: message,
      senderOrigin: 'https://events.example.com',
      embedOrigin: 'https://events.example.com'
    }).kind).toBe('accepted');
    expect(acceptEmbedChildMessage({
      data: message,
      senderOrigin: 'https://evil.example.com',
      embedOrigin: 'https://events.example.com'
    })).toEqual({ kind: 'refused', code: 'origin_mismatch' });
    expect(acceptEmbedChildMessage({
      data: message,
      senderOrigin: 'https://events.example.com',
      embedOrigin: '*'
    })).toEqual({ kind: 'refused', code: 'origin_mismatch' });
    expect(acceptEmbedChildMessage({
      data: { ...message, extra: true },
      senderOrigin: 'https://events.example.com',
      embedOrigin: 'https://events.example.com'
    })).toEqual({ kind: 'refused', code: 'message_invalid' });
    expect(acceptEmbedHostMessage({
      data: { kind: 'host_context', ...envelope, colorScheme: null, locale: null },
      senderOrigin: 'https://conference.example.com',
      hostOrigin: 'https://conference.example.com'
    }).kind).toBe('accepted');
    expect(acceptEmbedHostMessage({
      data: { kind: 'host_context', ...envelope, colorScheme: null, locale: null },
      senderOrigin: 'https://conference.example.com',
      hostOrigin: 'https://other.example.com'
    })).toEqual({ kind: 'refused', code: 'origin_mismatch' });
  });
});

describe('embed snippet generator', () => {
  const request = (overrides: Partial<EmbedSnippetRequest> = {}): EmbedSnippetRequest => ({
    kind: 'schedule',
    delivery: 'frame',
    scope: null,
    frameTitle: 'Conference schedule',
    maxWidthPx: null,
    align: 'start',
    ...overrides
  });

  test('emits snippets exactly when the derived framing policy admits a page', () => {
    for (const kind of KINDS) {
      const refused = generateEmbedSnippet({
        productOrigin: 'https://events.example.com',
        request: request({ kind }),
        allowedFrameOrigins: []
      });
      expect(refused).toEqual({ kind: 'refused', code: 'allowlist_empty' });
      const generated = generateEmbedSnippet({
        productOrigin: 'https://events.example.com',
        request: request({ kind }),
        allowedFrameOrigins: ORIGINS
      });
      expect(generated.kind).toBe('generated');
      expect(
        deriveSurfaceFrameAncestors({ kind, allowedFrameOrigins: ORIGINS })
      ).not.toBe(FRAME_ANCESTORS_DENY_ALL);
    }
  });

  test('frame snippets point at the embed document with its floor height', () => {
    const outcome = generateEmbedSnippet({
      productOrigin: 'https://events.example.com/',
      request: request({ kind: 'apply', scope: 'form:cfp-2026', maxWidthPx: 720, align: 'center' }),
      allowedFrameOrigins: ORIGINS
    });
    if (outcome.kind !== 'generated') throw new Error('expected a generated snippet');
    expect(outcome.embedUrl).toBe('https://events.example.com/embed/apply?scope=form%3Acfp-2026');
    expect(outcome.standaloneUrl).toBe('https://events.example.com/s/apply?scope=form%3Acfp-2026');
    expect(outcome.frameMinHeightPx).toBe(900);
    expect(outcome.loaderSnippet).toBeNull();
    expect(outcome.snippet).toContain('min-height:900px');
    expect(outcome.snippet).toContain('max-width:720px');
    expect(outcome.snippet).toContain('title="Conference schedule"');
    expect(outcome.snippet).not.toContain('https://conference.example.com');
  });

  test('inline snippets pair the element with the once-per-page loader', () => {
    const outcome = generateEmbedSnippet({
      productOrigin: 'https://events.example.com',
      request: request({ delivery: 'inline', scope: 'day:2026-11-01' }),
      allowedFrameOrigins: ORIGINS
    });
    if (outcome.kind !== 'generated') throw new Error('expected a generated snippet');
    expect(outcome.loaderSnippet)
      .toBe('<script src="https://events.example.com/embed/v1/joo-embed.js" async></script>');
    expect(outcome.snippet.startsWith('<joo-embed ')).toBe(true);
    expect(outcome.snippet).toContain('scope="day:2026-11-01"');
    expect(outcome.snippet.endsWith('</joo-embed>')).toBe(true);
  });

  test('refuses invalid inputs in place instead of emitting broken code', () => {
    const refusal = (overrides: {
      productOrigin?: string;
      request?: Partial<EmbedSnippetRequest>;
      allowedFrameOrigins?: readonly string[];
    }) => generateEmbedSnippet({
      productOrigin: overrides.productOrigin ?? 'https://events.example.com',
      request: request(overrides.request ?? {}),
      allowedFrameOrigins: overrides.allowedFrameOrigins ?? ORIGINS
    });
    expect(refusal({ productOrigin: 'javascript:alert(1)' }))
      .toEqual({ kind: 'refused', code: 'product_origin_invalid' });
    expect(refusal({ allowedFrameOrigins: ['https://Conference.example.com'] }))
      .toEqual({ kind: 'refused', code: 'allowlist_invalid' });
    expect(refusal({ request: { scope: '<img onerror=x>' } }))
      .toEqual({ kind: 'refused', code: 'scope_invalid' });
    expect(refusal({ request: { frameTitle: '   ' } }))
      .toEqual({ kind: 'refused', code: 'frame_title_invalid' });
    expect(refusal({ request: { maxWidthPx: 10 } }))
      .toEqual({ kind: 'refused', code: 'max_width_invalid' });
  });

  test('a title with markup in it never becomes markup', () => {
    const outcome = generateEmbedSnippet({
      productOrigin: 'https://events.example.com',
      request: request({ frameTitle: 'Schedule "<script>"' }),
      allowedFrameOrigins: ORIGINS
    });
    if (outcome.kind !== 'generated') throw new Error('expected a generated snippet');
    expect(outcome.snippet).toContain('title="Schedule &quot;&lt;script&gt;&quot;"');
    expect(outcome.snippet).not.toContain('<script>');
  });
});
