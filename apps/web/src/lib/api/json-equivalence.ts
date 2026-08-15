/**
 * Compares JSON-shaped values by meaning rather than object insertion order.
 * Protocol boundaries may re-encode object keys while preserving the exact
 * reviewed value, so `JSON.stringify(left) === JSON.stringify(right)` is not a
 * valid integrity check across separate HTTP responses.
 */
export function jsonEquivalent(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
		return false;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left)
			&& Array.isArray(right)
			&& left.length === right.length
			&& left.every((value, index) => jsonEquivalent(value, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index]
			&& jsonEquivalent(leftRecord[key], rightRecord[key]));
}
