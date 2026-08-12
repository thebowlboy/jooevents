import {
  canonicalJsonValue,
  encodeCanonicalJson,
  parseContractVersion,
  type CanonicalJson,
  type ContractVersion
} from '@jooevents/kernel';
import {
  definitionRef,
  parseCanonicalSha256,
  parseDefinitionKey,
  type CanonicalSha256,
  type DefinitionKey,
  type DefinitionRef,
  type ReliabilityDefinition,
  type SchemaRef
} from './definitions';
import type { ReliabilityRegistry } from './registry';

export const RELIABILITY_AUXILIARY_KINDS = [
  'subject_identity',
  'scope',
  'causal_parent',
  'consumer_compatibility',
  'redaction',
  'reducer',
  'authority_citation',
  'retry',
  'cancellation',
  'input_projection',
  'backoff',
  'replay',
  'removal',
  'source',
  'scope_causation',
  'viewer_authorization',
  'destination',
  'activity_projector'
] as const;

export type ReliabilityAuxiliaryKind = (typeof RELIABILITY_AUXILIARY_KINDS)[number];

export const RELIABILITY_AUXILIARY_MODES = [
  'pure_total',
  'read_only',
  'transaction_reducer'
] as const;

export type ReliabilityAuxiliaryMode = (typeof RELIABILITY_AUXILIARY_MODES)[number];
export type ReliabilityCapabilityKind = 'read_capability' | 'transaction_capability';

const ALLOWED_MODES = Object.freeze({
  subject_identity: ['pure_total'],
  scope: ['pure_total', 'read_only'],
  causal_parent: ['pure_total'],
  consumer_compatibility: ['pure_total'],
  redaction: ['pure_total'],
  reducer: ['transaction_reducer'],
  authority_citation: ['pure_total', 'read_only'],
  retry: ['pure_total', 'read_only'],
  cancellation: ['pure_total', 'read_only'],
  input_projection: ['pure_total'],
  backoff: ['pure_total'],
  replay: ['pure_total', 'read_only'],
  removal: ['pure_total', 'read_only'],
  source: ['pure_total'],
  scope_causation: ['pure_total'],
  viewer_authorization: ['read_only'],
  destination: ['pure_total'],
  activity_projector: ['pure_total']
} satisfies Record<ReliabilityAuxiliaryKind, readonly ReliabilityAuxiliaryMode[]>);

export const RELIABILITY_AUXILIARY_DEFINITION_DIGEST_PROFILE = Object.freeze({
  key: 'jooevents.reliability_auxiliary_definition',
  version: 1
} as const);

export const RELIABILITY_AUXILIARY_CATALOG_DIGEST_PROFILE = Object.freeze({
  key: 'jooevents.reliability_auxiliary_catalog',
  version: 1
} as const);

export interface ReliabilityCapabilityRef<Kind extends ReliabilityCapabilityKind = ReliabilityCapabilityKind>
  extends DefinitionRef<Kind> {
  readonly canonicalContractDigestSha256: CanonicalSha256;
}

export function reliabilityCapabilityRef<const Kind extends ReliabilityCapabilityKind>(
  kind: Kind,
  key: string,
  version: number,
  canonicalContractDigestSha256: string
): ReliabilityCapabilityRef<Kind> {
  return Object.freeze({
    ...definitionRef(kind, key, version),
    canonicalContractDigestSha256: parseCanonicalSha256(canonicalContractDigestSha256)
  });
}

export interface ReliabilityAuxiliaryDefinition {
  readonly kind: ReliabilityAuxiliaryKind;
  readonly key: DefinitionKey;
  readonly version: ContractVersion;
  readonly canonicalDigestSha256: CanonicalSha256;
  readonly mode: ReliabilityAuxiliaryMode;
  readonly inputSchema: SchemaRef;
  readonly outputSchema: SchemaRef;
  readonly implementation: DefinitionRef<'reliability_implementation'>;
  readonly implementationDigestSha256: CanonicalSha256;
  readonly capabilities: readonly ReliabilityCapabilityRef[];
}

export type ReliabilityAuxiliaryDefinitionDraft = Omit<
  ReliabilityAuxiliaryDefinition,
  'canonicalDigestSha256'
>;

export type ReliabilitySchemaParseResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false };

export interface ReliabilitySchemaRegistration {
  readonly reference: SchemaRef;
  safeParse(value: unknown): ReliabilitySchemaParseResult;
}

export interface ReliabilityReadCapabilityView {
  readonly references: readonly ReliabilityCapabilityRef<'read_capability'>[];
  get(reference: DefinitionRef<'read_capability'>): unknown;
}

export interface ReliabilityTransactionCapabilityView {
  readonly references: readonly ReliabilityCapabilityRef<'transaction_capability'>[];
  get(reference: DefinitionRef<'transaction_capability'>): unknown;
}

interface ReliabilityAuxiliaryImplementationBase {
  readonly reference: DefinitionRef<'reliability_implementation'>;
  readonly canonicalImplementationDigestSha256: CanonicalSha256;
}

export interface PureTotalReliabilityAuxiliaryImplementation
  extends ReliabilityAuxiliaryImplementationBase {
  readonly mode: 'pure_total';
  execute(input: unknown): unknown;
}

export interface ReadOnlyReliabilityAuxiliaryImplementation
  extends ReliabilityAuxiliaryImplementationBase {
  readonly mode: 'read_only';
  execute(input: unknown, capabilities: ReliabilityReadCapabilityView): unknown | Promise<unknown>;
}

export interface TransactionReducerReliabilityAuxiliaryImplementation
  extends ReliabilityAuxiliaryImplementationBase {
  readonly mode: 'transaction_reducer';
  execute(
    input: unknown,
    capabilities: ReliabilityTransactionCapabilityView
  ): unknown | Promise<unknown>;
}

export type ReliabilityAuxiliaryImplementation =
  | PureTotalReliabilityAuxiliaryImplementation
  | ReadOnlyReliabilityAuxiliaryImplementation
  | TransactionReducerReliabilityAuxiliaryImplementation;

export interface ReliabilityRuntimeCapability {
  readonly reference: ReliabilityCapabilityRef;
  readonly value: unknown;
}

export interface ReliabilityAuxiliaryRegistry {
  readonly digestProfile: typeof RELIABILITY_AUXILIARY_CATALOG_DIGEST_PROFILE;
  readonly reliabilityCatalogDigestSha256: CanonicalSha256;
  readonly definitions: readonly ReliabilityAuxiliaryDefinition[];
  readonly catalogDigestSha256: CanonicalSha256;
}

export class ReliabilityAuxiliaryRegistryError extends Error {
  constructor(
    readonly code:
      | 'invalid_definition'
      | 'digest_mismatch'
      | 'duplicate_definition'
      | 'missing_prior_version'
      | 'unknown_reference'
      | 'orphan_definition'
      | 'schema_conflict'
      | 'missing_schema'
      | 'orphan_schema'
      | 'missing_implementation'
      | 'orphan_implementation'
      | 'implementation_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'ReliabilityAuxiliaryRegistryError';
  }
}

export class ReliabilityAuxiliaryExecutionError extends Error {
  constructor(
    readonly code:
      | 'unknown_definition'
      | 'invalid_input'
      | 'capability_mismatch'
      | 'invalid_output'
      | 'async_pure_implementation'
      | 'implementation_failed',
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ReliabilityAuxiliaryExecutionError';
  }
}

interface AuxiliaryRegistryState {
  readonly definitions: ReadonlyMap<string, ReliabilityAuxiliaryDefinition>;
  readonly schemas: ReadonlyMap<string, ReliabilitySchemaRegistration>;
  readonly implementations: ReadonlyMap<string, ReliabilityAuxiliaryImplementation>;
}

const auxiliaryRegistryStates = new WeakMap<ReliabilityAuxiliaryRegistry, AuxiliaryRegistryState>();

function auxiliaryIdentity(value: {
  readonly kind: string;
  readonly key: string;
  readonly version: number;
}): string {
  return `${value.kind}\u0000${value.key}\u0000${value.version}`;
}

function schemaIdentity(value: Pick<SchemaRef, 'key' | 'version'>): string {
  return `${value.key}\u0000${value.version}`;
}

function implementationIdentity(value: DefinitionRef<'reliability_implementation'>): string {
  return auxiliaryIdentity(value);
}

function capabilityIdentity(value: DefinitionRef<ReliabilityCapabilityKind>): string {
  return auxiliaryIdentity(value);
}

function deepFreeze<Value>(value: Value): Value {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
  }
  return value;
}

function canonicalClone<Value>(value: Value): Value {
  return canonicalJsonValue(value) as Value & CanonicalJson;
}

async function sha256(value: unknown): Promise<CanonicalSha256> {
  const bytes = new Uint8Array(encodeCanonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return parseCanonicalSha256(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

function invalid(message: string): never {
  throw new ReliabilityAuxiliaryRegistryError('invalid_definition', message);
}

function assertSchemaRef(value: SchemaRef, label: string): void {
  try {
    parseDefinitionKey(value.key);
    parseContractVersion(value.version);
    parseCanonicalSha256(value.canonicalSchemaDigestSha256);
  } catch {
    invalid(`${label} is not an exact schema reference`);
  }
}

function assertDefinitionRef(value: DefinitionRef, expectedKind: string, label: string): void {
  try {
    if (value.kind !== expectedKind) throw new TypeError('kind');
    parseDefinitionKey(value.key);
    parseContractVersion(value.version);
  } catch {
    invalid(`${label} is not an exact ${expectedKind} reference`);
  }
}

function assertCapabilityRef(value: ReliabilityCapabilityRef, label: string): void {
  try {
    if (value.kind !== 'read_capability' && value.kind !== 'transaction_capability') {
      throw new TypeError('kind');
    }
    parseDefinitionKey(value.key);
    parseContractVersion(value.version);
    parseCanonicalSha256(value.canonicalContractDigestSha256);
  } catch {
    invalid(`${label} is not an exact capability reference`);
  }
}

function assertAuxiliaryDefinition(
  definition: ReliabilityAuxiliaryDefinition | ReliabilityAuxiliaryDefinitionDraft,
  includeDigest: boolean
): void {
  if (!RELIABILITY_AUXILIARY_KINDS.includes(definition.kind)) {
    invalid('auxiliary definition kind is not closed');
  }
  try {
    parseDefinitionKey(definition.key);
    parseContractVersion(definition.version);
    if (includeDigest) {
      parseCanonicalSha256((definition as ReliabilityAuxiliaryDefinition).canonicalDigestSha256);
    }
    parseCanonicalSha256(definition.implementationDigestSha256);
  } catch {
    invalid('auxiliary definition identity or digest is invalid');
  }
  if (!RELIABILITY_AUXILIARY_MODES.includes(definition.mode)) {
    invalid('auxiliary definition mode is not closed');
  }
  if (!ALLOWED_MODES[definition.kind].includes(definition.mode as never)) {
    invalid(`${definition.kind} cannot use ${definition.mode}`);
  }
  assertSchemaRef(definition.inputSchema, 'auxiliary inputSchema');
  assertSchemaRef(definition.outputSchema, 'auxiliary outputSchema');
  assertDefinitionRef(definition.implementation, 'reliability_implementation', 'auxiliary implementation');
  if (!Array.isArray(definition.capabilities) || definition.capabilities.length > 32) {
    invalid('auxiliary capabilities must be a bounded array');
  }
  const seen = new Set<string>();
  for (const [index, capability] of definition.capabilities.entries()) {
    assertCapabilityRef(capability, `auxiliary capabilities[${index}]`);
    const identity = capabilityIdentity(capability);
    if (seen.has(identity)) invalid('auxiliary capabilities contain a duplicate exact reference');
    seen.add(identity);
  }
  if (definition.mode === 'pure_total' && definition.capabilities.length !== 0) {
    invalid('pure-total auxiliary definitions cannot receive capabilities');
  }
  if (definition.mode === 'read_only') {
    if (definition.capabilities.length === 0) invalid('read-only definitions require a declared capability');
    if (definition.capabilities.some((capability) => capability.kind !== 'read_capability')) {
      invalid('read-only definitions may receive only read capabilities');
    }
  }
  if (definition.mode === 'transaction_reducer') {
    if (definition.capabilities.length === 0) invalid('transaction reducers require a declared capability');
    if (definition.capabilities.some((capability) => capability.kind !== 'transaction_capability')) {
      invalid('transaction reducers may receive only transaction capabilities');
    }
  }
}

function auxiliaryDefinitionBody(
  definition: ReliabilityAuxiliaryDefinition
): ReliabilityAuxiliaryDefinitionDraft {
  const { canonicalDigestSha256: _digest, ...body } = definition;
  return body;
}

export async function sealReliabilityAuxiliaryDefinition(
  draft: ReliabilityAuxiliaryDefinitionDraft
): Promise<ReliabilityAuxiliaryDefinition> {
  const canonical = canonicalClone(draft);
  assertAuxiliaryDefinition(canonical, false);
  const canonicalDigestSha256 = await sha256({
    profile: RELIABILITY_AUXILIARY_DEFINITION_DIGEST_PROFILE,
    definition: canonical
  });
  return deepFreeze({ ...canonical, canonicalDigestSha256 });
}

function citedAuxiliaryRefs(definition: ReliabilityDefinition): readonly DefinitionRef[] {
  switch (definition.kind) {
    case 'domain_fact':
      return [
        definition.subjectIdentity,
        definition.scope,
        definition.causalParent,
        definition.consumerCompatibility,
        definition.redaction
      ];
    case 'effect':
      return [
        definition.reducer,
        definition.authorityCitation,
        definition.retry,
        definition.cancellation
      ];
    case 'consumer':
      return [
        definition.inputProjection,
        definition.authorityCitation,
        definition.backoff,
        definition.replay,
        definition.removal
      ];
    case 'job':
      return [
        definition.source,
        definition.scopeCausation,
        definition.inputProjection,
        definition.authorityCitation,
        definition.backoff,
        definition.cancellation
      ];
    case 'activity_projection':
      return [
        definition.viewerAuthorization,
        definition.redaction,
        definition.destination,
        definition.projector
      ];
  }
}

function compareAuxiliaryDefinitions(
  left: ReliabilityAuxiliaryDefinition,
  right: ReliabilityAuxiliaryDefinition
): number {
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  return left.version - right.version;
}

function validateVersionChains(definitions: readonly ReliabilityAuxiliaryDefinition[]): void {
  const versions = new Map<string, Set<number>>();
  for (const definition of definitions) {
    const identity = `${definition.kind}\u0000${definition.key}`;
    const retained = versions.get(identity) ?? new Set<number>();
    retained.add(definition.version);
    versions.set(identity, retained);
  }
  for (const [identity, versionsForIdentity] of versions) {
    const ordered = [...versionsForIdentity].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index] !== index + 1) {
        throw new ReliabilityAuxiliaryRegistryError(
          'missing_prior_version',
          `${identity.replace('\u0000', ':')} is missing retained version ${index + 1}`
        );
      }
    }
  }
}

function validateCitedDefinitions(
  reliability: ReliabilityRegistry,
  definitions: readonly ReliabilityAuxiliaryDefinition[]
): Set<string> {
  const known = new Map(definitions.map((definition) => [auxiliaryIdentity(definition), definition]));
  const cited = new Set<string>();
  for (const owner of reliability.definitions) {
    for (const reference of citedAuxiliaryRefs(owner)) {
      if (!RELIABILITY_AUXILIARY_KINDS.includes(reference.kind as ReliabilityAuxiliaryKind)) {
        throw new ReliabilityAuxiliaryRegistryError(
          'unknown_reference',
          `${owner.kind}:${owner.key}@${owner.version} cites unsupported auxiliary kind ${reference.kind}`
        );
      }
      const identity = auxiliaryIdentity(reference);
      if (!known.has(identity)) {
        throw new ReliabilityAuxiliaryRegistryError(
          'unknown_reference',
          `${owner.kind}:${owner.key}@${owner.version} cites unknown ${reference.kind}:${reference.key}@${reference.version}`
        );
      }
      cited.add(identity);
    }
  }
  for (const definition of definitions) {
    const identity = auxiliaryIdentity(definition);
    if (!cited.has(identity)) {
      throw new ReliabilityAuxiliaryRegistryError(
        'orphan_definition',
        `auxiliary definition ${definition.kind}:${definition.key}@${definition.version} is not cited`
      );
    }
  }
  return cited;
}

function validateSchemas(
  definitions: readonly ReliabilityAuxiliaryDefinition[],
  registrations: readonly ReliabilitySchemaRegistration[]
): Map<string, ReliabilitySchemaRegistration> {
  const expected = new Map<string, SchemaRef>();
  for (const definition of definitions) {
    for (const schema of [definition.inputSchema, definition.outputSchema]) {
      const identity = schemaIdentity(schema);
      const existing = expected.get(identity);
      if (existing && existing.canonicalSchemaDigestSha256 !== schema.canonicalSchemaDigestSha256) {
        throw new ReliabilityAuxiliaryRegistryError(
          'schema_conflict',
          `schema ${schema.key}@${schema.version} has conflicting canonical digests`
        );
      }
      expected.set(identity, schema);
    }
  }
  const registered = new Map<string, ReliabilitySchemaRegistration>();
  for (const registration of registrations) {
    assertSchemaRef(registration.reference, 'schema registration');
    const identity = schemaIdentity(registration.reference);
    if (registered.has(identity)) {
      throw new ReliabilityAuxiliaryRegistryError('schema_conflict', `duplicate schema ${identity}`);
    }
    const required = expected.get(identity);
    if (!required) {
      throw new ReliabilityAuxiliaryRegistryError('orphan_schema', `schema ${identity} is not cited`);
    }
    if (required.canonicalSchemaDigestSha256 !== registration.reference.canonicalSchemaDigestSha256) {
      throw new ReliabilityAuxiliaryRegistryError('schema_conflict', `schema ${identity} digest differs`);
    }
    if (typeof registration.safeParse !== 'function') {
      throw new ReliabilityAuxiliaryRegistryError('schema_conflict', `schema ${identity} has no parser`);
    }
    registered.set(identity, Object.freeze({
      reference: Object.freeze({ ...registration.reference }),
      safeParse: registration.safeParse.bind(registration)
    }));
  }
  for (const identity of expected.keys()) {
    if (!registered.has(identity)) {
      throw new ReliabilityAuxiliaryRegistryError('missing_schema', `schema ${identity} is not registered`);
    }
  }
  return registered;
}

function validateImplementations(
  definitions: readonly ReliabilityAuxiliaryDefinition[],
  registrations: readonly ReliabilityAuxiliaryImplementation[]
): Map<string, ReliabilityAuxiliaryImplementation> {
  const expected = new Map<string, ReliabilityAuxiliaryDefinition[]>();
  for (const definition of definitions) {
    const identity = implementationIdentity(definition.implementation);
    const owners = expected.get(identity) ?? [];
    owners.push(definition);
    expected.set(identity, owners);
  }
  const registered = new Map<string, ReliabilityAuxiliaryImplementation>();
  for (const registration of registrations) {
    assertDefinitionRef(registration.reference, 'reliability_implementation', 'implementation registration');
    const identity = implementationIdentity(registration.reference);
    if (registered.has(identity)) {
      throw new ReliabilityAuxiliaryRegistryError(
        'implementation_mismatch',
        `duplicate implementation ${identity}`
      );
    }
    const owners = expected.get(identity);
    if (!owners) {
      throw new ReliabilityAuxiliaryRegistryError(
        'orphan_implementation',
        `implementation ${identity} is not cited`
      );
    }
    if (typeof registration.execute !== 'function' || owners.some((definition) => (
      registration.mode !== definition.mode
      || registration.canonicalImplementationDigestSha256 !== definition.implementationDigestSha256
    ))) {
      throw new ReliabilityAuxiliaryRegistryError(
        'implementation_mismatch',
        `implementation ${identity} does not match its definition`
      );
    }
    if (registration.mode === 'pure_total') {
      registered.set(identity, Object.freeze({
        reference: Object.freeze({ ...registration.reference }),
        canonicalImplementationDigestSha256: registration.canonicalImplementationDigestSha256,
        mode: 'pure_total' as const,
        execute: registration.execute.bind(registration)
      }));
    } else if (registration.mode === 'read_only') {
      registered.set(identity, Object.freeze({
        reference: Object.freeze({ ...registration.reference }),
        canonicalImplementationDigestSha256: registration.canonicalImplementationDigestSha256,
        mode: 'read_only' as const,
        execute: registration.execute.bind(registration)
      }));
    } else {
      registered.set(identity, Object.freeze({
        reference: Object.freeze({ ...registration.reference }),
        canonicalImplementationDigestSha256: registration.canonicalImplementationDigestSha256,
        mode: 'transaction_reducer' as const,
        execute: registration.execute.bind(registration)
      }));
    }
  }
  for (const [identity] of expected) {
    if (!registered.has(identity)) {
      throw new ReliabilityAuxiliaryRegistryError(
        'missing_implementation',
        `implementation ${identity} is not registered`
      );
    }
  }
  return registered;
}

export async function buildReliabilityAuxiliaryRegistry(input: {
  readonly reliability: ReliabilityRegistry;
  readonly definitions: readonly ReliabilityAuxiliaryDefinition[];
  readonly schemas: readonly ReliabilitySchemaRegistration[];
  readonly implementations: readonly ReliabilityAuxiliaryImplementation[];
}): Promise<ReliabilityAuxiliaryRegistry> {
  const definitions = input.definitions.map((definition) => canonicalClone(definition));
  const identities = new Set<string>();
  for (const definition of definitions) {
    assertAuxiliaryDefinition(definition, true);
    const identity = auxiliaryIdentity(definition);
    if (identities.has(identity)) {
      throw new ReliabilityAuxiliaryRegistryError('duplicate_definition', `duplicate ${identity}`);
    }
    identities.add(identity);
    const expectedDigest = await sha256({
      profile: RELIABILITY_AUXILIARY_DEFINITION_DIGEST_PROFILE,
      definition: auxiliaryDefinitionBody(definition)
    });
    if (expectedDigest !== definition.canonicalDigestSha256) {
      throw new ReliabilityAuxiliaryRegistryError(
        'digest_mismatch',
        `${definition.kind}:${definition.key}@${definition.version} has a noncanonical digest`
      );
    }
  }
  definitions.sort(compareAuxiliaryDefinitions);
  validateVersionChains(definitions);
  validateCitedDefinitions(input.reliability, definitions);
  const schemas = validateSchemas(definitions, input.schemas);
  const implementations = validateImplementations(definitions, input.implementations);
  const frozenDefinitions = deepFreeze(definitions);
  const catalogDigestSha256 = await sha256({
    profile: RELIABILITY_AUXILIARY_CATALOG_DIGEST_PROFILE,
    reliabilityCatalogDigestSha256: input.reliability.catalogDigestSha256,
    definitions: frozenDefinitions,
    implementations: frozenDefinitions.map((definition) => ({
      reference: definition.implementation,
      mode: definition.mode,
      canonicalImplementationDigestSha256: definition.implementationDigestSha256
    }))
  });
  const registry = deepFreeze({
    digestProfile: RELIABILITY_AUXILIARY_CATALOG_DIGEST_PROFILE,
    reliabilityCatalogDigestSha256: input.reliability.catalogDigestSha256,
    definitions: frozenDefinitions,
    catalogDigestSha256
  });
  auxiliaryRegistryStates.set(registry, {
    definitions: new Map(frozenDefinitions.map((definition) => [auxiliaryIdentity(definition), definition])),
    schemas,
    implementations
  });
  return registry;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

function capabilityView(
  expected: readonly ReliabilityCapabilityRef[],
  supplied: readonly ReliabilityRuntimeCapability[],
  mode: 'read_only' | 'transaction_reducer'
): ReliabilityReadCapabilityView | ReliabilityTransactionCapabilityView {
  if (supplied.length !== expected.length) {
    throw new ReliabilityAuxiliaryExecutionError(
      'capability_mismatch',
      'runtime capabilities do not exactly match the declared set'
    );
  }
  const values = new Map<string, unknown>();
  for (const capability of supplied) {
    const identity = capabilityIdentity(capability.reference);
    if (values.has(identity)) {
      throw new ReliabilityAuxiliaryExecutionError('capability_mismatch', 'duplicate runtime capability');
    }
    const declared = expected.find((candidate) => capabilityIdentity(candidate) === identity);
    if (
      !declared
      || declared.canonicalContractDigestSha256 !== capability.reference.canonicalContractDigestSha256
    ) {
      throw new ReliabilityAuxiliaryExecutionError('capability_mismatch', 'unknown runtime capability');
    }
    values.set(identity, capability.value);
  }
  const expectedKind = mode === 'read_only' ? 'read_capability' : 'transaction_capability';
  const references = expected.map((reference) => ({ ...reference }));
  return Object.freeze({
    references: deepFreeze(references),
    get(reference: DefinitionRef<ReliabilityCapabilityKind>) {
      if (reference.kind !== expectedKind) {
        throw new ReliabilityAuxiliaryExecutionError('capability_mismatch', 'capability mode mismatch');
      }
      const identity = capabilityIdentity(reference);
      if (!values.has(identity)) {
        throw new ReliabilityAuxiliaryExecutionError('capability_mismatch', 'capability was not declared');
      }
      return values.get(identity);
    }
  }) as ReliabilityReadCapabilityView | ReliabilityTransactionCapabilityView;
}

export async function executeReliabilityAuxiliary(
  registry: ReliabilityAuxiliaryRegistry,
  reference: DefinitionRef<ReliabilityAuxiliaryKind>,
  input: unknown,
  capabilities: readonly ReliabilityRuntimeCapability[] = []
): Promise<unknown> {
  const state = auxiliaryRegistryStates.get(registry);
  if (!state) {
    throw new ReliabilityAuxiliaryExecutionError('unknown_definition', 'unsealed auxiliary registry');
  }
  const definition = state.definitions.get(auxiliaryIdentity(reference));
  if (!definition) {
    throw new ReliabilityAuxiliaryExecutionError('unknown_definition', 'unknown auxiliary definition');
  }
  const inputSchema = state.schemas.get(schemaIdentity(definition.inputSchema));
  const outputSchema = state.schemas.get(schemaIdentity(definition.outputSchema));
  const implementation = state.implementations.get(implementationIdentity(definition.implementation));
  if (!inputSchema || !outputSchema || !implementation) {
    throw new ReliabilityAuxiliaryExecutionError('unknown_definition', 'auxiliary registry is incomplete');
  }
  let parsedInput: ReliabilitySchemaParseResult;
  try {
    parsedInput = inputSchema.safeParse(input);
  } catch (error) {
    throw new ReliabilityAuxiliaryExecutionError('invalid_input', 'auxiliary input is invalid', error);
  }
  if (!parsedInput.success) {
    throw new ReliabilityAuxiliaryExecutionError('invalid_input', 'auxiliary input is invalid');
  }
  let frozenInput: unknown;
  try {
    frozenInput = deepFreeze(canonicalClone(parsedInput.data));
  } catch (error) {
    throw new ReliabilityAuxiliaryExecutionError(
      'invalid_input',
      'auxiliary input is not canonical JSON',
      error
    );
  }
  let candidate: unknown;
  try {
    if (implementation.mode === 'pure_total') {
      if (capabilities.length !== 0) {
        throw new ReliabilityAuxiliaryExecutionError(
          'capability_mismatch',
          'pure-total implementation received a capability'
        );
      }
      candidate = implementation.execute(frozenInput);
      if (isPromiseLike(candidate)) {
        throw new ReliabilityAuxiliaryExecutionError(
          'async_pure_implementation',
          'pure-total implementation returned a promise'
        );
      }
    } else if (implementation.mode === 'read_only') {
      candidate = await implementation.execute(
        frozenInput,
        capabilityView(definition.capabilities, capabilities, 'read_only') as ReliabilityReadCapabilityView
      );
    } else {
      candidate = await implementation.execute(
        frozenInput,
        capabilityView(
          definition.capabilities,
          capabilities,
          'transaction_reducer'
        ) as ReliabilityTransactionCapabilityView
      );
    }
  } catch (error) {
    if (error instanceof ReliabilityAuxiliaryExecutionError) throw error;
    throw new ReliabilityAuxiliaryExecutionError(
      'implementation_failed',
      'auxiliary implementation failed',
      error
    );
  }
  let parsedOutput: ReliabilitySchemaParseResult;
  try {
    parsedOutput = outputSchema.safeParse(candidate);
  } catch (error) {
    throw new ReliabilityAuxiliaryExecutionError('invalid_output', 'auxiliary output is invalid', error);
  }
  if (!parsedOutput.success) {
    throw new ReliabilityAuxiliaryExecutionError('invalid_output', 'auxiliary output is invalid');
  }
  try {
    return deepFreeze(canonicalClone(parsedOutput.data));
  } catch (error) {
    throw new ReliabilityAuxiliaryExecutionError(
      'invalid_output',
      'auxiliary output is not canonical JSON',
      error
    );
  }
}

export function resolveReliabilityAuxiliaryDefinition(
  registry: ReliabilityAuxiliaryRegistry,
  reference: DefinitionRef<ReliabilityAuxiliaryKind>
): ReliabilityAuxiliaryDefinition | undefined {
  return auxiliaryRegistryStates.get(registry)?.definitions.get(auxiliaryIdentity(reference));
}
