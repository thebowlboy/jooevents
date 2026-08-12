import { createHash } from 'node:crypto';
import { canonicalJsonValue, encodeCanonicalJson, type CanonicalJson } from '@jooevents/kernel';
import type {
  ModelDefinitionRef,
  ModelProfileRevision,
  ModelProviderAdapter,
  ModelScaffoldRevision,
  ProviderCapabilities
} from './types';
import { validateProfile, validateScaffold } from './validation';

const stableKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256 = /^[a-f0-9]{64}$/;

export interface RegisteredModelAdapter {
  readonly adapter: ModelProviderAdapter;
  readonly implementationDigestSha256: string;
}

export interface ModelPurposeBinding {
  readonly purpose: string;
  readonly profile: ModelDefinitionRef & { readonly digest: string };
  readonly scaffold: ModelDefinitionRef & { readonly digest: string };
}

export interface ModelRegistrySource {
  readonly adapters: readonly RegisteredModelAdapter[];
  readonly profiles: readonly ModelProfileRevision[];
  readonly scaffolds: readonly ModelScaffoldRevision[];
  readonly purposes: readonly ModelPurposeBinding[];
}

export interface ModelRegistry {
  readonly registryDigestSha256: string;
  getAdapter(reference: ModelDefinitionRef): ModelProviderAdapter | undefined;
  getProfile(reference: ModelDefinitionRef): ModelProfileRevision | undefined;
  getScaffold(reference: ModelDefinitionRef): ModelScaffoldRevision | undefined;
  resolvePurpose(purpose: string): Readonly<{
    profile: ModelProfileRevision;
    scaffold: ModelScaffoldRevision;
    adapter: ModelProviderAdapter;
  }> | undefined;
}

export interface ModelRegistryIssue {
  readonly code: string;
  readonly detail: string;
}

export class ModelRegistryValidationError extends Error {
  readonly issues: readonly ModelRegistryIssue[];

  constructor(issues: readonly ModelRegistryIssue[]) {
    super(`Model registry validation failed with ${issues.length} issue(s).`);
    this.name = 'ModelRegistryValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

function refKey(reference: ModelDefinitionRef): string {
  return `${reference.key}@${reference.version}`;
}

function compareRef(left: ModelDefinitionRef, right: ModelDefinitionRef): number {
  return left.key.localeCompare(right.key) || left.version - right.version;
}

function digestBytes(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

function withoutDigest<Value extends { readonly digest: string }>(value: Value): Omit<Value, 'digest'> {
  const { digest: _digest, ...body } = value;
  return body;
}

export function calculateModelProfileDigest(profile: ModelProfileRevision): string {
  return digestBytes(withoutDigest(profile));
}

export function calculateModelScaffoldDigest(scaffold: ModelScaffoldRevision): string {
  return digestBytes(withoutDigest(scaffold));
}

function cloneDefinition<Value>(value: Value): Value {
  return deepFreeze(canonicalJsonValue(value) as Value);
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function validateRef(reference: ModelDefinitionRef, usage: string, issues: ModelRegistryIssue[]): boolean {
  if (!stableKey.test(reference.key) || !Number.isSafeInteger(reference.version) || reference.version <= 0) {
    issues.push({ code: 'invalid_reference', detail: `${usage} has an invalid key/version.` });
    return false;
  }
  return true;
}

function sameCapabilities(required: ProviderCapabilities, actual: ProviderCapabilities): boolean {
  return (Object.keys(required) as (keyof ProviderCapabilities)[])
    .every((key) => !required[key] || actual[key]);
}

function insertUnique<Value>(
  map: Map<string, Value>,
  key: string,
  value: Value,
  category: string,
  issues: ModelRegistryIssue[]
): void {
  if (map.has(key)) {
    issues.push({ code: 'duplicate_definition', detail: `${category} ${key} is duplicated.` });
  } else {
    map.set(key, value);
  }
}

export function createModelRegistry(source: ModelRegistrySource): ModelRegistry {
  const issues: ModelRegistryIssue[] = [];
  const adapters = new Map<string, RegisteredModelAdapter>();
  const profiles = new Map<string, ModelProfileRevision>();
  const scaffolds = new Map<string, ModelScaffoldRevision>();
  const purposes = new Map<string, ModelPurposeBinding>();

  for (const registration of source.adapters) {
    if (!validateRef(registration.adapter.ref, 'adapter', issues)) continue;
    if (!sha256.test(registration.implementationDigestSha256)) {
      issues.push({ code: 'invalid_implementation_digest', detail: `Adapter ${refKey(registration.adapter.ref)} has an invalid implementation digest.` });
    }
    const capabilities = registration.adapter.describeCapabilities();
    if (Object.values(capabilities).some((value) => typeof value !== 'boolean')) {
      issues.push({ code: 'invalid_capabilities', detail: `Adapter ${refKey(registration.adapter.ref)} returned invalid capabilities.` });
    }
    insertUnique(adapters, refKey(registration.adapter.ref), registration, 'adapter', issues);
  }

  for (const candidate of source.profiles) {
    try {
      validateProfile(candidate);
    } catch (error) {
      issues.push({ code: 'invalid_profile', detail: error instanceof Error ? error.message : 'Profile validation failed.' });
      continue;
    }
    if (!validateRef(candidate, 'profile', issues)) continue;
    const calculated = calculateModelProfileDigest(candidate);
    if (candidate.digest !== calculated) {
      issues.push({ code: 'profile_digest_mismatch', detail: `Profile ${refKey(candidate)} digest does not match its canonical body.` });
    }
    const adapter = adapters.get(refKey(candidate.adapter));
    if (!adapter) {
      issues.push({ code: 'missing_adapter', detail: `Profile ${refKey(candidate)} references missing adapter ${refKey(candidate.adapter)}.` });
    } else if (!sameCapabilities(candidate.capabilities, adapter.adapter.describeCapabilities())) {
      issues.push({ code: 'unsupported_profile_capability', detail: `Profile ${refKey(candidate)} requires an unsupported adapter capability.` });
    }
    insertUnique(profiles, refKey(candidate), cloneDefinition(candidate), 'profile', issues);
  }

  for (const candidate of source.scaffolds) {
    try {
      validateScaffold(candidate);
    } catch (error) {
      issues.push({ code: 'invalid_scaffold', detail: error instanceof Error ? error.message : 'Scaffold validation failed.' });
      continue;
    }
    if (!validateRef(candidate, 'scaffold', issues)) continue;
    const calculated = calculateModelScaffoldDigest(candidate);
    if (candidate.digest !== calculated) {
      issues.push({ code: 'scaffold_digest_mismatch', detail: `Scaffold ${refKey(candidate)} digest does not match its canonical body.` });
    }
    insertUnique(scaffolds, refKey(candidate), cloneDefinition(candidate), 'scaffold', issues);
  }

  for (const binding of source.purposes) {
    if (!stableKey.test(binding.purpose)) {
      issues.push({ code: 'invalid_purpose', detail: `Purpose ${binding.purpose} is invalid.` });
      continue;
    }
    if (purposes.has(binding.purpose)) {
      issues.push({ code: 'duplicate_purpose', detail: `Purpose ${binding.purpose} is duplicated.` });
      continue;
    }
    const profile = profiles.get(refKey(binding.profile));
    const scaffold = scaffolds.get(refKey(binding.scaffold));
    if (!profile || profile.digest !== binding.profile.digest) {
      issues.push({ code: 'purpose_profile_mismatch', detail: `Purpose ${binding.purpose} has a missing or mismatched profile revision.` });
    }
    if (!scaffold || scaffold.digest !== binding.scaffold.digest || scaffold.purpose !== binding.purpose) {
      issues.push({ code: 'purpose_scaffold_mismatch', detail: `Purpose ${binding.purpose} has a missing, mismatched, or differently purposed scaffold revision.` });
    }
    purposes.set(binding.purpose, cloneDefinition(binding));
  }

  if (issues.length > 0) throw new ModelRegistryValidationError(issues);

  const digestManifest: CanonicalJson = canonicalJsonValue({
    adapters: [...adapters.values()]
      .map((registration) => ({
        ref: registration.adapter.ref,
        implementationDigestSha256: registration.implementationDigestSha256,
        capabilities: registration.adapter.describeCapabilities()
      }))
      .sort((left, right) => compareRef(left.ref, right.ref)),
    profiles: [...profiles.values()].sort(compareRef),
    scaffolds: [...scaffolds.values()].sort(compareRef),
    purposes: [...purposes.values()].sort((left, right) => left.purpose.localeCompare(right.purpose))
  });
  const registryDigestSha256 = digestBytes(digestManifest);

  return Object.freeze({
    registryDigestSha256,
    getAdapter(reference: ModelDefinitionRef) {
      return adapters.get(refKey(reference))?.adapter;
    },
    getProfile(reference: ModelDefinitionRef) {
      return profiles.get(refKey(reference));
    },
    getScaffold(reference: ModelDefinitionRef) {
      return scaffolds.get(refKey(reference));
    },
    resolvePurpose(purpose: string) {
      const binding = purposes.get(purpose);
      if (!binding) return undefined;
      const profile = profiles.get(refKey(binding.profile));
      const scaffold = scaffolds.get(refKey(binding.scaffold));
      const adapter = profile ? adapters.get(refKey(profile.adapter))?.adapter : undefined;
      return profile && scaffold && adapter ? Object.freeze({ profile, scaffold, adapter }) : undefined;
    }
  });
}
