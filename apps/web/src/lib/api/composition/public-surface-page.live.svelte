<script lang="ts">
	let { kind: _kind }: { readonly kind?: string } = $props();
	$effect(() => void _kind);
</script>

<svelte:head>
	<title>Public page unavailable · JooEvents</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="public-live-gate">
	<section class="public-live-gate__panel" role="status">
		<h1>This event page isn’t available here yet</h1>
		<p>
			The organizer has not published this page from the live workspace. Check the link or try
			again later.
		</p>
	</section>
</main>

<style>
	.public-live-gate {
		min-block-size: 100svh;
		display: grid;
		place-items: center;
		padding: max(var(--je-space-6), env(safe-area-inset-top))
			max(var(--je-space-4), env(safe-area-inset-right))
			max(var(--je-space-6), env(safe-area-inset-bottom))
			max(var(--je-space-4), env(safe-area-inset-left));
		background: var(--je-color-page);
	}

	.public-live-gate__panel {
		inline-size: min(100%, 38rem);
		min-block-size: 18rem;
		display: grid;
		align-content: center;
		gap: var(--je-space-4);
		padding: clamp(var(--je-space-6), 6vw, var(--je-space-10));
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-lg);
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-sm);
	}

	h1,
	p {
		margin: 0;
	}

	h1 {
		max-inline-size: 24ch;
		font-size: var(--je-font-size-2xl);
		line-height: var(--je-leading-tight);
	}

	p {
		max-inline-size: 48ch;
		color: var(--je-color-text-muted);
		line-height: var(--je-leading-normal);
	}

	@media (max-width: 520px) {
		.public-live-gate {
			place-items: stretch;
			padding: 0;
			background: var(--je-color-surface);
		}

		.public-live-gate__panel {
			min-block-size: 100svh;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>
