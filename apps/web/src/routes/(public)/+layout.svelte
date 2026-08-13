<script lang="ts">
	import PublicSurfaceRoot from 'jooevents-public-surface-root';

	let { children } = $props();
</script>

<PublicSurfaceRoot>
	{@render children()}
</PublicSurfaceRoot>
