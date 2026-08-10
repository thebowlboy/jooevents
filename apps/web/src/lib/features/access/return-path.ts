const OPERATOR_PATH = /^\/app(?:\/[^?#\\]*)?(?:\?[^#\\]*)?(?:#[^\\]*)?$/;

/** Browser convenience only; the server applies the same final redirect rule. */
export function safeOperatorReturnPath(candidate: string | null | undefined): string {
  if (!candidate || candidate.includes('\\') || candidate.startsWith('//')) return '/app';
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return '/app';
  }
  if (decoded !== candidate && /[\\?#]|\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) return '/app';
  if (!OPERATOR_PATH.test(candidate) || /(?:^|\/)\.\.?(?:\/|$)/.test(candidate)) return '/app';
  return candidate;
}
