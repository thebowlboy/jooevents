import { describe, expect, test } from 'bun:test';
import {
  CANONICAL_JSON_PROFILE,
  canonicalJsonSha256,
  canonicalJsonText,
  encodeCanonicalJson
} from './canonical-json';

describe('canonical_json v1', () => {
  test('normalizes Unicode before sorting keys and produces stable UTF-8 bytes', () => {
    const decomposed = `e\u0301`;
    const composed = '\u00e9';
    expect(canonicalJsonText({ z: decomposed, b: 2, a: [true, null] })).toBe(
      canonicalJsonText({ a: [true, null], b: 2, z: composed })
    );
    expect(new TextDecoder().decode(encodeCanonicalJson({ b: 2, a: 1 }))).toBe('{"a":1,"b":2}');
    expect(CANONICAL_JSON_PROFILE).toEqual({ key: 'jooevents.canonical_json', version: 1 });
  });

  test('hashes the canonical bytes independently of input key order', () => {
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'
    );
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(canonicalJsonSha256({ a: 1, b: 2 }));
  });

  test('rejects values whose JavaScript representation is ambiguous or lossy', () => {
    expect(() => canonicalJsonText({ value: undefined })).toThrow('Unsupported value');
    expect(() => canonicalJsonText([, 1])).toThrow('Sparse array');
    expect(() => canonicalJsonText(-0)).toThrow('Non-canonical number');
    expect(() => canonicalJsonText(Number.NaN)).toThrow('Non-canonical number');
    expect(() => canonicalJsonText({ ['e\u0301']: 1, ['\u00e9']: 2 })).toThrow('key collision');
    expect(() => canonicalJsonText('\ud800')).toThrow('Unpaired Unicode surrogate');
  });

  test('rejects accessors, symbol keys, non-plain objects, and cycles', () => {
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    expect(() => canonicalJsonText(accessor)).toThrow('Non-data property');
    expect(() => canonicalJsonText({ [Symbol('hidden')]: 1 })).toThrow('Symbol-keyed');
    expect(() => canonicalJsonText(new Date())).toThrow('Non-plain object');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJsonText(cycle)).toThrow('Circular value');
  });
});
