<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createSamplePortalFilesPort } from '../files/sample';
	import { setPortalFilesPort } from '../files/portal-files-port';
	import { samplePortalGateway } from '../portal/sample/gateway';
	import { setPortalGateway } from '../portal/gateway';

	let { children }: { children: Snippet } = $props();
	setPortalGateway(samplePortalGateway);
	setPortalFilesPort(createSamplePortalFilesPort());
</script>

{@render children()}
