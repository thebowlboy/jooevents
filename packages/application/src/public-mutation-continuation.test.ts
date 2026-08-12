import { describe, expect, test } from 'bun:test';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseCorrelationId,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  createEffectInvocationContextBuilder,
  createHmacRequestHashSealer,
  createReadInvocationContextBuilder
} from './operations/invocation-context';
import { createOperationRegistry } from './operations/registry';
import type { OperationRegistrySource } from './operations/types';

const publicPolicyRevisionId = parsePublicPolicyRevisionId(
  '01890f47-9abc-7def-8123-456789abc001'
);
const ceremonyEvidenceId = parseCeremonyEvidenceId(
  '01890f47-9abc-7def-8123-456789abc002'
);
const workspaceId = parseWorkspaceId('01890f47-9abc-7def-8123-456789abc003');
const eventId = parseEventId('01890f47-9abc-7def-8123-456789abc004');
const correlationId = parseCorrelationId('01890f47-9abc-7def-8123-456789abc005');
const invocationId = parseInvocationId('01890f47-9abc-7def-8123-456789abc006');
const now = parseInstant('2026-08-11T00:00:00.000Z');
const profile = Object.freeze({ key: 'security.public-proof', version: parseContractVersion(1) });
const readLane = parseOperationAccessLane({
  kind: 'public_open',
  surface: 'public_http',
  policy: { key: 'authority.public-open-proof', version: 1 }
});
const effectLane = parseOperationAccessLane({
  kind: 'public_ceremony',
  surface: 'public_http',
  policy: { key: 'authority.public-ceremony-proof', version: 1 }
});

function scope() {
  return Object.freeze({
    workspaceId,
    eventId,
    subjects: Object.freeze([
      Object.freeze({ kind: 'workspace' as const, id: workspaceId }),
      Object.freeze({ kind: 'event' as const, id: eventId })
    ]),
    resolutionEvidenceIds: Object.freeze(['public-target:v1'])
  });
}

const denied = () => Object.freeze({
  class: 'access_denied' as const,
  kind: 'public.not_available',
  retryable: false,
  subjects: [],
  detail: null,
  detailSchemaVersion: 1
});

describe('public mutation activation remains closed', () => {
  test('open public evidence can build only a read context', async () => {
    const builder = createReadInvocationContextBuilder({
      reference: { key: 'context.public-read-proof', version: 1 },
      operation: { name: 'public.schedule.read', version: 1 },
      effect: 'read',
      lanes: [readLane],
      scopeResolver: { resolve: scope },
      authorityResolver: {
        resolve(input) {
          return {
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
              lane: input.lane,
              scope: input.scope,
              grants: Object.freeze([{ kind: 'public_policy' as const, key: 'schedule.read' }]),
              evidenceIds: Object.freeze(['public-policy-current:v1']),
              authorityCitationIds: Object.freeze([]),
              evaluatedAt: input.evaluatedAt
            })
          };
        }
      },
      clock: { now: () => now },
      newInvocationId: () => invocationId,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      deniedAuthorityOutcome: denied
    });
    const result = await builder.build({
      operationName: 'public.schedule.read',
      operationVersion: 1,
      surface: 'public_http',
      correlationId,
      businessInput: { eventSlug: 'proof' },
      verifiedEvidence: {
        kind: 'public_open',
        surface: 'public_http',
        client: { key: 'public.proof' },
        publicPolicyRevisionId
      }
    });
    expect(result.kind).toBe('ready');

    const effectBuilder = createEffectInvocationContextBuilder({
      reference: { key: 'context.public-effect-proof', version: 1 },
      operation: { name: 'public.cfp.submit', version: 1 },
      effect: 'commit',
      lanes: [effectLane],
      scopeResolver: { resolve: scope },
      authorityResolver: { resolve: () => ({ kind: 'denied' as const, reason: 'not_authorized' as const }) },
      clock: { now: () => now },
      newInvocationId: () => invocationId,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashProfile: { key: 'request.public-effect-proof', version: 1 },
      requestHashSealer: createHmacRequestHashSealer({
        profile: { key: 'request.public-effect-proof', version: 1 },
        keyBytes: new Uint8Array(32).fill(0x33)
      }),
      deniedAuthorityOutcome: denied,
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: () => ({ verifierProfile: profile, verifierSha256: 'a'.repeat(64) })
      }
    });
    await expect(effectBuilder.build({
      operationName: 'public.cfp.submit',
      operationVersion: 1,
      surface: 'public_http',
      correlationId,
      businessInput: { draftReference: 'opaque' },
      rawIdempotencyKey: 'opaque-key',
      verifiedEvidence: {
        kind: 'public_ceremony',
        surface: 'public_http',
        client: { key: 'public.proof' },
        ceremonyEvidenceId
      }
    })).rejects.toMatchObject({ code: 'public_mutation_disabled' });
  });

  test('the executable registry still rejects every effect operation carrying a public lane', async () => {
    const schema = (key: string) => ({ key, version: 1, digestSha256: 'a'.repeat(64) });
    const source: OperationRegistrySource = {
      autonomyPolicies: [],
      schemas: [],
      contextBuilders: [],
      readCapabilities: [],
      handlers: [],
      projections: [],
      operations: [],
      effectContextBuilders: [],
      effectHandlers: [],
      operationAuditTargets: [],
      operationAuditRecordProfiles: [],
      effectOperations: [{
        name: 'public.cfp.submit',
        version: 1,
        lifecycle: { status: 'active' },
        summary: 'Activation canary only.',
        effect: 'commit',
        maxRisk: 'consequential',
        autonomyPolicy: { key: 'autonomy.public-proof', version: 1 },
        consequenceTags: ['public-write'],
        inputSchema: schema('schema.public-proof.input'),
        contributionSchema: schema('schema.public-proof.contribution'),
        canonicalResultSchema: schema('schema.public-proof.result'),
        outcomes: [],
        accessLanes: [effectLane],
        contextBuilder: { key: 'context.public-effect-proof', version: 1 },
        handlerCapability: { key: 'capability.public-effect-proof', version: 1 },
        handler: { key: 'handler.public-effect-proof', version: 1 },
        audit: { mode: 'required', target: { key: 'audit.public-effect-proof', version: 1 } },
        idempotency: {
          keySource: { key: 'idempotency.public-effect-proof', version: 1 },
          credentialVerifierProfile: { key: 'security.public-proof', version: 1 },
          requestHashProfile: { key: 'request.public-effect-proof', version: 1 }
        },
        concurrency: { key: 'concurrency.public-effect-proof', version: 1 },
        execution: {
          kind: 'single_unit_of_work',
          family: { key: 'execution-family.public-effect-proof', version: 1 },
          phase: { key: 'phase.public-effect-proof', version: 1 },
          terminalization: { key: 'terminalization.public-effect-proof', version: 1 },
          autonomyPreflight: { key: 'autonomy-preflight.public-effect-proof', version: 1 }
        },
        bindings: []
      }]
    };
    await expect(createOperationRegistry(source)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'public_effect_lane_unactivated' })
      ])
    });
  });
});
