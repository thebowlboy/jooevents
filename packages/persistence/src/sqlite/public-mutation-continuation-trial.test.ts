import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createPublicMutationContinuationBoundary,
  type PublicMutationBootstrapVerification,
  type PublicMutationContinuationBoundary,
  type PublicMutationContinuationPolicy,
  type PublicMutationContinuationPolicyRegistry,
  type PublicMutationBootstrapVerifierRegistry,
  type RegisteredPublicMutationBootstrapVerifier
} from '@jooevents/application/public-mutation-continuation';
import {
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parsePublicPolicyRevisionId,
  parseWorkspaceId,
  type AuditEventId,
  type CeremonyEvidenceId,
  type Clock,
  type Instant
} from '@jooevents/kernel';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PUBLIC_MUTATION_CONTINUATION_TRIAL_TABLES,
  SQLitePublicMutationContinuationTrial,
  SQLitePublicMutationContinuationTrialError,
  installSQLitePublicMutationContinuationTrial,
  type SQLitePublicMutationContinuationTrialFaults
} from './public-mutation-continuation-trial';

const binding = Object.freeze({ key: 'public.cfp.submit.bootstrap', version: parseContractVersion(1) });
const verifierRef = Object.freeze({ key: 'security.public-mutation-bootstrap', version: parseContractVersion(1) });
const workspaceId = parseWorkspaceId('01890f47-9abc-7def-8123-456789abc001');
const eventId = parseEventId('01890f47-9abc-7def-8123-456789abc002');
const policyRevisionId = parsePublicPolicyRevisionId('01890f47-9abc-7def-8123-456789abc003');

function key(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 17) % 256);
}

const continuationKey1 = key(11);
const continuationKey2 = key(29);
const partitionKey = key(47);
const replayKey = key(83);

function policy(overrides: Partial<PublicMutationContinuationPolicy> = {}): PublicMutationContinuationPolicy {
  const base: PublicMutationContinuationPolicy = Object.freeze({
    binding,
    publicPolicyRevisionId: policyRevisionId,
    operation: Object.freeze({ name: 'public.cfp.submit', version: parseContractVersion(1) }),
    scope: Object.freeze({ kind: 'event' as const, workspaceId, eventId }),
    purpose: 'cfp.submission',
    action: 'submit',
    actionAnchorId: 'pma_0123456789abcdef',
    lifetimeMs: 5 * 60 * 1_000,
    bootstrapVerifier: verifierRef,
    originPolicy: Object.freeze({ key: 'security.origin.public-form', version: parseContractVersion(1) }),
    csrfPolicy: Object.freeze({ key: 'security.csrf.public-form', version: parseContractVersion(1) }),
    rateLimitPolicy: Object.freeze({ key: 'security.rate.public-form', version: parseContractVersion(1) }),
    replayPolicy: Object.freeze({ key: 'security.replay.public-form', version: parseContractVersion(1) }),
    continuationProfiles: Object.freeze([
      Object.freeze({ reference: { key: 'security.continuation.primary', version: parseContractVersion(2) }, keyBytes: continuationKey2 }),
      Object.freeze({ reference: { key: 'security.continuation.retained', version: parseContractVersion(1) }, keyBytes: continuationKey1 })
    ]) as PublicMutationContinuationPolicy['continuationProfiles'],
    principalPartitionProfile: Object.freeze({
      reference: { key: 'security.public-principal-partition', version: parseContractVersion(1) },
      keyBytes: partitionKey
    }),
    bootstrapReplayProfile: Object.freeze({
      reference: { key: 'security.public-bootstrap-replay', version: parseContractVersion(1) },
      keyBytes: replayKey
    })
  });
  return Object.freeze({ ...base, ...overrides }) as PublicMutationContinuationPolicy;
}

interface ProtocolEvidence {
  readonly origin: string;
  readonly csrf: string;
  readonly session: string;
  readonly nonce: string;
}

const validProtocol: ProtocolEvidence = Object.freeze({
  origin: 'https://forms.example.test',
  csrf: 'raw-csrf-token-never-store',
  session: 'raw-anonymous-action-session-never-store',
  nonce: 'raw-bootstrap-replay-nonce-never-store'
});

class FakeBootstrapVerifier implements RegisteredPublicMutationBootstrapVerifier {
  readonly reference = verifierRef;
  readonly seen = new Set<string>();
  readonly attempts = new Map<string, number>();
  enforceReplay = true;
  maximumAttempts = 20;
  addForbiddenOutput = false;
  readonly observedBindings: unknown[] = [];

  verify(input: Parameters<RegisteredPublicMutationBootstrapVerifier['verify']>[0]): PublicMutationBootstrapVerification {
    this.observedBindings.push({
      binding: input.binding,
      originPolicy: input.originPolicy,
      csrfPolicy: input.csrfPolicy,
      rateLimitPolicy: input.rateLimitPolicy,
      replayPolicy: input.replayPolicy
    });
    const evidence = input.protocolEvidence as Partial<ProtocolEvidence>;
    if (evidence.origin !== validProtocol.origin) return { kind: 'rejected', reason: 'origin_rejected' };
    if (evidence.csrf !== validProtocol.csrf) return { kind: 'rejected', reason: 'csrf_rejected' };
    if (typeof evidence.session !== 'string' || typeof evidence.nonce !== 'string') {
      return { kind: 'rejected', reason: 'csrf_rejected' };
    }
    const count = (this.attempts.get(evidence.session) ?? 0) + 1;
    this.attempts.set(evidence.session, count);
    if (count > this.maximumAttempts) return { kind: 'rejected', reason: 'rate_limited' };
    if (this.enforceReplay && this.seen.has(evidence.nonce)) {
      return { kind: 'rejected', reason: 'replay_rejected' };
    }
    this.seen.add(evidence.nonce);
    const result = {
      kind: 'verified' as const,
      principalPartitionMaterial: new TextEncoder().encode(`partition:${evidence.session}`),
      bootstrapReplayMaterial: new TextEncoder().encode(`replay:${evidence.nonce}`),
      originEvidenceId: 'poe_0123456789abcdef',
      csrfEvidenceId: 'pce_0123456789abcdef',
      rateLimitEvidenceId: 'pre_0123456789abcdef',
      replayEvidenceId: 'ppe_0123456789abcdef'
    };
    return this.addForbiddenOutput
      ? ({ ...result, operation: { name: 'attacker.chosen', version: 999 } } as never)
      : result;
  }
}

function mutableClock(initial = '2026-08-11T00:00:00.000Z') {
  let value = parseInstant(initial);
  return {
    clock: Object.freeze({ now: () => value }) satisfies Clock,
    set(next: string) {
      value = parseInstant(next);
    }
  };
}

function uuid(kind: 'audit' | 'ceremony', value: number): AuditEventId | CeremonyEvidenceId {
  const raw = `01890f47-9abc-7def-8123-${value.toString(16).padStart(12, '0')}`;
  return kind === 'audit' ? parseAuditEventId(raw) : parseCeremonyEvidenceId(raw);
}

interface Harness {
  readonly sqlite: Database;
  readonly time: ReturnType<typeof mutableClock>;
  readonly policies: PublicMutationContinuationPolicyRegistry;
  readonly verifierRegistry: PublicMutationBootstrapVerifierRegistry;
  readonly verifier: FakeBootstrapVerifier;
  readonly store: SQLitePublicMutationContinuationTrial;
  readonly boundary: PublicMutationContinuationBoundary;
  currentPolicy: PublicMutationContinuationPolicy | undefined;
  restart(input?: {
    readonly faults?: SQLitePublicMutationContinuationTrialFaults;
    readonly verifier?: FakeBootstrapVerifier;
    readonly randomSeed?: number;
  }): { readonly store: SQLitePublicMutationContinuationTrial; readonly boundary: PublicMutationContinuationBoundary };
}

function harness(input: {
  readonly policy?: PublicMutationContinuationPolicy;
  readonly verifier?: FakeBootstrapVerifier;
  readonly faults?: SQLitePublicMutationContinuationTrialFaults;
  readonly sqlite?: Database;
  readonly installSchema?: boolean;
  readonly time?: ReturnType<typeof mutableClock>;
  readonly idBase?: number;
} = {}): Harness {
  const sqlite = input.sqlite ?? new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (input.installSchema !== false) installSQLitePublicMutationContinuationTrial(sqlite);
  const time = input.time ?? mutableClock();
  const verifier = input.verifier ?? new FakeBootstrapVerifier();
  let currentPolicy: PublicMutationContinuationPolicy | undefined = input.policy ?? policy();
  let auditSequence = input.idBase ?? 100;
  let ceremonySequence = (input.idBase ?? 100) + 100;
  let completionSequence = 1;
  const policies: PublicMutationContinuationPolicyRegistry = Object.freeze({
    resolve(reference: Parameters<PublicMutationContinuationPolicyRegistry['resolve']>[0]) {
      return currentPolicy && reference.key === binding.key && reference.version === binding.version
        ? currentPolicy
        : undefined;
    }
  });
  const verifierRegistry: PublicMutationBootstrapVerifierRegistry = Object.freeze({
    resolve(reference: Parameters<PublicMutationBootstrapVerifierRegistry['resolve']>[0]) {
      return reference.key === verifierRef.key && reference.version === verifierRef.version
        ? verifier
        : undefined;
    }
  });

  const make = (
    selectedVerifier: FakeBootstrapVerifier,
    faults: SQLitePublicMutationContinuationTrialFaults | undefined,
    randomSeed: number
  ) => {
    const registry: PublicMutationBootstrapVerifierRegistry = Object.freeze({
      resolve(reference: Parameters<PublicMutationBootstrapVerifierRegistry['resolve']>[0]) {
        return reference.key === verifierRef.key && reference.version === verifierRef.version
          ? selectedVerifier
          : undefined;
      }
    });
    const store = new SQLitePublicMutationContinuationTrial(sqlite, {
      clock: time.clock,
      newAuditEventId: () => uuid('audit', auditSequence++) as AuditEventId,
      newCompletionReference: () => `pcr_${String(completionSequence++).padStart(24, '0')}`,
      ...(faults ? { faults } : {})
    });
    let randomCall = randomSeed;
    const boundary = createPublicMutationContinuationBoundary({
      binding,
      policies,
      bootstrapVerifiers: registry,
      store,
      clock: time.clock,
      newCeremonyEvidenceId: () => uuid('ceremony', ceremonySequence++) as CeremonyEvidenceId,
      newAuditEventId: () => uuid('audit', auditSequence++) as AuditEventId,
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => (randomCall + index * 13) % 256)
    });
    randomCall += 1;
    return { store, boundary };
  };
  const initial = make(verifier, input.faults, 7);
  const result: Harness = {
    sqlite,
    time,
    policies,
    verifierRegistry,
    verifier,
    store: initial.store,
    boundary: initial.boundary,
    get currentPolicy() {
      return currentPolicy;
    },
    set currentPolicy(value) {
      currentPolicy = value;
    },
    restart(restartInput = {}) {
      return make(
        restartInput.verifier ?? verifier,
        restartInput.faults,
        restartInput.randomSeed ?? 41
      );
    }
  };
  return result;
}

function tableCount(sqlite: Database, table: string): number {
  return Number(sqlite.query<{ total: number }, []>(`SELECT count(*) AS total FROM ${table}`).get()?.total ?? -1);
}

function onlyCeremonyId(sqlite: Database): CeremonyEvidenceId {
  const row = sqlite.query<{ ceremony_evidence_id: string }, []>(`
    SELECT ceremony_evidence_id FROM public_mutation_continuations_trial
  `).get();
  if (!row) throw new TypeError('expected ceremony row');
  return parseCeremonyEvidenceId(row.ceremony_evidence_id);
}

async function mint(h: Harness, evidence: ProtocolEvidence = validProtocol) {
  const result = await h.boundary.mint({ protocolEvidence: evidence });
  expect(result.kind).toBe('issued');
  if (result.kind !== 'issued') throw new TypeError('expected issued continuation');
  return result;
}

describe('disposable public mutation continuation proof', () => {
  test('mints one 256-bit short-lived capability and returns its raw value only once', async () => {
    const h = harness();
    const issued = await mint(h);
    expect(issued.continuation).toMatch(/^gsr_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(issued.continuation.slice(4), 'base64url')).toHaveLength(32);
    expect(String(issued.expiresAt)).toBe('2026-08-11T00:05:00.000Z');
    expect(tableCount(h.sqlite, 'public_mutation_continuations_trial')).toBe(1);
    expect(tableCount(h.sqlite, 'public_mutation_continuation_aliases_trial')).toBe(2);
    expect(
      h.sqlite.query<{ disposition: string }, []>(`
        SELECT disposition FROM public_mutation_security_audits_trial
      `).all()
    ).toEqual([{ disposition: 'mint_issued' }]);

    // A process restart may lose the verifier's memory. SQL's keyed replay/action
    // uniqueness still refuses to return either the original or a replacement raw value.
    const restartedVerifier = new FakeBootstrapVerifier();
    restartedVerifier.enforceReplay = false;
    const restarted = h.restart({ verifier: restartedVerifier });
    const again = await restarted.boundary.mint({ protocolEvidence: validProtocol });
    expect(again).toEqual({ kind: 'already_issued', expiresAt: issued.expiresAt });
    expect('continuation' in again).toBe(false);
    expect(tableCount(h.sqlite, 'public_mutation_continuations_trial')).toBe(1);
    expect(tableCount(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);

    // If the first raw response was lost, the server cannot recover that secret.
    // Expiry does not make a blind replacement safe for the same action anchor.
    h.time.set('2026-08-11T00:05:00.000Z');
    const afterExpiryVerifier = new FakeBootstrapVerifier();
    afterExpiryVerifier.enforceReplay = false;
    const afterExpiry = await h.restart({ verifier: afterExpiryVerifier }).boundary.mint({
      protocolEvidence: validProtocol
    });
    expect(afterExpiry.kind).toBe('already_issued');
    expect('continuation' in afterExpiry).toBe(false);

    // Dropping the anonymous browser partition and replay nonce cannot create a
    // second capability for the same server-held action anchor either.
    const replacementAttempt = await h.restart({ verifier: new FakeBootstrapVerifier() }).boundary.mint({
      protocolEvidence: {
        ...validProtocol,
        session: 'different-anonymous-session',
        nonce: 'different-bootstrap-nonce'
      }
    });
    expect(replacementAttempt.kind).toBe('already_issued');
    expect('continuation' in replacementAttempt).toBe(false);
    expect(tableCount(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);
    expect(
      h.sqlite.query<{ disposition: string }, []>(`
        SELECT disposition FROM public_mutation_security_audits_trial ORDER BY rowid
      `).all()
    ).toEqual([
      { disposition: 'mint_issued' },
      { disposition: 'mint_already_issued' },
      { disposition: 'mint_already_issued' },
      { disposition: 'mint_already_issued' }
    ]);
  });

  test('reopens a file-backed database with a new boundary and reconstructs the same sealed partition', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-public-continuation-'));
    const databasePath = join(directory, 'continuation.sqlite');
    try {
      const firstDatabase = new Database(databasePath);
      const first = harness({ sqlite: firstDatabase, idBase: 1_000 });
      const issued = await mint(first);
      const admitted = first.boundary.admit({ continuation: issued.continuation });
      if (admitted.kind !== 'ready') throw new TypeError('expected ready continuation');
      const initialMaterial = first.boundary.sealReader.open(admitted.evidence);
      expect(initialMaterial).toBeDefined();
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const restarted = harness({
        sqlite: reopenedDatabase,
        installSchema: false,
        idBase: 2_000,
        time: first.time
      });
      expect(restarted.boundary.sealReader.open(admitted.evidence)).toBeUndefined();
      const readmitted = restarted.boundary.admit({ continuation: issued.continuation });
      if (readmitted.kind !== 'ready') throw new TypeError('expected restarted continuation');
      const restartedMaterial = restarted.boundary.sealReader.open(readmitted.evidence);
      expect(restartedMaterial?.ceremonyEvidenceId).toBe(initialMaterial?.ceremonyEvidenceId);
      expect(restartedMaterial?.principalPartitionKey).toBe(initialMaterial?.principalPartitionKey);
      expect(restarted.store.commitProvingEffect({
        evidence: readmitted.evidence,
        sealReader: restarted.boundary.sealReader
      })).toMatchObject({ kind: 'terminal', replay: false });
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test('enforces origin, CSRF, rate-limit, replay, and closed verifier output before minting', async () => {
    const h = harness();
    expect(await h.boundary.mint({ protocolEvidence: { ...validProtocol, origin: 'https://evil.test' } }))
      .toEqual({ kind: 'rejected', reason: 'origin_rejected' });
    expect(await h.boundary.mint({ protocolEvidence: { ...validProtocol, csrf: 'wrong' } }))
      .toEqual({ kind: 'rejected', reason: 'csrf_rejected' });

    const replayEvidence = { ...validProtocol, nonce: 'nonce-used-twice' };
    const first = await h.boundary.mint({ protocolEvidence: replayEvidence });
    expect(first.kind).toBe('issued');
    expect(await h.boundary.mint({ protocolEvidence: replayEvidence }))
      .toEqual({ kind: 'rejected', reason: 'replay_rejected' });

    const rateVerifier = new FakeBootstrapVerifier();
    rateVerifier.maximumAttempts = 1;
    rateVerifier.enforceReplay = false;
    const rateHarness = harness({ verifier: rateVerifier });
    expect((await rateHarness.boundary.mint({ protocolEvidence: validProtocol })).kind).toBe('issued');
    expect(await rateHarness.boundary.mint({
      protocolEvidence: { ...validProtocol, nonce: 'different-rate-nonce' }
    })).toEqual({ kind: 'rejected', reason: 'rate_limited' });

    const invalidVerifier = new FakeBootstrapVerifier();
    invalidVerifier.addForbiddenOutput = true;
    const invalidHarness = harness({ verifier: invalidVerifier });
    expect(await invalidHarness.boundary.mint({ protocolEvidence: validProtocol }))
      .toEqual({ kind: 'rejected', reason: 'verifier_invalid' });
    expect(tableCount(invalidHarness.sqlite, 'public_mutation_continuations_trial')).toBe(0);
    expect(invalidVerifier.observedBindings[0]).toEqual({
      binding,
      originPolicy: policy().originPolicy,
      csrfPolicy: policy().csrfPolicy,
      rateLimitPolicy: policy().rateLimitPolicy,
      replayPolicy: policy().replayPolicy
    });

    expect(tableCount(h.sqlite, 'public_mutation_security_audits_trial')).toBe(4);
    expect(
      h.sqlite.query<{ disposition: string; reason_code: string }, []>(`
        SELECT disposition, reason_code
        FROM public_mutation_security_audits_trial
        WHERE disposition = 'bootstrap_rejected'
        ORDER BY rowid
      `).all()
    ).toEqual([
      { disposition: 'bootstrap_rejected', reason_code: 'origin_rejected' },
      { disposition: 'bootstrap_rejected', reason_code: 'csrf_rejected' },
      { disposition: 'bootstrap_rejected', reason_code: 'replay_rejected' }
    ]);
  });

  test('survives process and response loss with the same evidence and one terminal effect', async () => {
    const h = harness();
    const issued = await mint(h);
    const admitted = h.boundary.admit({ continuation: issued.continuation });
    expect(admitted.kind).toBe('ready');
    if (admitted.kind !== 'ready') throw new TypeError('expected ready continuation');
    const firstMaterial = h.boundary.sealReader.open(admitted.evidence);
    expect(firstMaterial).toBeDefined();

    const beforeCommitRestart = h.restart();
    const readmitted = beforeCommitRestart.boundary.admit({ continuation: issued.continuation });
    expect(readmitted.kind).toBe('ready');
    if (readmitted.kind !== 'ready') throw new TypeError('expected restarted ready continuation');
    const restartedMaterial = beforeCommitRestart.boundary.sealReader.open(readmitted.evidence);
    expect(restartedMaterial?.ceremonyEvidenceId).toBe(firstMaterial?.ceremonyEvidenceId);
    expect(restartedMaterial?.principalPartitionKey).toBe(firstMaterial?.principalPartitionKey);

    const lostResponse = h.restart({
      faults: { afterProofCommitBeforeReturn: () => { throw new Error('simulated-response-loss'); } }
    });
    const forCommit = lostResponse.boundary.admit({ continuation: issued.continuation });
    if (forCommit.kind !== 'ready') throw new TypeError('expected ready continuation before proof');
    expect(() => lostResponse.store.commitProvingEffect({
      evidence: forCommit.evidence,
      sealReader: lostResponse.boundary.sealReader
    })).toThrow('simulated-response-loss');
    expect(tableCount(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(1);

    const afterLoss = h.restart();
    const proofReplay = afterLoss.store.commitProvingEffect({
      evidence: forCommit.evidence,
      sealReader: lostResponse.boundary.sealReader
    });
    expect(proofReplay).toMatchObject({ kind: 'terminal', replay: true });
    const resolved = afterLoss.boundary.admit({ continuation: issued.continuation });
    expect(resolved).toMatchObject({ kind: 'terminal' });
    if (resolved.kind !== 'terminal') throw new TypeError('expected terminal resolution');
    const completion = h.sqlite.query<{ completion_reference: string }, []>(`
      SELECT completion_reference FROM public_mutation_effect_proofs_trial
    `).get()?.completion_reference;
    expect(completion).toBeDefined();
    if (!completion) throw new TypeError('expected completion reference');
    expect(resolved.completionReference).toBe(completion);
    expect(tableCount(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(1);

    const remintVerifier = new FakeBootstrapVerifier();
    remintVerifier.enforceReplay = false;
    const remintBoundary = h.restart({ verifier: remintVerifier }).boundary;
    const remint = await remintBoundary.mint({ protocolEvidence: validProtocol });
    expect(remint.kind).toBe('already_issued');
    expect('continuation' in remint).toBe(false);
    expect(tableCount(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(1);
    const dispositions = h.sqlite.query<{ disposition: string }, []>(`
      SELECT disposition FROM public_mutation_security_audits_trial ORDER BY rowid
    `).all().map((row) => row.disposition);
    expect(dispositions).toContain('proof_terminal');
    expect(dispositions).toContain('proof_replay');
    expect(dispositions).toContain('continuation_terminal_replay');
  });

  test('rechecks expiry, revocation, and current policy inside the proof transaction', async () => {
    const expired = harness();
    const expiredIssued = await mint(expired);
    const expiredAdmission = expired.boundary.admit({ continuation: expiredIssued.continuation });
    if (expiredAdmission.kind !== 'ready') throw new TypeError('expected ready continuation');
    expired.time.set('2026-08-11T00:05:00.000Z');
    expect(expired.store.commitProvingEffect({
      evidence: expiredAdmission.evidence,
      sealReader: expired.boundary.sealReader
    })).toEqual({ kind: 'stopped', reason: 'expired' });
    expect(expired.boundary.admit({ continuation: expiredIssued.continuation }))
      .toEqual({ kind: 'stopped', reason: 'expired' });
    expect(tableCount(expired.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);

    const revoked = harness();
    const revokedIssued = await mint(revoked);
    const revokedAdmission = revoked.boundary.admit({ continuation: revokedIssued.continuation });
    if (revokedAdmission.kind !== 'ready') throw new TypeError('expected ready continuation');
    expect(revoked.store.revokeForTrial(onlyCeremonyId(revoked.sqlite))).toBe(true);
    expect(revoked.store.commitProvingEffect({
      evidence: revokedAdmission.evidence,
      sealReader: revoked.boundary.sealReader
    })).toEqual({ kind: 'stopped', reason: 'revoked' });
    expect(revoked.boundary.admit({ continuation: revokedIssued.continuation }))
      .toEqual({ kind: 'stopped', reason: 'revoked' });
    expect(tableCount(revoked.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);

    const changed = harness();
    const changedIssued = await mint(changed);
    const changedAdmission = changed.boundary.admit({ continuation: changedIssued.continuation });
    if (changedAdmission.kind !== 'ready') throw new TypeError('expected ready continuation');
    changed.currentPolicy = policy({
      publicPolicyRevisionId: parsePublicPolicyRevisionId('01890f47-9abc-7def-8123-456789abc099')
    });
    expect(changed.store.commitProvingEffect({
      evidence: changedAdmission.evidence,
      sealReader: changed.boundary.sealReader
    })).toEqual({ kind: 'stopped', reason: 'policy_changed' });
    expect(changed.boundary.admit({ continuation: changedIssued.continuation }))
      .toEqual({ kind: 'stopped', reason: 'not_available' });
    expect(tableCount(changed.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);
  });

  test('does not disclose a terminal result through another operation, version, scope, purpose, or action', async () => {
    const h = harness();
    const issued = await mint(h);
    const admitted = h.boundary.admit({ continuation: issued.continuation });
    if (admitted.kind !== 'ready') throw new TypeError('expected ready continuation');
    const committed = h.store.commitProvingEffect({
      evidence: admitted.evidence,
      sealReader: h.boundary.sealReader
    });
    expect(committed.kind).toBe('terminal');

    const mutations: PublicMutationContinuationPolicy[] = [
      policy({ operation: { name: 'public.cfp.withdraw', version: parseContractVersion(1) } }),
      policy({ operation: { name: 'public.cfp.submit', version: parseContractVersion(2) } }),
      policy({ scope: { kind: 'event', workspaceId: parseWorkspaceId('01890f47-9abc-7def-8123-456789abc777'), eventId } }),
      policy({ scope: { kind: 'event', workspaceId, eventId: parseEventId('01890f47-9abc-7def-8123-456789abc778') } }),
      policy({ purpose: 'cfp.withdrawal' }),
      policy({ action: 'withdraw' }),
      policy({ actionAnchorId: 'pma_fedcba9876543210' })
    ];
    for (const changedPolicy of mutations) {
      h.currentPolicy = changedPolicy;
      expect(h.restart().boundary.admit({ continuation: issued.continuation }))
        .toEqual({ kind: 'stopped', reason: 'not_available' });
    }
    h.currentPolicy = policy();
    const forged = `${issued.continuation.slice(0, -1)}${issued.continuation.endsWith('A') ? 'B' : 'A'}`;
    expect(h.restart().boundary.admit({ continuation: forged }))
      .toEqual({ kind: 'stopped', reason: 'not_available' });
    expect(h.restart().boundary.admit({ continuation: 'gsr_too_short' }))
      .toEqual({ kind: 'stopped', reason: 'not_available' });
    expect(tableCount(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(1);
  });

  test('rejects cloned or forged seal objects while a fresh post-restart seal remains valid', async () => {
    const h = harness();
    const issued = await mint(h);
    const admitted = h.boundary.admit({ continuation: issued.continuation });
    if (admitted.kind !== 'ready') throw new TypeError('expected ready continuation');
    const cloned = structuredClone(admitted.evidence);
    expect(() => h.store.commitProvingEffect({
      evidence: cloned,
      sealReader: h.boundary.sealReader
    })).toThrow(SQLitePublicMutationContinuationTrialError);
    expect(() => h.store.commitProvingEffect({
      evidence: Object.freeze({ ceremonyEvidenceId: admitted.evidence.ceremonyEvidenceId }) as never,
      sealReader: h.boundary.sealReader
    })).toThrow(/not authentic/);
    expect(tableCount(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);

    const restarted = h.restart();
    const readmitted = restarted.boundary.admit({ continuation: issued.continuation });
    if (readmitted.kind !== 'ready') throw new TypeError('expected restarted ready continuation');
    expect(restarted.store.commitProvingEffect({
      evidence: readmitted.evidence,
      sealReader: restarted.boundary.sealReader
    })).toMatchObject({ kind: 'terminal', replay: false });
  });

  test('rolls back ceremony/effect state when their mandatory security audit cannot commit', async () => {
    const mintFailure = harness({
      faults: { beforeMintAudit: () => { throw new Error('mint-audit-failure'); } }
    });
    await expect(mintFailure.boundary.mint({ protocolEvidence: validProtocol }))
      .rejects.toThrow('mint-audit-failure');
    for (const table of PUBLIC_MUTATION_CONTINUATION_TRIAL_TABLES) {
      expect(tableCount(mintFailure.sqlite, table)).toBe(0);
    }

    const proof = harness();
    const issued = await mint(proof);
    const faulting = proof.restart({
      faults: { beforeProofAudit: () => { throw new Error('proof-audit-failure'); } }
    });
    const admitted = faulting.boundary.admit({ continuation: issued.continuation });
    if (admitted.kind !== 'ready') throw new TypeError('expected ready continuation');
    expect(() => faulting.store.commitProvingEffect({
      evidence: admitted.evidence,
      sealReader: faulting.boundary.sealReader
    })).toThrow('proof-audit-failure');
    expect(tableCount(proof.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);
    expect(proof.sqlite.query<{ state: string }, []>(`
      SELECT state FROM public_mutation_continuations_trial
    `).get()?.state).toBe('ready');
    expect(proof.sqlite.query<{ total: number }, []>(`
      SELECT count(*) AS total FROM public_mutation_security_audits_trial
      WHERE disposition = 'proof_terminal'
    `).get()?.total).toBe(0);
  });

  test('stores keyed verifiers and safe opaque evidence, never raw secrets or an ordinary token digest', async () => {
    const h = harness();
    const issued = await mint(h);
    const ordinaryDigest = createHash('sha256').update(issued.continuation, 'utf8').digest('hex');
    const databaseText = PUBLIC_MUTATION_CONTINUATION_TRIAL_TABLES
      .map((table) => JSON.stringify(h.sqlite.query(`SELECT * FROM ${table}`).all()))
      .join('\n');
    const forbidden = [
      issued.continuation,
      ordinaryDigest,
      validProtocol.origin,
      validProtocol.csrf,
      validProtocol.session,
      validProtocol.nonce,
      Buffer.from(continuationKey1).toString('hex'),
      Buffer.from(continuationKey2).toString('hex'),
      Buffer.from(partitionKey).toString('hex'),
      Buffer.from(replayKey).toString('hex')
    ];
    for (const canary of forbidden) expect(databaseText).not.toContain(canary);
    expect(databaseText).toContain('pcv1_');
    expect(databaseText).toContain('ppv1_');
    expect(databaseText).toContain('prv1_');
    expect(databaseText).toContain('poe_0123456789abcdef');
    expect(databaseText).not.toContain('protocolEvidence');

    expect(() => h.sqlite.query(`
      UPDATE public_mutation_security_audits_trial SET reason_code = 'tampered'
    `).run()).toThrow(/security_audit_immutable/);
    expect(() => h.sqlite.query(`DELETE FROM public_mutation_security_audits_trial`).run())
      .toThrow(/security_audit_immutable/);
    expect('list' in h.store).toBe(false);
    expect('getByCompletionReference' in h.store).toBe(false);
  });
});
