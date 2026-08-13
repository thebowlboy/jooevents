<script lang="ts">
	import '$lib/design-system/workbench.css';
	import PortalGallery from '$lib/design-system/PortalGallery.svelte';

	// No density override: the participant surface runs at the default metrics,
	// and a reference that showed it compact would be showing another product.
</script>

<svelte:head>
	<title>Participant portal · JooEvents design system</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="portal-reference">
	<PortalGallery />
</div>

<style>
	.portal-reference {
		min-block-size: 100dvh;
		background:
			radial-gradient(
				circle at 92% 7%,
				color-mix(in srgb, var(--je-color-action-soft) 58%, transparent),
				transparent 22rem
			),
			var(--je-color-canvas);
	}
</style>
