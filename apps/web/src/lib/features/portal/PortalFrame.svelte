<script lang="ts">
	/**
	 * Which chrome the address gets.
	 *
	 * The portal's own screens sit inside the shell, which owns the account menu
	 * and the single read of the participant's world. The entry screens in the
	 * same namespace deliberately do not: nobody is signed in yet, so there is no
	 * account to show and nothing to read.
	 */
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import PortalShell from './PortalShell.svelte';

	let { children }: { children: Snippet } = $props();

	const entryRoutes = ['/portal/sign-in', '/portal/auth/complete'];
	const beforeEntry = $derived(
		entryRoutes.some((route) => page.url.pathname === route || page.url.pathname.startsWith(`${route}/`))
	);
</script>

{#if beforeEntry}
	{@render children()}
{:else}
	<PortalShell>
		{@render children()}
	</PortalShell>
{/if}
