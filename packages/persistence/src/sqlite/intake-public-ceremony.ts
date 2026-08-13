import {
  type InvocationEvidence,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  publicMutationAuthorityPartitionDigest,
  type PublicMutationContinuationAdmissionResult,
  type PublicMutationContinuationBoundary,
  type PublicMutationContinuationMintResult,
  type SealedPublicMutationContinuationMaterial
} from '@jooevents/application/public-mutation-continuation';
import type { PublicMutationEffectCompletionPort } from '@jooevents/application/public-mutation-effect-completion';
import type { PublicMutationContinuationEvidence } from '@jooevents/application/public-mutation-continuation';
import { intakeIdSchema } from '@jooevents/contracts';
import type {
  CurrentAuthorityResolutionInput,
  CurrentAuthorityResolver
} from '@jooevents/identity-access';
import {
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_DRAFT_RESUME_OPERATION,
  INTAKE_PUBLIC_MUTATE_OPERATION,
  type IntakePublicCeremonyBindingResolution,
  type IntakePublicCeremonyScopeSource
} from '@jooevents/intake-operations';
import {
  canonicalJsonText,
  parseCeremonyEvidenceId,
  parseEventId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId,
  type CeremonyEvidenceId
} from '@jooevents/kernel';

export const INTAKE_PUBLIC_CONTINUATION_HEADER = 'jooevents-continuation';
export const INTAKE_PUBLIC_FORM_SELECTOR_HEADER = 'jooevents-form-id';
export const INTAKE_PUBLIC_CONTINUATION_MINT_PATH =
  '/api/public/forms/application/continuations';

export interface IntakePublicCeremonyBoundaryEntry {
  readonly formId: string;
  readonly formVersionId: string;
  readonly boundary: PublicMutationContinuationBoundary;
  readonly completion: PublicMutationEffectCompletionPort;
}

export interface IntakePublicCeremonyBoundaryRegistry {
  readonly entries: readonly IntakePublicCeremonyBoundaryEntry[];
}

const registryEntries = new WeakMap<
  IntakePublicCeremonyBoundaryRegistry,
  ReadonlyMap<string, IntakePublicCeremonyBoundaryEntry>
>();

/** Seals the bounded selector catalog; the selector routes but never grants authority. */
export function createIntakePublicCeremonyBoundaryRegistry(
  candidates: readonly IntakePublicCeremonyBoundaryEntry[]
): IntakePublicCeremonyBoundaryRegistry {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 500) {
    throw new TypeError('intake_public_ceremony_registry_invalid');
  }
  const map = new Map<string, IntakePublicCeremonyBoundaryEntry>();
  for (const candidate of candidates) {
    const formId = intakeIdSchema.parse(candidate.formId);
    const formVersionId = intakeIdSchema.parse(candidate.formVersionId);
    if (!candidate.boundary || typeof candidate.boundary.mint !== 'function'
        || typeof candidate.boundary.admit !== 'function'
        || typeof candidate.boundary.resolveCurrent !== 'function'
        || !candidate.completion || typeof candidate.completion.resume !== 'function') {
      throw new TypeError('intake_public_ceremony_registry_invalid');
    }
    if (map.has(formId)) throw new TypeError('intake_public_ceremony_form_duplicate');
    map.set(formId, Object.freeze({ formId, formVersionId,
      boundary: candidate.boundary, completion: candidate.completion }));
  }
  const ordered = Object.freeze([...map.values()].sort((left, right) =>
    left.formId < right.formId ? -1 : left.formId > right.formId ? 1 : 0));
  const registry = Object.freeze({ entries: ordered });
  registryEntries.set(registry, new Map(ordered.map((entry) => [entry.formId, entry])));
  return registry;
}

export type IntakePublicCeremonyAdmission =
  | { readonly kind: 'ready'; readonly evidence: Extract<
      PublicMutationContinuationAdmissionResult,
      { readonly kind: 'ready' }
    >['evidence'] }
  | { readonly kind: 'terminal'; readonly receipt: TerminalEffectReceipt }
  | { readonly kind: 'stopped'; readonly reason: 'not_available' | 'expired' | 'revoked' | 'policy_changed' };

export interface IntakePublicCeremonyDirectory extends IntakePublicCeremonyScopeSource {
  mint(input: {
    readonly formId: string;
    readonly protocolEvidence: unknown;
  }): Promise<PublicMutationContinuationMintResult>;
  admit(input: {
    readonly formId: string;
    readonly continuation: string;
  }): IntakePublicCeremonyAdmission;
  resolveCurrent(ceremonyEvidenceId: CeremonyEvidenceId):
    IntakePublicCeremonyBindingResolution | undefined;
  openForEffect(ceremonyEvidenceId: CeremonyEvidenceId): {
    readonly binding: IntakePublicCeremonyBindingResolution;
    readonly evidence: PublicMutationContinuationEvidence;
    readonly boundary: PublicMutationContinuationBoundary;
    readonly completion: PublicMutationEffectCompletionPort;
  } | undefined;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
}

const issuedDirectories = new WeakSet<object>();

export function assertIntakePublicCeremonyDirectory(
  directory: IntakePublicCeremonyDirectory
): void {
  if (!issuedDirectories.has(directory)) {
    throw new TypeError('intake_public_ceremony_directory_unsealed');
  }
}

function exactBinding(
  entry: IntakePublicCeremonyBoundaryEntry,
  material: SealedPublicMutationContinuationMaterial
): IntakePublicCeremonyBindingResolution | undefined {
  const configuration = material.configuration;
  if (configuration.operation.name !== INTAKE_PUBLIC_MUTATE_OPERATION.name
      || configuration.operation.version !== INTAKE_PUBLIC_MUTATE_OPERATION.version
      || configuration.resourceBindings.length !== 2
      || canonicalJsonText(configuration.resourceBindings) !== canonicalJsonText([
        { kind: 'intake_form', id: entry.formId },
        { kind: 'intake_form_version', id: entry.formVersionId }
      ])) return undefined;
  let draftId: string;
  try {
    draftId = intakeIdSchema.parse(configuration.actionAnchorId);
  } catch {
    return undefined;
  }
  return Object.freeze({
    workspaceId: parseWorkspaceId(configuration.scope.workspaceId),
    eventId: parseEventId(configuration.scope.eventId),
    draftId,
    formId: entry.formId,
    formVersionId: entry.formVersionId,
    authorityPartitionDigestSha256: publicMutationAuthorityPartitionDigest(
      material.principalPartitionKey
    ),
    evidenceIds: Object.freeze([
      `public-ceremony:${material.ceremonyEvidenceId}`,
      `public-policy:${configuration.publicPolicyRevisionId}`
    ].sort())
  });
}

function exactScope(
  resolved: IntakePublicCeremonyBindingResolution,
  input: CurrentAuthorityResolutionInput<InvocationEvidence>
): boolean {
  const expected = [
    { kind: 'workspace', id: resolved.workspaceId },
    { kind: 'event', id: resolved.eventId },
    { kind: 'domain', domain: 'intake', entity: 'application_draft', id: resolved.draftId },
    { kind: 'domain', domain: 'intake', entity: 'form', id: resolved.formId },
    { kind: 'domain', domain: 'intake', entity: 'form_version', id: resolved.formVersionId },
    { kind: 'domain', domain: 'intake', entity: 'authority_partition',
      id: resolved.authorityPartitionDigestSha256 }
  ];
  const canonicalSubjects = (values: readonly unknown[]) => values
    .map((value) => canonicalJsonText(value))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const actualSubjects = canonicalSubjects(input.scope.subjects);
  const expectedSubjects = canonicalSubjects(expected);
  return input.scope.workspaceId === resolved.workspaceId
    && input.scope.eventId === resolved.eventId
    && actualSubjects.length === new Set(actualSubjects).size
    && canonicalJsonText(actualSubjects) === canonicalJsonText(expectedSubjects);
}

export function createIntakePublicCeremonyDirectory(
  registry: IntakePublicCeremonyBoundaryRegistry
): IntakePublicCeremonyDirectory {
  const entries = registryEntries.get(registry);
  if (!entries) throw new TypeError('intake_public_ceremony_registry_unsealed');
  const admitted = new Map<CeremonyEvidenceId, {
    readonly entry: IntakePublicCeremonyBoundaryEntry;
    readonly evidence: PublicMutationContinuationEvidence;
  }>();

  const resolveCurrent = (ceremonyEvidenceId: CeremonyEvidenceId) => {
    const id = parseCeremonyEvidenceId(ceremonyEvidenceId);
    const admittedCeremony = admitted.get(id);
    if (!admittedCeremony) return undefined;
    const material = admittedCeremony.entry.boundary.resolveCurrent(id);
    return material ? exactBinding(admittedCeremony.entry, material) : undefined;
  };

  const currentAuthority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
    resolve(input: CurrentAuthorityResolutionInput<InvocationEvidence>) {
      if (input.evidence.kind !== 'public_ceremony'
          || input.evidence.surface !== 'public_http'
          || input.lane.kind !== 'public_ceremony'
          || input.lane.surface !== 'public_http'
          || input.lane.policy.key !== INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY.key
          || input.lane.policy.version !== INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY.version
          || !(
            (input.operation.name === INTAKE_PUBLIC_MUTATE_OPERATION.name
              && input.operation.version === INTAKE_PUBLIC_MUTATE_OPERATION.version)
            || (input.operation.name === INTAKE_PUBLIC_DRAFT_RESUME_OPERATION.name
              && input.operation.version === INTAKE_PUBLIC_DRAFT_RESUME_OPERATION.version)
          )) {
        return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      }
      const resolved = resolveCurrent(input.evidence.ceremonyEvidenceId);
      if (!resolved) {
        return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      }
      if (!exactScope(resolved, input)) {
        return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
      }
      const admittedCeremony = admitted.get(input.evidence.ceremonyEvidenceId);
      const material = admittedCeremony?.entry.boundary.resolveCurrent(
        input.evidence.ceremonyEvidenceId
      );
      if (!material) return Object.freeze({ kind: 'denied' as const, reason: 'revoked' as const });
      const publicPolicyRevisionId = parsePublicPolicyRevisionId(
        material.configuration.publicPolicyRevisionId
      );
      const ceremonyEvidenceId = parseCeremonyEvidenceId(input.evidence.ceremonyEvidenceId);
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze({
            kind: 'public_request' as const,
            publicPolicyRevisionId,
            authority: Object.freeze({ kind: 'mutation_ceremony' as const, ceremonyEvidenceId })
          }),
          principal: Object.freeze({
            kind: 'public_capability' as const,
            publicPolicyRevisionId,
            authority: Object.freeze({ kind: 'mutation_ceremony' as const, ceremonyEvidenceId })
          }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([{ kind: 'public_policy' as const,
            key: input.operation.name }]),
          evidenceIds: resolved.evidenceIds,
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      });
    }
  });

  const directory: IntakePublicCeremonyDirectory = Object.freeze({
    currentAuthority,
    resolveCurrent,
    resolve: resolveCurrent,
    openForEffect(ceremonyEvidenceId: CeremonyEvidenceId) {
      const id = parseCeremonyEvidenceId(ceremonyEvidenceId);
      const admittedCeremony = admitted.get(id);
      if (!admittedCeremony) return undefined;
      const binding = resolveCurrent(id);
      if (!binding) return undefined;
      return Object.freeze({
        binding,
        evidence: admittedCeremony.evidence,
        boundary: admittedCeremony.entry.boundary,
        completion: admittedCeremony.entry.completion
      });
    },
    async mint(input: { readonly formId: string; readonly protocolEvidence: unknown }) {
      let formId: string;
      try { formId = intakeIdSchema.parse(input.formId); } catch {
        return Object.freeze({ kind: 'unavailable' as const });
      }
      const entry = entries.get(formId);
      return entry
        ? entry.boundary.mint({ protocolEvidence: input.protocolEvidence })
        : Object.freeze({ kind: 'unavailable' as const });
    },
    admit(input: { readonly formId: string; readonly continuation: string }): IntakePublicCeremonyAdmission {
      let formId: string;
      try { formId = intakeIdSchema.parse(input.formId); } catch {
        return Object.freeze({ kind: 'stopped', reason: 'not_available' });
      }
      const entry = entries.get(formId);
      if (!entry) return Object.freeze({ kind: 'stopped', reason: 'not_available' });
      const result = entry.boundary.admit({ continuation: input.continuation });
      if (result.kind === 'stopped') return Object.freeze(result);
      if (result.kind === 'terminal') {
        const receipt = entry.completion.resume(result.completionReference);
        if (!receipt || receipt.ref.operationName !== INTAKE_PUBLIC_MUTATE_OPERATION.name
            || receipt.ref.operationVersion !== INTAKE_PUBLIC_MUTATE_OPERATION.version) {
          return Object.freeze({ kind: 'stopped', reason: 'not_available' });
        }
        return Object.freeze({ kind: 'terminal', receipt });
      }
      const material = entry.boundary.sealReader.open(result.evidence);
      const binding = material ? exactBinding(entry, material) : undefined;
      if (!binding || binding.draftId !== material?.configuration.actionAnchorId) {
        return Object.freeze({ kind: 'stopped', reason: 'not_available' });
      }
      admitted.set(result.evidence.ceremonyEvidenceId, Object.freeze({
        entry,
        evidence: result.evidence
      }));
      return Object.freeze({ kind: 'ready', evidence: result.evidence });
    }
  });
  issuedDirectories.add(directory);
  return directory;
}
