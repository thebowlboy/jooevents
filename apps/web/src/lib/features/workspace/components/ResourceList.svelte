<script lang="ts">
	import { resourceKindIcon } from '$lib/ui';
	import type { SubmissionResource } from '$lib/api/types';

	/**
	 * Materials render or their absence is stated — the same component says
	 * both, so no surface can show materials only when there happen to be some.
	 * `compact` is the queue-card density: one line per item, no per-row
	 * action (rows become doors to the artifact once file storage lands).
	 */
	let {
		resources = [],
		density = 'default'
	}: { resources?: SubmissionResource[]; density?: 'default' | 'compact' } = $props();
</script>

{#if resources.length === 0}
	<p class="none">No materials attached to this submission.</p>
{:else}
	<ul class="list" class:list--compact={density === 'compact'}>
		{#each resources as resource (resource.name)}
			{@const Icon = resourceKindIcon[resource.kind]}
			<li class="row">
				<span class="row__icon" aria-hidden="true"><Icon size={14} /></span>
				<span class="row__copy">
					<span class="row__name">{resource.name}</span>
					<span class="row__detail">{resource.detail}</span>
				</span>
				{#if density === 'default'}
					<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled title="Opens once file storage lands">Open</button>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.none {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--je-space-2);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.row__icon {
		display: grid;
		place-items: center;
		inline-size: 1.75rem;
		block-size: 1.75rem;
		flex-shrink: 0;
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text-muted);
	}

	.row__copy {
		flex: 1;
		min-width: 0;
		display: grid;
	}

	.row__name {
		font-size: var(--je-font-size-sm);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row__detail {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* One line per item: the typed tile keeps the zone recognizable across
	   cards, the name and its qualifier share the line, and nothing else asks
	   for height on a surface that shows many submissions at once. */
	.list--compact {
		gap: var(--je-space-1);
	}

	.list--compact .row__icon {
		inline-size: 1.5rem;
		block-size: 1.5rem;
	}

	.list--compact .row__copy {
		display: flex;
		align-items: baseline;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.list--compact .row__name {
		flex-shrink: 1;
	}

	.list--compact .row__detail {
		white-space: nowrap;
	}
</style>
