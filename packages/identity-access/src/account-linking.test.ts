import { describe, expect, test } from 'bun:test';
import type { ExternalIdentityClaims } from './identity';
import {
  confirmLinkIncumbentSession,
  confirmLinkMailbox,
  confirmLinkProviderCeremony,
  finalizeIdentityLink,
  recordLinkExplicitIntent,
  type IdentityLinkEvidence,
  type IdentityLinkExplicitIntentEvidence,
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

const explicitIntentEvidence: IdentityLinkExplicitIntentEvidence = {
  id: 'evidence_intent_ada',
  requestId: request.id,
  kind: 'explicit_intent',
  observedAt: now
};

function completeEvidence(): IdentityLinkEvidence[] {
  return [
    { id: 'evidence_mailbox_ada', requestId: request.id, kind: 'mailbox_confirmation', observedAt: now },
    { id: 'evidence_session_ada', requestId: request.id, kind: 'incumbent_session', authenticatedAt: now, observedAt: now },
    explicitIntentEvidence,
    {
      id: 'evidence_google_ada',
      requestId: request.id,
      kind: 'provider_ceremony',
      provider: claims.provider,
      issuer: claims.issuer,
      subject: claims.subject,
      authenticatedAt: now,
      observedAt: now
    }
  ];
}

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
        explicitIntentEvidence,
        now,
        policy: { requireAuthTime: true, maximumAuthAgeSeconds: 600 }
      }
    );
    expect(ceremony.kind).toBe('error');
    if (ceremony.kind === 'error') expect(ceremony.error.code).toBe('identity_link_auth_time_missing');
  });

  test('records explicit intent as its own request-bound versioned transition', () => {
    const intent = recordLinkExplicitIntent(
      { ...request, state: 'google_ceremony_required', version: 3 },
      { evidenceId: explicitIntentEvidence.id, observedAt: explicitIntentEvidence.observedAt }
    );
    expect(intent.kind).toBe('success');
    if (intent.kind === 'success') {
      expect(intent.data).toEqual({
        requestId: request.id,
        expectedVersion: 3,
        nextState: 'google_ceremony_required',
        evidence: {
          id: explicitIntentEvidence.id,
          kind: 'explicit_intent',
          observedAt: explicitIntentEvidence.observedAt
        }
      });
    }
  });

  test('rejects non-canonical, stale, and post-expiry explicit-intent observations', () => {
    const intentRequest = { ...request, state: 'google_ceremony_required' as const, version: 3 };
    for (const observedAt of [
      'not-an-instant',
      '2026-08-09T07:59:59.999Z',
      request.expiresAt
    ]) {
      const intent = recordLinkExplicitIntent(intentRequest, {
        evidenceId: 'evidence_intent_ada',
        observedAt
      });
      expect(intent.kind).toBe('error');
      if (intent.kind === 'error') expect(intent.error.code).toBe(
        observedAt === request.expiresAt ? 'identity_link_expired' : 'identity_link_explicit_intent_invalid'
      );
    }
  });

  test('accepts a canonical provider authentication time at the freshness boundary', () => {
    const ceremony = confirmLinkProviderCeremony(
      { ...request, state: 'google_ceremony_required', version: 3 },
      {
        evidenceId: 'evidence_google_ada',
        claims,
        authenticationTime: '2026-08-09T07:50:00.000Z',
        explicitIntentEvidence,
        now,
        policy: { requireAuthTime: true, maximumAuthAgeSeconds: 600 }
      }
    );
    expect(ceremony.kind).toBe('success');
    if (ceremony.kind === 'success') {
      expect(ceremony.data.evidence).toMatchObject({
        provider: 'google',
        issuer: claims.issuer,
        subject: claims.subject,
        authenticatedAt: '2026-08-09T07:50:00.000Z'
      });
    }
  });

  test('rejects invalid and future provider authentication times before comparing freshness', () => {
    const adversarialTimes = [
      ['not-an-instant', 'identity_link_authentication_time_invalid'],
      ['2026-02-30T08:00:00.000Z', 'identity_link_authentication_time_invalid'],
      ['2026-08-09T08:00:00.001Z', 'identity_link_authentication_time_future']
    ] as const;

    for (const [authenticationTime, expectedCode] of adversarialTimes) {
      const ceremony = confirmLinkProviderCeremony(
        { ...request, state: 'google_ceremony_required', version: 3 },
        {
          evidenceId: `evidence_google_${expectedCode}`,
          claims,
          authenticationTime,
          explicitIntentEvidence,
          now,
          policy: { requireAuthTime: false, maximumAuthAgeSeconds: 600 }
        }
      );
      expect(ceremony.kind).toBe('error');
      if (ceremony.kind === 'error') expect(ceremony.error.code).toBe(expectedCode);
    }
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

  test('finalization requires independently recorded explicit-intent evidence', () => {
    const evidence = completeEvidence().filter((item) => item.kind !== 'explicit_intent');
    const result = finalizeIdentityLink({ ...request, state: 'ready_to_link', version: 5 }, evidence, now);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error.code).toBe('identity_link_evidence_incomplete');
  });

  test('finalization requires exactly one canonical intent after the session and before the provider proof', () => {
    const adversarialEvidence = [
      [...completeEvidence(), { ...explicitIntentEvidence, id: 'evidence_intent_duplicate' }],
      completeEvidence().map((item) => item.kind === 'explicit_intent'
        ? { ...item, id: ' evidence_intent_ada' }
        : item),
      completeEvidence().map((item) => item.kind === 'explicit_intent'
        ? { ...item, observedAt: '2026-08-09T07:59:59.999Z' }
        : item),
      completeEvidence().map((item) => item.kind === 'explicit_intent'
        ? { ...item, observedAt: '2026-08-09T08:00:00.001Z' }
        : item)
    ];

    for (const evidence of adversarialEvidence) {
      const result = finalizeIdentityLink({ ...request, state: 'ready_to_link', version: 5 }, evidence, now);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.error.code).toBe('identity_link_explicit_intent_invalid');
    }
  });

  test('provider ceremony rejects explicit intent from another request', () => {
    const ceremony = confirmLinkProviderCeremony(
      { ...request, state: 'google_ceremony_required', version: 4 },
      {
        evidenceId: 'evidence_google_ada',
        claims,
        explicitIntentEvidence: { ...explicitIntentEvidence, requestId: 'link_grace_google' },
        now,
        policy: { requireAuthTime: false, maximumAuthAgeSeconds: 600 }
      }
    );
    expect(ceremony.kind).toBe('error');
    if (ceremony.kind === 'error') expect(ceremony.error.code).toBe('identity_link_explicit_intent_invalid');
  });

  test('finalization rejects any evidence belonging to another request', () => {
    const evidence = completeEvidence();
    evidence.push({
      id: 'evidence_intent_other_request',
      requestId: 'link_grace_google',
      kind: 'explicit_intent',
      observedAt: now
    });
    const result = finalizeIdentityLink({ ...request, state: 'ready_to_link', version: 4 }, evidence, now);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error.code).toBe('identity_link_evidence_request_mismatch');
  });

  test('finalization requires one provider proof bound to the requested provider and stable identity', () => {
    const providerIndex = completeEvidence().findIndex((item) => item.kind === 'provider_ceremony');
    const adversarialProviderEvidence = [
      { provider: 'github' },
      { issuer: '' },
      { subject: '' }
    ] as const;

    for (const override of adversarialProviderEvidence) {
      const evidence = completeEvidence();
      const providerEvidence = evidence[providerIndex];
      if (!providerEvidence) throw new TypeError('provider evidence fixture missing');
      evidence[providerIndex] = { ...providerEvidence, ...override };
      const result = finalizeIdentityLink({ ...request, state: 'ready_to_link', version: 4 }, evidence, now);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.error.code).toBe('identity_link_provider_evidence_mismatch');
    }
  });

  test('finalization accepts complete evidence bound to one exact request', () => {
    const result = finalizeIdentityLink(
      { ...request, state: 'ready_to_link', version: 5 },
      completeEvidence(),
      now
    );
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.data.nextState).toBe('linked');
  });
});
