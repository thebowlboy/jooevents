import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createClassifiedPayloadProfileRef,
  createStageReconciliationPolicyRef,
  createUnadoptedStageProofAuthority,
  type ClassifiedPayloadProfileRef,
  type ClassifiedPayloadProfiles,
  type StageReconciliationPolicyRef,
  type UnadoptedStageProofAuthority
} from '@jooevents/application';
import {
  createVerifiedIngressBoundary,
  type RegisteredVerifiedIngressVerifier,
  type VerifiedIngressBoundary,
  type VerifiedIngressSourceConnectionConfig,
  type VerifiedIngressSourceConnectionRegistry
} from '@jooevents/application/verified-ingress';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifierRevisionId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { definitionRef, parseCanonicalSha256 } from '@jooevents/reliability';
import {
  LocalFilesystemClassifiedPayloadStageStore,
  type RetainedClassifiedPayloadProfileResolver
} from '../filesystem/classified-payload-stage-store';
import {
  SQLiteVerifiedInboxTrialRepository,
  createSQLiteVerifiedInboxTrialRunner,
  installSQLiteVerifiedInboxTrial,
  reconcileSQLiteVerifiedInboxTrialStage,
  type VerifiedInboxTrialBindingProfile
} from './verified-inbox-trial';

const trialDirectories = new Set<string>();
const openDatabases = new Set<Database>();

afterEach(() => {
  for (const sqlite of openDatabases) sqlite.close();
  openDatabases.clear();
  for (const directory of trialDirectories) {
    if (basename(directory).startsWith('jooevents-verified-ingress-join-')) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  trialDirectories.clear();
});

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

const ids = Object.freeze({
  workspace: parseWorkspaceId(uuid(1)),
  event: parseEventId(uuid(2)),
  source: parseSourceConnectionId(uuid(3)),
  sourceRevision1: parseSourceConnectionRevisionId(uuid(4)),
  sourceRevision2: parseSourceConnectionRevisionId(uuid(5)),
  verifierRevision: parseVerifierRevisionId(uuid(6))
});

const binding = Object.freeze({
  key: 'fake.signed.webhook',
  version: parseContractVersion(1)
});
const verifierContract = Object.freeze({
  key: 'fake.hmac.verifier',
  version: parseContractVersion(1)
});
const processorRef = definitionRef('inbox_processor', 'fake.event-processor', 1);
const processorJobRef = definitionRef('job', 'fake.event-processing', 1);
const processorDigest = parseCanonicalSha256('9'.repeat(64));
const policy = createStageReconciliationPolicyRef('reconciliation.verified-ingress', 1);
const classifiedProfiles: ClassifiedPayloadProfiles = Object.freeze({
  classification: createClassifiedPayloadProfileRef(
    'classification', 'classification.provider-envelope', 1
  ),
  schema: createClassifiedPayloadProfileRef('schema', 'schema.fake-provider-envelope', 1),
  content: createClassifiedPayloadProfileRef('content', 'content.fake-provider-envelope', 1),
  integrity: createClassifiedPayloadProfileRef('integrity', 'integrity.sha256', 1),
  descriptorAuth: createClassifiedPayloadProfileRef(
    'descriptor_auth', 'descriptor-auth.hmac-sha256', 1
  )
});
const semanticKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const bindingKey = Uint8Array.from({ length: 32 }, (_, index) => index + 41);
const descriptorKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const RAW_ENVELOPE_CANARY = 'raw-envelope-secret-7zP9';
const NORMALIZED_CONTENT_CANARY = 'normalized-classified-content-Q4x2';

function profileIdentity(profile: ClassifiedPayloadProfileRef): string {
  return `${profile.kind}:${profile.key}@${profile.version}`;
}

function policyIdentity(value: StageReconciliationPolicyRef): string {
  return `${value.key}@${value.version}`;
}

class TrialProfileResolver implements RetainedClassifiedPayloadProfileResolver {
  isRetainedProfile(profile: ClassifiedPayloadProfileRef): boolean {
    return Object.values(classifiedProfiles).some((candidate) =>
      profileIdentity(candidate) === profileIdentity(profile)
    );
  }

  isRetainedReconciliationPolicy(value: StageReconciliationPolicyRef): boolean {
    return policyIdentity(value) === policyIdentity(policy);
  }

  resolveDescriptorAuthenticationKey(
    profile: ClassifiedPayloadProfileRef<'descriptor_auth'>
  ): Uint8Array | undefined {
    return profileIdentity(profile) === profileIdentity(classifiedProfiles.descriptorAuth)
      ? Uint8Array.from(descriptorKey)
      : undefined;
  }
}

function configuration(
  sourceRevision = ids.sourceRevision1
): VerifiedIngressSourceConnectionConfig {
  return Object.freeze({
    binding,
    sourceConnectionId: ids.source,
    sourceConnectionRevisionId: sourceRevision,
    scope: Object.freeze({ kind: 'event' as const, workspaceId: ids.workspace, eventId: ids.event }),
    verifierContract,
    verifierRevisionId: ids.verifierRevision,
    maximumRawEnvelopeBytes: 4_096,
    maximumNormalizedContentBytes: 2_048,
    semanticIdentityProfile: Object.freeze({
      key: 'semantic.fake-event',
      version: parseContractVersion(1)
    }),
    semanticIdentityKeyBytes: Uint8Array.from(semanticKey),
    contentBindingProfiles: [Object.freeze({
      profile: Object.freeze({ key: 'webhook.content', version: parseContractVersion(1) }),
      keyBytes: Uint8Array.from(bindingKey)
    })] as const,
    classifiedPayloadProfiles: classifiedProfiles,
    normalizedContentType: 'application/vnd.fake-provider+json',
    stageTtlMs: 60 * 60 * 1_000,
    reconciliationPolicy: policy
  });
}

function processingContract(sourceRevision = ids.sourceRevision1) {
  return Object.freeze({
    sourceConnectionId: ids.source,
    sourceConnectionRevisionId: sourceRevision,
    verifierContract,
    verifierRevisionId: ids.verifierRevision,
    processor: processorRef,
    processorDigestSha256: processorDigest,
    job: processorJobRef
  });
}

class TrialConnections implements VerifiedIngressSourceConnectionRegistry {
  current: VerifiedIngressSourceConnectionConfig | undefined;

  constructor(sourceRevision = ids.sourceRevision1) {
    this.current = configuration(sourceRevision);
  }

  resolve() {
    return this.current;
  }
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

class MutableClock {
  value = '2026-08-11T00:00:00.000Z';

  now(): string {
    return this.value;
  }
}

const repositoryProfile: VerifiedInboxTrialBindingProfile = Object.freeze({
  profile: definitionRef('content_binding', 'webhook.content', 1),
  keyBytes: Uint8Array.from(bindingKey)
});

interface DurableTrial {
  readonly directory: string;
  readonly root: string;
  readonly databasePath: string;
  readonly resolver: TrialProfileResolver;
  readonly clock: MutableClock;
  nextStageId: number;
  live: LiveTrial;
}

interface LiveTrial {
  readonly sqlite: Database;
  readonly stageStore: LocalFilesystemClassifiedPayloadStageStore;
  readonly connections: TrialConnections;
  readonly boundary: VerifiedIngressBoundary;
  readonly repository: SQLiteVerifiedInboxTrialRepository;
  readonly purgeProofAuthority: UnadoptedStageProofAuthority;
  readonly runner: ReturnType<typeof createSQLiteVerifiedInboxTrialRunner>;
}

function compose(
  trial: Omit<DurableTrial, 'live'>,
  sqlite: Database,
  sourceRevision = ids.sourceRevision1
): LiveTrial {
  let repository: SQLiteVerifiedInboxTrialRepository | undefined;
  const purgeProofAuthority = createUnadoptedStageProofAuthority({
    clock: { now: () => parseInstant(trial.clock.now()) },
    ownership: {
      resolve: (candidate) => repository?.resolveStagePurgeOwnership(candidate) ??
        Object.freeze({ kind: 'uncertain' as const })
    }
  });
  const stageStore = new LocalFilesystemClassifiedPayloadStageStore({
    root: trial.root,
    profileResolver: trial.resolver,
    purgeProofVerifier: purgeProofAuthority.verifier,
    newStageId: () => uuid(trial.nextStageId++)
  });
  const connections = new TrialConnections(sourceRevision);
  const boundary = createVerifiedIngressBoundary({
    binding,
    sourceConnections: connections,
    verifiers: { resolve: () => verifier() },
    stageStore,
    clock: trial.clock
  });
  repository = new SQLiteVerifiedInboxTrialRepository(sqlite, {
    contentBindingProfiles: [repositoryProfile],
    sealReader: boundary.sealReader,
    recovery: boundary.recovery,
    processingContract: processingContract(sourceRevision),
    clock: trial.clock
  });
  return Object.freeze({
    sqlite,
    stageStore,
    connections,
    boundary,
    repository,
    purgeProofAuthority,
    runner: createSQLiteVerifiedInboxTrialRunner({ boundary, repository })
  });
}

function createTrial(): DurableTrial {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-verified-ingress-join-'));
  trialDirectories.add(directory);
  chmodSync(directory, 0o700);
  const root = join(directory, 'classified');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const databasePath = join(directory, 'trial.sqlite');
  const sqlite = new Database(databasePath, { create: true, strict: true });
  openDatabases.add(sqlite);
  installSQLiteVerifiedInboxTrial(sqlite);
  const trial = {
    directory,
    root,
    databasePath,
    resolver: new TrialProfileResolver(),
    clock: new MutableClock(),
    nextStageId: 1_000,
    live: undefined as unknown as LiveTrial
  } satisfies DurableTrial;
  trial.live = compose(trial, sqlite);
  return trial;
}

function restartTrial(
  trial: DurableTrial,
  sourceRevision = ids.sourceRevision1
): LiveTrial {
  trial.live.sqlite.close();
  openDatabases.delete(trial.live.sqlite);
  const sqlite = new Database(trial.databasePath, { create: false, strict: true });
  openDatabases.add(sqlite);
  trial.live = compose(trial, sqlite, sourceRevision);
  return trial.live;
}

function rawEnvelope(eventKey: string, retained: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    eventKey,
    retained,
    rawOnly: RAW_ENVELOPE_CANARY
  }));
}

async function runIntake(live: LiveTrial, eventKey: string, retained: string) {
  return live.runner.intake({
    rawEnvelope: rawEnvelope(eventKey, retained),
    protocolEvidence: { signature: 'valid' }
  });
}

function count(sqlite: Database, table: string): number {
  if (!/^verified_inbox_[a-z_]+_trial$/.test(table)) throw new TypeError('unsafe trial table');
  return sqlite.query<{ total: number }, []>(`SELECT count(*) AS total FROM ${table}`).get()?.total ?? 0;
}

function sqlRowText(sqlite: Database): string {
  const tables = sqlite.query<{ name: string }, []>(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'verified_inbox_%_trial'
    ORDER BY name
  `).all();
  return JSON.stringify(tables.map(({ name }) => {
    if (!/^verified_inbox_[a-z_]+_trial$/.test(name)) throw new TypeError('unsafe trial table');
    return { name, rows: sqlite.query<Record<string, unknown>, []>(`SELECT * FROM ${name}`).all() };
  }));
}

function filesystemText(root: string): string {
  const values: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) values.push(readFileSync(path).toString('utf8'));
    }
  };
  visit(root);
  return values.join('\n');
}

async function onlyCandidate(live: LiveTrial) {
  const page = await live.stageStore.listReconciliationCandidates({ limit: 20 });
  expect(page.candidates).toHaveLength(1);
  const candidate = page.candidates[0];
  if (!candidate) throw new TypeError('missing reconciliation candidate');
  return candidate;
}

describe('sealed verified ingress to SQLite inbox trial', () => {
  test('preserves new/same/changed/known-changed semantics and never adopts known replay losers', async () => {
    const trial = createTrial();
    const first = await runIntake(trial.live, 'event-42', NORMALIZED_CONTENT_CANARY);
    expect(first.kind).toBe('intake');
    if (first.kind !== 'intake') throw new TypeError('expected intake');
    expect(first.reduction.kind).toBe('new');
    expect(first.stageOwnership).toBe('owned');

    const same = await runIntake(trial.live, 'event-42', NORMALIZED_CONTENT_CANARY);
    expect(same.kind).toBe('intake');
    if (same.kind !== 'intake') throw new TypeError('expected same replay');
    expect(same.reduction.kind).toBe('same');
    expect(same.stageOwnership).toBe('not_adopted');

    const changedContent = `${NORMALIZED_CONTENT_CANARY}-changed`;
    const changed = await runIntake(trial.live, 'event-42', changedContent);
    expect(changed.kind).toBe('intake');
    if (changed.kind !== 'intake') throw new TypeError('expected changed intake');
    expect(changed.reduction.kind).toBe('changed');
    expect(changed.stageOwnership).toBe('owned');

    const knownChanged = await runIntake(trial.live, 'event-42', changedContent);
    expect(knownChanged.kind).toBe('intake');
    if (knownChanged.kind !== 'intake') throw new TypeError('expected known changed replay');
    expect(knownChanged.reduction.kind).toBe('changed');
    expect(knownChanged.stageOwnership).toBe('not_adopted');

    expect(count(trial.live.sqlite, 'verified_inbox_receipts_trial')).toBe(1);
    expect(count(trial.live.sqlite, 'verified_inbox_receipt_processing_contracts_trial')).toBe(1);
    expect(trial.live.repository.readProcessingContract(first.reduction.receipt.id)).toEqual(
      processingContract()
    );
    expect(count(trial.live.sqlite, 'verified_inbox_conflicts_trial')).toBe(1);
    expect(count(trial.live.sqlite, 'verified_inbox_attentions_trial')).toBe(1);
    expect(count(trial.live.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(2);
    expect(count(trial.live.sqlite, 'verified_inbox_intake_intents_trial')).toBe(0);

    const losers = await trial.live.stageStore.listReconciliationCandidates({ limit: 20 });
    expect(losers.candidates).toHaveLength(2);
    for (const candidate of losers.candidates) {
      const inspection = await trial.live.stageStore.inspect({ source: 'reconciliation', candidate });
      expect(inspection.state).toBe('staged');
      expect(inspection.payloadRef).toBeUndefined();
    }
    trial.clock.value = '2026-08-11T02:00:00.000Z';
    for (const candidate of losers.candidates) {
      const result = await reconcileSQLiteVerifiedInboxTrialStage({
        repository: trial.live.repository,
        boundary: trial.live.boundary,
        stageStore: trial.live.stageStore,
        purgeProofAuthority: trial.live.purgeProofAuthority,
        candidate
      });
      expect(result.kind).toBe('purged_unowned_staged');
    }
    expect(count(trial.live.sqlite, 'verified_inbox_stage_cleanup_claims_trial')).toBe(0);
  });

  test('freezes one processor mapping per exact source revision before final intake', () => {
    const trial = createTrial();
    expect(() => new SQLiteVerifiedInboxTrialRepository(trial.live.sqlite, {
      contentBindingProfiles: [repositoryProfile],
      sealReader: trial.live.boundary.sealReader,
      recovery: trial.live.boundary.recovery,
      processingContract: {
        ...processingContract(),
        processor: definitionRef('inbox_processor', 'fake.event-processor', 2),
        processorDigestSha256: parseCanonicalSha256('8'.repeat(64))
      },
      clock: trial.clock
    })).toThrow(/cannot rotate its inbox processor mapping/);
    expect(count(trial.live.sqlite, 'verified_inbox_source_processor_mappings_trial')).toBe(1);
  });

  test('a unique durable intent wins before adoption and the concurrent loser stays staged and unowned', async () => {
    const trial = createTrial();
    const first = await trial.live.boundary.verifyAndStage({
      rawEnvelope: rawEnvelope('contended-event', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' }
    });
    const second = await trial.live.boundary.verifyAndStage({
      rawEnvelope: rawEnvelope('contended-event', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' }
    });
    if (first.kind !== 'staged' || second.kind !== 'staged') throw new TypeError('expected stages');
    const winner = trial.live.repository.preflight(first.handle);
    expect(winner.kind).toBe('adoption_required');
    const loser = trial.live.repository.preflight(second.handle);
    expect(loser).toEqual({ kind: 'contended' });
    expect(count(trial.live.sqlite, 'verified_inbox_intake_intents_trial')).toBe(1);
    expect(count(trial.live.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(0);
    if (winner.kind !== 'adoption_required') throw new TypeError('expected winner');
    const adopted = await trial.live.boundary.adopt({
      handle: first.handle,
      payloadRefId: winner.payloadRefId
    });
    const finalized = trial.live.repository.finalize(adopted);
    expect(finalized.kind).toBe('finalized');
    await trial.live.boundary.markAdopted(adopted);
    expect(count(trial.live.sqlite, 'verified_inbox_intake_intents_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(1);
    const loserMaterial = trial.live.boundary.sealReader.openStaged(second.handle);
    if (!loserMaterial) throw new TypeError('missing loser material');
    expect(trial.live.sqlite.query<{ total: number }, [string]>(`
      SELECT count(*) AS total FROM verified_inbox_stage_ownership_trial WHERE stage_id = ?
    `).get(loserMaterial.stage.stageId)?.total).toBe(0);
    expect((await trial.live.stageStore.inspect({
      source: 'descriptor',
      stage: loserMaterial.stage
    })).state).toBe('staged');
  });

  test('a durable cleanup claim serializes expired staged cleanup against late intent creation', async () => {
    const trial = createTrial();
    const staged = await trial.live.boundary.verifyAndStage({
      rawEnvelope: rawEnvelope('cleanup-claim', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' }
    });
    if (staged.kind !== 'staged') throw new TypeError('expected stage');
    trial.clock.value = '2026-08-11T02:00:00.000Z';
    const candidate = await onlyCandidate(trial.live);
    const inspection = await trial.live.stageStore.inspect({ source: 'reconciliation', candidate });
    const issued = await trial.live.purgeProofAuthority.issue({ candidate, inspection });
    if (issued.kind !== 'issued') throw new TypeError('expected cleanup proof');
    expect(count(trial.live.sqlite, 'verified_inbox_stage_cleanup_claims_trial')).toBe(1);
    expect(trial.live.repository.preflight(staged.handle)).toEqual({ kind: 'cleanup_claimed' });
    await trial.live.stageStore.purge({ candidate, proof: issued.proof });
    trial.live.repository.releaseStageCleanupClaim(candidate);
    expect(count(trial.live.sqlite, 'verified_inbox_stage_cleanup_claims_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_intake_intents_trial')).toBe(0);
    expect(trial.live.repository.preflight(staged.handle)).toEqual({ kind: 'stage_expired' });
  });

  test('restart rejects the prior process proof and reissues only after the exact durable SQL claim is rechecked', async () => {
    const trial = createTrial();
    const staged = await trial.live.boundary.verifyAndStage({
      rawEnvelope: rawEnvelope('restart-cleanup-proof', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' }
    });
    if (staged.kind !== 'staged') throw new TypeError('expected staged envelope');
    trial.clock.value = '2026-08-11T02:00:00.000Z';
    const candidate = await onlyCandidate(trial.live);
    const inspection = await trial.live.stageStore.inspect({ source: 'reconciliation', candidate });
    const issued = await trial.live.purgeProofAuthority.issue({ candidate, inspection });
    if (issued.kind !== 'issued') throw new TypeError('expected cleanup proof');
    expect(count(trial.live.sqlite, 'verified_inbox_stage_cleanup_claims_trial')).toBe(1);

    const restarted = restartTrial(trial);
    try {
      await restarted.stageStore.purge({ candidate, proof: issued.proof });
      throw new Error('old process proof unexpectedly purged the stage');
    } catch (error) {
      expect(error).toMatchObject({ name: 'ClassifiedPayloadStageError', code: 'proof_mismatch' });
    }
    expect((await restarted.stageStore.inspect({ source: 'reconciliation', candidate })).state)
      .toBe('staged');
    const reconciled = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: restarted.repository,
      boundary: restarted.boundary,
      stageStore: restarted.stageStore,
      purgeProofAuthority: restarted.purgeProofAuthority,
      candidate
    });
    expect(reconciled).toEqual({ kind: 'purged_unowned_staged', stageId: candidate.stageId });
    expect(count(restarted.sqlite, 'verified_inbox_stage_cleanup_claims_trial')).toBe(0);
  });

  test('ambiguous or mismatched SQL cleanup ownership becomes durable attention and never deletes bytes', async () => {
    const trial = createTrial();
    const staged = await trial.live.boundary.verifyAndStage({
      rawEnvelope: rawEnvelope('uncertain-cleanup-proof', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' }
    });
    if (staged.kind !== 'staged') throw new TypeError('expected staged envelope');
    trial.clock.value = '2026-08-11T02:00:00.000Z';
    const candidate = await onlyCandidate(trial.live);
    trial.live.sqlite.query(`
      INSERT INTO verified_inbox_stage_cleanup_claims_trial
        (stage_id, stage_expected_version, stage_fence, stage_expires_at_ms,
         reconciliation_policy_key, reconciliation_policy_version, claimed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.stageId,
      Number(candidate.expectedVersion) + 1,
      Number(candidate.fence),
      Date.parse(candidate.expiresAt),
      candidate.reconciliationPolicy.key,
      Number(candidate.reconciliationPolicy.version),
      Date.parse(trial.clock.value)
    );

    const result = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: trial.live.repository,
      boundary: trial.live.boundary,
      stageStore: trial.live.stageStore,
      purgeProofAuthority: trial.live.purgeProofAuthority,
      candidate
    });
    expect(result).toEqual({
      kind: 'requires_attention',
      stageId: candidate.stageId,
      reason: 'cleanup_ownership_uncertain'
    });
    expect(count(trial.live.sqlite, 'verified_inbox_stage_attentions_trial')).toBe(1);
    expect((await trial.live.stageStore.inspect({ source: 'reconciliation', candidate })).state)
      .toBe('staged');
    expect(readFileSync(join(
      trial.root,
      '.jooevents-classified-payload-stages-v1',
      candidate.stageId,
      'payload.bin'
    )).byteLength).toBeGreaterThan(0);
  });

  test('restarts without the WeakMap and resumes staged intent through adopt, canonical commit, and mark', async () => {
    const trial = createTrial();
    await expect(trial.live.runner.intake({
      rawEnvelope: rawEnvelope('restart-staged', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' },
      faults: { afterIntentPrepared: () => { throw new Error('crash-after-intent'); } }
    })).rejects.toThrow('crash-after-intent');
    expect(count(trial.live.sqlite, 'verified_inbox_intake_intents_trial')).toBe(1);
    const before = await onlyCandidate(trial.live);
    expect((await trial.live.stageStore.inspect({ source: 'reconciliation', candidate: before })).state)
      .toBe('staged');

    const sql = sqlRowText(trial.live.sqlite);
    const digest = createHash('sha256').update(NORMALIZED_CONTENT_CANARY).digest('hex');
    expect(sql).not.toContain(RAW_ENVELOPE_CANARY);
    expect(sql).not.toContain(NORMALIZED_CONTENT_CANARY);
    expect(sql).not.toContain(digest);
    expect(filesystemText(trial.root)).not.toContain(RAW_ENVELOPE_CANARY);
    expect(filesystemText(trial.root)).toContain(NORMALIZED_CONTENT_CANARY);

    const restarted = restartTrial(trial);
    const candidate = await onlyCandidate(restarted);
    const result = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: restarted.repository,
      boundary: restarted.boundary,
      stageStore: restarted.stageStore,
      purgeProofAuthority: restarted.purgeProofAuthority,
      candidate
    });
    expect(result.kind).toBe('recovered_and_marked');
    if (result.kind !== 'recovered_and_marked') throw new TypeError('expected recovery');
    expect(result.recoveredFrom).toBe('staged');
    expect(result.reduction.kind).toBe('new');
    expect(count(restarted.sqlite, 'verified_inbox_receipts_trial')).toBe(1);
    expect(count(restarted.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(1);
    expect(count(restarted.sqlite, 'verified_inbox_intake_intents_trial')).toBe(0);
    expect((await restarted.stageStore.listReconciliationCandidates({ limit: 20 })).candidates)
      .toHaveLength(0);
  });

  test('restarts without the WeakMap and resumes adoption_pending intent through canonical commit and mark', async () => {
    const trial = createTrial();
    await expect(trial.live.runner.intake({
      rawEnvelope: rawEnvelope('restart-adopted', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' },
      faults: { afterStageAdopt: () => { throw new Error('crash-after-adopt'); } }
    })).rejects.toThrow('crash-after-adopt');
    expect(count(trial.live.sqlite, 'verified_inbox_intake_intents_trial')).toBe(1);
    const before = await onlyCandidate(trial.live);
    expect((await trial.live.stageStore.inspect({ source: 'reconciliation', candidate: before })).state)
      .toBe('adoption_pending');

    const restarted = restartTrial(trial);
    const candidate = await onlyCandidate(restarted);
    const result = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: restarted.repository,
      boundary: restarted.boundary,
      stageStore: restarted.stageStore,
      purgeProofAuthority: restarted.purgeProofAuthority,
      candidate
    });
    expect(result.kind).toBe('recovered_and_marked');
    if (result.kind !== 'recovered_and_marked') throw new TypeError('expected recovery');
    expect(result.recoveredFrom).toBe('adoption_pending');
    expect(result.reduction.kind).toBe('new');
    expect(count(restarted.sqlite, 'verified_inbox_receipts_trial')).toBe(1);
    expect(count(restarted.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(1);
    expect(count(restarted.sqlite, 'verified_inbox_intake_intents_trial')).toBe(0);
  });

  test('an intent that cannot adopt after expiry is retained as intervention, never purged or canonicalized', async () => {
    const trial = createTrial();
    await expect(trial.live.runner.intake({
      rawEnvelope: rawEnvelope('expired-intent', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' },
      faults: { afterIntentPrepared: () => { throw new Error('hold-until-expiry'); } }
    })).rejects.toThrow('hold-until-expiry');
    trial.clock.value = '2026-08-11T02:00:00.000Z';
    const restarted = restartTrial(trial);
    const candidate = await onlyCandidate(restarted);
    const result = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: restarted.repository,
      boundary: restarted.boundary,
      stageStore: restarted.stageStore,
      purgeProofAuthority: restarted.purgeProofAuthority,
      candidate
    });
    expect(result).toMatchObject({
      kind: 'requires_attention',
      reason: 'intent_adoption_refused'
    });
    expect(count(restarted.sqlite, 'verified_inbox_receipts_trial')).toBe(0);
    expect(count(restarted.sqlite, 'verified_inbox_intake_intents_trial')).toBe(1);
    expect(count(restarted.sqlite, 'verified_inbox_stage_attentions_trial')).toBe(1);
    expect((await restarted.stageStore.inspect({ source: 'reconciliation', candidate })).state)
      .toBe('staged');
  });

  test('SQL rollback retains the intent and post-commit crash replays without duplicate canonical rows', async () => {
    const trial = createTrial();
    await expect(trial.live.runner.intake({
      rawEnvelope: rawEnvelope('rollback-event', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' },
      faults: {
        sqlite: {
          afterProcessingContractInserted: () => { throw new Error('rollback-final'); }
        }
      }
    })).rejects.toThrow('rollback-final');
    expect(count(trial.live.sqlite, 'verified_inbox_receipts_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_receipt_processing_contracts_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_processing_pointers_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_intake_intents_trial')).toBe(1);

    let restarted = restartTrial(trial);
    let candidate = await onlyCandidate(restarted);
    const repaired = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: restarted.repository,
      boundary: restarted.boundary,
      stageStore: restarted.stageStore,
      purgeProofAuthority: restarted.purgeProofAuthority,
      candidate
    });
    expect(repaired.kind).toBe('recovered_and_marked');
    expect(count(restarted.sqlite, 'verified_inbox_receipts_trial')).toBe(1);
    expect(count(restarted.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(1);

    await expect(restarted.runner.intake({
      rawEnvelope: rawEnvelope('post-commit-event', `${NORMALIZED_CONTENT_CANARY}-two`),
      protocolEvidence: { signature: 'valid' },
      faults: { afterSqlCommit: () => { throw new Error('crash-after-commit'); } }
    })).rejects.toThrow('crash-after-commit');
    expect(count(restarted.sqlite, 'verified_inbox_receipts_trial')).toBe(2);
    expect(count(restarted.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(2);
    expect(count(restarted.sqlite, 'verified_inbox_intake_intents_trial')).toBe(0);

    restarted = restartTrial(trial);
    candidate = await onlyCandidate(restarted);
    const marked = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: restarted.repository,
      boundary: restarted.boundary,
      stageStore: restarted.stageStore,
      purgeProofAuthority: restarted.purgeProofAuthority,
      candidate
    });
    expect(marked.kind).toBe('marked_owned');
    expect(count(restarted.sqlite, 'verified_inbox_receipts_trial')).toBe(2);
    expect(count(restarted.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(2);
  });

  test('forged SQL intent cannot reseal and creates append-only durable intervention attention', async () => {
    const trial = createTrial();
    await expect(trial.live.runner.intake({
      rawEnvelope: rawEnvelope('forged-intent', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' },
      faults: { afterIntentPrepared: () => { throw new Error('hold-intent'); } }
    })).rejects.toThrow('hold-intent');
    const row = trial.live.sqlite.query<{
      intent_id: string;
      record_version: number;
      stage_id: string;
      stage_expected_version: number;
      stage_fence: number;
      payload_ref_id: string;
      source_connection_id: string;
      semantic_identity: string;
      record_json: string;
      authenticator: string;
      created_at_ms: number;
    }, []>(`
      SELECT * FROM verified_inbox_intake_intents_trial
    `).get();
    if (!row) throw new TypeError('missing intent row');
    trial.live.sqlite.query('DELETE FROM verified_inbox_intake_intents_trial').run();
    trial.live.sqlite.query(`
      INSERT INTO verified_inbox_intake_intents_trial
        (intent_id, record_version, stage_id, stage_expected_version, stage_fence,
         payload_ref_id, source_connection_id, semantic_identity, record_json,
         authenticator, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.intent_id,
      row.record_version,
      row.stage_id,
      row.stage_expected_version,
      row.stage_fence,
      row.payload_ref_id,
      row.source_connection_id,
      row.semantic_identity,
      row.record_json,
      `via1_${'0'.repeat(64)}`,
      row.created_at_ms
    );
    expect(() => trial.live.sqlite.query(`
      UPDATE verified_inbox_intake_intents_trial SET created_at_ms = created_at_ms + 1
    `).run()).toThrow(/immutable/);

    const candidate = await onlyCandidate(trial.live);
    const result = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: trial.live.repository,
      boundary: trial.live.boundary,
      stageStore: trial.live.stageStore,
      purgeProofAuthority: trial.live.purgeProofAuthority,
      candidate
    });
    expect(result).toMatchObject({ kind: 'requires_attention', reason: 'invalid_intent' });
    expect(count(trial.live.sqlite, 'verified_inbox_receipts_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_stage_ownership_trial')).toBe(0);
    expect(count(trial.live.sqlite, 'verified_inbox_stage_attentions_trial')).toBe(1);
    expect(() => trial.live.sqlite.query(`
      UPDATE verified_inbox_stage_attentions_trial SET reason = 'stage_state_mismatch'
    `).run()).toThrow(/append-only/);
    expect(() => trial.live.sqlite.query('DELETE FROM verified_inbox_stage_attentions_trial').run())
      .toThrow(/append-only/);
  });

  test('registration rotation and orphan adoption_pending both fail closed as retained intervention states', async () => {
    const rotatedTrial = createTrial();
    await expect(rotatedTrial.live.runner.intake({
      rawEnvelope: rawEnvelope('rotated-event', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' },
      faults: { afterStageAdopt: () => { throw new Error('rotate-after-adopt'); } }
    })).rejects.toThrow('rotate-after-adopt');
    const rotated = restartTrial(rotatedTrial, ids.sourceRevision2);
    const rotatedResult = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: rotated.repository,
      boundary: rotated.boundary,
      stageStore: rotated.stageStore,
      purgeProofAuthority: rotated.purgeProofAuthority,
      candidate: await onlyCandidate(rotated)
    });
    expect(rotatedResult).toMatchObject({
      kind: 'requires_attention',
      reason: 'stale_registration'
    });
    expect(count(rotated.sqlite, 'verified_inbox_receipts_trial')).toBe(0);
    expect(count(rotated.sqlite, 'verified_inbox_intake_intents_trial')).toBe(1);
    const restored = restartTrial(rotatedTrial, ids.sourceRevision1);
    const stillGated = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: restored.repository,
      boundary: restored.boundary,
      stageStore: restored.stageStore,
      purgeProofAuthority: restored.purgeProofAuthority,
      candidate: await onlyCandidate(restored)
    });
    expect(stillGated).toMatchObject({
      kind: 'requires_attention',
      reason: 'stale_registration'
    });
    expect(count(restored.sqlite, 'verified_inbox_receipts_trial')).toBe(0);

    const orphanTrial = createTrial();
    await expect(orphanTrial.live.runner.intake({
      rawEnvelope: rawEnvelope('orphan-event', NORMALIZED_CONTENT_CANARY),
      protocolEvidence: { signature: 'valid' },
      faults: { afterStageAdopt: () => { throw new Error('orphan-after-adopt'); } }
    })).rejects.toThrow('orphan-after-adopt');
    orphanTrial.live.sqlite.query('DELETE FROM verified_inbox_intake_intents_trial').run();
    const orphanCandidate = await onlyCandidate(orphanTrial.live);
    const orphan = await reconcileSQLiteVerifiedInboxTrialStage({
      repository: orphanTrial.live.repository,
      boundary: orphanTrial.live.boundary,
      stageStore: orphanTrial.live.stageStore,
      purgeProofAuthority: orphanTrial.live.purgeProofAuthority,
      candidate: orphanCandidate
    });
    expect(orphan).toMatchObject({
      kind: 'requires_attention',
      reason: 'unowned_adoption_pending'
    });
    expect(count(orphanTrial.live.sqlite, 'verified_inbox_receipts_trial')).toBe(0);
    expect((await orphanTrial.live.stageStore.inspect({
      source: 'reconciliation',
      candidate: orphanCandidate
    })).state).toBe('adoption_pending');
  });
});
