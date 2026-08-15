import { describe, expect, test } from 'bun:test';
import { sha256HexOfBlob } from './upload-transfer';

describe('sha256HexOfBlob', () => {
	test('hashes the exact bytes, matching the well-known vector', async () => {
		// SHA-256("abc") — the FIPS 180-2 test vector.
		const blob = new Blob([new TextEncoder().encode('abc')]);
		expect(await sha256HexOfBlob(blob)).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	test('streams multi-chunk blobs to one digest', async () => {
		const chunked = new Blob([
			new Uint8Array(1024 * 1024).fill(7),
			new Uint8Array(3).fill(9)
		]);
		const whole = new Blob([await chunked.arrayBuffer()]);
		expect(await sha256HexOfBlob(chunked)).toBe(await sha256HexOfBlob(whole));
	});
});
