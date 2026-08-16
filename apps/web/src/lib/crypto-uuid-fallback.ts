/**
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost), but
 * development and tailnet previews are served over plain HTTP on a hostname —
 * where every attempt-key call site would throw. `crypto.getRandomValues` has
 * no such restriction, so install an RFC 4122 v4 fallback once at startup.
 * Import this module for its side effect before any surface that mutates.
 */
const cryptoRef = globalThis.crypto;
if (cryptoRef && typeof cryptoRef.randomUUID !== 'function') {
	const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
		const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	};
	Object.defineProperty(cryptoRef, 'randomUUID', { value: randomUUID, configurable: true });
}

export {};
