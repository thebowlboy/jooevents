import { describe, expect, test } from 'bun:test';
import {
  DeterministicFakeAdapter,
  MemoryDeterministicFakeStore,
  ModelRegistryValidationError,
  calculateModelProfileDigest,
  calculateModelScaffoldDigest,
  createModelRegistry,
  type ModelProfileRevision,
  type ModelRegistrySource,
  type ModelScaffoldRevision
} from '.';

const implementationDigest = 'd'.repeat(64);

function definitions() {
  const profileBody: ModelProfileRevision = {
    key: 'foundation_fake',
    version: 1,
    digest: '',
    adapter: { key: 'deterministic_fake', version: 1 },
    modelId: 'deterministic-v1',
    controls: { maxOutputTokens: 1000, requireStructuredOutput: true },
    defaultExecutionMode: 'batch',
    budget: { maximumAttempts: 3, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000, timeoutMs: 10_000 },
    capabilities: { structuredOutput: true, tools: true, batch: true, fast: true, lookup: true, cancellation: true, idempotency: true }
  };
  const profile = { ...profileBody, digest: calculateModelProfileDigest(profileBody) };
  const scaffoldBody: ModelScaffoldRevision = {
    key: 'foundation_probe',
    version: 1,
    digest: '',
    purpose: 'foundation_probe',
    outputSchema: { key: 'foundation_probe_output', version: 1 },
    allowedTools: [{ name: 'foundation.read', version: 1 }]
  };
  const scaffold = { ...scaffoldBody, digest: calculateModelScaffoldDigest(scaffoldBody) };
  return { profile, scaffold };
}

function source(): ModelRegistrySource {
  const { profile, scaffold } = definitions();
  const adapter = new DeterministicFakeAdapter(new MemoryDeterministicFakeStore(), () => ({ kind: 'success', output: {} }));
  return {
    adapters: [{ adapter, implementationDigestSha256: implementationDigest }],
    profiles: [profile],
    scaffolds: [scaffold],
    purposes: [{
      purpose: 'foundation_probe',
      profile: { key: profile.key, version: profile.version, digest: profile.digest },
      scaffold: { key: scaffold.key, version: scaffold.version, digest: scaffold.digest }
    }]
  };
}

describe('model registry', () => {
  test('registration order does not change the digest or exact purpose resolution', () => {
    const first = createModelRegistry(source());
    const reversed = source();
    const second = createModelRegistry({
      adapters: [...reversed.adapters].reverse(),
      profiles: [...reversed.profiles].reverse(),
      scaffolds: [...reversed.scaffolds].reverse(),
      purposes: [...reversed.purposes].reverse()
    });
    expect(first.registryDigestSha256).toBe(second.registryDigestSha256);
    expect(first.resolvePurpose('foundation_probe')).toMatchObject({
      profile: { key: 'foundation_fake', version: 1 },
      scaffold: { key: 'foundation_probe', version: 1 },
      adapter: { ref: { key: 'deterministic_fake', version: 1 } }
    });
  });

  test('canonical revision digests and exact pointer digests fail closed', () => {
    const invalid = source();
    expect(() => createModelRegistry({
      ...invalid,
      profiles: [{ ...invalid.profiles[0]!, modelId: 'mutated-after-digest' }]
    })).toThrow(ModelRegistryValidationError);
    expect(() => createModelRegistry({
      ...invalid,
      purposes: [{ ...invalid.purposes[0]!, profile: { ...invalid.purposes[0]!.profile, digest: '0'.repeat(64) } }]
    })).toThrow(ModelRegistryValidationError);
  });

  test('missing adapters, duplicate purposes, and unsupported capabilities reject before use', () => {
    const invalid = source();
    const profile = invalid.profiles[0]!;
    const unsupported = { ...profile, adapter: { key: 'missing', version: 1 }, digest: '' };
    const correctedDigest = calculateModelProfileDigest(unsupported);
    expect(() => createModelRegistry({ ...invalid, profiles: [{ ...unsupported, digest: correctedDigest }] })).toThrow(ModelRegistryValidationError);
    expect(() => createModelRegistry({ ...invalid, purposes: [invalid.purposes[0]!, invalid.purposes[0]!] })).toThrow(ModelRegistryValidationError);
  });

  test('registry-owned revisions are detached from later source mutation', () => {
    const mutable = source();
    const registry = createModelRegistry(mutable);
    (mutable.profiles[0] as { modelId: string }).modelId = 'changed-outside-registry';
    expect(registry.getProfile({ key: 'foundation_fake', version: 1 })?.modelId).toBe('deterministic-v1');
  });
});
