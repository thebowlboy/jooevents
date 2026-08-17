import { describe, expect, test } from 'bun:test';
import {
  processOneProjectionWork,
  type ProjectionWorkClaim,
  type ProjectionWorkRepository
} from './processor';

const claim: ProjectionWorkClaim = {
  workId: 'work-1',
  connectionId: 'connection-1',
  mappingRevision: 2,
  areaKey: 'tasks',
  subjectKind: 'task',
  subjectId: 'task-1',
  requestedProjectionVersion: 4,
  workerId: 'worker-1',
  leaseVersion: 3
};

describe('projection work processor', () => {
  test('external I/O starts only after the claim transaction and completes in a later fence', async () => {
    const sequence: string[] = [];
    let transactionActive = false;
    const repository: ProjectionWorkRepository = {
      async claimNext() {
        transactionActive = true;
        sequence.push('claim:begin', 'claim:commit');
        transactionActive = false;
        return claim;
      },
      async complete(input) {
        transactionActive = true;
        sequence.push(`complete:${input.outcome.kind}`, 'complete:commit');
        transactionActive = false;
        return true;
      }
    };
    const result = await processOneProjectionWork({
      connectionId: claim.connectionId,
      workerId: claim.workerId,
      nowMs: 1_000,
      repository,
      projectionReader: {
        async readCurrent() {
          expect(transactionActive).toBe(false);
          sequence.push('projection:read');
          return { projectionVersion: 4, fingerprint: 'local-4', fields: { status: 'Done' } };
        }
      },
      writer: {
        async write() {
          expect(transactionActive).toBe(false);
          sequence.push('provider:write');
          return {
            kind: 'applied',
            providerRecordId: 'rec-1',
            providerFingerprint: 'remote-4'
          };
        }
      }
    });
    expect(result).toEqual({ kind: 'completed', workId: 'work-1' });
    expect(sequence).toEqual([
      'claim:begin',
      'claim:commit',
      'projection:read',
      'provider:write',
      'complete:succeeded',
      'complete:commit'
    ]);
  });

  test('acceptance unknown schedules reconciliation before any repeat write', async () => {
    let completion: string | undefined;
    const result = await processOneProjectionWork({
      connectionId: claim.connectionId,
      workerId: claim.workerId,
      nowMs: 1_000,
      repository: {
        async claimNext() {
          return claim;
        },
        async complete(input) {
          completion = input.outcome.kind;
          return true;
        }
      },
      projectionReader: {
        async readCurrent() {
          return { projectionVersion: 4, fingerprint: 'local-4', fields: {} };
        }
      },
      writer: {
        async write() {
          return { kind: 'acceptance_unknown', code: 'timeout_after_write' };
        }
      }
    });
    expect(result).toEqual({ kind: 'reconciliation_required', workId: 'work-1' });
    expect(completion).toBe('reconcile_first');
  });

  test('a stale completion fence never reports provider work completed', async () => {
    const result = await processOneProjectionWork({
      connectionId: claim.connectionId,
      workerId: claim.workerId,
      nowMs: 1_000,
      repository: {
        async claimNext() {
          return claim;
        },
        async complete() {
          return false;
        }
      },
      projectionReader: {
        async readCurrent() {
          return { projectionVersion: 4, fingerprint: 'local-4', fields: {} };
        }
      },
      writer: {
        async write() {
          return {
            kind: 'already_current',
            providerRecordId: 'rec-1',
            providerFingerprint: 'remote-4'
          };
        }
      }
    });
    expect(result).toEqual({ kind: 'lost_fence', workId: 'work-1' });
  });
});
