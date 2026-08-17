import type { CanonicalJson } from '@jooevents/kernel';
import type { SyncAreaKey } from './mapping';

export interface ProjectionWorkClaim {
  readonly workId: string;
  readonly connectionId: string;
  readonly mappingRevision: number;
  readonly areaKey: SyncAreaKey;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly requestedProjectionVersion: number;
  readonly workerId: string;
  readonly leaseVersion: number;
}

export interface CurrentProjection {
  readonly projectionVersion: number;
  readonly fingerprint: string;
  readonly fields: Readonly<Record<string, CanonicalJson>>;
}

export type ProjectionWriteResult =
  | {
      readonly kind: 'applied';
      readonly providerRecordId: string;
      readonly providerFingerprint: string;
    }
  | {
      readonly kind: 'already_current';
      readonly providerRecordId: string;
      readonly providerFingerprint: string;
    }
  | {
      readonly kind: 'retry';
      readonly code: string;
      readonly retryAfterMs: number;
    }
  | {
      readonly kind: 'acceptance_unknown';
      readonly code: string;
    }
  | {
      readonly kind: 'attention';
      readonly code: string;
    };

export interface ProjectionWorkRepository {
  claimNext(input: {
    readonly connectionId: string;
    readonly workerId: string;
    readonly nowMs: number;
  }): Promise<ProjectionWorkClaim | undefined>;
  complete(input: {
    readonly claim: ProjectionWorkClaim;
    readonly outcome:
      | {
          readonly kind: 'succeeded';
          readonly providerRecordId: string;
          readonly providerFingerprint: string;
          readonly projection: CurrentProjection;
          readonly providerTableId?: string;
        }
      | { readonly kind: 'retry'; readonly code: string; readonly notBeforeMs: number }
      | { readonly kind: 'reconcile_first'; readonly code: string }
      | { readonly kind: 'attention'; readonly code: string };
    readonly nowMs: number;
  }): Promise<boolean>;
}

export interface CurrentProjectionReader {
  readCurrent(claim: ProjectionWorkClaim): Promise<CurrentProjection>;
}

export interface ExternalProjectionWriter {
  write(input: {
    readonly claim: ProjectionWorkClaim;
    readonly projection: CurrentProjection;
  }): Promise<ProjectionWriteResult>;
}

export type ProcessProjectionWorkResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'completed'; readonly workId: string }
  | { readonly kind: 'retry_scheduled'; readonly workId: string }
  | { readonly kind: 'reconciliation_required'; readonly workId: string }
  | { readonly kind: 'attention'; readonly workId: string }
  | { readonly kind: 'lost_fence'; readonly workId: string };

/**
 * The repository claim transaction finishes before current projection reads or
 * external provider I/O begins. Completion is a separate fenced transaction.
 */
export async function processOneProjectionWork(input: {
  readonly connectionId: string;
  readonly workerId: string;
  readonly nowMs: number;
  readonly repository: ProjectionWorkRepository;
  readonly projectionReader: CurrentProjectionReader;
  readonly writer: ExternalProjectionWriter;
}): Promise<ProcessProjectionWorkResult> {
  const claim = await input.repository.claimNext({
    connectionId: input.connectionId,
    workerId: input.workerId,
    nowMs: input.nowMs
  });
  if (!claim) return { kind: 'idle' };

  const projection = await input.projectionReader.readCurrent(claim);
  const written = await input.writer.write({ claim, projection });
  const outcome = written.kind === 'applied' || written.kind === 'already_current'
      ? {
          kind: 'succeeded' as const,
          providerRecordId: written.providerRecordId,
          providerFingerprint: written.providerFingerprint,
          projection
        }
    : written.kind === 'retry'
      ? {
          kind: 'retry' as const,
          code: written.code,
          notBeforeMs: input.nowMs + written.retryAfterMs
        }
      : written.kind === 'acceptance_unknown'
        ? { kind: 'reconcile_first' as const, code: written.code }
        : { kind: 'attention' as const, code: written.code };
  const completed = await input.repository.complete({
    claim,
    outcome,
    nowMs: input.nowMs
  });
  if (!completed) return { kind: 'lost_fence', workId: claim.workId };
  if (outcome.kind === 'succeeded') return { kind: 'completed', workId: claim.workId };
  if (outcome.kind === 'retry') return { kind: 'retry_scheduled', workId: claim.workId };
  if (outcome.kind === 'reconcile_first') {
    return { kind: 'reconciliation_required', workId: claim.workId };
  }
  return { kind: 'attention', workId: claim.workId };
}
