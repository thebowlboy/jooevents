<script lang="ts">
	import type { Snippet } from 'svelte';
	import LiveWorkspaceComposition from './LiveWorkspaceComposition.svelte';
	import LiveWorkspaceGate from '$lib/features/workspace/components/LiveWorkspaceGate.svelte';

	let { children: route }: { children: Snippet } = $props();
</script>

<LiveWorkspaceGate>
	{#snippet children(ready)}
		<LiveWorkspaceComposition {ready}>
			{@render route()}
		</LiveWorkspaceComposition>
	{/snippet}
</LiveWorkspaceGate>
