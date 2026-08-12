import { describe, expect, test } from 'bun:test';
import { parseUtcInstant } from '@jooevents/kernel';
import {
  createOperationAutonomyPolicy,
  evaluateAutonomy,
  isTrustedOperationAutonomyPolicy,
  validateOperationAutonomyPolicy,
  type AutonomyInvocation,
  type AutonomyPolicyProfile,
  type OperationAutonomyPolicy,
  type RenewedApprovalEvidence
} from './autonomy';

const now = parseUtcInstant('2026-08-11T12:00:00.000Z');
const soon = parseUtcInstant('2026-08-11T12:30:00.000Z');
const later = parseUtcInstant('2026-08-11T14:00:00.000Z');

const policy: OperationAutonomyPolicy = {
  definition: { key: 'autonomy.note_draft', version: 1 },
  operation: { name: 'note.draft', version: 1 },
  riskFloor: 'normal',
  unattendedRiskCeiling: 'normal',
  supportedDispositions: [
    'proceed',
    'safe_retry',
    'reconcile',
    'renewed_approval',
    'replan',
    'compensate',
    'block',
    'attention'
  ],
  triggerDispositions: {
    authority_lost: 'block',
    unattended_bounds_exceeded: 'renewed_approval',
    approval_required: 'renewed_approval',
    known_retryable_failure: 'safe_retry',
    ambiguous_external_effect: 'reconcile',
    stale_plan: 'replan',
    compensation_required: 'compensate',
    terminal_failure: 'attention'
  },
  requiresSeparateApproval: false
};

function invocation(overrides: Partial<AutonomyInvocation> = {}): AutonomyInvocation {
  return {
    operation: policy.operation,
    surface: 'external_mcp',
    effect: 'draft',
    resolvedRisk: 'normal',
    requestOrPlanDigestSha256: '1'.repeat(64),
    proposedAction: { key: 'action.create_note_draft', version: 1, digestSha256: '2'.repeat(64) },
    scopeKeys: ['workspace.alpha'],
    spendMicros: 10,
    actionCount: 1,
    completesBy: soon,
    authority: {
      current: true,
      permitted: true,
      principalKey: 'principal.external_agent',
      kind: 'external_mcp',
      hardBounds: {
        scopeKeys: ['workspace.alpha'],
        maximumSpendMicros: 1_000,
        maximumActions: 10,
        notAfter: later
      }
    },
    unattendedBounds: {
      scopeKeys: ['workspace.alpha'],
      maximumSpendMicros: 100,
      maximumActions: 5,
      notAfter: later
    },
    failure: { kind: 'none' },
    consequenceEvidenceIds: ['evidence.intent'],
    ...overrides
  };
}

function exactApproval(request: Extract<ReturnType<typeof evaluateAutonomy>, { disposition: 'renewed_approval' }>['request']): RenewedApprovalEvidence {
  return {
    id: 'approval.one',
    policy: request.policy,
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    operation: request.operation,
    requestOrPlanDigestSha256: request.requestOrPlanDigestSha256,
    proposedAction: request.proposedAction,
    scopeKeys: request.scopeKeys,
    maximumSpendMicros: request.requestedSpendMicros,
    maximumActions: request.requestedActions,
    notAfter: request.notAfter,
    proposerPrincipalKey: request.proposerPrincipalKey,
    approverPrincipalKey: 'principal.owner',
    issuedAt: now,
    expiresAt: parseUtcInstant('2026-08-11T12:20:00.000Z'),
    evidenceIds: request.evidenceIds
  };
}

describe('bounded agent autonomy', () => {
  test('authorized work proceeds without a per-step human prompt inside exact bounds', () => {
    expect(evaluateAutonomy({ policy, invocation: invocation(), now })).toEqual({ disposition: 'proceed' });
  });

  test('a soft cap crossing pauses for one exact action and resumes only with matching current approval', () => {
    const request = invocation({ spendMicros: 300 });
    const paused = evaluateAutonomy({ policy, invocation: request, now });
    expect(paused).toMatchObject({
      disposition: 'renewed_approval',
      request: {
        trigger: 'unattended_bounds_exceeded',
        requestedSpendMicros: 300,
        requestOrPlanDigestSha256: '1'.repeat(64)
      }
    });
    if (paused.disposition !== 'renewed_approval') throw new Error('expected renewed approval');
    const approval = exactApproval(paused.request);
    expect(evaluateAutonomy({
      policy,
      invocation: request,
      now,
      renewedApproval: approval,
      approverCurrentlyAuthorized: true
    })).toEqual({ disposition: 'proceed' });

    expect(evaluateAutonomy({
      policy,
      invocation: { ...request, requestOrPlanDigestSha256: '3'.repeat(64) },
      now,
      renewedApproval: approval,
      approverCurrentlyAuthorized: true
    }).disposition).toBe('renewed_approval');
    expect(evaluateAutonomy({
      policy,
      invocation: request,
      now,
      renewedApproval: { ...approval, approverPrincipalKey: approval.proposerPrincipalKey },
      approverCurrentlyAuthorized: true
    }).disposition).toBe('renewed_approval');
  });

  test('separate approval has no structural boolean bypass', () => {
    const separateApprovalPolicy: OperationAutonomyPolicy = {
      ...policy,
      requiresSeparateApproval: true
    };
    const structuralBypass: Parameters<typeof evaluateAutonomy>[0] = {
      policy: separateApprovalPolicy,
      invocation: invocation(),
      now,
      // @ts-expect-error Structural approval is not part of the public evaluator contract.
      consequentialApprovalSatisfied: true
    };
    expect(evaluateAutonomy(structuralBypass)).toMatchObject({
      disposition: 'renewed_approval',
      request: { trigger: 'approval_required' }
    });
  });

  test('hard authority cannot be expanded by settings or renewed approval', () => {
    const request = invocation({ scopeKeys: ['workspace.beta'] });
    const forgedRequest = evaluateAutonomy({ policy, invocation: invocation({ spendMicros: 300 }), now });
    if (forgedRequest.disposition !== 'renewed_approval') throw new Error('expected approval fixture');
    expect(evaluateAutonomy({
      policy,
      invocation: request,
      now,
      renewedApproval: exactApproval(forgedRequest.request),
      approverCurrentlyAuthorized: true
    })).toEqual({ disposition: 'block', trigger: 'authority_lost' });
  });

  test('ambiguous external acceptance always reconciles before retry, even with a human present', () => {
    const request = invocation({
      failure: { kind: 'acceptance_unknown', semanticAnchorId: 'effect.attempt.one' }
    });
    expect(evaluateAutonomy({
      policy,
      invocation: request,
      now,
      approverCurrentlyAuthorized: true
    })).toEqual({ disposition: 'reconcile', semanticAnchorId: 'effect.attempt.one' });
  });

  test('known failure retries only under the same semantic anchor; otherwise it raises attention', () => {
    expect(evaluateAutonomy({
      policy,
      invocation: invocation({ failure: { kind: 'known_retryable', semanticAnchorId: 'job.attempt.one' } }),
      now
    })).toEqual({ disposition: 'safe_retry', semanticAnchorId: 'job.attempt.one' });
    expect(evaluateAutonomy({
      policy,
      invocation: invocation({ failure: { kind: 'known_retryable' } }),
      now
    })).toEqual({ disposition: 'attention', trigger: 'known_retryable_failure' });
  });

  test('profiles can tighten caps but cannot loosen the code-owned risk ceiling', () => {
    const tight: AutonomyPolicyProfile = {
      definition: { key: 'autonomy_profile.cautious', version: 1 },
      maximumUnattendedRisk: 'low',
      maximumSpendMicros: 50,
      maximumActions: 1,
      notAfter: later
    };
    expect(evaluateAutonomy({ policy, invocation: invocation(), profile: tight, now }).disposition)
      .toBe('renewed_approval');
    const tightened = evaluateAutonomy({ policy, invocation: invocation(), profile: tight, now });
    if (tightened.disposition !== 'renewed_approval') throw new Error('expected tightened-profile approval');
    const approval = exactApproval(tightened.request);
    expect(approval.profile).toEqual(tight.definition);
    expect(evaluateAutonomy({
      policy,
      invocation: invocation(),
      profile: { ...tight, definition: { key: 'autonomy_profile.cautious', version: 2 } },
      now,
      renewedApproval: approval,
      approverCurrentlyAuthorized: true
    }).disposition).toBe('renewed_approval');
    const purportedlyLoose: AutonomyPolicyProfile = {
      ...tight,
      definition: { key: 'autonomy_profile.loose', version: 1 },
      maximumUnattendedRisk: 'consequential',
      maximumSpendMicros: 1_000,
      maximumActions: 100
    };
    expect(evaluateAutonomy({
      policy,
      invocation: invocation({ resolvedRisk: 'consequential' }),
      profile: purportedlyLoose,
      now
    }).disposition).toBe('renewed_approval');
  });

  test('lost or substituted authority and app-model commit hit non-lowerable blocks', () => {
    expect(evaluateAutonomy({
      policy,
      invocation: invocation({ authority: { ...invocation().authority, current: false } }),
      now
    })).toEqual({ disposition: 'block', trigger: 'authority_lost' });
    expect(evaluateAutonomy({
      policy,
      invocation: invocation({ authority: { ...invocation().authority, kind: 'human' } }),
      now
    })).toEqual({ disposition: 'block', trigger: 'authority_lost' });
    expect(evaluateAutonomy({
      policy,
      invocation: invocation({
        surface: 'app_model',
        effect: 'commit',
        authority: { ...invocation().authority, kind: 'app_model' }
      }),
      now
    })).toEqual({ disposition: 'block', trigger: 'authority_lost' });
  });

  test('registry policy cannot configure blind ambiguity retry or omit a selected disposition', () => {
    expect(() => validateOperationAutonomyPolicy({
      ...policy,
      triggerDispositions: { ...policy.triggerDispositions, ambiguous_external_effect: 'safe_retry' }
    })).toThrow('ambiguous external effects cannot select blind retry');
    expect(() => validateOperationAutonomyPolicy({
      ...policy,
      supportedDispositions: policy.supportedDispositions.filter((value) => value !== 'replan')
    })).toThrow('unsupported disposition');
  });

  test('trusted policy definitions are normalized, deeply frozen, and cannot be structurally forged', () => {
    const mutable = {
      ...policy,
      definition: { ...policy.definition },
      operation: { ...policy.operation },
      supportedDispositions: [...policy.supportedDispositions].reverse(),
      triggerDispositions: { ...policy.triggerDispositions }
    };
    const sealed = createOperationAutonomyPolicy(mutable);
    expect(sealed.supportedDispositions).toEqual([
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ]);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.definition)).toBe(true);
    expect(Object.isFrozen(sealed.triggerDispositions)).toBe(true);
    expect(isTrustedOperationAutonomyPolicy(sealed)).toBe(true);
    expect(isTrustedOperationAutonomyPolicy({ ...sealed })).toBe(false);

    mutable.definition.key = 'autonomy.substituted';
    mutable.operation.name = 'other.operation';
    expect(sealed.definition).toEqual(policy.definition);
    expect(sealed.operation).toEqual(policy.operation);
  });
});
