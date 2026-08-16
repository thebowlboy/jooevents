import {
  parseCapabilityRevisionId,
  parseContractVersion
} from '@jooevents/kernel';
import {
  definitionRef,
  parseDefinitionKey,
  schemaRef,
  type ActivityProjectionDefinition,
  type ConsumerDefinition,
  type DomainFactDefinition,
  type EffectDefinition,
  type JobDefinition
} from './definitions';
import { sealReliabilityDefinition } from './registry';

const SCHEMA_DIGEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SCHEMA_DIGEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const auxiliary = <const Kind extends string>(kind: Kind, key: string) =>
  definitionRef(kind, key, 1);

export async function factDefinition(
  key = 'submission.created',
  version = 1
): Promise<DomainFactDefinition> {
  return sealReliabilityDefinition({
    kind: 'domain_fact',
    key: parseDefinitionKey(key),
    version: parseContractVersion(version),
    metadataSchema: schemaRef('schema.submission.created', 1, SCHEMA_DIGEST_A),
    producers: [
      {
        kind: 'operation',
        operation: definitionRef('operation', 'submission.commit', 2)
      }
    ],
    aggregateKind: parseDefinitionKey('submission'),
    subjectIdentity: auxiliary('subject_identity', 'submission.subject'),
    scope: auxiliary('scope', 'event.scope'),
    causalParent: auxiliary('causal_parent', 'operation.receipt'),
    consumerCompatibility: auxiliary('consumer_compatibility', 'exact.source'),
    classifiedPayloadPaths: ['/privateNotes'],
    redaction: auxiliary('redaction', 'submission.fact')
  });
}

export async function jobDefinition(
  key = 'message.dispatch',
  version = 1,
  maximumAttempts = 2
): Promise<JobDefinition> {
  return sealReliabilityDefinition({
    kind: 'job',
    key: parseDefinitionKey(key),
    version: parseContractVersion(version),
    inputSchema: schemaRef('schema.message.job.input', 1, SCHEMA_DIGEST_A),
    resultSchema: schemaRef('schema.message.job.result', 1, SCHEMA_DIGEST_B),
    errorDetailSchema: schemaRef('schema.safe.failure', 1, SCHEMA_DIGEST_A),
    source: auxiliary('source', 'registered.reliability.source'),
    scopeCausation: auxiliary('scope_causation', 'source.scope'),
    inputProjection: auxiliary('input_projection', 'message.job.input'),
    targetOperation: auxiliary('operation', 'message.dispatch.execute'),
    capabilityRevisionId: parseCapabilityRevisionId('00000000-0000-4000-8000-000000000001'),
    authorityCitation: auxiliary('authority_citation', 'message.dispatch.authority'),
    leaseDurationMs: 30_000,
    maximumAttempts,
    backoff: auxiliary('backoff', 'bounded.exponential'),
    timeoutMs: 60_000,
    cancellation: auxiliary('cancellation', 'message.dispatch.cancel'),
    externalRetryPolicy: 'anchor_inspection_only'
  });
}

export async function effectDefinition(
  targetJob = definitionRef('job', 'message.dispatch', 1)
): Promise<EffectDefinition> {
  return sealReliabilityDefinition({
    kind: 'effect',
    key: parseDefinitionKey('message.requested'),
    version: parseContractVersion(1),
    specificationSchema: schemaRef('schema.message.effect', 1, SCHEMA_DIGEST_A),
    providerAttemptSchema: schemaRef('schema.message.provider.attempt', 1, SCHEMA_DIGEST_B),
    producers: [
      {
        kind: 'operation',
        operation: definitionRef('operation', 'message.request', 3)
      }
    ],
    targetJob,
    reducer: auxiliary('reducer', 'message.provider.result'),
    authorityCitation: auxiliary('authority_citation', 'message.effect.authority'),
    retry: auxiliary('retry', 'provider.anchor.inspect'),
    cancellation: auxiliary('cancellation', 'message.effect.cancel')
  });
}

export async function consumerDefinition(
  key = 'submission.activity',
  version = 1,
  source = definitionRef('domain_fact', 'submission.created', 1),
  maximumAttempts = 2
): Promise<ConsumerDefinition> {
  return sealReliabilityDefinition({
    kind: 'consumer',
    key: parseDefinitionKey(key),
    version: parseContractVersion(version),
    acceptedSources: [source],
    inputSchema: schemaRef('schema.consumer.input', 1, SCHEMA_DIGEST_A),
    resultSchema: schemaRef('schema.consumer.result', 1, SCHEMA_DIGEST_B),
    inputProjection: auxiliary('input_projection', 'activity.consumer.input'),
    targetOperation: auxiliary('operation', 'activity.project'),
    capabilityRevisionId: parseCapabilityRevisionId('00000000-0000-4000-8000-000000000002'),
    authorityCitation: auxiliary('authority_citation', 'activity.consumer.authority'),
    maximumAttempts,
    leaseDurationMs: 30_000,
    backoff: auxiliary('backoff', 'bounded.exponential'),
    outputKind: 'projection',
    replay: auxiliary('replay', 'idempotent.receipt'),
    removal: auxiliary('removal', 'drain.then.remove')
  });
}

export async function activityDefinition(): Promise<ActivityProjectionDefinition> {
  return sealReliabilityDefinition({
    kind: 'activity_projection',
    key: parseDefinitionKey('event.activity'),
    version: parseContractVersion(1),
    acceptedSources: [
      definitionRef('receipt', 'operation.receipt', 1),
      definitionRef('audit', 'operation.audit', 1),
      definitionRef('domain_fact', 'submission.created', 1),
      definitionRef('model_run', 'model.run', 1),
      definitionRef('job', 'message.dispatch', 1),
      definitionRef('effect', 'message.requested', 1)
    ],
    inputSchema: schemaRef('schema.activity.input', 1, SCHEMA_DIGEST_A),
    itemSchema: schemaRef('schema.activity.item', 1, SCHEMA_DIGEST_B),
    viewerAuthorization: auxiliary('viewer_authorization', 'event.activity.view'),
    redaction: auxiliary('redaction', 'event.activity'),
    destination: auxiliary('destination', 'event.activity.feed'),
    projector: auxiliary('activity_projector', 'event.activity.projector')
  });
}

export async function completeCatalog() {
  return Promise.all([
    factDefinition(),
    effectDefinition(),
    consumerDefinition(),
    jobDefinition(),
    activityDefinition()
  ]);
}
