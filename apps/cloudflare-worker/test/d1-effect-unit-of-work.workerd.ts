import { env } from 'cloudflare:workers';
import type {
  DirectOperationLogRecord,
  EffectOperationIdentity,
  TerminalEffectReceipt
} from '@jooevents/application';
import {
  parseCorrelationId,
  parseEventId,
  parseInstant,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  D1EffectUnitOfWorkPort,
  createD1EffectDomainAdapterRegistry
} from '../src/d1-effect-unit-of-work';

const uuid = (suffix: number): string =>
  `019c1df8-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(uuid(1));
const eventId = parseEventId(uuid(2));
const userId = parseUserId(uuid(3));
const capability = Object.freeze({ key: 'capability.d1-probe-write', version: 1 });

interface ProbeRow { readonly value: string; readonly version: number }
interface CountRow { readonly count: number }

function identity(suffix: number): EffectOperationIdentity {
  return Object.freeze({
    scopePartitionKey: suffix.toString(16).padStart(64, '0'),
    authorityPrincipalKey: `principal.${suffix}`,
    operationName: 'probe.update',
    operationVersion: 1,
    surface: 'operator_http',
    idempotencyVerifierProfile: { key: 'idempotency.hmac.d1-probe', version: 1 },
    idempotencyKeyVerifier: suffix.toString(16).padStart(64, '0')
  });
}

function receipt(suffix: number, operationIdentity = identity(suffix)): TerminalEffectReceipt {
  const ref = Object.freeze({
    id: uuid(suffix),
    operationName: operationIdentity.operationName,
    operationVersion: operationIdentity.operationVersion
  });
  return Object.freeze({
    ref,
    identity: operationIdentity,
    requestHash: '3'.repeat(64),
    result: Object.freeze({
      kind: 'success' as const,
      data: { value: `value-${suffix}` },
      receipt: ref,
      correlationId: uuid(suffix + 100)
    })
  });
}

function logRecord(terminal: TerminalEffectReceipt): DirectOperationLogRecord {
  return Object.freeze({
    receipt: terminal,
    registryDigestSha256: '4'.repeat(64),
    actor: { kind: 'workspace_user' as const, userId },
    scope: {
      workspaceId,
      eventId,
      subjects: [{ kind: 'event' as const, id: eventId }]
    },
    summary: 'Updated a D1 probe',
    occurredAt: parseInstant('2026-08-17T00:00:00.000Z'),
    correlationId: parseCorrelationId(terminal.result.correlationId)
  });
}

function port(hooks: string[]): D1EffectUnitOfWorkPort {
  const registry = createD1EffectDomainAdapterRegistry([{
    capability,
    create(buffered) {
      return {
        openHandlerSnapshot: () => Object.freeze({}),
        applyDomainContribution(contribution) {
          if (!contribution || typeof contribution !== 'object'
              || !('id' in contribution) || typeof contribution.id !== 'string'
              || !('value' in contribution) || typeof contribution.value !== 'string') {
            throw new TypeError('invalid_d1_probe_contribution');
          }
          buffered.assertCurrent(
            'EXISTS (SELECT 1 FROM d1_effect_uow_probe WHERE id = ? AND version = ?)',
            [contribution.id, 1]
          );
          buffered.write(
            'UPDATE d1_effect_uow_probe SET value = ?,version = version + 1 WHERE id = ?',
            [contribution.value, contribution.id]
          );
        },
        afterUnitOfWorkCommitted() { hooks.push('committed'); },
        afterUnitOfWorkFinished(outcome) { hooks.push(`finished:${outcome.committed}`); }
      };
    }
  }]);
  return new D1EffectUnitOfWorkPort(env.DB, registry, {
    authorityRecheck: () => ({
      resolveAuthority: () => { throw new Error('unexpected_authority_recheck'); },
      now: () => { throw new Error('unexpected_authority_recheck_clock'); }
    }),
    recordShortOperationAudit: () => { throw new Error('unexpected_short_audit'); }
  });
}

async function insertProbe(id: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO d1_effect_uow_probe (id,value,version) VALUES (?,'before',1)"
  ).bind(id).run();
}

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE d1_effect_uow_probe (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0)
  ) STRICT, WITHOUT ROWID`).run();
});

describe('D1 application effect unit of work in workerd', () => {
  test('commits domain state and its operation log together, then reads the replay', async () => {
    const probeId = 'effect-port-single';
    await insertProbe(probeId);
    const hooks: string[] = [];
    const runtime = port(hooks);
    const terminal = receipt(210);

    await runtime.runInUnitOfWork(async (unit) => {
      expect(await unit.findTerminalReceipt(terminal.identity)).toBeUndefined();
      await unit.applyDomainContribution(capability, { id: probeId, value: 'after' });
      await unit.insertOperationLog?.(logRecord(terminal));
    });

    const row = await env.DB.prepare(
      'SELECT value,version FROM d1_effect_uow_probe WHERE id = ?'
    ).bind(probeId).first<ProbeRow>();
    const logs = await env.DB.prepare(
      'SELECT count(*) AS count FROM operation_log WHERE id = ?'
    ).bind(terminal.ref.id).first<CountRow>();
    expect(row).toEqual({ value: 'after', version: 2 });
    expect(logs?.count).toBe(1);
    expect(await runtime.findTerminalReceipt(terminal.identity)).toEqual(terminal);
    expect(hooks).toEqual(['committed', 'finished:true']);
  });

  test('concurrent identical invocations converge on one domain write and one replay row', async () => {
    const probeId = 'effect-port-race';
    await insertProbe(probeId);
    const terminal = receipt(220);
    const runtime = port([]);
    const execute = () => runtime.runInUnitOfWork(async (unit) => {
      const replay = await unit.findTerminalReceipt(terminal.identity);
      if (replay) return replay;
      await unit.applyDomainContribution(capability, { id: probeId, value: 'winner' });
      await unit.insertOperationLog?.(logRecord(terminal));
      return terminal;
    });

    const results = await Promise.all([execute(), execute()]);
    const row = await env.DB.prepare(
      'SELECT value,version FROM d1_effect_uow_probe WHERE id = ?'
    ).bind(probeId).first<ProbeRow>();
    const logs = await env.DB.prepare(
      'SELECT count(*) AS count FROM operation_log WHERE id = ?'
    ).bind(terminal.ref.id).first<CountRow>();
    expect(results).toEqual([terminal, terminal]);
    expect(row).toEqual({ value: 'winner', version: 2 });
    expect(logs?.count).toBe(1);
  });
});
