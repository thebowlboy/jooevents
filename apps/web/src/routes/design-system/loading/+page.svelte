<script lang="ts">
	import LoadingGallery from '$lib/design-system/LoadingGallery.svelte';

	// Shown at internal-operations density, since the workspace shell is where the
	// chosen treatment will live.
	$effect(() => {
		const previous = document.documentElement.dataset.density;
		document.documentElement.dataset.density = 'compact';
		return () => {
			if (previous === undefined) delete document.documentElement.dataset.density;
			else document.documentElement.dataset.density = previous;
		};
	});
</script>

<svelte:head>
	<title>Waiting treatments · JooEvents design system</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<LoadingGallery />
