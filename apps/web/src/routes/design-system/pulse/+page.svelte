<script lang="ts">
	import { setWorkspaceGateway } from '$lib/api/workspace-gateway';
	import { sampleWorkspaceGateway } from '$lib/api/sample/gateway';
	import { createSamplePulsePagePort } from '$lib/api/pulse-page-port.sample';
	import { createSampleWorkspaceShellPort } from '$lib/api/workspace-shell-port.sample';
	import WorkspaceShell from '$lib/features/workspace/components/WorkspaceShell.svelte';
	import PulseDashboard from '$lib/features/workspace/components/PulseDashboard.svelte';

	setWorkspaceGateway(sampleWorkspaceGateway);
	const pulse = createSamplePulsePagePort({
		api: sampleWorkspaceGateway.api,
		scenario: sampleWorkspaceGateway.source.scenario
	});
	const shell = createSampleWorkspaceShellPort(sampleWorkspaceGateway);

	// The Pulse page rendered as a design reference at internal-operations
	// density with its sample dataset — heartbeat panels, the decision spread,
	// and the per-track fill, including each section's worded absence states
	// under the opening scenario.
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
	<title>Pulse · JooEvents design system</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<WorkspaceShell port={shell} title="Pulse" activePath="/app/pulse">
	<PulseDashboard port={pulse} />
</WorkspaceShell>
