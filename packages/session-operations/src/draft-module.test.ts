import { describe, expect, test } from 'bun:test';
import {
  composeOperationRegistryModules,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperationRegistry,
  type EffectInvocationContext,
  type InvocationEvidence
} from '@jooevents/application';
import {
  SESSION_OPERATION_SCHEMA_REFS,
  sessionAuthorInputSchema,
  sessionDraftOperationResultSchema
} from '@jooevents/contracts/sessions';
import type {
  CurrentAuthorityResolutionInput,
  CurrentAuthorityResolver
} from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseCorrelationId,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { createEmptySessionCatalog } from '@jooevents/session';
import {
  SESSION_CATALOG_READ_OPERATION,
  SESSION_CHANGE_DRAFT_OPERATION,
  SESSION_DRAFT_ACCESS_POLICY,
  SESSION_DRAFT_APPROVAL_POLICY,
  SESSION_DRAFT_HANDLER_CAPABILITY,
  SESSION_DRAFT_PERMISSION_ID,
  SESSION_DRAFT_REQUEST_HASH_PROFILE,
  SESSION_READ_ACCESS_POLICY,
  createSessionDraftHandler,
  createSessionDraftOperationModule,
  createSessionOperationModule,
  sealSessionDraftPreparation,
  sessionDraftCanonicalResultSchema,
  sessionDraftContributionSchema
} from '.';

const scope = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101')
});
const userId = parseUserId('019c1df7-86b5-769b-bba4-5f7097bfa202');
const membershipId = parseMembershipId('019c1df7-86b5-769b-bba4-5f7097bfa203');
const now = parseInstant('2026-08-13T12:00:00.000Z');
const profile = Object.freeze({
  key: 'session-draft-operation-test', version: parseContractVersion(1)
});
const evidence = Object.freeze({
  kind: 'operator' as const,
  surface: 'operator_http' as const,
  client: Object.freeze({ key: 'session-draft-test' }),
  sessionHandle: 'session-draft-test-handle'
});
const draftIds = Object.freeze({
  changeset: '019c1df7-86b5-769b-bba4-5f7097bfa701',
  revision: '019c1df7-86b5-769b-bba4-5f7097bfa702',
  handle: '019c1df7-86b5-769b-bba4-5f7097bfa703',
  timeline: '019c1df7-86b5-769b-bba4-5f7097bfa704'
});
const createInput = Object.freeze({
  action: 'create' as const,
  expectedCatalogVersion: 1,
  expectedCatalogDigestSha256: 'a'.repeat(64),
  title: 'Canonical Session',
  plannedDurationMinutes: 45,
  lifecycle: 'collecting' as const,
  formatId: '019c1df7-86b5-769b-bba4-5f7097bfa301',
  trackId: null
});
const head = Object.freeze({
  schemaVersion: 1 as const,
  scope,
  id: '019c1df7-86b5-769b-bba4-5f7097bfa201',
  title: 'Canonical Session',
  plannedDurationMinutes: 45,
  lifecycle: 'collecting' as const,
  programTarget: Object.freeze({
    setVersion: 1,
    setDigestSha256: 'b'.repeat(64),
    format: Object.freeze({
      kind: 'format' as const,
      id: '019c1df7-86b5-769b-bba4-5f7097bfa301',
      name: 'Talk',
      status: 'active' as const,
      version: 1
    }),
    track: null
  }),
  roster: Object.freeze({ version: 1, digestSha256: 'c'.repeat(64), participants: [] }),
  version: 1,
  digestSha256: 'd'.repeat(64),
  createdByUserId: userId,
  createdAt: now,
  updatedByUserId: userId,
  updatedAt: now
});
const contribution = Object.freeze({
  result: Object.freeze({
    kind: 'success' as const,
    data: Object.freeze({
      schemaVersion: 1 as const,
      action: 'create' as const,
      changesetId: draftIds.changeset,
      headVersion: 1,
      status: 'draft' as const,
      revision: Object.freeze({
        id: draftIds.revision, number: 1, digestSha256: 'e'.repeat(64)
      }),
      riskTier: 'normal' as const,
      approvalPolicy: SESSION_DRAFT_APPROVAL_POLICY,
      safeDiff: Object.freeze({ action: 'create' as const, before: null, after: head })
    })
  }),
  domain: Object.freeze({
    kind: 'session_changeset_draft' as const,
    preparationHandle: draftIds.handle,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    changesetId: draftIds.changeset,
    revisionId: draftIds.revision,
    revisionDigestSha256: 'e'.repeat(64),
    recordDigestSha256: 'f'.repeat(64),
    action: 'create' as const,
    sessionId: head.id,
    occurredAt: now
  }),
  receiptChildren: Object.freeze([Object.freeze({
    kind: 'timeline' as const,
    timelineId: draftIds.timeline,
    sourceKind: 'changeset_revision' as const,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    changesetId: draftIds.changeset,
    revisionId: draftIds.revision,
    occurredAt: now
  })])
});

const authorized: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
  resolve: (resolution: CurrentAuthorityResolutionInput<InvocationEvidence>) => Object.freeze({
    kind: 'authorized' as const,
    authority: Object.freeze({
      actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
      principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
      lane: resolution.lane,
      scope: resolution.scope,
      grants: Object.freeze([{ kind: 'permission' as const, key: SESSION_DRAFT_PERMISSION_ID }]),
      evidenceIds: Object.freeze(['membership:session-draft-test']),
      authorityCitationIds: Object.freeze([]),
      evaluatedAt: resolution.evaluatedAt
    })
  })
});
const denied: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
  resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'not_authorized' as const })
});

function draftModule(input: {
  readonly currentAuthority?: CurrentAuthorityResolver<InvocationEvidence>;
  readonly invocationId?: string;
} = {}) {
  return createSessionDraftOperationModule({
    workspaceId: scope.workspaceId,
    draftPolicy: SESSION_DRAFT_ACCESS_POLICY,
    currentAuthority: input.currentAuthority ?? denied,
    currentEvent: {
      resolveCurrentEvent: () => ({ eventId: scope.eventId, evidenceIds: ['event.current'] })
    },
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(input.invocationId ?? crypto.randomUUID()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: SESSION_DRAFT_REQUEST_HASH_PROFILE,
      keyBytes: new Uint8Array(32).fill(0x61)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: new Uint8Array(32).fill(0x62)
    })
  });
}

function readModule() {
  return createSessionOperationModule({
    workspaceId: scope.workspaceId,
    currentEvent: {
      resolveCurrentEvent: () => Object.freeze({
        eventId: scope.eventId,
        evidenceIds: Object.freeze(['event.current.selection'])
      })
    },
    readPolicy: SESSION_READ_ACCESS_POLICY,
    currentAuthority: denied,
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    sessions: { readSessionCatalog: () => createEmptySessionCatalog(scope) }
  });
}

async function draftContext(input: {
  readonly invocationId: string;
  readonly idempotencyKey: string;
}): Promise<EffectInvocationContext> {
  const builder = draftModule({
    currentAuthority: authorized, invocationId: input.invocationId
  }).source.effectContextBuilders?.[0];
  if (!builder) throw new TypeError('missing_session_draft_context_builder');
  const built = await builder.build({
    operationName: SESSION_CHANGE_DRAFT_OPERATION.name,
    operationVersion: SESSION_CHANGE_DRAFT_OPERATION.version,
    surface: 'operator_http',
    correlationId: parseCorrelationId('019c1df7-86b5-769b-bba4-5f7097bfa401'),
    businessInput: createInput,
    verifiedEvidence: evidence,
    rawIdempotencyKey: input.idempotencyKey
  });
  if (built.kind !== 'ready') throw new TypeError('expected_ready_session_draft_context');
  return built.context;
}

function handler(capability = SESSION_DRAFT_HANDLER_CAPABILITY) {
  return createSessionDraftHandler({
    reference: { key: 'handler.session.change-draft', version: 1 },
    handlerCapability: capability,
    contributionSchema: {
      key: 'schema.session.change-draft.contribution', version: 1, digestSha256: '0'.repeat(64)
    },
    canonicalResultSchema: {
      key: 'schema.session.change-draft.canonical-result', version: 1, digestSha256: '0'.repeat(64)
    }
  });
}

describe('Session changeset draft operation module', () => {
  test('registers one inert draft path beside the untouched catalog read', async () => {
    const registry = await createOperationRegistry(
      composeOperationRegistryModules([readModule(), draftModule()])
    );
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${SESSION_CATALOG_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/sessions'
    }]);
    expect(registry.operatorHttpEffectBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path,
      input: binding.input
    }))).toEqual([{
      operation: `${SESSION_CHANGE_DRAFT_OPERATION.name}@1`,
      method: 'POST',
      path: '/api/events/current/sessions/drafts',
      input: 'body'
    }]);
  });

  test('publishes the frozen draft schema identities and an idempotent low-risk contract', async () => {
    const registry = await createOperationRegistry(draftModule().source);
    const manifest = registry.safeManifest.operations.find((operation) =>
      operation.name === SESSION_CHANGE_DRAFT_OPERATION.name
    );
    expect(manifest).toMatchObject({
      version: 1,
      lifecycle: { status: 'active' },
      effect: 'draft',
      maxRisk: 'low',
      consequenceTags: ['changeset-drafted'],
      inputSchema: SESSION_OPERATION_SCHEMA_REFS.draft.inputSchema,
      idempotency: { required: true, requestHashProfile: SESSION_DRAFT_REQUEST_HASH_PROFILE },
      enabledBindings: [{
        surface: 'operator_http',
        protocol: 'http',
        method: 'POST',
        path: '/api/events/current/sessions/drafts',
        input: 'body',
        resultSchema: SESSION_OPERATION_SCHEMA_REFS.draft.resultSchema,
        browserResumption: { kind: 'none' }
      }]
    });
    expect(manifest?.outcomes.some((outcome) =>
      outcome.class === 'stale_revision' && outcome.kind === 'session.changed'
    )).toBe(true);
    expect(SESSION_DRAFT_REQUEST_HASH_PROFILE)
      .toEqual({ key: 'request-hash.session.change-draft', version: 1 });
    expect(SESSION_DRAFT_HANDLER_CAPABILITY)
      .toEqual({ key: 'capability.session.change-draft', version: 1 });
    expect(SESSION_DRAFT_ACCESS_POLICY).toEqual({
      key: 'authority.session.draft', version: parseContractVersion(1)
    });
    expect(SESSION_DRAFT_PERMISSION_ID).toBe('schedule.manage');
  });

  test('accepts only create and transition authoring from a browser', () => {
    expect(sessionAuthorInputSchema.safeParse(createInput).success).toBe(true);
    expect(sessionAuthorInputSchema.safeParse({
      action: 'transition',
      expectedCatalogVersion: 1,
      expectedCatalogDigestSha256: 'a'.repeat(64),
      sessionId: head.id,
      expectedSessionVersion: 1,
      expectedSessionDigestSha256: 'd'.repeat(64),
      to: 'programmed'
    }).success).toBe(true);
    for (const action of ['restore', 'delete']) {
      expect(sessionAuthorInputSchema.safeParse({ ...createInput, action }).success).toBe(false);
    }
    for (const field of [
      'scope', 'sessionId', 'actorUserId', 'occurredAt', 'changesetId', 'revisionId',
      'receiptId', 'approval'
    ]) {
      expect(sessionAuthorInputSchema.safeParse({
        ...createInput,
        [field]: field === 'scope' ? { ...scope } : crypto.randomUUID()
      }).success).toBe(false);
    }
  });

  test('accepts only coherent draft evidence and declared draft refusals', () => {
    expect(sessionDraftContributionSchema.parse(contribution))
      .toMatchObject({ domain: { action: 'create', sessionId: head.id } });
    for (const domain of [
      { ...contribution.domain, sessionId: '019c1df7-86b5-769b-bba4-5f7097bfa205' },
      { ...contribution.domain, action: 'transition' as const },
      { ...contribution.domain, eventId: '019c1df7-86b5-769b-bba4-5f7097bfa105' },
      { ...contribution.domain, changesetId: '019c1df7-86b5-769b-bba4-5f7097bfa705' },
      { ...contribution.domain, revisionDigestSha256: '9'.repeat(64) }
    ]) {
      expect(sessionDraftContributionSchema.safeParse({ ...contribution, domain }).success)
        .toBe(false);
    }
    const refusal = {
      result: {
        kind: 'outcome',
        outcome: {
          class: 'stale_revision', kind: 'session.changed', retryable: false,
          subjects: [{ type: 'session', id: head.id }],
          detail: { code: 'stale_catalog', action: 'create', sessionId: head.id },
          detailSchemaVersion: 1
        }
      },
      domain: null,
      receiptChildren: []
    };
    expect(sessionDraftContributionSchema.safeParse(refusal).success).toBe(true);
    expect(sessionDraftContributionSchema.safeParse({
      ...refusal,
      result: {
        kind: 'outcome',
        outcome: {
          ...refusal.result.outcome,
          detail: { code: 'stale_catalog', action: 'restore', sessionId: head.id }
        }
      }
    }).success).toBe(false);
  });

  test('refuses a substituted context, a foreign capability, and a second use', async () => {
    const expected = await draftContext({
      invocationId: '019c1df7-86b5-769b-bba4-5f7097bfa501',
      idempotencyKey: 'session-draft-first'
    });
    const other = await draftContext({
      invocationId: '019c1df7-86b5-769b-bba4-5f7097bfa502',
      idempotencyKey: 'session-draft-second'
    });
    const snapshot = sealSessionDraftPreparation({
      capability: SESSION_DRAFT_HANDLER_CAPABILITY,
      context: expected,
      preparation: {
        prepare: ({ context: received }) => {
          expect(received).toBe(expected);
          return contribution;
        }
      }
    });
    expect(() => handler().handle({
      businessInput: createInput, context: other, snapshot
    })).toThrow('invalid_session_draft_preparation');
    expect(() => handler({ key: 'capability.session.foreign', version: 1 }).handle({
      businessInput: createInput, context: expected, snapshot
    })).toThrow('invalid_session_draft_preparation');
    expect(handler().handle({ businessInput: createInput, context: expected, snapshot })).toEqual({
      result: contribution.result,
      domain: contribution.domain,
      receiptChildren: [...contribution.receiptChildren]
    });
    expect(() => handler().handle({
      businessInput: createInput, context: expected, snapshot
    })).toThrow('invalid_session_draft_preparation');
  });

  test('refuses a missing, asynchronous, or thenable preparation', async () => {
    const expected = await draftContext({
      invocationId: '019c1df7-86b5-769b-bba4-5f7097bfa503',
      idempotencyKey: 'session-draft-third'
    });
    expect(() => sealSessionDraftPreparation({
      capability: SESSION_DRAFT_HANDLER_CAPABILITY, context: expected, preparation: {} as never
    })).toThrow('session_draft_preparation_invalid');
    expect(() => sealSessionDraftPreparation({
      capability: SESSION_DRAFT_HANDLER_CAPABILITY,
      context: expected,
      preparation: { prepare: (async () => contribution) as never }
    })).toThrow('session_draft_preparation_must_be_synchronous');
    const thenable = sealSessionDraftPreparation({
      capability: SESSION_DRAFT_HANDLER_CAPABILITY,
      context: expected,
      preparation: { prepare: (() => ({ then() {} })) as never }
    });
    expect(() => handler().handle({
      businessInput: createInput, context: expected, snapshot: thenable
    })).toThrow('session_draft_preparation_must_be_synchronous');
  });

  test('denies an unauthorized draft with one declared access_denied outcome', async () => {
    const builder = draftModule().source.effectContextBuilders?.[0];
    if (!builder) throw new TypeError('missing_session_draft_context_builder');
    const built = await builder.build({
      operationName: SESSION_CHANGE_DRAFT_OPERATION.name,
      operationVersion: SESSION_CHANGE_DRAFT_OPERATION.version,
      surface: 'operator_http',
      correlationId: parseCorrelationId('019c1df7-86b5-769b-bba4-5f7097bfa402'),
      businessInput: createInput,
      verifiedEvidence: evidence,
      rawIdempotencyKey: 'session-draft-denied'
    });
    if (built.kind !== 'outcome') throw new TypeError('expected_denied_session_draft_context');
    expect(built.outcome).toMatchObject({
      class: 'access_denied', kind: 'authority.not_authorized', retryable: false, detail: null
    });
    const registry = await createOperationRegistry(draftModule().source);
    const manifest = registry.safeManifest.operations.find((operation) =>
      operation.name === SESSION_CHANGE_DRAFT_OPERATION.name
    );
    expect(manifest?.outcomes.filter((outcome) => outcome.class === 'access_denied')
      .map((outcome) => outcome.kind)).toContain(built.outcome.kind);
  });

  test('projects one canonical draft result into the frozen operator contract', () => {
    const projection = draftModule().source.projections[0];
    if (!projection) throw new TypeError('missing_session_draft_projection');
    const canonical = sessionDraftCanonicalResultSchema.parse(contribution.result);
    const projected = projection.project(canonical);
    expect(projected).toEqual(canonical);
    expect(sessionDraftOperationResultSchema.parse({
      ...canonical,
      receipt: {
        id: '019c1df7-86b5-769b-bba4-5f7097bfa601',
        operationName: SESSION_CHANGE_DRAFT_OPERATION.name,
        operationVersion: SESSION_CHANGE_DRAFT_OPERATION.version
      },
      correlationId: parseCorrelationId('019c1df7-86b5-769b-bba4-5f7097bfa402')
    })).toMatchObject({
      kind: 'success',
      data: {
        action: 'create',
        changesetId: draftIds.changeset,
        headVersion: 1,
        status: 'draft',
        revision: { id: draftIds.revision, number: 1 },
        safeDiff: { before: null }
      }
    });
    expect(sessionDraftOperationResultSchema.safeParse({
      ...canonical,
      correlationId: parseCorrelationId('019c1df7-86b5-769b-bba4-5f7097bfa402')
    }).success).toBe(false);
  });
});
