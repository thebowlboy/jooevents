import { describe, expect, test } from 'bun:test';
import { renderTransactionalEmail, type TransactionalEmailInput } from './transactional-email';

const BUTTON_URL = 'https://app.example.test/a/tok1_button';
const NAKED_LINK = 'https://app.example.test/a/tok1_naked';
const SITE_URL = 'https://jooevents.com';
const LOGO_URL = 'https://jooevents.com/assets/jooevents-wordmark.png';

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

  test('allows only the declared brand image as passive remote content', () => {
    const { htmlBody } = renderTransactionalEmail(input());
    const urls = htmlBody.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    for (const url of urls) {
      expect([BUTTON_URL, NAKED_LINK, SITE_URL, LOGO_URL]).toContain(url);
    }
    expect(urls.length).toBeGreaterThan(0);
    expect((htmlBody.match(/<img /g) ?? []).length).toBe(1);
    expect(htmlBody).toContain(`<img src="${LOGO_URL}" width="136" height="24" alt="JooEvents"`);
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

  test('places the quiet brand identity before the task and uses the brand action color', () => {
    const { htmlBody } = renderTransactionalEmail(input());
    const logoAt = htmlBody.indexOf(`<img src="${LOGO_URL}"`);
    const headingAt = htmlBody.indexOf('Sign in to JooEvents');
    const buttonAt = htmlBody.indexOf(`<a href="${BUTTON_URL}"`);
    expect(logoAt).toBeGreaterThan(0);
    expect(logoAt).toBeLessThan(headingAt);
    expect(headingAt).toBeLessThan(buttonAt);
    expect(htmlBody).toContain('background-color:#b05a4f;border-radius:6px');
  });

  test('a supplied event brand replaces both identity and action treatment', () => {
    const { htmlBody } = renderTransactionalEmail(input({
      productName: 'Northstar Conf',
      brand: {
        actionColor: '#214e78',
        logo: {
          url: 'https://northstar.example.test/brand/email-logo.png',
          alt: 'Northstar Conf', width: 120, height: 30
        }
      }
    }));
    expect(htmlBody).toContain('src="https://northstar.example.test/brand/email-logo.png"');
    expect(htmlBody).toContain('alt="Northstar Conf"');
    expect(htmlBody).toContain('background-color:#214e78;border-radius:6px');
    expect(htmlBody).not.toContain(LOGO_URL);
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
    expect(() => renderTransactionalEmail(input({
      brand: { actionColor: '#b05a4f', logo: {
        url: 'data:image/png;base64,nope', alt: 'JooEvents', width: 136, height: 24
      } }
    }))).toThrow('transactional_email_url_invalid');
  });

  test('refuses malformed brand colors and image geometry', () => {
    expect(() => renderTransactionalEmail(input({
      brand: { actionColor: 'black' }
    }))).toThrow('transactional_email_brand_invalid');
    expect(() => renderTransactionalEmail(input({
      brand: { actionColor: '#b05a4f', logo: {
        url: LOGO_URL, alt: 'JooEvents', width: 0, height: 24
      } }
    }))).toThrow('transactional_email_brand_invalid');
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
test('the action centers with a thumb-sized target and the naked link centered beneath', () => {
  const { htmlBody } = renderTransactionalEmail({
    subject: 'Your sign-in link',
    preheader: 'Sign in with one tap.',
    heading: 'Sign in to JooEvents',
    intro: ['Use the button below.'],
    button: { label: 'Sign in', url: 'https://example.test/a/tok' },
    nakedLink: 'https://example.test/a/tok',
    smallPrint: ['Works once.'],
    siteUrl: 'https://jooevents.com',
    productName: 'JooEvents'
  });
  // Centered even in clients that ignore auto margins.
  expect(htmlBody).toContain('align="center" cellpadding="0" cellspacing="0"');
  // 16px type + 15px vertical padding = a 54px surface, past 44pt/48dp, and
  // the padding sits on the anchor so the whole surface is the tap target.
  expect(htmlBody).toMatch(/<a [^>]*style="display:inline-block;padding:15px 44px;[^"]*font-size:16px/);
  // The copy-paste link centers with the button as one action unit.
  expect(htmlBody).toMatch(/text-align:center;[^"]*word-break:break-all/);
});
