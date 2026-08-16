import { describe, expect, test } from 'bun:test';
import {
  createEffectInvocationContextBuilder,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  type EffectInvocationContext
} from '@jooevents/application';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseCorrelationId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { createIntakeHandler, sealIntakePreparation } from './preparation';

const capability = Object.freeze({
  key: 'capability.intake.test',
  version: parseContractVersion(1)
});
const schema = Object.freeze({
  key: 'schema.intake.test',
  version: parseContractVersion(1),
  digestSha256: '0'.repeat(64)
});
const contribution = Object.freeze({
  result: Object.freeze({ kind: 'success', data: Object.freeze({}) }),
  domain: Object.freeze({ kind: 'test' }),
  effectContributions: Object.freeze([])
});
const workspaceId = parseWorkspaceId('018f7d5a-4b3c-7abc-8def-012345678901');
const userId = parseUserId('018f7d5a-4b3c-7abc-8def-012345678902');
const membershipId = parseMembershipId('018f7d5a-4b3c-7abc-8def-012345678903');
const now = parseInstant('2026-08-12T12:00:00.000Z');
const profile = Object.freeze({ key: 'intake.preparation.test', version: parseContractVersion(1) });
const requestHashProfile = Object.freeze({
  key: 'request-hash.intake.preparation-test', version: parseContractVersion(1)
});
const lane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.intake.preparation-test', version: parseContractVersion(1) }
});

async function context(input: {
  readonly invocationId: string;
}): Promise<EffectInvocationContext> {
  const effect = 'commit' as const;
  const operation = Object.freeze({ name: 'submission.direct_entry.create', version: 1 });
  const builder = createEffectInvocationContextBuilder({
    reference: { key: `context.intake.preparation-${effect}`, version: parseContractVersion(1) },
    operation,
    effect,
    lanes: [lane],
    scopeResolver: {
      resolve: () => Object.freeze({
        workspaceId,
        subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
        resolutionEvidenceIds: Object.freeze(['scope:intake-test'])
      })
    },
    authorityResolver: {
      resolve(resolution) {
        return Object.freeze({
          kind: 'authorized' as const,
          authority: Object.freeze({
            actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
            principal: Object.freeze({ kind: 'workspace_user' as const, userId, membershipId }),
            lane: resolution.lane,
            scope: resolution.scope,
            grants: Object.freeze([{ kind: 'permission' as const, key: 'event.manage' }]),
            evidenceIds: Object.freeze(['membership:intake-test']),
            authorityCitationIds: Object.freeze([]),
            evaluatedAt: resolution.evaluatedAt
          })
        });
      }
    },
    clock: { now: () => now },
    newInvocationId: () => parseInvocationId(input.invocationId),
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashProfile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: requestHashProfile,
      keyBytes: new Uint8Array(32).fill(0x41)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: new Uint8Array(32).fill(0x42)
    }),
    deniedAuthorityOutcome: (reason) => ({
      class: 'access_denied', kind: `authority.${reason}`, retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const built = await builder.build({
    operationName: operation.name,
    operationVersion: operation.version,
    surface: 'operator_http',
    correlationId: parseCorrelationId('018f7d5a-4b3c-7abc-8def-012345678904'),
    businessInput: {},
    verifiedEvidence: {
      kind: 'operator', surface: 'operator_http', client: { key: 'intake-preparation-test' },
      sessionHandle: 'session-intake-preparation'
    },
    rawIdempotencyKey: `intake-preparation-${input.invocationId}`
  });
  if (built.kind !== 'ready') throw new TypeError('expected_ready_intake_context');
  return built.context;
}

function handler() {
  return createIntakeHandler({
    reference: { key: 'handler.intake.test-commit', version: parseContractVersion(1) },
    handlerCapability: capability,
    contributionSchema: schema,
    canonicalResultSchema: schema
  });
}

describe('intake preparation', () => {
  test('requires an authentic exact context and is one-shot', async () => {
    const expectedContext = await context({
      invocationId: '018f7d5a-4b3c-7abc-8def-012345678905'
    });
    const wrongContext = await context({
      invocationId: '018f7d5a-4b3c-7abc-8def-012345678906'
    });
    expect(() => sealIntakePreparation({
      capability,
      context: Object.freeze({ ...expectedContext }) as EffectInvocationContext,
      preparation: { prepare: () => contribution }
    })).toThrow('intake_preparation_context_invalid');

    const snapshot = sealIntakePreparation({
      capability,
      context: expectedContext,
      preparation: {
        prepare({ context: received }) {
          expect(received).toBe(expectedContext);
          return contribution;
        }
      }
    });
    expect(() => handler().handle({
      businessInput: {}, context: wrongContext, snapshot
    })).toThrow('invalid_intake_preparation');
    expect(handler().handle({
      businessInput: {}, context: expectedContext, snapshot
    })).toEqual(contribution);
    expect(() => handler().handle({
      businessInput: {}, context: expectedContext, snapshot
    })).toThrow('invalid_intake_preparation');
  });

  test('refuses effect substitution, missing/async functions, and returned thenables', async () => {
    const expectedContext = await context({
      invocationId: '018f7d5a-4b3c-7abc-8def-012345678907'
    });
    expect(() => sealIntakePreparation({
      capability, context: expectedContext, preparation: {} as never
    })).toThrow('intake_preparation_invalid');
    expect(() => sealIntakePreparation({
      capability,
      context: expectedContext,
      preparation: { prepare: (async () => contribution) as never }
    })).toThrow('intake_preparation_must_be_synchronous');

    const mismatch = sealIntakePreparation({
      capability: { key: 'capability.intake.other', version: parseContractVersion(1) },
      context: expectedContext,
      preparation: { prepare: () => contribution }
    });
    expect(() => handler().handle({
      businessInput: {}, context: expectedContext, snapshot: mismatch
    })).toThrow('invalid_intake_preparation');

    const thenable = sealIntakePreparation({
      capability,
      context: expectedContext,
      preparation: { prepare: (() => ({ then() {} })) as never }
    });
    expect(() => handler().handle({
      businessInput: {}, context: expectedContext, snapshot: thenable
    })).toThrow('intake_preparation_must_be_synchronous');
  });
});
