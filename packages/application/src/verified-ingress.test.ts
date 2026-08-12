import { describe, expect, test } from 'bun:test';
import {
  createAuthenticatedPayloadStageDescriptor,
  createClassifiedPayloadProfileRef,
  createPayloadStageFence,
  createStageReconciliationPolicyRef,
  type AuthenticatedPayloadStageDescriptor,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadStageStore,
  type PayloadStageInspection,
  type PayloadStageReconciliationCandidate,
  type PayloadStageReconciliationPage
} from './classified-payloads';
import {
  createVerifiedIngressBoundary,
  type RegisteredVerifiedIngressVerifier,
  type VerifiedIngressSourceConnectionConfig,
  type VerifiedIngressSourceConnectionRegistry
} from './verified-ingress';
import {
  createPayloadRef,
  parseAggregateVersion,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parsePayloadRefId,
  parsePayloadStageId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifierRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';

const ids = {
  workspace: parseWorkspaceId('01890f47-9abc-7def-8123-456789abc001'),
  event: parseEventId('01890f47-9abc-7def-8123-456789abc002'),
  connection: parseSourceConnectionId('01890f47-9abc-7def-8123-456789abc003'),
  connectionRevision1: parseSourceConnectionRevisionId('01890f47-9abc-7def-8123-456789abc004'),
  connectionRevision2: parseSourceConnectionRevisionId('01890f47-9abc-7def-8123-456789abc005'),
  verifierRevision: parseVerifierRevisionId('01890f47-9abc-7def-8123-456789abc006'),
  stage: '01890f47-9abc-7def-8123-456789abc007',
  payload: '01890f47-9abc-7def-8123-456789abc008'
} as const;

const binding = Object.freeze({ key: 'fake.signed.webhook', version: parseContractVersion(1) });
const verifierContract = Object.freeze({ key: 'fake.hmac.verifier', version: parseContractVersion(1) });
const policy = createStageReconciliationPolicyRef('reconciliation.verified-ingress', 1);
const profiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef('classification', 'classification.provider-envelope', 1),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.fake-provider-envelope', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.fake-provider-envelope', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', 'descriptor-auth.hmac-sha256', 1)
});

function key(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256);
}

function configuration(
  connectionRevision = ids.connectionRevision1
): VerifiedIngressSourceConnectionConfig {
  return {
    binding,
    sourceConnectionId: ids.connection,
    sourceConnectionRevisionId: connectionRevision,
    scope: Object.freeze({ kind: 'event', workspaceId: ids.workspace, eventId: ids.event }),
    verifierContract,
    verifierRevisionId: ids.verifierRevision,
    maximumRawEnvelopeBytes: 2_048,
    maximumNormalizedContentBytes: 1_024,
    semanticIdentityProfile: Object.freeze({ key: 'semantic.fake-event', version: parseContractVersion(1) }),
    semanticIdentityKeyBytes: key(1),
    contentBindingProfiles: [
      Object.freeze({
        profile: Object.freeze({ key: 'webhook.content', version: parseContractVersion(1) }),
        keyBytes: key(40)
      })
    ],
    classifiedPayloadProfiles: profiles,
    normalizedContentType: 'application/vnd.fake-provider+json',
    stageTtlMs: 60_000,
    reconciliationPolicy: policy
  };
}

class MutableConnections implements VerifiedIngressSourceConnectionRegistry {
  current: VerifiedIngressSourceConnectionConfig | undefined = configuration();

  resolve() {
    return this.current;
  }
}

class MemoryStageStore implements ClassifiedPayloadStageStore {
  state: 'empty' | 'staged' | 'adoption_pending' | 'adopted' = 'empty';
  bytes = new Uint8Array();
  descriptor: ClassifiedPayloadDescriptor | undefined;
  stage: AuthenticatedPayloadStageDescriptor | undefined;
  payloadRef = undefined as ReturnType<typeof createPayloadRef> | undefined;

  async put(input: Parameters<ClassifiedPayloadStageStore['put']>[0]) {
    this.state = 'staged';
    this.bytes = Uint8Array.from(input.bytes);
    this.descriptor = input.descriptor;
    this.stage = createAuthenticatedPayloadStageDescriptor({
      stageId: ids.stage,
      expectedVersion: 1,
      fence: 1,
      expiresAt: input.expiresAt,
      reconciliationPolicy: input.reconciliationPolicy,
      authenticationProfile: profiles.descriptorAuth,
      authenticationTag: 'a'.repeat(64)
    });
    return this.stage;
  }

  async inspect(): Promise<PayloadStageInspection> {
    if (!this.stage || !this.descriptor) throw new TypeError('missing stage');
    return Object.freeze({
      stage: this.stage,
      classified: this.descriptor,
      state: this.state === 'empty' ? 'staged' : this.state,
      ...(this.payloadRef ? { payloadRef: this.payloadRef } : {})
    });
  }

  async adopt(input: Parameters<ClassifiedPayloadStageStore['adopt']>[0]) {
    if (!this.stage || this.state !== 'staged') throw new TypeError('not staged');
    this.payloadRef = createPayloadRef(input.payloadRefId);
    this.state = 'adoption_pending';
    this.stage = createAuthenticatedPayloadStageDescriptor({
      stageId: this.stage.stageId,
      expectedVersion: 2,
      fence: 2,
      expiresAt: this.stage.expiresAt,
      reconciliationPolicy: this.stage.reconciliationPolicy,
      authenticationProfile: this.stage.authenticationProfile,
      authenticationTag: 'b'.repeat(64)
    });
    return Object.freeze({
      kind: 'adopted' as const,
      payloadRef: this.payloadRef,
      continuation: this.stage
    });
  }

  async markAdopted(input: Parameters<ClassifiedPayloadStageStore['markAdopted']>[0]) {
    if (this.state !== 'adoption_pending' || this.payloadRef?.id !== input.payloadRef.id) {
      throw new TypeError('not adoption pending');
    }
    this.state = 'adopted';
    return Object.freeze({ kind: 'marked' as const, payloadRef: input.payloadRef });
  }

  async purge(): Promise<never> {
    throw new TypeError('unused');
  }

  async listReconciliationCandidates(): Promise<PayloadStageReconciliationPage> {
    return Object.freeze({ candidates: Object.freeze([]) });
  }
}

async function candidateFor(store: MemoryStageStore): Promise<PayloadStageReconciliationCandidate> {
  const inspection = await store.inspect();
  return Object.freeze({
    stageId: inspection.stage.stageId,
    expectedVersion: inspection.stage.expectedVersion,
    fence: inspection.stage.fence,
    expiresAt: inspection.stage.expiresAt,
    reconciliationPolicy: inspection.stage.reconciliationPolicy
  });
}

function verifier(): RegisteredVerifiedIngressVerifier {
  return Object.freeze({
    contract: verifierContract,
    revisionId: ids.verifierRevision,
    verify(input: Parameters<RegisteredVerifiedIngressVerifier['verify']>[0]) {
      const evidence = input.protocolEvidence as { signature?: unknown };
      if (evidence?.signature !== 'valid') {
        return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_authenticity' as const });
      }
      const parsed = JSON.parse(new TextDecoder().decode(input.rawEnvelope)) as {
        eventKey: string;
        retained: string;
      };
      return Object.freeze({
        kind: 'verified' as const,
        semanticIdentityMaterial: new TextEncoder().encode(parsed.eventKey),
        normalizedRetainedContent: new TextEncoder().encode(parsed.retained)
      });
    }
  });
}

function harness(
  connections = new MutableConnections(),
  stageStore = new MemoryStageStore()
) {
  let nextHandle = 20;
  const boundary = createVerifiedIngressBoundary({
    binding,
    sourceConnections: connections,
    verifiers: { resolve: () => verifier() },
    stageStore,
    clock: { now: () => '2026-08-11T00:00:00.000Z' },
    newHandleId: () => `00000000-0000-4000-8000-${String(nextHandle++).padStart(12, '0')}`
  });
  return { boundary, connections, stageStore };
}

const raw = new TextEncoder().encode(JSON.stringify({
  eventKey: 'provider-event-42',
  retained: 'normalized classified content',
  scope: 'caller-forged-workspace',
  connection: 'caller-forged-connection'
}));

describe('sealed verified ingress boundary', () => {
  test('route-bound verification derives trusted material, stages only normalized bytes, and rejects forged handles', async () => {
    const first = harness();
    const staged = await first.boundary.verifyAndStage({
      rawEnvelope: raw,
      protocolEvidence: { signature: 'valid' }
    });
    expect(staged.kind).toBe('staged');
    if (staged.kind !== 'staged') throw new TypeError('expected staged');
    const opened = first.boundary.sealReader.openCurrentStaged(staged.handle);
    expect(opened).toMatchObject({
      sourceConnectionId: ids.connection,
      sourceConnectionRevisionId: ids.connectionRevision1,
      scope: { workspaceId: ids.workspace, eventId: ids.event },
      verifierRevisionId: ids.verifierRevision
    });
    expect(opened?.semanticIdentity).toMatch(/^si1_[A-Za-z0-9_-]{43}$/);
    expect(opened?.contentBindings[0]?.value).toMatch(/^kb1_[A-Za-z0-9_-]{43}$/);
    expect(opened?.contentBindings[0]?.keyVerifier).toMatch(/^ikv1_[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(first.stageStore.bytes)).toBe('normalized classified content');
    expect(new TextDecoder().decode(first.stageStore.bytes)).not.toContain('caller-forged');

    expect(first.boundary.sealReader.openCurrentStaged({ ...staged.handle })).toBeUndefined();
    expect(first.boundary.sealReader.openCurrentStaged({ id: staged.handle.id })).toBeUndefined();
    expect(harness().boundary.sealReader.openCurrentStaged(staged.handle)).toBeUndefined();
  });

  test('rejects invalid and oversized envelopes before staging', async () => {
    const target = harness();
    expect(await target.boundary.verifyAndStage({
      rawEnvelope: raw,
      protocolEvidence: { signature: 'wrong' }
    })).toEqual({ kind: 'rejected', reason: 'invalid_authenticity' });
    expect(target.stageStore.state).toBe('empty');
    expect(await target.boundary.verifyAndStage({
      rawEnvelope: new Uint8Array(2_049),
      protocolEvidence: { signature: 'valid' }
    })).toEqual({ kind: 'rejected', reason: 'raw_envelope_too_large' });
    expect(target.stageStore.state).toBe('empty');
  });

  test('rechecks revocation/rotation and seals the exact acquired adoption continuation', async () => {
    const target = harness();
    const staged = await target.boundary.verifyAndStage({
      rawEnvelope: raw,
      protocolEvidence: { signature: 'valid' }
    });
    if (staged.kind !== 'staged') throw new TypeError('expected staged');
    target.connections.current = configuration(ids.connectionRevision2);
    expect(target.boundary.sealReader.openCurrentStaged(staged.handle)).toBeUndefined();
    await expect(target.boundary.adopt({
      handle: staged.handle,
      payloadRefId: parsePayloadRefId(ids.payload)
    })).rejects.toThrow(/unsealed_or_stale/);

    target.connections.current = configuration();
    const adopted = await target.boundary.adopt({
      handle: staged.handle,
      payloadRefId: parsePayloadRefId(ids.payload)
    });
    const opened = target.boundary.sealReader.openCurrentAdopted(adopted);
    expect(Number(opened?.stage.expectedVersion)).toBe(1);
    expect(Number(opened?.adoptedStage.expectedVersion)).toBe(2);
    expect(Number(opened?.adoptedStage.fence)).toBe(2);
    expect(opened?.payloadRef.id).toBe(parsePayloadRefId(ids.payload));
    expect(target.stageStore.state).toBe('adoption_pending');
    expect((await target.boundary.markAdopted(adopted)).id).toBe(parsePayloadRefId(ids.payload));
    expect(target.stageStore.state).toBe('adopted');
  });

  test('authenticates a canonical durable intent and reseals exact staged and adoption-pending state after restart', async () => {
    const first = harness();
    const staged = await first.boundary.verifyAndStage({
      rawEnvelope: raw,
      protocolEvidence: { signature: 'valid' }
    });
    if (staged.kind !== 'staged') throw new TypeError('expected staged');
    const intent = first.boundary.recovery.prepare({
      handle: staged.handle,
      intentId: '00000000-0000-4000-8000-000000000030',
      payloadRefId: parsePayloadRefId(ids.payload)
    });
    expect(intent.authenticator).toMatch(/^via1_[0-9a-f]{64}$/);
    expect(intent.record.expectedDescriptorBinding).toMatch(/^idb1_[0-9a-f]{64}$/);
    expect(JSON.stringify(intent)).not.toContain(first.stageStore.descriptor?.integrityDigest ?? 'missing');

    const serialized = JSON.parse(JSON.stringify(intent)) as unknown;
    const restarted = harness(first.connections, first.stageStore);
    const stagedRecovery = restarted.boundary.recovery.reseal({
      intent: serialized,
      candidate: await candidateFor(first.stageStore)
    });
    expect((await stagedRecovery).kind).toBe('staged');
    const openedStagedRecovery = await stagedRecovery;
    if (openedStagedRecovery.kind !== 'staged') throw new TypeError('expected staged recovery');
    const adopted = await restarted.boundary.adopt({
      handle: openedStagedRecovery.handle,
      payloadRefId: parsePayloadRefId(ids.payload)
    });
    expect(restarted.boundary.sealReader.openCurrentAdopted(adopted)?.payloadRef.id)
      .toBe(parsePayloadRefId(ids.payload));

    const restartedAgain = harness(first.connections, first.stageStore);
    const pendingRecovery = await restartedAgain.boundary.recovery.reseal({
      intent: serialized,
      candidate: await candidateFor(first.stageStore)
    });
    expect(pendingRecovery.kind).toBe('adoption_pending');
    if (pendingRecovery.kind !== 'adoption_pending') {
      throw new TypeError('expected adoption pending recovery');
    }
    await restartedAgain.boundary.markAdopted(pendingRecovery.handle);
    expect(first.stageStore.state).toBe('adopted');

    const forged = structuredClone(serialized) as {
      record: { semanticIdentity: string };
      authenticator: string;
    };
    forged.record.semanticIdentity = `si1_${'A'.repeat(43)}`;
    expect(restarted.boundary.recovery.verifyCurrent(forged).kind).toBe('invalid');
    expect((await restarted.boundary.recovery.reseal({
      intent: forged,
      candidate: await candidateFor(first.stageStore)
    })).kind).toBe('invalid');

    const excess = structuredClone(serialized) as {
      record: { configuration: { binding: Record<string, unknown> } };
    };
    excess.record.configuration.binding.untrusted = true;
    expect(restarted.boundary.recovery.verifyCurrent(excess).kind).toBe('invalid');
  });

  test('deep-normalizes sealed configuration and refuses recovery after exact registration rotation', async () => {
    const target = harness();
    const staged = await target.boundary.verifyAndStage({
      rawEnvelope: raw,
      protocolEvidence: { signature: 'valid' }
    });
    if (staged.kind !== 'staged') throw new TypeError('expected staged');
    const opened = target.boundary.sealReader.openStaged(staged.handle);
    expect(Object.isFrozen(opened?.configuration)).toBe(true);
    expect(Object.isFrozen(opened?.configuration.classifiedPayloadProfiles)).toBe(true);
    expect(Object.isFrozen(opened?.stage)).toBe(true);
    const intent = target.boundary.recovery.prepare({
      handle: staged.handle,
      intentId: '00000000-0000-4000-8000-000000000031',
      payloadRefId: parsePayloadRefId(ids.payload)
    });
    target.connections.current = configuration(ids.connectionRevision2);
    expect(target.boundary.recovery.verifyCurrent(intent).kind).toBe('stale_registration');
    expect((await target.boundary.recovery.reseal({
      intent,
      candidate: await candidateFor(target.stageStore)
    })).kind).toBe('stale_registration');
  });
});
