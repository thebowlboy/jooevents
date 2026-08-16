import {
  canonicalJsonText,
  canonicalJsonValue,
  isApplicationId,
  parseAgentRunId,
  parseAggregateVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseCeremonyEvidenceId,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseContractVersion,
  parseDomainFactId,
  parseEffectSpecificationId,
  parseEventId,
  parseIntegrationInboxReceiptId,
  parseInstant,
  parseJobId,
  parseModelAttemptId,
  parseModelToolCallId,
  parseOperationReceiptId,
  parseOutboxPointerId,
  parseParticipantIdentityId,
  parsePayloadRefId,
  parsePersonId,
  parsePublicPolicyRevisionId,
  parseServiceIdentityId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseUserId,
  parseVerifiedEnvelopeHandleId,
  parseVerifierRevisionId,
  parseWorkspaceId,
  type ActorRef,
  type AggregateVersion,
  type AuthorityCitationId,
  type CapabilityRevisionId,
  type ContractVersion,
  type DomainFactId,
  type EffectSpecificationId,
  type Instant,
  type OperationReceiptId,
  type OutboxPointerId,
  type PayloadRef,
  type ScopeRef,
  type SubjectRef
} from '@jooevents/kernel';
import {
  definitionRef,
  parseCanonicalSha256,
  parseDefinitionKey,
  type CanonicalSha256,
  type DefinitionKey,
  type DefinitionRef,
  type DomainFactDefinition,
  type EffectDefinition,
  type JobDefinition,
  type ProducerRef,
  type ReliabilityDefinitionDraft,
  type SchemaRef
} from './definitions';
import {
  digestReliabilityDefinition,
  resolveReliabilityDefinition,
  type ReliabilityRegistry
} from './registry';

const safeReferenceKinds = ['entity', 'purpose', 'destination', 'policy', 'guard'] as const;
const maximumSafeReferences = 100;
const maximumClassifiedPayloadRefs = 100;
const maximumSubjects = 100;

export type ReliabilitySafeReferenceKind = (typeof safeReferenceKinds)[number];

export interface ReliabilitySafeReference {
  readonly kind: ReliabilitySafeReferenceKind;
  readonly key: DefinitionKey;
  readonly version: ContractVersion;
  readonly opaqueId?: string;
}

export interface ReliabilitySafeInput {
  readonly safeReferences: readonly ReliabilitySafeReference[];
  readonly classifiedPayloadRefs: readonly PayloadRef[];
}

export type ReliabilityContributionCausation = {
  readonly kind: 'operation_receipt';
  readonly receiptId: OperationReceiptId;
};

declare const contributionContextBrand: unique symbol;

export interface SealedReliabilityContributionContext extends Readonly<Record<string, unknown>> {
  readonly producer: ProducerRef;
  readonly occurredAt: Instant;
  readonly actor: ActorRef;
  readonly scope: ScopeRef;
  readonly subjects: readonly SubjectRef[];
  readonly causation: ReliabilityContributionCausation;
  readonly [contributionContextBrand]: true;
}

export interface ExactReliabilityDefinitionBinding<Kind extends 'domain_fact' | 'effect' | 'job'> {
  readonly reference: DefinitionRef<Kind>;
  readonly canonicalDigestSha256: CanonicalSha256;
}

export interface DomainFactAggregatePlan {
  readonly kind: DefinitionKey;
  readonly id: string;
  readonly priorVersion: number;
  readonly sequence: number;
  readonly resultingVersion: AggregateVersion;
}

export interface DomainFactContributionPlan {
  readonly recordKind: 'domain_fact_plan';
  readonly id: DomainFactId;
  readonly context: SealedReliabilityContributionContext;
  readonly definition: ExactReliabilityDefinitionBinding<'domain_fact'>;
  readonly metadataSchema: SchemaRef;
  readonly aggregate: DomainFactAggregatePlan;
  readonly input: ReliabilitySafeInput;
}

declare const effectAuthorizationEvidenceBrand: unique symbol;

export interface SealedEffectAuthorizationEvidence extends Readonly<Record<string, unknown>> {
  readonly effect: ExactReliabilityDefinitionBinding<'effect'>;
  readonly targetJob: ExactReliabilityDefinitionBinding<'job'>;
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly authorityCitationId: AuthorityCitationId;
  readonly context: SealedReliabilityContributionContext;
  readonly [effectAuthorizationEvidenceBrand]: true;
}

export interface EffectSpecificationContributionPlan {
  readonly recordKind: 'effect_specification_plan';
  readonly id: EffectSpecificationId;
  readonly context: SealedReliabilityContributionContext;
  readonly definition: ExactReliabilityDefinitionBinding<'effect'>;
  readonly specificationSchema: SchemaRef;
  readonly providerAttemptSchema: SchemaRef;
  readonly authorization: {
    readonly definition: DefinitionRef<'authority_citation'>;
    readonly id: AuthorityCitationId;
  };
  readonly targetJob: ExactReliabilityDefinitionBinding<'job'> & {
    readonly targetOperation: DefinitionRef<'operation'>;
    readonly capabilityRevisionId: CapabilityRevisionId;
    readonly authorityCitation: DefinitionRef<'authority_citation'>;
  };
  readonly input: ReliabilitySafeInput;
}

export interface ReliabilityOutboxPointerPlan {
  readonly id: OutboxPointerId;
  readonly source:
    | { readonly kind: 'domain_fact'; readonly id: DomainFactId }
    | { readonly kind: 'effect_specification'; readonly id: EffectSpecificationId };
  readonly targetJob?: ExactReliabilityDefinitionBinding<'job'>;
}

export interface ReliabilityTimelinePlan {
  readonly id: string;
  readonly source:
    | { readonly kind: 'domain_fact'; readonly id: DomainFactId }
    | { readonly kind: 'effect_specification'; readonly id: EffectSpecificationId }
    | { readonly kind: 'outbox_pointer'; readonly id: OutboxPointerId };
  readonly kind: DefinitionRef<'domain_fact' | 'effect' | 'outbox_pointer'>;
  readonly definitionDigestSha256?: CanonicalSha256;
  readonly context: SealedReliabilityContributionContext;
}

export interface SealedReliabilityContribution extends Readonly<Record<string, unknown>> {
  readonly recordKind: 'reliability_contribution';
  readonly context: SealedReliabilityContributionContext;
  readonly fact: DomainFactContributionPlan;
  readonly effect?: EffectSpecificationContributionPlan;
  readonly pointers: readonly ReliabilityOutboxPointerPlan[];
  readonly timeline: readonly ReliabilityTimelinePlan[];
}

export interface DomainFactContributionPlanner {
  readonly definition: ExactReliabilityDefinitionBinding<'domain_fact'>;
  readonly producer: ProducerRef;
  plan(input: {
    readonly context: SealedReliabilityContributionContext;
    readonly aggregate: {
      readonly id: string;
      readonly priorVersion: number;
      readonly sequence: number;
      readonly resultingVersion: number;
    };
    readonly input: ReliabilitySafeInput;
  }): DomainFactContributionPlan;
}

export interface EffectAuthorityCitationVerifier {
  isTrusted(input: {
    readonly definition: DefinitionRef<'authority_citation'>;
    readonly citationId: AuthorityCitationId;
    readonly effect: ExactReliabilityDefinitionBinding<'effect'>;
    readonly targetJob: ExactReliabilityDefinitionBinding<'job'>;
    readonly context: SealedReliabilityContributionContext;
  }): boolean | Promise<boolean>;
}

export interface EffectSpecificationContributionPlanner {
  readonly definition: ExactReliabilityDefinitionBinding<'effect'>;
  readonly targetJob: ExactReliabilityDefinitionBinding<'job'>;
  readonly producer: ProducerRef;
  authorize(input: {
    readonly context: SealedReliabilityContributionContext;
    readonly authorityCitation: DefinitionRef<'authority_citation'>;
    readonly authorityCitationId: AuthorityCitationId;
  }): Promise<SealedEffectAuthorizationEvidence>;
  plan(input: {
    readonly context: SealedReliabilityContributionContext;
    readonly authorization: SealedEffectAuthorizationEvidence;
    readonly input: ReliabilitySafeInput;
  }): EffectSpecificationContributionPlan;
}

export class ReliabilityContributionError extends Error {
  constructor(
    readonly code:
      | 'invalid_context'
      | 'invalid_safe_input'
      | 'unknown_definition'
      | 'definition_digest_mismatch'
      | 'producer_mismatch'
      | 'target_job_mismatch'
      | 'authority_citation_mismatch'
      | 'untrusted_authority_citation'
      | 'unsealed_authorization'
      | 'contribution_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'ReliabilityContributionError';
  }
}

const sealedContributionContexts = new WeakSet<object>();
const sealedFactPlans = new WeakSet<object>();
const sealedEffectAuthorizationEvidence = new WeakMap<object, {
  readonly plannerToken: object;
  readonly context: SealedReliabilityContributionContext;
}>();
const sealedEffectPlans = new WeakSet<object>();
const sealedContributions = new WeakSet<object>();

function fail(code: ReliabilityContributionError['code'], message: string): never {
  throw new ReliabilityContributionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sameRef(
  left: { readonly kind: string; readonly key: string; readonly version: number },
  right: { readonly kind: string; readonly key: string; readonly version: number }
): boolean {
  return left.kind === right.kind && left.key === right.key && left.version === right.version;
}

function sameProducer(left: ProducerRef, right: ProducerRef): boolean {
  return left.kind === right.kind && sameRef(left.operation, right.operation);
}

function parseProducer(value: unknown): ProducerRef {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'operation'])
    || value.kind !== 'operation'
    || !isRecord(value.operation)
    || !exactKeys(value.operation, ['kind', 'key', 'version'])
    || value.operation.kind !== value.kind) {
    return fail('invalid_context', 'The contribution producer is not an exact operation version.');
  }
  return deepFreeze({
    kind: value.kind,
    operation: definitionRef(value.kind, String(value.operation.key), Number(value.operation.version))
  }) as ProducerRef;
}

function boundedString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value !== value.normalize('NFC')) {
    return fail('invalid_context', `${label} is not a bounded canonical string.`);
  }
  return value;
}

function parseActor(value: unknown): ActorRef {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return fail('invalid_context', 'The timeline actor is invalid.');
  }
  try {
    switch (value.kind) {
      case 'workspace_user':
        if (!exactKeys(value, ['kind', 'userId'])) throw new TypeError();
        return { kind: value.kind, userId: parseUserId(value.userId) };
      case 'participant':
        if (!exactKeys(value, ['kind', 'participantIdentityId', 'personId'])) throw new TypeError();
        return {
          kind: value.kind,
          participantIdentityId: parseParticipantIdentityId(value.participantIdentityId),
          personId: parsePersonId(value.personId)
        };
      case 'service':
        if (!exactKeys(value, ['kind', 'serviceIdentityId'])) throw new TypeError();
        return { kind: value.kind, serviceIdentityId: parseServiceIdentityId(value.serviceIdentityId) };
      case 'external_mcp_client':
        if (!exactKeys(value, ['kind', 'oauthClientId', 'authorityPrincipalId'])) throw new TypeError();
        return {
          kind: value.kind,
          oauthClientId: boundedString(value.oauthClientId, 'oauth client id'),
          authorityPrincipalId: boundedString(value.authorityPrincipalId, 'authority principal id')
        };
      case 'app_model_run':
        if (!exactKeys(value, ['kind', 'agentRunId', 'delegatedByPrincipalId'])) throw new TypeError();
        return {
          kind: value.kind,
          agentRunId: parseAgentRunId(value.agentRunId),
          delegatedByPrincipalId: boundedString(value.delegatedByPrincipalId, 'delegated principal id')
        };
      case 'system_job':
        if (!exactKeys(value, ['kind', 'jobId', 'registeredCapabilityRevisionId'])) throw new TypeError();
        return {
          kind: value.kind,
          jobId: parseJobId(value.jobId),
          registeredCapabilityRevisionId: parseCapabilityRevisionId(value.registeredCapabilityRevisionId)
        };
      case 'system_consumer_delivery':
        if (!exactKeys(value, ['kind', 'consumerDeliveryId', 'consumerAttemptId', 'consumerKey', 'consumerVersion'])) throw new TypeError();
        return {
          kind: value.kind,
          consumerDeliveryId: parseConsumerDeliveryId(value.consumerDeliveryId),
          consumerAttemptId: parseConsumerAttemptId(value.consumerAttemptId),
          consumerKey: boundedString(value.consumerKey, 'consumer key', 160),
          consumerVersion: parseContractVersion(value.consumerVersion)
        };
      case 'system_scheduler':
        if (!exactKeys(value, ['kind', 'schedulerKey', 'schedulerVersion', 'registeredCapabilityRevisionId'])) throw new TypeError();
        return {
          kind: value.kind,
          schedulerKey: boundedString(value.schedulerKey, 'scheduler key', 160),
          schedulerVersion: parseContractVersion(value.schedulerVersion),
          registeredCapabilityRevisionId: parseCapabilityRevisionId(value.registeredCapabilityRevisionId)
        };
      case 'verified_ingress_intake':
        if (!exactKeys(value, [
          'kind', 'verifiedEnvelopeHandleId', 'sourceConnectionId', 'sourceConnectionRevisionId',
          'verifierContractKey', 'verifierContractVersion', 'verifierRevisionId'
        ])) throw new TypeError();
        return {
          kind: value.kind,
          verifiedEnvelopeHandleId: parseVerifiedEnvelopeHandleId(value.verifiedEnvelopeHandleId),
          sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId),
          sourceConnectionRevisionId: parseSourceConnectionRevisionId(value.sourceConnectionRevisionId),
          verifierContractKey: boundedString(value.verifierContractKey, 'verifier contract key', 160),
          verifierContractVersion: parseContractVersion(value.verifierContractVersion),
          verifierRevisionId: parseVerifierRevisionId(value.verifierRevisionId)
        };
      case 'verified_inbox_processing':
        if (!exactKeys(value, ['kind', 'inboxReceiptId', 'sourceConnectionId'])) throw new TypeError();
        return {
          kind: value.kind,
          inboxReceiptId: parseIntegrationInboxReceiptId(value.inboxReceiptId),
          sourceConnectionId: parseSourceConnectionId(value.sourceConnectionId)
        };
      case 'public_request': {
        if (!exactKeys(value, ['kind', 'publicPolicyRevisionId', 'authority']) || !isRecord(value.authority)) throw new TypeError();
        const authority = value.authority;
        if (authority.kind === 'open_policy' && exactKeys(authority, ['kind'])) {
          return {
            kind: value.kind,
            publicPolicyRevisionId: parsePublicPolicyRevisionId(value.publicPolicyRevisionId),
            authority: { kind: 'open_policy' }
          };
        }
        if (authority.kind === 'mutation_ceremony' && exactKeys(authority, ['kind', 'ceremonyEvidenceId'])) {
          return {
            kind: value.kind,
            publicPolicyRevisionId: parsePublicPolicyRevisionId(value.publicPolicyRevisionId),
            authority: {
              kind: 'mutation_ceremony',
              ceremonyEvidenceId: parseCeremonyEvidenceId(authority.ceremonyEvidenceId)
            }
          };
        }
        throw new TypeError();
      }
      default:
        throw new TypeError();
    }
  } catch {
    return fail('invalid_context', 'The timeline actor is invalid.');
  }
}

function parseScope(value: unknown): ScopeRef {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return fail('invalid_context', 'The contribution scope is invalid.');
  }
  try {
    if (value.kind === 'workspace' && exactKeys(value, ['kind', 'workspaceId'])) {
      return { kind: 'workspace', workspaceId: parseWorkspaceId(value.workspaceId) };
    }
    if (value.kind === 'event' && exactKeys(value, ['kind', 'workspaceId', 'eventId'])) {
      return {
        kind: 'event',
        workspaceId: parseWorkspaceId(value.workspaceId),
        eventId: parseEventId(value.eventId)
      };
    }
  } catch {
    // normalized below
  }
  return fail('invalid_context', 'The contribution scope is invalid.');
}

function parseSubject(value: unknown): SubjectRef {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return fail('invalid_context', 'A timeline subject is invalid.');
  }
  try {
    if (value.kind === 'workspace' && exactKeys(value, ['kind', 'id'])) {
      return { kind: value.kind, id: parseWorkspaceId(value.id) };
    }
    if (value.kind === 'event' && exactKeys(value, ['kind', 'id'])) {
      return { kind: value.kind, id: parseEventId(value.id) };
    }
    if (value.kind === 'workspace_user' && exactKeys(value, ['kind', 'id'])) {
      return { kind: value.kind, id: parseUserId(value.id) };
    }
    if (value.kind === 'participant_person' && exactKeys(value, ['kind', 'id'])) {
      return { kind: value.kind, id: parsePersonId(value.id) };
    }
    if (value.kind === 'domain' && exactKeys(value, ['kind', 'domain', 'entity', 'id'], ['version'])
      && isApplicationId(value.id)) {
      return {
        kind: value.kind,
        domain: parseDefinitionKey(value.domain),
        entity: parseDefinitionKey(value.entity),
        id: value.id,
        ...(value.version === undefined ? {} : { version: parseAggregateVersion(value.version) })
      };
    }
  } catch {
    // normalized below
  }
  return fail('invalid_context', 'A timeline subject is invalid.');
}

function parseCausation(value: unknown, producer: ProducerRef): ReliabilityContributionCausation {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return fail('invalid_context', 'Contribution causation is required.');
  }
  try {
    if (producer.kind === 'operation' && value.kind === 'operation_receipt'
      && exactKeys(value, ['kind', 'receiptId'])) {
      return { kind: value.kind, receiptId: parseOperationReceiptId(value.receiptId) };
    }
  } catch {
    // normalized below
  }
  return fail('invalid_context', 'Contribution causation does not match the exact producer.');
}

export function sealReliabilityContributionContext(input: {
  readonly producer: ProducerRef;
  readonly occurredAt: Instant;
  readonly actor: ActorRef;
  readonly scope: ScopeRef;
  readonly subjects: readonly SubjectRef[];
  readonly causation: ReliabilityContributionCausation;
}): SealedReliabilityContributionContext {
  if (!isRecord(input) || !exactKeys(input, [
    'producer', 'occurredAt', 'actor', 'scope', 'subjects', 'causation'
  ]) || !Array.isArray(input.subjects) || input.subjects.length === 0
    || input.subjects.length > maximumSubjects) {
    return fail('invalid_context', 'The contribution context is not exact and bounded.');
  }
  const producer = parseProducer(input.producer);
  const scope = parseScope(input.scope);
  const subjects = input.subjects.map(parseSubject);
  if (!subjects.some((subject) => subject.kind === 'workspace' && subject.id === scope.workspaceId)
    || (scope.kind === 'event'
      && !subjects.some((subject) => subject.kind === 'event' && subject.id === scope.eventId))) {
    return fail('invalid_context', 'Timeline subjects do not cover the trusted scope.');
  }
  const context = deepFreeze({
    producer,
    occurredAt: parseInstant(input.occurredAt),
    actor: parseActor(input.actor),
    scope,
    subjects,
    causation: parseCausation(input.causation, producer)
  }) as unknown as SealedReliabilityContributionContext;
  sealedContributionContexts.add(context);
  return context;
}

export function isSealedReliabilityContributionContext(
  value: unknown
): value is SealedReliabilityContributionContext {
  return isRecord(value) && sealedContributionContexts.has(value);
}

function parseSafeInput(value: unknown): ReliabilitySafeInput {
  if (!isRecord(value) || !exactKeys(value, ['safeReferences', 'classifiedPayloadRefs'])
    || !Array.isArray(value.safeReferences)
    || value.safeReferences.length > maximumSafeReferences
    || !Array.isArray(value.classifiedPayloadRefs)
    || value.classifiedPayloadRefs.length > maximumClassifiedPayloadRefs) {
    return fail('invalid_safe_input', 'Reliability input must contain only bounded safe and classified references.');
  }
  const safeReferences = value.safeReferences.map((reference) => {
    if (!isRecord(reference) || !exactKeys(reference, ['kind', 'key', 'version'], ['opaqueId'])
      || !safeReferenceKinds.includes(reference.kind as ReliabilitySafeReferenceKind)
      || (reference.opaqueId !== undefined && !isApplicationId(reference.opaqueId))) {
      return fail('invalid_safe_input', 'A reliability safe reference is invalid.');
    }
    return {
      kind: reference.kind as ReliabilitySafeReferenceKind,
      key: parseDefinitionKey(reference.key),
      version: parseContractVersion(reference.version),
      ...(reference.opaqueId === undefined ? {} : { opaqueId: reference.opaqueId })
    };
  }).sort((left, right) => canonicalJsonText(left).localeCompare(canonicalJsonText(right)));
  const classifiedPayloadRefs = value.classifiedPayloadRefs.map((reference) => {
    if (!isRecord(reference) || !exactKeys(reference, ['id'])) {
      return fail('invalid_safe_input', 'A classified payload reference is invalid.');
    }
    return { id: parsePayloadRefId(reference.id) };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(safeReferences.map(canonicalJsonText)).size !== safeReferences.length
    || new Set(classifiedPayloadRefs.map((reference) => reference.id)).size !== classifiedPayloadRefs.length) {
    return fail('invalid_safe_input', 'Reliability references must be unique.');
  }
  return deepFreeze({ safeReferences, classifiedPayloadRefs });
}

function binding<Kind extends 'domain_fact' | 'effect' | 'job'>(
  definition: { readonly kind: Kind; readonly key: DefinitionKey; readonly version: ContractVersion; readonly canonicalDigestSha256: CanonicalSha256 }
): ExactReliabilityDefinitionBinding<Kind> {
  return deepFreeze({
    reference: definitionRef(definition.kind, definition.key, definition.version),
    canonicalDigestSha256: definition.canonicalDigestSha256
  });
}

async function exactDefinition<Kind extends 'domain_fact' | 'effect' | 'job'>(
  registry: ReliabilityRegistry,
  expected: ExactReliabilityDefinitionBinding<Kind>,
  kind: Kind
): Promise<Extract<DomainFactDefinition | EffectDefinition | JobDefinition, { readonly kind: Kind }>> {
  const resolved = resolveReliabilityDefinition(registry, expected.reference) as
    | DomainFactDefinition
    | EffectDefinition
    | JobDefinition
    | undefined;
  if (!resolved || resolved.kind !== kind) {
    return fail('unknown_definition', `Unknown ${kind} definition ${expected.reference.key}@${expected.reference.version}.`);
  }
  const { canonicalDigestSha256, ...draft } = resolved;
  const recomputed = await digestReliabilityDefinition(draft as ReliabilityDefinitionDraft);
  if (canonicalDigestSha256 !== expected.canonicalDigestSha256
    || recomputed !== canonicalDigestSha256) {
    return fail('definition_digest_mismatch', `${kind} definition digest does not match.`);
  }
  return resolved as Extract<DomainFactDefinition | EffectDefinition | JobDefinition, { readonly kind: Kind }>;
}

function assertPlannerContext(
  context: SealedReliabilityContributionContext,
  producer: ProducerRef
): void {
  if (!isSealedReliabilityContributionContext(context) || !sameProducer(context.producer, producer)) {
    fail('producer_mismatch', 'The sealed context producer does not match the planner producer.');
  }
}

export async function createDomainFactContributionPlanner(input: {
  readonly registry: ReliabilityRegistry;
  readonly definition: ExactReliabilityDefinitionBinding<'domain_fact'>;
  readonly producer: ProducerRef;
  readonly newFactId: () => DomainFactId;
}): Promise<DomainFactContributionPlanner> {
  const definition = await exactDefinition(input.registry, input.definition, 'domain_fact');
  const producer = parseProducer(input.producer);
  if (!definition.producers.some((candidate) => sameProducer(candidate, producer))) {
    return fail('producer_mismatch', 'The fact definition does not declare this exact producer version.');
  }
  const exactBinding = binding(definition);
  const planner: DomainFactContributionPlanner = deepFreeze({
    definition: exactBinding,
    producer,
    plan(candidate) {
      if (!isRecord(candidate) || !exactKeys(candidate, ['context', 'aggregate', 'input'])
        || !isRecord(candidate.aggregate)
        || !exactKeys(candidate.aggregate, ['id', 'priorVersion', 'sequence', 'resultingVersion'])) {
        return fail('contribution_mismatch', 'The fact plan input is not exact.');
      }
      assertPlannerContext(candidate.context, producer);
      if (!isApplicationId(candidate.aggregate.id)
        || !Number.isSafeInteger(candidate.aggregate.priorVersion)
        || candidate.aggregate.priorVersion < 0
        || !Number.isSafeInteger(candidate.aggregate.sequence)
        || candidate.aggregate.sequence <= 0
        || candidate.aggregate.resultingVersion !== candidate.aggregate.priorVersion + 1) {
        return fail('contribution_mismatch', 'Fact aggregate sequence/version material is invalid.');
      }
      const plan = deepFreeze({
        recordKind: 'domain_fact_plan' as const,
        id: parseDomainFactId(input.newFactId()),
        context: candidate.context,
        definition: exactBinding,
        metadataSchema: { ...definition.metadataSchema },
        aggregate: {
          kind: definition.aggregateKind,
          id: candidate.aggregate.id,
          priorVersion: candidate.aggregate.priorVersion,
          sequence: candidate.aggregate.sequence,
          resultingVersion: parseAggregateVersion(candidate.aggregate.resultingVersion)
        },
        input: parseSafeInput(candidate.input)
      });
      sealedFactPlans.add(plan);
      return plan;
    }
  });
  return planner;
}

export async function createEffectSpecificationContributionPlanner(input: {
  readonly registry: ReliabilityRegistry;
  readonly definition: ExactReliabilityDefinitionBinding<'effect'>;
  readonly targetJob: ExactReliabilityDefinitionBinding<'job'>;
  readonly producer: ProducerRef;
  readonly authorityCitation: DefinitionRef<'authority_citation'>;
  readonly citationVerifier: EffectAuthorityCitationVerifier;
  readonly newEffectSpecificationId: () => EffectSpecificationId;
}): Promise<EffectSpecificationContributionPlanner> {
  const definition = await exactDefinition(input.registry, input.definition, 'effect');
  const job = await exactDefinition(input.registry, input.targetJob, 'job');
  const producer = parseProducer(input.producer);
  if (!definition.producers.some((candidate) => sameProducer(candidate, producer))) {
    return fail('producer_mismatch', 'The effect definition does not declare this exact producer version.');
  }
  if (!sameRef(definition.targetJob, job)) {
    return fail('target_job_mismatch', 'The effect does not map to the exact registered job definition.');
  }
  if (!sameRef(definition.authorityCitation, input.authorityCitation)) {
    return fail('authority_citation_mismatch', 'The effect authority-citation definition does not match.');
  }
  const exactEffect = binding(definition);
  const exactJob = binding(job);
  const plannerToken = Object.freeze({});
  const planner: EffectSpecificationContributionPlanner = deepFreeze({
    definition: exactEffect,
    targetJob: exactJob,
    producer,
    async authorize(candidate) {
      if (!isRecord(candidate) || !exactKeys(candidate, [
        'context', 'authorityCitation', 'authorityCitationId'
      ])) {
        return fail('authority_citation_mismatch', 'Effect authority evidence is not exact.');
      }
      assertPlannerContext(candidate.context, producer);
      if (!sameRef(candidate.authorityCitation, definition.authorityCitation)) {
        return fail('authority_citation_mismatch', 'Effect authority evidence cites another definition.');
      }
      const authorityCitationId = parseAuthorityCitationId(candidate.authorityCitationId);
      const trusted = await input.citationVerifier.isTrusted({
        definition: definition.authorityCitation,
        citationId: authorityCitationId,
        effect: exactEffect,
        targetJob: exactJob,
        context: candidate.context
      });
      if (!trusted) {
        return fail('untrusted_authority_citation', 'The authority citation is not trusted for this effect.');
      }
      const evidence = deepFreeze({
        effect: exactEffect,
        targetJob: exactJob,
        authorityCitation: { ...definition.authorityCitation },
        authorityCitationId,
        context: candidate.context
      }) as unknown as SealedEffectAuthorizationEvidence;
      sealedEffectAuthorizationEvidence.set(evidence, {
        plannerToken,
        context: candidate.context
      });
      return evidence;
    },
    plan(candidate) {
      if (!isRecord(candidate) || !exactKeys(candidate, ['context', 'authorization', 'input'])) {
        return fail('contribution_mismatch', 'The effect plan input is not exact.');
      }
      assertPlannerContext(candidate.context, producer);
      const evidence = sealedEffectAuthorizationEvidence.get(candidate.authorization);
      if (!evidence || evidence.plannerToken !== plannerToken || evidence.context !== candidate.context) {
        return fail('unsealed_authorization', 'Effect planning requires separately sealed exact authority evidence.');
      }
      const plan = deepFreeze({
        recordKind: 'effect_specification_plan' as const,
        id: parseEffectSpecificationId(input.newEffectSpecificationId()),
        context: candidate.context,
        definition: exactEffect,
        specificationSchema: { ...definition.specificationSchema },
        providerAttemptSchema: { ...definition.providerAttemptSchema },
        authorization: {
          definition: { ...definition.authorityCitation },
          id: candidate.authorization.authorityCitationId
        },
        targetJob: {
          ...exactJob,
          targetOperation: { ...job.targetOperation },
          capabilityRevisionId: parseCapabilityRevisionId(job.capabilityRevisionId),
          authorityCitation: { ...job.authorityCitation }
        },
        input: parseSafeInput(candidate.input)
      });
      sealedEffectPlans.add(plan);
      return plan;
    }
  });
  return planner;
}

function timelineId(value: unknown): string {
  if (!isApplicationId(value)) {
    return fail('contribution_mismatch', 'Timeline identities must be opaque application IDs.');
  }
  return value;
}

export function composeReliabilityContribution(input: {
  readonly fact: DomainFactContributionPlan;
  readonly effect?: EffectSpecificationContributionPlan;
  readonly identifiers: {
    readonly factTimelineId: string;
    readonly factPointerId: OutboxPointerId;
    readonly factPointerTimelineId: string;
    readonly effectTimelineId?: string;
    readonly effectPointerId?: OutboxPointerId;
    readonly effectPointerTimelineId?: string;
  };
}): SealedReliabilityContribution {
  if (!isRecord(input) || !exactKeys(input, ['fact', 'identifiers'], ['effect'])
    || !isRecord(input.identifiers)
    || !exactKeys(input.identifiers, ['factTimelineId', 'factPointerId', 'factPointerTimelineId'], [
      'effectTimelineId', 'effectPointerId', 'effectPointerTimelineId'
    ]) || !sealedFactPlans.has(input.fact)) {
    return fail('contribution_mismatch', 'The contribution contains an unsealed fact plan.');
  }
  const hasEffectIdentifiers = input.identifiers.effectTimelineId !== undefined
    || input.identifiers.effectPointerId !== undefined
    || input.identifiers.effectPointerTimelineId !== undefined;
  if (input.effect === undefined ? hasEffectIdentifiers : !hasEffectIdentifiers
    || (input.effect !== undefined && !sealedEffectPlans.has(input.effect))) {
    return fail('contribution_mismatch', 'Effect plans and their exact identifiers must appear together.');
  }
  if (input.effect && input.effect.context !== input.fact.context) {
    return fail('contribution_mismatch', 'Fact and effect plans must share one sealed causal context.');
  }

  const factPointer: ReliabilityOutboxPointerPlan = deepFreeze({
    id: parseOutboxPointerId(input.identifiers.factPointerId),
    source: { kind: 'domain_fact', id: input.fact.id }
  });
  const pointers: ReliabilityOutboxPointerPlan[] = [factPointer];
  const timeline: ReliabilityTimelinePlan[] = [{
    id: timelineId(input.identifiers.factTimelineId),
    source: { kind: 'domain_fact', id: input.fact.id },
    kind: input.fact.definition.reference,
    definitionDigestSha256: input.fact.definition.canonicalDigestSha256,
    context: input.fact.context
  }, {
    id: timelineId(input.identifiers.factPointerTimelineId),
    source: { kind: 'outbox_pointer', id: factPointer.id },
    kind: definitionRef('outbox_pointer', 'reliability.outbox-pointer', 1),
    context: input.fact.context
  }];
  if (input.effect) {
    if (input.identifiers.effectTimelineId === undefined
      || input.identifiers.effectPointerId === undefined
      || input.identifiers.effectPointerTimelineId === undefined) {
      return fail('contribution_mismatch', 'Effect identifiers are incomplete.');
    }
    const effectPointer: ReliabilityOutboxPointerPlan = deepFreeze({
      id: parseOutboxPointerId(input.identifiers.effectPointerId),
      source: { kind: 'effect_specification', id: input.effect.id },
      targetJob: {
        reference: { ...input.effect.targetJob.reference },
        canonicalDigestSha256: input.effect.targetJob.canonicalDigestSha256
      }
    });
    pointers.push(effectPointer);
    timeline.push({
      id: timelineId(input.identifiers.effectTimelineId),
      source: { kind: 'effect_specification', id: input.effect.id },
      kind: input.effect.definition.reference,
      definitionDigestSha256: input.effect.definition.canonicalDigestSha256,
      context: input.effect.context
    }, {
      id: timelineId(input.identifiers.effectPointerTimelineId),
      source: { kind: 'outbox_pointer', id: effectPointer.id },
      kind: definitionRef('outbox_pointer', 'reliability.outbox-pointer', 1),
      context: input.effect.context
    });
  }
  const identities = [input.fact.id, input.effect?.id, ...pointers.map((pointer) => pointer.id), ...timeline.map((entry) => entry.id)]
    .filter((value): value is string => value !== undefined);
  if (new Set(identities).size !== identities.length) {
    return fail('contribution_mismatch', 'Contribution record identities must be unique.');
  }
  const contribution = deepFreeze({
    recordKind: 'reliability_contribution' as const,
    context: input.fact.context,
    fact: input.fact,
    ...(input.effect === undefined ? {} : { effect: input.effect }),
    pointers,
    timeline
  }) as SealedReliabilityContribution;
  canonicalJsonValue(contribution);
  sealedContributions.add(contribution);
  return contribution;
}

export function isSealedReliabilityContribution(
  value: unknown
): value is SealedReliabilityContribution {
  return isRecord(value) && sealedContributions.has(value);
}
