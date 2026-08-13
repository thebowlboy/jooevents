<script lang="ts">
	import { Lock } from 'lucide-svelte';

	let {
		title,
		detail = 'This area is not enabled in the live workspace yet.'
	}: {
		readonly title: string;
		readonly detail?: string;
	} = $props();
</script>

<section class="unavailable" aria-labelledby="live-unavailable-title">
	<span class="unavailable__mark" aria-hidden="true"><Lock size={18} /></span>
	<div class="unavailable__copy">
		<h2 id="live-unavailable-title">{title}</h2>
		<p>{detail}</p>
	</div>
	<a class="ui-button ui-button--secondary ui-button--sm" href="/app">Back to overview</a>
</section>

<style>
	.unavailable {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--je-space-4);
		min-block-size: 10rem;
		padding: var(--je-space-6);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.unavailable__mark {
		display: grid;
		place-items: center;
		inline-size: 2.5rem;
		block-size: 2.5rem;
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	.unavailable__copy {
		display: grid;
		gap: var(--je-space-1);
	}

	.unavailable h2,
	.unavailable p {
		margin: 0;
	}

	.unavailable h2 {
		font-size: var(--je-font-size-lg);
	}

	.unavailable p {
		max-inline-size: 58ch;
		color: var(--je-color-text-muted);
	}

	@media (max-width: 640px) {
		.unavailable {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.unavailable > a {
			grid-column: 1 / -1;
			justify-self: start;
		}
	}
</style>
