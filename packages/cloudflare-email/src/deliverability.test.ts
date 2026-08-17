import { describe, expect, test } from 'bun:test';
import { cloudflareEmailSendingExpectedDnsRecords } from './deliverability';

describe('cloudflareEmailSendingExpectedDnsRecords', () => {
  test('declares the documented cf-bounce record layout for a sending domain', () => {
    const records = cloudflareEmailSendingExpectedDnsRecords('mail.example.test');
    expect(records).toEqual([
      {
        key: 'spf',
        recordName: 'cf-bounce.mail.example.test',
        mustContain: ['v=spf1', 'include:_spf.mx.cloudflare.net']
      },
      {
        key: 'dkim',
        recordName: 'cf-bounce._domainkey.mail.example.test',
        mustContain: ['v=DKIM1']
      },
      {
        key: 'dmarc',
        recordName: '_dmarc.mail.example.test',
        mustContain: ['v=DMARC1']
      }
    ]);
  });
});
