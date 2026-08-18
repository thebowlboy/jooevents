import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createOperationRegistry,
  createOperatorAuthorityPolicyCatalog,
  type EffectUnitOfWorkPort,
  type InvocationEvidence
} from '@jooevents/application';
import { createPublicEffectConformanceBoundary } from '@jooevents/application/public-effect-conformance';
import { INTAKE_OPERATION_SCHEMA_REFS } from '@jooevents/contracts';
import type { CurrentAuthorityResolver } from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseCorrelationId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parsePublicPolicyRevisionId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_EVENT_READ_ACCESS_POLICY,
  INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
  INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
  INTAKE_PUBLIC_MUTATE_OPERATION,
  INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
  INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS,
  INTAKE_SUBMISSION_READ_ACCESS_POLICY,
  createIntakePublicConformanceMutationOperationModule,
  createIntakePublicConformanceReadOperationModule,
  createIntakePublicFormReadOperationModule,
  createIntakeReadOperationModule,
  intakePublicMutateInputSchema
} from './module';
import {
  INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
  INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE,
  INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE,
  createIntakeFormWriteOperationModule
} from './form-write-module';

const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678901');
const eventId = '018f7d5a-4b3c-7abc-8def-012345678902';
const formId = '018f7d5a-4b3c-7abc-8def-012345678903';
const formVersionId = '018f7d5a-4b3c-7abc-8def-012345678904';
const draftId = '018f7d5a-4b3c-7abc-8def-012345678905';
const publicPolicyRevisionId = parsePublicPolicyRevisionId(
  '018f7d5a-4b3c-7abc-8def-012345678910'
);
const profile = Object.freeze({ key: 'intake.operation-test', version: parseContractVersion(1) });
const authority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
  resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'not_authorized' as const })
});
const policies = Object.freeze({
  eventRead: INTAKE_EVENT_READ_ACCESS_POLICY,
  eventManage: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  submissionRead: INTAKE_SUBMISSION_READ_ACCESS_POLICY,
  submissionContactRead: INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
  publicOpen: INTAKE_PUBLIC_OPEN_ACCESS_POLICY,
  publicCeremony: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY
});
const clock = Object.freeze({ now: () => '2026-08-12T12:00:00.000Z' as never });
let nextInvocation = 0;
const ids = Object.freeze({
  newInvocationId: () => parseInvocationId(
    `018f7d5a-4b3c-7abc-8def-${String(5678906 + nextInvocation++).padStart(12, '0')}`
  )
});
const crypto = Object.freeze({
  authorityPrincipalKeyProfile: profile,
  scopePartitionProfile: profile,
  requestCanonicalizationProfile: profile,
  requestHashSealer: createHmacRequestHashSealer({
    profile: { key: 'request-hash.application.public.mutate', version: parseContractVersion(1) },
    keyBytes: new Uint8Array(32).fill(0x41)
  }),
  idempotencyCredentialProfile: profile,
  idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
    profile,
    keyBytes: new Uint8Array(32).fill(0x42)
  })
});
const read = Object.freeze({
  listForms: () => ({
    schemaVersion: 1 as const,
    catalogVersion: 1,
    registryPin: { version: 1, digestSha256: '0'.repeat(64) },
    forms: []
  }),
  readForm: () => undefined,
  readServedForm: () => undefined,
  listSubmissions: () => [],
  listPersonSubmissions: () => ({ schemaVersion: 1 as const, rows: [], nextAfterSubmissionId: null }),
  readSubmission: () => undefined,
  readSubmissionContact: () => undefined,
  readPublicDraftResume: () => undefined
});

const unusedUnitOfWork: EffectUnitOfWorkPort = Object.freeze({
  findTerminalReceipt: () => undefined,
  recordShortOperationAudit: () => undefined,
  async runInUnitOfWork() { throw new TypeError('intake_test_effect_not_mounted'); }
});

const operatorEvidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'session-intake-test'
});

const allowedAuthority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
  resolve(resolution: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
    return Object.freeze({
      kind: 'authorized' as const,
      authority: Object.freeze({
        actor: Object.freeze({
          kind: 'workspace_user' as const,
          userId: parseUserId('018f7d5a-4b3c-7abc-8def-012345678906')
        }),
        principal: Object.freeze({
          kind: 'workspace_user' as const,
          userId: parseUserId('018f7d5a-4b3c-7abc-8def-012345678906'),
          membershipId: parseMembershipId('018f7d5a-4b3c-7abc-8def-012345678907')
        }),
        lane: resolution.lane,
        scope: resolution.scope,
        grants: Object.freeze([{ kind: 'permission' as const, key: 'event.read' }]),
        evidenceIds: Object.freeze(['membership:intake-test']),
        authorityCitationIds: Object.freeze([]),
        evaluatedAt: resolution.evaluatedAt
      })
    });
  }
});

const publicAuthority: CurrentAuthorityResolver<InvocationEvidence> = Object.freeze({
  resolve(resolution: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) {
    return Object.freeze({
      kind: 'authorized' as const,
      authority: Object.freeze({
        actor: Object.freeze({
          kind: 'public_request' as const,
          publicPolicyRevisionId,
          authority: Object.freeze({ kind: 'open_policy' as const })
        }),
        principal: Object.freeze({
          kind: 'public_capability' as const,
          publicPolicyRevisionId,
          authority: Object.freeze({ kind: 'open_policy' as const })
        }),
        lane: resolution.lane,
        scope: resolution.scope,
        grants: Object.freeze([{
          kind: 'public_policy' as const,
          key: INTAKE_PUBLIC_OPEN_ACCESS_POLICY.key
        }]),
        evidenceIds: Object.freeze(['public-policy:intake-test']),
        authorityCitationIds: Object.freeze([]),
        evaluatedAt: resolution.evaluatedAt
      })
    });
  }
});

const publicOpenEvidence: InvocationEvidence = Object.freeze({
  kind: 'public_open',
  surface: 'public_http',
  client: { key: 'web.public-application' },
  publicPolicyRevisionId
});

function endpointTable(module: ReturnType<typeof createIntakeReadOperationModule>) {
  return [
    ...(module.source.operations ?? []).flatMap((operation) => operation.bindings.flatMap((binding) =>
      binding.surface === 'operator_http' || binding.surface === 'public_http'
        ? [{
            operation: `${operation.name}@${operation.version}`,
            effect: operation.effect,
            method: binding.method,
            path: binding.path,
            input: binding.input,
            surface: binding.surface
          }]
        : []
    )),
    ...(module.source.effectOperations ?? []).flatMap((operation) => operation.bindings.flatMap((binding) =>
      binding.surface === 'operator_http' || binding.surface === 'public_http'
        ? [{
            operation: `${operation.name}@${operation.version}`,
            effect: operation.effect,
            method: binding.method,
            path: binding.path,
            input: binding.input,
            surface: binding.surface
          }]
        : []
    ))
  ];
}

describe('Intake operation modules', () => {
  test('freezes operator reads separately from isolated public reads', async () => {
    const operator = createIntakeReadOperationModule({
      workspaceId,
      policies,
      currentAuthority: authority,
      currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event:current'] }) },
      read,
      clock,
      ids,
      crypto
    });
    expect(endpointTable(operator)).toEqual([
      { operation: 'form.list@1', effect: 'read', method: 'GET', path: '/api/events/current/forms', input: 'query', surface: 'operator_http' },
      { operation: 'form.read@1', effect: 'read', method: 'GET', path: '/api/events/current/forms/detail', input: 'query', surface: 'operator_http' },
      { operation: 'submission.list@1', effect: 'read', method: 'GET', path: '/api/events/current/submissions', input: 'query', surface: 'operator_http' },
      { operation: 'submission.person.list@1', effect: 'read', method: 'GET', path: '/api/events/current/submissions/by-person', input: 'query', surface: 'operator_http' },
      { operation: 'submission.read@1', effect: 'read', method: 'GET', path: '/api/events/current/submissions/detail', input: 'query', surface: 'operator_http' },
      { operation: 'submission.contact.read@1', effect: 'read', method: 'GET', path: '/api/events/current/submissions/contact', input: 'query', surface: 'operator_http' },
      { operation: 'submission.contact.list@1', effect: 'read', method: 'GET', path: '/api/events/current/submissions/contacts', input: 'query', surface: 'operator_http' }
    ]);
    const registry = await createOperationRegistry(operator.source);
    const formList = registry.safeManifest.operations.find(
      (operation) => operation.name === 'form.list'
    );
    const submissionContact = registry.safeManifest.operations.find(
      (operation) => operation.name === 'submission.contact.read'
    );
    expect(formList?.inputSchema).toEqual(INTAKE_OPERATION_SCHEMA_REFS.formList.inputSchema);
    expect(formList?.enabledBindings[0]?.resultSchema)
      .toEqual(INTAKE_OPERATION_SCHEMA_REFS.formList.resultSchema);
    expect(submissionContact?.inputSchema)
      .toEqual(INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead.inputSchema);
    expect(submissionContact?.enabledBindings[0]?.resultSchema)
      .toEqual(INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead.resultSchema);
    const submissionContactList = registry.safeManifest.operations.find(
      (operation) => operation.name === 'submission.contact.list'
    );
    expect(submissionContactList?.inputSchema)
      .toEqual(INTAKE_OPERATION_SCHEMA_REFS.submissionContactList.inputSchema);
    expect(submissionContactList?.enabledBindings[0]?.resultSchema)
      .toEqual(INTAKE_OPERATION_SCHEMA_REFS.submissionContactList.resultSchema);

    const publicReads = createIntakePublicConformanceReadOperationModule({
      policies,
      currentAuthority: authority,
      publicFormScope: {
        resolve: () => ({ workspaceId, eventId, availability: 'open', evidenceIds: ['form:served'] })
      },
      ceremonyScope: {
        resolve: () => ({
          workspaceId,
          eventId,
          draftId,
          formId,
          formVersionId,
          authorityPartitionDigestSha256: 'a'.repeat(64),
          evidenceIds: ['ceremony:current']
        })
      },
      read,
      clock,
      ids,
      crypto
    });
    expect(endpointTable(publicReads)).toEqual([
      { operation: 'form.public.read@1', effect: 'read', method: 'GET', path: '/api/public/forms/current', input: 'query', surface: 'public_http' },
      { operation: 'application.public.resume@1', effect: 'read', method: 'GET', path: '/api/public/forms/application', input: 'query', surface: 'public_http' }
    ]);

    const openFormRead = createIntakePublicFormReadOperationModule({
      policy: policies.publicOpen,
      currentAuthority: authority,
      publicFormScope: {
        resolve: () => ({ workspaceId, eventId, availability: 'open', evidenceIds: ['form:served'] })
      },
      read,
      clock,
      ids,
      crypto
    });
    expect(endpointTable(openFormRead as ReturnType<typeof createIntakeReadOperationModule>))
      .toEqual([{
        operation: 'form.public.read@1', effect: 'read', method: 'GET',
        path: '/api/public/forms/current', input: 'query', surface: 'public_http'
      }]);
  });

  test('requires both current submission and contact grants under one policy', () => {
    expect(INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS).toEqual([
      'speaker.contact.read', 'submission.read'
    ]);
    const catalog = createOperatorAuthorityPolicyCatalog([{
      policy: INTAKE_SUBMISSION_CONTACT_READ_ACCESS_POLICY,
      permission: {
        kind: 'all_of',
        permissionIds: INTAKE_SUBMISSION_CONTACT_REQUIRED_PERMISSION_IDS
      }
    }]);
    expect(catalog.policies[0]?.permission).toEqual({
      kind: 'all_of', permissionIds: ['speaker.contact.read', 'submission.read']
    });
  });

  test('freezes one strict continuation-bound public ceremony only behind conformance', () => {
    const module = createIntakePublicConformanceMutationOperationModule({
      policy: INTAKE_PUBLIC_CEREMONY_ACCESS_POLICY,
      currentAuthority: authority,
      ceremonyScope: {
        resolve: () => ({
          workspaceId,
          eventId,
          draftId,
          formId,
          formVersionId,
          authorityPartitionDigestSha256: 'a'.repeat(64),
          evidenceIds: ['ceremony:current']
        })
      },
      publicEffectConformance: createPublicEffectConformanceBoundary(),
      clock,
      ids,
      crypto
    });
    expect(endpointTable(module as ReturnType<typeof createIntakeReadOperationModule>)).toEqual([{
      operation: `${INTAKE_PUBLIC_MUTATE_OPERATION.name}@1`,
      effect: 'commit',
      method: 'POST',
      path: '/api/public/forms/application/mutate',
      input: 'body',
      surface: 'public_http'
    }]);
    expect(intakePublicMutateInputSchema.safeParse({
      action: 'begin', input: { formId }
    }).success).toBe(true);
    expect(intakePublicMutateInputSchema.safeParse({
      action: 'save', input: { expectedDraftVersion: 1, answers: [] }
    }).success).toBe(true);
    expect(intakePublicMutateInputSchema.safeParse({
      action: 'submit', input: { expectedDraftVersion: 1 }
    }).success).toBe(true);
    for (const trusted of [
      { workspaceId }, { eventId }, { draftId }, { formVersionId },
      { authorityPartitionDigestSha256: 'a'.repeat(64) }, { actorUserId: formId }
    ]) {
      expect(intakePublicMutateInputSchema.safeParse({
        action: 'submit', input: { expectedDraftVersion: 1 }, ...trusted
      }).success).toBe(false);
    }
  });

  test('uses typed served-form availability for the shared closed-call outcome', async () => {
    let availability: 'open' | 'closed' = 'closed';
    let readCalls = 0;
    const module = createIntakePublicFormReadOperationModule({
      policy: policies.publicOpen,
      currentAuthority: publicAuthority,
      publicFormScope: {
        resolve: () => ({
          workspaceId,
          eventId,
          availability,
          evidenceIds: ['form:served']
        })
      },
      read: {
        readServedForm: () => {
          readCalls += 1;
          return undefined;
        }
      },
      clock,
      ids,
      crypto
    });
    const runtime = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
        newInvocationId: ids.newInvocationId
      },
      unitOfWork: unusedUnitOfWork
    });
    const execute = () => runtime.readExecutor.execute({
      operationName: 'form.public.read',
      operationVersion: 1,
      surface: 'public_http',
      correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678911'),
      businessInput: { formId },
      verifiedEvidence: publicOpenEvidence
    });

    await expect(execute()).resolves.toMatchObject({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'intake.form_closed',
        retryable: false,
        detail: null
      }
    });
    expect(readCalls).toBe(0);

    availability = 'open';
    await expect(execute()).resolves.toMatchObject({
      kind: 'outcome',
      outcome: { class: 'conflict', kind: 'intake.not_found' }
    });
    expect(readCalls).toBe(1);
  });

  test('freezes the direct and owner-native Form write bindings', () => {
    const module = createIntakeFormWriteOperationModule({
      workspaceId,
      policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
      currentAuthority: authority,
      currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event:current'] }) },
      clock,
      ids,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      directRequestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x51)
      }),
      reviewRequestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x52)
      }),
      publishRequestHashSealer: createHmacRequestHashSealer({
        profile: INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE,
        keyBytes: new Uint8Array(32).fill(0x53)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: crypto.idempotencyCredentialSealer
    });
    expect(endpointTable(module as ReturnType<typeof createIntakeReadOperationModule>)).toEqual([
      { operation: 'form.definition.create@1', effect: 'commit', method: 'POST', path: '/api/events/current/forms/create', input: 'body', surface: 'operator_http' },
      { operation: 'form.definition.revise@1', effect: 'commit', method: 'POST', path: '/api/events/current/forms/revise', input: 'body', surface: 'operator_http' },
      { operation: 'form.closing.change@1', effect: 'commit', method: 'POST', path: '/api/events/current/forms/closing', input: 'body', surface: 'operator_http' },
      { operation: 'form.lifecycle.change@1', effect: 'commit', method: 'POST', path: '/api/events/current/forms/lifecycle', input: 'body', surface: 'operator_http' },
      { operation: 'form.version.publish.draft@1', effect: 'draft', method: 'POST', path: '/api/events/current/forms/publish/draft', input: 'body', surface: 'operator_http' },
      { operation: 'form.version.publish@1', effect: 'commit', method: 'POST', path: '/api/events/current/forms/publish', input: 'body', surface: 'operator_http' }
    ]);
    const publish = module.source.effectOperations?.find((operation) =>
      operation.name === 'form.version.publish'
    );
    expect(publish?.execution).toMatchObject({
      profile: 'direct_audited',
      history: { summariesByAction: {
        publish: 'Published a form version',
        publish_and_open: 'Published and opened a form'
      } }
    });
  });

  test('fails closed on substituted policy references', () => {
    expect(() => createIntakeReadOperationModule({
      workspaceId,
      policies: { ...policies, submissionContactRead: INTAKE_SUBMISSION_READ_ACCESS_POLICY },
      currentAuthority: authority,
      currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: [] }) },
      read,
      clock,
      ids,
      crypto
    })).toThrow('intake_submission_contact_policy_catalog_mismatch');
  });

  test('returns the registered event-required outcome before an operator read port is called', async () => {
    let readCalls = 0;
    const module = createIntakeReadOperationModule({
      workspaceId,
      policies,
      currentAuthority: allowedAuthority,
      currentEvent: { resolveCurrentEvent: () => ({ evidenceIds: ['event:none'] }) },
      read: {
        ...read,
        listForms: () => {
          readCalls += 1;
          throw new TypeError('read port must not run without an Event');
        }
      },
      clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
      ids,
      crypto
    });
    const runtime = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
        newInvocationId: ids.newInvocationId
      },
      unitOfWork: unusedUnitOfWork
    });
    const correlationId = parseCorrelationId(
      '018f7d5a-4b3c-7abc-8def-012345678909'
    );

    await expect(runtime.readExecutor.execute({
      operationName: 'form.list',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: {},
      verifiedEvidence: operatorEvidence
    })).resolves.toEqual({
      kind: 'outcome',
      outcome: {
        class: 'conflict',
        kind: 'intake.event_required',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      },
      correlationId
    });
    expect(readCalls).toBe(0);
  });

  test('refuses hostile read ports that substitute requested resource identities', async () => {
    const otherId = '018f7d5a-4b3c-7abc-8def-012345678999';
    const module = createIntakeReadOperationModule({
      workspaceId,
      policies,
      currentAuthority: allowedAuthority,
      currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event:current'] }) },
      read: {
        ...read,
        readForm: () => ({ head: { id: otherId, scope: { workspaceId, eventId } } }) as never,
        readSubmission: () => ({
          schemaVersion: 1,
          submissionId: otherId,
          formId,
          formVersionId,
          submittedAt: '2026-08-12T12:00:00.000Z',
          participantCount: 1,
          answeredFieldIds: [],
          affirmedConsentFieldIds: []
        }) as never,
        readSubmissionContact: () => ({
          schemaVersion: 1,
          submissionId: otherId,
          personId: otherId,
          participantIdentityId: otherId,
          sourceFieldId: otherId,
          email: 'speaker@example.com'
        })
      },
      clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
      ids,
      crypto
    });
    const runtime = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
        newInvocationId: ids.newInvocationId
      },
      unitOfWork: unusedUnitOfWork
    });
    const execute = (operationName: string, businessInput: unknown) =>
      runtime.readExecutor.execute({
        operationName,
        operationVersion: 1,
        surface: 'operator_http',
        correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678908'),
        businessInput,
        verifiedEvidence: operatorEvidence
      });
    await expect(execute('form.read', { formId })).rejects
      .toThrow('Operation execution failed during handler.');
    await expect(execute('submission.read', { submissionId: draftId })).rejects
      .toThrow('Operation execution failed during handler.');
    await expect(execute('submission.contact.read', { submissionId: draftId })).rejects
      .toThrow('Operation execution failed during handler.');
    await expect(execute('submission.contact.list', { submissionIds: [draftId] })).rejects
      .toThrow('Operation execution failed during handler.');
  });

  test('lists only found contacts under the same contact policy, omitting missing ids', async () => {
    const foundId = '018f7d5a-4b3c-7abc-8def-012345678901';
    const missingId = '018f7d5a-4b3c-7abc-8def-012345678902';
    const contact = {
      schemaVersion: 1 as const,
      submissionId: foundId,
      personId: foundId,
      participantIdentityId: foundId,
      sourceFieldId: foundId,
      email: 'speaker@example.com'
    };
    const module = createIntakeReadOperationModule({
      workspaceId,
      policies,
      currentAuthority: allowedAuthority,
      currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event:current'] }) },
      read: {
        ...read,
        readSubmissionContact: (_scope, submissionId) =>
          submissionId === foundId ? contact : undefined
      },
      clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
      ids,
      crypto
    });
    const runtime = await createApplicationOperationRuntime({
      source: module.source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => parseInstant('2026-08-12T12:00:00.000Z') },
        newInvocationId: ids.newInvocationId
      },
      unitOfWork: unusedUnitOfWork
    });
    const result = await runtime.readExecutor.execute({
      operationName: 'submission.contact.list',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678908'),
      businessInput: { submissionIds: [missingId, foundId] },
      verifiedEvidence: operatorEvidence
    });
    expect(result).toMatchObject({
      kind: 'success',
      data: { schemaVersion: 1, rows: [contact] }
    });
  });
});
