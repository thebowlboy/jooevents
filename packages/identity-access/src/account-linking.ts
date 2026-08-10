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

export function confirmLinkProviderCeremony(
  request: IdentityLinkRequest,
  input: {
    readonly evidenceId: string;
    readonly claims: ExternalIdentityClaims;
    readonly authenticationTime?: ISODateTime;
    readonly explicitIntentObservedAt: ISODateTime;
    readonly now: ISODateTime;
    readonly policy: ProviderCeremonyPolicy;
  }
): AdapterOutcome<IdentityLinkTransition> {
  if (
    input.claims.provider !== request.provider ||
    !input.claims.emailVerified ||
    input.claims.email === undefined ||
    input.claims.email.trim().normalize('NFKC').toLocaleLowerCase('en-US') !== request.normalizedTargetEmail
  ) {
    return failure({ code: 'identity_link_provider_mismatch', message: 'The verified provider account does not match this request.', retryable: false });
  }

  const authTime = input.authenticationTime;
  if (!authTime && input.policy.requireAuthTime) {
    return failure({ code: 'identity_link_auth_time_missing', message: 'The provider did not supply the required authentication time.', retryable: true });
  }
  if (authTime && (Date.parse(input.now) - Date.parse(authTime)) / 1000 > input.policy.maximumAuthAgeSeconds) {
    return failure({ code: 'identity_link_authentication_stale', message: 'The provider authentication is too old.', retryable: true });
  }

  const notices = authTime
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
      ...(authTime ? { authenticatedAt: authTime } : {}),
      observedAt: input.now,
      redactedMetadata: { explicitIntentObservedAt: input.explicitIntentObservedAt }
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
  const kinds = new Set(evidence.map((item) => item.kind));
  if (!kinds.has('mailbox_confirmation') || !kinds.has('incumbent_session') || !kinds.has('provider_ceremony')) {
    return failure({ code: 'identity_link_evidence_incomplete', message: 'All required identity proofs must be recorded before linking.', retryable: false });
  }
  return transition(request, 'ready_to_link', 'linked', undefined, now);
}
