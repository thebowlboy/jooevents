import { describe, expect, test } from 'bun:test';
import {
  canonicalJsonText,
  parseAuthorityCitationId,
  parseChangesetId,
  parseChangesetRevisionId,
  parseContractVersion,
  parseDomainFactId,
  parseEffectSpecificationId,
  parseEventId,
  parseInstant,
  parseOperationReceiptId,
  parseOutboxPointerId,
  parsePayloadRefId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  composeReliabilityContribution,
  createDomainFactContributionPlanner,
  createEffectSpecificationContributionPlanner,
  ReliabilityContributionError,
  sealReliabilityContributionContext,
  type ExactReliabilityDefinitionBinding,
  type ReliabilitySafeInput
} from './contribution';
import {
  definitionRef,
  parseDefinitionKey,
  schemaRef,
  type DomainFactDefinition,
  type EffectDefinition,
  type JobDefinition,
  type ProducerRef
} from './definitions';
import { buildReliabilityRegistry, sealReliabilityDefinition } from './registry';
import { jobDefinition } from './test-fixtures';

const schemaDigest = 'a'.repeat(64);
const producer: ProducerRef = {
  kind: 'changeset_operation',
  operation: definitionRef('changeset_operation', 'event.commit', 1)
};
const authorityCitation = definitionRef(
  'authority_citation',
  'message.effect.authority',
  1
);
const trustedCitationId = parseAuthorityCitationId('01890f47-9abc-7def-8123-456789abc010');

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  event: parseEventId('01890f47-9abc-7def-8123-456789abc001'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc002'),
  receipt: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abc003'),
  changeset: parseChangesetId('01890f47-9abc-7def-8123-456789abc004'),
  revision: parseChangesetRevisionId('01890f47-9abc-7def-8123-456789abc005'),
  aggregate: '01890f47-9abc-7def-8123-456789abc006',
  payload: parsePayloadRefId('01890f47-9abc-7def-8123-456789abc007'),
  fact: parseDomainFactId('01890f47-9abc-7def-8123-456789abc008'),
  effect: parseEffectSpecificationId('01890f47-9abc-7def-8123-456789abc009'),
  factTimeline: '01890f47-9abc-7def-8123-456789abc011',
  factPointer: parseOutboxPointerId('01890f47-9abc-7def-8123-456789abc012'),
  factPointerTimeline: '01890f47-9abc-7def-8123-456789abc013',
  effectTimeline: '01890f47-9abc-7def-8123-456789abc014',
  effectPointer: parseOutboxPointerId('01890f47-9abc-7def-8123-456789abc015'),
  effectPointerTimeline: '01890f47-9abc-7def-8123-456789abc016'
} as const;

async function factDefinition(): Promise<DomainFactDefinition> {
  return sealReliabilityDefinition({
    kind: 'domain_fact',
    key: parseDefinitionKey('event.changed'),
    version: parseContractVersion(1),
    metadataSchema: schemaRef('schema.event.changed', 1, schemaDigest),
    producers: [producer],
    aggregateKind: parseDefinitionKey('event'),
    subjectIdentity: definitionRef('subject_identity', 'event.subject', 1),
    scope: definitionRef('scope', 'event.scope', 1),
    causalParent: definitionRef('causal_parent', 'changeset.receipt', 1),
    consumerCompatibility: definitionRef('consumer_compatibility', 'exact.source', 1),
    classifiedPayloadPaths: ['/classifiedPayloadRefs'],
    redaction: definitionRef('redaction', 'event.fact', 1)
  });
}

async function effectDefinition(job: JobDefinition): Promise<EffectDefinition> {
  return sealReliabilityDefinition({
    kind: 'effect',
    key: parseDefinitionKey('message.requested'),
    version: parseContractVersion(1),
    specificationSchema: schemaRef('schema.message.effect', 1, schemaDigest),
    providerAttemptSchema: schemaRef('schema.message.attempt', 1, 'b'.repeat(64)),
    producers: [producer],
    targetJob: definitionRef('job', job.key, job.version),
    reducer: definitionRef('reducer', 'message.result', 1),
    authorityCitation,
    retry: definitionRef('retry', 'provider.anchor.inspect', 1),
    cancellation: definitionRef('cancellation', 'message.cancel', 1)
  });
}

function exact<Kind extends 'domain_fact' | 'effect' | 'job'>(
  definition: { readonly kind: Kind; readonly key: string; readonly version: number; readonly canonicalDigestSha256: string }
): ExactReliabilityDefinitionBinding<Kind> {
  return {
    reference: definitionRef(definition.kind, definition.key, definition.version),
    canonicalDigestSha256: definition.canonicalDigestSha256 as never
  };
}

async function fixture() {
  const job = await jobDefinition();
  const otherJob = await jobDefinition('message.dispatch.other');
  const fact = await factDefinition();
  const effect = await effectDefinition(job);
  const registry = await buildReliabilityRegistry([fact, effect, job, otherJob]);
  const context = sealReliabilityContributionContext({
    producer,
    occurredAt: parseInstant('2026-08-11T00:00:00.000Z'),
    actor: { kind: 'workspace_user', userId: ids.user },
    scope: { kind: 'event', workspaceId: ids.workspace, eventId: ids.event },
    subjects: [
      { kind: 'workspace', id: ids.workspace },
      { kind: 'event', id: ids.event },
      { kind: 'domain', domain: 'event', entity: 'event', id: ids.aggregate }
    ],
    causation: {
      kind: 'changeset_revision',
      receiptId: ids.receipt,
      changesetId: ids.changeset,
      revisionId: ids.revision,
      revisionDigestSha256: 'c'.repeat(64) as never
    }
  });
  const safeInput: ReliabilitySafeInput = {
    safeReferences: [{
      kind: 'purpose',
      key: parseDefinitionKey('message.acceptance'),
      version: parseContractVersion(1),
      opaqueId: ids.aggregate
    }],
    classifiedPayloadRefs: [{ id: ids.payload }]
  };
  return { registry, fact, effect, job, otherJob, context, safeInput };
}

async function planners(target?: Awaited<ReturnType<typeof fixture>>) {
  const resolved = target ?? await fixture();
  const facts = await createDomainFactContributionPlanner({
    registry: resolved.registry,
    definition: exact(resolved.fact),
    producer,
    newFactId: () => ids.fact
  });
  const effects = await createEffectSpecificationContributionPlanner({
    registry: resolved.registry,
    definition: exact(resolved.effect),
    targetJob: exact(resolved.job),
    producer,
    authorityCitation,
    citationVerifier: {
      isTrusted: ({ citationId }) => citationId === trustedCitationId
    },
    newEffectSpecificationId: () => ids.effect
  });
  return { ...resolved, facts, effects };
}

function identifierSet() {
  return {
    factTimelineId: ids.factTimeline,
    factPointerId: ids.factPointer,
    factPointerTimelineId: ids.factPointerTimeline,
    effectTimelineId: ids.effectTimeline,
    effectPointerId: ids.effectPointer,
    effectPointerTimelineId: ids.effectPointerTimeline
  };
}

describe('sealed reliability contributions', () => {
  test('binds one fact and separately authorized effect to exact definitions, target job, and causation', async () => {
    const target = await planners();
    const fact = target.facts.plan({
      context: target.context,
      aggregate: { id: ids.aggregate, priorVersion: 0, sequence: 1, resultingVersion: 1 },
      input: target.safeInput
    });
    const authorization = await target.effects.authorize({
      context: target.context,
      authorityCitation,
      authorityCitationId: trustedCitationId
    });
    const effect = target.effects.plan({
      context: target.context,
      authorization,
      input: target.safeInput
    });
    const contribution = composeReliabilityContribution({
      fact,
      effect,
      identifiers: identifierSet()
    });

    expect(Object.isFrozen(contribution)).toBe(true);
    expect(contribution.fact.definition.canonicalDigestSha256).toBe(
      target.fact.canonicalDigestSha256
    );
    expect(contribution.effect?.definition.canonicalDigestSha256).toBe(
      target.effect.canonicalDigestSha256
    );
    expect(contribution.effect?.targetJob).toMatchObject({
      reference: definitionRef('job', target.job.key, target.job.version),
      canonicalDigestSha256: target.job.canonicalDigestSha256,
      targetOperation: target.job.targetOperation,
      capabilityRevisionId: target.job.capabilityRevisionId,
      authorityCitation: target.job.authorityCitation
    });
    expect(contribution.effect?.authorization).toEqual({
      definition: authorityCitation,
      id: trustedCitationId
    });
    expect(contribution.pointers.map((pointer) => pointer.source.kind)).toEqual([
      'domain_fact', 'effect_specification'
    ]);
    expect(contribution.pointers[1]?.targetJob).toEqual(exact(target.job));
    expect(contribution.pointers[1]?.targetJob).not.toHaveProperty('targetOperation');
    expect(contribution.timeline).toHaveLength(4);
  });

  test('rejects unknown/wrong versions, digests, producers, target jobs, and citation definitions', async () => {
    const target = await fixture();
    await expect(createDomainFactContributionPlanner({
      registry: target.registry,
      definition: {
        ...exact(target.fact),
        reference: definitionRef('domain_fact', target.fact.key, 2)
      },
      producer,
      newFactId: () => ids.fact
    })).rejects.toMatchObject({ code: 'unknown_definition' });

    await expect(createDomainFactContributionPlanner({
      registry: target.registry,
      definition: { ...exact(target.fact), canonicalDigestSha256: 'f'.repeat(64) as never },
      producer,
      newFactId: () => ids.fact
    })).rejects.toMatchObject({ code: 'definition_digest_mismatch' });

    await expect(createDomainFactContributionPlanner({
      registry: target.registry,
      definition: exact(target.fact),
      producer: {
        kind: 'changeset_operation',
        operation: definitionRef('changeset_operation', 'event.commit', 2)
      },
      newFactId: () => ids.fact
    })).rejects.toMatchObject({ code: 'producer_mismatch' });

    await expect(createEffectSpecificationContributionPlanner({
      registry: target.registry,
      definition: exact(target.effect),
      targetJob: exact(target.otherJob),
      producer,
      authorityCitation,
      citationVerifier: { isTrusted: () => true },
      newEffectSpecificationId: () => ids.effect
    })).rejects.toMatchObject({ code: 'target_job_mismatch' });

    await expect(createEffectSpecificationContributionPlanner({
      registry: target.registry,
      definition: exact(target.effect),
      targetJob: exact(target.job),
      producer,
      authorityCitation: definitionRef('authority_citation', 'message.other.authority', 1),
      citationVerifier: { isTrusted: () => true },
      newEffectSpecificationId: () => ids.effect
    })).rejects.toMatchObject({ code: 'authority_citation_mismatch' });
  });

  test('fact visibility cannot mint an effect and payload fields cannot select authority or target', async () => {
    const target = await planners();
    const fact = target.facts.plan({
      context: target.context,
      aggregate: { id: ids.aggregate, priorVersion: 0, sequence: 1, resultingVersion: 1 },
      input: target.safeInput
    });
    expect(() => target.effects.plan({
      context: target.context,
      authorization: fact as never,
      input: target.safeInput
    })).toThrow(ReliabilityContributionError);

    const factOnly = composeReliabilityContribution({
      fact,
      identifiers: {
        factTimelineId: ids.factTimeline,
        factPointerId: ids.factPointer,
        factPointerTimelineId: ids.factPointerTimeline
      }
    });
    expect(factOnly.effect).toBeUndefined();
    expect(factOnly.pointers).toEqual([expect.objectContaining({
      source: { kind: 'domain_fact', id: ids.fact }
    })]);
    expect(factOnly.pointers[0]).not.toHaveProperty('targetJob');

    expect(() => target.facts.plan({
      context: target.context,
      aggregate: { id: ids.aggregate, priorVersion: 0, sequence: 1, resultingVersion: 1 },
      input: {
        ...target.safeInput,
        authorityCitationId: trustedCitationId,
        targetJob: target.job.targetOperation,
        rawBody: 'raw-provider-body-canary'
      } as never
    })).toThrow(expect.objectContaining({ code: 'invalid_safe_input' }));
  });

  test('requires producer-matched causation and a trusted exact authority citation', async () => {
    expect(() => sealReliabilityContributionContext({
      producer,
      occurredAt: parseInstant('2026-08-11T00:00:00.000Z'),
      actor: { kind: 'workspace_user', userId: ids.user },
      scope: { kind: 'event', workspaceId: ids.workspace, eventId: ids.event },
      subjects: [
        { kind: 'workspace', id: ids.workspace },
        { kind: 'event', id: ids.event }
      ]
    } as never)).toThrow(expect.objectContaining({ code: 'invalid_context' }));

    const target = await planners();
    await expect(target.effects.authorize({
      context: target.context,
      authorityCitation,
      authorityCitationId: parseAuthorityCitationId(
        '01890f47-9abc-7def-8123-456789abc099'
      )
    })).rejects.toMatchObject({ code: 'untrusted_authority_citation' });
    await expect(target.effects.authorize({
      context: target.context,
      authorityCitation: definitionRef('authority_citation', 'message.other.authority', 1),
      authorityCitationId: trustedCitationId
    })).rejects.toMatchObject({ code: 'authority_citation_mismatch' });
  });

  test('stores only safe opaque structure and classified references in planned payload material', async () => {
    const target = await planners();
    const fact = target.facts.plan({
      context: target.context,
      aggregate: { id: ids.aggregate, priorVersion: 0, sequence: 1, resultingVersion: 1 },
      input: target.safeInput
    });
    const authorization = await target.effects.authorize({
      context: target.context,
      authorityCitation,
      authorityCitationId: trustedCitationId
    });
    const effect = target.effects.plan({
      context: target.context,
      authorization,
      input: target.safeInput
    });
    const serialized = canonicalJsonText(composeReliabilityContribution({
      fact,
      effect,
      identifiers: identifierSet()
    }));
    expect(serialized).toContain(ids.payload);
    for (const canary of [
      'raw-provider-body-canary',
      'classified-content-canary',
      'provider-response-text-canary'
    ]) expect(serialized).not.toContain(canary);
  });
});
