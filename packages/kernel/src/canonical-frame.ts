const MAGIC = Uint8Array.of(0x4a, 0x45, 0x43, 0x46); // JECF
const FORMAT_VERSION = 1;
const UINT32_BYTES = 4;
const encoder = new TextEncoder();

export interface CanonicalFrameInput {
  readonly namespace: string;
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly kind: string;
  readonly fields: readonly string[];
}

function requireNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
}

function writeUint32(output: Uint8Array, offset: number, value: number): void {
  new DataView(output.buffer, output.byteOffset, output.byteLength)
    .setUint32(offset, value, false);
}

/**
 * Encodes exact UTF-8 segments as a versioned, length-prefixed binary frame.
 * Callers choose semantic fields; cryptographic key derivation consumes these bytes.
 */
export function encodeCanonicalFrame(input: CanonicalFrameInput): Uint8Array {
  requireNonEmpty(input.namespace, 'namespace');
  requireNonEmpty(input.profileKey, 'profileKey');
  requireNonEmpty(input.kind, 'kind');
  if (!Number.isSafeInteger(input.profileVersion) || input.profileVersion <= 0) {
    throw new TypeError('profileVersion must be a positive safe integer');
  }
  if (!input.fields.every((field) => typeof field === 'string')) {
    throw new TypeError('canonical frame fields must be strings');
  }

  const segments = [
    input.namespace,
    input.profileKey,
    String(input.profileVersion),
    input.kind,
    ...input.fields
  ].map((segment) => encoder.encode(segment));
  if (segments.length > 0xffff_ffff) throw new RangeError('too many canonical frame segments');

  let byteLength = MAGIC.byteLength + 1 + UINT32_BYTES;
  for (const segment of segments) {
    if (segment.byteLength > 0xffff_ffff) throw new RangeError('canonical frame segment is too large');
    byteLength += UINT32_BYTES + segment.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > 0xffff_ffff) {
      throw new RangeError('canonical frame is too large');
    }
  }

  const output = new Uint8Array(byteLength);
  output.set(MAGIC, 0);
  output[MAGIC.byteLength] = FORMAT_VERSION;
  let offset = MAGIC.byteLength + 1;
  writeUint32(output, offset, segments.length);
  offset += UINT32_BYTES;
  for (const segment of segments) {
    writeUint32(output, offset, segment.byteLength);
    offset += UINT32_BYTES;
    output.set(segment, offset);
    offset += segment.byteLength;
  }
  return output;
}
