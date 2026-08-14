<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setPortalGateway } from '../portal/gateway';
	import { createLivePortalApi, livePortalSource } from '../portal/portal-page-port.live';
	import { createDeferredPortalOperationsClient } from '../portal/live/deferred-operations-client';
	import { loadLiveOperationManifest } from './manifest';

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
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{@render children()}
