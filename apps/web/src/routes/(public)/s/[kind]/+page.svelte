<script lang="ts">
	import { page } from '$app/state';
	import PublicSurfacePage from 'jooevents-public-surface-page';
	import type { SurfaceKind } from '$lib/api/types';

	/**
	 * `/s/apply`, `/s/schedule`, `/s/speakers` — the hosted address of a public
	 * surface. The path segment is the public word for the page, not the internal
	 * kind: an organizer hands out `/s/apply`, and the route resolves it.
	 */
	const ROUTES: Record<string, SurfaceKind> = {
		apply: 'application-form',
		schedule: 'schedule',
		speakers: 'speaker-roster'
	};

	const kind = $derived(ROUTES[page.params.kind ?? '']);
</script>

<!-- An address that names no surface stays off the search index either way;
     there is nothing there to route a visitor to. A published page replaces
     both of these from its own data — its hero title, and the event's own
     indexing setting. -->
<svelte:head>
	{#if !kind}
		<title>Page not found</title>
		<meta name="robots" content="noindex, nofollow" />
	{/if}
</svelte:head>

{#if kind}
	<PublicSurfacePage {kind} />
{:else}
	<div class="notfound">
		<p class="notfound__title">This page doesn’t exist.</p>
		<p class="notfound__copy">The link may be mistyped, or the page was never published.</p>
	</div>
{/if}

<style>
	.notfound {
		display: grid;
		gap: var(--je-space-2);
		align-content: center;
		justify-items: center;
		min-block-size: 100dvh;
		padding: var(--je-space-6);
		text-align: center;
	}

	.notfound__title {
		margin: 0;
		font-size: var(--je-font-size-lg);
		font-weight: 650;
	}

	.notfound__copy {
		margin: 0;
		color: var(--je-color-text-muted);
	}
</style>
