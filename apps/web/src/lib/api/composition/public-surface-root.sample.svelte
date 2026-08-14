<script lang="ts">
	import type { Snippet } from 'svelte';
	import { sampleWorkspaceGateway } from '../sample/gateway';
	import { setPublicSurfacePort } from '../public-surface-port';
	import { setWorkspaceGateway } from '../workspace-gateway';

	let { children }: { children: Snippet } = $props();
	setWorkspaceGateway(sampleWorkspaceGateway);
	// The public pages read their own narrow port; the sample fixture
	// satisfies it structurally, unchanged in behavior.
	setPublicSurfacePort(sampleWorkspaceGateway.api);
</script>

{@render children()}
