import { versionedDefinitionRefSchema } from '@jooevents/contracts';
import type {
  DirectOperationFeatureContributor,
  DirectOperationFeatureContributorRegistry
} from './types';

type ContributionInput = Parameters<DirectOperationFeatureContributor['contribute']>[0];

interface RegisteredContributor {
  readonly reference: DirectOperationFeatureContributor['reference'];
  readonly contribute: DirectOperationFeatureContributor['contribute'];
}

const registered = new WeakMap<object, readonly RegisteredContributor[]>();

function compareContributor(left: RegisteredContributor, right: RegisteredContributor): number {
  const key = left.reference.key.localeCompare(right.reference.key);
  return key === 0 ? left.reference.version - right.reference.version : key;
}

/**
 * Creates the only admitted plural contributor registry. Callers provide concrete
 * process-owned implementations; the returned registry is immutable and authentic.
 */
export function createDirectOperationFeatureContributorRegistry(
  candidates: readonly DirectOperationFeatureContributor[]
): DirectOperationFeatureContributorRegistry {
  if (candidates.length > 32) throw new TypeError('direct_operation_feature_contributor_bound_exceeded');
  const contributors = candidates.map((candidate): RegisteredContributor => {
    const reference = versionedDefinitionRefSchema.safeParse(candidate.reference);
    if (!reference.success || typeof candidate.contribute !== 'function') {
      throw new TypeError('direct_operation_feature_contributor_invalid');
    }
    return Object.freeze({
      reference: Object.freeze({ ...reference.data }),
      contribute: candidate.contribute.bind(candidate)
    });
  }).sort(compareContributor);
  for (let index = 1; index < contributors.length; index += 1) {
    const previous = contributors[index - 1]!.reference;
    const current = contributors[index]!.reference;
    if (previous.key === current.key && previous.version === current.version) {
      throw new TypeError(`direct_operation_feature_contributor_duplicate:${current.key}@${current.version}`);
    }
  }
  const registry = Object.freeze({
    references: Object.freeze(contributors.map((contributor) => contributor.reference))
  });
  registered.set(registry, Object.freeze(contributors));
  return registry;
}

export function assertDirectOperationFeatureContributorRegistry(
  candidate: DirectOperationFeatureContributorRegistry
): void {
  if (!registered.has(candidate)) throw new TypeError('direct_operation_feature_contributor_registry_untrusted');
}

/** Resolves contributors in their one deterministic registered-reference order. */
export function resolveDirectOperationFeatureContributorRegistry(
  registry: DirectOperationFeatureContributorRegistry,
  input: ContributionInput
): readonly Readonly<{
  reference: DirectOperationFeatureContributor['reference'];
  value: unknown;
}>[] {
  const contributors = registered.get(registry);
  if (!contributors) throw new TypeError('direct_operation_feature_contributor_registry_untrusted');
  const resolved: { reference: DirectOperationFeatureContributor['reference']; value: unknown }[] = [];
  for (const contributor of contributors) {
    const value = contributor.contribute(input);
    if (value && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') {
      throw new TypeError('direct operation feature contributor returned a promise');
    }
    if (value !== undefined) resolved.push(Object.freeze({ reference: contributor.reference, value }));
  }
  return Object.freeze(resolved);
}
