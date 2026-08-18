import {
  providerReadinessAdapterObservationSchema,
  providerReadinessInputSchema,
  type EmailSetupManifest,
  type ProviderReadinessAdapterObservation,
  type ProviderReadinessInput
} from '@jooevents/contracts';
import type { EmailSetupAdapter } from '@jooevents/communications';
import { CLOUDFLARE_EMAIL_READINESS_EXTERNAL_CHECK_KEY } from './constants';
import {
  CLOUDFLARE_EMAIL_EVIDENCE_CODES,
  createCloudflareEmailEvidence,
  type CloudflareEmailObservation,
  type CloudflareEmailTransportKind
} from './evidence';

export type CloudflareEmailReadinessProbeObservation =
  | Readonly<{
      kind: 'passed';
      readiness: 'ready' | 'degraded';
      validUntil: number;
    }>
  | Readonly<{
      kind: 'known_failed';
      reason:
        | 'authentication_failed'
        | 'authorization_failed'
        | 'domain_not_enabled'
        | 'transport_unavailable';
    }>
  | Readonly<{
      kind: 'acceptance_unknown';
      reason: 'timeout' | 'connection_lost' | 'malformed_response';
    }>;

export interface CloudflareEmailReadinessProbe {
  check(input: Readonly<{
    contractVersion: 1;
    transport: CloudflareEmailTransportKind;
    request: ProviderReadinessInput;
  }>): Promise<CloudflareEmailReadinessProbeObservation>;
}

function timeoutLike(error: unknown): boolean {
  try {
    return typeof error === 'object'
      && error !== null
      && 'name' in error
      && (error.name === 'AbortError' || error.name === 'TimeoutError');
  } catch {
    return false;
  }
}

function readinessEvidence(input: Readonly<{
  code: Parameters<typeof createCloudflareEmailEvidence>[0]['code'];
  request: ProviderReadinessInput;
  transport: CloudflareEmailTransportKind;
  observation: CloudflareEmailObservation;
  requestDispatched: boolean;
}>) {
  return createCloudflareEmailEvidence({
    code: input.code,
    correlationDigestSha256: input.request.requestDigestSha256,
    transport: input.transport,
    observation: input.observation,
    requestDispatched: input.requestDispatched
  });
}

function malformed(
  request: ProviderReadinessInput,
  transport: CloudflareEmailTransportKind
): ProviderReadinessAdapterObservation {
  return providerReadinessAdapterObservationSchema.parse({
    contractVersion: 1,
    kind: 'acceptance_unknown',
    reason: 'malformed_response',
    evidence: readinessEvidence({
      code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessAcceptanceUnknown,
      request,
      transport,
      observation: 'malformed_response',
      requestDispatched: true
    })
  });
}

export function createCloudflareEmailSetupAdapter(input: Readonly<{
  adapterKey: string;
  adapterVersion: string;
  manifest: EmailSetupManifest;
  transport: CloudflareEmailTransportKind;
  readinessProbe?: CloudflareEmailReadinessProbe;
}>): EmailSetupAdapter {
  return Object.freeze({
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    manifest: input.manifest,
    async checkReadiness(raw: ProviderReadinessInput) {
      const request = providerReadinessInputSchema.parse(raw);
      if (
        request.adapterKey !== input.adapterKey
        || request.adapterVersion !== input.adapterVersion
        || request.manifestKey !== input.manifest.manifestKey
        || request.manifestVersion !== input.manifest.manifestVersion
        || request.manifestDigestSha256 !== input.manifest.manifestDigestSha256
      ) {
        throw new TypeError('Cloudflare readiness input does not cite the exact adapter manifest');
      }

      if (request.capability === 'inbound_replies') {
        const code = CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessInboundNotEnabled;
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'known_failed',
          code,
          evidence: readinessEvidence({
            code,
            request,
            transport: input.transport,
            observation: 'inbound_not_enabled',
            requestDispatched: false
          })
        });
      }

      const contentCapability = request.capability === 'attachments'
        || request.capability === 'calendar_mime';
      const contentSupported = contentCapability
        && input.manifest.capabilityStatus[request.capability] === 'supported';
      if (request.capability !== 'transactional_outbound' && !contentSupported) {
        const code = CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessNotSupported;
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'known_failed',
          code,
          evidence: readinessEvidence({
            code,
            request,
            transport: input.transport,
            observation: 'capability_not_supported',
            requestDispatched: false
          })
        });
      }

      if (request.externalCheckKey !== CLOUDFLARE_EMAIL_READINESS_EXTERNAL_CHECK_KEY) {
        throw new TypeError('Cloudflare readiness input cites an unknown external check');
      }

      if (input.readinessProbe === undefined) {
        const code = CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessNotVerified;
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'known_failed',
          code,
          evidence: readinessEvidence({
            code,
            request,
            transport: input.transport,
            observation: 'readiness_not_verified',
            requestDispatched: false
          })
        });
      }

      let observation: CloudflareEmailReadinessProbeObservation;
      try {
        observation = await input.readinessProbe.check(Object.freeze({
          contractVersion: 1,
          transport: input.transport,
          request
        }));
      } catch (error) {
        const reason = timeoutLike(error) ? 'timeout' : 'connection_lost';
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'acceptance_unknown',
          reason,
          evidence: readinessEvidence({
            code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessAcceptanceUnknown,
            request,
            transport: input.transport,
            observation: reason,
            requestDispatched: true
          })
        });
      }

      if (observation.kind === 'passed') {
        if (
          (observation.readiness !== 'ready' && observation.readiness !== 'degraded')
          || !Number.isSafeInteger(observation.validUntil)
          || observation.validUntil < 0
        ) return malformed(request, input.transport);
        const readiness = observation.readiness;
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'passed',
          readiness,
          validUntil: Math.min(observation.validUntil, request.requestedValidUntil),
          evidence: readinessEvidence({
            code: readiness === 'ready'
              ? CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessReady
              : CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessDegraded,
            request,
            transport: input.transport,
            observation: readiness === 'ready' ? 'readiness_ready' : 'readiness_degraded',
            requestDispatched: true
          })
        });
      }

      if (observation.kind === 'known_failed') {
        const observations = {
          authentication_failed: 'authentication_failed',
          authorization_failed: 'authorization_failed',
          domain_not_enabled: 'domain_not_enabled',
          transport_unavailable: 'transport_unavailable'
        } as const;
        const normalized = observations[observation.reason];
        if (normalized === undefined) return malformed(request, input.transport);
        const code = CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessKnownFailed;
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'known_failed',
          code,
          evidence: readinessEvidence({
            code,
            request,
            transport: input.transport,
            observation: normalized,
            requestDispatched: true
          })
        });
      }

      if (observation.kind === 'acceptance_unknown') {
        if (!['timeout', 'connection_lost', 'malformed_response'].includes(observation.reason)) {
          return malformed(request, input.transport);
        }
        return providerReadinessAdapterObservationSchema.parse({
          contractVersion: 1,
          kind: 'acceptance_unknown',
          reason: observation.reason,
          evidence: readinessEvidence({
            code: CLOUDFLARE_EMAIL_EVIDENCE_CODES.readinessAcceptanceUnknown,
            request,
            transport: input.transport,
            observation: observation.reason,
            requestDispatched: true
          })
        });
      }

      return malformed(request, input.transport);
    }
  });
}
