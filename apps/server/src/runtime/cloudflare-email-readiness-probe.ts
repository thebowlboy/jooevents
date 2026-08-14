import type {
  CloudflareApiTokenLease,
  CloudflareEmailReadinessProbe,
  CloudflareEmailReadinessProbeObservation,
  CloudflareFetch
} from '@jooevents/cloudflare-email';

/**
 * Concrete readiness probe for the `cloudflare.email.rest` transport
 * (external check key `cloudflare.email.outbound_ready`).
 *
 * Observable basis, stated honestly: the probe leases the configured API token
 * once and verifies it against Cloudflare's token-verification endpoint
 * (`GET /client/v4/user/tokens/verify`). A passing check therefore proves the
 * `cloudflare.transport.configured` claim — account identity, token
 * availability, token validity, and API reachability — the exact material a
 * REST send needs before dispatch. Cloudflare exposes no read surface in this
 * integration for per-domain sending state, so `cloudflare.domain.enabled`
 * regressions surface at dispatch time as terminal `sender_not_ready`
 * rejections in delivery history, never as silent losses.
 *
 * Failure honesty: a secret-resolver failure is a typed `known_failed`
 * observation (`transport_unavailable`), never a thrown error, so readiness
 * lands as recorded evidence instead of a crash loop. The token itself is
 * leased single-use inside this call and never appears in any observation.
 */

const TOKEN_VERIFY_ENDPOINT = 'https://api.cloudflare.com/client/v4/user/tokens/verify';
const MAXIMUM_RESPONSE_BYTES = 65_536;

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

function knownFailed(
  reason: Extract<CloudflareEmailReadinessProbeObservation, { kind: 'known_failed' }>['reason']
): CloudflareEmailReadinessProbeObservation {
  return Object.freeze({ kind: 'known_failed', reason });
}

function acceptanceUnknown(
  reason: Extract<CloudflareEmailReadinessProbeObservation, { kind: 'acceptance_unknown' }>['reason']
): CloudflareEmailReadinessProbeObservation {
  return Object.freeze({ kind: 'acceptance_unknown', reason });
}

async function readBoundedJson(response: Response): Promise<unknown | undefined> {
  try {
    const text = await response.text();
    if (text.length > MAXIMUM_RESPONSE_BYTES) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createCloudflareTokenVerificationReadinessProbe(input: Readonly<{
  tokenLease: CloudflareApiTokenLease;
  fetch: CloudflareFetch;
}>): CloudflareEmailReadinessProbe {
  return Object.freeze({
    async check(
      request: Parameters<CloudflareEmailReadinessProbe['check']>[0]
    ): Promise<CloudflareEmailReadinessProbeObservation> {
      if (request.contractVersion !== 1 || request.transport !== 'bun_rest') {
        return knownFailed('transport_unavailable');
      }
      let dispatched = false;
      let response: unknown;
      try {
        response = await input.tokenLease.withApiToken(async (apiToken) => {
          dispatched = true;
          return input.fetch(TOKEN_VERIFY_ENDPOINT, {
            method: 'GET',
            redirect: 'error',
            headers: { Authorization: `Bearer ${apiToken}` }
          });
        });
      } catch (error) {
        if (!dispatched) {
          // Secret lease unavailable (missing file, wrong mode, invalid
          // shape): a typed readiness failure, never a crash.
          return knownFailed('transport_unavailable');
        }
        return acceptanceUnknown(timeoutLike(error) ? 'timeout' : 'connection_lost');
      }
      if (!(response instanceof Response)) return acceptanceUnknown('malformed_response');
      if (response.status === 401) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        return knownFailed('authentication_failed');
      }
      if (response.status === 403) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        return knownFailed('authorization_failed');
      }
      if (response.status >= 500 && response.status <= 599) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        return acceptanceUnknown('connection_lost');
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        return knownFailed('transport_unavailable');
      }
      const body = await readBoundedJson(response);
      if (
        typeof body !== 'object' || body === null || Array.isArray(body)
        || (body as { readonly success?: unknown }).success !== true
      ) {
        return acceptanceUnknown('malformed_response');
      }
      const result = (body as { readonly result?: unknown }).result;
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        return acceptanceUnknown('malformed_response');
      }
      const status = (result as { readonly status?: unknown }).status;
      if (status !== 'active') {
        // A verified-but-inactive (expired/disabled) token cannot authorize sends.
        return knownFailed('authentication_failed');
      }
      return Object.freeze({
        kind: 'passed',
        readiness: 'ready',
        // The setup adapter clamps to the requested validity; the probe claims
        // no validity beyond what the caller requested under the manifest bound.
        validUntil: request.request.requestedValidUntil
      });
    }
  });
}
