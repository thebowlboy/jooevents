import { describe, expect, test } from 'bun:test';
import {
  evaluatePublicInputPolicy,
  openPublicInputPolicyDecision
} from '@jooevents/intake';
import { parseContractVersion, parsePublicPolicyRevisionId } from '@jooevents/kernel';
import {
  INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES,
  INTAKE_PUBLIC_APPLY_UNCONFIGURED_INPUT_POLICY,
  INTAKE_PUBLIC_MUTATE_OPERATION,
  createApplySurfaceGatedContinuationPolicySource,
  createApplySurfaceGatedPublicFormScopeSource,
  createOffUnlessConfiguredPublicInputPolicyEvaluator,
  createOffUnlessConfiguredPublicIntakeBootstrapVerifier,
  intakePublicApplyPolicyRevision,
  type IntakePublicApplySurfaceGate,
  type IntakePublicApplySurfacePin,
  type IntakePublicApplySurfaceResolution
} from './index';

const uuid = (suffix: number): string =>
  `019c2ea0-40cf-7d21-9d5e-${suffix.toString(16).padStart(12, '0')}`;

const pin: IntakePublicApplySurfacePin = Object.freeze({
  workspaceId: uuid(1),
  eventId: uuid(2),
  formId: uuid(3),
  formVersionId: uuid(4),
  surfaceReleaseId: uuid(5),
  surfaceHeadVersion: 3,
  evidenceIds: Object.freeze([`apply-surface:${uuid(5)}`])
});

function gateOf(resolution: IntakePublicApplySurfaceResolution): IntakePublicApplySurfaceGate {
  return Object.freeze({ resolveApplySurface: () => resolution });
}

const pinned: IntakePublicApplySurfaceResolution = Object.freeze({ kind: 'pinned', pin });
const revision = parsePublicPolicyRevisionId(pin.surfaceReleaseId);

const binding = Object.freeze({ key: 'intake.public-apply', version: parseContractVersion(1) });
const keyProfile = (key: string, fill: number) => Object.freeze({
  reference: Object.freeze({ key, version: parseContractVersion(1) }),
  keyBytes: new Uint8Array(32).fill(fill)
});
const security = Object.freeze({
  lifetimeMs: 300_000,
  bootstrapVerifier: INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES.bootstrapVerifier,
  originPolicy: INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES.originPolicy,
  csrfPolicy: INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES.csrfPolicy,
  rateLimitPolicy: INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES.rateLimitPolicy,
  replayPolicy: INTAKE_PUBLIC_APPLY_UNCONFIGURED_ABUSE_POLICIES.replayPolicy,
  continuationProfiles: [keyProfile('intake.public-continuation', 1)] as const,
  principalPartitionProfile: keyProfile('intake.public-partition', 2),
  bootstrapReplayProfile: keyProfile('intake.public-bootstrap-replay', 3)
});

describe('apply-surface gated public form scope source', () => {
  test('serves the pinned form under the pin-derived policy revision with surface evidence', async () => {
    const source = createApplySurfaceGatedPublicFormScopeSource({ gate: gateOf(pinned) });
    const resolved = await source.resolve({ formId: pin.formId, publicPolicyRevisionId: revision });
    expect(resolved).toMatchObject({ workspaceId: pin.workspaceId, eventId: pin.eventId });
    expect(resolved?.evidenceIds).toContain(`apply-surface:${pin.surfaceReleaseId}`);
    expect(resolved?.evidenceIds).toContain(`public-policy:${revision}`);
  });

  test('fails closed on every refusal, wrong form, stale revision, and thrown resolution', async () => {
    const wrongRevision = parsePublicPolicyRevisionId(uuid(0x99));
    const cases: readonly IntakePublicApplySurfaceResolution[] = [
      { kind: 'refused', reason: 'no_published_apply_surface' },
      { kind: 'refused', reason: 'apply_form_version_superseded' }
    ];
    for (const resolution of cases) {
      const source = createApplySurfaceGatedPublicFormScopeSource({ gate: gateOf(resolution) });
      expect(await source.resolve({ formId: pin.formId, publicPolicyRevisionId: revision }))
        .toBeUndefined();
    }
    const source = createApplySurfaceGatedPublicFormScopeSource({ gate: gateOf(pinned) });
    expect(await source.resolve({ formId: uuid(0x77), publicPolicyRevisionId: revision }))
      .toBeUndefined();
    expect(await source.resolve({ formId: pin.formId, publicPolicyRevisionId: wrongRevision }))
      .toBeUndefined();
    const throwing = createApplySurfaceGatedPublicFormScopeSource({
      gate: { resolveApplySurface() { throw new Error('release read failed'); } }
    });
    expect(await throwing.resolve({ formId: pin.formId, publicPolicyRevisionId: revision }))
      .toBeUndefined();
  });

  test('resolves the pinned form read as closed without opening the ceremony pin', async () => {
    const source = createApplySurfaceGatedPublicFormScopeSource({
      gate: gateOf({ kind: 'closed', pin })
    });
    const resolved = await source.resolve({
      formId: pin.formId,
      publicPolicyRevisionId: revision
    });
    expect(resolved).toMatchObject({ workspaceId: pin.workspaceId, eventId: pin.eventId });
    expect(resolved?.evidenceIds).toContain('apply-form-state:closed');

    const registry = createApplySurfaceGatedContinuationPolicySource({
      gate: gateOf({ kind: 'closed', pin }), binding, security
    });
    expect(registry.resolve(binding)).toBeUndefined();
  });

  test('a malformed pin never becomes a served scope', async () => {
    const source = createApplySurfaceGatedPublicFormScopeSource({
      gate: gateOf({
        kind: 'pinned',
        pin: { ...pin, formVersionId: 'not-a-uuid' }
      })
    });
    expect(await source.resolve({ formId: pin.formId, publicPolicyRevisionId: revision }))
      .toBeUndefined();
  });
});

describe('apply-surface gated continuation policy source', () => {
  test('resolves the ceremony policy exactly from the live pin', () => {
    const registry = createApplySurfaceGatedContinuationPolicySource({
      gate: gateOf(pinned), binding, security
    });
    const policy = registry.resolve(binding);
    expect(policy).toMatchObject({
      binding,
      publicPolicyRevisionId: revision,
      operation: { name: INTAKE_PUBLIC_MUTATE_OPERATION.name, version: 1 },
      scope: { kind: 'event', workspaceId: pin.workspaceId, eventId: pin.eventId },
      purpose: 'intake.application',
      action: 'mutate',
      resourceBindings: [
        { kind: 'intake_form', id: pin.formId },
        { kind: 'intake_form_version', id: pin.formVersionId }
      ],
      lifetimeMs: 300_000
    });
    expect(intakePublicApplyPolicyRevision(pin)).toBe(revision);
  });

  test('an absent, refused, throwing, or foreign binding resolution stays unavailable', () => {
    const registry = createApplySurfaceGatedContinuationPolicySource({
      gate: gateOf({ kind: 'refused', reason: 'no_published_apply_surface' }), binding, security
    });
    expect(registry.resolve(binding)).toBeUndefined();
    const throwing = createApplySurfaceGatedContinuationPolicySource({
      gate: { resolveApplySurface() { throw new Error('rolled back'); } }, binding, security
    });
    expect(throwing.resolve(binding)).toBeUndefined();
    const live = createApplySurfaceGatedContinuationPolicySource({
      gate: gateOf(pinned), binding, security
    });
    expect(live.resolve({ key: 'intake.other-binding', version: parseContractVersion(1) }))
      .toBeUndefined();
    expect(live.resolve({ key: binding.key, version: parseContractVersion(2) })).toBeUndefined();
  });

  test('a re-pinned form version changes the resolved policy, never mutates it in place', () => {
    let current: IntakePublicApplySurfaceResolution = pinned;
    const registry = createApplySurfaceGatedContinuationPolicySource({
      gate: { resolveApplySurface: () => current }, binding, security
    });
    const before = registry.resolve(binding);
    current = {
      kind: 'pinned',
      pin: { ...pin, formVersionId: uuid(0x44), surfaceReleaseId: uuid(0x45) }
    };
    const after = registry.resolve(binding);
    expect(before?.resourceBindings[1]).toEqual({ kind: 'intake_form_version', id: pin.formVersionId });
    expect(after?.resourceBindings[1]).toEqual({ kind: 'intake_form_version', id: uuid(0x44) });
    expect(after?.publicPolicyRevisionId).toBe(parsePublicPolicyRevisionId(uuid(0x45)));
  });
});

describe('off-unless-configured bootstrap verifier', () => {
  const bootstrap = 'b'.repeat(48);
  const evidence = Object.freeze({ schemaVersion: 1 as const, bootstrap, origin: null });
  const verifyInput = (protocolEvidence: unknown) => ({
    protocolEvidence,
    receivedAt: '2026-08-14T12:00:00.000Z',
    binding,
    originPolicy: security.originPolicy,
    csrfPolicy: security.csrfPolicy,
    rateLimitPolicy: security.rateLimitPolicy,
    replayPolicy: security.replayPolicy
  });

  test('verifies a well-formed bootstrap without any origin, challenge, or rate requirement', async () => {
    const verifier = createOffUnlessConfiguredPublicIntakeBootstrapVerifier();
    const result = await verifier.verify(verifyInput(evidence) as never);
    if (result.kind !== 'verified') throw new TypeError('expected verification');
    expect(result.originEvidenceId).toMatch(/^poe_uncfg_[a-f0-9]{40}$/);
    expect(result.csrfEvidenceId).toMatch(/^pce_uncfg_[a-f0-9]{40}$/);
    expect(result.rateLimitEvidenceId).toMatch(/^pre_uncfg_[a-f0-9]{40}$/);
    expect(result.replayEvidenceId).toMatch(/^ppe_uncfg_[a-f0-9]{40}$/);
    expect(new TextDecoder().decode(result.bootstrapReplayMaterial)).toBe(bootstrap);
    const replay = await verifier.verify(verifyInput(evidence) as never);
    if (replay.kind !== 'verified') throw new TypeError('expected replay verification');
    expect(replay.replayEvidenceId).toBe(result.replayEvidenceId);
    expect(new TextDecoder().decode(replay.principalPartitionMaterial))
      .toBe(new TextDecoder().decode(result.principalPartitionMaterial));
  });

  test('rejects malformed protocol evidence structurally', async () => {
    const verifier = createOffUnlessConfiguredPublicIntakeBootstrapVerifier();
    for (const candidate of [
      null,
      {},
      { schemaVersion: 1, bootstrap: 'short', origin: null },
      { schemaVersion: 1, bootstrap, origin: null, extra: true },
      { schemaVersion: 2, bootstrap, origin: null }
    ]) {
      expect(await verifier.verify(verifyInput(candidate) as never))
        .toEqual({ kind: 'rejected', reason: 'csrf_rejected' });
    }
  });

  test('an origin allowlist is enforced only when configured', async () => {
    const configured = createOffUnlessConfiguredPublicIntakeBootstrapVerifier({
      allowedOrigins: ['https://events.example']
    });
    expect(await configured.verify(verifyInput(evidence) as never))
      .toEqual({ kind: 'rejected', reason: 'origin_rejected' });
    expect(await configured.verify(
      verifyInput({ ...evidence, origin: 'https://elsewhere.example' }) as never
    )).toEqual({ kind: 'rejected', reason: 'origin_rejected' });
    const allowed = await configured.verify(
      verifyInput({ ...evidence, origin: 'https://events.example' }) as never
    );
    expect(allowed.kind).toBe('verified');
    const unconfigured = createOffUnlessConfiguredPublicIntakeBootstrapVerifier();
    const anywhere = await unconfigured.verify(
      verifyInput({ ...evidence, origin: 'https://anywhere.example' }) as never
    );
    expect(anywhere.kind).toBe('verified');
  });
});

describe('off-unless-configured input policy', () => {
  test('allows every action under the explicit unconfigured policy identity', () => {
    let evaluation = 0x500;
    const evaluator = createOffUnlessConfiguredPublicInputPolicyEvaluator({
      issueEvaluationId: () => uuid(evaluation++)
    });
    const context = Object.freeze({
      scope: Object.freeze({ workspaceId: pin.workspaceId, eventId: pin.eventId }),
      action: 'application_submit' as const,
      requestDigestSha256: 'c'.repeat(64),
      evaluatedAt: '2026-08-14T12:00:00.000Z'
    });
    const sealed = evaluatePublicInputPolicy(evaluator, context);
    const opened = openPublicInputPolicyDecision(sealed, context);
    expect(opened).toMatchObject({
      disposition: 'allow',
      reasonCode: null,
      remedyCode: null,
      policy: INTAKE_PUBLIC_APPLY_UNCONFIGURED_INPUT_POLICY
    });
  });
});
