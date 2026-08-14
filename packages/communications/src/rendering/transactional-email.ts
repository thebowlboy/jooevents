/**
 * Fixed transactional email layout shared by the security/sign-in lanes: one
 * hidden preheader, a heading, intro paragraphs, one bulletproof button, the
 * naked short link for copy-paste, small print, and a quiet host footer. The
 * output is deliberately self-contained — no images, no scripts, no external
 * references of any kind, all styles inline — with a neutral palette that
 * stays legible when a client inverts colors, and a text body that mirrors
 * the same content in the same order for text-only clients.
 */

const MAXIMUM_LINE_LENGTH = 1_000;
const MAXIMUM_LINES = 10;
const MAXIMUM_URL_LENGTH = 2_048;

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONOSPACE_STACK = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

// Neutral palette; nothing sits at a pure extreme so client dark-mode
// inversion keeps every pairing high-contrast.
const PAGE_BACKGROUND = '#eef0f3';
const CARD_BACKGROUND = '#fafbfc';
const CARD_BORDER = '#d8dce2';
const PRIMARY_TEXT = '#232936';
const SECONDARY_TEXT = '#5c6470';
const FOOTER_TEXT = '#7a828d';
const BUTTON_BACKGROUND = '#232936';
const BUTTON_TEXT = '#f5f7fa';

export interface TransactionalEmailInput {
  readonly subject: string;
  readonly preheader: string;
  readonly heading: string;
  readonly intro: readonly string[];
  readonly button: { readonly label: string; readonly url: string };
  readonly nakedLink: string;
  readonly smallPrint: readonly string[];
  readonly siteUrl: string;
  readonly productName: string;
}

export interface RenderedTransactionalEmail {
  readonly textBody: string;
  readonly htmlBody: string;
}

function assertLine(value: string): string {
  // Beyond C0/DEL controls, directional-override and zero-width formatting
  // characters are refused: a line carrying U+202E can visually reverse the
  // text beside a link — the classic direction-spoof — and nothing this
  // renderer legitimately says needs them.
  if (
    value.length === 0
    || value.length > MAXIMUM_LINE_LENGTH
    || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new TypeError('transactional_email_text_invalid');
  }
  return value;
}

function assertLines(values: readonly string[]): readonly string[] {
  if (values.length > MAXIMUM_LINES) throw new TypeError('transactional_email_text_invalid');
  return values.map(assertLine);
}

/** Rendered verbatim, so the bytes themselves must already be a safe URL. */
function assertHttpUrl(value: string): string {
  if (value.length > MAXIMUM_URL_LENGTH || /[\u0000-\u0020\u007f"'<>\\]/u.test(value)) {
    throw new TypeError('transactional_email_url_invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('transactional_email_url_invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('transactional_email_url_invalid');
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderTransactionalEmail(
  input: TransactionalEmailInput
): RenderedTransactionalEmail {
  const subject = assertLine(input.subject);
  const preheader = assertLine(input.preheader);
  const heading = assertLine(input.heading);
  const intro = assertLines(input.intro);
  const buttonLabel = assertLine(input.button.label);
  const buttonUrl = assertHttpUrl(input.button.url);
  const nakedLink = assertHttpUrl(input.nakedLink);
  const smallPrint = assertLines(input.smallPrint);
  const siteUrl = assertHttpUrl(input.siteUrl);
  const siteHost = assertLine(new URL(siteUrl).host);
  const productName = assertLine(input.productName);
  const footerLine = `© 2026 ${productName} · ${siteHost}`;

  const textBody = [
    heading,
    '',
    ...intro,
    '',
    nakedLink,
    '',
    ...smallPrint,
    '',
    footerLine
  ].join('\n');

  const bodyText = (size: number, lineHeight: number, color: string): string =>
    `font-family:${FONT_STACK};font-size:${size}px;line-height:${lineHeight}px;color:${color};`;
  const introHtml = intro.map((line) =>
    `<p style="margin:0 0 12px 0;${bodyText(15, 23, PRIMARY_TEXT)}">${escapeHtml(line)}</p>`
  ).join('');
  const smallPrintHtml = smallPrint.map((line) =>
    `<p style="margin:0 0 6px 0;${bodyText(13, 20, SECONDARY_TEXT)}">${escapeHtml(line)}</p>`
  ).join('');

  const htmlBody = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;background-color:${PAGE_BACKGROUND};">`,
    '<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;'
      + `opacity:0;overflow:hidden;">${escapeHtml(preheader)}</span>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
      + `style="border-collapse:collapse;background-color:${PAGE_BACKGROUND};">`,
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" '
      + 'style="border-collapse:collapse;width:100%;max-width:600px;">',
    // The card: heading, intro, the primary action, its copy-paste link, small print.
    '<tr><td style="'
      + `background-color:${CARD_BACKGROUND};border:1px solid ${CARD_BORDER};`
      + 'border-radius:8px;padding:36px 40px 26px 40px;">',
    `<h1 style="margin:0 0 16px 0;${bodyText(22, 30, PRIMARY_TEXT)}font-weight:600;">`
      + `${escapeHtml(heading)}</h1>`,
    introHtml,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
      + 'style="border-collapse:separate;margin:20px 0 12px 0;">',
    `<tr><td style="background-color:${BUTTON_BACKGROUND};border-radius:6px;">`,
    `<a href="${escapeHtml(buttonUrl)}" target="_blank" style="display:inline-block;`
      + `padding:12px 28px;${bodyText(15, 22, BUTTON_TEXT)}font-weight:600;`
      + `text-decoration:none;border-radius:6px;">${escapeHtml(buttonLabel)}</a>`,
    '</td></tr>',
    '</table>',
    `<p style="margin:0 0 24px 0;font-family:${MONOSPACE_STACK};font-size:12px;`
      + 'line-height:18px;word-break:break-all;">'
      + `<a href="${escapeHtml(nakedLink)}" target="_blank" `
      + `style="color:${SECONDARY_TEXT};text-decoration:underline;">`
      + `${escapeHtml(nakedLink)}</a></p>`,
    smallPrintHtml,
    '</td></tr>',
    // The quiet footer sits below the card so the action stays above the fold.
    `<tr><td align="center" style="padding:20px 8px 0 8px;${bodyText(12, 18, FOOTER_TEXT)}">`
      + `© 2026 ${escapeHtml(productName)} · `
      + `<a href="${escapeHtml(siteUrl)}" target="_blank" `
      + `style="color:${FOOTER_TEXT};text-decoration:underline;">${escapeHtml(siteHost)}</a>`
      + '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>'
  ].join('\n');

  return Object.freeze({ textBody, htmlBody });
}
