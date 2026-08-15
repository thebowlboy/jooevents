<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setPortalFilesPort } from '../files/portal-files-port';
	import { createLivePortalFilesPort } from '../files/portal-files-port.live';
	import { setPortalGateway } from '../portal/gateway';
	import { createLivePortalApi, livePortalSource } from '../portal/portal-page-port.live';
	import { createDeferredPortalOperationsClient } from '../portal/live/deferred-operations-client';
	import { loadLiveOperationManifest, loadPortalFilesOperationManifest } from './manifest';

	let { children }: { children: Snippet } = $props();

	// The gateway must exist before the first child reads it, so the one
	// manifest read folds into the first operation call. A failed read is that
	// call's honest transport failure — retried by the next call — never a
	// fabricated world, and the entry screens need no manifest at all.
	setPortalGateway({
		api: createLivePortalApi({
			operations: createDeferredPortalOperationsClient({ loadManifest: loadLiveOperationManifest })
		}),
		source: livePortalSource
	});
	// The files capability rides the same deferred manifest posture, against
	// the portal files registry's OWN manifest (its operations share names
	// with the operator lane, so the main manifest cannot carry them):
	// bindings resolve on first use, and an installation that does not serve
	// files yet answers as a typed absence, never a fabricated world.
	setPortalFilesPort(createLivePortalFilesPort({ loadManifest: loadPortalFilesOperationManifest }));
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{@render children()}
