import type { DnsTxtResolution, DnsTxtResolver } from '@jooevents/communications';

/**
 * DNS-over-HTTPS TXT resolver for the advisory deliverability check. It asks a
 * public resolver over plain `fetch`, so the same implementation serves the
 * Bun server and a Workers composition where `node:dns` does not exist. Every
 * failure is a typed `lookup_failed` resolution — a DNS outage diagnoses as
 * "could not check", never as a crash or as proof a record is absent.
 */

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
export const DOH_TXT_RESOLVER_KEY = 'doh.cloudflare-dns.com';
const MAXIMUM_RESPONSE_BYTES = 65_536;
const TXT_RECORD_TYPE = 16;
const DNS_STATUS_NOERROR = 0;
const DNS_STATUS_NXDOMAIN = 3;
const DEFAULT_TIMEOUT_MS = 5_000;

export type DohFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** dns-json TXT data arrives as one or more quoted character strings; join them. */
function normalizeTxtData(data: string): string {
  const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1]!.replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  );
  return chunks.length === 0 ? data : chunks.join('');
}

export function createDohTxtResolver(input: Readonly<{
  fetch: DohFetch;
  timeoutMs?: number;
}>): DnsTxtResolver {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Object.freeze({
    async resolveTxt(name: string): Promise<DnsTxtResolution> {
      let response: Response;
      try {
        response = await input.fetch(
          `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`,
          {
            headers: { accept: 'application/dns-json' },
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs)
          }
        );
      } catch {
        return Object.freeze({ kind: 'lookup_failed' });
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* status is authoritative */ }
        return Object.freeze({ kind: 'lookup_failed' });
      }
      let body: unknown;
      try {
        const text = await response.text();
        if (text.length > MAXIMUM_RESPONSE_BYTES) return Object.freeze({ kind: 'lookup_failed' });
        body = JSON.parse(text) as unknown;
      } catch {
        return Object.freeze({ kind: 'lookup_failed' });
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return Object.freeze({ kind: 'lookup_failed' });
      }
      const status = (body as { readonly Status?: unknown }).Status;
      if (status === DNS_STATUS_NXDOMAIN) return Object.freeze({ kind: 'no_records' });
      if (status !== DNS_STATUS_NOERROR) return Object.freeze({ kind: 'lookup_failed' });
      const answers = (body as { readonly Answer?: unknown }).Answer;
      const values = (Array.isArray(answers) ? answers : [])
        .filter((answer): answer is { readonly type: number; readonly data: string } =>
          typeof answer === 'object' && answer !== null
          && (answer as { readonly type?: unknown }).type === TXT_RECORD_TYPE
          && typeof (answer as { readonly data?: unknown }).data === 'string')
        .map((answer) => normalizeTxtData(answer.data));
      if (values.length === 0) return Object.freeze({ kind: 'no_records' });
      return Object.freeze({ kind: 'answers', values: Object.freeze(values) });
    }
  });
}
