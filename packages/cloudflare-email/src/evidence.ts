import type { RegisteredSafeEvidenceFact, SafeEvidence } from '@jooevents/contracts';
import {
  createSafeEvidence,
  createSafeEvidenceCatalog,
  type SafeEvidenceCatalog
} from '@jooevents/communications';

export type CloudflareEmailTransportKind = 'bun_rest' | 'graphql_analytics' | 'workers_binding';

export const CLOUDFLARE_EMAIL_EVIDENCE_CODES = Object.freeze({
  accepted: 'cloudflare.email.accepted',
  acceptanceUnknown: 'cloudflare.email.acceptance_unknown',
  authentication: 'cloudflare.email.rejected.authentication',
  authorization: 'cloudflare.email.rejected.authorization',
  dailyLimit: 'cloudflare.email.rejected.daily_limit',
  deliveryFailed: 'cloudflare.email.rejected.delivery_failed',
  invalidRequest: 'cloudflare.email.rejected.invalid_request',
  notFound: 'cloudflare.email.rejected.not_found',
  rateLimited: 'cloudflare.email.rejected.rate_limited',
  recipientNotAllowed: 'cloudflare.email.rejected.recipient_not_allowed',
  recipientSuppressed: 'cloudflare.email.rejected.recipient_suppressed',
  secretUnavailable: 'cloudflare.email.secret_unavailable',
  senderNotReady: 'cloudflare.email.rejected.sender_not_ready',
  readinessAcceptanceUnknown: 'cloudflare.email.readiness.acceptance_unknown',
  readinessDegraded: 'cloudflare.email.readiness.degraded',
  readinessInboundNotEnabled: 'cloudflare.email.readiness.inbound_not_enabled',
  readinessKnownFailed: 'cloudflare.email.readiness.known_failed',
  readinessNotSupported: 'cloudflare.email.readiness.not_supported',
  readinessNotVerified: 'cloudflare.email.readiness.not_verified',
  readinessReady: 'cloudflare.email.readiness.ready'
} as const);

export type CloudflareEmailEvidenceCode =
  typeof CLOUDFLARE_EMAIL_EVIDENCE_CODES[keyof typeof CLOUDFLARE_EMAIL_EVIDENCE_CODES];

export const CLOUDFLARE_WORKERS_ERROR_CODES = Object.freeze([
  'E_CONTENT_TOO_LARGE',
  'E_DAILY_LIMIT_EXCEEDED',
  'E_DELIVERY_FAILED',
  'E_FIELD_MISSING',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
  'E_HEADER_NAME_INVALID',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_INTERNAL_SERVER_ERROR',
  'E_RATE_LIMIT_EXCEEDED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_SENDER_NOT_VERIFIED',
  'E_TOO_MANY_ATTACHMENTS',
  'E_TOO_MANY_RECIPIENTS',
  'E_VALIDATION_ERROR'
] as const);

export type CloudflareWorkersErrorCode = typeof CLOUDFLARE_WORKERS_ERROR_CODES[number];

export const CLOUDFLARE_EMAIL_OBSERVATIONS = Object.freeze([
  'accepted_delivered',
  'accepted_no_disposition',
  'accepted_permanent_bounce',
  'accepted_queued',
  'accepted_workers',
  'authentication_failed',
  'authorization_failed',
  'capability_not_supported',
  'connection_lost',
  'daily_limit_exceeded',
  'delivery_failed',
  'delivery_confirmed',
  'domain_not_enabled',
  'inbound_not_enabled',
  'invalid_request',
  'malformed_response',
  'not_found',
  'rate_limited',
  'readiness_degraded',
  'readiness_not_verified',
  'readiness_ready',
  'recipient_not_allowed',
  'recipient_suppressed',
  'secret_unavailable',
  'sender_not_ready',
  'timeout',
  'transport_unavailable'
] as const);

export type CloudflareEmailObservation = typeof CLOUDFLARE_EMAIL_OBSERVATIONS[number];

const ALL_FACT_KEYS = [
  'cloudflare.http_status',
  'cloudflare.observation',
  'cloudflare.provider_code',
  'cloudflare.request_dispatched',
  'cloudflare.transport'
] as const;

export const CLOUDFLARE_EMAIL_SAFE_EVIDENCE_CATALOG: SafeEvidenceCatalog =
  createSafeEvidenceCatalog({
    facts: [
      {
        key: 'cloudflare.http_status',
        schemaVersion: 1,
        valueKind: 'integer',
        minimum: 100,
        maximum: 599
      },
      {
        key: 'cloudflare.observation',
        schemaVersion: 1,
        valueKind: 'enum',
        allowedValues: CLOUDFLARE_EMAIL_OBSERVATIONS
      },
      {
        key: 'cloudflare.provider_code',
        schemaVersion: 1,
        valueKind: 'enum',
        allowedValues: CLOUDFLARE_WORKERS_ERROR_CODES.map((value) => value.toLowerCase())
      },
      {
        key: 'cloudflare.request_dispatched',
        schemaVersion: 1,
        valueKind: 'boolean'
      },
      {
        key: 'cloudflare.transport',
        schemaVersion: 1,
        valueKind: 'enum',
        allowedValues: ['bun_rest', 'graphql_analytics', 'workers_binding']
      }
    ],
    codes: Object.values(CLOUDFLARE_EMAIL_EVIDENCE_CODES).map((code) => ({
      code,
      allowedFactKeys: ALL_FACT_KEYS
    }))
  });

function enumFact(key: string, value: string): RegisteredSafeEvidenceFact {
  return {
    factKey: key as RegisteredSafeEvidenceFact['factKey'],
    factSchemaVersion: 1,
    valueKind: 'enum',
    enumValue: value as Extract<
      RegisteredSafeEvidenceFact,
      { valueKind: 'enum' }
    >['enumValue']
  };
}

function booleanFact(key: string, value: boolean): RegisteredSafeEvidenceFact {
  return {
    factKey: key as RegisteredSafeEvidenceFact['factKey'],
    factSchemaVersion: 1,
    valueKind: 'boolean',
    booleanValue: value
  };
}

function integerFact(key: string, value: number): RegisteredSafeEvidenceFact {
  return {
    factKey: key as RegisteredSafeEvidenceFact['factKey'],
    factSchemaVersion: 1,
    valueKind: 'integer',
    integerValue: value
  };
}

export type CloudflareEvidenceInput = Readonly<{
  code: CloudflareEmailEvidenceCode;
  correlationDigestSha256: string;
  transport: CloudflareEmailTransportKind;
  observation: CloudflareEmailObservation;
  requestDispatched: boolean;
  providerCode?: CloudflareWorkersErrorCode;
  httpStatus?: number;
}>;

export function createCloudflareEmailEvidence(input: CloudflareEvidenceInput): SafeEvidence {
  const facts: RegisteredSafeEvidenceFact[] = [
    enumFact('cloudflare.observation', input.observation),
    booleanFact('cloudflare.request_dispatched', input.requestDispatched),
    enumFact('cloudflare.transport', input.transport)
  ];
  if (input.providerCode !== undefined) {
    facts.push(enumFact('cloudflare.provider_code', input.providerCode.toLowerCase()));
  }
  if (input.httpStatus !== undefined) {
    facts.push(integerFact('cloudflare.http_status', input.httpStatus));
  }
  return createSafeEvidence(CLOUDFLARE_EMAIL_SAFE_EVIDENCE_CATALOG, {
    code: input.code,
    correlationId: `corr1_${input.correlationDigestSha256.slice(0, 24)}`,
    facts
  });
}
