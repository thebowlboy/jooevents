import { describe, expect, test } from 'bun:test';
import {
  createPayloadRef,
  parseAggregateVersion,
  parseInstant,
  parsePayloadRefId,
  parsePayloadStageId,
  type AggregateVersion,
  type PayloadRef
} from '@jooevents/kernel';
import {
  ClassifiedPayloadStageError,
  createAuthenticatedPayloadStageDescriptor,
  createClassifiedPayloadDescriptor,
  createClassifiedPayloadProfileRef,
  createPayloadStageFence,
  createSafePayloadStageOperationalEvent,
  createSecretReference,
  createSecretStoreAdapterRef,
  createStageReconciliationCursor,
  createStageReconciliationPolicyRef,
  createUnadoptedStageProofAuthority,
  toSafePayloadStageAdoptionResult,
  type AuthenticatedPayloadStageDescriptor,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type ClassifiedPayloadStageErrorCode,
  type ClassifiedPayloadStageStore,
  type PayloadStageAdoptionResult,
  type PayloadStageInspection,
  type PayloadStageReconciliationCandidate,
  type SecretReference,
  type SecretStore,
  type SecretStoreAdapterRef,
  type StageReconciliationCursor,
  type StageReconciliationPolicyRef,
  type UnadoptedStageProof,
  type UnadoptedStageProofVerifier
} from './classified-payloads';

const stageIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c7c40',
  '018f0f47-7a86-7d36-8a25-9f86589c7c41',
  '018f0f47-7a86-7d36-8a25-9f86589c7c42'
] as const;
const payloadIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c7d40',
  '018f0f47-7a86-7d36-8a25-9f86589c7d41'
] as const;
const beforeExpiry = parseInstant('2026-08-11T09:00:00.000Z');
const expiry = parseInstant('2026-08-11T10:00:00.000Z');
const afterExpiry = parseInstant('2026-08-11T11:00:00.000Z');
const reconciliationPolicy = createStageReconciliationPolicyRef('reconciliation.classified-stage', 1);

function profileSet(version: number): ClassifiedPayloadProfiles {
  return Object.freeze({
    classification: createClassifiedPayloadProfileRef('classification', 'classification.private-document', version),
    schema: createClassifiedPayloadProfileRef('schema', 'schema.private-document', version),
    content: createClassifiedPayloadProfileRef('content', 'content.private-document', version),
    integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', version),
    descriptorAuth: createClassifiedPayloadProfileRef('descriptor_auth', 'descriptor-auth.hmac-sha256', version)
  });
}

function profileKey(profile: ClassifiedPayloadProfileRef): string {
  return `${profile.kind}:${profile.key}@${profile.version}`;
}

function policyKey(policy: StageReconciliationPolicyRef): string {
  return `${policy.key}@${policy.version}`;
}

function profilesOf(profiles: ClassifiedPayloadProfiles): readonly ClassifiedPayloadProfileRef[] {
  return [profiles.classification, profiles.schema, profiles.content, profiles.integrity, profiles.descriptorAuth];
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', owned(bytes)));
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', owned(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, owned(new TextEncoder().encode(value))));
}

async function verifyHmac(keyBytes: Uint8Array, value: string, tag: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', owned(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, unhex(tag), owned(new TextEncoder().encode(value)));
}

function sameDescriptor(left: ClassifiedPayloadDescriptor, right: ClassifiedPayloadDescriptor): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface StageRecord {
  readonly stageId: ReturnType<typeof parsePayloadStageId>;
  version: number;
  fence: number;
  readonly expiresAt: string;
  readonly reconciliationPolicy: StageReconciliationPolicyRef;
  readonly classified: ClassifiedPayloadDescriptor;
  readonly bytes: Uint8Array;
  readonly storageLocator: string;
  state: 'staged' | 'adoption_pending' | 'adopted';
  payloadRef?: PayloadRef;
}

class InMemoryClassifiedPayloadStageStore implements ClassifiedPayloadStageStore {
  private readonly records = new Map<string, StageRecord>();
  private readonly retainedProfiles = new Map<string, ClassifiedPayloadProfileRef>();
  private readonly authenticationKeys = new Map<string, Uint8Array>();
  private readonly policies = new Set<string>();
  private readonly cursors = new Map<string, string>();
  private readonly purgeProofVerifier: UnadoptedStageProofVerifier | undefined;
  private nextStage = 0;
  private nextCursor = 0;

  constructor(
    initialProfiles: ClassifiedPayloadProfiles,
    authenticationKey: Uint8Array,
    purgeProofVerifier?: UnadoptedStageProofVerifier
  ) {
    this.registerProfiles(initialProfiles, authenticationKey);
    this.policies.add(policyKey(reconciliationPolicy));
    this.purgeProofVerifier = purgeProofVerifier;
  }

  registerProfiles(profiles: ClassifiedPayloadProfiles, authenticationKey: Uint8Array) {
    for (const profile of profilesOf(profiles)) this.retainedProfiles.set(profileKey(profile), profile);
    this.authenticationKeys.set(profileKey(profiles.descriptorAuth), authenticationKey.slice());
  }

  removeProfile(profile: ClassifiedPayloadProfileRef) {
    for (const record of this.records.values()) {
      if (profilesOf(record.classified.profiles).some((candidate) => profileKey(candidate) === profileKey(profile))) {
        throw new ClassifiedPayloadStageError('profile_in_use');
      }
    }
    this.retainedProfiles.delete(profileKey(profile));
    this.authenticationKeys.delete(profileKey(profile));
  }

  private assertProfiles(descriptor: ClassifiedPayloadDescriptor) {
    for (const profile of profilesOf(descriptor.profiles)) {
      if (!this.retainedProfiles.has(profileKey(profile))) throw new ClassifiedPayloadStageError('unknown_profile');
    }
  }

  private descriptorFrame(input: {
    readonly stageId: string;
    readonly version: number;
    readonly fence: number;
    readonly expiresAt: string;
    readonly reconciliationPolicy: StageReconciliationPolicyRef;
    readonly authenticationProfile: ClassifiedPayloadProfileRef<'descriptor_auth'>;
  }): string {
    return JSON.stringify([
      'payload-stage-descriptor',
      input.stageId,
      input.version,
      input.fence,
      input.expiresAt,
      input.reconciliationPolicy.key,
      input.reconciliationPolicy.version,
      input.authenticationProfile.key,
      input.authenticationProfile.version
    ]);
  }

  private async signed(record: StageRecord): Promise<AuthenticatedPayloadStageDescriptor> {
    const authenticationProfile = record.classified.profiles.descriptorAuth;
    const key = this.authenticationKeys.get(profileKey(authenticationProfile));
    if (!key) throw new ClassifiedPayloadStageError('unknown_profile');
    const frame = this.descriptorFrame({
      stageId: record.stageId,
      version: record.version,
      fence: record.fence,
      expiresAt: record.expiresAt,
      reconciliationPolicy: record.reconciliationPolicy,
      authenticationProfile
    });
    return createAuthenticatedPayloadStageDescriptor({
      stageId: record.stageId,
      expectedVersion: record.version,
      fence: record.fence,
      expiresAt: record.expiresAt,
      reconciliationPolicy: record.reconciliationPolicy,
      authenticationProfile,
      authenticationTag: await hmac(key, frame)
    });
  }

  private async authenticated(stage: AuthenticatedPayloadStageDescriptor): Promise<StageRecord> {
    const key = this.authenticationKeys.get(profileKey(stage.authenticationProfile));
    if (!key) throw new ClassifiedPayloadStageError('unknown_profile');
    const frame = this.descriptorFrame({
      stageId: stage.stageId,
      version: stage.expectedVersion,
      fence: stage.fence,
      expiresAt: stage.expiresAt,
      reconciliationPolicy: stage.reconciliationPolicy,
      authenticationProfile: stage.authenticationProfile
    });
    if (!await verifyHmac(key, frame, stage.authenticationTag)) throw new ClassifiedPayloadStageError('invalid_descriptor_auth');
    const record = this.records.get(stage.stageId);
    if (!record) throw new ClassifiedPayloadStageError('stage_not_found');
    return record;
  }

  private assertCurrent(record: StageRecord, version: number, fence: number) {
    if (record.version !== version) throw new ClassifiedPayloadStageError('stale_stage_version');
    if (record.fence !== fence) throw new ClassifiedPayloadStageError('stale_stage_fence');
  }

  private candidate(record: StageRecord): PayloadStageReconciliationCandidate {
    return Object.freeze({
      stageId: record.stageId,
      expectedVersion: parseAggregateVersion(record.version),
      fence: createPayloadStageFence(record.fence),
      expiresAt: parseInstant(record.expiresAt),
      reconciliationPolicy: record.reconciliationPolicy
    });
  }

  private async inspection(record: StageRecord): Promise<PayloadStageInspection> {
    return Object.freeze({
      stage: await this.signed(record),
      classified: record.classified,
      state: record.state,
      ...(record.payloadRef ? { payloadRef: record.payloadRef } : {})
    });
  }

  async put(input: {
    readonly descriptor: ClassifiedPayloadDescriptor;
    readonly bytes: Uint8Array;
    readonly expiresAt: ReturnType<typeof parseInstant>;
    readonly reconciliationPolicy: StageReconciliationPolicyRef;
  }): Promise<AuthenticatedPayloadStageDescriptor> {
    this.assertProfiles(input.descriptor);
    if (!this.policies.has(policyKey(input.reconciliationPolicy))) throw new ClassifiedPayloadStageError('unknown_profile');
    if (input.bytes.byteLength !== input.descriptor.byteSize || await sha256(input.bytes) !== input.descriptor.integrityDigest) {
      throw new ClassifiedPayloadStageError('descriptor_mismatch');
    }
    const stageId = stageIds[this.nextStage++];
    if (!stageId) throw new Error('test stage ID supply exhausted');
    const record: StageRecord = {
      stageId: parsePayloadStageId(stageId),
      version: 1,
      fence: 1,
      expiresAt: input.expiresAt,
      reconciliationPolicy: input.reconciliationPolicy,
      classified: input.descriptor,
      bytes: input.bytes.slice(),
      storageLocator: `memory://classified-private/${stageId}`,
      state: 'staged'
    };
    this.records.set(stageId, record);
    return this.signed(record);
  }

  async inspect(input:
    | { readonly source: 'descriptor'; readonly stage: AuthenticatedPayloadStageDescriptor }
    | { readonly source: 'reconciliation'; readonly candidate: PayloadStageReconciliationCandidate }
  ): Promise<PayloadStageInspection> {
    if (input.source === 'descriptor') {
      const record = await this.authenticated(input.stage);
      this.assertCurrent(record, input.stage.expectedVersion, input.stage.fence);
      return this.inspection(record);
    }
    const record = this.records.get(input.candidate.stageId);
    if (!record) throw new ClassifiedPayloadStageError('stage_not_found');
    this.assertCurrent(record, input.candidate.expectedVersion, input.candidate.fence);
    if (policyKey(record.reconciliationPolicy) !== policyKey(input.candidate.reconciliationPolicy)) {
      throw new ClassifiedPayloadStageError('proof_mismatch');
    }
    return this.inspection(record);
  }

  async adopt(input: {
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly expectedDescriptor: ClassifiedPayloadDescriptor;
    readonly payloadRefId: ReturnType<typeof parsePayloadRefId>;
    readonly at: ReturnType<typeof parseInstant>;
  }): Promise<PayloadStageAdoptionResult> {
    const record = await this.authenticated(input.stage);
    this.assertProfiles(record.classified);
    if (!sameDescriptor(record.classified, input.expectedDescriptor)) throw new ClassifiedPayloadStageError('descriptor_mismatch');
    if (record.state !== 'staged') {
      if (record.payloadRef?.id !== input.payloadRefId) throw new ClassifiedPayloadStageError('adoption_conflict');
      return Object.freeze({ kind: 'replay', payloadRef: record.payloadRef, continuation: await this.signed(record) });
    }
    this.assertCurrent(record, input.stage.expectedVersion, input.stage.fence);
    if (input.at >= record.expiresAt) throw new ClassifiedPayloadStageError('stage_expired');
    record.payloadRef = createPayloadRef(input.payloadRefId);
    record.state = 'adoption_pending';
    record.version += 1;
    record.fence += 1;
    return Object.freeze({ kind: 'adopted', payloadRef: record.payloadRef, continuation: await this.signed(record) });
  }

  async markAdopted(input: {
    readonly stage: AuthenticatedPayloadStageDescriptor;
    readonly payloadRef: PayloadRef;
  }) {
    const record = await this.authenticated(input.stage);
    if (record.state === 'adopted') {
      if (record.payloadRef?.id !== input.payloadRef.id) throw new ClassifiedPayloadStageError('adoption_conflict');
      return Object.freeze({ kind: 'replay' as const, payloadRef: record.payloadRef });
    }
    this.assertCurrent(record, input.stage.expectedVersion, input.stage.fence);
    if (record.state !== 'adoption_pending' || record.payloadRef?.id !== input.payloadRef.id) {
      throw new ClassifiedPayloadStageError('adoption_conflict');
    }
    record.state = 'adopted';
    record.version += 1;
    return Object.freeze({ kind: 'marked' as const, payloadRef: record.payloadRef });
  }

  async purge(input: {
    readonly candidate: PayloadStageReconciliationCandidate;
    readonly proof: UnadoptedStageProof;
  }) {
    const record = this.records.get(input.candidate.stageId);
    if (!record) throw new ClassifiedPayloadStageError('stage_not_found');
    this.assertCurrent(record, input.candidate.expectedVersion, input.candidate.fence);
    if (record.state !== 'staged') throw new ClassifiedPayloadStageError('stage_not_purgeable');
    if (!this.purgeProofVerifier) throw new ClassifiedPayloadStageError('proof_mismatch');
    const verification = await this.purgeProofVerifier.verifyAndConsume({
      candidate: this.candidate(record),
      proof: input.proof
    });
    if (verification.kind === 'adopted') throw new ClassifiedPayloadStageError('canonical_stage_adopted');
    if (verification.kind === 'uncertain') {
      throw new ClassifiedPayloadStageError('canonical_stage_ownership_uncertain');
    }
    this.records.delete(record.stageId);
    return Object.freeze({ kind: 'purged' as const, stageId: input.candidate.stageId });
  }

  async listReconciliationCandidates(input: { readonly cursor?: StageReconciliationCursor; readonly limit: number }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) throw new ClassifiedPayloadStageError('invalid_limit');
    const after = input.cursor ? this.cursors.get(input.cursor) : undefined;
    if (input.cursor && after === undefined) throw new ClassifiedPayloadStageError('invalid_cursor');
    const records = [...this.records.values()]
      .filter((record) => record.state !== 'adopted' && (after === undefined || record.stageId > after))
      .sort((left, right) => left.stageId.localeCompare(right.stageId));
    const selected = records.slice(0, input.limit);
    const hasMore = records.length > selected.length;
    let nextCursor: StageReconciliationCursor | undefined;
    if (hasMore) {
      const value = createStageReconciliationCursor(`cursor_${String(++this.nextCursor).padStart(12, '0')}`);
      const last = selected.at(-1);
      if (last) this.cursors.set(value, last.stageId);
      nextCursor = value;
    }
    return Object.freeze({
      candidates: Object.freeze(selected.map((record) => this.candidate(record))),
      ...(nextCursor ? { nextCursor } : {})
    });
  }
}

function descriptorFixture(profiles: ClassifiedPayloadProfiles, bytes: Uint8Array, digest: string) {
  return createClassifiedPayloadDescriptor({
    profiles,
    scopeBinding: 'scope-verifier-private-canary',
    contentType: 'application/x-private-canary',
    byteSize: bytes.byteLength,
    integrityDigest: digest
  });
}

async function putFixture(store: InMemoryClassifiedPayloadStageStore, profiles = profileSet(1)) {
  const bytes = new TextEncoder().encode('low entropy classified canary');
  const digest = await sha256(bytes);
  const descriptor = descriptorFixture(profiles, bytes, digest);
  const stage = await store.put({ descriptor, bytes, expiresAt: expiry, reconciliationPolicy });
  return { bytes, digest, descriptor, stage };
}

async function expectStageError(promise: Promise<unknown>, code: ClassifiedPayloadStageErrorCode) {
  try {
    await promise;
    throw new Error('expected classified payload stage error');
  } catch (error) {
    expect(error).toBeInstanceOf(ClassifiedPayloadStageError);
    expect((error as ClassifiedPayloadStageError).code).toBe(code);
  }
}

describe('classified payload staging and reconciliation', () => {
  test('a returned stage is durably discoverable after a crash before SQL or job state exists', async () => {
    const store = new InMemoryClassifiedPayloadStageStore(profileSet(1), new TextEncoder().encode('descriptor-auth-key-v1'));
    await putFixture(store);

    const page = await store.listReconciliationCandidates({ limit: 20 });
    expect(page.candidates).toHaveLength(1);
    expect(Object.keys(page.candidates[0] ?? {}).sort()).toEqual([
      'expectedVersion', 'expiresAt', 'fence', 'reconciliationPolicy', 'stageId'
    ]);
    const inspection = await store.inspect({ source: 'reconciliation', candidate: page.candidates[0]! });
    expect(inspection.state).toBe('staged');
  });

  test('candidate listing is bounded and cursor-driven', async () => {
    const store = new InMemoryClassifiedPayloadStageStore(profileSet(1), new TextEncoder().encode('descriptor-auth-key-v1'));
    await putFixture(store);
    await putFixture(store);
    const first = await store.listReconciliationCandidates({ limit: 1 });
    expect(first.candidates).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await store.listReconciliationCandidates({ cursor: first.nextCursor!, limit: 1 });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0]?.stageId).not.toBe(first.candidates[0]?.stageId);
    await expectStageError(store.listReconciliationCandidates({ limit: 51 }), 'invalid_limit');
    await expectStageError(store.listReconciliationCandidates({ cursor: createStageReconciliationCursor('cursor_999999999999'), limit: 1 }), 'invalid_cursor');
  });

  test('wrong authentication, stale version, and stale fence all fail closed', async () => {
    const store = new InMemoryClassifiedPayloadStageStore(profileSet(1), new TextEncoder().encode('descriptor-auth-key-v1'));
    const staged = await putFixture(store);
    const tampered = createAuthenticatedPayloadStageDescriptor({
      stageId: staged.stage.stageId,
      expectedVersion: staged.stage.expectedVersion,
      fence: staged.stage.fence,
      expiresAt: staged.stage.expiresAt,
      reconciliationPolicy: staged.stage.reconciliationPolicy,
      authenticationProfile: staged.stage.authenticationProfile,
      authenticationTag: '0'.repeat(64)
    });
    await expectStageError(store.inspect({ source: 'descriptor', stage: tampered }), 'invalid_descriptor_auth');

    const adopted = await store.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    await expectStageError(store.inspect({ source: 'descriptor', stage: staged.stage }), 'stale_stage_version');
    const candidate = (await store.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const wrongFence = Object.freeze({ ...candidate, fence: createPayloadStageFence(Number(candidate.fence) + 1) });
    await expectStageError(store.inspect({ source: 'reconciliation', candidate: wrongFence }), 'stale_stage_fence');
    expect(Number(adopted.continuation.expectedVersion)).toBe(2);
  });

  test('adoption is idempotent for one payload identity and changed identity conflicts', async () => {
    const store = new InMemoryClassifiedPayloadStageStore(profileSet(1), new TextEncoder().encode('descriptor-auth-key-v1'));
    const staged = await putFixture(store);
    const input = {
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    };
    const first = await store.adopt(input);
    const replay = await store.adopt(input);
    expect(first.kind).toBe('adopted');
    expect(replay.kind).toBe('replay');
    expect(replay.payloadRef).toEqual(first.payloadRef);
    await expectStageError(store.adopt({ ...input, payloadRefId: parsePayloadRefId(payloadIds[1]) }), 'adoption_conflict');

    const mark = await store.markAdopted({ stage: first.continuation, payloadRef: first.payloadRef });
    const markReplay = await store.markAdopted({ stage: first.continuation, payloadRef: first.payloadRef });
    expect(mark.kind).toBe('marked');
    expect(markReplay.kind).toBe('replay');
    expect((await store.listReconciliationCandidates({ limit: 10 })).candidates).toHaveLength(0);
  });

  test('cleanup authority requires expiry, exact current state, and a fresh canonical absence check', async () => {
    let now = beforeExpiry;
    let ownership: 'unadopted' | 'adopted' | 'uncertain' = 'unadopted';
    let lookupCount = 0;
    const authority = createUnadoptedStageProofAuthority({
      clock: { now: () => now },
      ownership: {
        resolve: () => {
          lookupCount += 1;
          return Object.freeze({ kind: ownership });
        }
      }
    });
    const store = new InMemoryClassifiedPayloadStageStore(
      profileSet(1),
      new TextEncoder().encode('descriptor-auth-key-v1'),
      authority.verifier
    );
    const staged = await putFixture(store);
    const candidate = (await store.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const inspection = await store.inspect({ source: 'reconciliation', candidate });
    await expectStageError(authority.issue({ candidate, inspection }), 'stage_not_purgeable');
    expect(lookupCount).toBe(0);

    now = afterExpiry;
    const issued = await authority.issue({ candidate, inspection });
    if (issued.kind !== 'issued') throw new TypeError('expected cleanup proof');
    expect(lookupCount).toBe(1);

    await store.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    await expectStageError(store.purge({ candidate, proof: issued.proof }), 'stale_stage_version');
    expect(lookupCount).toBe(1);

    const cleanAuthority = createUnadoptedStageProofAuthority({
      clock: { now: () => afterExpiry },
      ownership: { resolve: () => Object.freeze({ kind: 'unadopted' as const }) }
    });
    const cleanStore = new InMemoryClassifiedPayloadStageStore(
      profileSet(1),
      new TextEncoder().encode('descriptor-auth-key-v1'),
      cleanAuthority.verifier
    );
    await putFixture(cleanStore);
    const cleanCandidate = (await cleanStore.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const cleanInspection = await cleanStore.inspect({ source: 'reconciliation', candidate: cleanCandidate });
    const cleanIssued = await cleanAuthority.issue({ candidate: cleanCandidate, inspection: cleanInspection });
    if (cleanIssued.kind !== 'issued') throw new TypeError('expected cleanup proof');
    expect(await cleanStore.purge({ candidate: cleanCandidate, proof: cleanIssued.proof })).toEqual({ kind: 'purged', stageId: cleanCandidate.stageId });
    await expectStageError(cleanStore.inspect({ source: 'reconciliation', candidate: cleanCandidate }), 'stage_not_found');
  });

  test('cleanup proofs are empty, one-shot, process-private, and fail closed on clone, foreign authority, or uncertainty', async () => {
    const ownership = { kind: 'unadopted' as 'unadopted' | 'adopted' | 'uncertain' };
    const makeAuthority = () => createUnadoptedStageProofAuthority({
      clock: { now: () => afterExpiry },
      ownership: { resolve: () => Object.freeze({ kind: ownership.kind }) }
    });
    const authority = makeAuthority();
    const store = new InMemoryClassifiedPayloadStageStore(
      profileSet(1),
      new TextEncoder().encode('descriptor-auth-key-v1'),
      authority.verifier
    );
    await putFixture(store);
    const candidate = (await store.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const inspection = await store.inspect({ source: 'reconciliation', candidate });

    const first = await authority.issue({ candidate, inspection });
    if (first.kind !== 'issued') throw new TypeError('expected cleanup proof');
    expect(Object.keys(first.proof)).toEqual([]);
    const cloned = { ...first.proof } as UnadoptedStageProof;
    await expectStageError(store.purge({ candidate, proof: cloned }), 'proof_mismatch');

    const foreign = makeAuthority();
    const foreignIssued = await foreign.issue({ candidate, inspection });
    if (foreignIssued.kind !== 'issued') throw new TypeError('expected foreign cleanup proof');
    await expectStageError(store.purge({ candidate, proof: foreignIssued.proof }), 'proof_mismatch');

    const oneShot = await authority.issue({ candidate, inspection });
    if (oneShot.kind !== 'issued') throw new TypeError('expected one-shot cleanup proof');
    expect((await authority.verifier.verifyAndConsume({ candidate, proof: oneShot.proof })).kind).toBe('verified');
    await expectStageError(
      authority.verifier.verifyAndConsume({ candidate, proof: oneShot.proof }),
      'proof_mismatch'
    );

    ownership.kind = 'adopted';
    expect((await authority.issue({ candidate, inspection })).kind).toBe('adopted');
    ownership.kind = 'uncertain';
    expect((await authority.issue({ candidate, inspection })).kind).toBe('uncertain');
  });

  test('retained profile and authentication-key versions keep old stages usable across rotation', async () => {
    const v1 = profileSet(1);
    const v2 = profileSet(2);
    const store = new InMemoryClassifiedPayloadStageStore(v1, new TextEncoder().encode('descriptor-auth-key-v1'));
    const old = await putFixture(store, v1);
    store.registerProfiles(v2, new TextEncoder().encode('descriptor-auth-key-v2'));
    const current = await putFixture(store, v2);

    expect(Number((await store.inspect({ source: 'descriptor', stage: old.stage })).classified.profiles.descriptorAuth.version)).toBe(1);
    expect(Number((await store.inspect({ source: 'descriptor', stage: current.stage })).classified.profiles.descriptorAuth.version)).toBe(2);
    await expectStageError(Promise.resolve().then(() => store.removeProfile(v1.descriptorAuth)), 'profile_in_use');
    await expectStageError(Promise.resolve().then(() => store.removeProfile(v1.classification)), 'profile_in_use');
    expect((await store.adopt({
      stage: old.stage,
      expectedDescriptor: old.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    })).kind).toBe('adopted');
  });

  test('safe refs, results, candidates, and operational DTOs leak no classified metadata', async () => {
    const store = new InMemoryClassifiedPayloadStageStore(profileSet(1), new TextEncoder().encode('descriptor-auth-key-v1'));
    const staged = await putFixture(store);
    const adoption = await store.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    const safeResult = toSafePayloadStageAdoptionResult(adoption);
    const page = await store.listReconciliationCandidates({ limit: 10 });
    const logEvent = createSafePayloadStageOperationalEvent({ stageId: staged.stage.stageId, action: 'adopt', outcome: 'succeeded' });
    const safeChannels = JSON.stringify({ payloadRef: safeResult.payloadRef, result: safeResult, page, logEvent });
    for (const canary of [
      staged.digest,
      String(staged.descriptor.byteSize),
      staged.descriptor.contentType,
      staged.descriptor.scopeBinding,
      `memory://classified-private/${staged.stage.stageId}`,
      staged.stage.authenticationTag
    ]) expect(safeChannels).not.toContain(canary);
    expect(Object.keys(safeResult.payloadRef)).toEqual(['id']);
    expect(JSON.stringify(adoption.continuation)).toContain('authenticationTag');
  });
});

interface SecretRecord {
  currentVersion: number;
  readonly reference: Omit<SecretReference, 'version'>;
  readonly versions: Map<number, Uint8Array>;
  readonly revoked: Set<number>;
}

class InMemorySecretStore implements SecretStore {
  private readonly records = new Map<string, SecretRecord>();
  private nextId = 0;

  async create(input: {
    readonly adapter: SecretStoreAdapterRef;
    readonly purpose: string;
    readonly scopeBinding: string;
    readonly secret: Uint8Array;
  }): Promise<SecretReference> {
    const id = `secret-reference-${String(++this.nextId).padStart(4, '0')}`;
    const reference = createSecretReference({ id, version: 1, adapter: input.adapter, purpose: input.purpose, scopeBinding: input.scopeBinding });
    this.records.set(id, {
      currentVersion: 1,
      reference,
      versions: new Map([[1, input.secret.slice()]]),
      revoked: new Set()
    });
    return reference;
  }

  async rotate(input: { readonly reference: SecretReference; readonly expectedVersion: AggregateVersion; readonly secret: Uint8Array }) {
    const record = this.records.get(input.reference.id);
    if (!record || record.currentVersion !== input.expectedVersion) throw new Error('stale_secret_reference');
    const version = record.currentVersion + 1;
    record.currentVersion = version;
    record.versions.set(version, input.secret.slice());
    return createSecretReference({
      id: input.reference.id,
      version,
      adapter: input.reference.adapter,
      purpose: input.reference.purpose,
      scopeBinding: input.reference.scopeBinding
    });
  }

  async revoke(input: { readonly reference: SecretReference; readonly expectedVersion: AggregateVersion }) {
    const record = this.records.get(input.reference.id);
    if (!record || input.reference.version !== input.expectedVersion || !record.versions.has(input.reference.version)) throw new Error('stale_secret_reference');
    record.revoked.add(input.reference.version);
  }

  async withSecret<Value>(input: {
    readonly reference: SecretReference;
    readonly purpose: string;
    readonly scopeBinding: string;
    readonly consume: (secret: Uint8Array) => Value | Promise<Value>;
  }): Promise<Value> {
    const record = this.records.get(input.reference.id);
    const secret = record?.versions.get(input.reference.version);
    if (!record || !secret || record.revoked.has(input.reference.version)
      || input.reference.purpose !== input.purpose || input.reference.scopeBinding !== input.scopeBinding) {
      throw new Error('secret_unavailable');
    }
    const scopedCopy = secret.slice();
    try {
      return await input.consume(scopedCopy);
    } finally {
      scopedCopy.fill(0);
    }
  }
}

test('secret ports retain exact versions and expose bytes only inside the consumer scope', async () => {
  const store = new InMemorySecretStore();
  const adapter = createSecretStoreAdapterRef('secret-adapter.environment', 1);
  const v1 = await store.create({
    adapter,
    purpose: 'provider.api-key',
    scopeBinding: 'workspace-secret-scope',
    secret: new TextEncoder().encode('provider-secret-v1')
  });
  const v2 = await store.rotate({
    reference: v1,
    expectedVersion: v1.version,
    secret: new TextEncoder().encode('provider-secret-v2')
  });
  let scopedBytes: Uint8Array | undefined;
  expect(await store.withSecret({
    reference: v1,
    purpose: 'provider.api-key',
    scopeBinding: 'workspace-secret-scope',
    consume: (secret) => { scopedBytes = secret; return new TextDecoder().decode(secret); }
  })).toBe('provider-secret-v1');
  expect([...scopedBytes ?? []].every((byte) => byte === 0)).toBe(true);
  expect(await store.withSecret({
    reference: v2,
    purpose: 'provider.api-key',
    scopeBinding: 'workspace-secret-scope',
    consume: (secret) => new TextDecoder().decode(secret)
  })).toBe('provider-secret-v2');
  expect(JSON.stringify({ id: 'redacted', version: v2.version })).not.toContain(v2.id);
  await store.revoke({ reference: v1, expectedVersion: v1.version });
  await expect(store.withSecret({
    reference: v1,
    purpose: 'provider.api-key',
    scopeBinding: 'workspace-secret-scope',
    consume: () => undefined
  })).rejects.toThrow('secret_unavailable');
});
