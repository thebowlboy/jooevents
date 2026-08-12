export const CANONICAL_JSON_PROFILE = Object.freeze({
  key: 'jooevents.canonical_json',
  version: 1
} as const);

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

const encoder = new TextEncoder();

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`Unpaired Unicode surrogate at ${path}`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`Unpaired Unicode surrogate at ${path}`);
    }
  }
}

function normalizeString(value: string, path: string): string {
  assertUnicodeScalarString(value, path);
  return value.normalize('NFC');
}

function canonicalize(value: unknown, path: string, ancestors: Set<object>): CanonicalJson {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return normalizeString(value, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`Non-canonical number at ${path}`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`Circular value at ${path}`);
    ancestors.add(value);
    try {
      const result: CanonicalJson[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`Sparse array entry at ${path}[${index}]`);
        result.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }

  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError(`Circular value at ${path}`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Symbol-keyed value at ${path}`);
    }

    ancestors.add(value);
    try {
      const entries: Array<readonly [string, CanonicalJson]> = [];
      const normalizedKeys = new Set<string>();
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError(`Non-data property at ${path}.${key}`);
        }
        const normalizedKey = normalizeString(key, `${path}.[key]`);
        if (normalizedKeys.has(normalizedKey)) {
          throw new TypeError(`Unicode-normalized key collision at ${path}.${normalizedKey}`);
        }
        normalizedKeys.add(normalizedKey);
        entries.push([
          normalizedKey,
          canonicalize(descriptor.value, `${path}.${normalizedKey}`, ancestors)
        ]);
      }
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
    }
  }

  throw new TypeError(`Unsupported value at ${path}`);
}

/**
 * Produces the sole schema-parsed JSON value accepted by Foundation digests.
 * The returned object is detached from the input and contains NFC strings/keys.
 */
export function canonicalJsonValue(value: unknown): CanonicalJson {
  return canonicalize(value, '$', new Set());
}

/** Encodes canonical_json v1 as exact UTF-8 JSON bytes. */
export function encodeCanonicalJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(canonicalJsonValue(value)));
}

export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}
