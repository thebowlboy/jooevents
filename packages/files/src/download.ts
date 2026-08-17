import {
  INERT_DOWNLOAD_FORBIDDEN_CONTENT_TYPES,
  type FileAssetDto,
  type FileScopeDto
} from '@jooevents/contracts/files';
import type { FileBlobStreamingStore } from './blob';
import { deepFreeze, isAllowedFileContentType } from './model';

/**
 * The L1 structural-inertness serving contract. A transport mounting the
 * download route serves exactly these headers and never invents its own:
 * attachment disposition, nosniff, and a content type copied from OUR asset
 * record — never sniffed from bytes, never taken from the request.
 */
export interface InertDownloadHeaders {
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly xContentTypeOptions: 'nosniff';
}

export type InertDownloadOutcome =
  | {
      readonly kind: 'stream';
      readonly bytes: AsyncIterable<Uint8Array>;
      readonly byteSize: number;
      readonly headers: InertDownloadHeaders;
    }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'refused';
      readonly code: 'asset_blocked' | 'content_type_not_servable' | 'blob_missing';
    };

export interface FileDownloadAssetSource {
  readAssetForDownload(
    scope: FileScopeDto,
    assetId: string
  ): FileAssetDto | undefined | Promise<FileAssetDto | undefined>;
}

const FORBIDDEN = new Set<string>(INERT_DOWNLOAD_FORBIDDEN_CONTENT_TYPES);

/**
 * Serve-time gate on the *stored* content-type string. Membership in the
 * closed allowlist is required and the forbidden actives are refused
 * explicitly, so a corrupted or legacy record can never turn the download
 * route into an HTML/SVG/JS origin.
 */
export function isServableFileContentType(storedContentType: string): boolean {
  if (typeof storedContentType !== 'string') return false;
  const essence = storedContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (FORBIDDEN.has(essence)) return false;
  if (essence !== storedContentType) return false;
  return isAllowedFileContentType(essence);
}

/** RFC 6266/5987 attachment disposition with an ASCII fallback and UTF-8 form. */
export function contentDispositionAttachment(displayFilename: string): string {
  const ascii = displayFilename
    .replace(/[^ -~]/gu, '_')
    .replaceAll('\\', '_')
    .replaceAll('"', '_');
  const encoded = encodeRfc5987(displayFilename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function encodeRfc5987(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9!#$&+.^_`|~-]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/**
 * The inert download source. Yields the byte stream plus the exact headers the
 * transport must serve. Regardless of any stored value it never yields
 * text/html, image/svg+xml, or application/javascript, and it never sniffs.
 */
export async function openInertFileDownload(input: {
  readonly assets: FileDownloadAssetSource;
  readonly blobs: Pick<FileBlobStreamingStore, 'provider' | 'openReadStream'>;
  readonly scope: FileScopeDto;
  readonly assetId: string;
}): Promise<InertDownloadOutcome> {
  const asset = await input.assets.readAssetForDownload(input.scope, input.assetId);
  if (!asset) return deepFreeze({ kind: 'not_found' });
  if (asset.lifecycle === 'blocked') {
    return deepFreeze({ kind: 'refused', code: 'asset_blocked' });
  }
  if (!isServableFileContentType(asset.contentType)) {
    return deepFreeze({ kind: 'refused', code: 'content_type_not_servable' });
  }
  if (asset.storageProvider !== input.blobs.provider) {
    throw new TypeError('file_download_storage_provider_mismatch');
  }
  const read = await input.blobs.openReadStream(asset.storageKey);
  if (read.kind === 'missing') {
    return deepFreeze({ kind: 'refused', code: 'blob_missing' });
  }
  if (read.byteSize !== asset.byteSize) {
    throw new TypeError('file_download_blob_size_mismatch');
  }
  return Object.freeze({
    kind: 'stream' as const,
    bytes: read.bytes,
    byteSize: read.byteSize,
    headers: deepFreeze({
      contentType: asset.contentType,
      contentDisposition: contentDispositionAttachment(asset.displayFilename),
      xContentTypeOptions: 'nosniff' as const
    })
  });
}
