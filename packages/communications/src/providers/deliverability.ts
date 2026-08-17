import {
  emailDeliverabilityCheckProjectionSchema,
  type EmailDeliverabilityCheckProjection,
  type EmailDeliverabilityRecordCheck
} from '@jooevents/contracts';

/**
 * Advisory public-DNS deliverability checks.
 *
 * The checker verifies that the records a provider adapter *declares* are
 * publicly resolvable and carry the declared markers. It is a diagnosis for a
 * person finishing setup, never a gate: provider readiness evidence stays the
 * only authority for whether the send lane runs, and no result here is
 * persisted as effective state.
 */

export type DnsTxtResolution =
  | Readonly<{ kind: 'answers'; values: readonly string[] }>
  | Readonly<{ kind: 'no_records' }>
  | Readonly<{ kind: 'lookup_failed' }>;

export interface DnsTxtResolver {
  resolveTxt(name: string): Promise<DnsTxtResolution>;
}

export type ExpectedDnsRecord = Readonly<{
  key: 'spf' | 'dkim' | 'dmarc';
  recordName: string;
  /** Case-insensitive substrings one single TXT value must all carry. */
  mustContain: readonly string[];
}>;

const OBSERVED_VALUE_MAXIMUM_LENGTH = 512;
const OBSERVED_VALUES_MAXIMUM = 8;
const DNS_NAME_PATTERN =
  /^[a-z0-9_]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9_]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

/** The sending domain is the from-address's right-hand side, or null when it is not one hostname. */
export function senderDomainFromAddress(address: string): string | null {
  const separator = address.lastIndexOf('@');
  if (separator < 1 || separator === address.length - 1) return null;
  const domain = address.slice(separator + 1).toLowerCase();
  return DNS_NAME_PATTERN.test(domain) ? domain : null;
}

function evaluateRecord(
  expected: ExpectedDnsRecord,
  resolution: DnsTxtResolution
): EmailDeliverabilityRecordCheck {
  const base = {
    key: expected.key,
    recordName: expected.recordName,
    recordType: 'TXT' as const,
    mustContain: [...expected.mustContain]
  };
  if (resolution.kind === 'lookup_failed') {
    return { ...base, state: 'lookup_failed', observedValues: [] };
  }
  if (resolution.kind === 'no_records' || resolution.values.length === 0) {
    return { ...base, state: 'missing', observedValues: [] };
  }
  const observedValues = resolution.values
    .slice(0, OBSERVED_VALUES_MAXIMUM)
    .map((value) => value.slice(0, OBSERVED_VALUE_MAXIMUM_LENGTH));
  const satisfied = resolution.values.some((value) => {
    const candidate = value.toLowerCase();
    return expected.mustContain.every((marker) => candidate.includes(marker.toLowerCase()));
  });
  return { ...base, state: satisfied ? 'found' : 'mismatch', observedValues };
}

export async function checkEmailDeliverability(input: Readonly<{
  domain: string;
  records: readonly ExpectedDnsRecord[];
  resolver: DnsTxtResolver;
  resolverKey: string;
  checkedAt: string;
}>): Promise<EmailDeliverabilityCheckProjection> {
  const records: EmailDeliverabilityRecordCheck[] = [];
  // Sequential on purpose: three bounded lookups, and a shared-cause failure
  // (no route to the resolver) reads as one story instead of a burst.
  for (const expected of input.records) {
    records.push(evaluateRecord(expected, await input.resolver.resolveTxt(expected.recordName)));
  }
  const overall = records.some(
    (record) => record.state === 'missing' || record.state === 'mismatch'
  )
    ? 'action_required'
    : records.some((record) => record.state === 'lookup_failed')
      ? 'unknown'
      : 'pass';
  return emailDeliverabilityCheckProjectionSchema.parse({
    schemaVersion: 1,
    advisory: true,
    domain: input.domain,
    resolverKey: input.resolverKey,
    records,
    overall,
    checkedAt: input.checkedAt
  });
}
