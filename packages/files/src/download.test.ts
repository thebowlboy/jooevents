import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileAssetDto } from '@jooevents/contracts/files';
import { FILE_CONTENT_TYPES } from '@jooevents/contracts/files';
import { singleChunk } from './blob';
import { createFilesystemFileBlobStore } from './filesystem-blob-store';
import {
  contentDispositionAttachment,
  isServableFileContentType,
  openInertFileDownload
} from './download';
import { FIXTURE_SCOPE, fixtureAsset } from './test-fixtures';

async function drain(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of bytes) chunks.push(Uint8Array.from(chunk));
  return Buffer.concat(chunks);
}

describe('inert download source (L1)', () => {
  test('serves attachment-only headers with the recorded type and nosniff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jooevents-files-download-test-'));
    try {
      const blobs = createFilesystemFileBlobStore({ rootDirectory: root });
      const payload = new TextEncoder().encode('%PDF-1.7 pretend');
      const asset = fixtureAsset({
        displayFilename: 'Straße talk.pdf',
        byteSize: payload.byteLength
      });
      await blobs.writeStream({
        key: asset.storageKey, bytes: singleChunk(payload), maximumByteSize: payload.byteLength
      });
      const outcome = await openInertFileDownload({
        assets: { readAssetForDownload: async () => asset },
        blobs,
        scope: FIXTURE_SCOPE,
        assetId: asset.id
      });
      if (outcome.kind !== 'stream') throw new Error('expected stream');
      expect(outcome.byteSize).toBe(payload.byteLength);
      expect(outcome.headers.contentType).toBe('application/pdf');
      expect(outcome.headers.xContentTypeOptions).toBe('nosniff');
      expect(outcome.headers.contentDisposition.startsWith('attachment;')).toBe(true);
      expect(outcome.headers.contentDisposition).toContain("filename*=UTF-8''Stra%C3%9Fe%20talk.pdf");
      expect(Buffer.from(await drain(outcome.bytes)).equals(Buffer.from(payload))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CONFORMANCE: never yields text/html, image/svg+xml, or application/javascript regardless of the stored value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jooevents-files-download-test-'));
    try {
      const blobs = createFilesystemFileBlobStore({ rootDirectory: root });
      const hostile = [
        'text/html',
        'TEXT/HTML',
        'text/html; charset=utf-8',
        'image/svg+xml',
        'image/svg+xml;q=1',
        'application/javascript',
        'application/javascript ; charset=utf-8',
        'text/javascript',
        'application/xhtml+xml',
        'application/octet-stream',
        'video/mp4',
        ''
      ];
      for (const storedContentType of hostile) {
        // Simulate a corrupted or legacy record: the repository yields a raw
        // row whose stored content type bypassed every write-time gate.
        const asset = {
          ...fixtureAsset(),
          contentType: storedContentType
        } as unknown as FileAssetDto;
        const payload = new TextEncoder().encode('<script>alert(1)</script>');
        await blobs.writeStream({
          key: asset.storageKey, bytes: singleChunk(payload), maximumByteSize: payload.byteLength
        });
        const outcome = await openInertFileDownload({
          assets: { readAssetForDownload: () => asset },
          blobs,
          scope: FIXTURE_SCOPE,
          assetId: asset.id
        });
        expect(outcome).toEqual({ kind: 'refused', code: 'content_type_not_servable' });
      }
      // The closed list itself stays servable.
      for (const contentType of FILE_CONTENT_TYPES) {
        expect(isServableFileContentType(contentType)).toBe(true);
      }
      expect(isServableFileContentType('text/html')).toBe(false);
      expect(isServableFileContentType('image/svg+xml')).toBe(false);
      expect(isServableFileContentType('application/javascript')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocked assets and missing blobs refuse; unknown assets are not found', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jooevents-files-download-test-'));
    try {
      const blobs = createFilesystemFileBlobStore({ rootDirectory: root });
      const blocked = fixtureAsset({
        lifecycle: 'blocked',
        scan: { provider: 'clamav', verdict: 'blocked', checkedAt: '2026-08-15T10:00:00.000Z' }
      });
      expect(await openInertFileDownload({
        assets: { readAssetForDownload: () => blocked },
        blobs, scope: FIXTURE_SCOPE, assetId: blocked.id
      })).toEqual({ kind: 'refused', code: 'asset_blocked' });

      const dangling = fixtureAsset();
      expect(await openInertFileDownload({
        assets: { readAssetForDownload: () => dangling },
        blobs, scope: FIXTURE_SCOPE, assetId: dangling.id
      })).toEqual({ kind: 'refused', code: 'blob_missing' });

      expect(await openInertFileDownload({
        assets: { readAssetForDownload: () => undefined },
        blobs, scope: FIXTURE_SCOPE, assetId: dangling.id
      })).toEqual({ kind: 'not_found' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to stream an object whose retained size differs from its asset record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jooevents-files-download-test-'));
    try {
      const blobs = createFilesystemFileBlobStore({ rootDirectory: root });
      const asset = fixtureAsset({ byteSize: 2 });
      await blobs.writeStream({
        key: asset.storageKey,
        bytes: singleChunk(new TextEncoder().encode('abc')),
        maximumByteSize: 3
      });
      await expect(openInertFileDownload({
        assets: { readAssetForDownload: () => asset },
        blobs,
        scope: FIXTURE_SCOPE,
        assetId: asset.id
      })).rejects.toThrow('file_download_blob_size_mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('content disposition quotes hostile filenames safely', () => {
    const disposition = contentDispositionAttachment('a"b\\c.pdf');
    expect(disposition).toBe(
      `attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`
    );
  });
});
