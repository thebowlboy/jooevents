import { describe, expect, test } from 'bun:test';
import type { ExternalIdentityClaims } from './identity';
import {
  confirmLinkIncumbentSession,
  confirmLinkMailbox,
  confirmLinkProviderCeremony,
  finalizeIdentityLink,
  type IdentityLinkEvidence,
  type IdentityLinkRequest
} from './account-linking';

const now = '2026-08-09T08:00:00.000Z';
const request: IdentityLinkRequest = {
  id: 'link_ada_google',
  targetUserId: 'user_ada',
  provider: 'google',
  normalizedTargetEmail: 'ada@example.com',
  state: 'email_confirmation_pending',
  tokenHash: 'sha256:fixture-not-a-token',
  expiresAt: '2026-08-09T08:15:00.000Z',
  attempts: 0,
  version: 1,
  createdAt: now,
  updatedAt: now
};

const claims: ExternalIdentityClaims = {
  provider: 'google',
  issuer: 'https://accounts.google.com',
  subject: 'google-subject-ada-secondary',
  email: 'Ada@Example.com',
  emailVerified: true,
  observedAt: now
};

describe('account-linking policy', () => {
  test('advances one proof at a time and requires the incumbent user', () => {
    const mailbox = confirmLinkMailbox(request, { evidenceId: 'evidence_mailbox_ada', observedAt: now });
    expect(mailbox.kind).toBe('success');
    if (mailbox.kind !== 'success') return;

    const sessionRequest = { ...request, state: mailbox.data.nextState, version: 2 };
    const wrongUser = confirmLinkIncumbentSession(sessionRequest, {
      evidenceId: 'evidence_session_wrong',
      authenticatedUserId: 'user_grace',
      authenticatedAt: now,
      observedAt: now
    });
    expect(wrongUser.kind).toBe('error');
    if (wrongUser.kind === 'error') expect(wrongUser.error.code).toBe('identity_link_wrong_user');
  });

  test('never substitutes token issue time when provider authentication time is required', () => {
    const ceremony = confirmLinkProviderCeremony(
      { ...request, state: 'google_ceremony_required', version: 3 },
      {
        evidenceId: 'evidence_google_ada',
        claims,
        explicitIntentObservedAt: now,
        now,
        policy: { requireAuthTime: true, maximumAuthAgeSeconds: 600 }
      }
    );
    expect(ceremony.kind).toBe('error');
    if (ceremony.kind === 'error') expect(ceremony.error.code).toBe('identity_link_auth_time_missing');
  });

  test('finalization requires mailbox, session, and provider evidence', () => {
    const evidence: IdentityLinkEvidence[] = [
      { id: 'evidence_mailbox_ada', requestId: request.id, kind: 'mailbox_confirmation', observedAt: now },
      { id: 'evidence_google_ada', requestId: request.id, kind: 'provider_ceremony', provider: 'google', issuer: claims.issuer, subject: claims.subject, observedAt: now }
    ];
    const result = finalizeIdentityLink({ ...request, state: 'ready_to_link', version: 4 }, evidence, now);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error.code).toBe('identity_link_evidence_incomplete');
  });
});
