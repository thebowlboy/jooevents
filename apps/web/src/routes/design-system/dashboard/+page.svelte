<script lang="ts">
	import { setWorkspaceGateway } from '$lib/api/workspace-gateway';
	import { sampleWorkspaceGateway } from '$lib/api/sample/gateway';
	import WorkspaceShell from '$lib/features/workspace/components/WorkspaceShell.svelte';
	import OverviewDashboard from '$lib/features/workspace/components/OverviewDashboard.svelte';

	setWorkspaceGateway(sampleWorkspaceGateway);

	// The shipped operator shell, rendered as a design reference at
	// internal-operations density with its sample dataset.
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
	<title>Workspace shell · JooEvents design system</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<WorkspaceShell title="Overview" activePath="/app">
	<OverviewDashboard />
</WorkspaceShell>
