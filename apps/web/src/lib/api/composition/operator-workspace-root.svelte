<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolveDataset } from '../sample/registry';
	import { sampleWorkspaceGateway } from '../sample/gateway';
	import { setWorkspaceGateway } from '../workspace-gateway';
	import { createSampleWorkspaceShellPort } from '../workspace-shell-port.sample';
	import WorkspaceShell from '$lib/features/workspace/components/WorkspaceShell.svelte';
	import { createSampleWorkspacePorts, setSampleWorkspacePorts } from './sample-workspace';

	let { children }: { children: Snippet } = $props();
	setWorkspaceGateway(sampleWorkspaceGateway);
	const ports = setSampleWorkspacePorts(createSampleWorkspacePorts(resolveDataset()));
	const shell = createSampleWorkspaceShellPort(sampleWorkspaceGateway);

	function resetSample() {
		ports.reset();
		location.reload();
	}
</script>

<WorkspaceShell port={shell} onResetSample={resetSample}>
	{@render children()}
</WorkspaceShell>
