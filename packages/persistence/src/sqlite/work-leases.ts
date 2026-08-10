import type { Database } from 'bun:sqlite';

export type DurableWorkTable = 'outbox_events' | 'avatar_import_jobs';

export interface LeasedWork {
  readonly id: string;
  readonly attempts: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
}

/** The database row remains the source of truth; a queue only wakes this claimant. */
export function claimDueWork(input: {
  readonly sqlite: Database;
  readonly table: DurableWorkTable;
  readonly owner: string;
  readonly now: string;
  readonly leaseSeconds: number;
  readonly limit: number;
}): readonly LeasedWork[] {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('lease limit must be between 1 and 100');
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 3600) throw new Error('lease duration must be between 5 and 3600 seconds');
  const nowMs = Date.parse(input.now);
  const expiresMs = nowMs + input.leaseSeconds * 1000;
  return input.sqlite.transaction(() => {
    const candidates = input.sqlite.query<{ id: string }, [number, number]>(`
      select id from ${input.table}
       where ((status in ('pending', 'failed') and next_attempt_at <= ?)
          or (status = 'running' and lease_expires_at <= ?))
       order by next_attempt_at, id limit ${input.limit}
    `).all(nowMs, nowMs);
    const leased: LeasedWork[] = [];
    for (const candidate of candidates) {
      const result = input.sqlite.query(`update ${input.table}
        set status = 'running', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
        where id = ? and ((status in ('pending', 'failed') and next_attempt_at <= ?)
          or (status = 'running' and lease_expires_at <= ?))`)
        .run(input.owner, expiresMs, nowMs, candidate.id, nowMs, nowMs);
      if (result.changes === 1) {
        const row = input.sqlite.query<{ attempts: number }, [string]>(`select attempts from ${input.table} where id = ?`).get(candidate.id);
        leased.push({ id: candidate.id, attempts: row?.attempts ?? 1, leaseOwner: input.owner, leaseExpiresAt: new Date(expiresMs).toISOString() });
      }
    }
    return leased;
  })();
}

export function finishLeasedWork(input: {
  readonly sqlite: Database;
  readonly table: DurableWorkTable;
  readonly id: string;
  readonly owner: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly now: string;
  readonly nextAttemptAt?: string;
  readonly errorCode?: string;
}): boolean {
  if (input.outcome === 'failed' && !input.nextAttemptAt) throw new Error('failed work requires a next attempt time');
  const result = input.sqlite.query(`update ${input.table}
    set status = ?, next_attempt_at = ?, last_error_code = ?, lease_owner = null, lease_expires_at = null, updated_at = ?
    where id = ? and status = 'running' and lease_owner = ?`)
    .run(input.outcome, Date.parse(input.nextAttemptAt ?? input.now), input.errorCode ?? null, Date.parse(input.now), input.id, input.owner);
  return result.changes === 1;
}
