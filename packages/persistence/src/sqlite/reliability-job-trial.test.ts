import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { TerminalEffectReceipt } from '@jooevents/application';
import { effectfulOperationResultSchema } from '@jooevents/contracts';
import {
  canonicalJsonText,
  createPayloadRef,
  parseAggregateVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parsePayloadRefId,
  parseWorkspaceId,
  type Clock,
  type Instant
} from '@jooevents/kernel';
import {
  definitionRef,
  parseCanonicalSha256,
  parseDefinitionKey,
  parseLeaseFence,
  parseOpaqueSourceIdentity,
  schemaRef,
  sealReliabilityDefinition,
  type ExternalRetryPolicy,
  type JobDefinition
} from '@jooevents/reliability';
import { installFoundationTrialUnitOfWorkSchema } from './foundation-trial-uow';
import {
  SQLiteReliabilityJobTrial,
  SQLiteReliabilityJobTrialError,
  installSQLiteReliabilityJobTrial,
  type CreateReliabilityJobTrialInput,
  type TrialJobDispositionPolicyRef
} from './reliability-job-trial';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function instant(value: string): Instant {
  return parseInstant(value);
}

function mutableClock(initial: Instant): {
  readonly clock: Clock;
  set(value: Instant): void;
} {
  let current = initial;
  return {
    clock: Object.freeze({ now: () => current }),
    set(value) {
      current = value;
    }
  };
}

async function jobDefinition(
  externalRetryPolicy: ExternalRetryPolicy = 'anchor_inspection_only',
  maximumAttempts = 3,
  timeoutMs = 20_000
): Promise<JobDefinition> {
  return sealReliabilityDefinition({
    kind: 'job',
    key: parseDefinitionKey('program.projection.rebuild'),
    version: parseContractVersion(1),
    inputSchema: schemaRef('schema.program.rebuild.job-input', 1, HASH_A),
    resultSchema: schemaRef('schema.program.rebuild.result', 1, HASH_B),
    errorDetailSchema: schemaRef('schema.safe.failure', 1, HASH_C),
    source: definitionRef('source', 'registered.reliability.source', 1),
    scopeCausation: definitionRef('scope_causation', 'source.scope', 1),
    inputProjection: definitionRef('input_projection', 'program.rebuild.input', 1),
    targetOperation: definitionRef('operation', 'program.projection.rebuild.execute', 1),
    capabilityRevisionId: parseCapabilityRevisionId('00000000-0000-4000-8000-000000000001'),
    authorityCitation: definitionRef('authority_citation', 'program.rebuild.authority', 1),
    leaseDurationMs: 30_000,
    maximumAttempts,
    backoff: definitionRef('backoff', 'bounded.exponential', 1),
    timeoutMs,
    cancellation: definitionRef('cancellation', 'program.rebuild.cancel', 1),
    externalRetryPolicy
  });
}

const policy: TrialJobDispositionPolicyRef = Object.freeze({
  reference: definitionRef('job_disposition', 'program.rebuild.intervention', 1),
  canonicalDigestSha256: parseCanonicalSha256(HASH_D)
});

async function createInput(input: {
  readonly id?: string;
  readonly semanticIdentity?: string;
  readonly externalRetryPolicy?: ExternalRetryPolicy;
  readonly maximumAttempts?: number;
  readonly timeoutMs?: number;
} = {}): Promise<CreateReliabilityJobTrialInput> {
  const definition = await jobDefinition(
    input.externalRetryPolicy,
    input.maximumAttempts,
    input.timeoutMs
  );
  return Object.freeze({
    id: parseJobId(input.id ?? '00000000-0000-4000-8000-000000000101'),
    definition,
    registeredIdempotencyIdentity: input.semanticIdentity ?? 'program-projection:event-1',
    source: Object.freeze({
      definition: definitionRef('domain_fact', 'program.vocabulary.changed', 1),
      identity: parseOpaqueSourceIdentity('src1_program-vocabulary-changed-0001'),
      version: parseAggregateVersion(4)
    }),
    inputRef: createPayloadRef(
      parsePayloadRefId('00000000-0000-4000-8000-000000000201')
    ),
    scope: Object.freeze({
      kind: 'event' as const,
      workspaceId: parseWorkspaceId('00000000-0000-4000-8000-000000000301'),
      eventId: parseEventId('00000000-0000-4000-8000-000000000302')
    }),
    authorityCitationId: parseAuthorityCitationId(
      '00000000-0000-4000-8000-000000000401'
    ),
    dispositionPolicy: policy,
    availableAt: instant('2026-08-11T00:00:00Z')
  });
}

function setup(now = instant('2026-08-11T00:00:01Z')) {
  const sqlite = new Database(':memory:');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installSQLiteReliabilityJobTrial(sqlite);
  const time = mutableClock(now);
  const store = new SQLiteReliabilityJobTrial(sqlite, time.clock);
  return { sqlite, time, store };
}

function insertReceipt(
  sqlite: Database,
  receiptId = '00000000-0000-4000-8000-000000000501'
): TerminalEffectReceipt {
  const result = effectfulOperationResultSchema.parse({
    kind: 'success',
    data: { rebuilt: 1 },
    receipt: {
      id: receiptId,
      operationName: 'program.projection.rebuild.execute',
      operationVersion: 1
    },
    correlationId: '00000000-0000-4000-8000-000000000601'
  });
  if (result.kind !== 'success') throw new TypeError('fixture result must be successful');
  const receipt: TerminalEffectReceipt = Object.freeze({
    ref: result.receipt,
    identity: Object.freeze({
      scopePartitionKey: HASH_A,
      authorityPrincipalKey: 'registered-job:fixture',
      operationName: result.receipt.operationName,
      operationVersion: result.receipt.operationVersion,
      surface: 'application_job',
      idempotencyVerifierProfile: Object.freeze({ key: 'job-idempotency', version: 1 }),
      idempotencyKeyVerifier: HASH_B
    }),
    requestHash: HASH_C,
    result
  });
  sqlite.query(`
    INSERT INTO foundation_trial_operation_receipts (
      id, scope_partition_key, authority_principal_key, operation_name,
      operation_version, surface, idempotency_verifier_profile_key,
      idempotency_verifier_profile_version, idempotency_key_verifier,
      request_hash, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.ref.id,
    receipt.identity.scopePartitionKey,
    receipt.identity.authorityPrincipalKey,
    receipt.identity.operationName,
    receipt.identity.operationVersion,
    receipt.identity.surface,
    receipt.identity.idempotencyVerifierProfile.key,
    receipt.identity.idempotencyVerifierProfile.version,
    receipt.identity.idempotencyKeyVerifier,
    receipt.requestHash,
    canonicalJsonText(receipt.result)
  );
  return receipt;
}

function tableCount(sqlite: Database, table: string): number {
  return Number(sqlite.query<{ total: number }, []>(`SELECT count(*) AS total FROM ${table}`).get()?.total ?? -1);
}

describe('disposable SQLite reliability job store', () => {
  test('freezes the exact registered definition, semantic identity, scope, and authority citation', async () => {
    const { sqlite, store } = setup();
    const input = await createInput();
    const created = store.create(input);

    expect(created.job.definitionDigestSha256).toBe(input.definition.canonicalDigestSha256);
    expect(created.job.registeredIdempotencyIdentity).toBe('program-projection:event-1');
    expect(created.job.targetOperation).toEqual(input.definition.targetOperation);
    expect(created.job.inputProjection).toEqual(input.definition.inputProjection);
    expect(created.job.capabilityRevisionId).toBe(input.definition.capabilityRevisionId);
    expect(created.job.authorityCitation).toEqual(input.definition.authorityCitation);
    expect(created.authorityCitationId).toBe(input.authorityCitationId);
    expect(created.scope).toEqual(input.scope);
    expect(created.definitionSnapshot.inputSchema).toEqual(input.definition.inputSchema);
    expect(created.dispositionPolicy).toEqual(policy);
    expect(() => sqlite.query(`
      UPDATE reliability_jobs_trial
      SET target_operation_key = 'payload.selected.target'
      WHERE job_id = ?
    `).run(input.id)).toThrow(/binding_immutable/);

    const durableText = JSON.stringify(sqlite.query('SELECT * FROM reliability_jobs_trial').all());
    expect(durableText).toContain(String(input.inputRef.id));
    expect(durableText).not.toContain('classified-job-input-canary');
    const duplicateSemanticIdentity = await createInput({
      id: '00000000-0000-4000-8000-000000000102'
    });
    expect(() => store.create(duplicateSemanticIdentity)).toThrow();
  });

  test('uses the store Clock, resumes one owner, and closes an expired lease for reconciliation', async () => {
    const { sqlite, time, store } = setup();
    const input = await createInput();
    store.create(input);
    const firstAttempt = parseInvocationId('00000000-0000-4000-8000-000000000701');
    const claimed = store.claim({
      jobId: input.id,
      invocationId: firstAttempt,
      ownerKey: 'job-worker-a'
    });
    expect(claimed.job.lease).toMatchObject({
      ownerKey: 'job-worker-a',
      attemptId: firstAttempt,
      expiresAt: instant('2026-08-11T00:00:31Z')
    });

    time.set(instant('2026-08-11T00:00:02Z'));
    const resumed = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000702'),
      ownerKey: 'job-worker-a'
    });
    expect(resumed.job.attempts).toHaveLength(1);
    expect(resumed.job.lease?.attemptId).toBe(firstAttempt);
    expect(() => store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000703'),
      ownerKey: 'job-worker-b'
    })).toThrow(/lease has not expired/);

    time.set(instant('2026-08-11T00:00:32Z'));
    expect(() => store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000704'),
      ownerKey: 'job-worker-b'
    })).toThrow(/anchor inspection/);
    expect(store.require(input.id).job.attempts).toHaveLength(1);

    const settled = store.settle({
      jobId: input.id,
      fence: parseLeaseFence(1),
      policy,
      cause: 'lease_expired',
      disposition: 'reconcile',
      reasonCode: 'job_lease_expired',
      failure: { code: 'job_acceptance_unknown', classification: 'ambiguous' }
    });
    expect(settled.job.state).toBe('dead_lettered');
    expect(settled.job.lease).toBeNull();
    expect(store.readLatestDisposition(input.id)).toMatchObject({
      cause: 'lease_expired',
      disposition: 'reconcile',
      reasonCode: 'job_lease_expired'
    });

    const restarted = new SQLiteReliabilityJobTrial(sqlite, time.clock);
    expect(restarted.require(input.id).job.state).toBe('dead_lettered');
    expect(restarted.listAttemptEvidence(input.id)[0]?.completion).toMatchObject({
      state: 'dead_lettered',
      failure: { classification: 'ambiguous' }
    });
    expect(() => restarted.settle({
      jobId: input.id,
      fence: parseLeaseFence(1),
      policy,
      cause: 'lease_expired',
      disposition: 'reconcile',
      reasonCode: 'job_lease_expired',
      failure: { code: 'job_acceptance_unknown', classification: 'ambiguous' }
    })).toThrow(SQLiteReliabilityJobTrialError);
  });

  test('persists a registered safe retry while preserving semantic identity across attempts', async () => {
    const { time, store } = setup();
    const input = await createInput();
    store.create(input);
    const first = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000711'),
      ownerKey: 'job-worker-a'
    });
    const waiting = store.settle({
      jobId: input.id,
      fence: first.job.currentFence!,
      policy,
      cause: 'known_pre_submission_failure',
      disposition: 'safe_retry',
      reasonCode: 'dependency_not_ready',
      failure: { code: 'dependency_not_ready', classification: 'transient' },
      retryDelayMs: 5_000
    });
    expect(waiting.job.state).toBe('retry_wait');
    expect(waiting.job.nextActionAt).toBe(instant('2026-08-11T00:00:06Z'));
    expect(waiting.job.lease).toBeNull();

    time.set(instant('2026-08-11T00:00:05Z'));
    expect(() => store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000712'),
      ownerKey: 'job-worker-b'
    })).toThrow(/not due/);
    time.set(instant('2026-08-11T00:00:06Z'));
    const second = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000712'),
      ownerKey: 'job-worker-b'
    });
    expect(second.job.attempts.map((attempt) => attempt.state)).toEqual([
      'retry_scheduled',
      'running'
    ]);
    expect(Number(second.job.currentFence)).toBe(2);
    expect(second.job.registeredIdempotencyIdentity).toBe(
      first.job.registeredIdempotencyIdentity
    );
    expect(second.job.id).toBe(first.job.id);
  });

  test('fails closed on policy substitution and ambiguous safe retry without partial evidence', async () => {
    const { store } = setup();
    const input = await createInput();
    store.create(input);
    const claimed = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000721'),
      ownerKey: 'job-worker-a'
    });
    expect(() => store.settle({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      policy: Object.freeze({ ...policy, canonicalDigestSha256: parseCanonicalSha256(HASH_A) }),
      cause: 'operation_nonterminal',
      disposition: 'attention',
      reasonCode: 'authority_denied',
      failure: { code: 'authority_denied', classification: 'permanent' }
    })).toThrow(/policy differs/);
    expect(() => store.settle({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      policy,
      cause: 'ambiguous_failure',
      disposition: 'safe_retry',
      reasonCode: 'provider_unknown',
      failure: { code: 'provider_unknown', classification: 'ambiguous' },
      retryDelayMs: 1_000
    })).toThrow(/external retry policy/);
    expect(store.require(input.id).job.state).toBe('leased');
    expect(store.listAttemptEvidence(input.id)[0]?.completion).toBeNull();
    expect(store.readLatestDisposition(input.id)).toBeNull();
  });

  test('rolls nonterminal disposition and attempt completion back together', async () => {
    const { store } = setup();
    const input = await createInput();
    store.create(input);
    const claimed = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000731'),
      ownerKey: 'job-worker-a'
    });
    expect(() => store.settle({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      policy,
      cause: 'operation_nonterminal',
      disposition: 'attention',
      reasonCode: 'current_authority_denied',
      failure: { code: 'current_authority_denied', classification: 'permanent' },
      faults: {
        afterDispositionInserted() {
          throw new Error('crash-after-disposition');
        }
      }
    })).toThrow(/crash-after-disposition/);
    expect(store.require(input.id).job.state).toBe('leased');
    expect(store.listAttemptEvidence(input.id)[0]?.completion).toBeNull();
    expect(store.readLatestDisposition(input.id)).toBeNull();

    const settled = store.settle({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      policy,
      cause: 'operation_nonterminal',
      disposition: 'attention',
      reasonCode: 'current_authority_denied',
      failure: { code: 'current_authority_denied', classification: 'permanent' }
    });
    expect(settled.job.state).toBe('dead_lettered');
    expect(settled.job.lease).toBeNull();
    expect(store.readLatestDisposition(input.id)?.disposition).toBe('attention');
  });

  test('requires the real receipt parent and atomically rolls receipt/job completion together', async () => {
    const { sqlite, store } = setup();
    const input = await createInput();
    store.create(input);
    const claimed = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000741'),
      ownerKey: 'job-worker-a'
    });
    const missingReceipt = Object.freeze({
      ref: Object.freeze({
        id: '00000000-0000-4000-8000-000000000599',
        operationName: 'program.projection.rebuild.execute',
        operationVersion: 1
      }),
      identity: Object.freeze({
        scopePartitionKey: HASH_A,
        authorityPrincipalKey: 'registered-job:fixture',
        operationName: 'program.projection.rebuild.execute',
        operationVersion: 1,
        surface: 'application_job' as const,
        idempotencyVerifierProfile: Object.freeze({ key: 'job-idempotency', version: 1 }),
        idempotencyKeyVerifier: HASH_B
      }),
      requestHash: HASH_C,
      result: effectfulOperationResultSchema.parse({
        kind: 'success',
        data: { rebuilt: 1 },
        receipt: {
          id: '00000000-0000-4000-8000-000000000599',
          operationName: 'program.projection.rebuild.execute',
          operationVersion: 1
        },
        correlationId: '00000000-0000-4000-8000-000000000609'
      })
    }) as TerminalEffectReceipt;
    expect(() => store.completeWithReceipt({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      receipt: missingReceipt
    })).toThrow();
    expect(store.require(input.id).job.state).toBe('leased');

    expect(() => sqlite.transaction(() => {
      const receipt = insertReceipt(sqlite);
      store.completeWithReceipt({
        jobId: input.id,
        fence: claimed.job.currentFence!,
        receipt,
        faults: {
          afterJobUpdated() {
            throw new Error('crash-after-job-completion');
          }
        }
      });
    })()).toThrow(/crash-after-job-completion/);
    expect(tableCount(sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(store.require(input.id).job.state).toBe('leased');
    expect(store.listAttemptEvidence(input.id)[0]?.completion).toBeNull();

    const receipt = sqlite.transaction(() => {
      const fresh = insertReceipt(sqlite);
      store.completeWithReceipt({
        jobId: input.id,
        fence: claimed.job.currentFence!,
        receipt: fresh
      });
      return fresh;
    })();
    expect(store.require(input.id).job.state).toBe('succeeded');
    expect(store.require(input.id).job.lease).toBeNull();
    expect(store.listAttemptEvidence(input.id)[0]?.completion).toMatchObject({
      state: 'succeeded',
      receiptId: receipt.ref.id
    });
    expect(() => sqlite.query(
      'UPDATE reliability_job_attempt_completions_trial SET receipt_id = NULL'
    ).run()).toThrow(/immutable/);
  });

  test('uses trusted time to stop timed-out receipt attachment and records a closed timeout', async () => {
    const { time, store } = setup();
    const input = await createInput({ timeoutMs: 2_000 });
    store.create(input);
    const claimed = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000751'),
      ownerKey: 'job-worker-a'
    });
    time.set(instant('2026-08-11T00:00:04Z'));
    const settled = store.settle({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      policy,
      cause: 'timeout',
      disposition: 'reconcile',
      reasonCode: 'job_timeout_exceeded',
      failure: { code: 'job_timeout_exceeded', classification: 'ambiguous' }
    });
    expect(settled.job.state).toBe('dead_lettered');
    expect(store.readLatestDisposition(input.id)).toMatchObject({
      cause: 'timeout',
      disposition: 'reconcile'
    });
  });

  test('forbidden external work blocks rather than reconciling after lease expiry', async () => {
    const { time, store } = setup();
    const input = await createInput({ externalRetryPolicy: 'forbidden' });
    store.create(input);
    const claimed = store.claim({
      jobId: input.id,
      invocationId: parseInvocationId('00000000-0000-4000-8000-000000000761'),
      ownerKey: 'job-worker-a'
    });
    time.set(instant('2026-08-11T00:00:32Z'));
    expect(() => store.settle({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      policy,
      cause: 'lease_expired',
      disposition: 'reconcile',
      reasonCode: 'job_lease_expired',
      failure: { code: 'job_acceptance_unknown', classification: 'ambiguous' }
    })).toThrow(/external retry policy/);
    const blocked = store.settle({
      jobId: input.id,
      fence: claimed.job.currentFence!,
      policy,
      cause: 'lease_expired',
      disposition: 'block',
      reasonCode: 'external_retry_forbidden',
      failure: { code: 'job_acceptance_unknown', classification: 'ambiguous' }
    });
    expect(blocked.job.state).toBe('dead_lettered');
    expect(store.readLatestDisposition(input.id)?.disposition).toBe('block');
  });
});
