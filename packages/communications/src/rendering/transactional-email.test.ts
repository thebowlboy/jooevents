import { describe, expect, test } from 'bun:test';
import { renderTransactionalEmail, type TransactionalEmailInput } from './transactional-email';

const BUTTON_URL = 'https://app.example.test/a/tok1_button';
const NAKED_LINK = 'https://app.example.test/a/tok1_naked';
const SITE_URL = 'https://jooevents.com';

function input(overrides: Partial<TransactionalEmailInput> = {}): TransactionalEmailInput {
  return {
    subject: 'Your sign-in link',
    preheader: 'Your one-time link to sign in.',
    heading: 'Sign in to JooEvents',
    intro: ['Use this link to sign in:'],
    button: { label: 'Sign in', url: BUTTON_URL },
    nakedLink: NAKED_LINK,
    smallPrint: [
      'The link is valid for 15 minutes and works once.',
      'If you did not request it, you can ignore this email.'
    ],
    siteUrl: SITE_URL,
    productName: 'JooEvents',
    ...overrides
  };
}

function anchorHrefs(html: string): readonly string[] {
  return [...html.matchAll(/<a href="([^"]*)"/g)].map((match) => match[1]!);
}

describe('transactional email rendering', () => {
  test('exactly one anchor each for the button, the naked link, and the site link', () => {
    const { htmlBody } = renderTransactionalEmail(input());
    const hrefs = anchorHrefs(htmlBody);
    expect(hrefs).toEqual([BUTTON_URL, NAKED_LINK, SITE_URL]);
    expect((htmlBody.match(/<a /g) ?? []).length).toBe(3);
  });

  test('no URL beyond the three declared links, and no external-request vector', () => {
    const { htmlBody } = renderTransactionalEmail(input());
    const urls = htmlBody.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    for (const url of urls) {
      expect([BUTTON_URL, NAKED_LINK, SITE_URL]).toContain(url);
    }
    expect(urls.length).toBeGreaterThan(0);
    expect(htmlBody).not.toContain('<img');
    expect(htmlBody).not.toContain('<script');
    expect(htmlBody).not.toContain('@import');
    expect(htmlBody).not.toContain('url(');
  });

  test('the hidden preheader comes first and the layout stays a bounded single column', () => {
    const { htmlBody } = renderTransactionalEmail(input());
    const preheaderAt = htmlBody.indexOf('Your one-time link to sign in.');
    expect(htmlBody.slice(0, preheaderAt)).toContain('display:none');
    expect(preheaderAt).toBeLessThan(htmlBody.indexOf('Sign in to JooEvents'));
    expect(htmlBody).toContain('max-width:600px');
    // The primary action sits above the small print and the quiet footer.
    const buttonAt = htmlBody.indexOf(`<a href="${BUTTON_URL}"`);
    expect(buttonAt).toBeLessThan(htmlBody.indexOf('works once'));
    expect(buttonAt).toBeLessThan(htmlBody.indexOf('© 2026'));
  });

  test('the footer credits the product and links the site host', () => {
    const { htmlBody } = renderTransactionalEmail(input());
    expect(htmlBody).toContain('© 2026 JooEvents · ');
    expect(htmlBody).toContain(`<a href="${SITE_URL}"`);
    expect(htmlBody).toContain('>jooevents.com</a>');
  });

  test('the text body mirrors the content in order and carries the naked link verbatim', () => {
    const { textBody } = renderTransactionalEmail(input());
    expect(textBody).toBe([
      'Sign in to JooEvents',
      '',
      'Use this link to sign in:',
      '',
      NAKED_LINK,
      '',
      'The link is valid for 15 minutes and works once.',
      'If you did not request it, you can ignore this email.',
      '',
      '© 2026 JooEvents · jooevents.com'
    ].join('\n'));
  });

  test('content is HTML-escaped everywhere it is interpolated', () => {
    const { htmlBody } = renderTransactionalEmail(input({
      heading: 'Tick & <tock>',
      intro: ['A "quoted" line'],
      productName: "O'Product"
    }));
    expect(htmlBody).toContain('Tick &amp; &lt;tock&gt;');
    expect(htmlBody).toContain('A &quot;quoted&quot; line');
    expect(htmlBody).toContain('O&#39;Product');
    expect(htmlBody).not.toContain('<tock>');
  });

  test('refuses non-http(s), unparseable, and attribute-breaking URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'not a url',
      'https://app.example.test/a/tok"onclick=x',
      'data:text/html,x'
    ]) {
      expect(() => renderTransactionalEmail(input({ nakedLink: url })))
        .toThrow('transactional_email_url_invalid');
      expect(() => renderTransactionalEmail(input({ button: { label: 'Sign in', url } })))
        .toThrow('transactional_email_url_invalid');
    }
    expect(() => renderTransactionalEmail(input({ siteUrl: 'ftp://jooevents.com' })))
      .toThrow('transactional_email_url_invalid');
  });

  test('refuses empty and control-character text lines', () => {
    expect(() => renderTransactionalEmail(input({ heading: '' })))
      .toThrow('transactional_email_text_invalid');
    expect(() => renderTransactionalEmail(input({ intro: ['line one\nline two'] })))
      .toThrow('transactional_email_text_invalid');
    expect(() => renderTransactionalEmail(input({ subject: 'sub\u0000ject' })))
      .toThrow('transactional_email_text_invalid');
  });
});
test('directional-override and zero-width characters are refused in every line', () => {
  for (const hostile of ['pay\u202eattention', 'zero\u200bwidth', 'isolate\u2066text\u2069']) {
    expect(() => renderTransactionalEmail({
      subject: 'Your sign-in link',
      preheader: 'Sign in with one tap.',
      heading: 'Sign in to JooEvents',
      intro: [hostile],
      button: { label: 'Sign in', url: 'https://example.test/a/tok' },
      nakedLink: 'https://example.test/a/tok',
      smallPrint: ['Works once.'],
      siteUrl: 'https://jooevents.com',
      productName: 'JooEvents'
    })).toThrow('transactional_email_text_invalid');
  }
});

