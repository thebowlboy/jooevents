<script lang="ts">
	import type { Snippet } from 'svelte';
	import { sampleWorkspaceGateway } from '../sample/gateway';
	import { setWorkspaceGateway } from '../workspace-gateway';

	let { children }: { children: Snippet } = $props();
	setWorkspaceGateway(sampleWorkspaceGateway);
</script>

{@render children()}
