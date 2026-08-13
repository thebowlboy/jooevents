import {
  emailDiagnosticSubmissionOutcomeSchema,
  providerSubmissionOutcomeSchema,
  type EmailDiagnosticSubmissionOutcome,
  type ProviderSubmissionOutcome
} from '@jooevents/contracts';
import {
  CLOUDFLARE_EMAIL_EVIDENCE_CODES,
  createCloudflareEmailEvidence,
  type CloudflareEmailEvidenceCode,
  type CloudflareEmailObservation,
  type CloudflareEmailTransportKind,
  type CloudflareWorkersErrorCode
} from './evidence';

export type CloudflareAcceptedDisposition =
  | 'accepted_delivered'
  | 'accepted_permanent_bounce'
  | 'accepted_queued'
  | 'accepted_workers';

export type CloudflareSendTransportObservation =
  | Readonly<{
      kind: 'accepted';
      providerMessageId: string;
      observation: CloudflareAcceptedDisposition;
      requestDispatched: true;
      httpStatus?: number;
    }>
  | Readonly<{
      kind: 'known_rejected';
      retryClass: 'safe_retryable' | 'terminal';
      code: CloudflareEmailEvidenceCode;
      observation: CloudflareEmailObservation;
      requestDispatched: boolean;
      providerCode?: CloudflareWorkersErrorCode;
      httpStatus?: number;
    }>
  | Readonly<{
      kind: 'acceptance_unknown';
      reason: 'timeout' | 'connection_lost' | 'malformed_response';
      observation: CloudflareEmailObservation;
      requestDispatched: boolean;
      providerCode?: CloudflareWorkersErrorCode;
      httpStatus?: number;
    }>;

export interface CloudflareSendTransport<Prepared> {
  readonly kind: CloudflareEmailTransportKind;
  send(prepared: Prepared): Promise<CloudflareSendTransportObservation>;
}

function evidence(
  transport: CloudflareEmailTransportKind,
  digest: string,
  observation: CloudflareSendTransportObservation
) {
  const code = observation.kind === 'accepted'
    ? CLOUDFLARE_EMAIL_EVIDENCE_CODES.accepted
    : observation.kind === 'acceptance_unknown'
      ? CLOUDFLARE_EMAIL_EVIDENCE_CODES.acceptanceUnknown
      : observation.code;
  return createCloudflareEmailEvidence({
    code,
    correlationDigestSha256: digest,
    transport,
    observation: observation.observation,
    requestDispatched: observation.requestDispatched,
    ...('providerCode' in observation && observation.providerCode !== undefined
      ? { providerCode: observation.providerCode }
      : {}),
    ...(observation.httpStatus === undefined ? {} : { httpStatus: observation.httpStatus })
  });
}

export function normalizeOrdinarySendObservation(
  transport: CloudflareEmailTransportKind,
  digest: string,
  observation: CloudflareSendTransportObservation
): ProviderSubmissionOutcome {
  if (observation.kind === 'accepted') {
    return providerSubmissionOutcomeSchema.parse({
      contractVersion: 1,
      kind: 'accepted',
      providerMessageId: observation.providerMessageId,
      evidence: evidence(transport, digest, observation)
    });
  }
  if (observation.kind === 'known_rejected') {
    return providerSubmissionOutcomeSchema.parse({
      contractVersion: 1,
      kind: 'known_rejected',
      retryClass: observation.retryClass,
      code: observation.code,
      evidence: evidence(transport, digest, observation)
    });
  }
  return providerSubmissionOutcomeSchema.parse({
    contractVersion: 1,
    kind: 'acceptance_unknown',
    reason: observation.reason,
    evidence: evidence(transport, digest, observation)
  });
}

export function normalizeDiagnosticSendObservation(
  transport: CloudflareEmailTransportKind,
  digest: string,
  observation: CloudflareSendTransportObservation
): EmailDiagnosticSubmissionOutcome {
  if (observation.kind === 'accepted') {
    return emailDiagnosticSubmissionOutcomeSchema.parse({
      contractVersion: 1,
      kind: 'accepted',
      providerMessageId: observation.providerMessageId,
      evidence: evidence(transport, digest, observation)
    });
  }
  if (observation.kind === 'known_rejected') {
    return emailDiagnosticSubmissionOutcomeSchema.parse({
      contractVersion: 1,
      kind: observation.retryClass === 'safe_retryable'
        ? 'known_rejected_safe_retryable'
        : 'known_rejected_terminal',
      code: observation.code,
      evidence: evidence(transport, digest, observation)
    });
  }
  return emailDiagnosticSubmissionOutcomeSchema.parse({
    contractVersion: 1,
    kind: 'acceptance_unknown',
    reason: observation.reason,
    evidence: evidence(transport, digest, observation)
  });
}

export function unexpectedTransportFailure(): CloudflareSendTransportObservation {
  return Object.freeze({
    kind: 'acceptance_unknown',
    reason: 'connection_lost',
    observation: 'connection_lost',
    requestDispatched: true
  });
}
