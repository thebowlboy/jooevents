import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  sealPublicMutationEffectCompletion
} from '@jooevents/application/public-mutation-effect-completion';
import {
  createHmacRequestHashSealer
} from '@jooevents/application';
import { createPublicEffectConformanceBoundary } from '@jooevents/application/public-effect-conformance';
import {
  createPublicMutationContinuationBoundary,
  type PublicMutationBootstrapVerification,
  type PublicMutationContinuationPolicy,
  type RegisteredPublicMutationBootstrapVerifier
} from '@jooevents/application/public-mutation-continuation';
import type {
  EffectInvocationContext,
  InvocationEvidence,
  TerminalEffectReceipt
} from '@jooevents/application';
import {
  parseOperationAccessLane,
  type CurrentAuthorityResolver
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  parseAuditEventId,
  parseCeremonyEvidenceId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parsePublicPolicyRevisionId,
  parseWorkspaceId,
  type Clock
} from '@jooevents/kernel';
import {
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import {
  installSQLitePublicMutationContinuationTrial,
  SQLitePublicMutationContinuationTrial
} from './public-mutation-continuation-trial';
import {
  installSQLitePublicMutationEffectCompletion,
  SQLitePublicMutationEffectCompletionError,
  SQLitePublicMutationEffectCompletionPort,
  type SQLitePublicMutationEffectCompletionFaults
} from './public-mutation-effect-completion';

const workspaceId = parseWorkspaceId('01890f47-9abc-7def-8123-456789abc001');
const eventId = parseEventId('01890f47-9abc-7def-8123-456789abc002');
const policyRevisionId = parsePublicPolicyRevisionId('01890f47-9abc-7def-8123-456789abc003');
const binding = Object.freeze({ key: 'public.cfp.submit.bootstrap', version: parseContractVersion(1) });
const verifierRef = Object.freeze({ key: 'security.public-mutation-bootstrap', version: parseContractVersion(1) });
const operation = Object.freeze({ name: 'public.cfp.submit', version: parseContractVersion(1) });
const receiptId = '01890f47-9abc-7def-8123-456789abc020';
const correlationId = '01890f47-9abc-7def-8123-456789abc021';

function key(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 19) % 256);
}

function policy(version = 1): PublicMutationContinuationPolicy {
  return Object.freeze({
    binding,
    publicPolicyRevisionId: policyRevisionId,
    operation,
    scope: Object.freeze({ kind: 'event' as const, workspaceId, eventId }),
    purpose: 'cfp.submission',
    action: 'submit',
    resourceBindings: Object.freeze([
      Object.freeze({ kind: 'intake_form', id: '01890f47-9abc-7def-8123-456789abc010' }),
      Object.freeze({ kind: 'intake_form_version', id: '01890f47-9abc-7def-8123-456789abc011' })
    ]),
    lifetimeMs: 5 * 60_000,
    bootstrapVerifier: verifierRef,
    originPolicy: Object.freeze({ key: 'security.origin.public-form', version: parseContractVersion(version) }),
    csrfPolicy: Object.freeze({ key: 'security.csrf.public-form', version: parseContractVersion(1) }),
    rateLimitPolicy: Object.freeze({ key: 'security.rate.public-form', version: parseContractVersion(1) }),
    replayPolicy: Object.freeze({ key: 'security.replay.public-form', version: parseContractVersion(1) }),
    continuationProfiles: Object.freeze([Object.freeze({
      reference: { key: 'security.continuation.primary', version: parseContractVersion(1) },
      keyBytes: key(11)
    })]) as PublicMutationContinuationPolicy['continuationProfiles'],
    principalPartitionProfile: Object.freeze({
      reference: { key: 'security.public-principal-partition', version: parseContractVersion(1) },
      keyBytes: key(31)
    }),
    bootstrapReplayProfile: Object.freeze({
      reference: { key: 'security.public-bootstrap-replay', version: parseContractVersion(1) },
      keyBytes: key(51)
    })
  });
}

class Verifier implements RegisteredPublicMutationBootstrapVerifier {
  readonly reference = verifierRef;
  verify(): PublicMutationBootstrapVerification {
    return Object.freeze({
      kind: 'verified',
      principalPartitionMaterial: new TextEncoder().encode('browser-partition'),
      bootstrapReplayMaterial: new TextEncoder().encode('one-bootstrap'),
      originEvidenceId: 'poe_0123456789abcdef',
      csrfEvidenceId: 'pce_0123456789abcdef',
      rateLimitEvidenceId: 'pre_0123456789abcdef',
      replayEvidenceId: 'ppe_0123456789abcdef'
    });
  }
}

function mutableClock() {
  let value = parseInstant('2026-08-12T00:00:00.000Z');
  return {
    clock: Object.freeze({ now: () => value }) satisfies Clock,
    set(next: string) { value = parseInstant(next); }
  };
}

interface Harness {
  readonly sqlite: Database;
  readonly clock: ReturnType<typeof mutableClock>;
  readonly boundary: ReturnType<typeof createPublicMutationContinuationBoundary>;
  readonly completion: SQLitePublicMutationEffectCompletionPort;
  currentPolicy: PublicMutationContinuationPolicy | undefined;
}

function harness(faults?: SQLitePublicMutationEffectCompletionFaults): Harness {
  const sqlite = new Database(':memory:');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installSQLitePublicMutationContinuationTrial(sqlite);
  installSQLitePublicMutationEffectCompletion(sqlite);
  const clock = mutableClock();
  let currentPolicy: PublicMutationContinuationPolicy | undefined = policy();
  let sequence = 100;
  const auditId = () => parseAuditEventId(
    `01890f47-9abc-7def-8123-${(sequence++).toString(16).padStart(12, '0')}`
  );
  const store = new SQLitePublicMutationContinuationTrial(sqlite, {
    clock: clock.clock,
    newAuditEventId: auditId,
    newCompletionReference: () => 'pcr_fixed-proof-not-used-000001'
  });
  const boundary = createPublicMutationContinuationBoundary({
    binding,
    policies: Object.freeze({ resolve: () => currentPolicy }),
    bootstrapVerifiers: Object.freeze({ resolve: () => new Verifier() }),
    store,
    clock: clock.clock,
    newActionAnchorId: () => '01890f47-9abc-7def-8123-456789abc010',
    newCeremonyEvidenceId: () => parseCeremonyEvidenceId(
      `01890f47-9abc-7def-8123-${(sequence++).toString(16).padStart(12, '0')}`
    ),
    newAuditEventId: auditId,
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1)
  });
  const completion = new SQLitePublicMutationEffectCompletionPort(sqlite, {
    clock: clock.clock,
    newAuditEventId: auditId,
    ...(faults ? { faults } : {})
  });
  return {
    sqlite,
    clock,
    boundary,
    completion,
    get currentPolicy() { return currentPolicy; },
    set currentPolicy(value) { currentPolicy = value; }
  };
}

async function context(ceremonyEvidenceId: string): Promise<EffectInvocationContext> {
  const lane = Object.freeze({
    kind: 'public_ceremony' as const,
    surface: 'public_http' as const,
    policy: Object.freeze({ key: 'authority.public-cfp-submit', version: parseContractVersion(1) })
  });
  const parsedLane = parseOperationAccessLane(lane);
  const parsedCeremonyId = parseCeremonyEvidenceId(ceremonyEvidenceId);
  const actor = Object.freeze({
    kind: 'public_request' as const,
    publicPolicyRevisionId: policyRevisionId,
    authority: Object.freeze({
      kind: 'mutation_ceremony' as const,
      ceremonyEvidenceId: parsedCeremonyId
    })
  });
  const scope = Object.freeze({
    workspaceId,
    eventId,
    subjects: Object.freeze([
      Object.freeze({ kind: 'workspace' as const, id: workspaceId }),
      Object.freeze({ kind: 'event' as const, id: eventId })
    ]),
    resolutionEvidenceIds: Object.freeze(['public.ceremony.current'])
  });
  const boundary = createPublicEffectConformanceBoundary();
  const builder = boundary.createContextBuilder({
    reference: { key: 'context.public-cfp-submit', version: parseContractVersion(1) },
    operation,
    effect: 'commit',
    lanes: [parsedLane],
    scopeResolver: Object.freeze({ resolve: () => scope }),
    authorityResolver: Object.freeze({
      resolve: (input: Parameters<CurrentAuthorityResolver<InvocationEvidence>['resolve']>[0]) => Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor,
          principal: Object.freeze({
            kind: 'public_capability' as const,
            publicPolicyRevisionId: policyRevisionId,
            authority: actor.authority
          }),
          lane: input.lane,
          scope: input.scope,
          grants: Object.freeze([{ kind: 'public_policy' as const, key: 'public.cfp.submit' }]),
          evidenceIds: Object.freeze(['public.ceremony.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: input.evaluatedAt
        })
      })
    }),
    clock: { now: () => parseInstant('2026-08-12T00:00:00.000Z') },
    newInvocationId: () => parseInvocationId('01890f47-9abc-7def-8123-456789abc040'),
    authorityPrincipalKeyProfile: { key: 'principal.public-cfp', version: parseContractVersion(1) },
    scopePartitionProfile: { key: 'scope.public-cfp', version: parseContractVersion(1) },
    requestCanonicalizationProfile: { key: 'request.public-cfp', version: parseContractVersion(1) },
    requestHashProfile: { key: 'request-hash.public-cfp', version: parseContractVersion(1) },
    requestHashSealer: createHmacRequestHashSealer({
      profile: { key: 'request-hash.public-cfp', version: parseContractVersion(1) },
      keyBytes: key(71)
    }),
    idempotencyCredentialProfile: { key: 'idempotency.public-cfp', version: parseContractVersion(1) },
    idempotencyCredentialSealer: Object.freeze({
      seal: async (raw: string) => ({
        verifierProfile: { key: 'idempotency.public-cfp', version: parseContractVersion(1) },
        verifierSha256: new Bun.CryptoHasher('sha256').update(`idempotency:${raw}`).digest('hex')
      })
    }),
    deniedAuthorityOutcome: (reason) => ({
      class: 'access_denied', kind: `authority.${reason}`, retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const built = await builder.build({
    operationName: operation.name,
    operationVersion: operation.version,
    surface: 'public_http',
    correlationId,
    businessInput: Object.freeze({ expectedDraftVersion: 1 }),
    verifiedEvidence: Object.freeze({
      kind: 'public_ceremony',
      surface: 'public_http',
      client: Object.freeze({ key: 'closed-intake.test' }),
      ceremonyEvidenceId: parsedCeremonyId
    }),
    rawIdempotencyKey: 'submit-idempotency-1'
  });
  if (built.kind !== 'ready') throw new TypeError('expected authentic public context');
  return built.context;
}

function receipt(boundContext: EffectInvocationContext, id = receiptId): TerminalEffectReceipt {
  const ref = Object.freeze({ id, operationName: operation.name, operationVersion: operation.version });
  return Object.freeze({
    ref,
    identity: Object.freeze({
      scopePartitionKey: boundContext.requestBinding.scopePartitionKey,
      authorityPrincipalKey: boundContext.authorityPrincipalKey,
      operationName: operation.name,
      operationVersion: operation.version,
      surface: 'public_http' as const,
      idempotencyVerifierProfile: boundContext.requestBinding.idempotency!.verifierProfile,
      idempotencyKeyVerifier: boundContext.requestBinding.idempotency!.verifierSha256
    }),
    requestHash: boundContext.requestBinding.requestHashSha256,
    result: Object.freeze({
      kind: 'success' as const,
      data: Object.freeze({ submissionId: '01890f47-9abc-7def-8123-456789abc030' }),
      receipt: ref,
      correlationId
    })
  });
}

function insertReceipt(sqlite: Database, value: TerminalEffectReceipt): void {
  sqlite.query(`
    INSERT INTO foundation_trial_operation_receipts (
      id, scope_partition_key, authority_principal_key, operation_name,
      operation_version, surface, idempotency_verifier_profile_key,
      idempotency_verifier_profile_version, idempotency_key_verifier,
      request_hash, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.ref.id,
    value.identity.scopePartitionKey,
    value.identity.authorityPrincipalKey,
    value.identity.operationName,
    value.identity.operationVersion,
    value.identity.surface,
    value.identity.idempotencyVerifierProfile.key,
    value.identity.idempotencyVerifierProfile.version,
    value.identity.idempotencyKeyVerifier,
    value.requestHash,
    canonicalJsonText(value.result)
  );
}

async function admitted(h: Harness) {
  const minted = await h.boundary.mint({ protocolEvidence: {} });
  if (minted.kind !== 'issued') throw new TypeError('expected issued continuation');
  const admission = h.boundary.admit({ continuation: minted.continuation });
  if (admission.kind !== 'ready') throw new TypeError('expected ready continuation');
  return { continuation: minted.continuation, evidence: admission.evidence };
}

function count(sqlite: Database, table: string): number {
  return Number(sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1);
}

describe('transaction-bound public mutation effect completion', () => {
  test('refuses forged/substituted contexts and nonterminal or cross-bound receipt results', async () => {
    const h = harness();
    const ready = await admitted(h);
    const ceremonyId = h.boundary.sealReader.open(ready.evidence)!.ceremonyEvidenceId;
    const invocationContext = await context(ceremonyId);
    const terminalReceipt = receipt(invocationContext);

    expect(() => sealPublicMutationEffectCompletion({
      evidence: ready.evidence,
      sealReader: h.boundary.sealReader,
      context: structuredClone(invocationContext) as EffectInvocationContext,
      receipt: terminalReceipt,
      completionReference: 'pcr_registered-effect-00000004'
    })).toThrow('operation_mismatch');

    const wrongOperationContext = await context(ceremonyId);
    const forgedOperationContext = {
      ...wrongOperationContext,
      operation: { name: 'public.cfp.other', version: 1, effect: 'commit' }
    } as unknown as EffectInvocationContext;
    expect(() => sealPublicMutationEffectCompletion({
      evidence: ready.evidence,
      sealReader: h.boundary.sealReader,
      context: forgedOperationContext,
      receipt: terminalReceipt,
      completionReference: 'pcr_registered-effect-00000005'
    })).toThrow('operation_mismatch');

    const mismatchedEmbedded = {
      ...terminalReceipt,
      result: {
        ...terminalReceipt.result,
        receipt: { ...terminalReceipt.ref, id: '01890f47-9abc-7def-8123-456789abc088' }
      }
    } as TerminalEffectReceipt;
    expect(() => sealPublicMutationEffectCompletion({
      evidence: ready.evidence,
      sealReader: h.boundary.sealReader,
      context: invocationContext,
      receipt: mismatchedEmbedded,
      completionReference: 'pcr_registered-effect-00000006'
    })).toThrow('receipt_mismatch');

    const nonterminal = {
      ...terminalReceipt,
      result: {
        kind: 'outcome',
        outcome: {
          class: 'conflict', kind: 'application.changed', retryable: false,
          subjects: [], detail: null, detailSchemaVersion: 1
        },
        terminal: false,
        correlationId
      }
    } as unknown as TerminalEffectReceipt;
    expect(() => sealPublicMutationEffectCompletion({
      evidence: ready.evidence,
      sealReader: h.boundary.sealReader,
      context: invocationContext,
      receipt: nonterminal,
      completionReference: 'pcr_registered-effect-00000007'
    })).toThrow('receipt_mismatch');
  });

  test('atomically terminalizes an authentic receipt and resolves response loss', async () => {
    const h = harness();
    const ready = await admitted(h);
    const ceremonyId = h.boundary.sealReader.open(ready.evidence)!.ceremonyEvidenceId;
    const invocationContext = await context(ceremonyId);
    const terminalReceipt = receipt(invocationContext);
    const sealed = sealPublicMutationEffectCompletion({
      evidence: ready.evidence,
      sealReader: h.boundary.sealReader,
      context: invocationContext,
      receipt: terminalReceipt,
      completionReference: 'pcr_registered-effect-00000001'
    });

    expect(() => h.completion.complete(sealed)).toThrow(
      new SQLitePublicMutationEffectCompletionError('transaction_required')
    );
    h.sqlite.exec('BEGIN IMMEDIATE');
    insertReceipt(h.sqlite, terminalReceipt);
    const completed = h.completion.complete(sealed);
    h.sqlite.exec('COMMIT');

    expect(completed).toMatchObject({
      kind: 'terminal', completionReference: 'pcr_registered-effect-00000001', replay: false
    });
    expect(h.boundary.admit({ continuation: ready.continuation })).toEqual({
      kind: 'terminal', completionReference: 'pcr_registered-effect-00000001'
    });
    expect(h.completion.resume('pcr_registered-effect-00000001')).toEqual(terminalReceipt);
    expect(count(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(1);
    expect(count(h.sqlite, 'public_mutation_registered_effect_completions')).toBe(1);

    h.sqlite.exec('BEGIN IMMEDIATE');
    expect(h.completion.complete(sealed)).toMatchObject({ kind: 'terminal', replay: true });
    h.sqlite.exec('COMMIT');
  });

  test('rolls proof, binding, receipt and terminal state back after an injected crash', async () => {
    const h = harness({ afterCeremonyTerminal: () => { throw new Error('crash'); } });
    const ready = await admitted(h);
    const ceremonyId = h.boundary.sealReader.open(ready.evidence)!.ceremonyEvidenceId;
    const invocationContext = await context(ceremonyId);
    const terminalReceipt = receipt(invocationContext);
    const sealed = sealPublicMutationEffectCompletion({
      evidence: ready.evidence,
      sealReader: h.boundary.sealReader,
      context: invocationContext,
      receipt: terminalReceipt,
      completionReference: 'pcr_registered-effect-00000002'
    });

    h.sqlite.exec('BEGIN IMMEDIATE');
    insertReceipt(h.sqlite, terminalReceipt);
    expect(() => h.completion.complete(sealed)).toThrow('completion_collision');
    h.sqlite.exec('ROLLBACK');
    expect(count(h.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);
    expect(count(h.sqlite, 'public_mutation_registered_effect_completions')).toBe(0);
    expect(h.boundary.admit({ continuation: ready.continuation }).kind).toBe('ready');
  });

  test('stops on current configuration rotation and refuses a substituted receipt', async () => {
    const h = harness();
    const ready = await admitted(h);
    const ceremonyId = h.boundary.sealReader.open(ready.evidence)!.ceremonyEvidenceId;
    const invocationContext = await context(ceremonyId);
    const terminalReceipt = receipt(invocationContext);
    const sealed = sealPublicMutationEffectCompletion({
      evidence: ready.evidence,
      sealReader: h.boundary.sealReader,
      context: invocationContext,
      receipt: terminalReceipt,
      completionReference: 'pcr_registered-effect-00000003'
    });

    h.currentPolicy = policy(2);
    h.sqlite.exec('BEGIN IMMEDIATE');
    insertReceipt(h.sqlite, terminalReceipt);
    expect(h.completion.complete(sealed)).toEqual({ kind: 'stopped', reason: 'policy_changed' });
    h.sqlite.exec('ROLLBACK');

    h.currentPolicy = policy();
    h.sqlite.exec('BEGIN IMMEDIATE');
    insertReceipt(h.sqlite, receipt(invocationContext, '01890f47-9abc-7def-8123-456789abc099'));
    expect(() => h.completion.complete(sealed)).toThrow('receipt_mismatch');
    h.sqlite.exec('ROLLBACK');
    expect(count(h.sqlite, 'public_mutation_effect_proofs_trial')).toBe(0);
  });
});
