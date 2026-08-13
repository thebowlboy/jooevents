import {
  providerOpaqueIdSchema,
  providerSha256Schema,
  providerStableKeySchema,
  safeEvidenceSchema,
  verifiedProviderCallbackSchema,
  type ProviderOutcomeV1,
  type SafeEvidence
} from '@jooevents/contracts';
import {
  type CallbackVerificationResolution,
  type CallbackVerifierCandidate,
  type CallbackVerifierCandidateSet,
  type EmailCallbackVerifier,
  type EmailCallbackVerifierRegistry,
  type RawProviderCallback,
  validateRawProviderCallback
} from './port';

export type CallbackRegistryEvidenceCode =
  | 'callback.no_candidate'
  | 'callback.verifier_unavailable'
  | 'callback.none_verified'
  | 'callback.multiple_verified';

export type CallbackRegistryEvidenceFactory = (
  code: CallbackRegistryEvidenceCode,
  correlationId: string
) => SafeEvidence;

function implementationKey(value: {
  readonly verifierKey: string;
  readonly verifierVersion: string;
  readonly verificationContractVersion: number;
}): string {
  return `${value.verifierKey}\u0000${value.verifierVersion}\u0000${value.verificationContractVersion}`;
}

function eligibleCandidates<Context>(
  set: CallbackVerifierCandidateSet<Context>
): readonly CallbackVerifierCandidate<Context>[] {
  if (set.pointerState === 'disabled') return Object.freeze([]);
  const connectionCeiling = set.connectionLifecycleVerificationUntil;
  if (connectionCeiling !== undefined && set.resolvedAtDatabaseTime >= connectionCeiling) {
    return Object.freeze([]);
  }
  const candidates: CallbackVerifierCandidate<Context>[] = [];
  if (set.pointerState === 'active') {
    candidates.push(set.current);
    if (
      set.previous !== undefined
      && set.resolvedAtDatabaseTime < set.previous.eligibilityCeiling
    ) candidates.push(set.previous);
  } else {
    if (
      set.current !== undefined
      && set.resolvedAtDatabaseTime < set.currentVerificationUntil
    ) candidates.push(set.current);
    if (
      set.previous !== undefined
      && set.resolvedAtDatabaseTime < set.previous.eligibilityCeiling
    ) candidates.push(set.previous);
  }
  return Object.freeze(candidates.sort((left, right) => {
    const leftKey = `${implementationKey(left)}\u0000${left.callbackVerifierRevisionId}`;
    const rightKey = `${implementationKey(right)}\u0000${right.callbackVerifierRevisionId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }));
}

function validateCandidateSet<Context>(
  input: RawProviderCallback,
  set: CallbackVerifierCandidateSet<Context>
): void {
  if (set.contractVersion !== 1) throw new TypeError('callback candidate-set version is unsupported');
  if (set.connectionId !== input.providerConnectionId) {
    throw new TypeError('callback candidate set does not belong to the ingress connection');
  }
  if (!Number.isSafeInteger(set.verifierPointerVersion) || set.verifierPointerVersion <= 0) {
    throw new TypeError('callback verifier pointer version must be positive');
  }
  if (!Number.isSafeInteger(set.resolvedAtDatabaseTime) || set.resolvedAtDatabaseTime < 0) {
    throw new TypeError('callback candidate set requires bounded database time');
  }
  if (
    set.connectionLifecycleVerificationUntil !== undefined
    && (
      !Number.isSafeInteger(set.connectionLifecycleVerificationUntil)
      || set.connectionLifecycleVerificationUntil < 0
    )
  ) throw new TypeError('callback connection ceiling must be a bounded timestamp');
  if (
    set.pointerState === 'draining_disabled'
    && (
      !Number.isSafeInteger(set.currentVerificationUntil)
      || set.currentVerificationUntil < 0
    )
  ) throw new TypeError('callback draining ceiling must be a bounded timestamp');
  const declared = set.pointerState === 'disabled'
    ? []
    : [set.current, set.previous].filter(
        (candidate): candidate is CallbackVerifierCandidate<Context> => candidate !== undefined
      );
  const revisionIds = new Set<string>();
  for (const candidate of declared) {
    if (candidate.connectionId !== set.connectionId) {
      throw new TypeError('callback verifier candidate belongs to another connection');
    }
    providerOpaqueIdSchema.parse(candidate.callbackVerifierRevisionId);
    providerStableKeySchema.parse(candidate.verifierKey);
    providerStableKeySchema.parse(candidate.verifierVersion);
    if (
      !Number.isSafeInteger(candidate.verificationContractVersion)
      || candidate.verificationContractVersion <= 0
    ) throw new TypeError('callback verification contract version must be positive');
    providerSha256Schema.parse(candidate.configDigestSha256);
    if (revisionIds.has(candidate.callbackVerifierRevisionId)) {
      throw new TypeError('callback candidate revisions must be unique');
    }
    revisionIds.add(candidate.callbackVerifierRevisionId);
    if (
      candidate.pointerRole === 'unexpired_previous'
      && (
        !Number.isSafeInteger(candidate.eligibilityCeiling)
        || candidate.eligibilityCeiling < 0
      )
    ) throw new TypeError('callback previous ceiling must be a bounded timestamp');
  }
}

function none(
  kind: 'none',
  correlationId: string,
  evidence: SafeEvidence
): CallbackVerificationResolution {
  return Object.freeze({ contractVersion: 1, kind, correlationId, evidence });
}

function validateVerifierOutcome(
  value: ProviderOutcomeV1<
    | { kind: 'verified'; verified: unknown; evidence: unknown }
    | { kind: 'not_verified'; evidence: unknown }
  >,
  input: RawProviderCallback
): ProviderOutcomeV1<
  | { kind: 'verified'; verified: ReturnType<typeof verifiedProviderCallbackSchema.parse>; evidence: SafeEvidence }
  | { kind: 'not_verified'; evidence: SafeEvidence }
> {
  if (value.contractVersion !== 1) throw new TypeError('callback verifier outcome version is unsupported');
  const evidence = safeEvidenceSchema.parse(value.evidence);
  if (value.kind === 'not_verified') {
    return Object.freeze({ contractVersion: 1, kind: 'not_verified', evidence });
  }
  const verified = verifiedProviderCallbackSchema.parse(value.verified);
  if (
    verified.providerConnectionId !== input.providerConnectionId
    || verified.payloadDigestSha256 !== input.payloadDigestSha256
  ) throw new TypeError('verified callback does not bind the ingress envelope');
  return Object.freeze({ contractVersion: 1, kind: 'verified', verified, evidence });
}

/**
 * Creates the sole exact-tuple verifier dispatcher. Missing or duplicate retained
 * implementations fail closed before any candidate can be accepted.
 */
export function createEmailCallbackVerifierRegistry<Context>(input: Readonly<{
  implementations: readonly EmailCallbackVerifier<Context>[];
  evidence: CallbackRegistryEvidenceFactory;
}>): EmailCallbackVerifierRegistry<Context> {
  const implementations = new Map<string, EmailCallbackVerifier<Context>[]>();
  for (const implementation of input.implementations) {
    const key = implementationKey(implementation);
    const existing = implementations.get(key) ?? [];
    existing.push(implementation);
    implementations.set(key, existing);
  }

  return Object.freeze({
    async resolve(
      raw: RawProviderCallback,
      candidateSet: CallbackVerifierCandidateSet<Context>
    ) {
      const callback = validateRawProviderCallback(raw);
      try {
        validateCandidateSet(callback, candidateSet);
      } catch {
        return none(
          'none',
          callback.ingressCorrelationId,
          input.evidence('callback.verifier_unavailable', callback.ingressCorrelationId)
        );
      }
      const candidates = eligibleCandidates<Context>(candidateSet);
      if (candidates.length === 0) {
        return none(
          'none',
          callback.ingressCorrelationId,
          input.evidence('callback.no_candidate', callback.ingressCorrelationId)
        );
      }

      const selected: Array<Readonly<{
        candidate: CallbackVerifierCandidate<Context>;
        implementation: EmailCallbackVerifier<Context>;
      }>> = [];
      for (const candidate of candidates) {
        const exact = implementations.get(implementationKey(candidate));
        if (exact?.length !== 1) {
          return none(
            'none',
            callback.ingressCorrelationId,
            input.evidence('callback.verifier_unavailable', callback.ingressCorrelationId)
          );
        }
        selected.push(Object.freeze({ candidate, implementation: exact[0]! }));
      }

      const results = await Promise.all(selected.map(async ({ candidate, implementation }) => {
        try {
          return {
            candidate,
            outcome: validateVerifierOutcome(
              await implementation.verifyCandidate(callback, candidate),
              callback
            )
          } as const;
        } catch {
          return { candidate, outcome: null } as const;
        }
      }));
      const verified = results.filter((result) => result.outcome?.kind === 'verified');
      if (verified.length === 0) {
        return none(
          'none',
          callback.ingressCorrelationId,
          input.evidence('callback.none_verified', callback.ingressCorrelationId)
        );
      }
      if (verified.length > 1) {
        return Object.freeze({
          contractVersion: 1,
          kind: 'ambiguous',
          correlationId: callback.ingressCorrelationId,
          evidence: input.evidence('callback.multiple_verified', callback.ingressCorrelationId)
        });
      }
      const match = verified[0]!;
      const outcome = match.outcome!;
      if (outcome.kind !== 'verified') throw new TypeError('callback verifier result narrowed incorrectly');
      return Object.freeze({
        contractVersion: 1,
        kind: 'exactly_one',
        callbackVerifierRevisionId: match.candidate.callbackVerifierRevisionId,
        verifierKey: match.candidate.verifierKey,
        verifierVersion: match.candidate.verifierVersion,
        verificationContractVersion: match.candidate.verificationContractVersion,
        verifierConfigDigestSha256: match.candidate.configDigestSha256,
        verified: outcome.verified,
        evidence: outcome.evidence
      });
    }
  });
}
