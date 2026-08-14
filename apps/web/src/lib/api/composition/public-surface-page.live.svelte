<script lang="ts">
	import PublicSurfacePage from '$lib/features/public/PublicSurfacePage.svelte';
	import type { SurfaceKind } from '$lib/api/types';

	let { kind }: { readonly kind: SurfaceKind } = $props();
</script>

<!-- The live composition serves the real hosted page: the root has already
     mounted the live public-surface port, publication absence renders the
     page's own honest not-published state, and indexing stays opt-out-by-
     absence (the live settings read serves none). -->
<PublicSurfacePage {kind} />
