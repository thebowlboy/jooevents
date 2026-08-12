<script lang="ts">
	/**
	 * The line-up at its own address.
	 *
	 * The comparison itself lives in `LineupPanel`, which the review queue also
	 * opens as a modal over itself. What this route adds is addressability: the
	 * anchor and the slice are scope, so both travel in the URL and a line-up can
	 * be linked to, reloaded, and stepped back out of.
	 *
	 * Referred surface: it is reached from a review, never from navigation, so
	 * without an anchor there is nothing to compare and the panel says so rather
	 * than rendering an empty frame.
	 */
	import { applyParams, param, paramIn } from '$lib/features/workspace/url-state.svelte';
	import CommitReceipt from '$lib/features/workspace/components/CommitReceipt.svelte';
	import LineupPanel, { sliceKeys } from './LineupPanel.svelte';
	import type { SliceKey } from './LineupPanel.svelte';

	const anchorId = $derived(param('anchor'));
	const slice = $derived(paramIn('slice', sliceKeys, 'track'));

	function switchSlice(next: SliceKey) {
		// A scope change is a destination: arriving on one slice and moving to the
		// other are two views, and Back is how you take the move back.
		applyParams({ slice: next === 'track' ? null : next }, { history: 'push' });
	}
</script>

<CommitReceipt />

<LineupPanel {anchorId} {slice} onSliceChange={switchSlice} heading="Line-up" />
