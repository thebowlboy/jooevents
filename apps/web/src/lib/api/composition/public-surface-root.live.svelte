<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<!-- Public reads and application effects are not activated in the ordinary live
     composition. The child resolves to a live unavailable surface and therefore
     needs no workspace or organizer authority context. -->
{@render children()}
