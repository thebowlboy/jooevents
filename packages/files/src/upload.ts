import {
  fileUploadConfirmInputSchema,
  fileUploadIntentRegisterInputSchema,
  type FileAssetChangedFactPayload,
  type FileAssetDto,
  type FileScopeDto,
  type FileUploadConfirmInput,
  type FileUploadIntentDto,
  type FileUploadIntentRegisterInput,
  type FileUploadLimitsDto,
  type FileUploaderPrincipalDto
} from '@jooevents/contracts/files';
import {
  newFileStorageKey,
  singleChunk,
  collectBounded,
  type FileBlobStreamingStore
} from './blob';
import { ingestImageBytes, type FileImageReEncoder } from './image-ingest';
import { ingestFileLifecycle, type FileScanProvider } from './lifecycle';
import { admitFileUpload, type UploadAdmissionRefusalCode } from './limits';
import {
  deepFreeze,
  isImageFileContentType,
  parseFileUploadIntent,
  sanitizeDisplayFilename,
  FilesValidationError,
  type FilesFact
} from './model';

/** Repository ports the two-phase upload engine composes; transports own transactions. */
export interface FileUploadIntentRepository {
  readIntent(scope: FileScopeDto, intentId: string): FileUploadIntentDto | undefined;
  createIntent(intent: FileUploadIntentDto): void;
  /** Replaces exactly the expected current image; must refuse on any drift. */
  transitionIntent(input: {
    readonly expected: FileUploadIntentDto;
    readonly next: FileUploadIntentDto;
  }): void;
}

export interface FileAssetWritePort {
  readAsset(scope: FileScopeDto, assetId: string): FileAssetDto | undefined;
  createAsset(asset: FileAssetDto): void;
}

export interface FileUploaderUsageSource {
  /**
   * Total bytes this uploader accountably holds in this event scope AS OF the
   * given instant: confirmed assets PLUS the reservations of open (pending or
   * stored, unexpired) upload intents at the larger of their declared and
   * stored sizes. Counting reservations is what makes the D4 quota bind at
   * registration — many intents opened before any confirm reserve their bytes
   * up front instead of slipping past a confirmed-only sum.
   */
  readUploaderStoredBytes(
    scope: FileScopeDto,
    uploader: FileUploaderPrincipalDto,
    asOf: string
  ): number;
}

export const DEFAULT_UPLOAD_INTENT_TTL_MS = 6 * 60 * 60 * 1000;

export type RegisterUploadIntentResult =
  | {
      readonly kind: 'registered';
      readonly intent: FileUploadIntentDto;
      readonly idempotent: boolean;
    }
  | {
      readonly kind: 'refused';
      readonly code:
        | UploadAdmissionRefusalCode
        | 'display_filename_invalid'
        | 'intent_id_collision';
    };

/** Phase one: admit and register the upload intent (D4 caps + D3 type gate). */
export function registerFileUploadIntent(input: {
  readonly scope: FileScopeDto;
  readonly uploader: FileUploaderPrincipalDto;
  readonly registration: FileUploadIntentRegisterInput;
  readonly limits: FileUploadLimitsDto;
  readonly usage: FileUploaderUsageSource;
  readonly intents: FileUploadIntentRepository;
  readonly storageProvider: string;
  readonly now: string;
  readonly ttlMs?: number;
}): RegisterUploadIntentResult {
  const registration = fileUploadIntentRegisterInputSchema.parse(input.registration);
  let displayFilename: string;
  try {
    displayFilename = sanitizeDisplayFilename(registration.displayFilename);
  } catch (error) {
    if (error instanceof FilesValidationError) {
      return deepFreeze({ kind: 'refused', code: 'display_filename_invalid' });
    }
    throw error;
  }
  const existing = input.intents.readIntent(input.scope, registration.intentId);
  if (existing) {
    const identical = existing.displayFilename === displayFilename
      && existing.contentType === registration.contentType
      && existing.declaredByteSize === registration.declaredByteSize
      && existing.purpose === registration.purpose
      && sameUploader(existing.uploader, input.uploader);
    return identical
      ? deepFreeze({ kind: 'registered', intent: existing, idempotent: true })
      : deepFreeze({ kind: 'refused', code: 'intent_id_collision' });
  }
  const admission = admitFileUpload({
    limits: input.limits,
    uploader: input.uploader,
    contentType: registration.contentType,
    declaredByteSize: registration.declaredByteSize,
    currentUploaderEventBytes:
      input.usage.readUploaderStoredBytes(input.scope, input.uploader, input.now)
  });
  if (admission.kind === 'refused') {
    return deepFreeze({ kind: 'refused', code: admission.code });
  }
  const ttlMs = input.ttlMs ?? DEFAULT_UPLOAD_INTENT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError('file_upload_intent_ttl_invalid');
  }
  const intent = parseFileUploadIntent({
    schemaVersion: 1,
    id: registration.intentId,
    scope: input.scope,
    uploader: input.uploader,
    purpose: registration.purpose,
    displayFilename,
    contentType: registration.contentType,
    declaredByteSize: registration.declaredByteSize,
    maximumByteSize: admission.maximumByteSize,
    storageProvider: input.storageProvider,
    storageKey: newFileStorageKey(input.scope, registration.intentId),
    state: 'pending',
    storedByteSize: null,
    storedSha256: null,
    createdAt: input.now,
    expiresAt: instantPlus(input.now, ttlMs)
  });
  input.intents.createIntent(intent);
  return deepFreeze({ kind: 'registered', intent, idempotent: false });
}

export type StreamUploadBytesResult =
  | { readonly kind: 'stored'; readonly intent: FileUploadIntentDto }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'intent_not_pending'
        | 'intent_expired'
        | 'byte_cap_exceeded'
        | 'empty_stream'
        | 'image_reencoder_unavailable'
        | 'image_decode_failed'
        | 'image_reencode_invalid';
    };

/**
 * Phase two: stream the bytes through the app to the blob store. Hashing and
 * the hard cap are inline; image types run through the re-encode seam and are
 * refused — with no stored object — when they do not decode.
 */
export async function streamFileUploadBytes(input: {
  readonly intents: FileUploadIntentRepository;
  readonly intent: FileUploadIntentDto;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly blobs: FileBlobStreamingStore;
  readonly imageReEncoder?: FileImageReEncoder;
  readonly now: string;
}): Promise<StreamUploadBytesResult> {
  const intent = parseFileUploadIntent(input.intent);
  if (intent.state !== 'pending') {
    return deepFreeze({ kind: 'refused', code: 'intent_not_pending' });
  }
  if (Date.parse(input.now) >= Date.parse(intent.expiresAt)) {
    input.intents.transitionIntent({
      expected: intent,
      next: parseFileUploadIntent({ ...intent, state: 'discarded' })
    });
    return deepFreeze({ kind: 'refused', code: 'intent_expired' });
  }
  if (intent.storageProvider !== input.blobs.provider) {
    throw new TypeError('file_upload_storage_provider_mismatch');
  }

  let storedContentType = intent.contentType;
  // The declared size is binding, not advisory: it is exactly what the quota
  // reserved at registration, so the input stream may not exceed it (nor the
  // lane cap). Re-encoded image output may differ from the input size; it
  // stays bounded by the lane cap on the write.
  const inputByteCap = Math.min(intent.maximumByteSize, intent.declaredByteSize);
  let write;
  if (isImageFileContentType(intent.contentType)) {
    const collected = await collectBounded(input.bytes, inputByteCap);
    if (collected.kind === 'refused') {
      return deepFreeze({ kind: 'refused', code: collected.code });
    }
    const ingested = await ingestImageBytes({
      ...(input.imageReEncoder ? { reencoder: input.imageReEncoder } : { reencoder: undefined }),
      contentType: intent.contentType,
      bytes: collected.bytes
    });
    if (ingested.kind === 'refused') {
      return deepFreeze({ kind: 'refused', code: ingested.code });
    }
    storedContentType = ingested.contentType as typeof intent.contentType;
    write = await input.blobs.writeStream({
      key: intent.storageKey,
      bytes: singleChunk(ingested.bytes),
      maximumByteSize: intent.maximumByteSize
    });
  } else {
    write = await input.blobs.writeStream({
      key: intent.storageKey,
      bytes: input.bytes,
      maximumByteSize: inputByteCap
    });
  }
  if (write.kind === 'refused') {
    return deepFreeze({ kind: 'refused', code: write.code });
  }
  const next = parseFileUploadIntent({
    ...intent,
    contentType: storedContentType,
    state: 'stored',
    storedByteSize: write.byteSize,
    storedSha256: write.sha256
  });
  input.intents.transitionIntent({ expected: intent, next });
  return deepFreeze({ kind: 'stored', intent: next });
}

export type ConfirmUploadResult =
  | {
      readonly kind: 'confirmed';
      readonly asset: FileAssetDto;
      readonly intent: FileUploadIntentDto;
      readonly idempotent: boolean;
      readonly facts: readonly FilesFact<FileAssetChangedFactPayload>[];
    }
  | {
      readonly kind: 'refused';
      readonly code: 'intent_not_stored' | 'hash_mismatch' | 'asset_id_collision';
    };

/**
 * Phase three: confirm the streamed bytes by hash and mint the durable asset
 * through the scan seam. The confirmation hash must equal the inline digest of
 * the exact stored bytes; anything else refuses without creating state.
 */
export function confirmFileUpload(input: {
  readonly intents: FileUploadIntentRepository;
  readonly assets: FileAssetWritePort;
  readonly scanProvider: FileScanProvider;
  readonly intent: FileUploadIntentDto;
  readonly confirmation: FileUploadConfirmInput;
  readonly now: string;
}): ConfirmUploadResult {
  const confirmation = fileUploadConfirmInputSchema.parse(input.confirmation);
  const intent = parseFileUploadIntent(input.intent);
  if (intent.id !== confirmation.intentId) {
    throw new TypeError('file_upload_confirm_intent_mismatch');
  }
  if (intent.state === 'confirmed') {
    const existing = input.assets.readAsset(intent.scope, confirmation.assetId);
    if (existing
        && existing.sha256 === intent.storedSha256
        && existing.storageKey === intent.storageKey) {
      return deepFreeze({
        kind: 'confirmed', asset: existing, intent, idempotent: true, facts: []
      });
    }
    return deepFreeze({ kind: 'refused', code: 'intent_not_stored' });
  }
  if (intent.state !== 'stored' || intent.storedSha256 === null || intent.storedByteSize === null) {
    return deepFreeze({ kind: 'refused', code: 'intent_not_stored' });
  }
  if (confirmation.sha256 !== intent.storedSha256) {
    return deepFreeze({ kind: 'refused', code: 'hash_mismatch' });
  }
  if (input.assets.readAsset(intent.scope, confirmation.assetId)) {
    return deepFreeze({ kind: 'refused', code: 'asset_id_collision' });
  }
  const ingest = ingestFileLifecycle({
    provider: input.scanProvider,
    assetId: confirmation.assetId,
    contentType: intent.contentType,
    byteSize: intent.storedByteSize,
    sha256: intent.storedSha256,
    at: input.now
  });
  const asset = deepFreeze({
    schemaVersion: 1 as const,
    id: confirmation.assetId,
    scope: intent.scope,
    uploader: intent.uploader,
    purpose: intent.purpose,
    displayFilename: intent.displayFilename,
    contentType: intent.contentType,
    byteSize: intent.storedByteSize,
    sha256: intent.storedSha256,
    storageProvider: intent.storageProvider,
    storageKey: intent.storageKey,
    lifecycle: ingest.lifecycle,
    scan: ingest.scan,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now
  }) satisfies FileAssetDto;
  input.assets.createAsset(asset);
  const nextIntent = parseFileUploadIntent({ ...intent, state: 'confirmed' });
  input.intents.transitionIntent({ expected: intent, next: nextIntent });
  return deepFreeze({
    kind: 'confirmed',
    asset,
    intent: nextIntent,
    idempotent: false,
    facts: [{
      kind: 'file_asset_changed',
      version: 1 as const,
      payload: {
        action: 'confirm' as const,
        assetId: asset.id,
        lifecycle: asset.lifecycle,
        version: asset.version
      }
    }]
  });
}

export type DiscardUploadIntentResult =
  | { readonly kind: 'discarded'; readonly intent: FileUploadIntentDto; readonly blobDeleted: boolean }
  | { readonly kind: 'refused'; readonly code: 'intent_already_terminal' };

/** Compensation for the two-phase upload: discard the intent and its bytes. */
export async function discardFileUploadIntent(input: {
  readonly intents: FileUploadIntentRepository;
  readonly blobs: FileBlobStreamingStore;
  readonly intent: FileUploadIntentDto;
}): Promise<DiscardUploadIntentResult> {
  const intent = parseFileUploadIntent(input.intent);
  if (intent.state === 'confirmed' || intent.state === 'discarded') {
    return deepFreeze({ kind: 'refused', code: 'intent_already_terminal' });
  }
  let blobDeleted = false;
  if (intent.state === 'stored') {
    blobDeleted = (await input.blobs.deleteObject(intent.storageKey)).deleted;
  }
  const next = parseFileUploadIntent({ ...intent, state: 'discarded' });
  input.intents.transitionIntent({ expected: intent, next });
  return deepFreeze({ kind: 'discarded', intent: next, blobDeleted });
}

function sameUploader(
  left: FileUploaderPrincipalDto,
  right: FileUploaderPrincipalDto
): boolean {
  if (left.kind === 'operator_user' && right.kind === 'operator_user') {
    return left.userId === right.userId;
  }
  if (left.kind === 'participant' && right.kind === 'participant') {
    return left.participantIdentityId === right.participantIdentityId;
  }
  return false;
}

function instantPlus(now: string, deltaMs: number): string {
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed)) throw new TypeError('file_upload_now_invalid');
  return new Date(parsed + deltaMs).toISOString();
}
