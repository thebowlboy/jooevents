<script lang="ts">
	import { Compass } from 'lucide-svelte';
	import { page } from '$app/state';
	import { destinationLabel } from '$lib/features/workspace/navigation';

	const label = $derived(destinationLabel(page.url.pathname));
	const title = $derived(label ?? 'Workspace');
</script>

<svelte:head><title>{title} · JooEvents</title></svelte:head>

<section class="pending">
	<span class="pending__mark" aria-hidden="true"><Compass size={20} /></span>
	<h2 class="pending__title">
		{#if label}{label} is not built yet{:else}This destination does not exist{/if}
	</h2>
	<p class="pending__copy">
		{#if label}
			The workspace navigation is in place ahead of this screen. Everything else stays
			available from the sidebar.
		{:else}
			No workspace destination matches this address. Continue from the overview.
		{/if}
	</p>
	<a class="ui-button ui-button--secondary ui-button--sm" href="/app">Back to overview</a>
</section>

<style>
	/* Placeholder destinations keep the shell so navigation is never lost; the
	   panel matches ordinary content geometry so arriving here reads as a state,
	   not a broken page. */
	.pending {
		display: grid;
		justify-items: start;
		gap: var(--je-space-3);
		min-block-size: 16rem;
		align-content: center;
		padding: var(--je-space-8);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.pending__mark {
		display: grid;
		place-items: center;
		inline-size: 2.5rem;
		block-size: 2.5rem;
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	.pending__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 600;
	}

	.pending__copy {
		margin: 0;
		max-inline-size: 42ch;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-md);
	}
</style>
