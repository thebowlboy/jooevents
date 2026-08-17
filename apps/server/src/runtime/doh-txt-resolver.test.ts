import { describe, expect, test } from 'bun:test';
import { createDohTxtResolver } from './doh-txt-resolver';

function dnsJson(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/dns-json' },
    ...init
  });
}

describe('createDohTxtResolver', () => {
  test('asks the resolver for TXT records with the dns-json accept header', async () => {
    let requested: { url: string; accept: string | undefined } | undefined;
    const resolver = createDohTxtResolver({
      fetch: (url, init) => {
        requested = {
          url,
          accept: new Headers(init?.headers).get('accept') ?? undefined
        };
        return Promise.resolve(dnsJson({ Status: 0, Answer: [] }));
      }
    });
    await resolver.resolveTxt('_dmarc.mail.example.test');
    expect(requested).toEqual({
      url: 'https://cloudflare-dns.com/dns-query?name=_dmarc.mail.example.test&type=TXT',
      accept: 'application/dns-json'
    });
  });

  test('joins quoted character-string chunks and keeps only TXT answers', async () => {
    const resolver = createDohTxtResolver({
      fetch: () => Promise.resolve(dnsJson({
        Status: 0,
        Answer: [
          { type: 16, data: '"v=spf1 include:_spf.mx" ".cloudflare.net ~all"' },
          { type: 5, data: 'alias.example.test.' },
          { type: 16, data: 'unquoted-form' }
        ]
      }))
    });
    expect(await resolver.resolveTxt('cf-bounce.mail.example.test')).toEqual({
      kind: 'answers',
      values: ['v=spf1 include:_spf.mx.cloudflare.net ~all', 'unquoted-form']
    });
  });

  test('NXDOMAIN and empty answers are no_records, never failures', async () => {
    const nxdomain = createDohTxtResolver({
      fetch: () => Promise.resolve(dnsJson({ Status: 3 }))
    });
    expect(await nxdomain.resolveTxt('x.example.test')).toEqual({ kind: 'no_records' });
    const empty = createDohTxtResolver({
      fetch: () => Promise.resolve(dnsJson({ Status: 0 }))
    });
    expect(await empty.resolveTxt('x.example.test')).toEqual({ kind: 'no_records' });
  });

  test('server errors, network throws, and malformed bodies are lookup_failed', async () => {
    const serverError = createDohTxtResolver({
      fetch: () => Promise.resolve(new Response('gone', { status: 502 }))
    });
    expect(await serverError.resolveTxt('x.example.test')).toEqual({ kind: 'lookup_failed' });
    const thrown = createDohTxtResolver({
      fetch: () => Promise.reject(new TypeError('network down'))
    });
    expect(await thrown.resolveTxt('x.example.test')).toEqual({ kind: 'lookup_failed' });
    const malformed = createDohTxtResolver({
      fetch: () => Promise.resolve(new Response('not-json', { status: 200 }))
    });
    expect(await malformed.resolveTxt('x.example.test')).toEqual({ kind: 'lookup_failed' });
    const refused = createDohTxtResolver({
      fetch: () => Promise.resolve(dnsJson({ Status: 2 }))
    });
    expect(await refused.resolveTxt('x.example.test')).toEqual({ kind: 'lookup_failed' });
  });
});
