import type {
  RegisteredVerifiedIngressVerifier,
  VerifiedIngressVerificationResult
} from '@jooevents/application/verified-ingress';
import {
  parseAirtableBaseId,
  parseAirtableWebhookId,
  type AirtableBaseId,
  type AirtableWebhookId
} from '@jooevents/airtable';
import {
  canonicalJsonText,
  parseContractVersion,
  parseInstant,
  type SourceConnectionId,
  type VerifierRevisionId
} from '@jooevents/kernel';

export const AIRTABLE_WEBHOOK_VERIFIER_CONTRACT = Object.freeze({
  key: 'airtable.webhook-content-mac',
  version: parseContractVersion(1)
} as const);

export interface AirtableWebhookMacRegistration {
  readonly baseId: AirtableBaseId;
  readonly webhookId: AirtableWebhookId;
  readonly maximumNotificationAgeMs: number;
  withMacSecret<Result>(use: (secret: Uint8Array) => Promise<Result>): Promise<Result>;
}

export interface AirtableWebhookMacRegistrationResolver {
  resolve(sourceConnectionId: SourceConnectionId): Promise<AirtableWebhookMacRegistration | undefined>;
}

interface Notification {
  readonly baseId: AirtableBaseId;
  readonly webhookId: AirtableWebhookId;
  readonly timestamp: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function notification(rawEnvelope: Uint8Array): Notification | undefined {
  try {
    const parsed = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawEnvelope)));
    const base = object(parsed?.base);
    const webhook = object(parsed?.webhook);
    if (!parsed || !base || !webhook || typeof parsed.timestamp !== 'string') return undefined;
    return Object.freeze({
      baseId: parseAirtableBaseId(base.id),
      webhookId: parseAirtableWebhookId(webhook.id),
      timestamp: parseInstant(parsed.timestamp)
    });
  } catch {
    return undefined;
  }
}

function contentMac(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^hmac-sha256=([0-9a-fA-F]{64})$/.exec(value);
  if (!match?.[1]) return undefined;
  return Uint8Array.from(match[1].match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function expectedMac(secret: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
  const keyBytes = Uint8Array.from(secret).buffer as ArrayBuffer;
  const bodyBytes = Uint8Array.from(body).buffer as ArrayBuffer;
  const key = await globalThis.crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, bodyBytes));
}

function reject(
  reason: 'invalid_authenticity' | 'replay_window' | 'malformed_envelope' | 'ambiguous_evidence'
): VerifiedIngressVerificationResult {
  return Object.freeze({ kind: 'rejected', reason });
}

/** Exact raw-body verifier for Airtable's X-Airtable-Content-MAC callback. */
export function createAirtableWebhookVerifier(input: Readonly<{
  revisionId: VerifierRevisionId;
  registrations: AirtableWebhookMacRegistrationResolver;
  maximumFutureSkewMs?: number;
}>): RegisteredVerifiedIngressVerifier {
  const maximumFutureSkewMs = input.maximumFutureSkewMs ?? 5 * 60 * 1_000;
  if (!Number.isSafeInteger(maximumFutureSkewMs) || maximumFutureSkewMs < 0
    || maximumFutureSkewMs > 60 * 60 * 1_000) {
    throw new TypeError('airtable_webhook_future_skew_invalid');
  }
  return Object.freeze({
    contract: AIRTABLE_WEBHOOK_VERIFIER_CONTRACT,
    revisionId: input.revisionId,
    async verify(
      request: Parameters<RegisteredVerifiedIngressVerifier['verify']>[0]
    ): Promise<VerifiedIngressVerificationResult> {
      const evidence = object(request.protocolEvidence);
      if (!evidence || Object.keys(evidence).some((key) => key !== 'contentMac')) {
        return reject('ambiguous_evidence');
      }
      const suppliedMac = contentMac(evidence.contentMac);
      if (!suppliedMac) return reject('invalid_authenticity');
      const parsed = notification(request.rawEnvelope);
      if (!parsed) return reject('malformed_envelope');
      const registration = await input.registrations.resolve(request.sourceConnectionId);
      if (!registration) return reject('invalid_authenticity');
      if (registration.baseId !== parsed.baseId || registration.webhookId !== parsed.webhookId) {
        return reject('invalid_authenticity');
      }
      if (!Number.isSafeInteger(registration.maximumNotificationAgeMs)
        || registration.maximumNotificationAgeMs < 60_000
        || registration.maximumNotificationAgeMs > 7 * 24 * 60 * 60 * 1_000) {
        throw new TypeError('airtable_webhook_replay_window_invalid');
      }
      const receivedAtMs = Date.parse(request.receivedAt);
      const notificationAtMs = Date.parse(parsed.timestamp);
      if (notificationAtMs > receivedAtMs + maximumFutureSkewMs
        || receivedAtMs - notificationAtMs > registration.maximumNotificationAgeMs) {
        return reject('replay_window');
      }
      const authentic = await registration.withMacSecret(async (secret) =>
        equalBytes(await expectedMac(secret, request.rawEnvelope), suppliedMac)
      );
      if (!authentic) return reject('invalid_authenticity');
      const normalized = canonicalJsonText({
        baseId: parsed.baseId,
        webhookId: parsed.webhookId,
        timestamp: parsed.timestamp
      });
      return Object.freeze({
        kind: 'verified',
        semanticIdentityMaterial: new TextEncoder().encode(normalized),
        normalizedRetainedContent: new TextEncoder().encode(normalized)
      });
    }
  });
}
