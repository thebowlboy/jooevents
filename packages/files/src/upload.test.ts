import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  FileAssetDto,
  FileScopeDto,
  FileUploadIntentDto,
  FileUploaderPrincipalDto
} from '@jooevents/contracts/files';
import { createFilesystemFileBlobStore } from './filesystem-blob-store';
import type { FileImageReEncoder } from './image-ingest';
import { NONE_SCAN_PROVIDER } from './lifecycle';
import { DEFAULT_FILE_UPLOAD_LIMITS } from './limits';
import {
  confirmFileUpload,
  discardFileUploadIntent,
  registerFileUploadIntent,
  streamFileUploadBytes,
  type FileAssetWritePort,
  type FileUploadIntentRepository,
  type FileUploaderUsageSource
} from './upload';
import { FIXTURE_SCOPE, NOW, SPEAKER, chunked, fixtureId } from './test-fixtures';

class MemoryIntents implements FileUploadIntentRepository {
  private readonly rows = new Map<string, FileUploadIntentDto>();
  /** The stored intents, for tests that model a reservation-aware usage sum. */
  all(): readonly FileUploadIntentDto[] {
    return [...this.rows.values()];
  }
  readIntent(scope: FileScopeDto, intentId: string): FileUploadIntentDto | undefined {
    const row = this.rows.get(intentId);
    return row && row.scope.eventId === scope.eventId ? row : undefined;
  }
  createIntent(intent: FileUploadIntentDto): void {
    if (this.rows.has(intent.id)) throw new Error('duplicate_intent');
    this.rows.set(intent.id, intent);
  }
  transitionIntent(input: {
    readonly expected: FileUploadIntentDto;
    readonly next: FileUploadIntentDto;
  }): void {
    const current = this.rows.get(input.expected.id);
    if (!current || current.state !== input.expected.state) throw new Error('intent_drift');
    this.rows.set(input.next.id, input.next);
  }
}

class MemoryAssets implements FileAssetWritePort {
  readonly rows = new Map<string, FileAssetDto>();
  readAsset(scope: FileScopeDto, assetId: string): FileAssetDto | undefined {
    const row = this.rows.get(assetId);
    return row && row.scope.eventId === scope.eventId ? row : undefined;
  }
  createAsset(asset: FileAssetDto): void {
    if (this.rows.has(asset.id)) throw new Error('duplicate_asset');
    this.rows.set(asset.id, asset);
  }
}

const noUsage: FileUploaderUsageSource = { readUploaderStoredBytes: () => 0 };

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'jooevents-files-upload-test-'));
  const blobs = createFilesystemFileBlobStore({ rootDirectory: root });
  return {
    root,
    blobs,
    intents: new MemoryIntents(),
    assets: new MemoryAssets(),
    dispose: () => rmSync(root, { recursive: true, force: true })
  };
}

function register(input: {
  readonly intents: FileUploadIntentRepository;
  readonly intentId?: string;
  readonly contentType?: 'application/pdf' | 'image/png';
  readonly declaredByteSize?: number;
  readonly uploader?: FileUploaderPrincipalDto;
  readonly usage?: FileUploaderUsageSource;
}) {
  return registerFileUploadIntent({
    scope: FIXTURE_SCOPE,
    uploader: input.uploader ?? SPEAKER,
    registration: {
      intentId: input.intentId ?? fixtureId(),
      purpose: 'engagement_material',
      displayFilename: 'deck.pdf',
      contentType: input.contentType ?? 'application/pdf',
      declaredByteSize: input.declaredByteSize ?? 1024
    },
    limits: DEFAULT_FILE_UPLOAD_LIMITS,
    usage: input.usage ?? noUsage,
    intents: input.intents,
    storageProvider: 'filesystem',
    now: NOW
  });
}

describe('two-phase upload engine (D2)', () => {
  test('register applies caps and the type gate, and is idempotent by intent id', () => {
    const { intents, dispose } = harness();
    try {
      const intentId = fixtureId();
      const first = register({ intents, intentId });
      if (first.kind !== 'registered') throw new Error('expected registration');
      expect(first.intent.state).toBe('pending');
      expect(first.intent.maximumByteSize).toBe(DEFAULT_FILE_UPLOAD_LIMITS.maxUploadBytesSpeaker);
      expect(first.intent.storageKey).toBe(
        `files/${FIXTURE_SCOPE.workspaceId}/${FIXTURE_SCOPE.eventId}/${intentId}`
      );
      const replay = register({ intents, intentId });
      expect(replay).toEqual({ kind: 'registered', intent: first.intent, idempotent: true });
      const collision = register({ intents, intentId, declaredByteSize: 2048 });
      expect(collision).toEqual({ kind: 'refused', code: 'intent_id_collision' });
      const refused = register({ intents, contentType: 'application/pdf', declaredByteSize: DEFAULT_FILE_UPLOAD_LIMITS.maxUploadBytesSpeaker + 1 });
      expect(refused).toEqual({ kind: 'refused', code: 'file_too_large' });
    } finally {
      dispose();
    }
  });

  test('streams bytes with inline hashing, then confirm requires the exact hash', async () => {
    const { intents, assets, blobs, dispose } = harness();
    try {
      const registration = register({ intents });
      if (registration.kind !== 'registered') throw new Error('expected registration');
      const payload = new TextEncoder().encode('the deck bytes');
      const streamed = await streamFileUploadBytes({
        intents, intent: registration.intent, bytes: chunked(payload), blobs, now: NOW
      });
      if (streamed.kind !== 'stored') throw new Error('expected stored');
      const expectedSha = createHash('sha256').update(payload).digest('hex');
      expect(streamed.intent.storedSha256).toBe(expectedSha);
      expect(streamed.intent.storedByteSize).toBe(payload.byteLength);

      const wrongHash = confirmFileUpload({
        intents, assets, scanProvider: NONE_SCAN_PROVIDER,
        intent: streamed.intent,
        confirmation: { intentId: streamed.intent.id, assetId: fixtureId(), sha256: 'b'.repeat(64) },
        now: NOW
      });
      expect(wrongHash).toEqual({ kind: 'refused', code: 'hash_mismatch' });

      const assetId = fixtureId();
      const confirmed = confirmFileUpload({
        intents, assets, scanProvider: NONE_SCAN_PROVIDER,
        intent: streamed.intent,
        confirmation: { intentId: streamed.intent.id, assetId, sha256: expectedSha },
        now: NOW
      });
      if (confirmed.kind !== 'confirmed') throw new Error('expected confirmation');
      expect(confirmed.asset).toMatchObject({
        id: assetId,
        byteSize: payload.byteLength,
        sha256: expectedSha,
        lifecycle: 'available',
        scan: { provider: 'none', verdict: 'released', checkedAt: NOW },
        version: 1
      });
      expect(confirmed.facts).toEqual([{
        kind: 'file_asset_changed',
        version: 1,
        payload: { action: 'confirm', assetId, lifecycle: 'available', version: 1 }
      }]);

      const replay = confirmFileUpload({
        intents, assets, scanProvider: NONE_SCAN_PROVIDER,
        intent: confirmed.intent,
        confirmation: { intentId: confirmed.intent.id, assetId, sha256: expectedSha },
        now: NOW
      });
      if (replay.kind !== 'confirmed') throw new Error('expected idempotent confirmation');
      expect(replay.idempotent).toBe(true);
      expect(replay.asset).toEqual(confirmed.asset);
    } finally {
      dispose();
    }
  });

  test('the hard cap refuses mid-stream and streaming twice refuses', async () => {
    const { intents, blobs, dispose } = harness();
    try {
      const registration = register({ intents, declaredByteSize: 8 });
      if (registration.kind !== 'registered') throw new Error('expected registration');
      const capped = {
        ...registration.intent,
        maximumByteSize: 8
      } as FileUploadIntentDto;
      const over = await streamFileUploadBytes({
        intents, intent: capped, bytes: chunked(new Uint8Array(9)), blobs, now: NOW
      });
      expect(over).toEqual({ kind: 'refused', code: 'byte_cap_exceeded' });

      const stored = await streamFileUploadBytes({
        intents, intent: capped, bytes: chunked(new Uint8Array(8).fill(1)), blobs, now: NOW
      });
      if (stored.kind !== 'stored') throw new Error('expected stored');
      const again = await streamFileUploadBytes({
        intents, intent: stored.intent, bytes: chunked(new Uint8Array(8)), blobs, now: NOW
      });
      expect(again).toEqual({ kind: 'refused', code: 'intent_not_pending' });
    } finally {
      dispose();
    }
  });

  test('an expired intent is discarded, never silently streamed', async () => {
    const { intents, blobs, dispose } = harness();
    try {
      const registration = register({ intents });
      if (registration.kind !== 'registered') throw new Error('expected registration');
      const afterExpiry = new Date(
        Date.parse(registration.intent.expiresAt) + 1000
      ).toISOString();
      const expired = await streamFileUploadBytes({
        intents, intent: registration.intent,
        bytes: chunked(new Uint8Array([1])), blobs, now: afterExpiry
      });
      expect(expired).toEqual({ kind: 'refused', code: 'intent_expired' });
      expect(intents.readIntent(FIXTURE_SCOPE, registration.intent.id)?.state).toBe('discarded');
    } finally {
      dispose();
    }
  });

  test('image ingest refuses without an encoder and re-encodes with one (D3)', async () => {
    const { intents, blobs, dispose } = harness();
    try {
      const first = register({ intents, contentType: 'image/png' });
      if (first.kind !== 'registered') throw new Error('expected registration');
      const bytes = new TextEncoder().encode('png-shaped payload');
      const refused = await streamFileUploadBytes({
        intents, intent: first.intent, bytes: chunked(bytes), blobs, now: NOW
      });
      expect(refused).toEqual({ kind: 'refused', code: 'image_reencoder_unavailable' });

      const reencoded = new TextEncoder().encode('clean re-encoded pixels');
      const encoder: FileImageReEncoder = {
        id: 'test-encoder',
        reencode: async ({ contentType }) => ({
          kind: 'reencoded', contentType, bytes: reencoded
        })
      };
      const second = register({ intents, contentType: 'image/png' });
      if (second.kind !== 'registered') throw new Error('expected registration');
      const stored = await streamFileUploadBytes({
        intents, intent: second.intent, bytes: chunked(bytes), blobs,
        imageReEncoder: encoder, now: NOW
      });
      if (stored.kind !== 'stored') throw new Error('expected stored');
      // The stored digest is of the RE-ENCODED bytes, never the wire bytes.
      expect(stored.intent.storedSha256)
        .toBe(createHash('sha256').update(reencoded).digest('hex'));
      expect(stored.intent.storedByteSize).toBe(reencoded.byteLength);

      const failing: FileImageReEncoder = {
        id: 'test-encoder',
        reencode: async () => ({ kind: 'decode_failed' })
      };
      const third = register({ intents, contentType: 'image/png' });
      if (third.kind !== 'registered') throw new Error('expected registration');
      const decodeFailed = await streamFileUploadBytes({
        intents, intent: third.intent, bytes: chunked(bytes), blobs,
        imageReEncoder: failing, now: NOW
      });
      expect(decodeFailed).toEqual({ kind: 'refused', code: 'image_decode_failed' });
      expect(await blobs.openReadStream(third.intent.storageKey)).toEqual({ kind: 'missing' });
    } finally {
      dispose();
    }
  });

  test('discard is the compensation: bytes removed, terminal states protected', async () => {
    const { intents, blobs, dispose } = harness();
    try {
      const registration = register({ intents });
      if (registration.kind !== 'registered') throw new Error('expected registration');
      const stored = await streamFileUploadBytes({
        intents, intent: registration.intent,
        bytes: chunked(new Uint8Array([1, 2, 3])), blobs, now: NOW
      });
      if (stored.kind !== 'stored') throw new Error('expected stored');
      const discarded = await discardFileUploadIntent({
        intents, blobs, intent: stored.intent
      });
      if (discarded.kind !== 'discarded') throw new Error('expected discard');
      expect(discarded.blobDeleted).toBe(true);
      expect(await blobs.openReadStream(stored.intent.storageKey)).toEqual({ kind: 'missing' });
      expect(await discardFileUploadIntent({ intents, blobs, intent: discarded.intent }))
        .toEqual({ kind: 'refused', code: 'intent_already_terminal' });
    } finally {
      dispose();
    }
  });
});
describe('quota reservations bind at registration (D4 integrity)', () => {
  test('open intents reserve their declared bytes against the speaker quota', () => {
    const { intents, dispose } = harness();
    try {
      // A reservation-aware usage source, shaped like the persistence sum:
      // confirmed assets plus open unexpired intents at max(declared, stored).
      const usage: FileUploaderUsageSource = {
        readUploaderStoredBytes: (scope, uploader, asOf) => {
          let total = 0;
          for (const intent of intents.all()) {
            if (intent.scope.eventId !== scope.eventId) continue;
            if (intent.uploader.kind !== uploader.kind) continue;
            if ((intent.state === 'pending' || intent.state === 'stored')
                && Date.parse(intent.expiresAt) > Date.parse(asOf)) {
              total += Math.max(intent.declaredByteSize, intent.storedByteSize ?? 0);
            }
          }
          return total;
        }
      };
      const quota = DEFAULT_FILE_UPLOAD_LIMITS.maxTotalBytesPerSpeakerPerEvent;
      const first = register({
        intents, usage, declaredByteSize: DEFAULT_FILE_UPLOAD_LIMITS.maxUploadBytesSpeaker
      });
      expect(first.kind).toBe('registered');
      // More full-cap intents reserve until the quota is exactly filled…
      for (let index = 0; index < 9; index += 1) {
        expect(register({
          intents, usage, declaredByteSize: DEFAULT_FILE_UPLOAD_LIMITS.maxUploadBytesSpeaker
        }).kind).toBe('registered');
      }
      const headroom = quota - 10 * DEFAULT_FILE_UPLOAD_LIMITS.maxUploadBytesSpeaker;
      expect(register({ intents, usage, declaredByteSize: headroom }).kind).toBe('registered');
      // …and the next byte refuses on the reservations alone: nothing was
      // ever streamed or confirmed, which is exactly the bypass this closes.
      const over = register({ intents, usage, declaredByteSize: 1 });
      expect(over).toMatchObject({ kind: 'refused', code: 'event_quota_exceeded' });
    } finally {
      dispose();
    }
  });

  test('the declared size binds the stream, not just the lane cap', async () => {
    const { intents, blobs, dispose } = harness();
    try {
      const registered = register({ intents, declaredByteSize: 8 });
      if (registered.kind !== 'registered') throw new Error('expected registration');
      const streamed = await streamFileUploadBytes({
        intents,
        blobs,
        intent: registered.intent,
        bytes: (async function* () { yield new Uint8Array(9); })(),
        now: NOW
      });
      expect(streamed).toMatchObject({ kind: 'refused', code: 'byte_cap_exceeded' });
    } finally {
      dispose();
    }
  });
});

