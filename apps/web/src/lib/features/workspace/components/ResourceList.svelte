<script lang="ts">
	import { resourceKindIcon } from '$lib/ui';
	import type { SubmissionResource } from '$lib/api/types';

	let { resources = [] }: { resources?: SubmissionResource[] } = $props();
</script>

{#if resources.length === 0}
	<p class="none">No materials attached to this submission.</p>
{:else}
	<ul class="list">
		{#each resources as resource (resource.name)}
			{@const Icon = resourceKindIcon[resource.kind]}
			<li class="row">
				<span class="row__icon" aria-hidden="true"><Icon size={14} /></span>
				<span class="row__copy">
					<span class="row__name">{resource.name}</span>
					<span class="row__detail">{resource.detail}</span>
				</span>
				<button type="button" class="ui-button ui-button--secondary ui-button--sm" disabled title="Opens once file storage lands">Open</button>
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
</style>
