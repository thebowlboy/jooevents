import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  D1BufferedUnitOfWorkConflict,
  runD1BufferedUnitOfWork
} from '../src/d1-atomic-batch';
import { handleRequest } from '../src/index';

interface ProbeRow {
  readonly value: string;
  readonly version: number;
}

interface CountRow { readonly count: number }

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE d1_atomic_batch_probe (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    ) STRICT, WITHOUT ROWID`
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO d1_atomic_batch_probe (id,value,version) VALUES ('probe','before',1)
     ON CONFLICT (id) DO UPDATE SET value = excluded.value,version = excluded.version`
  ).run();
});

describe('D1 atomic batch in workerd', () => {
  test('reports the migrated D1 and R2 adapter foundation without claiming runtime readiness', async () => {
    const response = await handleRequest(
      new Request('https://jooevents.invalid/health'),
      env
    );
    const body = await response.json<{
      status: string;
      ready: boolean;
      applicationRuntimeReady: boolean;
      adapters: {
        d1: boolean;
        d1BufferedUnitOfWork: boolean;
        r2: boolean;
        emailBinding: boolean;
      };
    }>();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toMatchObject({
      status: 'adapter_foundation_ready',
      ready: false,
      applicationRuntimeReady: false,
      adapters: {
        d1: true,
        d1BufferedUnitOfWork: true,
        r2: true,
        emailBinding: true
      }
    });
  });

  test('commits a true guard and removes transient assertion rows', async () => {
    await runD1BufferedUnitOfWork({
      database: env.DB,
      async work(unitOfWork) {
        unitOfWork.assertCurrent(
          'EXISTS (SELECT 1 FROM d1_atomic_batch_probe WHERE id = ? AND version = ?)',
          ['probe', 1]
        );
        unitOfWork.write(
          'UPDATE d1_atomic_batch_probe SET value = ?,version = version + 1 WHERE id = ?',
          ['after', 'probe']
        );
      }
    });
    const row = await env.DB.prepare(
      'SELECT value,version FROM d1_atomic_batch_probe WHERE id = ?'
    ).bind('probe').first<ProbeRow>();
    const guards = await env.DB.prepare(
      'SELECT count(*) AS count FROM d1_operation_batch_guards'
    ).first<CountRow>();
    expect(row).toEqual({ value: 'after', version: 2 });
    expect(guards?.count).toBe(0);
  });

  test('rolls back every write when a guard is false and bounds callback replay', async () => {
    let callbacks = 0;
    await expect(runD1BufferedUnitOfWork({
      database: env.DB,
      maximumAttempts: 2,
      async work(unitOfWork) {
        callbacks += 1;
        unitOfWork.assertCurrent(
          'EXISTS (SELECT 1 FROM d1_atomic_batch_probe WHERE id = ? AND version = ?)',
          ['probe', 0]
        );
        unitOfWork.write(
          'UPDATE d1_atomic_batch_probe SET value = ?,version = version + 1 WHERE id = ?',
          ['must-not-commit', 'probe']
        );
      }
    })).rejects.toBeInstanceOf(D1BufferedUnitOfWorkConflict);
    const row = await env.DB.prepare(
      'SELECT value,version FROM d1_atomic_batch_probe WHERE id = ?'
    ).bind('probe').first<ProbeRow>();
    const guards = await env.DB.prepare(
      'SELECT count(*) AS count FROM d1_operation_batch_guards'
    ).first<CountRow>();
    expect(callbacks).toBe(2);
    expect(row).toEqual({ value: 'before', version: 1 });
    expect(guards?.count).toBe(0);
  });
});
