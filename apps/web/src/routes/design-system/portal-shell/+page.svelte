<script lang="ts">
	import accepted from '$lib/api/portal/sample/accepted';
	import { createPortalApi } from '$lib/api/portal/sample/api';
	import { setPortalGateway } from '$lib/api/portal/gateway';
	import { createSamplePortalFilesPort } from '$lib/api/files/sample';
	import { setPortalFilesPort } from '$lib/api/files/portal-files-port';
	import PortalShell from '$lib/features/portal/PortalShell.svelte';
	import PortalHome from '$lib/features/portal/PortalHome.svelte';

	/**
	 * The shipped participant chrome and home surface, as a design reference: one
	 * column, no rail, default density, and a bar carrying only the way home and
	 * the account. The world is pinned to the accepted scenario rather than the
	 * selected one, so this page shows the same thing to everyone who opens it.
	 *
	 * The shell admits through the sample entry, so a browser holding a
	 * signed-out sample session is sent to the entry surface here exactly as it
	 * would be in the portal.
	 */
	setPortalGateway({
		api: createPortalApi(structuredClone(accepted)),
		source: {
			kind: 'sample',
			scenario: { key: accepted.key, name: accepted.name, description: accepted.description }
		}
	});
	// The engagement panels carry a Materials section; the reference fulfils it
	// with the same sample files port the portal composition uses.
	setPortalFilesPort(createSamplePortalFilesPort());
</script>

<svelte:head>
	<title>Portal composition · JooEvents design system</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<PortalShell>
	<PortalHome />
</PortalShell>
