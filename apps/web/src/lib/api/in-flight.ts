/**
 * Concurrent callers join one in-flight attempt. The slot clears when that
 * attempt settles, so the next read is fresh rather than a cache.
 *
 * This is the same join the live Schedule population source uses: a page load
 * that asks for the same snapshot twice pays once, and a later mutation
 * invalidates by simply reading again.
 */
export function shareInFlight<Value>(
	slot: { current: Promise<Value> | null },
	load: () => Promise<Value>
): Promise<Value> {
	if (slot.current) return slot.current;
	const run = load().finally(() => {
		if (slot.current === run) slot.current = null;
	});
	slot.current = run;
	return run;
}

export function createInFlightSlot<Value>(): { current: Promise<Value> | null } {
	return { current: null };
}
