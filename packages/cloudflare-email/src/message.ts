import { canonicalJsonText } from '@jooevents/kernel';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  ImmutableEmailAttachment,
  ImmutableEmailCalendarPart,
  ImmutableEmailEnvelope,
  ImmutableEmailEnvelopeV2
} from '@jooevents/communications';

export const CLOUDFLARE_EMAIL_MESSAGE_MAXIMUM_BYTES = 5 * 1024 * 1024;
const MIME_ENCODING_HEADROOM_BYTES = 64 * 1024;
const MAXIMUM_HEADER_VALUE_BYTES = 2_048;
const MAXIMUM_NON_X_HEADERS = 20;

const ALLOWLISTED_HEADERS = new Set([
  'archived-at',
  'auto-submitted',
  'comments',
  'importance',
  'in-reply-to',
  'keywords',
  'list-archive',
  'list-help',
  'list-id',
  'list-owner',
  'list-post',
  'list-subscribe',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'organization',
  'precedence',
  'references',
  'require-recipient-valid-since',
  'sensitivity'
]);

export type CloudflareWorkersEmailAddress = Readonly<{
  email: string;
  name?: string;
}>;

export type CloudflareWorkersEmailMessage = Readonly<{
  to: string;
  from: string | CloudflareWorkersEmailAddress;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | CloudflareWorkersEmailAddress;
  headers?: Readonly<Record<string, string>>;
  attachments?: readonly CloudflareEmailAttachment[];
}>;

export type CloudflareRestEmailAddress = Readonly<{
  address: string;
  name?: string;
}>;

export type CloudflareRestEmailMessage = Readonly<{
  to: string;
  from: string | CloudflareRestEmailAddress;
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string | CloudflareRestEmailAddress;
  headers?: Readonly<Record<string, string>>;
  attachments?: readonly CloudflareEmailAttachment[];
}>;

export type CloudflareEmailAttachment = Readonly<{
  filename: string;
  type: string;
  disposition: 'attachment' | 'inline';
  content: string;
  content_id?: string;
}>;

export type CloudflareRawEmailMessage = Readonly<{
  from: string;
  recipients: readonly [string];
  mime_message: string;
}>;

export type CloudflareRestPreparedMessage =
  | Readonly<{ kind: 'structured'; envelope: ImmutableEmailEnvelope }>
  | Readonly<{ kind: 'raw'; envelope: ImmutableEmailEnvelopeV2 }>;

export interface CloudflareEmailContentResolver {
  resolveContentBytes(contentBytesRef: string): Promise<Uint8Array>;
}

const encoder = new TextEncoder();

function encodedByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function base64UpperBound(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function assertCloudflareHeaders(envelope: ImmutableEmailEnvelope): void {
  let nonXHeaders = 0;
  let totalBytes = 0;
  for (const header of envelope.headers) {
    const canonicalName = header.name.toLowerCase();
    const isXHeader = /^x-[a-z0-9_-]+$/iu.test(header.name);
    if (!isXHeader && !ALLOWLISTED_HEADERS.has(canonicalName)) {
      throw new TypeError('email header is not supported by Cloudflare Email Sending');
    }
    if (!isXHeader) nonXHeaders += 1;
    const valueBytes = encodedByteLength(header.value);
    if (valueBytes === 0 || valueBytes > MAXIMUM_HEADER_VALUE_BYTES) {
      throw new TypeError('email header value exceeds the Cloudflare bounded shape');
    }
    totalBytes += encodedByteLength(header.name) + 2 + valueBytes + 2;
  }
  if (nonXHeaders > MAXIMUM_NON_X_HEADERS) {
    throw new TypeError('email has too many allowlisted Cloudflare headers');
  }
  if (totalBytes > 16_384) {
    throw new TypeError('email headers exceed the Cloudflare aggregate limit');
  }
}

function assertCloudflareMessageSize(envelope: ImmutableEmailEnvelope): void {
  const values = [
    envelope.from.address,
    envelope.from.displayName ?? '',
    envelope.to.address,
    envelope.replyTo?.address ?? '',
    envelope.replyTo?.displayName ?? '',
    envelope.subject,
    ...envelope.headers.flatMap((header) => [header.name, header.value])
  ];
  let estimatedBytes = MIME_ENCODING_HEADROOM_BYTES;
  for (const value of values) estimatedBytes += base64UpperBound(encodedByteLength(value));
  estimatedBytes += base64UpperBound(encodedByteLength(envelope.textBody));
  if (envelope.htmlBody !== undefined) {
    estimatedBytes += base64UpperBound(encodedByteLength(envelope.htmlBody));
  }
  if (envelope.contractVersion === 2) {
    for (const attachment of envelope.attachments) {
      estimatedBytes += base64UpperBound(attachment.byteLength) + MIME_ENCODING_HEADROOM_BYTES;
    }
    if (envelope.calendarPart !== undefined) {
      estimatedBytes += base64UpperBound(envelope.calendarPart.byteLength) + MIME_ENCODING_HEADROOM_BYTES;
    }
  }
  if (estimatedBytes > CLOUDFLARE_EMAIL_MESSAGE_MAXIMUM_BYTES) {
    throw new TypeError('email exceeds the conservative Cloudflare message-size bound');
  }
}

function headers(envelope: ImmutableEmailEnvelope): Readonly<Record<string, string>> | undefined {
  if (envelope.headers.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(
    envelope.headers.map((header) => [header.name, header.value])
  ));
}

function assertBody(envelope: ImmutableEmailEnvelope): void {
  if (envelope.textBody.length === 0 && (envelope.htmlBody?.length ?? 0) === 0) {
    throw new TypeError('Cloudflare Email Sending requires a nonempty text or HTML body');
  }
}

export function buildCloudflareWorkersMessage(
  envelope: ImmutableEmailEnvelope
): CloudflareWorkersEmailMessage {
  if (envelope.contractVersion === 2
      && (envelope.attachments.length > 0 || envelope.calendarPart !== undefined)) {
    throw new TypeError('Cloudflare Workers email route does not support reviewed content parts');
  }
  assertBody(envelope);
  assertCloudflareHeaders(envelope);
  assertCloudflareMessageSize(envelope);
  const customHeaders = headers(envelope);
  return Object.freeze({
    to: envelope.to.address,
    from: envelope.from.displayName === undefined
      ? envelope.from.address
      : Object.freeze({ email: envelope.from.address, name: envelope.from.displayName }),
    subject: envelope.subject,
    ...(envelope.htmlBody === undefined || envelope.htmlBody.length === 0
      ? {}
      : { html: envelope.htmlBody }),
    ...(envelope.textBody.length === 0 ? {} : { text: envelope.textBody }),
    ...(envelope.replyTo === undefined
      ? {}
      : {
          replyTo: envelope.replyTo.displayName === undefined
            ? envelope.replyTo.address
            : Object.freeze({
                email: envelope.replyTo.address,
                name: envelope.replyTo.displayName
              })
        }),
    ...(customHeaders === undefined ? {} : { headers: customHeaders })
  });
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? '=' : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? '=' : alphabet[third & 63];
  }
  return output;
}

function foldedBase64(bytes: Uint8Array): string {
  return toBase64(bytes).match(/.{1,76}/gu)?.join('\r\n') ?? '';
}

function encodedWord(value: string): string {
  return /^[\x20-\x7e]*$/u.test(value)
    ? value
    : `=?UTF-8?B?${toBase64(encoder.encode(value))}?=`;
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function mailbox(party: Readonly<{ address: string; displayName?: string }>): string {
  return party.displayName === undefined
    ? party.address
    : `${encodedWord(party.displayName)} <${party.address}>`;
}

async function resolveContent(
  reference: ImmutableEmailAttachment | ImmutableEmailCalendarPart,
  resolver: CloudflareEmailContentResolver
): Promise<Uint8Array> {
  const bytes = await resolver.resolveContentBytes(reference.contentBytesRef);
  if (!(bytes instanceof Uint8Array)
      || bytes.byteLength !== reference.byteLength
      || bytesToHex(sha256(bytes)) !== reference.contentSha256) {
    throw new TypeError('email content reference did not resolve to its reviewed bytes');
  }
  return bytes;
}

async function resolvedAttachments(
  envelope: ImmutableEmailEnvelope,
  resolver: CloudflareEmailContentResolver
): Promise<readonly CloudflareEmailAttachment[]> {
  if (envelope.contractVersion === 1) return Object.freeze([]);
  return Object.freeze(await Promise.all(envelope.attachments.map(async (attachment) =>
    Object.freeze({
      filename: attachment.filename,
      type: attachment.mediaType,
      disposition: attachment.disposition,
      content: toBase64(await resolveContent(attachment, resolver)),
      ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId })
    })
  )));
}

function structuredMessage(
  envelope: ImmutableEmailEnvelope,
  attachments: readonly CloudflareEmailAttachment[]
): CloudflareRestEmailMessage {
  const message = buildCloudflareRestMessage(envelope);
  return Object.freeze({
    ...message,
    ...(attachments.length === 0 ? {} : { attachments })
  });
}

function textPart(mediaType: 'text/plain' | 'text/html', value: string): string {
  return [
    `Content-Type: ${mediaType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    foldedBase64(encoder.encode(value))
  ].join('\r\n');
}

function contentPart(input: {
  readonly mediaType: string;
  readonly filename: string;
  readonly disposition: 'attachment' | 'inline';
  readonly bytes: Uint8Array;
  readonly contentId?: string;
  readonly method?: 'REQUEST' | 'CANCEL';
}): string {
  return [
    `Content-Type: ${input.mediaType}${input.method === undefined ? '' : `; method=${input.method}`}; name=${quoted(encodedWord(input.filename))}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${input.disposition}; filename=${quoted(encodedWord(input.filename))}`,
    ...(input.contentId === undefined ? [] : [`Content-ID: <${input.contentId}>`]),
    '',
    foldedBase64(input.bytes)
  ].join('\r\n');
}

/** Builds deterministic RFC 5322 MIME; Cloudflare owns transport headers such as Date. */
export async function buildCloudflareRawMessage(
  envelope: ImmutableEmailEnvelopeV2,
  resolver: CloudflareEmailContentResolver
): Promise<CloudflareRawEmailMessage> {
  assertBody(envelope);
  assertCloudflareHeaders(envelope);
  assertCloudflareMessageSize(envelope);
  if (envelope.calendarPart === undefined) {
    throw new TypeError('raw Cloudflare email requires a calendar part');
  }
  const seed = bytesToHex(sha256(encoder.encode(canonicalJsonText(envelope)))).slice(0, 32);
  const mixed = `je_mixed_${seed}`;
  const alternative = `je_alt_${seed}`;
  const calendarBytes = await resolveContent(envelope.calendarPart, resolver);
  const attachmentParts = await Promise.all(envelope.attachments.map(async (attachment) =>
    contentPart({
      mediaType: attachment.mediaType,
      filename: attachment.filename,
      disposition: attachment.disposition,
      bytes: await resolveContent(attachment, resolver),
      ...(attachment.contentId === undefined ? {} : { contentId: attachment.contentId })
    })
  ));
  const alternatives = [
    textPart('text/plain', envelope.textBody),
    ...(envelope.htmlBody === undefined || envelope.htmlBody.length === 0
      ? []
      : [textPart('text/html', envelope.htmlBody)]),
    contentPart({
      mediaType: 'text/calendar',
      method: envelope.calendarPart.method,
      filename: envelope.calendarPart.filename,
      disposition: 'inline',
      bytes: calendarBytes
    })
  ];
  const headers = [
    `From: ${mailbox(envelope.from)}`,
    `To: ${envelope.to.address}`,
    ...(envelope.replyTo === undefined ? [] : [`Reply-To: ${mailbox(envelope.replyTo)}`]),
    `Subject: ${encodedWord(envelope.subject)}`,
    ...envelope.headers.map((header) => `${header.name}: ${header.value}`),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary=${quoted(mixed)}`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary=${quoted(alternative)}`,
    '',
    ...alternatives.flatMap((part) => [`--${alternative}`, part]),
    `--${alternative}--`,
    ...attachmentParts.flatMap((part) => [`--${mixed}`, part]),
    `--${mixed}--`,
    ''
  ];
  return Object.freeze({
    from: envelope.from.address,
    recipients: Object.freeze([envelope.to.address] as const),
    mime_message: headers.join('\r\n')
  });
}

export function buildCloudflareRestPreparedMessage(
  envelope: ImmutableEmailEnvelope
): CloudflareRestPreparedMessage {
  assertBody(envelope);
  assertCloudflareHeaders(envelope);
  assertCloudflareMessageSize(envelope);
  return envelope.contractVersion === 2 && envelope.calendarPart !== undefined
    ? Object.freeze({ kind: 'raw', envelope })
    : Object.freeze({ kind: 'structured', envelope });
}

export async function materializeCloudflareRestMessage(
  prepared: CloudflareRestPreparedMessage,
  resolver: CloudflareEmailContentResolver
): Promise<CloudflareRestEmailMessage | CloudflareRawEmailMessage> {
  if (prepared.kind === 'raw') return buildCloudflareRawMessage(prepared.envelope, resolver);
  return structuredMessage(
    prepared.envelope,
    await resolvedAttachments(prepared.envelope, resolver)
  );
}

export function buildCloudflareRestMessage(
  envelope: ImmutableEmailEnvelope
): CloudflareRestEmailMessage {
  assertBody(envelope);
  assertCloudflareHeaders(envelope);
  assertCloudflareMessageSize(envelope);
  const customHeaders = headers(envelope);
  return Object.freeze({
    to: envelope.to.address,
    from: envelope.from.displayName === undefined
      ? envelope.from.address
      : Object.freeze({ address: envelope.from.address, name: envelope.from.displayName }),
    subject: envelope.subject,
    ...(envelope.htmlBody === undefined || envelope.htmlBody.length === 0
      ? {}
      : { html: envelope.htmlBody }),
    ...(envelope.textBody.length === 0 ? {} : { text: envelope.textBody }),
    ...(envelope.replyTo === undefined
      ? {}
      : {
          reply_to: envelope.replyTo.displayName === undefined
            ? envelope.replyTo.address
            : Object.freeze({
                address: envelope.replyTo.address,
                name: envelope.replyTo.displayName
              })
        }),
    ...(customHeaders === undefined ? {} : { headers: customHeaders })
  });
}
