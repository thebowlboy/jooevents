import { describe, expect, test } from 'bun:test';
import {
  D1BufferedUnitOfWorkConflict,
  runD1BufferedUnitOfWork
} from './d1-atomic-batch';

interface CapturedStatement {
  sql: string;
  bindings: unknown[];
}

function fixture(errors: readonly (Error | undefined)[] = []) {
  const constraints: string[] = [];
  const batches: CapturedStatement[][] = [];
  let batchIndex = 0;
  const database = {
    withSession(constraint: string) {
      constraints.push(constraint);
      return {
        prepare(sql: string) {
          const statement: CapturedStatement = { sql, bindings: [] };
          return {
            bind(...bindings: unknown[]) {
              statement.bindings = bindings;
              return statement;
            }
          };
        },
        async batch(statements: CapturedStatement[]) {
          batches.push(statements);
          const error = errors[batchIndex++];
          if (error) throw error;
          return [];
        },
        getBookmark() { return null; }
      };
    }
  };
  return { database: database as D1Database, constraints, batches };
}

describe('D1 buffered unit of work', () => {
  test('commits guards, writes, and cleanup in one ordered primary-session batch', async () => {
    const fx = fixture();
    const result = await runD1BufferedUnitOfWork({
      database: fx.database,
      newBatchId: () => 'batch-one',
      async work(unitOfWork) {
        unitOfWork.assertCurrent('EXISTS (SELECT 1 FROM events WHERE id = ?)', ['event-1']);
        unitOfWork.write('UPDATE events SET version = version + 1 WHERE id = ?', ['event-1']);
        return 'committed';
      }
    });
    expect(result).toBe('committed');
    expect(fx.constraints).toEqual(['first-primary']);
    expect(fx.batches).toHaveLength(1);
    expect(fx.batches[0]).toHaveLength(3);
    expect(fx.batches[0]?.[0]?.sql).toContain('INSERT INTO d1_operation_batch_guards');
    expect(fx.batches[0]?.[0]?.bindings).toEqual(['batch-one', 1, 'event-1']);
    expect(fx.batches[0]?.[1]).toEqual({
      sql: 'UPDATE events SET version = version + 1 WHERE id = ?',
      bindings: ['event-1']
    });
    expect(fx.batches[0]?.[2]?.sql).toContain('DELETE FROM d1_operation_batch_guards');
  });

  test('replays the deterministic callback only for the owned guard marker', async () => {
    const fx = fixture([new Error('D1_ERROR: jooevents_d1_guard_conflict'), undefined]);
    let workCalls = 0;
    const result = await runD1BufferedUnitOfWork({
      database: fx.database,
      newBatchId: () => `batch-${workCalls}`,
      async work(unitOfWork) {
        workCalls += 1;
        unitOfWork.assertCurrent('1 = 1');
        unitOfWork.write('INSERT INTO operation_log (id) VALUES (?)', [`log-${workCalls}`]);
        return workCalls;
      }
    });
    expect(result).toBe(2);
    expect(workCalls).toBe(2);
    expect(fx.batches).toHaveLength(2);
  });

  test('bounds contention and preserves non-contention storage errors', async () => {
    const contention = fixture([
      new Error('jooevents_d1_guard_conflict'),
      new Error('jooevents_d1_guard_conflict')
    ]);
    await expect(runD1BufferedUnitOfWork({
      database: contention.database,
      maximumAttempts: 2,
      async work(unitOfWork) {
        unitOfWork.assertCurrent('1 = 1');
        unitOfWork.write('SELECT 1');
      }
    })).rejects.toBeInstanceOf(D1BufferedUnitOfWorkConflict);

    const unavailable = new Error('D1 unavailable');
    const failure = fixture([unavailable]);
    await expect(runD1BufferedUnitOfWork({
      database: failure.database,
      async work(unitOfWork) {
        unitOfWork.assertCurrent('1 = 1');
        unitOfWork.write('SELECT 1');
      }
    })).rejects.toBe(unavailable);
    expect(failure.batches).toHaveLength(1);
  });

  test('does not open a batch for reads and refuses unguarded writes', async () => {
    const readOnly = fixture();
    await expect(runD1BufferedUnitOfWork({
      database: readOnly.database,
      async work() { return 'read'; }
    })).resolves.toBe('read');
    expect(readOnly.batches).toHaveLength(0);

    const unguarded = fixture();
    await expect(runD1BufferedUnitOfWork({
      database: unguarded.database,
      async work(unitOfWork) { unitOfWork.write('SELECT 1'); }
    })).rejects.toThrow('d1_buffered_unit_of_work_requires_guard');
    expect(unguarded.batches).toHaveLength(0);
  });
});
