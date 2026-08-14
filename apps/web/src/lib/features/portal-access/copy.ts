/* Participant entry copy. Registration is open on this surface, so the
   acknowledgement is plain rather than conditional. The action and the body
   name the method; no heading does, because the same composition later carries
   a code. */

export const participantEntryCopy = {
  heading: 'Sign in',
  /* Same method group as the operator lane, its own warm helper: this surface
     really does create access, so the line says so. */
  method: 'Magic link',
  intro: 'Enter the email address you use for your talks. New or returning, that is all you need.',
  label: 'Email address',
  submit: 'Email me a magic link',
  invalid: 'Enter an email address like name@example.com',
  confirmationHeading: 'Check your email',
  confirmationBody: 'We just emailed you a magic link. If the address is new here, it creates your access.',
  differentAddress: 'Try another address',
  backToSignIn: 'Back to sign in'
} as const;

export type ParticipantEntryNotice = 'session_expired' | 'signed_out';

export const participantNoticeCopy: Record<
  ParticipantEntryNotice,
  { readonly title: string; readonly message: string; readonly tone: 'info' | 'danger' }
> = {
  session_expired: { title: 'Your session ended', message: 'Enter your email to pick up where you left off.', tone: 'info' },
  signed_out: { title: 'Signed out', message: 'You can sign back in whenever you need to.', tone: 'info' }
};

export type ParticipantLinkFailure = 'link_expired' | 'link_used' | 'link_invalid';

export const participantLinkFailureCopy: Record<
  ParticipantLinkFailure,
  { readonly heading: string; readonly body: string }
> = {
  link_expired: { heading: 'That link has expired', body: 'Links are short-lived for your safety. Enter your email to get a fresh one.' },
  link_used: { heading: 'That link was already used', body: 'Each link works once. Enter your email to get a fresh one.' },
  link_invalid: { heading: 'That link is no longer valid', body: 'Requesting a new link replaces the old one, and an email app can also cut a link short. Enter your email to get a fresh one.' }
};

/** Expected refusals keep their own copy; nothing here echoes server text. */
export function participantRequestErrorCopy(code: string): { readonly title: string; readonly body: string } {
  return code === 'rate_limited'
    ? { title: 'Too many requests', body: 'Wait a minute before asking for another email.' }
    : { title: "Couldn't send that email", body: 'Check your connection and try again.' };
}

export function parseParticipantNotice(value: string | null): ParticipantEntryNotice | undefined {
  return value && Object.hasOwn(participantNoticeCopy, value) ? (value as ParticipantEntryNotice) : undefined;
}
