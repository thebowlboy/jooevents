import { isImageFileContentType } from './model';

/**
 * The image re-encode seam, following the avatar-pipeline posture: image types
 * are never stored verbatim. A decoder/encoder implementation (native or
 * worker-hosted) plugs in here; the upload engine refuses image ingest when no
 * encoder is configured or the encoder cannot decode the bytes — killing
 * polyglot files and stripping metadata is the point, so there is no
 * pass-through fallback.
 */
export interface FileImageReEncoder {
  /** Stable diagnostic identity of the encoder implementation. */
  readonly id: string;
  /**
   * Decodes and re-encodes `bytes` as `contentType`. Returns `decode_failed`
   * when the bytes are not a well-formed image of that type. The output
   * content type must stay within the image allowlist.
   */
  reencode(input: {
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<ImageReEncodeOutcome>;
}

export type ImageReEncodeOutcome =
  | {
      readonly kind: 'reencoded';
      readonly contentType: string;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'decode_failed' };

export type ImageIngestOutcome =
  | {
      readonly kind: 'ingested';
      readonly contentType: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'refused';
      readonly code: 'image_reencoder_unavailable' | 'image_decode_failed' | 'image_reencode_invalid';
    };

/**
 * Runs one image buffer through the re-encode seam. Non-image types never
 * reach this function; callers gate on `isImageFileContentType` first.
 */
export async function ingestImageBytes(input: {
  readonly reencoder: FileImageReEncoder | undefined;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}): Promise<ImageIngestOutcome> {
  if (!isImageFileContentType(input.contentType)) {
    throw new TypeError('image_ingest_content_type_not_image');
  }
  if (input.reencoder === undefined) {
    return Object.freeze({ kind: 'refused', code: 'image_reencoder_unavailable' });
  }
  const outcome = await input.reencoder.reencode({
    contentType: input.contentType,
    bytes: input.bytes
  });
  if (outcome.kind === 'decode_failed') {
    return Object.freeze({ kind: 'refused', code: 'image_decode_failed' });
  }
  if (outcome.kind !== 'reencoded'
      || !(outcome.bytes instanceof Uint8Array)
      || outcome.bytes.byteLength === 0
      || !isImageFileContentType(outcome.contentType)) {
    return Object.freeze({ kind: 'refused', code: 'image_reencode_invalid' });
  }
  return Object.freeze({
    kind: 'ingested',
    contentType: outcome.contentType,
    bytes: outcome.bytes
  });
}
