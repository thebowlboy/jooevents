import type {
  FileAssetDto,
  FileLifecycleState,
  FileScanStateDto
} from '@jooevents/contracts/files';
import { deepFreeze, parseFileAsset } from './model';

/**
 * The D5 scan seam. A provider decides what happens to freshly ingested bytes;
 * structural inertness (attachment-only serving, nosniff, the closed type
 * list) applies in every state and is not this seam's job. Providers are
 * per-installation configuration — swapping one is a config change, never a
 * schema change.
 */
export interface FileScanProvider {
  /** Stable configuration identity, e.g. 'none' or 'clamav'. */
  readonly id: string;
  /**
   * Ingest-time decision for one stored blob. `release` publishes immediately,
   * `hold` parks the asset in `pending_scan` for an asynchronous verdict, and
   * `block` quarantines it. A provider needing asynchronous work returns
   * `hold` here and later applies `applyFileScanVerdict` from its worker.
   */
  evaluateOnIngest(input: {
    readonly assetId: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly sha256: string;
  }): FileScanIngestDecision;
}

export type FileScanIngestDecision =
  | { readonly kind: 'release' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'block'; readonly reason: string };

/** D5 default: no scanner configured, release immediately; serving stays inert. */
export const NONE_SCAN_PROVIDER: FileScanProvider = Object.freeze({
  id: 'none',
  evaluateOnIngest: () => Object.freeze({ kind: 'release' as const })
});

export interface IngestLifecycle {
  readonly lifecycle: FileLifecycleState;
  readonly scan: FileScanStateDto;
}

/** Maps a provider's ingest decision to the initial lifecycle + scan record pair. */
export function ingestFileLifecycle(input: {
  readonly provider: FileScanProvider;
  readonly assetId: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly at: string;
}): IngestLifecycle {
  if (typeof input.provider.id !== 'string' || input.provider.id.length === 0
      || input.provider.id.length > 64) {
    throw new TypeError('file_scan_provider_invalid');
  }
  const decision = input.provider.evaluateOnIngest({
    assetId: input.assetId,
    contentType: input.contentType,
    byteSize: input.byteSize,
    sha256: input.sha256
  });
  switch (decision.kind) {
    case 'release':
      return deepFreeze({
        lifecycle: 'available',
        scan: { provider: input.provider.id, verdict: 'released', checkedAt: input.at }
      });
    case 'hold':
      return deepFreeze({
        lifecycle: 'pending_scan',
        scan: { provider: input.provider.id, verdict: 'pending', checkedAt: null }
      });
    case 'block':
      return deepFreeze({
        lifecycle: 'blocked',
        scan: { provider: input.provider.id, verdict: 'blocked', checkedAt: input.at }
      });
    default:
      throw new TypeError('file_scan_decision_invalid');
  }
}

export type FileScanTransitionErrorCode =
  | 'asset_not_pending_scan'
  | 'invalid_scan_verdict';

export class FileScanTransitionError extends TypeError {
  constructor(readonly code: FileScanTransitionErrorCode) {
    super(code);
    this.name = 'FileScanTransitionError';
  }
}

/**
 * The closed asynchronous verdict transition: `pending_scan → available | blocked`.
 * Every other transition refuses — a released or blocked asset never silently
 * re-enters scanning, and a verdict never applies twice.
 */
export function applyFileScanVerdict(input: {
  readonly asset: FileAssetDto;
  readonly verdict: 'released' | 'blocked';
  readonly at: string;
}): FileAssetDto {
  const asset = parseFileAsset(input.asset);
  if (asset.lifecycle !== 'pending_scan' || asset.scan.verdict !== 'pending') {
    throw new FileScanTransitionError('asset_not_pending_scan');
  }
  if (input.verdict !== 'released' && input.verdict !== 'blocked') {
    throw new FileScanTransitionError('invalid_scan_verdict');
  }
  return parseFileAsset({
    ...asset,
    lifecycle: input.verdict === 'released' ? 'available' : 'blocked',
    scan: { provider: asset.scan.provider, verdict: input.verdict, checkedAt: input.at },
    version: asset.version + 1,
    updatedAt: input.at
  });
}
