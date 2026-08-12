import { afterEach, describe, expect, test } from 'bun:test';
import {
  ClassifiedPayloadStageError,
  createAuthenticatedPayloadStageDescriptor,
  createClassifiedPayloadDescriptor,
  createClassifiedPayloadProfileRef,
  createPayloadStageFence,
  createStageReconciliationCursor,
  createStageReconciliationPolicyRef,
  createUnadoptedStageProofAuthority,
  type ClassifiedPayloadDescriptor,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type ClassifiedPayloadStageErrorCode,
  type PayloadStageReconciliationCandidate,
  type StageReconciliationPolicyRef,
  type UnadoptedStageProof,
  type UnadoptedStageProofAuthority
} from '@jooevents/application';
import {
  canonicalJsonText,
  parseInstant,
  parsePayloadRefId
} from '@jooevents/kernel';
import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalFilesystemClassifiedPayloadStageStore,
  type RetainedClassifiedPayloadProfileResolver
} from './classified-payload-stage-store';

const stageIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c8a01',
  '018f0f47-7a86-7d36-8a25-9f86589c8a02',
  '018f0f47-7a86-7d36-8a25-9f86589c8a03',
  '018f0f47-7a86-7d36-8a25-9f86589c8a04',
  '018f0f47-7a86-7d36-8a25-9f86589c8a05'
] as const;
const payloadIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c8b01',
  '018f0f47-7a86-7d36-8a25-9f86589c8b02'
] as const;
const beforeExpiry = parseInstant('2026-08-11T09:00:00.000Z');
const expiry = parseInstant('2026-08-11T10:00:00.000Z');
const afterExpiry = parseInstant('2026-08-11T11:00:00.000Z');
const policy = createStageReconciliationPolicyRef('reconciliation.classified-stage', 1);
const childFixture = fileURLToPath(new URL('./test-fixtures/classified-stage-child.ts', import.meta.url));
const lockChildFixture = fileURLToPath(new URL('./test-fixtures/classified-stage-lock-child.ts', import.meta.url));
const storeDirectoryName = '.jooevents-classified-payload-stages-v1';
const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    const directory = directories.pop();
    if (!directory || !basename(directory).startsWith('jooevents-classified-stage-test-')) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RootFixture {
  readonly container: string;
  readonly root: string;
}

function rootFixture(): RootFixture {
  const container = mkdtempSync(join(tmpdir(), 'jooevents-classified-stage-test-'));
  directories.push(container);
  chmodSync(container, 0o700);
  const root = join(container, 'caller-owned-root');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return { container, root };
}

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

function policyKey(reference: StageReconciliationPolicyRef): string {
  return `${reference.key}@${reference.version}`;
}

function profilesOf(profiles: ClassifiedPayloadProfiles): readonly ClassifiedPayloadProfileRef[] {
  return [profiles.classification, profiles.schema, profiles.content, profiles.integrity, profiles.descriptorAuth];
}

class MutableRetainedProfileResolver implements RetainedClassifiedPayloadProfileResolver {
  readonly #profiles = new Set<string>();
  readonly #policies = new Set<string>();
  readonly #keys = new Map<string, Uint8Array>();

  register(profiles: ClassifiedPayloadProfiles, key: Uint8Array): void {
    for (const profile of profilesOf(profiles)) this.#profiles.add(profileKey(profile));
    this.#keys.set(profileKey(profiles.descriptorAuth), Uint8Array.from(key));
    this.#policies.add(policyKey(policy));
  }

  removeProfile(profile: ClassifiedPayloadProfileRef): void {
    this.#profiles.delete(profileKey(profile));
  }

  restoreProfile(profile: ClassifiedPayloadProfileRef): void {
    this.#profiles.add(profileKey(profile));
  }

  removeKey(profile: ClassifiedPayloadProfileRef<'descriptor_auth'>): void {
    this.#keys.delete(profileKey(profile));
  }

  restoreKey(profile: ClassifiedPayloadProfileRef<'descriptor_auth'>, key: Uint8Array): void {
    this.#keys.set(profileKey(profile), Uint8Array.from(key));
  }

  isRetainedProfile(profile: ClassifiedPayloadProfileRef): boolean {
    return this.#profiles.has(profileKey(profile));
  }

  isRetainedReconciliationPolicy(reference: StageReconciliationPolicyRef): boolean {
    return this.#policies.has(policyKey(reference));
  }

  resolveDescriptorAuthenticationKey(profile: ClassifiedPayloadProfileRef<'descriptor_auth'>): Uint8Array | undefined {
    return this.#keys.get(profileKey(profile))?.slice();
  }
}

function resolverWith(profiles = profileSet(1), keyText = 'descriptor-auth-key-material-v1-canary') {
  const resolver = new MutableRetainedProfileResolver();
  resolver.register(profiles, new TextEncoder().encode(keyText));
  return resolver;
}

function store(input: {
  readonly root: string;
  readonly resolver: RetainedClassifiedPayloadProfileResolver;
  readonly ids?: readonly string[];
  readonly purgeAuthority?: UnadoptedStageProofAuthority;
  readonly purgeClock?: { now(): ReturnType<typeof parseInstant> };
  readonly purgeOwnership?: { kind: 'unadopted' | 'adopted' | 'uncertain' };
}) {
  let next = 0;
  const authority = input.purgeAuthority ?? createUnadoptedStageProofAuthority({
    clock: input.purgeClock ?? { now: () => afterExpiry },
    ownership: {
      resolve: () => Object.freeze({ kind: input.purgeOwnership?.kind ?? 'unadopted' })
    }
  });
  const filesystem = new LocalFilesystemClassifiedPayloadStageStore({
    root: input.root,
    profileResolver: input.resolver,
    purgeProofVerifier: authority.verifier,
    ...(input.ids ? { newStageId: () => input.ids?.[next++] ?? crypto.randomUUID() } : {})
  });
  purgeAuthorities.set(filesystem, authority);
  return filesystem;
}

const purgeAuthorities = new WeakMap<LocalFilesystemClassifiedPayloadStageStore, UnadoptedStageProofAuthority>();

async function descriptorFixture(input: {
  readonly profiles?: ClassifiedPayloadProfiles;
  readonly text?: string;
  readonly scopeBinding?: string;
  readonly contentType?: string;
} = {}) {
  const bytes = new TextEncoder().encode(input.text ?? 'low entropy classified payload canary');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const descriptor = createClassifiedPayloadDescriptor({
    profiles: input.profiles ?? profileSet(1),
    scopeBinding: input.scopeBinding ?? 'scope.private-low-entropy-canary',
    contentType: input.contentType ?? 'application/x-private-canary',
    byteSize: bytes.byteLength,
    integrityDigest: digest
  });
  return { bytes, digest, descriptor };
}

async function putFixture(input: {
  readonly store: LocalFilesystemClassifiedPayloadStageStore;
  readonly profiles?: ClassifiedPayloadProfiles;
  readonly text?: string;
  readonly expiresAt?: ReturnType<typeof parseInstant>;
}) {
  const fixture = await descriptorFixture({
    ...(input.profiles ? { profiles: input.profiles } : {}),
    ...(input.text ? { text: input.text } : {})
  });
  const stage = await input.store.put({
    descriptor: fixture.descriptor,
    bytes: fixture.bytes,
    expiresAt: input.expiresAt ?? expiry,
    reconciliationPolicy: policy
  });
  return { ...fixture, stage };
}

async function expectStageError(promise: Promise<unknown>, code: ClassifiedPayloadStageErrorCode) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClassifiedPayloadStageError);
    expect((error as ClassifiedPayloadStageError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return error as ClassifiedPayloadStageError;
  }
  throw new Error(`expected ${code}`);
}

function stageDirectory(root: string, stageId: string): string {
  return join(root, storeDirectoryName, stageId);
}

function metadataPath(root: string, stageId: string): string {
  return join(stageDirectory(root, stageId), 'metadata.json');
}

function payloadPath(root: string, stageId: string): string {
  return join(stageDirectory(root, stageId), 'payload.bin');
}

function lockDirectory(root: string, stageId: string): string {
  return join(stageDirectory(root, stageId), '.lock');
}

function activeLockPathInDirectory(directory: string): string | undefined {
  let current = join(directory, '.lock');
  if (!existsSync(current) || !lstatSync(current).isFile()) return existsSync(current) ? current : undefined;
  for (;;) {
    const nonce = (JSON.parse(readFileSync(current, 'utf8')) as { owner?: { nonce?: string } }).owner?.nonce;
    if (!nonce || !existsSync(join(directory, `.lock-reclaimed-${nonce}`))) return current;
    const successor = join(directory, `.lock-next-${nonce}`);
    if (!existsSync(successor)) return undefined;
    current = successor;
  }
}

function activeLockPath(root: string, stageId: string): string | undefined {
  return activeLockPathInDirectory(stageDirectory(root, stageId));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${basename(path)}`);
}

async function startLockChild(input: {
  readonly root: RootFixture;
  readonly label: string;
  readonly keyText: string;
  readonly action: unknown;
  readonly waitForGo?: boolean;
}) {
  const inputPath = join(input.root.container, `${input.label}-input.json`);
  const readyPath = join(input.root.container, `${input.label}-ready`);
  const goPath = input.waitForGo ? join(input.root.container, `${input.label}-go`) : undefined;
  writeFileSync(inputPath, JSON.stringify(input.action), { mode: 0o600 });
  const child = Bun.spawn([
    process.execPath,
    lockChildFixture,
    'operate',
    input.root.root,
    inputPath,
    readyPath,
    ...(goPath ? [goPath] : [])
  ], {
    env: { ...process.env, JOOEVENTS_TEST_DESCRIPTOR_AUTH_KEY: input.keyText },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  return { child, readyPath, goPath };
}

async function hardKill(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  child.kill('SIGKILL');
  return child.exited;
}

function diskText(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return '';
  if (stat.isFile()) return readFileSync(path).toString('utf8');
  if (!stat.isDirectory()) return '';
  return readdirSync(path).sort().map((name) => diskText(join(path, name))).join('\n');
}

async function proofFor(
  filesystem: LocalFilesystemClassifiedPayloadStageStore,
  candidate: PayloadStageReconciliationCandidate
) {
  const authority = purgeAuthorities.get(filesystem);
  if (!authority) throw new TypeError('missing test purge authority');
  const inspection = await filesystem.inspect({ source: 'reconciliation', candidate });
  const issued = await authority.issue({ candidate, inspection });
  if (issued.kind !== 'issued') throw new TypeError(`cleanup proof was not issued: ${issued.kind}`);
  return issued.proof;
}

describe('local filesystem classified payload stage store', () => {
  test('refuses composition without a cleanup verifier before creating managed storage', () => {
    const testRoot = rootFixture();
    expect(() => new LocalFilesystemClassifiedPayloadStageStore({
      root: testRoot.root,
      profileResolver: resolverWith()
    } as never)).toThrow('classified_payload_stage_purge_verifier_required');
    expect(existsSync(join(testRoot.root, storeDirectoryName))).toBe(false);
  });

  test('a hard-exited put is cursor-discoverable after restart before any SQL or job owner exists', async () => {
    const testRoot = rootFixture();
    const keyText = 'subprocess-descriptor-auth-key-canary-v1';
    const crashed = Bun.spawnSync([process.execPath, childFixture, testRoot.root], {
      env: { ...process.env, JOOEVENTS_TEST_DESCRIPTOR_AUTH_KEY: keyText }
    });
    expect(crashed.exitCode).toBe(73);
    expect(crashed.stderr.toString()).toBe('');

    const resolver = resolverWith(profileSet(1), keyText);
    const restarted = store({ root: testRoot.root, resolver });
    const page = await restarted.listReconciliationCandidates({ limit: 20 });
    expect(page.candidates).toHaveLength(1);
    expect(Object.keys(page.candidates[0] ?? {}).sort()).toEqual([
      'expectedVersion', 'expiresAt', 'fence', 'reconciliationPolicy', 'stageId'
    ]);
    const inspection = await restarted.inspect({ source: 'reconciliation', candidate: page.candidates[0]! });
    expect(inspection.state).toBe('staged');
    expect(diskText(testRoot.root)).not.toContain(keyText);

    const safeCandidateText = JSON.stringify(page);
    for (const canary of [
      'subprocess classified stage canary',
      inspection.classified.integrityDigest,
      inspection.classified.contentType,
      inspection.classified.scopeBinding,
      inspection.stage.authenticationTag,
      testRoot.root,
      keyText
    ]) expect(safeCandidateText).not.toContain(canary);
    expect(safeCandidateText).not.toContain('byteSize');
  });

  test('a hard-exited adopt lock has one exact dead owner and restart reclaims it atomically', async () => {
    const testRoot = rootFixture();
    const keyText = 'adopt-lock-process-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const filesystem = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: filesystem });
    const crashed = await startLockChild({
      root: testRoot,
      label: 'adopt-lock',
      keyText,
      action: {
        action: 'adopt',
        block: 'lock-held',
        blockState: 'staged',
        stage: staged.stage,
        expectedDescriptor: staged.descriptor,
        payloadRefId: payloadIds[0],
        at: beforeExpiry
      }
    });
    await waitForFile(crashed.readyPath);
    expect(activeLockPath(testRoot.root, staged.stage.stageId)).toBeDefined();
    expect(await hardKill(crashed.child)).not.toBe(0);

    const restarted = store({ root: testRoot.root, resolver });
    const adopted = await restarted.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    expect(adopted.kind).toBe('adopted');
    expect(activeLockPath(testRoot.root, staged.stage.stageId)).toBeUndefined();
    expect(readdirSync(stageDirectory(testRoot.root, staged.stage.stageId))
      .filter((name) => name.startsWith('.lock-reclaimed-'))).toHaveLength(2);
  });

  test('a hard-exited markAdopted lock is recoverable and preserves the pending payload binding', async () => {
    const testRoot = rootFixture();
    const keyText = 'mark-lock-process-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const filesystem = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: filesystem });
    const adopted = await filesystem.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    const crashed = await startLockChild({
      root: testRoot,
      label: 'mark-lock',
      keyText,
      action: {
        action: 'mark',
        block: 'lock-held',
        blockState: 'adoption_pending',
        stage: adopted.continuation,
        payloadRefId: adopted.payloadRef.id
      }
    });
    await waitForFile(crashed.readyPath);
    expect(await hardKill(crashed.child)).not.toBe(0);

    const restarted = store({ root: testRoot.root, resolver });
    expect(await restarted.markAdopted({
      stage: adopted.continuation,
      payloadRef: adopted.payloadRef
    })).toEqual({ kind: 'marked', payloadRef: adopted.payloadRef });
    expect(await restarted.markAdopted({
      stage: adopted.continuation,
      payloadRef: adopted.payloadRef
    })).toEqual({ kind: 'replay', payloadRef: adopted.payloadRef });
  });

  test('a hard-exited purge lock consumes no durable authority and restart requires a fresh absence proof', async () => {
    const testRoot = rootFixture();
    const keyText = 'purge-lock-process-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const first = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: first });
    const candidate = (await first.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const crashed = await startLockChild({
      root: testRoot,
      label: 'purge-lock',
      keyText,
      action: {
        action: 'purge',
        block: 'lock-held',
        blockState: 'staged',
        candidate
      }
    });
    await waitForFile(crashed.readyPath);
    expect(await hardKill(crashed.child)).not.toBe(0);
    expect(existsSync(join(stageDirectory(testRoot.root, staged.stage.stageId), 'purge.json'))).toBe(false);

    let restartedLookups = 0;
    const restartedAuthority = createUnadoptedStageProofAuthority({
      clock: { now: () => afterExpiry },
      ownership: {
        resolve: () => {
          restartedLookups += 1;
          return Object.freeze({ kind: 'unadopted' as const });
        }
      }
    });
    const restarted = store({ root: testRoot.root, resolver, purgeAuthority: restartedAuthority });
    const replacementProof = await proofFor(restarted, candidate);
    expect(await restarted.purge({ candidate, proof: replacementProof }))
      .toEqual({ kind: 'purged', stageId: candidate.stageId });
    expect(restartedLookups).toBe(2);
    expect(existsSync(stageDirectory(testRoot.root, staged.stage.stageId))).toBe(false);
  });

  test('a reclaimer hard exit after the atomic dead-lock move leaves only a nonblocking nonce tombstone', async () => {
    const testRoot = rootFixture();
    const keyText = 'reclaim-boundary-process-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const filesystem = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: filesystem });
    const action = {
      action: 'adopt',
      blockState: 'staged',
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: payloadIds[0],
      at: beforeExpiry
    } as const;
    const owner = await startLockChild({
      root: testRoot,
      label: 'dead-owner',
      keyText,
      action: { ...action, block: 'lock-held' }
    });
    await waitForFile(owner.readyPath);
    await hardKill(owner.child);

    const reclaimer = await startLockChild({
      root: testRoot,
      label: 'dead-reclaimer',
      keyText,
      action: { ...action, block: 'after-reclaim' }
    });
    await waitForFile(reclaimer.readyPath);
    expect(activeLockPath(testRoot.root, staged.stage.stageId)).toBeUndefined();
    expect(readdirSync(stageDirectory(testRoot.root, staged.stage.stageId))
      .some((name) => name.startsWith('.lock-reclaimed-'))).toBe(true);
    await hardKill(reclaimer.child);

    const restarted = store({ root: testRoot.root, resolver });
    expect((await restarted.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    })).kind).toBe('adopted');
  });

  test('a paused dead-owner retire cannot delete the concurrently published successor claim', async () => {
    const testRoot = rootFixture();
    const keyText = 'retire-successor-aba-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const filesystem = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: filesystem });
    const action = {
      action: 'adopt',
      blockState: 'staged',
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: payloadIds[0],
      at: beforeExpiry
    } as const;
    const owner = await startLockChild({
      root: testRoot,
      label: 'aba-owner',
      keyText,
      action: { ...action, block: 'lock-held' }
    });
    await waitForFile(owner.readyPath);
    await hardKill(owner.child);
    const rootLock = lockDirectory(testRoot.root, staged.stage.stageId);
    const predecessorNonce = (JSON.parse(readFileSync(rootLock, 'utf8')) as {
      owner: { nonce: string };
    }).owner.nonce;

    const retiring = await startLockChild({
      root: testRoot,
      label: 'aba-retirer',
      keyText,
      waitForGo: true,
      action: { ...action, block: 'after-reclaim-resumable' }
    });
    if (!retiring.goPath) throw new TypeError('missing retire resume path');
    await waitForFile(retiring.readyPath);
    expect(existsSync(join(
      stageDirectory(testRoot.root, staged.stage.stageId),
      `.lock-reclaimed-${predecessorNonce}`
    ))).toBe(true);

    const successor = await filesystem.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    expect(successor.kind).toBe('adopted');
    const successorPath = join(
      stageDirectory(testRoot.root, staged.stage.stageId),
      `.lock-next-${predecessorNonce}`
    );
    const successorIdentity = lstatSync(successorPath);

    writeFileSync(retiring.goPath, 'go\n', { mode: 0o600 });
    expect(await retiring.child.exited).toBe(0);
    const after = lstatSync(successorPath);
    expect({ device: String(after.dev), inode: String(after.ino) }).toEqual({
      device: String(successorIdentity.dev),
      inode: String(successorIdentity.ino)
    });
    expect(activeLockPath(testRoot.root, staged.stage.stageId)).toBeUndefined();
  }, 10_000);

  test('empty, legacy, malformed, foreign, and live owners are never replaced or reclaimed', async () => {
    const testRoot = rootFixture();
    const keyText = 'lock-refusal-process-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const first = store({ root: testRoot.root, resolver, ids: [stageIds[0], stageIds[1], stageIds[2]] });
    const empty = await putFixture({ store: first, text: 'empty lock refusal' });
    mkdirSync(lockDirectory(testRoot.root, empty.stage.stageId), { mode: 0o700 });
    await expectStageError(first.adopt({
      stage: empty.stage,
      expectedDescriptor: empty.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    }), 'invalid_descriptor_auth');
    expect(readdirSync(lockDirectory(testRoot.root, empty.stage.stageId))).toHaveLength(0);

    const legacy = await putFixture({ store: first, text: 'legacy lock refusal' });
    const legacyLock = lockDirectory(testRoot.root, legacy.stage.stageId);
    mkdirSync(legacyLock, { mode: 0o700 });
    writeFileSync(join(legacyLock, 'owner.json'), JSON.stringify({
      formatVersion: 1,
      nonce: 'a'.repeat(32),
      pid: 999_999_999
    }), { mode: 0o600 });
    await expectStageError(first.adopt({
      stage: legacy.stage,
      expectedDescriptor: legacy.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    }), 'invalid_descriptor_auth');
    expect(existsSync(legacyLock)).toBe(true);

    const live = await putFixture({ store: first, text: 'live lock refusal' });
    const holder = await startLockChild({
      root: testRoot,
      label: 'live-owner',
      keyText,
      action: {
        action: 'adopt',
        block: 'lock-held',
        blockState: 'staged',
        stage: live.stage,
        expectedDescriptor: live.descriptor,
        payloadRefId: payloadIds[0],
        at: beforeExpiry
      }
    });
    await waitForFile(holder.readyPath);
    try {
      await expectStageError(first.adopt({
        stage: live.stage,
        expectedDescriptor: live.descriptor,
        payloadRefId: parsePayloadRefId(payloadIds[0]),
        at: beforeExpiry
      }), 'stale_stage_fence');
      expect(activeLockPath(testRoot.root, live.stage.stageId)).toBeDefined();
    } finally {
      await hardKill(holder.child);
    }

    const foreign = await putFixture({ store: first, text: 'foreign lock refusal' });
    const dead = await startLockChild({
      root: testRoot,
      label: 'foreign-owner',
      keyText,
      action: {
        action: 'adopt',
        block: 'lock-held',
        blockState: 'staged',
        stage: foreign.stage,
        expectedDescriptor: foreign.descriptor,
        payloadRefId: payloadIds[0],
        at: beforeExpiry
      }
    });
    await waitForFile(dead.readyPath);
    await hardKill(dead.child);
    const ownerPath = lockDirectory(testRoot.root, foreign.stage.stageId);
    const forged = JSON.parse(readFileSync(ownerPath, 'utf8')) as { owner: { starting: { version: number } } };
    forged.owner.starting.version += 1;
    writeFileSync(ownerPath, JSON.stringify(forged), { mode: 0o600 });
    await expectStageError(first.adopt({
      stage: foreign.stage,
      expectedDescriptor: foreign.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    }), 'invalid_descriptor_auth');
    expect(existsSync(lockDirectory(testRoot.root, foreign.stage.stageId))).toBe(true);

    const uncertain = await putFixture({ store: first, text: 'unverifiable owner refusal' });
    const uncertainChild = await startLockChild({
      root: testRoot,
      label: 'unverifiable-owner',
      keyText,
      action: {
        action: 'adopt',
        block: 'lock-held',
        blockState: 'staged',
        stage: uncertain.stage,
        expectedDescriptor: uncertain.descriptor,
        payloadRefId: payloadIds[0],
        at: beforeExpiry
      }
    });
    await waitForFile(uncertainChild.readyPath);
    await hardKill(uncertainChild.child);
    const uncertainLock = lockDirectory(testRoot.root, uncertain.stage.stageId);
    const uncertainEnvelope = JSON.parse(readFileSync(uncertainLock, 'utf8')) as {
      owner: Record<string, unknown>;
      ownerAuthenticationTag: string;
    };
    uncertainEnvelope.owner.processStartToken = null;
    uncertainEnvelope.ownerAuthenticationTag = createHmac('sha256', keyText)
      .update(canonicalJsonText([
        'jooevents.local-classified-stage-lock-owner',
        2,
        uncertainEnvelope.owner
      ]), 'utf8')
      .digest('hex');
    writeFileSync(uncertainLock, `${canonicalJsonText(uncertainEnvelope)}\n`, { mode: 0o600 });
    await expectStageError(first.adopt({
      stage: uncertain.stage,
      expectedDescriptor: uncertain.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    }), 'stale_stage_fence');
    expect(existsSync(uncertainLock)).toBe(true);
  }, 10_000);

  test('a hard exit after authenticated purge quarantine is completed on restart without leaking bytes', async () => {
    const testRoot = rootFixture();
    const keyText = 'purge-quarantine-process-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const first = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({
      store: first,
      text: 'purge quarantine classified canary '.repeat(200_000)
    });
    const candidate = (await first.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const operator = await startLockChild({
      root: testRoot,
      label: 'purge-quarantine',
      keyText,
      waitForGo: true,
      action: {
        action: 'purge',
        block: 'none',
        blockState: 'staged',
        candidate
      }
    });
    if (!operator.goPath) throw new TypeError('missing purge go path');
    const watcherReady = join(testRoot.container, 'purge-watch-ready');
    const watcher = Bun.spawn([
      process.execPath,
      lockChildFixture,
      'watch-purged',
      join(testRoot.root, storeDirectoryName),
      String(operator.child.pid),
      watcherReady
    ], { stdout: 'pipe', stderr: 'pipe' });
    await waitForFile(watcherReady);
    writeFileSync(operator.goPath, 'go\n', { mode: 0o600 });
    expect(await operator.child.exited).not.toBe(0);
    await watcher.exited;
    expect(existsSync(stageDirectory(testRoot.root, staged.stage.stageId))).toBe(false);
    const quarantineName = readdirSync(join(testRoot.root, storeDirectoryName))
      .find((name) => name.includes(staged.stage.stageId));
    expect(quarantineName).toBeDefined();
    writeFileSync(
      join(testRoot.root, storeDirectoryName, quarantineName!, 'payload.bin'),
      'corrupted after authenticated purge quarantine',
      { mode: 0o600 }
    );
    resolver.removeProfile(profileSet(1).content);

    const restarted = store({ root: testRoot.root, resolver });
    expect((await restarted.listReconciliationCandidates({ limit: 10 })).candidates).toHaveLength(0);
    expect(readdirSync(join(testRoot.root, storeDirectoryName))
      .some((name) => name.includes(staged.stage.stageId))).toBe(false);
    expect(diskText(testRoot.root)).not.toContain('purge quarantine classified canary');
  }, 20_000);

  test('purged-to-cleaning rename fences a contender paused on the prior free lock tail', async () => {
    const testRoot = rootFixture();
    const keyText = 'purge-cleaning-tail-race-key-canary-v1';
    const resolver = resolverWith(profileSet(1), keyText);
    const first = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: first, text: 'cleanup tail race classified canary' });
    const candidate = (await first.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const operator = await startLockChild({
      root: testRoot,
      label: 'cleanup-tail-operator',
      keyText,
      waitForGo: true,
      action: { action: 'purge', block: 'none', blockState: 'staged', candidate }
    });
    if (!operator.goPath) throw new TypeError('missing purge go path');
    const watcherReady = join(testRoot.container, 'cleanup-tail-watch-ready');
    const watcher = Bun.spawn([
      process.execPath,
      lockChildFixture,
      'watch-purged',
      join(testRoot.root, storeDirectoryName),
      String(operator.child.pid),
      watcherReady
    ], { stdout: 'pipe', stderr: 'pipe' });
    await waitForFile(watcherReady);
    writeFileSync(operator.goPath, 'go\n', { mode: 0o600 });
    expect(await operator.child.exited).not.toBe(0);
    await watcher.exited;
    const stageRoot = join(testRoot.root, storeDirectoryName);
    const purgedName = readdirSync(stageRoot)
      .find((name) => name.startsWith(`.purged-${staged.stage.stageId}-`));
    expect(purgedName).toBeDefined();
    const purgedPath = join(stageRoot, purgedName!);

    let signalPaused!: () => void;
    let resumePaused!: () => void;
    const paused = new Promise<void>((resolvePromise) => { signalPaused = resolvePromise; });
    const resume = new Promise<void>((resolvePromise) => { resumePaused = resolvePromise; });
    let didPause = false;
    const pausingResolver: RetainedClassifiedPayloadProfileResolver = {
      isRetainedProfile: (profile) => resolver.isRetainedProfile(profile),
      isRetainedReconciliationPolicy: (reference) => resolver.isRetainedReconciliationPolicy(reference),
      async resolveDescriptorAuthenticationKey(profile) {
        if (!didPause && existsSync(purgedPath) && activeLockPathInDirectory(purgedPath) === undefined) {
          didPause = true;
          signalPaused();
          await resume;
        }
        return resolver.resolveDescriptorAuthenticationKey(profile);
      }
    };
    const staleCleaner = store({ root: testRoot.root, resolver: pausingResolver })
      .listReconciliationCandidates({ limit: 10 });
    await paused;

    expect((await store({ root: testRoot.root, resolver })
      .listReconciliationCandidates({ limit: 10 })).candidates).toHaveLength(0);
    expect(readdirSync(stageRoot).some((name) => name.includes(staged.stage.stageId))).toBe(false);
    resumePaused();
    await expectStageError(staleCleaner, 'invalid_cursor');
    expect(diskText(testRoot.root)).not.toContain('cleanup tail race classified canary');
  }, 20_000);

  test('bounded opaque cursors survive restart and reject tampering', async () => {
    const testRoot = rootFixture();
    const resolver = resolverWith();
    const firstStore = store({ root: testRoot.root, resolver, ids: stageIds.slice(0, 3) });
    await putFixture({ store: firstStore, text: 'cursor payload one' });
    await putFixture({ store: firstStore, text: 'cursor payload two' });
    await putFixture({ store: firstStore, text: 'cursor payload three' });

    const first = await firstStore.listReconciliationCandidates({ limit: 1 });
    expect(first.candidates).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^c1_[0-9a-f]{64}$/);
    expect(first.nextCursor).not.toContain(String(first.candidates[0]?.stageId).replaceAll('-', ''));

    const restarted = store({ root: testRoot.root, resolver });
    const second = await restarted.listReconciliationCandidates({ cursor: first.nextCursor!, limit: 1 });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0]?.stageId).not.toBe(first.candidates[0]?.stageId);
    const cursor = String(first.nextCursor);
    const tampered = createStageReconciliationCursor(`${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`);
    await expectStageError(restarted.listReconciliationCandidates({ cursor: tampered, limit: 1 }), 'invalid_cursor');
    await expectStageError(restarted.listReconciliationCandidates({ limit: 0 }), 'invalid_limit');
    await expectStageError(restarted.listReconciliationCandidates({ limit: 51 }), 'invalid_limit');
  });

  test('concurrent adopters converge and stale versions and fences refuse conditionally', async () => {
    const testRoot = rootFixture();
    const resolver = resolverWith();
    const writer = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: writer });
    const oldCandidate = (await writer.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const contenderA = store({ root: testRoot.root, resolver });
    const contenderB = store({ root: testRoot.root, resolver });

    const attempts = await Promise.allSettled([
      contenderA.adopt({
        stage: staged.stage,
        expectedDescriptor: staged.descriptor,
        payloadRefId: parsePayloadRefId(payloadIds[0]),
        at: beforeExpiry
      }),
      contenderB.adopt({
        stage: staged.stage,
        expectedDescriptor: staged.descriptor,
        payloadRefId: parsePayloadRefId(payloadIds[1]),
        at: beforeExpiry
      })
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof contenderA.adopt>>>).value.kind).toBe('adopted');
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      name: 'ClassifiedPayloadStageError',
      code: 'adoption_conflict'
    });

    await expectStageError(
      writer.inspect({ source: 'reconciliation', candidate: oldCandidate }),
      'stale_stage_version'
    );
    const current = (await writer.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const wrongFence = Object.freeze({
      ...current,
      fence: createPayloadStageFence(Number(current.fence) + 1)
    });
    await expectStageError(writer.inspect({ source: 'reconciliation', candidate: wrongFence }), 'stale_stage_fence');

    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof contenderA.adopt>>>).value;
    expect((await writer.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: winner.payloadRef.id,
      at: beforeExpiry
    })).kind).toBe('replay');
    expect((await writer.markAdopted({ stage: winner.continuation, payloadRef: winner.payloadRef })).kind).toBe('marked');
    const coordinationCount = () => readdirSync(stageDirectory(testRoot.root, staged.stage.stageId))
      .filter((name) => name === '.lock'
        || name.startsWith('.lock-next-')
        || name.startsWith('.lock-reclaimed-')).length;
    const afterCommitCount = coordinationCount();
    for (let replay = 0; replay < 5; replay += 1) {
      expect((await writer.adopt({
        stage: staged.stage,
        expectedDescriptor: staged.descriptor,
        payloadRefId: winner.payloadRef.id,
        at: beforeExpiry
      })).kind).toBe('replay');
      expect((await writer.markAdopted({ stage: winner.continuation, payloadRef: winner.payloadRef })).kind)
        .toBe('replay');
    }
    expect(coordinationCount()).toBe(afterCommitCount);
    expect((await store({ root: testRoot.root, resolver }).listReconciliationCandidates({ limit: 10 })).candidates).toHaveLength(0);
  });

  test('a prepared owner reauthenticates the stage after publish and releases when its bound state lost the race', async () => {
    const testRoot = rootFixture();
    const keyText = 'prepared-lock-race-key-canary-v1';
    const profiles = profileSet(1);
    const creatorResolver = resolverWith(profiles, keyText);
    const creator = store({ root: testRoot.root, resolver: creatorResolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: creator, profiles });
    let keyResolutions = 0;
    let resumePrepared!: () => void;
    let signalPrepared!: () => void;
    const prepared = new Promise<void>((resolvePromise) => { signalPrepared = resolvePromise; });
    const resume = new Promise<void>((resolvePromise) => { resumePrepared = resolvePromise; });
    const pausingResolver: RetainedClassifiedPayloadProfileResolver = {
      isRetainedProfile: (profile) => creatorResolver.isRetainedProfile(profile),
      isRetainedReconciliationPolicy: (reference) => creatorResolver.isRetainedReconciliationPolicy(reference),
      async resolveDescriptorAuthenticationKey(profile) {
        keyResolutions += 1;
        if (keyResolutions === 3) {
          signalPrepared();
          await resume;
        }
        return creatorResolver.resolveDescriptorAuthenticationKey(profile);
      }
    };
    const staleContender = store({ root: testRoot.root, resolver: pausingResolver });
    const staleAttempt = staleContender.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    await prepared;
    const pendingNames = readdirSync(stageDirectory(testRoot.root, staged.stage.stageId))
      .filter((name) => name.startsWith('.lock-pending-'));
    expect(pendingNames).toHaveLength(0);

    const winner = store({ root: testRoot.root, resolver: creatorResolver });
    expect((await winner.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[1]),
      at: beforeExpiry
    })).kind).toBe('adopted');
    resumePrepared();
    await expectStageError(staleAttempt, 'adoption_conflict');
    expect(activeLockPath(testRoot.root, staged.stage.stageId)).toBeUndefined();
    const current = (await winner.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    expect((await winner.inspect({ source: 'reconciliation', candidate: current })).payloadRef?.id)
      .toBe(parsePayloadRefId(payloadIds[1]));
  });

  test('a post-publication resolver failure retires its live claim and same-process retry succeeds', async () => {
    const testRoot = rootFixture();
    const keyText = 'published-error-release-key-canary-v1';
    const profiles = profileSet(1);
    const retained = resolverWith(profiles, keyText);
    const creator = store({ root: testRoot.root, resolver: retained, ids: [stageIds[0]] });
    const staged = await putFixture({ store: creator, profiles });
    const fixedLock = lockDirectory(testRoot.root, staged.stage.stageId);
    let failPostPublish = true;
    const failingResolver: RetainedClassifiedPayloadProfileResolver = {
      isRetainedProfile: (profile) => retained.isRetainedProfile(profile),
      isRetainedReconciliationPolicy: (reference) => retained.isRetainedReconciliationPolicy(reference),
      resolveDescriptorAuthenticationKey(profile) {
        if (failPostPublish && existsSync(fixedLock)) return undefined;
        return retained.resolveDescriptorAuthenticationKey(profile);
      }
    };
    const filesystem = store({ root: testRoot.root, resolver: failingResolver });
    await expectStageError(filesystem.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    }), 'unknown_profile');
    expect(activeLockPath(testRoot.root, staged.stage.stageId)).toBeUndefined();
    expect(readdirSync(stageDirectory(testRoot.root, staged.stage.stageId))
      .some((name) => name.startsWith('.lock-pending-'))).toBe(false);

    failPostPublish = false;
    expect((await filesystem.adopt({
      stage: staged.stage,
      expectedDescriptor: staged.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    })).kind).toBe('adopted');
  });

  test('expiry, matching authority, and an exact current canonical absence proof are all required for purge', async () => {
    const testRoot = rootFixture();
    const resolver = resolverWith();
    const purgeClock = {
      value: beforeExpiry,
      now() { return this.value; }
    };
    const filesystem = store({
      root: testRoot.root,
      resolver,
      ids: [stageIds[0], stageIds[1]],
      purgeClock
    });
    await putFixture({ store: filesystem });
    const candidate = (await filesystem.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const authority = purgeAuthorities.get(filesystem);
    if (!authority) throw new TypeError('missing cleanup authority');
    const inspection = await filesystem.inspect({ source: 'reconciliation', candidate });
    await expectStageError(authority.issue({ candidate, inspection }), 'stage_not_purgeable');

    purgeClock.value = afterExpiry;
    const validProof = await proofFor(filesystem, candidate);
    const clonedProof = { ...validProof } as UnadoptedStageProof;
    await expectStageError(filesystem.purge({ candidate, proof: clonedProof }), 'proof_mismatch');

    const foreignAuthority = createUnadoptedStageProofAuthority({
      clock: purgeClock,
      ownership: { resolve: () => Object.freeze({ kind: 'unadopted' as const }) }
    });
    const foreignIssued = await foreignAuthority.issue({ candidate, inspection });
    if (foreignIssued.kind !== 'issued') throw new TypeError('missing foreign proof');
    await expectStageError(filesystem.purge({ candidate, proof: foreignIssued.proof }), 'proof_mismatch');

    expect(await filesystem.purge({ candidate, proof: validProof }))
      .toEqual({ kind: 'purged', stageId: candidate.stageId });
    expect(existsSync(stageDirectory(testRoot.root, candidate.stageId))).toBe(false);
    await expectStageError(filesystem.inspect({ source: 'reconciliation', candidate }), 'stage_not_found');

    const adoptedStage = await putFixture({ store: filesystem });
    const adopted = await filesystem.adopt({
      stage: adoptedStage.stage,
      expectedDescriptor: adoptedStage.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    });
    const pendingCandidate = (await filesystem.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const pendingInspection = await filesystem.inspect({ source: 'reconciliation', candidate: pendingCandidate });
    await expectStageError(
      authority.issue({ candidate: pendingCandidate, inspection: pendingInspection }),
      'stage_not_purgeable'
    );
    await filesystem.markAdopted({ stage: adopted.continuation, payloadRef: adopted.payloadRef });
    expect(existsSync(stageDirectory(testRoot.root, adoptedStage.stage.stageId))).toBe(true);
  });

  test('a proof dies with its process authority and restart must rerun ownership lookup before purge', async () => {
    const testRoot = rootFixture();
    const resolver = resolverWith();
    let firstLookups = 0;
    const firstAuthority = createUnadoptedStageProofAuthority({
      clock: { now: () => afterExpiry },
      ownership: {
        resolve: () => {
          firstLookups += 1;
          return Object.freeze({ kind: 'unadopted' as const });
        }
      }
    });
    const first = store({
      root: testRoot.root,
      resolver,
      ids: [stageIds[0]],
      purgeAuthority: firstAuthority
    });
    await putFixture({ store: first });
    const candidate = (await first.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const oldProof = await proofFor(first, candidate);
    expect(firstLookups).toBe(1);

    let restartedLookups = 0;
    const restartedAuthority = createUnadoptedStageProofAuthority({
      clock: { now: () => afterExpiry },
      ownership: {
        resolve: () => {
          restartedLookups += 1;
          return Object.freeze({ kind: 'unadopted' as const });
        }
      }
    });
    const restarted = store({ root: testRoot.root, resolver, purgeAuthority: restartedAuthority });
    await expectStageError(restarted.purge({ candidate, proof: oldProof }), 'proof_mismatch');
    expect(restartedLookups).toBe(0);
    const replacementProof = await proofFor(restarted, candidate);
    expect(restartedLookups).toBe(1);
    expect(await restarted.purge({ candidate, proof: replacementProof }))
      .toEqual({ kind: 'purged', stageId: candidate.stageId });
    expect(restartedLookups).toBe(2);
  });

  test('an ownership change after issuance is rechecked under the stage lock and retains both stages', async () => {
    const testRoot = rootFixture();
    const resolver = resolverWith();
    const ownership = { kind: 'unadopted' as 'unadopted' | 'adopted' | 'uncertain' };
    const filesystem = store({
      root: testRoot.root,
      resolver,
      ids: [stageIds[0], stageIds[1]],
      purgeOwnership: ownership
    });
    const becameAdopted = await putFixture({ store: filesystem, text: 'adopted race bytes' });
    const becameUncertain = await putFixture({ store: filesystem, text: 'uncertain race bytes' });
    const candidates = (await filesystem.listReconciliationCandidates({ limit: 10 })).candidates;
    const adoptedCandidate = candidates.find((candidate) => candidate.stageId === becameAdopted.stage.stageId);
    const uncertainCandidate = candidates.find((candidate) => candidate.stageId === becameUncertain.stage.stageId);
    if (!adoptedCandidate || !uncertainCandidate) throw new TypeError('missing race candidates');

    const adoptedProof = await proofFor(filesystem, adoptedCandidate);
    ownership.kind = 'adopted';
    await expectStageError(
      filesystem.purge({ candidate: adoptedCandidate, proof: adoptedProof }),
      'canonical_stage_adopted'
    );

    ownership.kind = 'unadopted';
    const uncertainProof = await proofFor(filesystem, uncertainCandidate);
    ownership.kind = 'uncertain';
    await expectStageError(
      filesystem.purge({ candidate: uncertainCandidate, proof: uncertainProof }),
      'canonical_stage_ownership_uncertain'
    );
    expect(existsSync(stageDirectory(testRoot.root, adoptedCandidate.stageId))).toBe(true);
    expect(existsSync(stageDirectory(testRoot.root, uncertainCandidate.stageId))).toBe(true);
  });

  test('retained authentication versions survive rotation and removal fails closed without persisting keys', async () => {
    const testRoot = rootFixture();
    const v1 = profileSet(1);
    const v2 = profileSet(2);
    const keyV1Text = 'descriptor-auth-key-material-v1-canary';
    const keyV2Text = 'descriptor-auth-key-material-v2-canary';
    const keyV1 = new TextEncoder().encode(keyV1Text);
    const keyV2 = new TextEncoder().encode(keyV2Text);
    const resolver = new MutableRetainedProfileResolver();
    resolver.register(v1, keyV1);
    const filesystem = store({ root: testRoot.root, resolver, ids: [stageIds[0], stageIds[1]] });
    const old = await putFixture({ store: filesystem, profiles: v1, text: 'old profile bytes' });
    resolver.register(v2, keyV2);
    const current = await putFixture({ store: filesystem, profiles: v2, text: 'current profile bytes' });

    resolver.removeKey(v1.descriptorAuth);
    await expectStageError(filesystem.inspect({ source: 'descriptor', stage: old.stage }), 'unknown_profile');
    await expectStageError(filesystem.listReconciliationCandidates({ limit: 10 }), 'unknown_profile');
    resolver.restoreKey(v1.descriptorAuth, keyV1);
    expect(Number((await filesystem.inspect({ source: 'descriptor', stage: old.stage })).classified.profiles.descriptorAuth.version)).toBe(1);
    expect(Number((await filesystem.inspect({ source: 'descriptor', stage: current.stage })).classified.profiles.descriptorAuth.version)).toBe(2);

    resolver.removeProfile(v1.classification);
    await expectStageError(filesystem.inspect({ source: 'descriptor', stage: old.stage }), 'unknown_profile');
    resolver.restoreProfile(v1.classification);
    const restarted = store({ root: testRoot.root, resolver });
    expect((await restarted.adopt({
      stage: old.stage,
      expectedDescriptor: old.descriptor,
      payloadRefId: parsePayloadRefId(payloadIds[0]),
      at: beforeExpiry
    })).kind).toBe('adopted');

    const persisted = diskText(testRoot.root);
    expect(persisted).not.toContain(keyV1Text);
    expect(persisted).not.toContain(keyV2Text);
  });

  test('metadata, descriptor, and payload tampering fail closed without filesystem disclosure', async () => {
    const testRoot = rootFixture();
    const resolver = resolverWith();
    const filesystem = store({ root: testRoot.root, resolver, ids: [stageIds[0]] });
    const staged = await putFixture({ store: filesystem });
    const candidate = (await filesystem.listReconciliationCandidates({ limit: 10 })).candidates[0]!;

    const tamperedDescriptor = createAuthenticatedPayloadStageDescriptor({
      stageId: staged.stage.stageId,
      expectedVersion: staged.stage.expectedVersion,
      fence: staged.stage.fence,
      expiresAt: staged.stage.expiresAt,
      reconciliationPolicy: staged.stage.reconciliationPolicy,
      authenticationProfile: staged.stage.authenticationProfile,
      authenticationTag: '0'.repeat(64)
    });
    const descriptorError = await expectStageError(
      filesystem.inspect({ source: 'descriptor', stage: tamperedDescriptor }),
      'invalid_descriptor_auth'
    );
    expect(JSON.stringify(descriptorError)).not.toContain(testRoot.root);
    expect(JSON.stringify(descriptorError)).not.toContain(staged.digest);

    const metadata = metadataPath(testRoot.root, staged.stage.stageId);
    const originalMetadata = readFileSync(metadata, 'utf8');
    const parsed = JSON.parse(originalMetadata) as { record: { version: number } };
    parsed.record.version += 1;
    writeFileSync(metadata, JSON.stringify(parsed), { mode: 0o600 });
    await expectStageError(
      filesystem.inspect({ source: 'reconciliation', candidate }),
      'invalid_descriptor_auth'
    );

    writeFileSync(metadata, originalMetadata, { mode: 0o600 });
    const payload = payloadPath(testRoot.root, staged.stage.stageId);
    const bytes = readFileSync(payload);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(payload, bytes, { mode: 0o600 });
    await expectStageError(
      filesystem.inspect({ source: 'reconciliation', candidate }),
      'descriptor_mismatch'
    );

    writeFileSync(metadata, '{malformed', { mode: 0o600 });
    await expectStageError(filesystem.listReconciliationCandidates({ limit: 10 }), 'invalid_descriptor_auth');
  });

  test('traversal, symlink, and hardlink substitutions cannot escape the owned root', async () => {
    const testRoot = rootFixture();
    const resolver = resolverWith();
    const filesystem = store({ root: testRoot.root, resolver, ids: [stageIds[0], stageIds[1]] });
    const first = await putFixture({ store: filesystem, text: 'symlink target bytes' });
    const firstCandidate = (await filesystem.listReconciliationCandidates({ limit: 10 })).candidates[0]!;
    const firstProof = await proofFor(filesystem, firstCandidate);
    const traversal = Object.freeze({ ...firstCandidate, stageId: '../../outside-canary' as never });
    await expectStageError(filesystem.inspect({ source: 'reconciliation', candidate: traversal }), 'stage_not_found');

    if (process.platform !== 'win32') {
      const outsideSymlinkTarget = join(testRoot.container, 'outside-symlink-target.bin');
      writeFileSync(outsideSymlinkTarget, first.bytes, { mode: 0o600 });
      unlinkSync(payloadPath(testRoot.root, first.stage.stageId));
      symlinkSync(outsideSymlinkTarget, payloadPath(testRoot.root, first.stage.stageId));
      await expectStageError(
        filesystem.inspect({ source: 'reconciliation', candidate: firstCandidate }),
        'invalid_descriptor_auth'
      );
      await expectStageError(filesystem.purge({
        candidate: firstCandidate,
        proof: firstProof
      }), 'invalid_descriptor_auth');
      expect(readFileSync(outsideSymlinkTarget)).toEqual(Buffer.from(first.bytes));

      const second = await putFixture({ store: filesystem, text: 'hardlink target bytes' });
      const secondCandidate = Object.freeze({
        stageId: second.stage.stageId,
        expectedVersion: second.stage.expectedVersion,
        fence: second.stage.fence,
        expiresAt: second.stage.expiresAt,
        reconciliationPolicy: second.stage.reconciliationPolicy
      });
      const outsideHardlinkTarget = join(testRoot.container, 'outside-hardlink-target.bin');
      writeFileSync(outsideHardlinkTarget, second.bytes, { mode: 0o600 });
      unlinkSync(payloadPath(testRoot.root, second.stage.stageId));
      linkSync(outsideHardlinkTarget, payloadPath(testRoot.root, second.stage.stageId));
      await expectStageError(
        filesystem.inspect({ source: 'reconciliation', candidate: secondCandidate }),
        'invalid_descriptor_auth'
      );
      expect(readFileSync(outsideHardlinkTarget)).toEqual(Buffer.from(second.bytes));
      expect(lstatSync(outsideHardlinkTarget).nlink).toBe(2);

      const linkRoot = join(testRoot.container, 'root-link');
      symlinkSync(testRoot.root, linkRoot);
      expect(() => new LocalFilesystemClassifiedPayloadStageStore({
        root: linkRoot,
        profileResolver: resolver,
        purgeProofVerifier: createUnadoptedStageProofAuthority({
          clock: { now: () => afterExpiry },
          ownership: { resolve: () => Object.freeze({ kind: 'unadopted' as const }) }
        }).verifier
      })).toThrow('classified_payload_stage_root_unsafe');
    }
  });
});
