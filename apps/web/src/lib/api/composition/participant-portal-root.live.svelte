<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children: _children }: { children: Snippet } = $props();
	$effect(() => void _children);
</script>

<!-- No participant operations are served in this build, so no portal data source
     exists. The state is rendered here rather than delegated to a child route,
     which would instantiate an alternate one. -->
<svelte:head>
	<title>Portal · JooEvents</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="portal-gate">
	<section class="portal-gate__panel">
		<h1>The speaker portal isn’t available here yet</h1>
		<p>
			This build has no participant tools enabled. If an organizer sent you a link, they can tell
			you where your submissions live in the meantime.
		</p>
	</section>
</main>

<style>
	.portal-gate {
		min-block-size: 100svh;
		display: grid;
		place-items: center;
		padding: max(var(--je-space-6), env(safe-area-inset-top))
			max(var(--je-space-4), env(safe-area-inset-right))
			max(var(--je-space-6), env(safe-area-inset-bottom))
			max(var(--je-space-4), env(safe-area-inset-left));
		background: var(--je-color-page);
	}

	.portal-gate__panel {
		inline-size: min(100%, 38rem);
		display: grid;
		align-content: start;
		gap: var(--je-space-4);
		padding: clamp(var(--je-space-6), 6vw, var(--je-space-10));
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-lg);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-sm);
	}

	.portal-gate__panel h1 {
		margin: 0;
		max-inline-size: 24ch;
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
	}

	.portal-gate__panel p {
		margin: 0;
		max-inline-size: 48ch;
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	@media (max-width: 520px) {
		.portal-gate {
			place-items: start stretch;
			padding-inline: 0;
			padding-block: 0;
			background: var(--je-color-surface);
		}

		.portal-gate__panel {
			min-block-size: 100svh;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>
