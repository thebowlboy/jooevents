import { expect, test } from 'bun:test';
import { encodeCanonicalFrame } from './canonical-frame';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

test('canonical frames are deterministic and frozen by a golden vector', () => {
  const frame = encodeCanonicalFrame({
    namespace: 'authority-principal',
    profileKey: 'principal-key',
    profileVersion: 1,
    kind: 'workspace_user',
    fields: ['user', 'membership']
  });

  expect(hex(frame)).toBe(
    '4a454346010000000600000013617574686f726974792d7072696e636970616c' +
    '0000000d7072696e636970616c2d6b657900000001310000000e776f726b7370' +
    '6163655f7573657200000004757365720000000a6d656d62657273686970'
  );
  expect(hex(encodeCanonicalFrame({
    namespace: 'authority-principal',
    profileKey: 'principal-key',
    profileVersion: 1,
    kind: 'workspace_user',
    fields: ['user', 'membership']
  }))).toBe(hex(frame));
});

test('length-prefixing separates empty, NUL, Unicode, kind, and profile inputs', () => {
  const inputs = [
    { kind: 'a', fields: ['', 'x'] },
    { kind: 'a', fields: ['x', ''] },
    { kind: 'a', fields: ['\u0000', 'x'] },
    { kind: 'a\u0000', fields: ['', 'x'] },
    { kind: 'a', fields: ['é', 'x'] },
    { kind: 'a', fields: ['e\u0301', 'x'] },
    { kind: 'b', fields: ['', 'x'] }
  ];
  const frames = inputs.map((input) => hex(encodeCanonicalFrame({
    namespace: 'authority-principal',
    profileKey: 'principal-key',
    profileVersion: 1,
    ...input
  })));

  expect(new Set(frames).size).toBe(frames.length);
  expect(hex(encodeCanonicalFrame({
    namespace: 'authority-principal', profileKey: 'principal-key', profileVersion: 2,
    kind: 'a', fields: ['', 'x']
  }))).not.toBe(frames[0]);
});
