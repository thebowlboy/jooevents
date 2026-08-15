/**
 * Fixed transactional email layout shared by the security/sign-in lanes: one
 * hidden preheader, a heading, intro paragraphs, one bulletproof button, the
 * naked short link for copy-paste, small print, and a quiet host footer. The
 * output uses one explicitly supplied brand image and no other passive remote
 * content, no scripts, and no stylesheets. All styles stay inline, while the
 * text body mirrors the same content in the same order for text-only clients.
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
export interface TransactionalEmailBrand {
  /** Six-digit email-safe color. The renderer derives accessible button ink. */
  readonly actionColor: string;
  /** Omit the image until an approved, stable public asset is available. */
  readonly logo?: {
    readonly url: string;
    readonly alt: string;
    readonly width: number;
    readonly height: number;
  };
}

/** Product baseline used until a lane supplies the event's current brand. */
export const JOOEVENTS_TRANSACTIONAL_EMAIL_BRAND: TransactionalEmailBrand = Object.freeze({
  actionColor: '#b05a4f',
  logo: Object.freeze({
    url: 'https://jooevents.com/assets/jooevents-wordmark.png',
    alt: 'JooEvents',
    width: 136,
    height: 24
  })
});

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
  /** Defaults to the approved JooEvents email identity. */
  readonly brand?: TransactionalEmailBrand;
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

function assertColor(value: string): string {
  if (!/^#[0-9a-f]{6}$/u.test(value)) {
    throw new TypeError('transactional_email_brand_invalid');
  }
  return value;
}

function assertImageDimension(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_024) {
    throw new TypeError('transactional_email_brand_invalid');
  }
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function buttonTextColor(background: string): '#ffffff' | '#232936' {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#232936')
    ? '#ffffff'
    : '#232936';
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
  const brand = input.brand ?? JOOEVENTS_TRANSACTIONAL_EMAIL_BRAND;
  const actionColor = assertColor(brand.actionColor);
  const actionText = buttonTextColor(actionColor);
  const logo = brand.logo === undefined
    ? undefined
    : {
        url: assertHttpUrl(brand.logo.url),
        alt: assertLine(brand.logo.alt),
        width: assertImageDimension(brand.logo.width),
        height: assertImageDimension(brand.logo.height)
      };
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
      // 32px sides keep real content width on small phones; 600px desktop
      // still reads airy.
      + 'border-radius:8px;padding:36px 32px 26px 32px;">',
    ...(logo === undefined ? [] : [
      // The identity is deliberately quiet and unlinked: it establishes trust
      // before the task without competing with the only consequential action.
      `<div style="margin:0 0 22px 0;line-height:0;"><img src="${escapeHtml(logo.url)}" `
        + `width="${logo.width}" height="${logo.height}" alt="${escapeHtml(logo.alt)}" `
        + `style="display:block;width:${logo.width}px;height:${logo.height}px;border:0;outline:none;`
        + 'text-decoration:none;"></div>'
    ]),
    `<h1 style="margin:0 0 16px 0;${bodyText(22, 30, PRIMARY_TEXT)}font-weight:600;">`
      + `${escapeHtml(heading)}</h1>`,
    introHtml,
    // The action centers because a scrolling email controls its own vertical
    // position: horizontal center is the one thumb-reach lever this document
    // owns, and it is where a one-handed grip lands on either hand. The
    // anchor carries the padding so the whole 54px surface is the tap target
    // (16px type + 15px padding clears the 44pt/48dp floors); `align` on the
    // table centers it even where auto margins are ignored.
    '<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" '
      + 'style="border-collapse:separate;margin:28px auto 16px auto;">',
    `<tr><td style="background-color:${actionColor};border-radius:6px;">`,
    `<a href="${escapeHtml(buttonUrl)}" target="_blank" style="display:inline-block;`
      + `padding:15px 44px;${bodyText(16, 24, actionText)}font-weight:600;`
      + `text-decoration:none;border-radius:6px;">${escapeHtml(buttonLabel)}</a>`,
    '</td></tr>',
    '</table>',
    // The copy-paste link centers with the button as one action unit — and a
    // thumb that misses low lands on the same destination.
    `<p style="margin:0 0 24px 0;text-align:center;font-family:${MONOSPACE_STACK};font-size:12px;`
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
