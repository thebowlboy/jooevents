<script lang="ts">
	/**
	 * A portal store over one named sample world, for reference specimens.
	 *
	 * The components inside are the shipped ones, wired to the shipped sample
	 * API, so a press here does what a press does in the product: the change is
	 * refused or committed by the same code, and the receipt says the same
	 * thing. The dataset is cloned per scope, so one card's changes cannot leak
	 * into the next card's specimen.
	 */
	import { untrack, type Snippet } from 'svelte';
	import { createPortalApi } from '$lib/api/portal/sample/api';
	import type { PortalDataset } from '$lib/api/portal/sample/dataset';
	import { createPortalStore, setPortalStore } from '$lib/features/portal/store.svelte';
	import type { PortalSnapshotView } from '$lib/api/portal/view-models';

	let { dataset, children }: { dataset: PortalDataset; children: Snippet<[PortalSnapshotView]> } =
		$props();

	// Read once on purpose: a scope owns one world for as long as it is mounted.
	const store = untrack(() => createPortalStore(createPortalApi(structuredClone(dataset))));
	setPortalStore(store);
	void store.load();
</script>

{#if store.snapshot}
	{@render children(store.snapshot)}
{:else}
	<p class="scope-waiting">Reading the sample world…</p>
{/if}

<style>
	.scope-waiting {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}
</style>
