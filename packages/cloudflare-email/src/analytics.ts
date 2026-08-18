import { OUTBOUND_EMAIL_PROVIDER_REQUEST_BUDGET_MS } from '@jooevents/communications';
import { createCloudflareEmailEvidence } from './evidence';
import type { CloudflareApiTokenLease, CloudflareFetch } from './rest';

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const MAXIMUM_RESPONSE_BYTES = 65_536;

const RECENT_EMAIL_EVENTS_QUERY = `
query RecentEmailEvents($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      emailSendingAdaptive(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: 50
        orderBy: [datetime_DESC]
      ) {
        datetime
        messageId
        status
        errorCause
        errorDetail
        isLastEvent
      }
    }
  }
}`;

export type CloudflareEmailDeliveryLookupResult =
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{
      kind: 'found';
      disposition: 'delivered' | 'delivery_failed';
      providerMessageId: string;
      providerEventKey: string;
      providerObservedAt: string;
      safeEvidence: ReturnType<typeof createCloudflareEmailEvidence>;
    }>
  | Readonly<{ kind: 'unavailable'; reason: 'invalid_response' | 'request_failed' }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hashed = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function boundedJson(response: Response): Promise<unknown | undefined> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAXIMUM_RESPONSE_BYTES) return undefined;
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function events(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!record(value) || value.errors !== undefined || !record(value.data)) return undefined;
  const viewer = value.data.viewer;
  if (!record(viewer) || !Array.isArray(viewer.zones) || viewer.zones.length !== 1) return undefined;
  const zone = viewer.zones[0];
  if (!record(zone) || !Array.isArray(zone.emailSendingAdaptive)
      || !zone.emailSendingAdaptive.every(record)) return undefined;
  return zone.emailSendingAdaptive;
}

/**
 * Pull-first per-message delivery lookup over Cloudflare's zone-level
 * `emailSendingAdaptive` event dataset. Recipient/subject/error bytes are not
 * returned or persisted; only the matching provider identity and normalized
 * disposition cross this adapter boundary.
 */
export function createCloudflareEmailDeliveryLookup(input: Readonly<{
  zoneId: string;
  tokenLease: CloudflareApiTokenLease;
  fetch: CloudflareFetch;
}>) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.zoneId)) {
    throw new TypeError('Cloudflare zone ID has an invalid bounded shape');
  }
  return Object.freeze({
    async lookup(candidate: Readonly<{
      providerMessageId: string;
      start: string;
      end: string;
    }>): Promise<CloudflareEmailDeliveryLookupResult> {
      if (candidate.providerMessageId.length < 1 || candidate.providerMessageId.length > 512
          || !Number.isFinite(Date.parse(candidate.start)) || !Number.isFinite(Date.parse(candidate.end))
          || Date.parse(candidate.start) > Date.parse(candidate.end)) {
        throw new TypeError('Cloudflare email lookup input is invalid');
      }
      try {
        const response = await input.tokenLease.withApiToken((apiToken) => input.fetch(
          GRAPHQL_ENDPOINT,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiToken}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              query: RECENT_EMAIL_EVENTS_QUERY,
              variables: { zoneTag: input.zoneId, start: candidate.start, end: candidate.end }
            }),
            signal: AbortSignal.timeout(OUTBOUND_EMAIL_PROVIDER_REQUEST_BUDGET_MS)
          }
        ));
        if (!response.ok) return Object.freeze({ kind: 'unavailable', reason: 'request_failed' });
        const rows = events(await boundedJson(response));
        if (rows === undefined) return Object.freeze({ kind: 'unavailable', reason: 'invalid_response' });
        for (const row of rows) {
          if (row.messageId !== candidate.providerMessageId) continue;
          if (row.status !== 'delivered' && row.status !== 'deliveryFailed') continue;
          if (typeof row.datetime !== 'string' || !Number.isFinite(Date.parse(row.datetime))) {
            return Object.freeze({ kind: 'unavailable', reason: 'invalid_response' });
          }
          const disposition = row.status === 'delivered' ? 'delivered' as const : 'delivery_failed' as const;
          const identityDigest = await sha256(JSON.stringify({
            zoneId: input.zoneId,
            providerMessageId: candidate.providerMessageId,
            datetime: row.datetime,
            status: row.status,
            isLastEvent: row.isLastEvent ?? null
          }));
          return Object.freeze({
            kind: 'found',
            disposition,
            providerMessageId: candidate.providerMessageId,
            providerEventKey: `cloudflare.graphql.${identityDigest}`,
            providerObservedAt: new Date(row.datetime).toISOString(),
            safeEvidence: createCloudflareEmailEvidence({
              code: disposition === 'delivered'
                ? 'cloudflare.email.accepted'
                : 'cloudflare.email.rejected.delivery_failed',
              correlationDigestSha256: identityDigest,
              transport: 'graphql_analytics',
              observation: disposition === 'delivered' ? 'delivery_confirmed' : 'delivery_failed',
              requestDispatched: false
            })
          });
        }
        return Object.freeze({ kind: 'not_found' });
      } catch {
        return Object.freeze({ kind: 'unavailable', reason: 'request_failed' });
      }
    }
  });
}
