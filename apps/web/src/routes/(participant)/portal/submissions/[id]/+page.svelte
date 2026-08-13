<script lang="ts">
	import { page } from '$app/state';
	import PortalSubmission from '$lib/features/portal/PortalSubmission.svelte';
</script>

<svelte:head><title>Your submission · JooEvents</title></svelte:head>

<PortalSubmission id={page.params.id ?? ''} />
