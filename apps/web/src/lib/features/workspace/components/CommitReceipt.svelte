<script lang="ts">
	/**
	 * The receipt bus, docked. Every surface that commits renders one of these;
	 * the presentation itself is the shared `Receipt` primitive, so the operator
	 * workspace and the participant portal cannot drift into two grammars for
	 * the same guarantee.
	 */
	import { Receipt } from '$lib/ui';
	import { latestReceipt, undoReceipt } from '../actions.svelte';

	let {
		onUndone,
		placement = 'rail'
	}: { onUndone?: () => void; placement?: 'rail' | 'column' } = $props();

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
	<Receipt
		label={receipt.label}
		href={receipt.href}
		hrefLabel={receipt.hrefLabel}
		{placement}
		{undoing}
		onundo={receipt.undo ? undo : undefined}
		finalNote={receipt.notUndoableReason}
		ondismiss={() => (shownId = null)} />
{/if}
