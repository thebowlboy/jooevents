import { createHash } from 'node:crypto';
import type {
  PublicMutationContinuationKeyProfile,
  PublicMutationContinuationPolicy,
  PublicMutationContinuationPolicyRegistry,
  RegisteredPublicMutationBootstrapVerifier
} from '@jooevents/application/public-mutation-continuation';
import { intakeIdSchema, type VersionedDefinitionRef } from '@jooevents/contracts';
import { issuePublicInputPolicyEvaluator, type PublicInputPolicyEvaluator } from '@jooevents/intake';
import {
  parseContractVersion,
  parseEventId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId,
  type PublicPolicyRevisionId
} from '@jooevents/kernel';
import { z } from 'zod';
import { INTAKE_PUBLIC_MUTATE_OPERATION, type IntakePublicFormScopeSource } from './module';

/**
 * Public submission activation: the published apply-surface gate.
 *
 * The public Application ceremony (mint / autosave / resume / submit) serves
 * only while a published form-kind ("apply") surface release currently pins
 * the form. Everything here is a producer for that gate: the runtime join
 * composes one gate instance into (a) the public form-read scope source,
 * (b) the continuation policy registry the ceremony boundary re-resolves on
 * every mint/admit/effect, and (c) the public policy revision stamped into
 * `public_open` evidence. Absence, rollback, and re-pinning fail closed.
 * Closing preserves only a detail-free marker on the form-read lane while
 * still sealing every ceremony path.
 */

export const INTAKE_PUBLIC_APPLY_SURFACE_REFUSAL_REASONS = [
  'no_published_apply_surface',
  'apply_form_closed',
  'apply_form_version_superseded'
] as const;

export type IntakePublicApplySurfaceRefusalReason =
  (typeof INTAKE_PUBLIC_APPLY_SURFACE_REFUSAL_REASONS)[number];

const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());

const applySurfacePinSchema = z.strictObject({
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  formId: intakeIdSchema,
  formVersionId: intakeIdSchema,
  surfaceReleaseId: canonicalUuid,
  surfaceHeadVersion: z.number().int().positive(),
  evidenceIds: z.array(z.string().min(1).max(512).refine((value) => value.trim() === value)).max(16)
});

/** The exact serving pin of the currently published apply surface release. */
export interface IntakePublicApplySurfacePin {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly formId: string;
  readonly formVersionId: string;
  readonly surfaceReleaseId: string;
  readonly surfaceHeadVersion: number;
  readonly evidenceIds: readonly string[];
}

export type IntakePublicApplySurfaceResolution =
  | { readonly kind: 'pinned'; readonly pin: IntakePublicApplySurfacePin }
  | { readonly kind: 'closed'; readonly pin: IntakePublicApplySurfacePin }
  | { readonly kind: 'refused'; readonly reason: IntakePublicApplySurfaceRefusalReason };

/**
 * Fail-closed source of the current apply-surface pin. A resolution is a
 * point-in-time fact; callers re-resolve rather than cache, and any thrown
 * error or malformed value is treated as refusal by every consumer here.
 */
export interface IntakePublicApplySurfaceGate {
  resolveApplySurface(): IntakePublicApplySurfaceResolution;
}

function currentSurface(
  gate: IntakePublicApplySurfaceGate
): Extract<IntakePublicApplySurfaceResolution, { readonly kind: 'pinned' | 'closed' }> | undefined {
  let resolution: IntakePublicApplySurfaceResolution;
  try {
    resolution = gate.resolveApplySurface();
  } catch {
    return undefined;
  }
  if (!resolution || (resolution.kind !== 'pinned' && resolution.kind !== 'closed')) {
    return undefined;
  }
  const parsed = applySurfacePinSchema.safeParse(resolution.pin);
  return parsed.success
    ? Object.freeze({ kind: resolution.kind, pin: Object.freeze(parsed.data) })
    : undefined;
}

function currentPin(gate: IntakePublicApplySurfaceGate): IntakePublicApplySurfacePin | undefined {
  const resolution = currentSurface(gate);
  return resolution?.kind === 'pinned' ? resolution.pin : undefined;
}

/**
 * The public policy revision the apply activation serves under: the active
 * apply surface release id. Publishing a successor or rolling the head back
 * changes the revision, which stops open ceremonies (`policy_changed`) and
 * invalidates previously stamped `public_open` evidence.
 */
export function intakePublicApplyPolicyRevision(
  pin: IntakePublicApplySurfacePin
): PublicPolicyRevisionId {
  return parsePublicPolicyRevisionId(pin.surfaceReleaseId);
}

/**
 * Gates `form.public.read` on the published apply surface: the requested form
 * must be the pinned form and the caller's `public_open` evidence must carry
 * the pin's own policy revision. The resolved scope also distinguishes an
 * open pin from its closed marker; anything else resolves to absence.
 */
export function createApplySurfaceGatedPublicFormScopeSource(input: {
  readonly gate: IntakePublicApplySurfaceGate;
}): IntakePublicFormScopeSource {
  return Object.freeze({
    resolve(request: { readonly formId: string; readonly publicPolicyRevisionId: PublicPolicyRevisionId }) {
      const resolution = currentSurface(input.gate);
      const pin = resolution?.pin;
      if (!resolution || !pin || pin.formId !== request.formId
          || intakePublicApplyPolicyRevision(pin) !== request.publicPolicyRevisionId) {
        return undefined;
      }
      return Object.freeze({
        workspaceId: pin.workspaceId,
        eventId: pin.eventId,
        availability: resolution.kind === 'pinned' ? 'open' as const : 'closed' as const,
        evidenceIds: Object.freeze([...new Set([
          ...pin.evidenceIds,
          `apply-surface:${pin.surfaceReleaseId}`,
          `public-policy:${intakePublicApplyPolicyRevision(pin)}`
        ])])
      });
    }
  });
}

/** Ceremony security material fixed at composition time; the pin stays live. */
export interface IntakePublicApplyCeremonySecurity {
  readonly lifetimeMs: number;
  readonly bootstrapVerifier: VersionedDefinitionRef;
  readonly originPolicy: VersionedDefinitionRef;
  readonly csrfPolicy: VersionedDefinitionRef;
  readonly rateLimitPolicy: VersionedDefinitionRef;
  readonly replayPolicy: VersionedDefinitionRef;
  readonly continuationProfiles: readonly [
    PublicMutationContinuationKeyProfile,
    ...PublicMutationContinuationKeyProfile[]
  ];
  readonly principalPartitionProfile: PublicMutationContinuationKeyProfile;
  readonly bootstrapReplayProfile: PublicMutationContinuationKeyProfile;
}

export const INTAKE_PUBLIC_APPLY_CEREMONY_PURPOSE = 'intake.application';
export const INTAKE_PUBLIC_APPLY_CEREMONY_ACTION = 'mutate';

/**
 * A continuation policy registry whose sole entry exists exactly while the
 * apply surface is published. The ceremony boundary re-resolves this on every
 * mint, admit, and in-transaction effect recheck, so an absent or rolled-back
 * surface release stops minting (`unavailable`), admission (`policy_changed`),
 * and writing (authority revoked / completion `policy_changed`) without any
 * further wiring.
 */
export function createApplySurfaceGatedContinuationPolicySource(input: {
  readonly gate: IntakePublicApplySurfaceGate;
  readonly binding: VersionedDefinitionRef;
  readonly security: IntakePublicApplyCeremonySecurity;
}): PublicMutationContinuationPolicyRegistry {
  const binding = Object.freeze({
    key: input.binding.key,
    version: parseContractVersion(input.binding.version)
  });
  return Object.freeze({
    resolve(requested: VersionedDefinitionRef): PublicMutationContinuationPolicy | undefined {
      if (!requested || requested.key !== binding.key || requested.version !== binding.version) {
        return undefined;
      }
      const pin = currentPin(input.gate);
      if (!pin) return undefined;
      return Object.freeze({
        binding,
        publicPolicyRevisionId: intakePublicApplyPolicyRevision(pin),
        operation: Object.freeze({
          name: INTAKE_PUBLIC_MUTATE_OPERATION.name,
          version: parseContractVersion(INTAKE_PUBLIC_MUTATE_OPERATION.version)
        }),
        scope: Object.freeze({
          kind: 'event' as const,
          workspaceId: parseWorkspaceId(pin.workspaceId),
          eventId: parseEventId(pin.eventId)
        }),
        purpose: INTAKE_PUBLIC_APPLY_CEREMONY_PURPOSE,
        action: INTAKE_PUBLIC_APPLY_CEREMONY_ACTION,
        resourceBindings: Object.freeze([
          Object.freeze({ kind: 'intake_form', id: pin.formId }),
          Object.freeze({ kind: 'intake_form_version', id: pin.formVersionId })
        ]),
        lifetimeMs: input.security.lifetimeMs,
        bootstrapVerifier: input.security.bootstrapVerifier,
        originPolicy: input.security.originPolicy,
        csrfPolicy: input.security.csrfPolicy,
        rateLimitPolicy: input.security.rateLimitPolicy,
        replayPolicy: input.security.replayPolicy,
        continuationProfiles: input.security.continuationProfiles,
        principalPartitionProfile: input.security.principalPartitionProfile,
        bootstrapReplayProfile: input.security.bootstrapReplayProfile
      });
    }
  });
}

/**
 * Abuse seam, recorded off-unless-configured posture: challenge providers
 * (Turnstile) and rate policy remain pluggable configuration, never a
 * requirement. This default verifier enforces only the structural protocol —
 * a well-formed client bootstrap secret, and the origin allowlist when one is
 * configured — while still supplying real principal-partition and mint-replay
 * material so continuation security keeps its full strength.
 */
export const INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES = Object.freeze({
  bootstrapVerifier: Object.freeze({
    key: 'intake.public-bootstrap.unconfigured', version: parseContractVersion(1)
  }),
  originPolicy: Object.freeze({
    key: 'intake.public-origin.unconfigured', version: parseContractVersion(1)
  }),
  csrfPolicy: Object.freeze({
    key: 'intake.public-csrf.unconfigured', version: parseContractVersion(1)
  }),
  rateLimitPolicy: Object.freeze({
    key: 'intake.public-rate.unconfigured', version: parseContractVersion(1)
  }),
  replayPolicy: Object.freeze({
    key: 'intake.public-replay.unconfigured', version: parseContractVersion(1)
  })
});

export const intakePublicBootstrapProtocolEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Client-held mint secret; equal secrets replay to the same ceremony. */
  bootstrap: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  /** The transport `Origin` header as received; null when absent. */
  origin: z.string().min(1).max(512).nullable()
});

export type IntakePublicBootstrapProtocolEvidence =
  z.infer<typeof intakePublicBootstrapProtocolEvidenceSchema>;

export function createOffUnlessConfiguredPublicIntakeBootstrapVerifier(options: {
  readonly reference?: VersionedDefinitionRef;
  /** Exact allowed `Origin` values; absent or empty leaves the check off. */
  readonly allowedOrigins?: readonly string[];
} = {}): RegisteredPublicMutationBootstrapVerifier {
  const reference = options.reference
    ?? INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES.bootstrapVerifier;
  const allowedOrigins = (options.allowedOrigins ?? []).map((origin) => {
    if (typeof origin !== 'string' || origin.length === 0 || origin.length > 512
        || origin.trim() !== origin) {
      throw new TypeError('intake_public_bootstrap_origin_allowlist_invalid');
    }
    return origin;
  });
  const configuredOrigins = allowedOrigins.length > 0 ? new Set(allowedOrigins) : undefined;
  return Object.freeze({
    reference: Object.freeze({
      key: reference.key,
      version: parseContractVersion(reference.version)
    }),
    verify(input: Parameters<RegisteredPublicMutationBootstrapVerifier['verify']>[0]) {
      const parsed = intakePublicBootstrapProtocolEvidenceSchema.safeParse(input.protocolEvidence);
      if (!parsed.success) {
        return Object.freeze({ kind: 'rejected' as const, reason: 'csrf_rejected' as const });
      }
      if (configuredOrigins
          && (parsed.data.origin === null || !configuredOrigins.has(parsed.data.origin))) {
        return Object.freeze({ kind: 'rejected' as const, reason: 'origin_rejected' as const });
      }
      const digest = createHash('sha256')
        .update('jooevents.intake.public-bootstrap.v1\0', 'utf8')
        .update(parsed.data.bootstrap, 'utf8')
        .digest('hex')
        .slice(0, 40);
      return Object.freeze({
        kind: 'verified' as const,
        principalPartitionMaterial: new TextEncoder().encode(`bootstrap:${parsed.data.bootstrap}`),
        bootstrapReplayMaterial: new TextEncoder().encode(parsed.data.bootstrap),
        originEvidenceId: `poe_uncfg_${digest}`,
        csrfEvidenceId: `pce_uncfg_${digest}`,
        rateLimitEvidenceId: `pre_uncfg_${digest}`,
        replayEvidenceId: `ppe_uncfg_${digest}`
      });
    }
  });
}

export const INTAKE_PUBLIC_APPLY_UNCONFIGURED_INPUT_POLICY = Object.freeze({
  key: 'intake.public-input.unconfigured', version: 1
});

/**
 * Effect-time abuse decision at the recorded default: every begin/save/submit
 * is allowed, and each decision is still evaluated, sealed, and persisted as
 * immutable input-policy evidence under the explicit "unconfigured" policy
 * identity so a later configured policy is a visible revision, not a rewrite.
 */
export function createOffUnlessConfiguredPublicInputPolicyEvaluator(input: {
  readonly issueEvaluationId: () => string;
}): PublicInputPolicyEvaluator {
  return issuePublicInputPolicyEvaluator({
    policy: INTAKE_PUBLIC_APPLY_UNCONFIGURED_INPUT_POLICY,
    issueEvaluationId: input.issueEvaluationId,
    decide: () => ({ disposition: 'allow', reasonCode: null, remedyCode: null })
  });
}
