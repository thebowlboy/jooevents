import { providerMessageIdSchema } from '@jooevents/contracts';
import {
  CLOUDFLARE_EMAIL_ADAPTER_VERSION,
  CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
  CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST
} from './constants';
import {
  CLOUDFLARE_EMAIL_EVIDENCE_CODES,
  CLOUDFLARE_WORKERS_ERROR_CODES,
  type CloudflareWorkersErrorCode
} from './evidence';
import {
  buildCloudflareWorkersMessage,
  type CloudflareWorkersEmailMessage
} from './message';
import { createCloudflareEmailProvider, type CloudflareEmailProvider } from './provider';
import type { CloudflareEmailReadinessProbe } from './setup';
import type {
  CloudflareSendTransport,
  CloudflareSendTransportObservation
} from './transport';

export interface CloudflareEmailSendingBinding {
  send(message: CloudflareWorkersEmailMessage): Promise<Readonly<{ messageId: string }>>;
}

function errorCode(error: unknown): CloudflareWorkersErrorCode | undefined {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    const code = error.code;
    return typeof code === 'string'
      && (CLOUDFLARE_WORKERS_ERROR_CODES as readonly string[]).includes(code)
      ? code as CloudflareWorkersErrorCode
      : undefined;
  } catch {
    return undefined;
  }
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

function normalizeWorkersError(error: unknown): CloudflareSendTransportObservation {
  const providerCode = errorCode(error);
  if (providerCode === 'E_RATE_LIMIT_EXCEEDED') {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'safe_retryable',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.rateLimited,
      observation: 'rate_limited',
      requestDispatched: true,
      providerCode
    });
  }
  if (providerCode === 'E_DAILY_LIMIT_EXCEEDED') {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'safe_retryable',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.dailyLimit,
      observation: 'daily_limit_exceeded',
      requestDispatched: true,
      providerCode
    });
  }
  if (providerCode === 'E_SENDER_NOT_VERIFIED' || providerCode === 'E_SENDER_DOMAIN_NOT_AVAILABLE') {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.senderNotReady,
      observation: 'sender_not_ready',
      requestDispatched: true,
      providerCode
    });
  }
  if (providerCode === 'E_RECIPIENT_NOT_ALLOWED') {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.recipientNotAllowed,
      observation: 'recipient_not_allowed',
      requestDispatched: true,
      providerCode
    });
  }
  if (providerCode === 'E_RECIPIENT_SUPPRESSED') {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.recipientSuppressed,
      observation: 'recipient_suppressed',
      requestDispatched: true,
      providerCode
    });
  }
  if (providerCode === 'E_DELIVERY_FAILED') {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.deliveryFailed,
      observation: 'delivery_failed',
      requestDispatched: true,
      providerCode
    });
  }
  const invalid = new Set<CloudflareWorkersErrorCode>([
    'E_CONTENT_TOO_LARGE',
    'E_FIELD_MISSING',
    'E_HEADERS_TOO_LARGE',
    'E_HEADERS_TOO_MANY',
    'E_HEADER_NAME_INVALID',
    'E_HEADER_NOT_ALLOWED',
    'E_HEADER_USE_API_FIELD',
    'E_HEADER_VALUE_INVALID',
    'E_HEADER_VALUE_TOO_LONG',
    'E_TOO_MANY_ATTACHMENTS',
    'E_TOO_MANY_RECIPIENTS',
    'E_VALIDATION_ERROR'
  ]);
  if (providerCode !== undefined && invalid.has(providerCode)) {
    return Object.freeze({
      kind: 'known_rejected',
      retryClass: 'terminal',
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.invalidRequest,
      observation: 'invalid_request',
      requestDispatched: true,
      providerCode
    });
  }
  const reason = timeoutLike(error) ? 'timeout' : 'connection_lost';
  return Object.freeze({
    kind: 'acceptance_unknown',
    reason,
    observation: reason,
    requestDispatched: true,
    ...(providerCode === undefined ? {} : { providerCode })
  });
}

function createWorkersTransport(
  binding: CloudflareEmailSendingBinding
): CloudflareSendTransport<CloudflareWorkersEmailMessage> {
  const transport: CloudflareSendTransport<CloudflareWorkersEmailMessage> = {
    kind: 'workers_binding',
    async send(message) {
      try {
        const result = await binding.send(message);
        const messageId = providerMessageIdSchema.safeParse(
          typeof result === 'object' && result !== null && 'messageId' in result
            ? result.messageId
            : undefined
        );
        if (!messageId.success) {
          return Object.freeze({
            kind: 'acceptance_unknown',
            reason: 'malformed_response',
            observation: 'malformed_response',
            requestDispatched: true
          });
        }
        return Object.freeze({
          kind: 'accepted',
          providerMessageId: messageId.data,
          observation: 'accepted_workers',
          requestDispatched: true
        });
      } catch (error) {
        return normalizeWorkersError(error);
      }
    }
  };
  return Object.freeze(transport);
}

export function createCloudflareWorkersEmailProvider(input: Readonly<{
  binding: CloudflareEmailSendingBinding;
  readinessProbe?: CloudflareEmailReadinessProbe;
}>): CloudflareEmailProvider<CloudflareWorkersEmailMessage> {
  return createCloudflareEmailProvider({
    adapterKey: CLOUDFLARE_WORKERS_EMAIL_ADAPTER_KEY,
    adapterVersion: CLOUDFLARE_EMAIL_ADAPTER_VERSION,
    manifest: CLOUDFLARE_WORKERS_EMAIL_SETUP_MANIFEST,
    transport: createWorkersTransport(input.binding),
    prepareEnvelope: buildCloudflareWorkersMessage,
    ...(input.readinessProbe === undefined ? {} : { readinessProbe: input.readinessProbe })
  });
}
