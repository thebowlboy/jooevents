import { createContext } from 'svelte';
import type { PortalApi } from '$lib/api/portal/gateway';
import type { PortalSnapshotView } from '$lib/api/portal/view-models';

/**
 * One read of one participant's world, owned by the shell and shared with every
 * page inside it.
 *
 * The portal is small enough that a single projection answers every screen, and
 * making it one read is what keeps the shell's event name and a page's content
 * from ever describing two different moments. A change re-reads it: the rows
 * already on screen stay, dimmed, until the replacement lands, so nobody is sent
 * back to a loading state they have already passed.
 */
export interface PortalStore {
	readonly api: PortalApi;
	readonly snapshot: PortalSnapshotView | null;
	/** A re-read under content that is already on screen. */
	readonly reloading: boolean;
	/** The first read could not be completed; the surface says so rather than showing nothing. */
	readonly failed: boolean;
	load(): Promise<void>;
	reload(): Promise<void>;
}

export function createPortalStore(api: PortalApi): PortalStore {
	let snapshot = $state<PortalSnapshotView | null>(null);
	let reloading = $state(false);
	let failed = $state(false);

	// Only the newest read may write: a reload that overtakes an earlier one must
	// not be replaced by the answer it overtook.
	let request = 0;

	async function read(): Promise<void> {
		const ticket = (request += 1);
		try {
			const next = await api.snapshot();
			if (ticket !== request) return;
			snapshot = next;
			failed = false;
		} catch {
			if (ticket !== request) return;
			failed = snapshot === null;
		}
	}

	return {
		api,
		get snapshot() {
			return snapshot;
		},
		get reloading() {
			return reloading;
		},
		get failed() {
			return failed;
		},
		async load() {
			if (snapshot !== null) return;
			await read();
		},
		async reload() {
			reloading = true;
			try {
				await read();
			} finally {
				reloading = false;
			}
		}
	};
}

export const [usePortalStore, setPortalStore] = createContext<PortalStore>();
