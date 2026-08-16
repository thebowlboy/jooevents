import {
  canonicalJsonValue,
  encodeCanonicalJson,
  parseCapabilityRevisionId,
  parseContractVersion,
  type CanonicalJson
} from '@jooevents/kernel';
import {
  ACTIVITY_SOURCE_KINDS,
  CONSUMER_OUTPUT_KINDS,
  EXTERNAL_RETRY_POLICIES,
  RELIABILITY_KINDS,
  RELIABILITY_LIMITS,
  parseCanonicalSha256,
  parseDefinitionKey,
  type ActivityProjectionDefinition,
  type ActivitySourceKind,
  type CanonicalSha256,
  type ConsumerDefinition,
  type DefinitionRef,
  type DomainFactDefinition,
  type EffectDefinition,
  type JobDefinition,
  type ProducerRef,
  type ReliabilityDefinition,
  type ReliabilityDefinitionDraft,
  type ReliabilityKind,
  type SchemaRef
} from './definitions';

export const RELIABILITY_DEFINITION_DIGEST_PROFILE = Object.freeze({
  key: 'jooevents.reliability_definition',
  version: 1
} as const);

export const RELIABILITY_CATALOG_DIGEST_PROFILE = Object.freeze({
  key: 'jooevents.reliability_catalog',
  version: 1
} as const);

export class ReliabilityRegistryError extends Error {
  constructor(
    readonly code:
      | 'invalid_definition'
      | 'digest_mismatch'
      | 'duplicate_definition'
      | 'missing_prior_version'
      | 'unknown_reference'
      | 'schema_conflict',
    message: string
  ) {
    super(message);
    this.name = 'ReliabilityRegistryError';
  }
}

function invalid(message: string): never {
  throw new ReliabilityRegistryError('invalid_definition', message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertVersion(value: unknown, label: string): void {
  try {
    parseContractVersion(value);
  } catch {
    invalid(`${label} must be a positive version`);
  }
}

function assertKey(value: unknown, label: string): void {
  try {
    parseDefinitionKey(value);
  } catch {
    invalid(`${label} is not a canonical definition key`);
  }
}

function assertDigest(value: unknown, label: string): void {
  try {
    parseCanonicalSha256(value);
  } catch {
    invalid(`${label} is not a canonical SHA-256`);
  }
}

function assertRef(value: unknown, expectedKind: string | readonly string[], label: string): void {
  const ref = asObject(value, label);
  const kinds = typeof expectedKind === 'string' ? [expectedKind] : expectedKind;
  if (typeof ref.kind !== 'string' || !kinds.includes(ref.kind)) {
    invalid(`${label}.kind is not allowed`);
  }
  assertKey(ref.key, `${label}.key`);
  assertVersion(ref.version, `${label}.version`);
}

function assertSchema(value: unknown, label: string): void {
  const schema = asObject(value, label);
  assertKey(schema.key, `${label}.key`);
  assertVersion(schema.version, `${label}.version`);
  assertDigest(schema.canonicalSchemaDigestSha256, `${label}.canonicalSchemaDigestSha256`);
}

function assertUniqueRefs(values: readonly unknown[], label: string): void {
  const seen = new Set<string>();
  for (const candidate of values) {
    const ref = asObject(candidate, label);
    const identity = `${String(ref.kind)}\u0000${String(ref.key)}\u0000${String(ref.version)}`;
    if (seen.has(identity)) invalid(`${label} contains a duplicate exact reference`);
    seen.add(identity);
  }
}

function assertBoundedArray(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty: boolean
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) {
    invalid(`${label} must contain ${allowEmpty ? 'zero or more' : 'one or more'} bounded entries`);
  }
}

function assertBoundedInteger(value: unknown, label: string, maximum: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    invalid(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
}

function assertProducer(producer: unknown, label: string): void {
  const candidate = asObject(producer, label);
  if (candidate.kind === 'operation') {
    assertRef(candidate.operation, 'operation', `${label}.operation`);
    return;
  }
  invalid(`${label}.kind is not a closed producer kind`);
}

function assertCommon(definition: Record<string, unknown>, includeDigest: boolean): void {
  if (!RELIABILITY_KINDS.includes(definition.kind as ReliabilityKind)) {
    invalid('definition.kind is not a closed reliability kind');
  }
  assertKey(definition.key, 'definition.key');
  assertVersion(definition.version, 'definition.version');
  if (includeDigest) assertDigest(definition.canonicalDigestSha256, 'definition.canonicalDigestSha256');
}

function assertProducers(value: unknown, label: string): void {
  assertBoundedArray(value, label, RELIABILITY_LIMITS.maximumProducers, false);
  value.forEach((producer, index) => assertProducer(producer, `${label}[${index}]`));
  const identities = value.map((producer) => {
    const typed = producer as ProducerRef;
    return { kind: typed.kind, key: typed.operation.key, version: typed.operation.version };
  });
  assertUniqueRefs(identities, label);
}

function assertDomainFact(definition: Record<string, unknown>): void {
  assertSchema(definition.metadataSchema, 'domain_fact.metadataSchema');
  assertProducers(definition.producers, 'domain_fact.producers');
  assertKey(definition.aggregateKind, 'domain_fact.aggregateKind');
  assertRef(definition.subjectIdentity, 'subject_identity', 'domain_fact.subjectIdentity');
  assertRef(definition.scope, 'scope', 'domain_fact.scope');
  assertRef(definition.causalParent, 'causal_parent', 'domain_fact.causalParent');
  assertRef(
    definition.consumerCompatibility,
    'consumer_compatibility',
    'domain_fact.consumerCompatibility'
  );
  assertBoundedArray(
    definition.classifiedPayloadPaths,
    'domain_fact.classifiedPayloadPaths',
    RELIABILITY_LIMITS.maximumClassifiedPayloadPaths,
    true
  );
  const paths = new Set<string>();
  for (const path of definition.classifiedPayloadPaths) {
    if (typeof path !== 'string' || (!path.startsWith('/') && path !== '')) {
      invalid('domain_fact.classifiedPayloadPaths must contain JSON pointers');
    }
    if (paths.has(path)) invalid('domain_fact.classifiedPayloadPaths contains a duplicate');
    paths.add(path);
  }
  assertRef(definition.redaction, 'redaction', 'domain_fact.redaction');
}

function assertEffect(definition: Record<string, unknown>): void {
  assertSchema(definition.specificationSchema, 'effect.specificationSchema');
  assertSchema(definition.providerAttemptSchema, 'effect.providerAttemptSchema');
  assertProducers(definition.producers, 'effect.producers');
  assertRef(definition.targetJob, 'job', 'effect.targetJob');
  assertRef(definition.reducer, 'reducer', 'effect.reducer');
  assertRef(definition.authorityCitation, 'authority_citation', 'effect.authorityCitation');
  assertRef(definition.retry, 'retry', 'effect.retry');
  assertRef(definition.cancellation, 'cancellation', 'effect.cancellation');
}

function assertAcceptedSources(
  value: unknown,
  kinds: readonly string[],
  label: string
): asserts value is readonly DefinitionRef[] {
  assertBoundedArray(value, label, RELIABILITY_LIMITS.maximumAcceptedSources, false);
  value.forEach((source, index) => assertRef(source, kinds, `${label}[${index}]`));
  assertUniqueRefs(value, label);
}

function assertExecutionTarget(definition: Record<string, unknown>, label: string): void {
  assertRef(definition.inputProjection, 'input_projection', `${label}.inputProjection`);
  assertRef(definition.targetOperation, 'operation', `${label}.targetOperation`);
  try {
    parseCapabilityRevisionId(definition.capabilityRevisionId);
  } catch {
    invalid(`${label}.capabilityRevisionId must be an application capability revision ID`);
  }
  assertRef(definition.authorityCitation, 'authority_citation', `${label}.authorityCitation`);
}

function assertConsumer(definition: Record<string, unknown>): void {
  assertAcceptedSources(definition.acceptedSources, ['domain_fact', 'effect', 'job'], 'consumer.acceptedSources');
  assertSchema(definition.inputSchema, 'consumer.inputSchema');
  assertSchema(definition.resultSchema, 'consumer.resultSchema');
  assertExecutionTarget(definition, 'consumer');
  assertBoundedInteger(
    definition.maximumAttempts,
    'consumer.maximumAttempts',
    RELIABILITY_LIMITS.maximumAttempts
  );
  assertBoundedInteger(
    definition.leaseDurationMs,
    'consumer.leaseDurationMs',
    RELIABILITY_LIMITS.maximumLeaseDurationMs
  );
  assertRef(definition.backoff, 'backoff', 'consumer.backoff');
  if (!CONSUMER_OUTPUT_KINDS.includes(definition.outputKind as never)) {
    invalid('consumer.outputKind is not closed');
  }
  assertRef(definition.replay, 'replay', 'consumer.replay');
  assertRef(definition.removal, 'removal', 'consumer.removal');
}

function assertJob(definition: Record<string, unknown>): void {
  assertSchema(definition.inputSchema, 'job.inputSchema');
  assertSchema(definition.resultSchema, 'job.resultSchema');
  assertSchema(definition.errorDetailSchema, 'job.errorDetailSchema');
  assertRef(definition.source, 'source', 'job.source');
  assertRef(definition.scopeCausation, 'scope_causation', 'job.scopeCausation');
  assertExecutionTarget(definition, 'job');
  assertBoundedInteger(
    definition.leaseDurationMs,
    'job.leaseDurationMs',
    RELIABILITY_LIMITS.maximumLeaseDurationMs
  );
  assertBoundedInteger(definition.maximumAttempts, 'job.maximumAttempts', RELIABILITY_LIMITS.maximumAttempts);
  assertRef(definition.backoff, 'backoff', 'job.backoff');
  assertBoundedInteger(definition.timeoutMs, 'job.timeoutMs', RELIABILITY_LIMITS.maximumJobTimeoutMs);
  assertRef(definition.cancellation, 'cancellation', 'job.cancellation');
  if (!EXTERNAL_RETRY_POLICIES.includes(definition.externalRetryPolicy as never)) {
    invalid('job.externalRetryPolicy is not closed');
  }
}

function assertActivityProjection(definition: Record<string, unknown>): void {
  assertAcceptedSources(
    definition.acceptedSources,
    ACTIVITY_SOURCE_KINDS,
    'activity_projection.acceptedSources'
  );
  assertSchema(definition.inputSchema, 'activity_projection.inputSchema');
  assertSchema(definition.itemSchema, 'activity_projection.itemSchema');
  assertRef(
    definition.viewerAuthorization,
    'viewer_authorization',
    'activity_projection.viewerAuthorization'
  );
  assertRef(definition.redaction, 'redaction', 'activity_projection.redaction');
  assertRef(definition.destination, 'destination', 'activity_projection.destination');
  assertRef(definition.projector, 'activity_projector', 'activity_projection.projector');
}

function validateDefinitionShape(value: unknown, includeDigest: boolean): void {
  const definition = asObject(value, 'definition');
  assertCommon(definition, includeDigest);
  switch (definition.kind) {
    case 'domain_fact':
      assertDomainFact(definition);
      return;
    case 'effect':
      assertEffect(definition);
      return;
    case 'consumer':
      assertConsumer(definition);
      return;
    case 'job':
      assertJob(definition);
      return;
    case 'activity_projection':
      assertActivityProjection(definition);
      return;
    default:
      invalid('definition.kind is not closed');
  }
}

async function sha256(value: unknown): Promise<CanonicalSha256> {
  const bytes = new Uint8Array(encodeCanonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return parseCanonicalSha256(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

function definitionBody(definition: ReliabilityDefinition): ReliabilityDefinitionDraft {
  const { canonicalDigestSha256: _digest, ...body } = definition;
  return body as ReliabilityDefinitionDraft;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function canonicalClone<T>(value: T): T {
  return canonicalJsonValue(value) as T & CanonicalJson;
}

export async function digestReliabilityDefinition(
  definition: ReliabilityDefinitionDraft
): Promise<CanonicalSha256> {
  const canonical = canonicalClone(definition);
  validateDefinitionShape(canonical, false);
  return sha256({
    profile: RELIABILITY_DEFINITION_DIGEST_PROFILE,
    definition: canonical
  });
}

export async function sealReliabilityDefinition<const Draft extends ReliabilityDefinitionDraft>(
  draft: Draft
): Promise<Extract<ReliabilityDefinition, { readonly kind: Draft['kind'] }>> {
  const canonical = canonicalClone(draft);
  validateDefinitionShape(canonical, false);
  const canonicalDigestSha256 = await sha256({
    profile: RELIABILITY_DEFINITION_DIGEST_PROFILE,
    definition: canonical
  });
  return deepFreeze({
    ...canonical,
    canonicalDigestSha256
  }) as unknown as Extract<ReliabilityDefinition, { readonly kind: Draft['kind'] }>;
}

function definitionIdentity(definition: ReliabilityDefinition): string {
  return `${definition.kind}\u0000${definition.key}\u0000${definition.version}`;
}

function compareDefinitions(left: ReliabilityDefinition, right: ReliabilityDefinition): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  return left.version - right.version;
}

function validateVersionChains(definitions: readonly ReliabilityDefinition[]): void {
  const versions = new Map<string, Set<number>>();
  for (const definition of definitions) {
    const key = `${definition.kind}\u0000${definition.key}`;
    const known = versions.get(key) ?? new Set<number>();
    known.add(definition.version);
    versions.set(key, known);
  }
  for (const [key, known] of versions) {
    const retained = [...known].sort((left, right) => left - right);
    for (let index = 0; index < retained.length; index += 1) {
      const expectedVersion = index + 1;
      if (retained[index] !== expectedVersion) {
        throw new ReliabilityRegistryError(
          'missing_prior_version',
          `${key.replace('\u0000', ':')} is missing retained version ${expectedVersion}`
        );
      }
    }
  }
}

function validateSchemas(definitions: readonly ReliabilityDefinition[]): void {
  const known = new Map<string, CanonicalSha256>();
  const visit = (schema: SchemaRef): void => {
    const key = `${schema.key}\u0000${schema.version}`;
    const existing = known.get(key);
    if (existing !== undefined && existing !== schema.canonicalSchemaDigestSha256) {
      throw new ReliabilityRegistryError(
        'schema_conflict',
        `schema ${schema.key}@${schema.version} has conflicting canonical digests`
      );
    }
    known.set(key, schema.canonicalSchemaDigestSha256);
  };
  for (const definition of definitions) {
    switch (definition.kind) {
      case 'domain_fact':
        visit(definition.metadataSchema);
        break;
      case 'effect':
        visit(definition.specificationSchema);
        visit(definition.providerAttemptSchema);
        break;
      case 'consumer':
        visit(definition.inputSchema);
        visit(definition.resultSchema);
        break;
      case 'job':
        visit(definition.inputSchema);
        visit(definition.resultSchema);
        visit(definition.errorDetailSchema);
        break;
      case 'activity_projection':
        visit(definition.inputSchema);
        visit(definition.itemSchema);
        break;
    }
  }
}

function validateInternalReferences(definitions: readonly ReliabilityDefinition[]): void {
  const known = new Set(definitions.map(definitionIdentity));
  const requireRef = (ref: DefinitionRef<ReliabilityKind>, owner: ReliabilityDefinition): void => {
    const identity = `${ref.kind}\u0000${ref.key}\u0000${ref.version}`;
    if (!known.has(identity)) {
      throw new ReliabilityRegistryError(
        'unknown_reference',
        `${owner.kind}:${owner.key}@${owner.version} cites unknown ${ref.kind}:${ref.key}@${ref.version}`
      );
    }
  };
  for (const definition of definitions) {
    if (definition.kind === 'effect') requireRef(definition.targetJob, definition);
    if (definition.kind === 'consumer') {
      definition.acceptedSources.forEach((source) => requireRef(source, definition));
    }
    if (definition.kind === 'activity_projection') {
      definition.acceptedSources.forEach((source) => {
        if (source.kind === 'domain_fact' || source.kind === 'job' || source.kind === 'effect') {
          requireRef(source, definition);
        }
      });
    }
  }
}

export interface ReliabilityRegistry {
  readonly digestProfile: typeof RELIABILITY_CATALOG_DIGEST_PROFILE;
  readonly definitions: readonly ReliabilityDefinition[];
  readonly catalogDigestSha256: CanonicalSha256;
}

export async function buildReliabilityRegistry(
  input: readonly ReliabilityDefinition[]
): Promise<ReliabilityRegistry> {
  const definitions = input.map((definition) => canonicalClone(definition));
  const identities = new Set<string>();
  for (const definition of definitions) {
    validateDefinitionShape(definition, true);
    const identity = definitionIdentity(definition);
    if (identities.has(identity)) {
      throw new ReliabilityRegistryError('duplicate_definition', `duplicate definition ${identity}`);
    }
    identities.add(identity);
    const expected = await sha256({
      profile: RELIABILITY_DEFINITION_DIGEST_PROFILE,
      definition: definitionBody(definition)
    });
    if (expected !== definition.canonicalDigestSha256) {
      throw new ReliabilityRegistryError(
        'digest_mismatch',
        `${definition.kind}:${definition.key}@${definition.version} has a noncanonical digest`
      );
    }
  }

  definitions.sort(compareDefinitions);
  validateVersionChains(definitions);
  validateSchemas(definitions);
  validateInternalReferences(definitions);

  const frozenDefinitions = deepFreeze(definitions);
  const catalogDigestSha256 = await sha256({
    profile: RELIABILITY_CATALOG_DIGEST_PROFILE,
    definitions: frozenDefinitions
  });
  return deepFreeze({
    digestProfile: RELIABILITY_CATALOG_DIGEST_PROFILE,
    definitions: frozenDefinitions,
    catalogDigestSha256
  });
}

export function resolveReliabilityDefinition<Kind extends ReliabilityKind>(
  registry: ReliabilityRegistry,
  ref: DefinitionRef<Kind>
): Extract<ReliabilityDefinition, { readonly kind: Kind }> | undefined {
  return registry.definitions.find(
    (definition) =>
      definition.kind === ref.kind && definition.key === ref.key && definition.version === ref.version
  ) as Extract<ReliabilityDefinition, { readonly kind: Kind }> | undefined;
}
