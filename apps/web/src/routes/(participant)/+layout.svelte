<script lang="ts">
	import ParticipantPortalRoot from 'jooevents-participant-portal-root';
	import PortalFrame from '$lib/features/portal/PortalFrame.svelte';

	let { children } = $props();

	// The participant lane composes its own data source and its own chrome, both
	// owned here so one instance survives every move inside the portal.
	//
	// No density is set: this surface is read a few times a year by someone who
	// never asked to learn a product, so it runs at the default metrics rather
	// than the internal-operations ones.
</script>

<ParticipantPortalRoot>
	<PortalFrame>
		{@render children()}
	</PortalFrame>
</ParticipantPortalRoot>
