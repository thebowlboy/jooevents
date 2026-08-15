import type { FileAssetDto, FileUploadIntentDto } from '@jooevents/contracts/files';
import { parseFileUploadIntent } from './model';
import type { FileBlobStreamingStore } from './blob';
import { deepFreeze } from './model';

export const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The D7 orphan-collection port. The adapter answers, inside its own
 * transaction, which assets currently have zero live (`attached`) attachment
 * references, no pending fulfilment via a live upload intent, and have been
 * orphaned for longer than the grace window. The sweep never re-derives the
 * refcount itself — reverts must always find the bytes still present until the
 * window closes.
 */
export interface FileOrphanSweepPort {
  listCollectableAssets(input: {
    readonly asOf: string;
    readonly graceMs: number;
    readonly limit: number;
  }): readonly FileAssetDto[];
  /**
   * Deletes the asset record only when its version still matches. Returns
   * false when the asset changed (for example, regained an attachment) since
   * listing; the sweep then leaves its blob alone.
   */
  deleteAssetRecord(input: { readonly assetId: string; readonly expectedVersion: number }): boolean;
}

export interface OrphanSweepReport {
  readonly collected: readonly {
    readonly assetId: string;
    readonly storageKey: string;
    readonly blobDeleted: boolean;
  }[];
  readonly skipped: readonly {
    readonly assetId: string;
    readonly reason: 'record_changed' | 'wrong_provider';
  }[];
}

/**
 * The D7 sweep: a plain function invoked by whatever schedule the runtime
 * owner wires (job, cron, operator action) — deliberately not a timer. It is
 * idempotent: a crashed run leaves either the record (retried next run) or a
 * deleted record whose blob deletion is retried harmlessly (`deleted: false`).
 * The record is deleted before the blob so a crash can strand a blob (cleaned
 * on the next pass over storage) but never a record pointing at nothing.
 */
export async function sweepOrphanFileBlobs(input: {
  readonly port: FileOrphanSweepPort;
  readonly blobs: FileBlobStreamingStore;
  readonly now: string;
  readonly graceMs?: number;
  readonly limit?: number;
}): Promise<OrphanSweepReport> {
  const graceMs = input.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0) {
    throw new TypeError('file_orphan_grace_invalid');
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError('file_orphan_limit_invalid');
  }
  const candidates = input.port.listCollectableAssets({
    asOf: input.now,
    graceMs,
    limit
  });
  const collected: { assetId: string; storageKey: string; blobDeleted: boolean }[] = [];
  const skipped: { assetId: string; reason: 'record_changed' | 'wrong_provider' }[] = [];
  for (const asset of candidates) {
    if (asset.storageProvider !== input.blobs.provider) {
      skipped.push({ assetId: asset.id, reason: 'wrong_provider' });
      continue;
    }
    const deleted = input.port.deleteAssetRecord({
      assetId: asset.id,
      expectedVersion: asset.version
    });
    if (!deleted) {
      skipped.push({ assetId: asset.id, reason: 'record_changed' });
      continue;
    }
    const blob = await input.blobs.deleteObject(asset.storageKey);
    collected.push({
      assetId: asset.id,
      storageKey: asset.storageKey,
      blobDeleted: blob.deleted
    });
  }
  return deepFreeze({ collected, skipped });
}

export interface ExpiredIntentSweepPort {
  listExpiredOpenIntents(input: {
    readonly asOf: string;
    readonly limit: number;
  }): readonly FileUploadIntentDto[];
  transitionIntent(input: {
    readonly expected: FileUploadIntentDto;
    readonly next: FileUploadIntentDto;
  }): void;
}

export interface ExpiredIntentSweepReport {
  readonly discarded: readonly {
    readonly intentId: string;
    readonly storageKey: string;
    readonly blobDeleted: boolean;
  }[];
  readonly skipped: readonly {
    readonly intentId: string;
    readonly reason: 'record_changed' | 'wrong_provider';
  }[];
}

/**
 * Reclaims expired, never-confirmed upload intents: without this, a client
 * that registers and streams but never confirms strands a per-file-cap blob
 * on disk forever, invisible to the quota's confirmed-asset sum. The record
 * transitions to `discarded` before the blob is deleted, so a crash strands
 * at most a blob (retried next pass), never a live record pointing at
 * nothing. Same posture as the orphan sweep: a plain function on whatever
 * schedule the runtime owner wires — deliberately not a timer.
 */
export async function sweepExpiredUploadIntents(input: {
  readonly port: ExpiredIntentSweepPort;
  readonly blobs: FileBlobStreamingStore;
  readonly now: string;
  readonly limit?: number;
}): Promise<ExpiredIntentSweepReport> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError('file_intent_sweep_limit_invalid');
  }
  const discarded: { intentId: string; storageKey: string; blobDeleted: boolean }[] = [];
  const skipped: { intentId: string; reason: 'record_changed' | 'wrong_provider' }[] = [];
  for (const intent of input.port.listExpiredOpenIntents({ asOf: input.now, limit })) {
    if (intent.storageProvider !== input.blobs.provider) {
      skipped.push({ intentId: intent.id, reason: 'wrong_provider' });
      continue;
    }
    try {
      input.port.transitionIntent({
        expected: intent,
        next: parseFileUploadIntent({ ...intent, state: 'discarded' })
      });
    } catch {
      skipped.push({ intentId: intent.id, reason: 'record_changed' });
      continue;
    }
    const hadBlob = intent.state === 'stored';
    const blob = hadBlob
      ? await input.blobs.deleteObject(intent.storageKey)
      : { deleted: false };
    discarded.push({
      intentId: intent.id,
      storageKey: intent.storageKey,
      blobDeleted: blob.deleted
    });
  }
  return deepFreeze({ discarded, skipped });
}
