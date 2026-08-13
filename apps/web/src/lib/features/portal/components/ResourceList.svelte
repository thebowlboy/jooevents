<script lang="ts">
	/**
	 * What the organizers have published for the people speaking: handbooks,
	 * stage notes, the guide to what they look for. Reference material, so each
	 * row is one link and says what kind of thing sits behind it.
	 */
	import { resourceKindIcon } from '$lib/ui';
	import type { PortalResourceView } from '$lib/api/portal/view-models';

	let { resources }: { resources: readonly PortalResourceView[] } = $props();
</script>

<ul class="resources">
	{#each resources as resource (resource.id)}
		{@const KindIcon = resourceKindIcon[resource.kind]}
		<li class="resources__item">
			<span class="resources__mark" aria-hidden="true"><KindIcon size={16} /></span>
			<a class="resources__link" href={resource.url} target="_blank" rel="noreferrer noopener">
				{resource.title}
			</a>
			{#if resource.detail}<span class="resources__detail">{resource.detail}</span>{/if}
		</li>
	{/each}
</ul>

<style>
	.resources {
		display: grid;
		gap: var(--je-space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.resources__item {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: baseline;
		gap: var(--je-space-1) var(--je-space-2);
	}

	.resources__mark {
		grid-row: span 2;
		display: inline-flex;
		align-self: start;
		padding-block-start: 0.1rem;
		color: var(--je-color-text-muted);
	}

	.resources__link {
		color: var(--je-color-link);
	}

	.resources__detail {
		grid-column: 2;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}
</style>
