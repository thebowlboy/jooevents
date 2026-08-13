import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createOperationRegistry } from '@jooevents/application';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  DECISION_DECIDE_DRAFT_OPERATION,
  DECISION_DRAFT_ACCESS_POLICY,
  DECISION_DRAFT_REQUEST_HASH_PROFILE,
  DECISION_READ_ACCESS_POLICY,
  DECISION_STATE_READ_OPERATION,
  createDecisionDraftOperationModule,
  createDecisionOperationModule,
  decisionDraftContributionSchema
} from '.';

const scope = Object.freeze({
  workspaceId: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  eventId: parseEventId('019c1df7-86b5-769b-bba4-5f7097bfa101')
});
const profile = Object.freeze({ key: 'decision-operation-test', version: parseContractVersion(1) });

describe('Decision operation modules', () => {
  test('registers the current-event, current-authority Decision state read', async () => {
    const module = createDecisionOperationModule({
      workspaceId: scope.workspaceId,
      readPolicy: DECISION_READ_ACCESS_POLICY,
      currentAuthority: {
        resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
      },
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId,
          evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      clock: { now: () => parseInstant('2026-08-13T12:00:00.000Z') },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      decisions: {
        readDecisionHead: () => undefined,
        readSubmissionSessionOrigin: () => undefined
      }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path
    }))).toEqual([{
      operation: `${DECISION_STATE_READ_OPERATION.name}@1`,
      method: 'GET',
      path: '/api/events/current/decisions'
    }]);
    expect(registry.safeManifest.operations[0]).toMatchObject({
      effect: 'read', maxRisk: 'low', consequenceTags: []
    });
  });

  test('registers the decide draft with its typed refusal outcomes', async () => {
    const module = createDecisionDraftOperationModule({
      workspaceId: scope.workspaceId,
      draftPolicy: DECISION_DRAFT_ACCESS_POLICY,
      currentAuthority: {
        resolve: () => Object.freeze({ kind: 'denied' as const, reason: 'missing' as const })
      },
      currentEvent: {
        resolveCurrentEvent: () => Object.freeze({
          eventId: scope.eventId,
          evidenceIds: Object.freeze(['event.current.selection'])
        })
      },
      clock: { now: () => parseInstant('2026-08-13T12:00:00.000Z') },
      ids: { newInvocationId: () => parseInvocationId(crypto.randomUUID()) },
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: {
        seal: () => Object.freeze({
          profile: DECISION_DRAFT_REQUEST_HASH_PROFILE,
          requestHashSha256: 'a'.repeat(64)
        })
      } as never,
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: (raw: string) => Object.freeze({
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`decision-key:${raw}`).digest('hex')
        })
      }
    });
    const registry = await createOperationRegistry(module.source);
    expect(registry.operatorHttpEffectBindings.map((binding) => ({
      operation: `${binding.operationName}@${binding.operationVersion}`,
      method: binding.method,
      path: binding.path,
      input: binding.input
    }))).toEqual([{
      operation: `${DECISION_DECIDE_DRAFT_OPERATION.name}@1`,
      method: 'POST',
      path: '/api/events/current/decisions/decide-drafts',
      input: 'body'
    }]);
    const manifest = registry.safeManifest.operations.find(
      (operation) => operation.name === DECISION_DECIDE_DRAFT_OPERATION.name
    );
    expect(manifest).toMatchObject({ effect: 'draft', consequenceTags: ['changeset-drafted'] });
    const outcomeKeys = (manifest as { outcomes: readonly { class: string; kind: string }[] })
      .outcomes.map((outcome) => `${outcome.class}:${outcome.kind}`);
    expect(outcomeKeys).toContain('stale_revision:decision.changed');
    expect(outcomeKeys).toContain('conflict:decision.target_unavailable');
  });

  test('refusal contribution accepts only the declared typed outcomes with matching details', () => {
    const outcome = (kind: string, detail: unknown, klass = 'conflict') => ({
      result: {
        kind: 'outcome',
        outcome: {
          class: klass, kind, retryable: false,
          subjects: [], detail, detailSchemaVersion: 1
        }
      },
      domain: null,
      receiptChildren: []
    });
    expect(decisionDraftContributionSchema.safeParse(outcome(
      'decision.target_unavailable',
      { reason: 'target_graduated', exits: ['retarget', 'spawn'] }
    )).success).toBe(true);
    expect(decisionDraftContributionSchema.safeParse(outcome(
      'decision.target_unavailable',
      { reason: 'target_graduated', exits: ['spawn', 'retarget'] }
    )).success).toBe(false);
    expect(decisionDraftContributionSchema.safeParse(outcome(
      'decision.changed',
      { code: 'stale_decision', submissionId: '019c1df7-86b5-769b-bba4-5f7097bfa601' },
      'stale_revision'
    )).success).toBe(true);
    expect(decisionDraftContributionSchema.safeParse(outcome(
      'decision.notify', null
    )).success).toBe(false);
  });
});
