import { describe, expect, test } from 'bun:test';
import {
  FileScanTransitionError,
  NONE_SCAN_PROVIDER,
  applyFileScanVerdict,
  ingestFileLifecycle,
  type FileScanProvider
} from './lifecycle';
import { fixtureAsset, NOW, LATER } from './test-fixtures';

const HOLD_PROVIDER: FileScanProvider = Object.freeze({
  id: 'clamav',
  evaluateOnIngest: () => Object.freeze({ kind: 'hold' as const })
});

const BLOCK_PROVIDER: FileScanProvider = Object.freeze({
  id: 'clamav',
  evaluateOnIngest: () => Object.freeze({ kind: 'block' as const, reason: 'eicar' })
});

describe('scan seam (D5)', () => {
  test("the default 'none' provider releases immediately with an honest record", () => {
    const ingest = ingestFileLifecycle({
      provider: NONE_SCAN_PROVIDER,
      assetId: 'asset', contentType: 'application/pdf', byteSize: 10,
      sha256: 'a'.repeat(64), at: NOW
    });
    expect(ingest).toEqual({
      lifecycle: 'available',
      scan: { provider: 'none', verdict: 'released', checkedAt: NOW }
    });
  });

  test('a holding provider parks the asset in pending_scan awaiting a verdict', () => {
    const ingest = ingestFileLifecycle({
      provider: HOLD_PROVIDER,
      assetId: 'asset', contentType: 'application/zip', byteSize: 10,
      sha256: 'a'.repeat(64), at: NOW
    });
    expect(ingest).toEqual({
      lifecycle: 'pending_scan',
      scan: { provider: 'clamav', verdict: 'pending', checkedAt: null }
    });
  });

  test('a blocking provider quarantines at ingest', () => {
    const ingest = ingestFileLifecycle({
      provider: BLOCK_PROVIDER,
      assetId: 'asset', contentType: 'application/zip', byteSize: 10,
      sha256: 'a'.repeat(64), at: NOW
    });
    expect(ingest.lifecycle).toBe('blocked');
    expect(ingest.scan.verdict).toBe('blocked');
  });

  test('the asynchronous verdict transition is closed: pending_scan to available or blocked only', () => {
    const pending = fixtureAsset({
      lifecycle: 'pending_scan',
      scan: { provider: 'clamav', verdict: 'pending', checkedAt: null }
    });
    const released = applyFileScanVerdict({ asset: pending, verdict: 'released', at: LATER });
    expect(released.lifecycle).toBe('available');
    expect(released.scan).toEqual({ provider: 'clamav', verdict: 'released', checkedAt: LATER });
    expect(released.version).toBe(pending.version + 1);

    const blocked = applyFileScanVerdict({ asset: pending, verdict: 'blocked', at: LATER });
    expect(blocked.lifecycle).toBe('blocked');

    expect(() => applyFileScanVerdict({ asset: released, verdict: 'blocked', at: LATER }))
      .toThrow(FileScanTransitionError);
    expect(() => applyFileScanVerdict({ asset: fixtureAsset(), verdict: 'released', at: LATER }))
      .toThrow(FileScanTransitionError);
  });

  test('a malformed provider decision refuses instead of guessing a state', () => {
    const broken = { id: 'broken', evaluateOnIngest: () => ({ kind: 'maybe' }) } as never;
    expect(() => ingestFileLifecycle({
      provider: broken,
      assetId: 'asset', contentType: 'application/pdf', byteSize: 10,
      sha256: 'a'.repeat(64), at: NOW
    })).toThrow('file_scan_decision_invalid');
  });
});
