import {
  organizerCommunicationDefinitionRefSchema,
  organizerCommunicationDigestSchema,
  organizerCommunicationOpaqueIdSchema,
  organizerCommunicationRecipientResolutionIdSchema,
  organizerEmailMessageContentSchema,
  organizerEmailTemplateContentSchema,
  organizerMessageTemplateFieldBindingSchema,
  organizerMessageTemplateRevisionRefSchema,
  organizerRenderedAttachmentSchema,
  organizerServerRenderedEmailSchema
} from '@jooevents/contracts/communications/organizer';
import { canonicalJsonText } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  OrganizerMergeRegistryError,
  organizerMergeValueText,
  resolveOrganizerMergeFields,
  type OrganizerFallbackMergeValue,
  type OrganizerMergeRegistryRelease,
  type OrganizerResolvedMergeFields,
  type OrganizerResolvedMergeValue
} from './merge-registry';

const MAXIMUM_RENDERED_BYTES = 1_000_000;

export type OrganizerEmailRenderErrorCode =
  | 'invalid_input'
  | 'template_revision_mismatch'
  | 'open_canvas_not_supported'
  | 'unsafe_url'
  | 'attachment_mismatch'
  | 'output_too_large'
  | 'merge_resolution_failed';

export class OrganizerEmailRenderError extends Error {
  constructor(
    readonly code: OrganizerEmailRenderErrorCode,
    readonly mergeCode?: OrganizerMergeRegistryError['code']
  ) {
    super(code);
    this.name = 'OrganizerEmailRenderError';
  }
}

type MessageContent = ReturnType<typeof organizerEmailMessageContentSchema.parse>;
type TemplateContent = ReturnType<typeof organizerEmailTemplateContentSchema.parse>;
type TemplateBinding = ReturnType<typeof organizerMessageTemplateFieldBindingSchema.parse>;
type Attachment = ReturnType<typeof organizerRenderedAttachmentSchema.parse>;
type RenderedEmail = ReturnType<typeof organizerServerRenderedEmailSchema.parse>;
type InlineNode = TemplateContent['subject'][number];
type ComposedBlock = Extract<TemplateContent['body'], { readonly mode: 'composed' }>['blocks'][number];

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonText(value))));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHttpsUrl(value: string, allowedOrigins: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OrganizerEmailRenderError('unsafe_url');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0
      || parsed.username.length > 0 || parsed.password.length > 0
      || !allowedOrigins.includes(parsed.origin)) {
    throw new OrganizerEmailRenderError('unsafe_url');
  }
  return parsed.href;
}

function requestedFields(content: TemplateContent): readonly string[] {
  const keys: string[] = [];
  const inline = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) if (node.kind === 'merge_field') keys.push(node.fieldKey);
  };
  inline(content.subject);
  if (content.explicitPlainText !== undefined) inline(content.explicitPlainText);
  if (content.body.mode === 'composed') {
    for (const block of content.body.blocks) {
      switch (block.kind) {
        case 'paragraph':
        case 'heading': inline(block.content); break;
        case 'list': for (const item of block.items) inline(item); break;
        case 'action_link': inline(block.label); keys.push(block.hrefFieldKey); break;
        case 'detail_rows':
          for (const row of block.rows) { inline(row.label); inline(row.value); }
          break;
      }
    }
  }
  return Object.freeze([...new Set(keys)].sort());
}

function inlineText(
  nodes: readonly InlineNode[],
  fields: OrganizerResolvedMergeFields,
  timezone: string | undefined
): string {
  let result = '';
  for (const node of nodes) {
    result += node.kind === 'text'
      ? node.value
      : fields.values.get(node.fieldKey) === undefined
        ? ''
        : organizerMergeValueText(fields.values.get(node.fieldKey)!, { timezone });
  }
  return result;
}

function inlineHtml(
  nodes: readonly InlineNode[],
  fields: OrganizerResolvedMergeFields,
  timezone: string | undefined
): string {
  let result = '';
  for (const node of nodes) {
    const value = node.kind === 'text'
      ? node.value
      : fields.values.get(node.fieldKey) === undefined
        ? ''
        : organizerMergeValueText(fields.values.get(node.fieldKey)!, { timezone });
    const escaped = escapeHtml(value);
    result += node.kind === 'text' && node.emphasis === 'strong'
      ? `<strong>${escaped}</strong>`
      : node.kind === 'text' && node.emphasis === 'emphasis'
        ? `<em>${escaped}</em>`
        : escaped;
  }
  return result;
}

function actionUrl(
  fieldKey: string,
  fields: OrganizerResolvedMergeFields,
  mergeRegistry: OrganizerMergeRegistryRelease
): string | undefined {
  const value = fields.values.get(fieldKey);
  if (value === undefined) return undefined;
  const definition = mergeRegistry.fields.find((candidate) => candidate.fieldKey === fieldKey);
  if (value.valueType !== 'url' || definition?.valueType !== 'url') {
    throw new OrganizerEmailRenderError('merge_resolution_failed', 'merge_value_type_mismatch');
  }
  return safeHttpsUrl(value.value, definition.allowedHttpsOrigins);
}

function renderComposedHtml(
  blocks: readonly ComposedBlock[],
  fields: OrganizerResolvedMergeFields,
  mergeRegistry: OrganizerMergeRegistryRelease,
  timezone: string | undefined
): string {
  const html: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph': html.push(`<p>${inlineHtml(block.content, fields, timezone)}</p>`); break;
      case 'heading': html.push(`<h${block.level}>${inlineHtml(block.content, fields, timezone)}</h${block.level}>`); break;
      case 'list': {
        const tag = block.style === 'ordered' ? 'ol' : 'ul';
        html.push(`<${tag}>${block.items.map((item) => `<li>${inlineHtml(item, fields, timezone)}</li>`).join('')}</${tag}>`);
        break;
      }
      case 'action_link': {
        const label = inlineHtml(block.label, fields, timezone);
        const href = actionUrl(block.hrefFieldKey, fields, mergeRegistry);
        html.push(href === undefined
          ? `<p>${label}</p>`
          : `<p><a href="${escapeHtml(href)}">${label}</a></p>`);
        break;
      }
      case 'detail_rows':
        html.push(`<dl>${block.rows.map((row) =>
          `<dt>${inlineHtml(row.label, fields, timezone)}</dt><dd>${inlineHtml(row.value, fields, timezone)}</dd>`
        ).join('')}</dl>`);
        break;
    }
  }
  return `<div data-jooevents-email="v1">${html.join('')}</div>`;
}

function renderComposedText(
  blocks: readonly ComposedBlock[],
  fields: OrganizerResolvedMergeFields,
  mergeRegistry: OrganizerMergeRegistryRelease,
  timezone: string | undefined
): string {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading': lines.push(inlineText(block.content, fields, timezone)); break;
      case 'list':
        block.items.forEach((item, index) => lines.push(
          block.style === 'ordered' ? `${index + 1}. ${inlineText(item, fields, timezone)}` : `- ${inlineText(item, fields, timezone)}`
        ));
        break;
      case 'action_link': {
        const label = inlineText(block.label, fields, timezone);
        const href = actionUrl(block.hrefFieldKey, fields, mergeRegistry);
        lines.push(href === undefined ? label : `${label}: ${href}`);
        break;
      }
      case 'detail_rows':
        for (const row of block.rows) {
          lines.push(`${inlineText(row.label, fields, timezone)}: ${inlineText(row.value, fields, timezone)}`);
        }
        break;
    }
  }
  return lines.join('\n\n');
}

function canonicalAttachments(value: unknown, expectedSlots: readonly string[]): readonly Attachment[] {
  if (!Array.isArray(value) || value.length > 10) {
    throw new OrganizerEmailRenderError('attachment_mismatch');
  }
  let attachments: Attachment[];
  try {
    attachments = value.map((attachment) => organizerRenderedAttachmentSchema.parse(attachment));
  } catch {
    throw new OrganizerEmailRenderError('attachment_mismatch');
  }
  attachments.sort((left, right) => left.slotKey.localeCompare(right.slotKey));
  if (attachments.length !== expectedSlots.length
      || attachments.some((attachment, index) => attachment.slotKey !== expectedSlots[index])) {
    throw new OrganizerEmailRenderError('attachment_mismatch');
  }
  return Object.freeze(attachments.map((attachment) => Object.freeze({ ...attachment })));
}

function directHtml(text: string): string {
  if (text.length === 0) return '<div data-jooevents-email="v1"></div>';
  return `<div data-jooevents-email="v1"><p>${escapeHtml(text).replaceAll('\n', '<br>')}</p></div>`;
}

/**
 * Deterministic, provider-neutral rendering. Open-canvas stays fail-closed until
 * a separately reviewed sanitizer contract exists.
 */
export function renderOrganizerEmailV1(input: {
  readonly recipientResolutionId: string;
  readonly releaseId: string;
  readonly releaseDigestSha256: string;
  readonly renderer: unknown;
  readonly mergeRegistry: OrganizerMergeRegistryRelease;
  readonly messageContent: unknown;
  readonly template?: {
    readonly revision: unknown;
    readonly content: unknown;
    readonly fieldBindings: unknown;
  };
  readonly resolvedValues?: readonly OrganizerResolvedMergeValue[];
  readonly fallbackValues?: readonly OrganizerFallbackMergeValue[];
  readonly attachments?: unknown;
  /**
   * The event's IANA timezone, so an `instant` merge value is spelled on the
   * event's wall clock. Omitted, instants render in UTC and say `UTC`; the line
   * is then true but not local. It joins the resolved-input digest only when it
   * is supplied, so a render that never had a zone keeps the digest it has.
   */
  readonly timezone?: string;
}): RenderedEmail {
  const timezone = input.timezone;
  let recipientResolutionId: string;
  let releaseId: string;
  let releaseDigestSha256: string;
  let renderer: ReturnType<typeof organizerCommunicationDefinitionRefSchema.parse>;
  let message: MessageContent;
  try {
    recipientResolutionId = organizerCommunicationRecipientResolutionIdSchema.parse(
      input.recipientResolutionId
    );
    releaseId = organizerCommunicationOpaqueIdSchema.parse(input.releaseId);
    releaseDigestSha256 = organizerCommunicationDigestSchema.parse(input.releaseDigestSha256);
    renderer = organizerCommunicationDefinitionRefSchema.parse(input.renderer);
    message = organizerEmailMessageContentSchema.parse(input.messageContent);
  } catch {
    throw new OrganizerEmailRenderError('invalid_input');
  }

  let sanitizedHtml: string;
  let plainText: string;
  let fields: OrganizerResolvedMergeFields = Object.freeze({
    values: new Map(), canonicalValues: Object.freeze([]), warningCodes: Object.freeze([])
  });
  let attachments: readonly Attachment[];
  let templateDigestInput: unknown = null;

  if (message.body.kind === 'plain_text/v1') {
    if (input.template !== undefined || (input.resolvedValues?.length ?? 0) > 0
        || (input.fallbackValues?.length ?? 0) > 0) {
      throw new OrganizerEmailRenderError('invalid_input');
    }
    attachments = canonicalAttachments(input.attachments ?? [], []);
    sanitizedHtml = directHtml(message.body.text);
    plainText = message.body.text;
  } else {
    if (input.template === undefined) throw new OrganizerEmailRenderError('template_revision_mismatch');
    let revision: ReturnType<typeof organizerMessageTemplateRevisionRefSchema.parse>;
    let content: TemplateContent;
    let bindings: readonly TemplateBinding[];
    try {
      revision = organizerMessageTemplateRevisionRefSchema.parse(input.template.revision);
      content = organizerEmailTemplateContentSchema.parse(input.template.content);
      if (!Array.isArray(input.template.fieldBindings)) throw new TypeError();
      bindings = input.template.fieldBindings.map((binding) =>
        organizerMessageTemplateFieldBindingSchema.parse(binding)
      );
    } catch {
      throw new OrganizerEmailRenderError('invalid_input');
    }
    if (canonicalJsonText(revision) !== canonicalJsonText(message.body.templateRevision)) {
      throw new OrganizerEmailRenderError('template_revision_mismatch');
    }
    if (content.body.mode === 'open_canvas') {
      throw new OrganizerEmailRenderError('open_canvas_not_supported');
    }
    try {
      fields = resolveOrganizerMergeFields({
        registry: input.mergeRegistry,
        bindings,
        requestedFieldKeys: requestedFields(content),
        resolvedValues: input.resolvedValues ?? [],
        fallbackValues: input.fallbackValues ?? []
      });
    } catch (error) {
      if (error instanceof OrganizerMergeRegistryError) {
        throw new OrganizerEmailRenderError('merge_resolution_failed', error.code);
      }
      throw error;
    }
    attachments = canonicalAttachments(input.attachments ?? [], content.attachmentSlotKeys);
    sanitizedHtml = renderComposedHtml(content.body.blocks, fields, input.mergeRegistry, timezone);
    plainText = content.plainTextPolicy === 'explicit_v1'
      ? inlineText(content.explicitPlainText!, fields, timezone)
      : renderComposedText(content.body.blocks, fields, input.mergeRegistry, timezone);
    templateDigestInput = { revision, content, bindings };
  }

  if (new TextEncoder().encode(sanitizedHtml).byteLength > MAXIMUM_RENDERED_BYTES
      || new TextEncoder().encode(plainText).byteLength > MAXIMUM_RENDERED_BYTES) {
    throw new OrganizerEmailRenderError('output_too_large');
  }
  const attachmentManifestDigestSha256 = digest(attachments);
  const resolvedInputDigestSha256 = digest({
    schemaVersion: 1,
    recipientResolutionId,
    message,
    template: templateDigestInput,
    mergeRegistry: input.mergeRegistry.identity,
    values: fields.canonicalValues,
    // Present only when a zone was supplied: the same inputs rendered on two
    // different wall clocks are two different inputs, but a render that never
    // had a zone must keep the digest it already had.
    ...(timezone === undefined ? {} : { timezone })
  });
  const warningCodes = Object.freeze([...fields.warningCodes].sort());
  const unsigned = {
    recipientResolutionId,
    releaseId,
    releaseDigestSha256,
    resolvedInputDigestSha256,
    attachmentManifestDigestSha256,
    renderer,
    mergeRegistry: input.mergeRegistry.identity,
    subject: message.subject,
    sanitizedHtml,
    plainText,
    attachments,
    warningCodes
  };
  const outputDigestSha256 = digest({ schemaVersion: 1, ...unsigned });
  try {
    return organizerServerRenderedEmailSchema.parse({ ...unsigned, outputDigestSha256 });
  } catch {
    throw new OrganizerEmailRenderError('output_too_large');
  }
}
