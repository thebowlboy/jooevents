import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { singleChunk } from './blob';
import { createFilesystemFileBlobStore } from './filesystem-blob-store';
import {
  DEFAULT_ORPHAN_GRACE_MS,
  sweepExpiredUploadIntents,
  sweepOrphanFileBlobs,
  type ExpiredIntentSweepPort,
  type FileOrphanSweepPort
} from './gc';
import { NOW, fixtureAsset, fixtureIntent } from './test-fixtures';

describe('orphan blob sweep (D7)', () => {
  test('defaults to the decided 7-day grace window', () => {
    expect(DEFAULT_ORPHAN_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('collects listed orphans record-first, tolerates already-missing blobs, and skips drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jooevents-files-gc-test-'));
    try {
      const blobs = createFilesystemFileBlobStore({ rootDirectory: root });
      const collectable = fixtureAsset();
      const regained = fixtureAsset();
      const foreign = fixtureAsset({ storageProvider: 's3' });
      await blobs.writeStream({
        key: collectable.storageKey,
        bytes: singleChunk(new Uint8Array([1])),
        maximumByteSize: 4
      });
      const deleted: string[] = [];
      const port: FileOrphanSweepPort = {
        listCollectableAssets: ({ asOf, graceMs, limit }) => {
          expect(asOf).toBe(NOW);
          expect(graceMs).toBe(DEFAULT_ORPHAN_GRACE_MS);
          expect(limit).toBe(100);
          return [collectable, regained, foreign];
        },
        deleteAssetRecord: ({ assetId }) => {
          if (assetId === regained.id) return false;
          deleted.push(assetId);
          return true;
        }
      };
      const report = await sweepOrphanFileBlobs({ port, blobs, now: NOW });
      expect(report.collected).toEqual([{
        assetId: collectable.id,
        storageKey: collectable.storageKey,
        blobDeleted: true
      }]);
      expect(report.skipped).toEqual([
        { assetId: regained.id, reason: 'record_changed' },
        { assetId: foreign.id, reason: 'wrong_provider' }
      ]);
      expect(deleted).toEqual([collectable.id]);
      expect(await blobs.openReadStream(collectable.storageKey)).toEqual({ kind: 'missing' });

      // Re-running with the same listing minus the deleted record is a no-op:
      // blob deletion of an absent object reports false, never throws.
      const rerun = await sweepOrphanFileBlobs({
        port: {
          listCollectableAssets: () => [collectable],
          deleteAssetRecord: () => true
        },
        blobs,
        now: NOW
      });
      expect(rerun.collected).toEqual([{
        assetId: collectable.id,
        storageKey: collectable.storageKey,
        blobDeleted: false
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses malformed grace or limit configuration loudly', async () => {
    const port: FileOrphanSweepPort = {
      listCollectableAssets: () => [],
      deleteAssetRecord: () => false
    };
    const blobs = {
      provider: 'filesystem',
      writeStream: () => { throw new Error('unused'); },
      openReadStream: () => { throw new Error('unused'); },
      deleteObject: async () => ({ deleted: false })
    } as never;
    await expect(sweepOrphanFileBlobs({ port, blobs, now: NOW, graceMs: 0 }))
      .rejects.toThrow('file_orphan_grace_invalid');
    await expect(sweepOrphanFileBlobs({ port, blobs, now: NOW, limit: 0 }))
      .rejects.toThrow('file_orphan_limit_invalid');
  });
});
describe('expired intent sweep (D4 integrity)', () => {
  test('discards expired intents, deletes only stored blobs, and skips drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jooevents-files-intent-gc-test-'));
    try {
      const blobs = createFilesystemFileBlobStore({ rootDirectory: root });
      const storedExpired = fixtureIntent({
        state: 'stored',
        storedByteSize: 1,
        storedSha256: 'a'.repeat(64)
      });
      const pendingExpired = fixtureIntent({ state: 'pending' });
      const drifted = fixtureIntent({ state: 'pending' });
      await blobs.writeStream({
        key: storedExpired.storageKey,
        bytes: singleChunk(new Uint8Array([1])),
        maximumByteSize: 4
      });
      const transitions: string[] = [];
      const port: ExpiredIntentSweepPort = {
        listExpiredOpenIntents: ({ asOf, limit }) => {
          expect(asOf).toBe(NOW);
          expect(limit).toBe(100);
          return [storedExpired, pendingExpired, drifted];
        },
        transitionIntent: ({ expected, next }) => {
          if (expected.id === drifted.id) throw new Error('stale_row');
          expect(next.state).toBe('discarded');
          transitions.push(expected.id);
        }
      };
      const report = await sweepExpiredUploadIntents({ port, blobs, now: NOW });
      expect(transitions).toEqual([storedExpired.id, pendingExpired.id]);
      expect(report.discarded).toEqual([
        { intentId: storedExpired.id, storageKey: storedExpired.storageKey, blobDeleted: true },
        { intentId: pendingExpired.id, storageKey: pendingExpired.storageKey, blobDeleted: false }
      ]);
      expect(report.skipped).toEqual([{ intentId: drifted.id, reason: 'record_changed' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

