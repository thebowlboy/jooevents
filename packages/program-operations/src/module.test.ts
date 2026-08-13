import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type EffectInvocationContext,
  type EffectUnitOfWorkPort,
  type InvocationEvidence
} from '@jooevents/application';
import {
  PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS,
  programVocabularySnapshotReadResultSchema
} from '@jooevents/contracts';
import {
  createProgramReferenceContributorRegistry,
  createProgramVocabularyState
} from '@jooevents/program';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
  PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE,
  PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY,
  PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID,
  PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
  PROGRAM_VOCABULARY_READ_PERMISSION_ID,
  createProgramVocabularyDraftHandler,
  createProgramVocabularyOperationModule,
  programVocabularyCreateDraftInputSchema,
  programVocabularyDeleteDraftInputSchema,
  programVocabularyDraftActionForOperation,
  programVocabularyDraftContributionSchema,
  programVocabularyEditDraftInputSchema,
  programVocabularyMergeDraftInputSchema,
  programVocabularyRestoreDraftInputSchema,
  programVocabularyRetireDraftInputSchema,
  sealProgramVocabularyDraftPreparation
} from '.';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  event: '018f7d5a-4b3c-7abc-8def-0123456789a1',
  item: '018f7d5a-4b3c-7abc-8def-0123456789a2',
  changeset: '018f7d5a-4b3c-7abc-8def-0123456789a3',
  revision: '018f7d5a-4b3c-7abc-8def-0123456789a4',
  preparation: '018f7d5a-4b3c-7abc-8def-0123456789a5',
  timeline: '018f7d5a-4b3c-7abc-8def-0123456789a6',
  correlation: '018f7d5a-4b3c-7abc-8def-0123456789a7'
} as const;
const now = parseInstant('2026-08-12T09:00:00.000Z');
const profile = { key: 'program-vocabulary-operation-test', version: parseContractVersion(1) } as const;
const registry = createProgramReferenceContributorRegistry({ expected: [], contributors: [] });
const state = createProgramVocabularyState({
  scope: { workspaceId: ids.workspace, eventId: ids.event },
  setVersion: 1,
  rooms: [{
    id: ids.item,
    name: 'Main Hall',
    capacity: 250,
    status: 'active',
    version: 1
  }]
});
const crossScopeState = createProgramVocabularyState({
  scope: {
    workspaceId: '650e8400-e29b-41d4-a716-446655440000',
    eventId: ids.event
  },
  setVersion: 1
});

const unusedUnitOfWork: EffectUnitOfWorkPort = Object.freeze({
  findTerminalReceipt: () => undefined,
  recordShortOperationAudit: () => undefined,
  async runInUnitOfWork() {
    throw new TypeError('program_vocabulary_test_unit_of_work_not_mounted');
  }
});

function fixture(options: {
  readonly event?: boolean;
  readonly wrongPolicy?: boolean;
  readonly wrongReadScope?: boolean;
} = {}) {
  const authorityPolicies: string[] = [];
  const authorityScopes: Array<{
    readonly workspaceId: string;
    readonly eventId?: string;
    readonly subjects: readonly { readonly kind: string; readonly id: string }[];
    readonly resolutionEvidenceIds: readonly string[];
  }> = [];
  let nextInvocation = 0;
  const module = createProgramVocabularyOperationModule({
    workspaceId: ids.workspace,
    policies: {
      read: options.wrongPolicy
        ? {
            key: 'authority.program_vocabulary.wrong',
            version: parseContractVersion(1)
          }
        : PROGRAM_VOCABULARY_READ_ACCESS_POLICY,
      manage: PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY
    },
    currentAuthority: {
      resolve(resolution) {
        authorityPolicies.push(resolution.lane.policy.key);
        authorityScopes.push(resolution.scope);
        if (resolution.evidence.kind !== 'operator') {
          return { kind: 'denied', reason: 'lane_mismatch' };
        }
        const permission = resolution.operation.effect === 'read'
          ? PROGRAM_VOCABULARY_READ_PERMISSION_ID
          : PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID;
        return {
          kind: 'authorized',
          authority: {
            actor: { kind: 'workspace_user', userId: ids.user },
            principal: {
              kind: 'workspace_user',
              userId: ids.user,
              membershipId: ids.membership
            },
            lane: resolution.lane,
            scope: resolution.scope,
            grants: [{ kind: 'permission', key: permission }],
            evidenceIds: ['membership.current'],
            authorityCitationIds: [],
            evaluatedAt: resolution.evaluatedAt
          }
        };
      }
    },
    currentEvent: {
      resolveCurrentEvent: () => options.event
        ? {
            eventId: ids.event,
            evidenceIds: ['event.current:b', 'event.current:a', 'event.current:b']
          }
        : { evidenceIds: ['event.none'] }
    },
    vocabularyRead: {
      readVocabulary: ({ workspaceId, eventId }) =>
        workspaceId === ids.workspace && eventId === ids.event
          ? options.wrongReadScope ? crossScopeState : state
          : undefined,
      readContributor: () => undefined
    },
    referenceRegistry: registry,
    clock: { now: () => now },
    ids: {
      newInvocationId: () => parseInvocationId(
        `018f7d5a-4b3c-7abc-8def-${(nextInvocation++ + 100).toString().padStart(12, '0')}`
      )
    },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x42)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`program-vocabulary:${raw}`).digest('hex')
        };
      }
    }
  });
  const evidence: InvocationEvidence = {
    kind: 'operator',
    surface: 'operator_http',
    client: { key: 'web.operator' },
    sessionHandle: 'session-current'
  };
  return { module, authorityPolicies, authorityScopes, evidence };
}

async function runtime(value: ReturnType<typeof fixture>) {
  return createApplicationOperationRuntime({
    source: value.module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId(crypto.randomUUID())
    },
    unitOfWork: unusedUnitOfWork
  });
}

function handler() {
  return createProgramVocabularyDraftHandler({
    reference: { key: 'handler.program_vocabulary.changeset-draft', version: 1 },
    handlerCapability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
    contributionSchema: {
      key: 'schema.program_vocabulary.changeset-draft.contribution',
      version: 1,
      digestSha256: 'a'.repeat(64)
    },
    canonicalResultSchema: {
      key: 'schema.program_vocabulary.changeset-draft.canonical-result',
      version: 1,
      digestSha256: 'b'.repeat(64)
    },
    actionForOperation: programVocabularyDraftActionForOperation
  });
}

function context(operationName = 'program_vocabulary.create.draft'): EffectInvocationContext {
  return Object.freeze({
    operation: Object.freeze({ name: operationName, version: 1, effect: 'draft' }),
    actor: Object.freeze({ kind: 'workspace_user', userId: ids.user }),
    scope: Object.freeze({ workspaceId: ids.workspace, eventId: ids.event })
  }) as EffectInvocationContext;
}

function successContribution() {
  const safeDiff = {
    action: 'create' as const,
    before: null,
    after: {
      kind: 'room' as const,
      id: ids.item,
      name: 'Main Hall',
      status: 'active' as const,
      capacity: 250,
      version: 1
    }
  };
  return {
    result: {
      kind: 'success' as const,
      data: {
        schemaVersion: 1 as const,
        action: 'create' as const,
        changesetId: ids.changeset,
        headVersion: 1,
        status: 'draft' as const,
        revision: { id: ids.revision, number: 1, digestSha256: 'c'.repeat(64) },
        riskTier: 'normal' as const,
        approvalPolicy: {
          reference: { key: 'policy.program_vocabulary.bounded', version: 1 },
          definitionDigestSha256: 'd'.repeat(64),
          requirement: 'none' as const
        },
        safeDiff
      }
    },
    domain: {
      kind: 'program_vocabulary_changeset_draft' as const,
      preparationHandle: ids.preparation,
      action: 'create' as const,
      workspaceId: ids.workspace,
      eventId: ids.event,
      changesetId: ids.changeset,
      revisionId: ids.revision,
      revisionDigestSha256: 'c'.repeat(64),
      recordDigestSha256: 'e'.repeat(64),
      occurredAt: now
    },
    receiptChildren: [{
      kind: 'timeline' as const,
      timelineId: ids.timeline,
      sourceKind: 'changeset_revision' as const,
      workspaceId: ids.workspace,
      eventId: ids.event,
      changesetId: ids.changeset,
      revisionId: ids.revision,
      occurredAt: now
    }]
  };
}

describe('Program Vocabulary ordinary operation module', () => {
  test('binds exact declared permissions and rejects policy substitution', () => {
    expect(PROGRAM_VOCABULARY_READ_ACCESS_POLICY.key)
      .toBe('authority.program_vocabulary.read');
    expect(Number(PROGRAM_VOCABULARY_READ_ACCESS_POLICY.version)).toBe(1);
    expect(PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY.key)
      .toBe('authority.program_vocabulary.manage');
    expect(Number(PROGRAM_VOCABULARY_MANAGE_ACCESS_POLICY.version)).toBe(1);
    expect(PROGRAM_VOCABULARY_READ_PERMISSION_ID).toBe('event.read');
    expect(PROGRAM_VOCABULARY_MANAGE_PERMISSION_ID).toBe('program.vocabulary.manage');
    expect(() => fixture({ wrongPolicy: true }))
      .toThrow('program_vocabulary_operation_policy_catalog_mismatch');
  });

  test('compiles one deterministic operator-only catalog with exact read and draft paths', async () => {
    const first = await runtime(fixture({ event: true }));
    const second = await runtime(fixture({ event: true }));
    expect(first.registry.manifestDigestSha256).toBe(second.registry.manifestDigestSha256);
    expect(first.registry.operatorHttpBindings).toEqual([{
      operationName: 'program_vocabulary.snapshot.read',
      operationVersion: 1,
      surface: 'operator_http',
      method: 'GET',
      path: '/api/events/current/program-vocabulary',
      input: 'query'
    }]);
    expect(first.registry.operatorHttpEffectBindings.map((binding) => ({
      name: binding.operationName,
      path: binding.path
    }))).toEqual([
      { name: 'program_vocabulary.create.draft', path: '/api/events/current/program-vocabulary/drafts/create' },
      { name: 'program_vocabulary.delete.draft', path: '/api/events/current/program-vocabulary/drafts/delete' },
      { name: 'program_vocabulary.edit.draft', path: '/api/events/current/program-vocabulary/drafts/edit' },
      { name: 'program_vocabulary.merge.draft', path: '/api/events/current/program-vocabulary/drafts/merge' },
      { name: 'program_vocabulary.restore.draft', path: '/api/events/current/program-vocabulary/drafts/restore' },
      { name: 'program_vocabulary.retire.draft', path: '/api/events/current/program-vocabulary/drafts/retire' }
    ]);
    expect(first.registry.safeManifest.operations.every((operation) =>
      operation.enabledBindings.every((binding) => binding.surface === 'operator_http')
    )).toBe(true);
    const read = first.registry.safeManifest.operations.find(
      (operation) => operation.name === 'program_vocabulary.snapshot.read'
    );
    const create = first.registry.safeManifest.operations.find(
      (operation) => operation.name === 'program_vocabulary.create.draft'
    );
    expect(read?.inputSchema)
      .toEqual(PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema);
    expect(read?.enabledBindings[0]?.resultSchema)
      .toEqual(PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema);
    expect(create?.inputSchema)
      .toEqual(PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.create.inputSchema);
    expect(create?.enabledBindings[0]?.resultSchema)
      .toEqual(PROGRAM_VOCABULARY_OPERATION_SCHEMA_REFS.drafts.create.resultSchema);
  });

  test('reads one server-scoped canonical snapshot and reports the genuine no-event state', async () => {
    const current = fixture({ event: true });
    const currentRuntime = await runtime(current);
    const read = await currentRuntime.readExecutor.execute({
      operationName: 'program_vocabulary.snapshot.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: ids.correlation,
      businessInput: {},
      verifiedEvidence: current.evidence
    });
    expect(programVocabularySnapshotReadResultSchema.parse(read)).toMatchObject({
      kind: 'success',
      data: {
        scope: { workspaceId: ids.workspace, eventId: ids.event },
        setVersion: 1,
        rooms: [{ id: ids.item, usage: { current: 0, historicalPins: 0 } }]
      }
    });
    expect(current.authorityPolicies).toEqual(['authority.program_vocabulary.read']);
    expect(current.authorityScopes).toEqual([{
      workspaceId: ids.workspace,
      eventId: ids.event,
      subjects: [
        { kind: 'event', id: ids.event },
        { kind: 'workspace', id: ids.workspace }
      ],
      resolutionEvidenceIds: ['event.current:a', 'event.current:b']
    }]);

    const empty = fixture();
    const emptyRuntime = await runtime(empty);
    expect(await emptyRuntime.readExecutor.execute({
      operationName: 'program_vocabulary.snapshot.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: ids.correlation,
      businessInput: {},
      verifiedEvidence: empty.evidence
    })).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'program_vocabulary.event_required' }
    });
  });

  test('builds drafts only through the dedicated manage lane and server-resolved Event scope', async () => {
    const value = fixture({ event: true });
    const operations = await runtime(value);
    await operations.effectBuilder.build({
      operationName: 'program_vocabulary.create.draft',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: ids.correlation,
      businessInput: {
        kind: 'room', expectedSetVersion: 1, name: 'Main Hall', capacity: 250
      },
      verifiedEvidence: value.evidence,
      rawIdempotencyKey: 'draft-main-hall'
    });
    expect(value.authorityPolicies).toEqual(['authority.program_vocabulary.manage']);
    expect(PROGRAM_VOCABULARY_DRAFT_REQUEST_HASH_PROFILE).toEqual({
      key: 'request-hash.program_vocabulary.draft', version: 1
    });
  });

  test('fails closed when a repository returns another scope', async () => {
    const value = fixture({ event: true, wrongReadScope: true });
    const operations = await runtime(value);
    await expect(operations.readExecutor.execute({
      operationName: 'program_vocabulary.snapshot.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: ids.correlation,
      businessInput: {},
      verifiedEvidence: value.evidence
    })).rejects.toThrow();
  });

  test('keeps every wire draft scope-free and reserves new create identity for the server', () => {
    const valid = {
      create: { kind: 'room', expectedSetVersion: 1, name: 'Main Hall', capacity: 250 },
      edit: {
        kind: 'room', id: ids.item, expectedSetVersion: 1, expectedItemVersion: 1,
        changes: { name: 'Hall A', capacity: 200 }
      },
      retire: { kind: 'room', id: ids.item, expectedSetVersion: 1, expectedItemVersion: 1 },
      restore: { kind: 'room', id: ids.item, expectedSetVersion: 1, expectedItemVersion: 1 },
      delete: { kind: 'room', id: ids.item, expectedSetVersion: 1, expectedItemVersion: 1 },
      merge: {
        kind: 'room', sourceId: ids.item, targetId: ids.timeline, expectedSetVersion: 1,
        expectedSourceVersion: 1, expectedTargetVersion: 1
      }
    } as const;
    const cases = [
      [programVocabularyCreateDraftInputSchema, valid.create],
      [programVocabularyEditDraftInputSchema, valid.edit],
      [programVocabularyRetireDraftInputSchema, valid.retire],
      [programVocabularyRestoreDraftInputSchema, valid.restore],
      [programVocabularyDeleteDraftInputSchema, valid.delete],
      [programVocabularyMergeDraftInputSchema, valid.merge]
    ] as const;
    for (const [schema, value] of cases) {
      expect(schema.safeParse(value).success).toBe(true);
      for (const trusted of [
        { workspaceId: ids.workspace },
        { eventId: ids.event },
        { actorUserId: ids.user },
        { permission: 'program.vocabulary.manage' },
        { approval: true },
        { databasePath: '/tmp/not-authority.sqlite' }
      ]) {
        expect(schema.safeParse({ ...value, ...trusted }).success).toBe(false);
      }
    }
    expect(programVocabularyCreateDraftInputSchema.safeParse({
      ...valid.create,
      id: ids.item
    }).success).toBe(false);
  });
});

describe('Program Vocabulary draft preparation', () => {
  test('is opaque, exact-context/capability-bound, synchronous, and one-shot', () => {
    const draftHandler = handler();
    const invocationContext = context();
    const prepared = successContribution();
    const snapshot = sealProgramVocabularyDraftPreparation({
      capability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
      context: invocationContext,
      preparation: {
        prepare: ({ action, context: received }) => {
          expect(action).toBe('create');
          expect(received).toBe(invocationContext);
          return prepared;
        }
      }
    });
    expect(snapshot).toEqual({ strategy: 'program_vocabulary_changeset_draft', version: 1 });
    expect(Object.keys(snapshot)).toEqual(['strategy', 'version']);
    expect(draftHandler.handle({ businessInput: {}, context: invocationContext, snapshot }))
      .toEqual(prepared);
    expect(() => draftHandler.handle({ businessInput: {}, context: invocationContext, snapshot }))
      .toThrow('invalid_program_vocabulary_draft_preparation');

    expect(() => sealProgramVocabularyDraftPreparation({
      capability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
      context: invocationContext,
      preparation: {
        prepare: (async () => prepared) as never
      }
    })).toThrow('program_vocabulary_draft_preparation_must_be_synchronous');

    const thenable = sealProgramVocabularyDraftPreparation({
      capability: PROGRAM_VOCABULARY_DRAFT_HANDLER_CAPABILITY,
      context: invocationContext,
      preparation: {
        prepare: (() => ({ then() {} })) as never
      }
    });
    expect(() => draftHandler.handle({
      businessInput: {}, context: invocationContext, snapshot: thenable
    })).toThrow('program_vocabulary_draft_preparation_must_be_synchronous');
  });

  test('accepts only a coherent persisted revision/timeline or an exact zero-write refusal', () => {
    const prepared = successContribution();
    expect(programVocabularyDraftContributionSchema.safeParse(prepared).success).toBe(true);

    const wrongAction = structuredClone(prepared);
    wrongAction.result.data.action = 'edit' as 'create';
    expect(programVocabularyDraftContributionSchema.safeParse(wrongAction).success).toBe(false);

    const wrongTimeline = {
      ...structuredClone(prepared),
      receiptChildren: [{
        ...structuredClone(prepared.receiptChildren[0]),
        revisionId: ids.preparation
      }]
    };
    expect(programVocabularyDraftContributionSchema.safeParse(wrongTimeline).success).toBe(false);

    const refusal = {
      result: {
        kind: 'outcome',
        outcome: {
          class: 'stale_revision',
          kind: 'program_vocabulary.changed',
          retryable: false,
          subjects: [],
          detail: { code: 'stale_set', action: 'create', ids: [] },
          detailSchemaVersion: 1
        }
      },
      domain: null,
      receiptChildren: []
    };
    expect(programVocabularyDraftContributionSchema.safeParse(refusal).success).toBe(true);
    expect(programVocabularyDraftContributionSchema.safeParse({
      ...refusal,
      domain: { kind: 'program_vocabulary_changeset_draft' }
    }).success).toBe(false);
    expect(programVocabularyDraftContributionSchema.safeParse({
      ...refusal,
      receiptChildren: [{ kind: 'timeline' }]
    }).success).toBe(false);
  });
});
