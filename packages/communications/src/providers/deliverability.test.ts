import { describe, expect, test } from 'bun:test';
import {
  checkEmailDeliverability,
  senderDomainFromAddress,
  type DnsTxtResolution,
  type DnsTxtResolver,
  type ExpectedDnsRecord
} from './deliverability';

const CHECKED_AT = '2026-08-16T12:00:00.000Z';

const RECORDS: readonly ExpectedDnsRecord[] = [
  { key: 'spf', recordName: 'cf-bounce.mail.example.test', mustContain: ['v=spf1', 'include:_spf.mx.cloudflare.net'] },
  { key: 'dkim', recordName: 'cf-bounce._domainkey.mail.example.test', mustContain: ['v=DKIM1'] },
  { key: 'dmarc', recordName: '_dmarc.mail.example.test', mustContain: ['v=DMARC1'] }
];

function resolver(answers: Record<string, DnsTxtResolution>): DnsTxtResolver {
  return {
    resolveTxt: (name) => Promise.resolve(answers[name] ?? { kind: 'no_records' })
  };
}

function check(answers: Record<string, DnsTxtResolution>) {
  return checkEmailDeliverability({
    domain: 'mail.example.test',
    records: RECORDS,
    resolver: resolver(answers),
    resolverKey: 'doh.test',
    checkedAt: CHECKED_AT
  });
}

describe('senderDomainFromAddress', () => {
  test('takes the lowercased right-hand side of one address', () => {
    expect(senderDomainFromAddress('Events@Mail.Example.Test')).toBe('mail.example.test');
    expect(senderDomainFromAddress('a@_odd.example.test')).toBe('_odd.example.test');
  });

  test('refuses non-addresses and non-hostnames', () => {
    expect(senderDomainFromAddress('no-address')).toBeNull();
    expect(senderDomainFromAddress('trailing@')).toBeNull();
    expect(senderDomainFromAddress('@leading.example')).toBeNull();
    expect(senderDomainFromAddress('a@single-label')).toBeNull();
    expect(senderDomainFromAddress('a@bad_.example')).toBeNull();
  });
});

describe('checkEmailDeliverability', () => {
  test('passes when every declared marker resolves, case-insensitively', async () => {
    const projection = await check({
      'cf-bounce.mail.example.test': {
        kind: 'answers',
        values: ['V=SPF1 include:_spf.mx.cloudflare.net ~all']
      },
      'cf-bounce._domainkey.mail.example.test': {
        kind: 'answers',
        values: ['v=dkim1; h=sha256; k=rsa; p=abc']
      },
      '_dmarc.mail.example.test': { kind: 'answers', values: ['v=DMARC1; p=none;'] }
    });
    expect(projection.overall).toBe('pass');
    expect(projection.advisory).toBe(true);
    expect(projection.records.map((record) => record.state)).toEqual([
      'found', 'found', 'found'
    ]);
  });

  test('a record present with different content is a mismatch, and mismatch means action', async () => {
    const projection = await check({
      'cf-bounce.mail.example.test': {
        kind: 'answers',
        values: ['v=spf1 include:other.example ~all']
      },
      'cf-bounce._domainkey.mail.example.test': {
        kind: 'answers',
        values: ['v=DKIM1; p=abc']
      },
      '_dmarc.mail.example.test': { kind: 'answers', values: ['v=DMARC1; p=reject'] }
    });
    expect(projection.records[0]!.state).toBe('mismatch');
    expect(projection.records[0]!.observedValues).toEqual(['v=spf1 include:other.example ~all']);
    expect(projection.overall).toBe('action_required');
  });

  test('an absent record is missing; markers never match across separate values', async () => {
    const projection = await check({
      'cf-bounce.mail.example.test': {
        kind: 'answers',
        // Both markers exist, but never inside one single TXT value.
        values: ['v=spf1 ~all', 'include:_spf.mx.cloudflare.net']
      },
      '_dmarc.mail.example.test': { kind: 'answers', values: ['v=DMARC1'] }
    });
    expect(projection.records[0]!.state).toBe('mismatch');
    expect(projection.records[1]!.state).toBe('missing');
    expect(projection.overall).toBe('action_required');
  });

  test('a failed lookup is unknown, not missing, and yields to real defects', async () => {
    const unknownOnly = await check({
      'cf-bounce.mail.example.test': {
        kind: 'answers',
        values: ['v=spf1 include:_spf.mx.cloudflare.net ~all']
      },
      'cf-bounce._domainkey.mail.example.test': { kind: 'lookup_failed' },
      '_dmarc.mail.example.test': { kind: 'answers', values: ['v=DMARC1'] }
    });
    expect(unknownOnly.records[1]!.state).toBe('lookup_failed');
    expect(unknownOnly.overall).toBe('unknown');

    const withDefect = await check({
      'cf-bounce.mail.example.test': { kind: 'lookup_failed' },
      'cf-bounce._domainkey.mail.example.test': { kind: 'no_records' },
      '_dmarc.mail.example.test': { kind: 'answers', values: ['v=DMARC1'] }
    });
    expect(withDefect.overall).toBe('action_required');
  });

  test('observed values stay bounded', async () => {
    const projection = await check({
      'cf-bounce.mail.example.test': {
        kind: 'answers',
        values: Array.from({ length: 12 }, () => 'x'.repeat(600))
      },
      'cf-bounce._domainkey.mail.example.test': { kind: 'answers', values: ['v=DKIM1'] },
      '_dmarc.mail.example.test': { kind: 'answers', values: ['v=DMARC1'] }
    });
    expect(projection.records[0]!.observedValues).toHaveLength(8);
    expect(projection.records[0]!.observedValues[0]).toHaveLength(512);
  });
});
