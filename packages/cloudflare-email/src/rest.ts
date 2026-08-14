import { providerMessageIdSchema } from '@jooevents/contracts';
import {
  CLOUDFLARE_EMAIL_ADAPTER_VERSION,
  CLOUDFLARE_REST_EMAIL_ADAPTER_KEY,
  CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST
} from './constants';
import { CLOUDFLARE_EMAIL_EVIDENCE_CODES } from './evidence';
import {
  buildCloudflareRestMessage,
  type CloudflareRestEmailMessage
} from './message';
import { createCloudflareEmailProvider, type CloudflareEmailProvider } from './provider';
import type { CloudflareEmailReadinessProbe } from './setup';
import type {
  CloudflareSendTransport,
  CloudflareSendTransportObservation
} from './transport';

const MAXIMUM_RESPONSE_BYTES = 65_536;
const API_ROOT = 'https://api.cloudflare.com/client/v4';

export interface CloudflareApiTokenLease {
  withApiToken<Result>(use: (apiToken: string) => Promise<Result>): Promise<Result>;
}

export type CloudflareFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type ResponseRead =
  | Readonly<{ kind: 'value'; value: unknown }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'connection_lost' }>;

function validAccountId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 4_096
    && /^[\x21-\x7e]+$/u.test(value);
}

function timeoutLike(error: unknown): boolean {
  try {
    return typeof error === 'object'
      && error !== null
      && 'name' in error
      && (error.name === 'AbortError' || error.name === 'TimeoutError');
  } catch {
    return false;
  }
}

async function readBoundedJson(response: Response): Promise<ResponseRead> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAXIMUM_RESPONSE_BYTES) {
      try { await response.body?.cancel(); } catch { /* response is already rejected */ }
      return Object.freeze({ kind: 'malformed' });
    }
  }
  if (response.body === null) return Object.freeze({ kind: 'malformed' });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAXIMUM_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* response is already rejected */ }
        return Object.freeze({ kind: 'malformed' });
      }
      chunks.push(item.value);
    }
  } catch {
    return Object.freeze({ kind: 'connection_lost' });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return Object.freeze({
      kind: 'value',
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    });
  } catch {
    return Object.freeze({ kind: 'malformed' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedAddressArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 50
    && value.every((address) => typeof address === 'string' && address.length <= 320);
}

function normalizeSuccessfulResponse(
  value: unknown,
  recipient: string,
  status: number
): CloudflareSendTransportObservation {
  if (!isRecord(value) || value.success !== true || !isRecord(value.result)) {
    return Object.freeze({
      kind: 'acceptance_unknown',
      reason: 'malformed_response',
      observation: 'malformed_response',
      requestDispatched: true,
      httpStatus: status
    });
  }
  const result = value.result;
  if (
    !boundedAddressArray(result.delivered)
    || !boundedAddressArray(result.permanent_bounces)
    || !boundedAddressArray(result.queued)
  ) {
    return Object.freeze({
      kind: 'acceptance_unknown',
      reason: 'malformed_response',
      observation: 'malformed_response',
      requestDispatched: true,
      httpStatus: status
    });
  }
  const messageId = providerMessageIdSchema.safeParse(result.message_id);
  if (!messageId.success) {
    return Object.freeze({
      kind: 'acceptance_unknown',
      reason: 'malformed_response',
      observation: 'malformed_response',
      requestDispatched: true,
      httpStatus: status
    });
  }
  const totalDispositionCount = result.delivered.length
    + result.permanent_bounces.length
    + result.queued.length;
  // Field-verified beta contract (2026-08-14, live capture): the normal
  // acceptance is HTTP 200 with `success: true`, a `message_id`, and all
  // three per-recipient disposition arrays EMPTY — Wrangler's own send
  // command reports exactly this shape as plain success. When a disposition
  // is reported it must be exactly one and must name this recipient; any
  // other populated shape stays genuinely ambiguous.
  if (totalDispositionCount === 0) {
    return Object.freeze({
      kind: 'accepted',
      providerMessageId: messageId.data,
      observation: 'accepted_no_disposition',
      requestDispatched: true,
      httpStatus: status
    });
  }
  if (totalDispositionCount !== 1) {
    return Object.freeze({
      kind: 'acceptance_unknown',
      reason: 'malformed_response',
      observation: 'malformed_response',
      requestDispatched: true,
      httpStatus: status
    });
  }
  const dispositions = [
    result.delivered.includes(recipient) ? 'accepted_delivered' as const : undefined,
    result.permanent_bounces.includes(recipient)
      ? 'accepted_permanent_bounce' as const
      : undefined,
    result.queued.includes(recipient) ? 'accepted_queued' as const : undefined
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);
  if (dispositions.length !== 1) {
    return Object.freeze({
      kind: 'acceptance_unknown',
      reason: 'malformed_response',
      observation: 'malformed_response',
      requestDispatched: true,
      httpStatus: status
    });
  }
  return Object.freeze({
    kind: 'accepted',
    providerMessageId: messageId.data,
    observation: dispositions[0]!,
    requestDispatched: true,
    httpStatus: status
  });
}

function normalizeErrorStatus(status: number): CloudflareSendTransportObservation {
  if (status === 429) {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'safe_retryable',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.rateLimited,
      observation: 'rate_limited',
      requestDispatched: true,
      httpStatus: status
    });
  }
  if (status === 400 || status === 413 || status === 422) {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.invalidRequest,
      observation: 'invalid_request',
      requestDispatched: true,
      httpStatus: status
    });
  }
  if (status === 401) {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.authentication,
      observation: 'authentication_failed',
      requestDispatched: true,
      httpStatus: status
    });
  }
  if (status === 403) {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.authorization,
      observation: 'authorization_failed',
      requestDispatched: true,
      httpStatus: status
    });
  }
  if (status === 404) {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.notFound,
      observation: 'not_found',
      requestDispatched: true,
      httpStatus: status
    });
  }
  return Object.freeze({
    kind: 'acceptance_unknown',
    reason: status >= 500 && status <= 599 ? 'connection_lost' : 'malformed_response',
    observation: status >= 500 && status <= 599 ? 'connection_lost' : 'malformed_response',
    requestDispatched: true,
    httpStatus: status
  });
}

function createRestTransport(input: Readonly<{
  accountId: string;
  tokenLease: CloudflareApiTokenLease;
  fetch: CloudflareFetch;
}>): CloudflareSendTransport<CloudflareRestEmailMessage> {
  if (!validAccountId(input.accountId)) {
    throw new TypeError('Cloudflare account ID has an invalid bounded shape');
  }
  const endpoint = `${API_ROOT}/accounts/${encodeURIComponent(input.accountId)}/email/sending/send`;
  const leaseResultBrand: unique symbol = Symbol('cloudflareApiTokenLeaseResult');
  const transport: CloudflareSendTransport<CloudflareRestEmailMessage> = {
    kind: 'bun_rest',
    async send(message) {
      let dispatched = false;
      let callbackUsed = false;
      try {
        const leased = await input.tokenLease.withApiToken(async (apiToken) => {
          if (callbackUsed) throw new TypeError('Cloudflare token lease callback may run once');
          callbackUsed = true;
          if (!validToken(apiToken)) throw new TypeError('Cloudflare API token is unavailable');
          dispatched = true;
          const response = await input.fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${apiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
          });
          return Object.freeze({ response, [leaseResultBrand]: true as const });
        });
        if (
          typeof leased !== 'object'
          || leased === null
          || !(leaseResultBrand in leased)
          || leased[leaseResultBrand] !== true
          || !('response' in leased)
          || !(leased.response instanceof Response)
        ) {
          if (!dispatched) {
            return Object.freeze({
              kind: 'known_rejected',
              retryClass: 'safe_retryable',
              code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.secretUnavailable,
              observation: 'secret_unavailable',
              requestDispatched: false
            });
          }
          return Object.freeze({
            kind: 'acceptance_unknown',
            reason: 'malformed_response',
            observation: 'malformed_response',
            requestDispatched: true
          });
        }
        const response = leased.response;
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* status remains authoritative */ }
          return normalizeErrorStatus(response.status);
        }
        const body = await readBoundedJson(response);
        if (body.kind === 'connection_lost') {
          return Object.freeze({
            kind: 'acceptance_unknown',
            reason: 'connection_lost',
            observation: 'connection_lost',
            requestDispatched: true,
            httpStatus: response.status
          });
        }
        if (body.kind === 'malformed') {
          return Object.freeze({
            kind: 'acceptance_unknown',
            reason: 'malformed_response',
            observation: 'malformed_response',
            requestDispatched: true,
            httpStatus: response.status
          });
        }
        return normalizeSuccessfulResponse(body.value, message.to, response.status);
      } catch (error) {
        if (!dispatched) {
          return Object.freeze({
            kind: 'known_rejected',
            retryClass: 'safe_retryable',
            code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.secretUnavailable,
            observation: 'secret_unavailable',
            requestDispatched: false
          });
        }
        const reason = timeoutLike(error) ? 'timeout' : 'connection_lost';
        return Object.freeze({
          kind: 'acceptance_unknown',
          reason,
          observation: reason,
          requestDispatched: true
        });
      }
    }
  };
  return Object.freeze(transport);
}

export function createCloudflareRestEmailProvider(input: Readonly<{
  accountId: string;
  tokenLease: CloudflareApiTokenLease;
  fetch: CloudflareFetch;
  readinessProbe?: CloudflareEmailReadinessProbe;
}>): CloudflareEmailProvider<CloudflareRestEmailMessage> {
  return createCloudflareEmailProvider({
    adapterKey: CLOUDFLARE_REST_EMAIL_ADAPTER_KEY,
    adapterVersion: CLOUDFLARE_EMAIL_ADAPTER_VERSION,
    manifest: CLOUDFLARE_REST_EMAIL_SETUP_MANIFEST,
    transport: createRestTransport(input),
    prepareEnvelope: buildCloudflareRestMessage,
    ...(input.readinessProbe === undefined ? {} : { readinessProbe: input.readinessProbe })
  });
}
