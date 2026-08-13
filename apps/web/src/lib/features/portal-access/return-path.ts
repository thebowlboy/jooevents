const PARTICIPANT_PATH = /^\/portal(?:\/[^?#\\]*)?(?:\?[^#\\]*)?(?:#[^\\]*)?$/;
/* The participant entry routes live inside the namespace they guard, so they
   are excluded explicitly rather than by living outside it. */
const ENTRY_PATH = /^\/portal\/(?:sign-in|auth)(?:[/?#]|$)/;

/** Browser convenience only; the server applies the same final redirect rule. */
export function safeParticipantReturnPath(candidate: string | null | undefined): string {
  if (!candidate || candidate.includes('\\') || candidate.startsWith('//')) return '/portal';
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return '/portal';
  }
  if (decoded !== candidate && /[\\?#]|\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) return '/portal';
  if (!PARTICIPANT_PATH.test(candidate) || /(?:^|\/)\.\.?(?:\/|$)/.test(candidate)) return '/portal';
  if (ENTRY_PATH.test(candidate) || ENTRY_PATH.test(decoded)) return '/portal';
  return candidate;
}
