import { describe, expect, test } from 'bun:test';
import {
  createEffectfulOperationResultSchema,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  parseEventId,
  parseContractVersion,
  parseInstant,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type ResolvedScope
} from '@jooevents/kernel';
import {
  parseOperationAccessLane,
  type AuthorizationRepository,
  type MembershipRepository,
  type PermissionId,
  type RoleAssignment,
  type WorkspaceMembership
} from '@jooevents/identity-access';
import { z } from 'zod';
import { createOperationAutonomyPolicy } from './autonomy';
import type { InvocationEvidence } from './operations/invocation-context';
import {
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  createEffectInvocationContextBuilder,
  createReadInvocationContextBuilder
} from './operations/invocation-context';
import { createSingleUnitOfWorkConformanceFixture } from './operations/phase-autonomy-fixture';
import { createOperationRegistry } from './operations/registry';
import type { OperationRegistrySource } from './operations/types';
import {
  assertOperatorAuthorityPolicyCatalogCoversOperationRegistry,
  createOperatorAuthorityPolicyCatalog,
  createOperatorCurrentAuthorityResolver,
  type CurrentOperatorSessionRepository,
  type OperatorAuthorityPolicyRegistration,
  type OperatorScopeRelationshipValidator
} from './operator-authority';

const now = parseInstant('2026-08-12T06:00:00.000Z');
const later = parseInstant('2026-08-12T06:01:00.000Z');
const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678901');
const otherWorkspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678902');
const userId = parseUserId('018f7d5a-4b3c-7abc-8def-012345678903');
const membershipId = parseMembershipId('018f7d5a-4b3c-7abc-8def-012345678904');
const eventId = parseEventId('018f7d5a-4b3c-7abc-8def-012345678905');
const contractVersion1 = parseContractVersion(1);
const lane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'event.read', version: 1 }
});
const evidence: Extract<InvocationEvidence, { readonly kind: 'operator' }> = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'operator-authority-test' }),
  sessionHandle: 'session_z'
});
const workspaceScope: ResolvedScope = Object.freeze({
  workspaceId,
  subjects: Object.freeze([]),
  resolutionEvidenceIds: Object.freeze(['scope-resolution'])
});
const operationScope: ResolvedScope = Object.freeze({
  workspaceId,
  eventId,
  subjects: Object.freeze([
    { kind: 'workspace' as const, id: workspaceId },
    { kind: 'event' as const, id: eventId },
    {
      kind: 'domain' as const,
      domain: 'operation',
      entity: 'owner',
      id: 'program_vocabulary'
    }
  ]),
  resolutionEvidenceIds: Object.freeze(['operation-owner-resolution'])
});

const operationPermissionRegistration: OperatorAuthorityPolicyRegistration = Object.freeze({
  policy: lane.policy,
  permission: Object.freeze({
    kind: 'domain_subject' as const,
    domain: 'operation',
    entity: 'owner',
    mappings: Object.freeze([
      Object.freeze({ id: 'program_vocabulary', permissionId: 'program.vocabulary.manage' as const })
    ])
  })
});

function definitionRef(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return Object.freeze({ key, version: 1, digestSha256: seed.repeat(64) });
}

async function operatorReadAndEffectRegistry() {
  const readOperation = Object.freeze({ name: 'catalog.read', version: 1 });
  const effectOperation = Object.freeze({ name: 'catalog.draft', version: 1, effect: 'draft' as const });
  const manageLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: { key: 'event.manage', version: 1 }
  });
  const refs = Object.freeze({
    input: schemaRef('schema.catalog.input', '1'),
    readCanonical: schemaRef('schema.catalog.read-canonical', '2'),
    readProjected: schemaRef('schema.catalog.read-projected', '3'),
    effectContribution: schemaRef('schema.catalog.effect-contribution', '4'),
    effectCanonical: schemaRef('schema.catalog.effect-canonical', '5'),
    effectProjected: schemaRef('schema.catalog.effect-projected', '6'),
    nullDetail: schemaRef('schema.catalog.null-detail', '7'),
    readContext: definitionRef('context.catalog.read'),
    effectContext: definitionRef('context.catalog.effect'),
    readAutonomy: definitionRef('autonomy.catalog.read'),
    effectAutonomy: definitionRef('autonomy.catalog.effect'),
    readCapability: definitionRef('capability.catalog.read'),
    effectCapability: definitionRef('capability.catalog.effect'),
    readHandler: definitionRef('handler.catalog.read'),
    effectHandler: definitionRef('handler.catalog.effect'),
    readProjection: definitionRef('projection.catalog.read'),
    effectProjection: definitionRef('projection.catalog.effect'),
    trace: definitionRef('trace.catalog.read'),
    audit: definitionRef('audit.catalog.effect'),
    recordProfile: definitionRef('record-profile.catalog'),
    keySource: definitionRef('idempotency.catalog'),
    requestHash: definitionRef('request-hash.catalog'),
    concurrency: definitionRef('concurrency.catalog')
  });
  const inputSchema = z.strictObject({});
  const readCanonicalSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('success'), data: z.strictObject({ value: z.string() }) }),
    z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
  ]);
  const readProjectedSchema = createReadOperationResultSchema(z.strictObject({ value: z.string() }));
  const effectCanonicalSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('success'), data: z.strictObject({ value: z.string() }) }),
    z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
  ]);
  const effectProjectedSchema = createEffectfulOperationResultSchema(z.strictObject({ value: z.string() }));
  const effectContributionSchema = z.strictObject({
    result: effectCanonicalSchema,
    domain: z.null(),
    effectContributions: z.array(z.never())
  });
  const readAutonomy = createOperationAutonomyPolicy({
    definition: refs.readAutonomy,
    operation: readOperation,
    riskFloor: 'low',
    unattendedRiskCeiling: 'low',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    },
    requiresSeparateApproval: false
  });
  const effectAutonomy = createOperationAutonomyPolicy({
    ...readAutonomy,
    definition: refs.effectAutonomy,
    operation: effectOperation
  });
  const phases = createSingleUnitOfWorkConformanceFixture({
    operation: effectOperation,
    maximumRisk: 'low',
    consequenceTags: [],
    autonomyPolicy: effectAutonomy,
    handler: refs.effectHandler,
    handlerCapability: refs.effectCapability,
    contributionSchema: refs.effectContribution,
    nullDetailSchema: refs.nullDetail
  });
  const scopeResolver = Object.freeze({ resolve: () => workspaceScope });
  const authorityResolver = Object.freeze({
    resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'not_authorized' as const })
  });
  const clock = Object.freeze({ now: () => now });
  const keyProfile = Object.freeze({ key: 'key-profile.catalog', version: contractVersion1 });
  const readContext = createReadInvocationContextBuilder({
    reference: refs.readContext,
    operation: readOperation,
    effect: 'read',
    lanes: [lane],
    scopeResolver,
    authorityResolver,
    clock,
    newInvocationId: () => '018f7d5a-4b3c-7abc-8def-012345678906' as never,
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    deniedAuthorityOutcome: () => ({
      class: 'access_denied', kind: 'authority.denied', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const effectContext = createEffectInvocationContextBuilder({
    reference: refs.effectContext,
    operation: effectOperation,
    effect: 'draft',
    lanes: [manageLane],
    scopeResolver,
    authorityResolver,
    clock,
    newInvocationId: () => '018f7d5a-4b3c-7abc-8def-012345678907' as never,
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    requestHashProfile: refs.requestHash,
    requestHashSealer: createHmacRequestHashSealer({
      profile: refs.requestHash,
      keyBytes: new Uint8Array(32).fill(0x41)
    }),
    idempotencyCredentialProfile: keyProfile,
    idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
      profile: keyProfile,
      keyBytes: new Uint8Array(32).fill(0x42)
    }),
    deniedAuthorityOutcome: () => ({
      class: 'access_denied', kind: 'authority.denied', retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const source: OperationRegistrySource = {
    ...phases.registrations,
    autonomyPolicies: [readAutonomy, effectAutonomy],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.readCanonical, schema: readCanonicalSchema },
      { reference: refs.readProjected, schema: readProjectedSchema },
      { reference: refs.effectContribution, schema: effectContributionSchema },
      { reference: refs.effectCanonical, schema: effectCanonicalSchema },
      { reference: refs.effectProjected, schema: effectProjectedSchema },
      { reference: refs.nullDetail, schema: z.null() }
    ],
    contextBuilders: [readContext],
    readCapabilities: [{ reference: refs.readCapability, openSnapshot: () => ({}) }],
    handlers: [{
      reference: refs.readHandler,
      readCapability: refs.readCapability,
      canonicalResultSchema: refs.readCanonical,
      handle: () => ({ kind: 'success', data: { value: 'read' } })
    }],
    projections: [{
      reference: refs.readProjection,
      canonicalResultSchema: refs.readCanonical,
      projectedResultSchema: refs.readProjected,
      project: (value) => value
    }, {
      reference: refs.effectProjection,
      canonicalResultSchema: refs.effectCanonical,
      projectedResultSchema: refs.effectProjected,
      project: (value) => value
    }],
    readOperationalTraceTargets: [{
      reference: refs.trace, kind: 'read_operational_trace_record', recordProfile: refs.recordProfile
    }],
    operationAuditTargets: [{
      reference: refs.audit, kind: 'operation_audit_record', recordProfile: refs.recordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: refs.recordProfile, kind: 'canonical_json', maximumBytes: 16_384
    }],
    operations: [{
      ...readOperation,
      lifecycle: { status: 'active' },
      summary: 'Read catalog fixture.',
      effect: 'read', maxRisk: 'low', autonomyPolicy: refs.readAutonomy, consequenceTags: [],
      inputSchema: refs.input, canonicalResultSchema: refs.readCanonical,
      outcomes: [{
        class: 'access_denied', kind: 'authority.denied', retryable: false,
        detailSchema: refs.nullDetail
      }],
      accessLanes: [lane], contextBuilder: refs.readContext,
      readCapability: refs.readCapability, handler: refs.readHandler,
      observability: { trace: { mode: 'required', target: refs.trace }, immutableAudit: { mode: 'none' } },
      bindings: [{
        surface: 'operator_http', method: 'GET', path: '/api/catalog', input: 'query',
        browserResumption: { kind: 'none' }, projection: refs.readProjection
      }]
    }],
    effectContextBuilders: [effectContext],
    effectHandlers: [{
      reference: refs.effectHandler,
      effect: 'draft',
      handlerCapability: refs.effectCapability,
      contributionSchema: refs.effectContribution,
      canonicalResultSchema: refs.effectCanonical,
      handle: () => ({
        result: { kind: 'success', data: { value: 'draft' } }, domain: null, effectContributions: []
      })
    }],
    effectOperations: [{
      ...effectOperation,
      lifecycle: { status: 'active' },
      summary: 'Draft catalog fixture.',
      maxRisk: 'low', autonomyPolicy: refs.effectAutonomy, consequenceTags: [],
      inputSchema: refs.input, contributionSchema: refs.effectContribution,
      canonicalResultSchema: refs.effectCanonical,
      outcomes: [{
        class: 'idempotency_conflict', kind: 'operation.request_changed', retryable: false,
        detailSchema: refs.nullDetail
      }, phases.contentionOutcomeDeclaration, ...phases.outcomeDeclarations],
      accessLanes: [manageLane], contextBuilder: refs.effectContext,
      handlerCapability: refs.effectCapability, handler: refs.effectHandler,
      audit: { mode: 'required', target: refs.audit },
      idempotency: {
        keySource: refs.keySource, credentialVerifierProfile: keyProfile,
        requestHashProfile: refs.requestHash
      },
      concurrency: refs.concurrency,
      execution: phases.execution,
      bindings: [{
        surface: 'operator_http', method: 'POST', path: '/api/catalog/drafts', input: 'body',
        browserResumption: { kind: 'none' }, projection: refs.effectProjection
      }]
    }]
  };
  return createOperationRegistry(source);
}

function membership(status: WorkspaceMembership['status'] = 'active'): WorkspaceMembership {
  return Object.freeze({
    id: membershipId,
    workspaceId,
    userId,
    status,
    approvedAt: '2026-08-12T05:00:00.000Z',
    createdAt: '2026-08-12T04:00:00.000Z',
    updatedAt: '2026-08-12T05:00:00.000Z',
    version: 1
  });
}

function fixture(input: {
  readonly expiresAt?: string;
  readonly scopeRelationships?: OperatorScopeRelationshipValidator;
  readonly policyRegistration?: OperatorAuthorityPolicyRegistration;
  readonly rolePermissionIds?: readonly PermissionId[];
} = {}) {
  let currentMembership: WorkspaceMembership | undefined = membership();
  let assignments: readonly RoleAssignment[] = Object.freeze([
    Object.freeze({
      id: 'assignment_z',
      userId,
      roleId: 'role_reader',
      scope: Object.freeze({ kind: 'workspace' as const, workspaceId }),
      assignedAt: '2026-08-12T05:00:00.000Z'
    }),
    Object.freeze({
      id: 'assignment_a',
      userId,
      roleId: 'role_reader',
      scope: Object.freeze({ kind: 'workspace' as const, workspaceId }),
      assignedAt: '2026-08-12T05:00:00.000Z'
    }),
    Object.freeze({
      id: 'assignment_a',
      userId,
      roleId: 'role_reader',
      scope: Object.freeze({ kind: 'workspace' as const, workspaceId }),
      assignedAt: '2026-08-12T05:00:00.000Z'
    })
  ]);
  const sessions: CurrentOperatorSessionRepository = Object.freeze({
    resolveCurrent() {
      return Object.freeze({
        kind: 'current' as const,
        session: Object.freeze({
          sessionId: evidence.sessionHandle,
          authUserId: 'auth_z',
          userId,
          expiresAt: parseInstant(input.expiresAt ?? '2026-08-12T07:00:00.000Z'),
          evidenceIds: Object.freeze(['session:z', 'session:a', 'session:a'])
        })
      });
    }
  });
  const memberships: MembershipRepository = Object.freeze({
    async find() { return currentMembership; }
  });
  const authorization: AuthorizationRepository = Object.freeze({
    async listRoles() {
      return Object.freeze([Object.freeze({
        id: 'role_reader',
        workspaceId,
        name: 'Reader',
        description: 'Reads events',
        permissionIds: Object.freeze([...(input.rolePermissionIds ?? ['event.read' as const])])
      })]);
    },
    async listAssignments() { return assignments; },
    async listOverrides() { return Object.freeze([]); }
  });
  const scopeRelationships = input.scopeRelationships ?? Object.freeze({
    validate() {
      return Object.freeze({
        kind: 'valid' as const,
        evidenceIds: Object.freeze(['scope:z', 'scope:a', 'scope:a'])
      });
    }
  });
  const policies = createOperatorAuthorityPolicyCatalog([input.policyRegistration ?? {
    policy: lane.policy,
    permissionId: 'event.read'
  }]);
  const resolver = createOperatorCurrentAuthorityResolver({
    workspaceId,
    policies,
    sessions,
    memberships,
    authorization,
    scopeRelationships
  });
  return {
    resolver,
    setMembership(value: WorkspaceMembership | undefined) { currentMembership = value; },
    setAssignments(value: readonly RoleAssignment[]) { assignments = value; }
  };
}

function resolutionInput(scope: ResolvedScope = workspaceScope, evaluatedAt = now) {
  return Object.freeze({
    operation: Object.freeze({ name: 'event.read', version: 1, effect: 'read' as const }),
    evidence,
    lane,
    scope,
    evaluatedAt
  });
}

describe('ordinary operator current authority', () => {
  test('seals canonical all-of permissions and rejects duplicates or undersized rules', () => {
    const first = createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'all_of',
        permissionIds: ['submission.read', 'speaker.contact.read']
      }
    }]);
    const permuted = createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'all_of',
        permissionIds: ['speaker.contact.read', 'submission.read']
      }
    }]);
    expect(first.policies).toEqual(permuted.policies);
    expect(first.policies[0]?.permission).toEqual({
      kind: 'all_of',
      permissionIds: ['speaker.contact.read', 'submission.read']
    });
    expect(Object.isFrozen(
      first.policies[0]?.permission.kind === 'all_of'
        ? first.policies[0].permission.permissionIds
        : undefined
    )).toBe(true);

    expect(() => createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'all_of',
        permissionIds: ['submission.read', 'submission.read']
      }
    }])).toThrow('Operator authority all-of permissions must be unique');
    expect(() => createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'all_of',
        permissionIds: ['submission.read']
      } as never
    }])).toThrow('Operator authority all-of rule is invalid');
  });

  test('requires every all-of permission from one current authority snapshot', async () => {
    const registration: OperatorAuthorityPolicyRegistration = {
      policy: lane.policy,
      permission: {
        kind: 'all_of',
        permissionIds: ['submission.read', 'speaker.contact.read']
      }
    };
    const allPresent = await fixture({
      policyRegistration: registration,
      rolePermissionIds: ['speaker.contact.read', 'submission.read']
    }).resolver.resolve(resolutionInput());
    expect(allPresent.kind).toBe('authorized');
    if (allPresent.kind === 'authorized') {
      expect(allPresent.authority.grants).toEqual([
        { kind: 'permission', key: 'speaker.contact.read' },
        { kind: 'permission', key: 'submission.read' }
      ]);
      expect(allPresent.authority.evaluatedAt).toBe(now);
      expect(allPresent.authority.evidenceIds).toEqual(
        [...new Set(allPresent.authority.evidenceIds)].sort()
      );
    }

    for (const rolePermissionIds of [
      ['submission.read'] as const,
      ['speaker.contact.read'] as const
    ]) {
      expect(await fixture({
        policyRegistration: registration,
        rolePermissionIds
      }).resolver.resolve(resolutionInput())).toEqual({
        kind: 'denied', reason: 'not_authorized'
      });
    }
  });

  test('seals and canonicalizes domain-subject mappings while rejecting ambiguous mappings', () => {
    const catalog = createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'domain_subject',
        domain: 'operation',
        entity: 'owner',
        mappings: [
          { id: 'program_vocabulary', permissionId: 'program.vocabulary.manage' },
          { id: 'form_definition', permissionId: 'event.manage' },
          {
            id: 'workspace_team',
            anyOfPermissionIds: [
              'access.users.suspend',
              'access.roles.manage',
              'access.users.invite'
            ]
          }
        ]
      }
    }]);
    const rule = catalog.policies[0]?.permission;
    expect(rule?.kind).toBe('domain_subject');
    if (rule?.kind === 'domain_subject') {
      expect(rule.mappings).toEqual([
        { id: 'form_definition', permissionId: 'event.manage' },
        { id: 'program_vocabulary', permissionId: 'program.vocabulary.manage' },
        {
          id: 'workspace_team',
          anyOfPermissionIds: [
            'access.roles.manage',
            'access.users.invite',
            'access.users.suspend'
          ]
        }
      ]);
      expect(Object.isFrozen(rule.mappings)).toBe(true);
      expect(Object.isFrozen(rule.mappings[0])).toBe(true);
    }

    expect(() => createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'domain_subject',
        domain: 'operation',
        entity: 'owner',
        mappings: [
          { id: 'program_vocabulary', permissionId: 'event.manage' },
          { id: 'program_vocabulary', permissionId: 'program.vocabulary.manage' }
        ]
      }
    }])).toThrow('Duplicate operator authority domain-subject mapping');
    expect(() => createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'domain_subject',
        domain: 'operation',
        entity: 'owner',
        mappings: [{ id: 'program_vocabulary', permissionId: 'unknown.permission' as PermissionId }]
      }
    }])).toThrow('Operator authority domain-subject mapping is invalid');
    expect(() => createOperatorAuthorityPolicyCatalog([{
      policy: lane.policy,
      permission: {
        kind: 'domain_subject',
        domain: 'operation',
        entity: 'owner',
        mappings: [{
          id: 'workspace_team',
          anyOfPermissionIds: ['access.users.invite', 'access.users.invite']
        }]
      }
    }])).toThrow('Operator authority domain-subject any-of permissions must be unique');
  });

  test('admits a domain owner through any held coarse permission and cites only held grants', async () => {
    const registration: OperatorAuthorityPolicyRegistration = Object.freeze({
      policy: lane.policy,
      permission: Object.freeze({
        kind: 'domain_subject' as const,
        domain: 'operation',
        entity: 'owner',
        mappings: Object.freeze([Object.freeze({
          id: 'workspace_team',
          anyOfPermissionIds: Object.freeze([
            'access.roles.manage',
            'access.users.invite',
            'access.users.suspend'
          ] as const)
        })])
      })
    });
    const teamScope: ResolvedScope = Object.freeze({
      workspaceId,
      subjects: Object.freeze([
        { kind: 'workspace' as const, id: workspaceId },
        {
          kind: 'domain' as const,
          domain: 'operation',
          entity: 'owner',
          id: 'workspace_team'
        }
      ]),
      resolutionEvidenceIds: Object.freeze(['operation-owner-resolution'])
    });

    for (const permissionId of [
      'access.roles.manage',
      'access.users.invite',
      'access.users.suspend'
    ] as const) {
      const result = await fixture({
        policyRegistration: registration,
        rolePermissionIds: [permissionId]
      }).resolver.resolve(resolutionInput(teamScope));
      expect(result.kind).toBe('authorized');
      if (result.kind === 'authorized') {
        expect(result.authority.grants).toEqual([{ kind: 'permission', key: permissionId }]);
      }
    }

    const multiple = await fixture({
      policyRegistration: registration,
      rolePermissionIds: ['access.users.suspend', 'access.users.invite']
    }).resolver.resolve(resolutionInput(teamScope));
    expect(multiple.kind).toBe('authorized');
    if (multiple.kind === 'authorized') {
      expect(multiple.authority.grants).toEqual([
        { kind: 'permission', key: 'access.users.invite' },
        { kind: 'permission', key: 'access.users.suspend' }
      ]);
    }

    expect(await fixture({
      policyRegistration: registration,
      rolePermissionIds: ['event.read']
    }).resolver.resolve(resolutionInput(teamScope))).toEqual({
      kind: 'denied', reason: 'not_authorized'
    });
  });

  test('derives one exact permission from one authenticated domain subject', async () => {
    const authorized = fixture({
      policyRegistration: operationPermissionRegistration,
      rolePermissionIds: ['program.vocabulary.manage']
    });
    const result = await authorized.resolver.resolve(resolutionInput(operationScope));
    expect(result.kind).toBe('authorized');
    if (result.kind === 'authorized') {
      expect(result.authority.grants).toEqual([
        { kind: 'permission', key: 'program.vocabulary.manage' }
      ]);
    }

    const unmapped = Object.freeze({
      ...operationScope,
      subjects: Object.freeze(operationScope.subjects.map((subject) =>
        subject.kind === 'domain' ? Object.freeze({ ...subject, id: 'form_definition' }) : subject
      ))
    });
    expect(await authorized.resolver.resolve(resolutionInput(unmapped))).toEqual({
      kind: 'denied', reason: 'cross_scope'
    });

    const missing = Object.freeze({
      ...operationScope,
      subjects: Object.freeze(operationScope.subjects.filter((subject) =>
        subject.kind !== 'domain'
      ))
    });
    expect(await authorized.resolver.resolve(resolutionInput(missing))).toEqual({
      kind: 'denied', reason: 'cross_scope'
    });

    const multiple = Object.freeze({
      ...operationScope,
      subjects: Object.freeze([
        ...operationScope.subjects,
        { kind: 'domain' as const, domain: 'operation', entity: 'owner', id: 'form_definition' }
      ])
    });
    expect(await authorized.resolver.resolve(resolutionInput(multiple))).toEqual({
      kind: 'denied', reason: 'cross_scope'
    });

    const extra = Object.freeze({
      ...operationScope,
      subjects: Object.freeze([
        ...operationScope.subjects,
        { kind: 'workspace_user' as const, id: userId }
      ])
    });
    expect(await authorized.resolver.resolve(resolutionInput(extra))).toEqual({
      kind: 'denied', reason: 'cross_scope'
    });
  });

  test('requires exact policy coverage for every enabled operator read and effect binding', async () => {
    const registry = await operatorReadAndEffectRegistry();
    const exact = createOperatorAuthorityPolicyCatalog([{
      policy: { key: 'event.read', version: contractVersion1 }, permissionId: 'event.read'
    }, {
      policy: { key: 'event.manage', version: contractVersion1 }, permissionId: 'event.manage'
    }]);
    expect(() => assertOperatorAuthorityPolicyCatalogCoversOperationRegistry({
      catalog: exact,
      registry
    })).not.toThrow();

    const missingEffect = createOperatorAuthorityPolicyCatalog([{
      policy: { key: 'event.read', version: contractVersion1 }, permissionId: 'event.read'
    }]);
    expect(() => assertOperatorAuthorityPolicyCatalogCoversOperationRegistry({
      catalog: missingEffect,
      registry
    })).toThrow('Operator authority policy is not mapped for catalog.draft@1');

    const wrongRead = createOperatorAuthorityPolicyCatalog([{
      policy: { key: 'authority.wrong-read', version: contractVersion1 }, permissionId: 'event.read'
    }, {
      policy: { key: 'event.manage', version: contractVersion1 }, permissionId: 'event.manage'
    }]);
    expect(() => assertOperatorAuthorityPolicyCatalogCoversOperationRegistry({
      catalog: wrongRead,
      registry
    })).toThrow('Operator authority policy is not mapped for catalog.read@1');
  });

  test('does not activate an unused authority policy catalog entry', async () => {
    const registry = await operatorReadAndEffectRegistry();
    const withUnused = createOperatorAuthorityPolicyCatalog([{
      policy: { key: 'authority.unused', version: contractVersion1 }, permissionId: 'event.read'
    }, {
      policy: { key: 'event.read', version: contractVersion1 }, permissionId: 'event.read'
    }, {
      policy: { key: 'event.manage', version: contractVersion1 }, permissionId: 'event.manage'
    }]);
    expect(() => assertOperatorAuthorityPolicyCatalogCoversOperationRegistry({
      catalog: withUnused,
      registry
    })).not.toThrow();
    expect(registry.safeManifest.operations.map((operation) => operation.name))
      .toEqual(['catalog.draft', 'catalog.read']);
  });

  test('returns canonical, deduplicated current evidence and exact principal grant', async () => {
    const result = await fixture().resolver.resolve(resolutionInput());
    expect(result.kind).toBe('authorized');
    if (result.kind !== 'authorized') return;

    expect(result.authority.actor).toEqual({ kind: 'workspace_user', userId });
    expect(result.authority.principal).toEqual({
      kind: 'workspace_user',
      userId,
      membershipId
    });
    expect(result.authority.grants).toEqual([{ kind: 'permission', key: 'event.read' }]);
    expect(result.authority.evaluatedAt).toBe(now);
    expect(result.authority.evidenceIds).toEqual(
      [...new Set(result.authority.evidenceIds)].sort((left, right) => left.localeCompare(right))
    );
    expect(result.authority.evidenceIds.filter((id) => id.includes('assignment_a'))).toHaveLength(1);
    expect(result.authority.evidenceIds.filter((id) => id === 'session:a')).toHaveLength(1);
    expect(JSON.stringify(result.authority)).not.toContain(evidence.sessionHandle);
    expect(JSON.stringify(result.authority)).not.toContain('auth_z');
    expect(Object.isFrozen(result.authority.grants)).toBe(true);
    expect(Object.isFrozen(result.authority.evidenceIds)).toBe(true);
    expect(Object.isFrozen(result.authority.authorityCitationIds)).toBe(true);
  });

  test('re-reads membership and permission evidence on every call', async () => {
    const state = fixture();
    expect((await state.resolver.resolve(resolutionInput())).kind).toBe('authorized');

    state.setMembership(membership('suspended'));
    expect(await state.resolver.resolve(resolutionInput())).toEqual({
      kind: 'denied',
      reason: 'revoked'
    });

    state.setMembership(membership());
    state.setAssignments(Object.freeze([]));
    expect(await state.resolver.resolve(resolutionInput())).toEqual({
      kind: 'denied',
      reason: 'not_authorized'
    });
  });

  test('denies an expired session and an unregistered lane policy', async () => {
    expect(await fixture({ expiresAt: now }).resolver.resolve(resolutionInput())).toEqual({
      kind: 'denied',
      reason: 'revoked'
    });
    const otherLane = parseOperationAccessLane({
      kind: 'operator',
      surface: 'operator_http',
      policy: { key: 'event.manage', version: 1 }
    });
    expect(await fixture().resolver.resolve({ ...resolutionInput(), lane: otherLane })).toEqual({
      kind: 'denied',
      reason: 'lane_mismatch'
    });
  });

  test('denies server-root and subject relationships outside the registered scope', async () => {
    expect(await fixture().resolver.resolve(resolutionInput(Object.freeze({
      ...workspaceScope,
      workspaceId: otherWorkspaceId
    })))).toEqual({ kind: 'denied', reason: 'cross_scope' });

    const state = fixture({
      scopeRelationships: Object.freeze({
        validate() {
          return Object.freeze({ kind: 'denied' as const, reason: 'cross_scope' as const });
        }
      })
    });
    expect(await state.resolver.resolve(resolutionInput(Object.freeze({
      workspaceId,
      eventId,
      subjects: Object.freeze([{ kind: 'event' as const, id: eventId }]),
      resolutionEvidenceIds: Object.freeze(['server-event-resolution'])
    })))).toEqual({ kind: 'denied', reason: 'cross_scope' });
  });
});
