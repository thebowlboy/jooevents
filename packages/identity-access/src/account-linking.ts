import type {
  ExternalIdentityClaims,
  IdentityLinkRequestId,
  ISODateTime,
  UserId
} from './identity';
import type { AdapterOutcome } from './outcomes';
import { failure, success } from './outcomes';

export type IdentityLinkRequestState =
  | 'email_confirmation_pending'
  | 'existing_session_required'
  | 'google_ceremony_required'
  | 'ready_to_link'
  | 'linked'
  | 'expired'
  | 'cancelled'
  | 'failed';

export type IdentityLinkEvidenceKind =
  | 'mailbox_confirmation'
  | 'incumbent_session'
  | 'explicit_intent'
  | 'provider_ceremony';

export interface IdentityLinkRequest {
  readonly id: IdentityLinkRequestId;
  readonly targetUserId: UserId;
  readonly provider: string;
  readonly normalizedTargetEmail: string;
  readonly state: IdentityLinkRequestState;
  /** Only a one-way digest is persisted. The raw token belongs in sensitive outbox data. */
  readonly tokenHash: string;
  readonly expiresAt: ISODateTime;
  readonly attempts: number;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface IdentityLinkEvidence {
  readonly id: string;
  readonly requestId: IdentityLinkRequestId;
  readonly kind: IdentityLinkEvidenceKind;
  readonly provider?: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly authenticatedAt?: ISODateTime;
  readonly observedAt: ISODateTime;
  readonly redactedMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export type IdentityLinkExplicitIntentEvidence = Pick<
  IdentityLinkEvidence,
  'id' | 'requestId' | 'observedAt'
> & {
  readonly kind: 'explicit_intent';
};

export interface IdentityLinkTransition {
  readonly requestId: IdentityLinkRequestId;
  readonly expectedVersion: number;
  readonly nextState: IdentityLinkRequestState;
  readonly evidence?: Omit<IdentityLinkEvidence, 'requestId'>;
}

function isTerminal(state: IdentityLinkRequestState): boolean {
  return state === 'linked' || state === 'expired' || state === 'cancelled' || state === 'failed';
}

function expired(request: IdentityLinkRequest, now: ISODateTime): boolean {
  return Date.parse(request.expiresAt) <= Date.parse(now);
}

function transition(
  request: IdentityLinkRequest,
  expected: IdentityLinkRequestState,
  nextState: IdentityLinkRequestState,
  evidence: Omit<IdentityLinkEvidence, 'requestId'> | undefined,
  now: ISODateTime
): AdapterOutcome<IdentityLinkTransition> {
  if (expired(request, now)) {
    return failure({ code: 'identity_link_expired', message: 'The account-link request has expired.', retryable: false });
  }
  if (isTerminal(request.state)) {
    return failure({ code: `identity_link_${request.state}`, message: 'The account-link request is no longer active.', retryable: false });
  }
  if (request.state !== expected) {
    return failure({
      code: 'identity_link_state_mismatch',
      message: 'The required account-link proof has not been completed.',
      retryable: false,
      details: { currentState: request.state }
    });
  }
  return success({ requestId: request.id, expectedVersion: request.version, nextState, ...(evidence ? { evidence } : {}) });
}

export function confirmLinkMailbox(
  request: IdentityLinkRequest,
  input: { readonly evidenceId: string; readonly observedAt: ISODateTime }
): AdapterOutcome<IdentityLinkTransition> {
  return transition(
    request,
    'email_confirmation_pending',
    'existing_session_required',
    { id: input.evidenceId, kind: 'mailbox_confirmation', observedAt: input.observedAt },
    input.observedAt
  );
}

export function confirmLinkIncumbentSession(
  request: IdentityLinkRequest,
  input: { readonly evidenceId: string; readonly authenticatedUserId: UserId; readonly authenticatedAt: ISODateTime; readonly observedAt: ISODateTime }
): AdapterOutcome<IdentityLinkTransition> {
  if (input.authenticatedUserId !== request.targetUserId) {
    return failure({ code: 'identity_link_wrong_user', message: 'The active session does not belong to the requested account.', retryable: false });
  }
  return transition(
    request,
    'existing_session_required',
    'google_ceremony_required',
    { id: input.evidenceId, kind: 'incumbent_session', authenticatedAt: input.authenticatedAt, observedAt: input.observedAt },
    input.observedAt
  );
}

export interface ProviderCeremonyPolicy {
  readonly requireAuthTime: boolean;
  readonly maximumAuthAgeSeconds: number;
}

function parseCanonicalInstant(value: ISODateTime): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return undefined;
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const instant = Date.parse(canonical);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== canonical) return undefined;
  return instant;
}

function explicitIntentEvidenceIsValid(
  request: IdentityLinkRequest,
  evidence: IdentityLinkEvidence,
  notBefore: ISODateTime,
  notAfter: ISODateTime
): boolean {
  if (
    evidence.requestId !== request.id ||
    evidence.kind !== 'explicit_intent' ||
    evidence.id.trim().length === 0 ||
    evidence.id !== evidence.id.trim() ||
    evidence.provider !== undefined ||
    evidence.issuer !== undefined ||
    evidence.subject !== undefined ||
    evidence.authenticatedAt !== undefined
  ) {
    return false;
  }

  const observedAt = parseCanonicalInstant(evidence.observedAt);
  const lowerBound = parseCanonicalInstant(notBefore);
  const upperBound = parseCanonicalInstant(notAfter);
  return observedAt !== undefined &&
    lowerBound !== undefined &&
    upperBound !== undefined &&
    observedAt >= lowerBound &&
    observedAt <= upperBound;
}

export function recordLinkExplicitIntent(
  request: IdentityLinkRequest,
  input: { readonly evidenceId: string; readonly observedAt: ISODateTime }
): AdapterOutcome<IdentityLinkTransition> {
  const evidence: IdentityLinkExplicitIntentEvidence = {
    id: input.evidenceId,
    requestId: request.id,
    kind: 'explicit_intent',
    observedAt: input.observedAt
  };
  if (!explicitIntentEvidenceIsValid(request, evidence, request.updatedAt, request.expiresAt)) {
    return failure({
      code: 'identity_link_explicit_intent_invalid',
      message: 'The explicit account-link intent is not valid for this request.',
      retryable: false
    });
  }
  return transition(
    request,
    'google_ceremony_required',
    'google_ceremony_required',
    { id: evidence.id, kind: evidence.kind, observedAt: evidence.observedAt },
    evidence.observedAt
  );
}

export function confirmLinkProviderCeremony(
  request: IdentityLinkRequest,
  input: {
    readonly evidenceId: string;
    readonly claims: ExternalIdentityClaims;
    readonly authenticationTime?: ISODateTime;
    readonly explicitIntentEvidence: IdentityLinkExplicitIntentEvidence;
    readonly now: ISODateTime;
    readonly policy: ProviderCeremonyPolicy;
  }
): AdapterOutcome<IdentityLinkTransition> {
  if (!explicitIntentEvidenceIsValid(request, input.explicitIntentEvidence, request.createdAt, input.now)) {
    return failure({
      code: 'identity_link_explicit_intent_invalid',
      message: 'The explicit account-link intent is not valid for this request.',
      retryable: false
    });
  }
  if (
    input.claims.provider !== request.provider ||
    input.claims.issuer.trim().length === 0 ||
    input.claims.subject.trim().length === 0 ||
    !input.claims.emailVerified ||
    input.claims.email === undefined ||
    input.claims.email.trim().normalize('NFKC').toLocaleLowerCase('en-US') !== request.normalizedTargetEmail
  ) {
    return failure({ code: 'identity_link_provider_mismatch', message: 'The verified provider account does not match this request.', retryable: false });
  }

  const authTime = input.authenticationTime;
  if (authTime === undefined && input.policy.requireAuthTime) {
    return failure({ code: 'identity_link_auth_time_missing', message: 'The provider did not supply the required authentication time.', retryable: true });
  }
  if (authTime !== undefined) {
    const now = parseCanonicalInstant(input.now);
    const authenticatedAt = parseCanonicalInstant(authTime);
    if (now === undefined || authenticatedAt === undefined) {
      return failure({ code: 'identity_link_authentication_time_invalid', message: 'The provider authentication time is invalid.', retryable: true });
    }
    if (authenticatedAt > now) {
      return failure({ code: 'identity_link_authentication_time_future', message: 'The provider authentication time is in the future.', retryable: true });
    }
    if ((now - authenticatedAt) / 1000 > input.policy.maximumAuthAgeSeconds) {
      return failure({ code: 'identity_link_authentication_stale', message: 'The provider authentication is too old.', retryable: true });
    }
  }

  const notices = authTime !== undefined
    ? []
    : [{ code: 'identity_link_auth_time_missing', severity: 'warning' as const, message: 'The provider omitted authentication time; the configured policy accepted the other fresh proofs.' }];
  const result = transition(
    request,
    'google_ceremony_required',
    'ready_to_link',
    {
      id: input.evidenceId,
      kind: 'provider_ceremony',
      provider: input.claims.provider,
      issuer: input.claims.issuer,
      subject: input.claims.subject,
      ...(authTime !== undefined ? { authenticatedAt: authTime } : {}),
      observedAt: input.now
    },
    input.now
  );
  return result.kind === 'success' ? { ...result, notices } : result;
}

export function finalizeIdentityLink(
  request: IdentityLinkRequest,
  evidence: readonly IdentityLinkEvidence[],
  now: ISODateTime
): AdapterOutcome<IdentityLinkTransition> {
  if (evidence.some((item) => item.requestId !== request.id)) {
    return failure({ code: 'identity_link_evidence_request_mismatch', message: 'The identity proofs do not belong to this account-link request.', retryable: false });
  }
  const kinds = new Set(evidence.map((item) => item.kind));
  if (!kinds.has('mailbox_confirmation') || !kinds.has('incumbent_session') || !kinds.has('explicit_intent') || !kinds.has('provider_ceremony')) {
    return failure({ code: 'identity_link_evidence_incomplete', message: 'All required identity proofs must be recorded before linking.', retryable: false });
  }
  const explicitIntentEvidence = evidence.filter((item) => item.kind === 'explicit_intent');
  const incumbentSessionEvidence = evidence.filter((item) => item.kind === 'incumbent_session');
  const providerEvidence = evidence.filter((item) => item.kind === 'provider_ceremony');
  if (
    providerEvidence.length !== 1 ||
    providerEvidence[0]?.provider !== request.provider ||
    !providerEvidence[0]?.issuer?.trim() ||
    !providerEvidence[0]?.subject?.trim()
  ) {
    return failure({ code: 'identity_link_provider_evidence_mismatch', message: 'The provider proof is not bound to this account-link request.', retryable: false });
  }
  if (
    explicitIntentEvidence.length !== 1 ||
    incumbentSessionEvidence.length !== 1 ||
    !explicitIntentEvidenceIsValid(
      request,
      explicitIntentEvidence[0]!,
      incumbentSessionEvidence[0]!.observedAt,
      providerEvidence[0]!.observedAt
    ) ||
    !explicitIntentEvidenceIsValid(
      request,
      explicitIntentEvidence[0]!,
      request.createdAt,
      now
    )
  ) {
    return failure({ code: 'identity_link_explicit_intent_invalid', message: 'The explicit account-link intent is not valid for this request.', retryable: false });
  }
  return transition(request, 'ready_to_link', 'linked', undefined, now);
}
