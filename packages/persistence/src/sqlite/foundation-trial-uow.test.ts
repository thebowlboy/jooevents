import { describe, expect, test } from 'bun:test';
import type {
  DirectOperationLogRecord,
  EffectAuthorityRecheckSource,
  EffectOperationIdentity,
  TerminalEffectReceipt
} from '@jooevents/application';
import type { VersionedDefinitionRef } from '@jooevents/contracts';
import {
  parseCorrelationId,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { Database } from 'bun:sqlite';
import {
  SQLiteTrialEffectUnitOfWorkPort,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';

const uuid = (suffix: number): string =>
  `019c1df8-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(uuid(1));
const eventId = parseEventId(uuid(2));
const userId = parseUserId(uuid(3));
const capability = Object.freeze({ key: 'capability.note-write', version: 1 });

const authority: EffectAuthorityRecheckSource = Object.freeze({
  resolveAuthority: () => { throw new Error('unexpected_authority_recheck'); },
  now: () => { throw new Error('unexpected_authority_recheck_clock'); }
});

function identity(): EffectOperationIdentity {
  return Object.freeze({
    scopePartitionKey: '1'.repeat(64),
    authorityPrincipalKey: 'principal.ada',
    operationName: 'note.update',
    operationVersion: 1,
    surface: 'operator_http',
    idempotencyVerifierProfile: { key: 'idempotency.hmac.test', version: 1 },
    idempotencyKeyVerifier: '2'.repeat(64)
  });
}

function receipt(operationIdentity = identity()): TerminalEffectReceipt {
  const ref = Object.freeze({
    id: uuid(10),
    operationName: operationIdentity.operationName,
    operationVersion: operationIdentity.operationVersion
  });
  return Object.freeze({
    ref,
    identity: operationIdentity,
    requestHash: '3'.repeat(64),
    result: Object.freeze({
      kind: 'success' as const,
      data: { value: 'alpha' },
      receipt: ref,
      correlationId: uuid(11)
    })
  });
}

function logRecord(terminal = receipt()): DirectOperationLogRecord {
  return Object.freeze({
    receipt: terminal,
    registryDigestSha256: '4'.repeat(64),
    actor: { kind: 'workspace_user' as const, userId },
    scope: {
      workspaceId,
      eventId,
      subjects: [{ kind: 'event' as const, id: eventId }]
    },
    summary: 'Updated a note',
    occurredAt: parseInstant('2026-08-16T00:00:00.000Z'),
    correlationId: parseCorrelationId(uuid(11))
  });
}

function harness() {
  const sqlite = new Database(':memory:', { strict: true });
  installFoundationTrialUnitOfWorkSchema(sqlite);
  sqlite.exec('CREATE TABLE notes (value TEXT NOT NULL);');
  const domain: SQLiteTrialEffectDomainAdapter = {
    openHandlerSnapshot(_capability: VersionedDefinitionRef) {
      return Object.freeze({});
    },
    applyDomainContribution(contribution: unknown) {
      if (!contribution || typeof contribution !== 'object' || !('value' in contribution)
        || typeof contribution.value !== 'string') throw new TypeError('invalid_note');
      sqlite.query<never, [string]>('INSERT INTO notes(value) VALUES (?)').run(contribution.value);
    }
  };
  return {
    sqlite,
    port: new SQLiteTrialEffectUnitOfWorkPort(sqlite, domain, authority)
  };
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? -1;
}

describe('SQLite operation-log unit of work', () => {
  test('atomically commits domain state and the single terminal log, then replays it', async () => {
    const test = harness();
    try {
      const terminal = receipt();
      await test.port.runInUnitOfWork(async (unit) => {
        await unit.applyDomainContribution(capability, { value: 'alpha' });
        await unit.insertOperationLog?.(logRecord(terminal));
      });
      expect(count(test.sqlite, 'notes')).toBe(1);
      expect(count(test.sqlite, 'operation_log')).toBe(1);
      expect(test.port.findTerminalReceipt(terminal.identity)).toEqual(terminal);
    } finally {
      test.sqlite.close();
    }
  });

  test('rolls domain and log back together', async () => {
    const test = harness();
    try {
      await expect(test.port.runInUnitOfWork(async (unit) => {
        await unit.applyDomainContribution(capability, { value: 'alpha' });
        await unit.insertOperationLog?.(logRecord());
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(count(test.sqlite, 'notes')).toBe(0);
      expect(count(test.sqlite, 'operation_log')).toBe(0);
    } finally {
      test.sqlite.close();
    }
  });

  test('installs no generic claim, receipt-child, or audit tables and keeps the log immutable', async () => {
    const test = harness();
    try {
      const names = test.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
      `).all().map((row) => row.name);
      expect(names).not.toContain('foundation_trial_operation_execution_claims');
      expect(names).toContain('operation_log');
      expect(names).not.toContain('foundation_trial_operation_effect_contributionren');
      expect(names).not.toContain('foundation_trial_operation_audits');
      await test.port.runInDirectUnitOfWork?.(async (unit) => {
        await unit.insertOperationLog(logRecord());
      });
      expect(() => test.sqlite.exec("UPDATE operation_log SET summary = 'tampered'")).toThrow(
        'operation log is immutable'
      );
    } finally {
      test.sqlite.close();
    }
  });
});
