import { describe, expect, test } from 'bun:test';
import type {
  EffectAuthorityRecheckSource,
  EffectOperationIdentity,
  EffectUnitOfWork,
  TerminalEffectReceipt
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import { Database } from 'bun:sqlite';
import {
  SQLiteTrialEffectUnitOfWorkPort,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';

const receiptIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c7b40',
  '018f0f47-7a86-7d36-8a25-9f86589c7b41',
  '018f0f47-7a86-7d36-8a25-9f86589c7b42'
] as const;
const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const noteCapability = Object.freeze({ key: 'capability.note-write', version: 1 });

const unexpectedAuthorityRecheck: EffectAuthorityRecheckSource = Object.freeze({
  resolveAuthority: () => {
    throw new Error('unexpected_authority_recheck');
  },
  now: () => {
    throw new Error('unexpected_authority_recheck_clock');
  }
});

function identity(overrides: Partial<EffectOperationIdentity> = {}): EffectOperationIdentity {
  return Object.freeze({
    scopePartitionKey: '1'.repeat(64),
    authorityPrincipalKey: 'principal.ada',
    operationName: 'note.draft',
    operationVersion: 1,
    surface: 'operator_http',
    idempotencyVerifierProfile: { key: 'idempotency.hmac.test', version: 1 },
    idempotencyKeyVerifier: '2'.repeat(64),
    ...overrides
  });
}

function receipt(
  operationIdentity: EffectOperationIdentity,
  id: string = receiptIds[0],
  requestHash = '3'.repeat(64)
): TerminalEffectReceipt {
  const ref = Object.freeze({
    id,
    operationName: operationIdentity.operationName,
    operationVersion: operationIdentity.operationVersion
  });
  return Object.freeze({
    ref,
    identity: operationIdentity,
    requestHash,
    result: Object.freeze({
      kind: 'success' as const,
      data: { value: 'alpha' },
      receipt: ref,
      correlationId
    })
  });
}

interface Harness {
  readonly sqlite: Database;
  readonly port: SQLiteTrialEffectUnitOfWorkPort;
  readonly trace: string[];
}

function harness(): Harness {
  const sqlite = new Database(':memory:', { strict: true });
  installFoundationTrialUnitOfWorkSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE foundation_trial_notes (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const trace: string[] = [];
  const domain: SQLiteTrialEffectDomainAdapter = {
    openHandlerSnapshot(capability: VersionedDefinitionRef) {
      trace.push(`snapshot:${capability.key}@${capability.version}`);
      return Object.freeze({ noteCount: sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM foundation_trial_notes').get()?.count ?? 0 });
    },
    applyDomainContribution(contribution: unknown) {
      trace.push('domain');
      if (!contribution || typeof contribution !== 'object' || !('value' in contribution) || typeof contribution.value !== 'string') {
        throw new TypeError('invalid_note_contribution');
      }
      sqlite.query<never, [string]>('INSERT INTO foundation_trial_notes (value) VALUES (?)').run(contribution.value);
    },
    afterReceiptParentInserted() {
      trace.push(`parent-hook:${sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM foundation_trial_operation_receipts').get()?.count ?? -1}`);
    },
    afterReceiptChildInserted() {
      trace.push(`child-hook:${sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM foundation_trial_operation_receipt_children').get()?.count ?? -1}`);
    },
    afterExecutionClaimReleased() {
      trace.push(`release-hook:${sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM foundation_trial_operation_execution_claims').get()?.count ?? -1}`);
    },
    afterUnitOfWorkCommitted() {
      trace.push(`commit-hook:${sqlite.inTransaction}`);
    }
  };
  return {
    sqlite,
    port: new SQLiteTrialEffectUnitOfWorkPort(sqlite, domain, unexpectedAuthorityRecheck),
    trace
  };
}

async function terminalWrite(input: {
  readonly port: SQLiteTrialEffectUnitOfWorkPort;
  readonly identity: EffectOperationIdentity;
  readonly receipt: TerminalEffectReceipt;
  readonly failAfter?: 'claim' | 'domain' | 'parent' | 'child' | 'release';
}): Promise<void> {
  await input.port.runInUnitOfWork(async (unitOfWork) => {
    expect(await unitOfWork.acquireExecutionClaim(input.identity, input.receipt.requestHash)).toEqual({ kind: 'acquired' });
    if (input.failAfter === 'claim') throw new Error('injected:claim');
    await unitOfWork.applyDomainContribution(noteCapability, {
      value: input.identity.authorityPrincipalKey
    });
    if (input.failAfter === 'domain') throw new Error('injected:domain');
    await unitOfWork.insertReceiptParent(input.receipt);
    if (input.failAfter === 'parent') throw new Error('injected:parent');
    await unitOfWork.insertReceiptChild(input.receipt.ref.id, { kind: 'domain_evidence', summary: 'note drafted' });
    if (input.failAfter === 'child') throw new Error('injected:child');
    await unitOfWork.releaseExecutionClaim(input.identity);
    if (input.failAfter === 'release') throw new Error('injected:release');
  });
}

function counts(sqlite: Database) {
  const count = (table: string) => sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? -1;
  return {
    claims: count('foundation_trial_operation_execution_claims'),
    receipts: count('foundation_trial_operation_receipts'),
    children: count('foundation_trial_operation_receipt_children'),
    notes: count('foundation_trial_notes')
  };
}

describe('real SQLite ordinary-effect UnitOfWork trial', () => {
  test('commits domain state, immutable receipt parent, child, and no execution claim exactly once', async () => {
    const test = harness();
    const operationIdentity = identity();
    const terminal = receipt(operationIdentity);
    try {
      await terminalWrite({ port: test.port, identity: operationIdentity, receipt: terminal });
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 1, children: 1, notes: 1 });
      const loaded = test.port.findTerminalReceipt(operationIdentity);
      expect(loaded).toEqual(terminal);
      expect(loaded && [
        loaded,
        loaded.ref,
        loaded.identity,
        loaded.identity.idempotencyVerifierProfile,
        loaded.result,
        loaded.result.kind === 'success' ? loaded.result.data : loaded.result.outcome
      ].every(Object.isFrozen)).toBe(true);
      expect(test.sqlite.query<{
        idempotency_verifier_profile_key: string;
        idempotency_verifier_profile_version: number;
      }, []>(`
        SELECT idempotency_verifier_profile_key, idempotency_verifier_profile_version
          FROM foundation_trial_operation_receipts
      `).get()).toEqual({
        idempotency_verifier_profile_key: 'idempotency.hmac.test',
        idempotency_verifier_profile_version: 1
      });
      expect(test.sqlite.query<{ contribution_json: string }, []>(
        'SELECT contribution_json FROM foundation_trial_operation_receipt_children'
      ).get()?.contribution_json).toBe('{"kind":"domain_evidence","summary":"note drafted"}');
      expect(test.trace).toContain('parent-hook:1');
      expect(test.trace).toContain('child-hook:1');
      expect(test.trace).toContain('release-hook:0');
      expect(test.trace).toContain('commit-hook:false');
    } finally {
      test.sqlite.close();
    }
  });

  test('injected failure after every write boundary rolls back domain, receipt, child, and claim', async () => {
    for (const failAfter of ['claim', 'domain', 'parent', 'child', 'release'] as const) {
      const test = harness();
      const operationIdentity = identity();
      try {
        await expect(terminalWrite({
          port: test.port,
          identity: operationIdentity,
          receipt: receipt(operationIdentity),
          failAfter
        })).rejects.toThrow(`injected:${failAfter}`);
        expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 0, children: 0, notes: 0 });
      } finally {
        test.sqlite.close();
      }
    }
  });

  test('a callback that forgets claim deletion cannot commit anything', async () => {
    const test = harness();
    const operationIdentity = identity();
    try {
      await expect(test.port.runInUnitOfWork(async (unitOfWork) => {
        expect(await unitOfWork.acquireExecutionClaim(operationIdentity, '3'.repeat(64))).toEqual({ kind: 'acquired' });
        await unitOfWork.applyDomainContribution(noteCapability, { value: 'alpha' });
        await unitOfWork.insertReceiptParent(receipt(operationIdentity));
      })).rejects.toThrow('foundation_execution_claim_not_released');
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 0, children: 0, notes: 0 });
    } finally {
      test.sqlite.close();
    }
  });

  test('immediate foreign keys reject a child before its terminal receipt parent', async () => {
    const test = harness();
    const operationIdentity = identity();
    try {
      await expect(test.port.runInUnitOfWork(async (unitOfWork: EffectUnitOfWork) => {
        expect(await unitOfWork.acquireExecutionClaim(operationIdentity, '3'.repeat(64))).toEqual({ kind: 'acquired' });
        await unitOfWork.insertReceiptChild(receiptIds[0], { kind: 'domain_evidence' });
      })).rejects.toThrow();
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 0, children: 0, notes: 0 });
    } finally {
      test.sqlite.close();
    }
  });

  test('receipt storage rejects an embedded operation identity that differs from its row identity', async () => {
    const test = harness();
    const operationIdentity = identity();
    const valid = receipt(operationIdentity);
    if (valid.result.kind !== 'success') throw new TypeError('missing receipt identity fixture');
    const tampered: TerminalEffectReceipt = {
      ...valid,
      result: {
        ...valid.result,
        receipt: { ...valid.result.receipt, operationName: 'note.substituted' }
      }
    };
    try {
      await expect(test.port.runInUnitOfWork(async (unitOfWork) => {
        await unitOfWork.insertReceiptParent(tampered);
      })).rejects.toThrow();
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 0, children: 0, notes: 0 });
    } finally {
      test.sqlite.close();
    }
  });

  test('the same raw verifier is isolated by scope and principal while an exact identity is unique', async () => {
    const test = harness();
    const first = identity();
    const otherScope = identity({ scopePartitionKey: '4'.repeat(64) });
    const otherPrincipal = identity({ authorityPrincipalKey: 'principal.grace' });
    try {
      await terminalWrite({ port: test.port, identity: first, receipt: receipt(first, receiptIds[0]) });
      await terminalWrite({ port: test.port, identity: otherScope, receipt: receipt(otherScope, receiptIds[1]) });
      await terminalWrite({ port: test.port, identity: otherPrincipal, receipt: receipt(otherPrincipal, receiptIds[2]) });
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 3, children: 3, notes: 3 });
      await expect(test.port.runInUnitOfWork(async (unitOfWork) => {
        expect(await unitOfWork.acquireExecutionClaim(first, '3'.repeat(64))).toEqual({ kind: 'acquired' });
        await unitOfWork.insertReceiptParent(receipt(first, crypto.randomUUID()));
      })).rejects.toThrow();
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 3, children: 3, notes: 3 });
    } finally {
      test.sqlite.close();
    }
  });

  test('the pinned verifier profile is part of the exact claim and receipt identity', async () => {
    const test = harness();
    const first = identity();
    const rotated = identity({
      idempotencyVerifierProfile: { key: 'idempotency.hmac.test', version: 2 }
    });
    try {
      await test.port.runInUnitOfWork(async (unitOfWork) => {
        expect(await unitOfWork.acquireExecutionClaim(first, '3'.repeat(64))).toEqual({ kind: 'acquired' });
        expect(await unitOfWork.acquireExecutionClaim(rotated, '3'.repeat(64))).toEqual({ kind: 'acquired' });
        await unitOfWork.releaseExecutionClaim(first);
        await unitOfWork.releaseExecutionClaim(rotated);
      });

      await terminalWrite({ port: test.port, identity: first, receipt: receipt(first) });
      expect(test.port.findTerminalReceipt(rotated)).toBeUndefined();
      await terminalWrite({ port: test.port, identity: rotated, receipt: receipt(rotated, receiptIds[1]) });
      expect(test.port.findTerminalReceipt(rotated)?.identity.idempotencyVerifierProfile).toEqual(
        rotated.idempotencyVerifierProfile
      );
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 2, children: 2, notes: 2 });
    } finally {
      test.sqlite.close();
    }
  });

  test('execution-claim contention distinguishes the exact request hash without disclosing it', async () => {
    const test = harness();
    const operationIdentity = identity();
    try {
      await test.port.runInUnitOfWork(async (unitOfWork) => {
        expect(await unitOfWork.acquireExecutionClaim(operationIdentity, '3'.repeat(64)))
          .toEqual({ kind: 'acquired' });
        expect(await unitOfWork.acquireExecutionClaim(operationIdentity, '3'.repeat(64)))
          .toEqual({ kind: 'contended_same_request' });
        expect(await unitOfWork.acquireExecutionClaim(operationIdentity, '4'.repeat(64)))
          .toEqual({ kind: 'contended_changed_request' });
        await unitOfWork.releaseExecutionClaim(operationIdentity);
      });
      expect(counts(test.sqlite).claims).toBe(0);
    } finally {
      test.sqlite.close();
    }
  });

  test('a failed BEGIN neither poisons the port nor rolls back the caller transaction', async () => {
    const test = harness();
    const operationIdentity = identity();
    try {
      test.sqlite.exec('BEGIN;');
      test.sqlite.query<never, [string]>(
        'INSERT INTO foundation_trial_notes (value) VALUES (?)'
      ).run('caller-owned');

      await expect(test.port.runInUnitOfWork(async () => undefined)).rejects.toThrow();
      expect(test.sqlite.inTransaction).toBe(true);
      expect(counts(test.sqlite).notes).toBe(1);
      test.sqlite.exec('ROLLBACK;');

      await terminalWrite({
        port: test.port,
        identity: operationIdentity,
        receipt: receipt(operationIdentity)
      });
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 1, children: 1, notes: 1 });
    } finally {
      if (test.sqlite.inTransaction) test.sqlite.exec('ROLLBACK;');
      test.sqlite.close();
    }
  });

  test('terminal receipts and receipt children are immutable at the database boundary', async () => {
    const test = harness();
    const operationIdentity = identity();
    try {
      await terminalWrite({ port: test.port, identity: operationIdentity, receipt: receipt(operationIdentity) });
      expect(() => test.sqlite.exec(`
        UPDATE foundation_trial_operation_receipts SET request_hash = '${'4'.repeat(64)}'
      `)).toThrow('foundation operation receipts are immutable');
      expect(() => test.sqlite.exec('DELETE FROM foundation_trial_operation_receipts')).toThrow(
        'foundation operation receipts are immutable'
      );
      expect(() => test.sqlite.exec(`
        UPDATE foundation_trial_operation_receipt_children SET contribution_json = '{}'
      `)).toThrow('foundation operation receipt children are immutable');
      expect(counts(test.sqlite)).toEqual({ claims: 0, receipts: 1, children: 1, notes: 1 });
    } finally {
      test.sqlite.close();
    }
  });
});
