import type { ImmutableEmailEnvelope } from '@jooevents/communications';

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
}>;

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
