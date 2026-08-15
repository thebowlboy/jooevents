<script lang="ts">
	/**
	 * The files attached to one subject, for the organizer: download inert,
	 * detach with an in-place arm (R6: destructive single row), and an undo on
	 * the receipt — detach is the compensation of attach, and blobs are
	 * refcounted, so re-attaching is honest recovery, not a pretence.
	 */
	import type { FilesPagePort } from '$lib/api/files/files-page-port';
	import type { MaterialItemView } from '$lib/api/files/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { filesRefusalSentence, linkProviderLabel, scanHonestyLabel } from './copy';

	let {
		items,
		subject,
		port,
		onchanged
	}: {
		items: readonly MaterialItemView[];
		subject:
			| { readonly kind: 'engagement'; readonly engagementId: string }
			| { readonly kind: 'resource_share'; readonly resourceShareId: string };
		port: FilesPagePort;
		onchanged: () => void;
	} = $props();

	let armedId = $state<string | null>(null);
	let busyId = $state<string | null>(null);
	let refusal = $state('');

	function itemName(item: MaterialItemView): string {
		return item.kind === 'file' ? item.name : item.label;
	}

	async function detach(item: MaterialItemView): Promise<void> {
		if (armedId !== item.attachmentId) {
			armedId = item.attachmentId;
			return;
		}
		if (busyId !== null) return;
		armedId = null;
		busyId = item.attachmentId;
		refusal = '';
		const outcome = await port.detach({
			attachmentId: item.attachmentId,
			expectedVersion: item.attachmentVersion
		});
		busyId = null;
		if (!outcome.ok) {
			refusal = filesRefusalSentence(outcome.reason);
			return;
		}
		const name = itemName(item);
		recordAction({
			label: `Removed “${name}”`,
			area: 'Files',
			undo: async () => {
				const restored = item.kind === 'file'
					? await port.reattach({ subject, assetId: item.assetId })
					: await port.relink({
							subject,
							provider: item.provider,
							label: item.label,
							url: item.url
						});
				if (!restored.ok) throw new Error('reattach_refused');
			}
		});
		onchanged();
	}
</script>

<ul class="panel" aria-label="Attached files">
	{#each items as item (item.attachmentId)}
		<li class="row" aria-busy={busyId === item.attachmentId || undefined}>
			<span class="row__name">{itemName(item)}</span>
			{#if item.kind === 'file'}
				<span class="row__meta">{item.sizeLabel} · {scanHonestyLabel[item.scan]}</span>
			{:else}
				<span class="row__meta">{linkProviderLabel[item.provider]}</span>
			{/if}
			<span class="row__actions">
				{#if item.kind === 'file'}
					{#if item.downloadable}
						{@const path = port.downloadPath(item.assetId)}
						{#if path}
							<a class="row__download" href={path}>Download</a>
						{/if}
					{/if}
				{:else}
					<a class="row__download" href={item.url} rel="noreferrer external" target="_blank">Open</a>
				{/if}
				<button
					type="button"
					class="ui-button ui-button--ghost ui-button--sm"
					class:row__remove--armed={armedId === item.attachmentId}
					disabled={busyId !== null}
					onclick={() => detach(item)}
					onblur={() => {
						if (armedId === item.attachmentId) armedId = null;
					}}>
					{busyId === item.attachmentId
						? 'Removing…'
						: armedId === item.attachmentId
							? 'Remove?'
							: 'Remove'}
				</button>
			</span>
		</li>
	{:else}
		<li class="row row--empty">Nothing attached yet.</li>
	{/each}
</ul>
{#if refusal}
	<p class="refusal" role="status">{refusal}</p>
{/if}

<style>
	.panel {
		display: grid;
		gap: var(--je-space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		padding-block: var(--je-space-1);
	}

	.row--empty {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.row__name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.row__meta {
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
	}

	.row__actions {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		margin-inline-start: auto;
	}

	.row__download {
		font-size: var(--je-font-size-sm);
		white-space: nowrap;
	}

	.row__remove--armed {
		color: var(--je-color-danger);
	}

	.refusal {
		margin: 0;
		color: var(--je-color-danger);
		font-size: var(--je-font-size-sm);
	}
</style>
