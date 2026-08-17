import type { ExpectedDnsRecord } from '@jooevents/communications';

/**
 * The DNS records Cloudflare Email Sending documents for an onboarded sending
 * domain: SPF and DKIM on the `cf-bounce` subdomain it manages, and DMARC on
 * the domain itself. Cloudflare provisions these in-zone for Cloudflare-hosted
 * DNS; this declaration only lets the advisory deliverability check confirm
 * they publicly resolve. Cloudflare's own domain state stays authoritative —
 * a mismatch here is a prompt to re-check the provider console, not a gate.
 */
export function cloudflareEmailSendingExpectedDnsRecords(
  domain: string
): readonly ExpectedDnsRecord[] {
  return Object.freeze([
    Object.freeze({
      key: 'spf' as const,
      recordName: `cf-bounce.${domain}`,
      mustContain: Object.freeze(['v=spf1', 'include:_spf.mx.cloudflare.net'])
    }),
    Object.freeze({
      key: 'dkim' as const,
      recordName: `cf-bounce._domainkey.${domain}`,
      mustContain: Object.freeze(['v=DKIM1'])
    }),
    Object.freeze({
      key: 'dmarc' as const,
      recordName: `_dmarc.${domain}`,
      mustContain: Object.freeze(['v=DMARC1'])
    })
  ]);
}
