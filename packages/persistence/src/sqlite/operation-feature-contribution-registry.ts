import type { DirectOperationFeatureContribution } from '@jooevents/application';
import {
  versionedDefinitionRefSchema,
  type VersionedDefinitionRef
} from '@jooevents/contracts';

export interface SQLiteOperationFeatureContributionAdapter {
  apply(contribution: DirectOperationFeatureContribution): void | Promise<void>;
  afterUnitOfWorkCommitted?(): void | Promise<void>;
  afterUnitOfWorkFinished?(outcome: { readonly committed: boolean }): void | Promise<void>;
}

export interface SQLiteOperationFeatureContributionAdapterRegistration {
  readonly contributor: VersionedDefinitionRef;
  readonly adapter: SQLiteOperationFeatureContributionAdapter;
}

export interface SQLiteOperationFeatureContributionAdapterRegistry
  extends SQLiteOperationFeatureContributionAdapter {
  readonly contributors: readonly VersionedDefinitionRef[];
}

const registered = new WeakSet<SQLiteOperationFeatureContributionAdapterRegistry>();

function contributorKey(contributor: VersionedDefinitionRef): string {
  return `${contributor.key}\u0000${contributor.version}`;
}

function bindAdapter(
  candidate: SQLiteOperationFeatureContributionAdapter
): SQLiteOperationFeatureContributionAdapter {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.apply !== 'function') {
    throw new TypeError('sqlite_operation_feature_contribution_adapter_invalid');
  }
  for (const hook of ['afterUnitOfWorkCommitted', 'afterUnitOfWorkFinished'] as const) {
    if (candidate[hook] !== undefined && typeof candidate[hook] !== 'function') {
      throw new TypeError(`sqlite_operation_feature_contribution_adapter_hook_invalid:${hook}`);
    }
  }
  return Object.freeze({
    apply: candidate.apply.bind(candidate),
    ...(candidate.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: candidate.afterUnitOfWorkCommitted.bind(candidate) }
      : {}),
    ...(candidate.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: candidate.afterUnitOfWorkFinished.bind(candidate) }
      : {})
  });
}

/**
 * Freezes the process-owned persistence side of the contributor seam. Registration
 * is bounded and deterministic; contributions can only dispatch to an exact
 * contributor identity that was present during runtime composition.
 */
export function createSQLiteOperationFeatureContributionAdapterRegistry(
  registrations: readonly SQLiteOperationFeatureContributionAdapterRegistration[]
): SQLiteOperationFeatureContributionAdapterRegistry {
  if (!Array.isArray(registrations) || registrations.length > 32) {
    throw new TypeError('sqlite_operation_feature_contribution_registration_invalid');
  }
  const entries = registrations.map((registration) => {
    const parsed = versionedDefinitionRefSchema.safeParse(registration?.contributor);
    if (!parsed.success) throw new TypeError('sqlite_operation_feature_contributor_invalid');
    return Object.freeze({
      contributor: Object.freeze({ ...parsed.data }),
      adapter: bindAdapter(registration.adapter)
    });
  }).sort((left, right) => left.contributor.key.localeCompare(right.contributor.key)
    || left.contributor.version - right.contributor.version);
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!.contributor;
    const current = entries[index]!.contributor;
    if (contributorKey(previous) === contributorKey(current)) {
      throw new TypeError(`sqlite_operation_feature_contributor_duplicate:${current.key}@${current.version}`);
    }
  }
  const byContributor = new Map(entries.map((entry) => [contributorKey(entry.contributor), entry.adapter]));
  const adapters = entries.map((entry) => entry.adapter);
  const registry: SQLiteOperationFeatureContributionAdapterRegistry = Object.freeze({
    contributors: Object.freeze(entries.map((entry) => entry.contributor)),
    apply(contribution: DirectOperationFeatureContribution) {
      const parsed = versionedDefinitionRefSchema.safeParse(contribution?.contributor);
      if (!parsed.success) throw new TypeError('sqlite_operation_feature_contributor_invalid');
      const adapter = byContributor.get(contributorKey(parsed.data));
      if (!adapter) {
        throw new TypeError(
          `sqlite_operation_feature_contributor_unregistered:${parsed.data.key}@${parsed.data.version}`
        );
      }
      return adapter.apply(contribution);
    },
    async afterUnitOfWorkCommitted() {
      for (const adapter of adapters) await adapter.afterUnitOfWorkCommitted?.();
    },
    async afterUnitOfWorkFinished(outcome: { readonly committed: boolean }) {
      for (const adapter of adapters) await adapter.afterUnitOfWorkFinished?.(outcome);
    }
  });
  registered.add(registry);
  return registry;
}

export function assertSQLiteOperationFeatureContributionAdapterRegistry(
  candidate: SQLiteOperationFeatureContributionAdapterRegistry
): void {
  if (!registered.has(candidate)) {
    throw new TypeError('sqlite_operation_feature_contribution_registry_unsealed');
  }
}
