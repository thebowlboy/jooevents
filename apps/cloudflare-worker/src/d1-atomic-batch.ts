const D1_GUARD_CONFLICT_MARKER = 'jooevents_d1_guard_conflict';
const DEFAULT_MAXIMUM_ATTEMPTS = 3;

interface BufferedStatement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

export interface D1BufferedUnitOfWork {
  readonly readSession: D1DatabaseSession;
  assertCurrent(predicateSql: string, bindings?: readonly unknown[]): void;
  write(sql: string, bindings?: readonly unknown[]): void;
}

export class D1BufferedUnitOfWorkConflict extends Error {
  constructor(readonly attempts: number, options?: ErrorOptions) {
    super('d1_buffered_unit_of_work_contended', options);
    this.name = 'D1BufferedUnitOfWorkConflict';
  }
}

function assertStatementText(sql: string, label: string): string {
  const value = sql.trim();
  if (value.length === 0 || value.includes('\0')) throw new TypeError(`${label}_invalid`);
  return value;
}

function containsGuardConflict(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(candidate instanceof Error)) return false;
    if (candidate.message.includes(D1_GUARD_CONFLICT_MARKER)) return true;
    candidate = candidate.cause;
  }
  return false;
}

function prepared(
  session: D1DatabaseSession,
  statement: BufferedStatement
): D1PreparedStatement {
  return session.prepare(statement.sql).bind(...statement.bindings);
}

class BufferedUnitOfWork implements D1BufferedUnitOfWork {
  readonly #guards: BufferedStatement[] = [];
  readonly #writes: BufferedStatement[] = [];
  readonly #batchId: string;

  constructor(
    readonly readSession: D1DatabaseSession,
    batchId: string
  ) {
    this.#batchId = batchId;
  }

  assertCurrent(predicateSql: string, bindings: readonly unknown[] = []): void {
    this.#guards.push(Object.freeze({
      sql: assertStatementText(predicateSql, 'd1_guard_predicate'),
      bindings: Object.freeze([...bindings])
    }));
  }

  write(sql: string, bindings: readonly unknown[] = []): void {
    this.#writes.push(Object.freeze({
      sql: assertStatementText(sql, 'd1_buffered_statement'),
      bindings: Object.freeze([...bindings])
    }));
  }

  async commit(): Promise<void> {
    if (this.#writes.length === 0) return;
    if (this.#guards.length === 0) {
      throw new TypeError('d1_buffered_unit_of_work_requires_guard');
    }
    const statements: D1PreparedStatement[] = [];
    for (const [index, guard] of this.#guards.entries()) {
      statements.push(this.readSession.prepare(`
        INSERT INTO d1_operation_batch_guards (batch_id,guard_sequence,passed)
        SELECT ?,?,CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END
      `).bind(this.#batchId, index + 1, ...guard.bindings));
    }
    for (const write of this.#writes) statements.push(prepared(this.readSession, write));
    statements.push(this.readSession.prepare(
      'DELETE FROM d1_operation_batch_guards WHERE batch_id = ?'
    ).bind(this.#batchId));
    await this.readSession.batch(statements);
  }
}

function validMaximumAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new TypeError('d1_buffered_unit_of_work_maximum_attempts_invalid');
  }
  return value;
}

/**
 * Runs deterministic application work against a primary-consistent D1 session,
 * then commits its guarded buffered mutations in one D1 batch transaction.
 */
export async function runD1BufferedUnitOfWork<Value>(input: Readonly<{
  database: D1Database;
  work: (unitOfWork: D1BufferedUnitOfWork) => Promise<Value>;
  maximumAttempts?: number;
  newBatchId?: () => string;
}>): Promise<Value> {
  const maximumAttempts = validMaximumAttempts(
    input.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS
  );
  const newBatchId = input.newBatchId ?? (() => crypto.randomUUID());
  let lastConflict: unknown;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const session = input.database.withSession('first-primary');
    const unitOfWork = new BufferedUnitOfWork(session, newBatchId());
    const value = await input.work(unitOfWork);
    try {
      await unitOfWork.commit();
      return value;
    } catch (error) {
      if (!containsGuardConflict(error)) throw error;
      lastConflict = error;
    }
  }
  throw new D1BufferedUnitOfWorkConflict(maximumAttempts, { cause: lastConflict });
}
