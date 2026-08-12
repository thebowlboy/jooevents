import {
  parseCapabilityRevisionId,
  parseContractVersion,
  type Brand,
  type CapabilityRevisionId,
  type ContractVersion
} from '@jooevents/kernel';

export const RELIABILITY_KINDS = [
  'domain_fact',
  'effect',
  'consumer',
  'job',
  'activity_projection'
] as const;

export type ReliabilityKind = (typeof RELIABILITY_KINDS)[number];

export const ACTIVITY_SOURCE_KINDS = [
  'receipt',
  'audit',
  'domain_fact',
  'model_run',
  'job',
  'effect'
] as const;

export type ActivitySourceKind = (typeof ACTIVITY_SOURCE_KINDS)[number];
export type CanonicalSha256 = Brand<string, 'CanonicalSha256'>;
export type DefinitionKey = Brand<string, 'ReliabilityDefinitionKey'>;

const DEFINITION_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function parseDefinitionKey(value: unknown): DefinitionKey {
  if (
    typeof value !== 'string' ||
    value !== value.normalize('NFC') ||
    value.length > 160 ||
    !DEFINITION_KEY.test(value)
  ) {
    throw new TypeError('definition key must be a canonical lowercase dotted identifier');
  }
  return value as DefinitionKey;
}

export function parseCanonicalSha256(value: unknown): CanonicalSha256 {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new TypeError('canonical SHA-256 must be 64 lowercase hexadecimal characters');
  }
  return value as CanonicalSha256;
}

export interface DefinitionRef<Kind extends string = string> {
  readonly kind: Kind;
  readonly key: DefinitionKey;
  readonly version: ContractVersion;
}

export function definitionRef<const Kind extends string>(
  kind: Kind,
  key: string,
  version: number
): DefinitionRef<Kind> {
  return Object.freeze({
    kind,
    key: parseDefinitionKey(key),
    version: parseContractVersion(version)
  });
}

export interface SchemaRef {
  readonly key: DefinitionKey;
  readonly version: ContractVersion;
  readonly canonicalSchemaDigestSha256: CanonicalSha256;
}

export function schemaRef(
  key: string,
  version: number,
  canonicalSchemaDigestSha256: string
): SchemaRef {
  return Object.freeze({
    key: parseDefinitionKey(key),
    version: parseContractVersion(version),
    canonicalSchemaDigestSha256: parseCanonicalSha256(canonicalSchemaDigestSha256)
  });
}

export interface OperationProducerRef {
  readonly kind: 'operation';
  readonly operation: DefinitionRef<'operation'>;
}

export interface ChangesetOperationProducerRef {
  readonly kind: 'changeset_operation';
  readonly operation: DefinitionRef<'changeset_operation'>;
}

/** Every producer citation is an exact key and positive version, never a floating name. */
export type ProducerRef = OperationProducerRef | ChangesetOperationProducerRef;

export type ConsumerSourceRef =
  | DefinitionRef<'domain_fact'>
  | DefinitionRef<'effect'>
  | DefinitionRef<'job'>;

/**
 * A job may be requested by a verified inbox receipt without making that receipt a
 * consumer source or pretending it is a fact/another job.
 */
export type JobSourceRef = ConsumerSourceRef | DefinitionRef<'inbox_receipt'>;

export type ActivitySourceRef = {
  readonly [Kind in ActivitySourceKind]: DefinitionRef<Kind>;
}[ActivitySourceKind];

interface DefinitionBase<Kind extends ReliabilityKind> {
  readonly kind: Kind;
  readonly key: DefinitionKey;
  readonly version: ContractVersion;
  readonly canonicalDigestSha256: CanonicalSha256;
}

export interface DomainFactDefinition extends DefinitionBase<'domain_fact'> {
  readonly metadataSchema: SchemaRef;
  readonly producers: readonly ProducerRef[];
  readonly aggregateKind: DefinitionKey;
  readonly subjectIdentity: DefinitionRef<'subject_identity'>;
  readonly scope: DefinitionRef<'scope'>;
  readonly causalParent: DefinitionRef<'causal_parent'>;
  readonly consumerCompatibility: DefinitionRef<'consumer_compatibility'>;
  readonly classifiedPayloadPaths: readonly string[];
  readonly redaction: DefinitionRef<'redaction'>;
}

export interface EffectDefinition extends DefinitionBase<'effect'> {
  readonly specificationSchema: SchemaRef;
  readonly providerAttemptSchema: SchemaRef;
  readonly producers: readonly ProducerRef[];
  readonly targetJob: DefinitionRef<'job'>;
  readonly reducer: DefinitionRef<'reducer'>;
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly retry: DefinitionRef<'retry'>;
  readonly cancellation: DefinitionRef<'cancellation'>;
}

export const CONSUMER_OUTPUT_KINDS = [
  'projection',
  'job_request',
  'application_operation'
] as const;

export type ConsumerOutputKind = (typeof CONSUMER_OUTPUT_KINDS)[number];

export interface ConsumerDefinition extends DefinitionBase<'consumer'> {
  readonly acceptedSources: readonly ConsumerSourceRef[];
  readonly inputSchema: SchemaRef;
  readonly resultSchema: SchemaRef;
  readonly inputProjection: DefinitionRef<'input_projection'>;
  readonly targetOperation: DefinitionRef<'operation'>;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly maximumAttempts: number;
  readonly leaseDurationMs: number;
  readonly backoff: DefinitionRef<'backoff'>;
  readonly outputKind: ConsumerOutputKind;
  readonly replay: DefinitionRef<'replay'>;
  readonly removal: DefinitionRef<'removal'>;
}

export const EXTERNAL_RETRY_POLICIES = ['forbidden', 'anchor_inspection_only'] as const;
export type ExternalRetryPolicy = (typeof EXTERNAL_RETRY_POLICIES)[number];

export interface JobDefinition extends DefinitionBase<'job'> {
  readonly inputSchema: SchemaRef;
  readonly resultSchema: SchemaRef;
  readonly errorDetailSchema: SchemaRef;
  readonly source: DefinitionRef<'source'>;
  readonly scopeCausation: DefinitionRef<'scope_causation'>;
  readonly inputProjection: DefinitionRef<'input_projection'>;
  readonly targetOperation: DefinitionRef<'operation'>;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly leaseDurationMs: number;
  readonly maximumAttempts: number;
  readonly backoff: DefinitionRef<'backoff'>;
  readonly timeoutMs: number;
  readonly cancellation: DefinitionRef<'cancellation'>;
  readonly externalRetryPolicy: ExternalRetryPolicy;
}

export interface ActivityProjectionDefinition extends DefinitionBase<'activity_projection'> {
  readonly acceptedSources: readonly ActivitySourceRef[];
  readonly inputSchema: SchemaRef;
  readonly itemSchema: SchemaRef;
  readonly viewerAuthorization: DefinitionRef<'viewer_authorization'>;
  readonly redaction: DefinitionRef<'redaction'>;
  readonly destination: DefinitionRef<'destination'>;
  readonly projector: DefinitionRef<'activity_projector'>;
}

export type ReliabilityDefinition =
  | DomainFactDefinition
  | EffectDefinition
  | ConsumerDefinition
  | JobDefinition
  | ActivityProjectionDefinition;

export type ReliabilityDefinitionDraft = ReliabilityDefinition extends infer Definition
  ? Definition extends ReliabilityDefinition
    ? Omit<Definition, 'canonicalDigestSha256'>
    : never
  : never;

export const RELIABILITY_LIMITS = Object.freeze({
  maximumAttempts: 100,
  maximumLeaseDurationMs: 86_400_000,
  maximumJobTimeoutMs: 86_400_000,
  maximumAcceptedSources: 256,
  maximumProducers: 256,
  maximumClassifiedPayloadPaths: 256
} as const);

export function assertCapabilityRevisionId(value: unknown): CapabilityRevisionId {
  return parseCapabilityRevisionId(value);
}
