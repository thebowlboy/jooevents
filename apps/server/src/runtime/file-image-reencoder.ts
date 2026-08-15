import sharp from 'sharp';
import type { FileImageReEncoder, ImageReEncodeOutcome } from '@jooevents/files';

const FORMAT_BY_CONTENT_TYPE = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp'
} as const);

/** ~16k × 16k: far beyond any headshot, small enough to refuse pixel bombs. */
const MAXIMUM_INPUT_PIXELS = 268_402_689;

/**
 * The D3 image ingestion encoder: a full decode and a fresh encode, so a
 * polyglot, an appended payload, or embedded metadata (EXIF, GPS) does not
 * survive into storage. EXIF orientation is baked into the pixels first so
 * stripping it never flips a photo. Anything sharp cannot decode as the
 * declared type is a refusal, never a pass-through.
 */
export const SHARP_FILE_IMAGE_REENCODER: FileImageReEncoder = Object.freeze({
  id: 'sharp.reencode.v1',
  async reencode(input: {
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<ImageReEncodeOutcome> {
    const format = FORMAT_BY_CONTENT_TYPE[
      input.contentType as keyof typeof FORMAT_BY_CONTENT_TYPE
    ];
    if (format === undefined) return Object.freeze({ kind: 'decode_failed' });
    try {
      const output = await sharp(input.bytes, {
        limitInputPixels: MAXIMUM_INPUT_PIXELS,
        // One image only: animated inputs re-encode as their first frame.
        pages: 1
      })
        .rotate()
        .toFormat(format)
        .toBuffer();
      return Object.freeze({
        kind: 'reencoded',
        contentType: input.contentType,
        bytes: new Uint8Array(output)
      });
    } catch {
      return Object.freeze({ kind: 'decode_failed' });
    }
  }
});
