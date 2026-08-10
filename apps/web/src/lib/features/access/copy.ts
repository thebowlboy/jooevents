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

export type EntryNotice = 'session_ended' | 'provider_cancelled' | 'provider_error' | 'signed_out';

export const noticeCopy: Record<EntryNotice, { readonly title: string; readonly message: string; readonly tone: 'info' | 'danger' }> = {
  session_ended: { title: 'Session ended', message: 'Sign in again to return to your work.', tone: 'info' },
  provider_cancelled: { title: "Sign-in wasn't completed", message: 'You can try again or use a different Google account.', tone: 'info' },
  provider_error: { title: "Google sign-in couldn't finish", message: 'Check your connection and try again.', tone: 'danger' },
  signed_out: { title: 'Signed out', message: 'Your JooEvents session ended successfully.', tone: 'info' }
};

export function parseEntryNotice(value: string | null): EntryNotice | undefined {
  return value && Object.hasOwn(noticeCopy, value) ? value as EntryNotice : undefined;
}
