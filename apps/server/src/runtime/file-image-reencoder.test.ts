import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { SHARP_FILE_IMAGE_REENCODER } from './file-image-reencoder';

describe('sharp image re-encoder (D3)', () => {
  test('re-encodes a real PNG and strips trailing payload bytes', async () => {
    const clean = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 4, g: 8, b: 15 } }
    }).png().toBuffer();
    const polyglot = new Uint8Array([...clean, ...new TextEncoder().encode('<script>evil</script>')]);
    const outcome = await SHARP_FILE_IMAGE_REENCODER.reencode({
      contentType: 'image/png',
      bytes: polyglot
    });
    if (outcome.kind !== 'reencoded') throw new Error('expected reencode');
    expect(outcome.contentType).toBe('image/png');
    expect(new TextDecoder('latin1').decode(outcome.bytes)).not.toContain('<script>');
    const meta = await sharp(outcome.bytes).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(2);
  });

  test('refuses bytes that are not a decodable image', async () => {
    const outcome = await SHARP_FILE_IMAGE_REENCODER.reencode({
      contentType: 'image/jpeg',
      bytes: new TextEncoder().encode('not an image at all')
    });
    expect(outcome).toEqual({ kind: 'decode_failed' });
  });

  test('refuses content types outside the image allowlist', async () => {
    const outcome = await SHARP_FILE_IMAGE_REENCODER.reencode({
      contentType: 'image/svg+xml',
      bytes: new TextEncoder().encode('<svg/>')
    });
    expect(outcome).toEqual({ kind: 'decode_failed' });
  });
});
