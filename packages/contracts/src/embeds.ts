import { z } from 'zod';
import {
  normalizeEmbedFrameOrigin,
  surfaceKindSchema,
  type SurfaceKind
} from './releases';

/**
 * Embed delivery contract: the response framing policy for `/embed/*`
 * documents, the versioned parent↔frame message vocabulary, and the pasteable
 * snippet an organizer copies. Everything here is pure and deterministic — an
 * embed is never a stored record; the only persisted framing fact is the
 * per-surface origin allowlist on the surface head.
 */

/** The custom element's tag, and the one script that defines it. */
export const EMBED_ELEMENT_TAG = 'joo-embed';
export const EMBED_LOADER_PATH = '/embed/v1/joo-embed.js';

/** Route root for embedded surface documents; kinds are the path segments. */
export const EMBED_ROUTE_PREFIX = '/embed';
/** Route root for the hosted standalone pages the same surfaces publish. */
export const HOSTED_SURFACE_ROUTE_PREFIX = '/s';

export function embedDocumentPath(kind: SurfaceKind): string {
  return `${EMBED_ROUTE_PREFIX}/${surfaceKindSchema.parse(kind)}`;
}

export function hostedSurfacePath(kind: SurfaceKind): string {
  return `${HOSTED_SURFACE_ROUTE_PREFIX}/${surfaceKindSchema.parse(kind)}`;
}

/**
 * The value of a `Content-Security-Policy: frame-ancestors` directive that
 * permits framing by no one.
 */
export const FRAME_ANCESTORS_DENY_ALL = "'none'";

/**
 * Derives the `frame-ancestors` source list one surface's embed documents
 * must serve. Every surface kind is allowlist-only: the surface's configured
 * parent origins are the whole policy, an empty allowlist denies all framing,
 * and any entry that is not exactly a normalized origin fails the whole
 * policy closed rather than serving a partially trusted list.
 */
export function deriveSurfaceFrameAncestors(input: {
  readonly kind: SurfaceKind;
  readonly allowedFrameOrigins: readonly string[];
}): string {
  const kind = surfaceKindSchema.safeParse(input.kind);
  if (!kind.success) return FRAME_ANCESTORS_DENY_ALL;
  if (input.allowedFrameOrigins.length === 0) return FRAME_ANCESTORS_DENY_ALL;
  for (const origin of input.allowedFrameOrigins) {
    const normalization = normalizeEmbedFrameOrigin(origin);
    if (normalization.kind !== 'normalized' || normalization.origin !== origin) {
      return FRAME_ANCESTORS_DENY_ALL;
    }
  }
  return input.allowedFrameOrigins.join(' ');
}

/**
 * The versioned parent↔frame message vocabulary. Messages are presentation
 * only: readiness, a validated height, a navigation intent toward the hosted
 * page, a completion notice, and constrained host display context. Every
 * message names its protocol version and embed instance; the strict shapes
 * make a session, token, form value, speaker record, or style payload
 * unrepresentable.
 */
export const EMBED_MESSAGE_PROTOCOL_VERSION = 1 as const;

export const embedInstanceIdSchema = z.string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

const embedMessageEnvelopeFields = {
  protocolVersion: z.literal(EMBED_MESSAGE_PROTOCOL_VERSION),
  embedId: embedInstanceIdSchema
} as const;

/** A navigation intent may only point at a hosted surface page. */
export const embedNavigationPathSchema = z.string().max(160)
  .regex(/^\/s\/(schedule|speakers|apply)(\?scope=[a-z]+:[A-Za-z0-9._-]{1,64})?$/);

export const EMBED_HEIGHT_MAX_PX = 20_000;

/** Frame → host messages. */
export const embedChildMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), ...embedMessageEnvelopeFields }),
  z.strictObject({
    kind: z.literal('height_changed'),
    ...embedMessageEnvelopeFields,
    heightPx: z.number().int().min(0).max(EMBED_HEIGHT_MAX_PX)
  }),
  z.strictObject({
    kind: z.literal('navigate'),
    ...embedMessageEnvelopeFields,
    path: embedNavigationPathSchema
  }),
  z.strictObject({ kind: z.literal('submission_complete'), ...embedMessageEnvelopeFields })
]);

const embedLocaleSchema = z.string().max(35)
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/);

/** Host → frame messages: constrained display context, nothing executable. */
export const embedHostMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('host_context'),
    ...embedMessageEnvelopeFields,
    colorScheme: z.enum(['light', 'dark']).nullable(),
    locale: embedLocaleSchema.nullable()
  })
]);

export type EmbedChildMessage = z.infer<typeof embedChildMessageSchema>;
export type EmbedHostMessage = z.infer<typeof embedHostMessageSchema>;

export type EmbedMessageRefusalCode = 'origin_mismatch' | 'message_invalid';

export type EmbedMessageAcceptance<Message> =
  | { readonly kind: 'accepted'; readonly message: Message }
  | { readonly kind: 'refused'; readonly code: EmbedMessageRefusalCode };

function acceptEmbedMessage<Message>(
  schema: { safeParse(value: unknown): { success: boolean; data?: Message } },
  input: { readonly data: unknown; readonly senderOrigin: string; readonly expectedOrigin: string }
): EmbedMessageAcceptance<Message> {
  const expected = normalizeEmbedFrameOrigin(input.expectedOrigin);
  if (expected.kind !== 'normalized' || expected.origin !== input.expectedOrigin) {
    return Object.freeze({ kind: 'refused', code: 'origin_mismatch' });
  }
  if (input.senderOrigin !== input.expectedOrigin) {
    return Object.freeze({ kind: 'refused', code: 'origin_mismatch' });
  }
  const parsed = schema.safeParse(input.data);
  return parsed.success
    ? Object.freeze({ kind: 'accepted', message: parsed.data as Message })
    : Object.freeze({ kind: 'refused', code: 'message_invalid' });
}

/**
 * Host-side acceptance of one frame message: the sender must be exactly the
 * product origin serving the embed document, and the payload must be one of
 * the presentation-only frame messages. An expected origin that is not itself
 * a single normalized origin (`*` included) admits nothing.
 */
export function acceptEmbedChildMessage(input: {
  readonly data: unknown;
  readonly senderOrigin: string;
  readonly embedOrigin: string;
}): EmbedMessageAcceptance<EmbedChildMessage> {
  return acceptEmbedMessage(embedChildMessageSchema, {
    data: input.data,
    senderOrigin: input.senderOrigin,
    expectedOrigin: input.embedOrigin
  });
}

/**
 * Frame-side acceptance of one host message: the sender must be exactly the
 * configured host page origin, and the payload must be the constrained host
 * context message.
 */
export function acceptEmbedHostMessage(input: {
  readonly data: unknown;
  readonly senderOrigin: string;
  readonly hostOrigin: string;
}): EmbedMessageAcceptance<EmbedHostMessage> {
  return acceptEmbedMessage(embedHostMessageSchema, {
    data: input.data,
    senderOrigin: input.senderOrigin,
    expectedOrigin: input.hostOrigin
  });
}

/** The two pasteable deliveries; the hosted page is a link, not a snippet. */
export const embedDeliverySchema = z.enum(['inline', 'frame']);
export type EmbedDelivery = z.infer<typeof embedDeliverySchema>;

/** A scope as one attribute value: `kind:id`, or null for the whole surface. */
export const embedScopeAttributeSchema = z.string().max(80)
  .regex(/^[a-z]+:[A-Za-z0-9._-]{1,64}$/);

/**
 * A frame must be told a height, because a cross-document child cannot size
 * its parent. Generous per-kind floors: too short crops content behind an
 * inner scrollbar; too tall only leaves empty page.
 */
export const EMBED_FRAME_MIN_HEIGHT_PX: Readonly<Record<SurfaceKind, number>> = Object.freeze({
  schedule: 720,
  speakers: 640,
  apply: 900
});

const EMBED_FRAME_TITLE_MAX = 200;
const EMBED_MAX_WIDTH_MIN_PX = 200;
const EMBED_MAX_WIDTH_MAX_PX = 2_000;

export interface EmbedSnippetRequest {
  readonly kind: SurfaceKind;
  readonly delivery: EmbedDelivery;
  /** Serialized scope attribute value, or null for the whole surface. */
  readonly scope: string | null;
  /** Human title for the frame delivery's iframe. */
  readonly frameTitle: string;
  readonly maxWidthPx: number | null;
  readonly align: 'start' | 'center';
}

export type EmbedSnippetRefusalCode =
  | 'allowlist_empty'
  | 'allowlist_invalid'
  | 'product_origin_invalid'
  | 'scope_invalid'
  | 'frame_title_invalid'
  | 'max_width_invalid';

export type EmbedSnippetOutcome =
  | {
      readonly kind: 'generated';
      readonly delivery: EmbedDelivery;
      readonly snippet: string;
      /** The once-per-page loader tag; emitted for the inline delivery only. */
      readonly loaderSnippet: string | null;
      readonly embedUrl: string;
      readonly standaloneUrl: string;
      readonly frameMinHeightPx: number | null;
    }
  | { readonly kind: 'refused'; readonly code: EmbedSnippetRefusalCode };

/**
 * The pasteable code for one embed, as a pure function of the product origin,
 * the requested presentation, and the surface's framing allowlist. Nothing is
 * read from storage and nothing is persisted. Generation is
 * allowlist-consistent by construction: a snippet is produced exactly when
 * the surface's derived `frame-ancestors` policy would let some page frame
 * it, so the code handed out is never code the response headers make dead.
 */
export function generateEmbedSnippet(input: {
  readonly productOrigin: string;
  readonly request: EmbedSnippetRequest;
  readonly allowedFrameOrigins: readonly string[];
}): EmbedSnippetOutcome {
  const request = input.request;
  const origin = normalizeEmbedFrameOrigin(input.productOrigin);
  if (origin.kind !== 'normalized') return refusedSnippet('product_origin_invalid');
  for (const entry of input.allowedFrameOrigins) {
    const normalization = normalizeEmbedFrameOrigin(entry);
    if (normalization.kind !== 'normalized' || normalization.origin !== entry) {
      return refusedSnippet('allowlist_invalid');
    }
  }
  const ancestors = deriveSurfaceFrameAncestors({
    kind: request.kind,
    allowedFrameOrigins: input.allowedFrameOrigins
  });
  if (ancestors === FRAME_ANCESTORS_DENY_ALL) return refusedSnippet('allowlist_empty');
  if (request.scope !== null && !embedScopeAttributeSchema.safeParse(request.scope).success) {
    return refusedSnippet('scope_invalid');
  }
  if (request.maxWidthPx !== null && (
    !Number.isInteger(request.maxWidthPx)
    || request.maxWidthPx < EMBED_MAX_WIDTH_MIN_PX
    || request.maxWidthPx > EMBED_MAX_WIDTH_MAX_PX
  )) {
    return refusedSnippet('max_width_invalid');
  }
  const title = request.frameTitle.trim();
  if (request.delivery === 'frame'
      && (title.length === 0 || title.length > EMBED_FRAME_TITLE_MAX)) {
    return refusedSnippet('frame_title_invalid');
  }

  const embedUrl = withScope(`${origin.origin}${embedDocumentPath(request.kind)}`, request.scope);
  const standaloneUrl = withScope(
    `${origin.origin}${hostedSurfacePath(request.kind)}`,
    request.scope
  );
  if (request.delivery === 'frame') {
    const minHeight = EMBED_FRAME_MIN_HEIGHT_PX[request.kind];
    return Object.freeze({
      kind: 'generated',
      delivery: 'frame',
      snippet: frameSnippet({ embedUrl, title, request, minHeight }),
      loaderSnippet: null,
      embedUrl,
      standaloneUrl,
      frameMinHeightPx: minHeight
    });
  }
  return Object.freeze({
    kind: 'generated',
    delivery: 'inline',
    snippet: elementSnippet({ embedUrl, request }),
    loaderSnippet: `<script src="${origin.origin}${EMBED_LOADER_PATH}" async></script>`,
    embedUrl,
    standaloneUrl,
    frameMinHeightPx: null
  });
}

function refusedSnippet(code: EmbedSnippetRefusalCode): EmbedSnippetOutcome {
  return Object.freeze({ kind: 'refused', code });
}

function withScope(base: string, scope: string | null): string {
  return scope === null ? base : `${base}?scope=${encodeURIComponent(scope)}`;
}

function elementSnippet(input: {
  readonly embedUrl: string;
  readonly request: EmbedSnippetRequest;
}): string {
  const attributes = [`src="${escapeAttribute(input.embedUrl)}"`];
  if (input.request.scope !== null) {
    attributes.push(`scope="${escapeAttribute(input.request.scope)}"`);
  }
  if (input.request.maxWidthPx !== null) {
    attributes.push(`max-width="${input.request.maxWidthPx}"`);
  }
  if (input.request.align === 'center') attributes.push('align="center"');
  const [first, ...rest] = attributes;
  const head = `<${EMBED_ELEMENT_TAG} ${first}`;
  if (rest.length === 0) return `${head}></${EMBED_ELEMENT_TAG}>`;
  const indent = ' '.repeat(EMBED_ELEMENT_TAG.length + 2);
  return `${head}\n${rest.map((line) => `${indent}${line}`).join('\n')}></${EMBED_ELEMENT_TAG}>`;
}

function frameSnippet(input: {
  readonly embedUrl: string;
  readonly title: string;
  readonly request: EmbedSnippetRequest;
  readonly minHeight: number;
}): string {
  const style = [
    'width:100%',
    input.request.maxWidthPx !== null ? `max-width:${input.request.maxWidthPx}px` : null,
    input.request.align === 'center' && input.request.maxWidthPx !== null ? 'margin:0 auto' : null,
    'border:0',
    `min-height:${input.minHeight}px`
  ].filter((part) => part !== null).join(';');
  return [
    `<iframe src="${escapeAttribute(input.embedUrl)}"`,
    `        title="${escapeAttribute(input.title)}"`,
    `        style="${style}"`,
    '        loading="lazy"></iframe>'
  ].join('\n');
}

/** The snippet is source someone pastes; text must never become markup. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
