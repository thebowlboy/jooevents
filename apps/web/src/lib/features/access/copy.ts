export const blockedCopy = {
  suspended: {
    heading: 'Your workspace access is paused',
    body: 'A workspace administrator can help you understand or restore this membership.'
  },
  deactivated: {
    heading: 'This membership is no longer active',
    body: 'A workspace administrator must restore the membership before this account can enter.'
  },
  not_admitted: {
    heading: 'This Google account cannot enter this workspace',
    body: 'Try the Google account that received your invitation, or contact the workspace team.'
  }
} as const;

export type EntryNotice =
  | 'session_ended'
  | 'provider_cancelled'
  | 'provider_error'
  | 'signed_out'
  | 'link_expired'
  | 'link_used'
  | 'link_invalid';

export const noticeCopy: Record<EntryNotice, { readonly title: string; readonly message: string; readonly tone: 'info' | 'danger' }> = {
  session_ended: { title: 'Session ended', message: 'Sign in again to return to your work.', tone: 'info' },
  provider_cancelled: { title: "Sign-in wasn't completed", message: 'You can try again or use a different Google account.', tone: 'info' },
  provider_error: { title: "Google sign-in couldn't finish", message: 'Check your connection and try again.', tone: 'danger' },
  signed_out: { title: 'Signed out', message: 'Your JooEvents session ended successfully.', tone: 'info' },
  /* Closed link outcomes. None of them says whether the address is registered. */
  link_expired: { title: 'That link has expired', message: 'Sign-in links are short-lived. Ask for a new one below.', tone: 'info' },
  link_used: { title: 'That link was already used', message: 'Each sign-in link works once. Ask for a new one below.', tone: 'info' },
  link_invalid: { title: "That link didn't work", message: 'Ask for a new one below, or continue with Google.', tone: 'info' }
};

export const linkRequestCopy = {
  /* The group names the method, so the field below it can stay plain and the
     helper can sell the method instead of instructing the typist. Nothing here
     says anything about whether a given address exists. */
  method: 'Magic link',
  methodHelp: "We'll email you a link that signs you in — no password, nothing to remember.",
  label: 'Email address',
  submit: 'Email me a magic link',
  invalid: 'Enter an email address like name@example.com',
  /* Owner revision 2026-08-15: the magic link owns the card; the divider
     hands off to a quiet provider alternative. */
  divider: 'or',
  aside: 'No sign-up here. Entry is for those who know.',
  /* Verbatim non-enumerating acknowledgement: identical on match and miss. The
     heading names no method so a code can share this room later. */
  confirmationHeading: 'Check your email',
  confirmationBody: 'If an account exists for this address, a magic link is on its way.',
  differentAddress: 'Try another address'
} as const;

/** Expected refusals keep their own copy; nothing here echoes server text. */
export function linkRequestErrorCopy(code: string): { readonly title: string; readonly body: string } {
  return code === 'rate_limited'
    ? { title: 'Too many requests', body: 'Wait a minute before asking for another email.' }
    : { title: "Couldn't send that email", body: 'Check your connection and try again.' };
}

export function parseEntryNotice(value: string | null): EntryNotice | undefined {
  return value && Object.hasOwn(noticeCopy, value) ? value as EntryNotice : undefined;
}
