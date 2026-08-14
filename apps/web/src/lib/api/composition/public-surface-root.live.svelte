<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setPublicSurfacePort } from '../public-surface-port';
	import { createLivePublicSurfacePort } from '../public-surface-port.live';

	let { children }: { children: Snippet } = $props();

	// The anonymous public lane: three GET reads, no workspace or organizer
	// authority context. Publication absence arrives as a typed outcome and
	// renders as the page's own honest not-published state.
	setPublicSurfacePort(createLivePublicSurfacePort());
</script>

{@render children()}
