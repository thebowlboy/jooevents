<script lang="ts">
	import { Undo2 } from 'lucide-svelte';
	import { latestReceipt, undoReceipt } from '../actions.svelte';

	let { onUndone }: { onUndone?: () => void } = $props();

	const receipt = $derived(latestReceipt());
	let shownId = $state<number | null>(null);
	let undoing = $state(false);

	// A fresh receipt shows for a while, then rests; the trail itself is kept by
	// the bus, this surface only presents the newest entry at commit time.
	$effect(() => {
		const current = receipt?.id ?? null;
		if (current === null) return;
		shownId = current;
		const timer = setTimeout(() => {
			if (shownId === current) shownId = null;
		}, 8000);
		return () => clearTimeout(timer);
	});

	async function undo() {
		if (!receipt?.undo || undoing) return;
		undoing = true;
		try {
			await undoReceipt(receipt);
			onUndone?.();
		} finally {
			undoing = false;
			shownId = null;
		}
	}
</script>

{#if receipt && shownId === receipt.id}
	<div class="receipt" role="status">
		<p class="receipt__label">{receipt.label}</p>
		{#if receipt.undo}
			<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled={undoing} onclick={undo}>
				<Undo2 size={13} aria-hidden="true" />{undoing ? 'Undoing…' : 'Undo'}
			</button>
		{:else if receipt.notUndoableReason}
			<p class="receipt__final">{receipt.notUndoableReason}</p>
		{/if}
	</div>
{/if}

<style>
	.receipt {
		position: fixed;
		inset-block-end: var(--je-space-4);
		inset-inline-start: calc(var(--je-sidebar-width) + var(--je-space-6));
		z-index: 70;
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		max-inline-size: min(34rem, calc(100vw - 2rem));
		padding: var(--je-space-2) var(--je-space-3);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-surface);
		box-shadow: var(--je-shadow-md);
	}

	.receipt__label {
		margin: 0;
		font-size: var(--je-font-size-sm);
		min-width: 0;
	}

	.receipt__final {
		margin: 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 920px) {
		.receipt {
			inset-inline-start: var(--je-space-3);
			inset-inline-end: var(--je-space-3);
		}
	}
</style>
