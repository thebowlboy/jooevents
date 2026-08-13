<script lang="ts">
	import type { Snippet } from 'svelte';
	import { samplePortalGateway } from '../portal/sample/gateway';
	import { setPortalGateway } from '../portal/gateway';

	let { children }: { children: Snippet } = $props();
	setPortalGateway(samplePortalGateway);
</script>

{@render children()}
