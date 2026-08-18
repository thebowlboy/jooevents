<script lang="ts">
	import { onMount } from 'svelte';
	import type { SessionDetailView } from './program-discovery';

	interface Props {
		detail: SessionDetailView;
		onClose: () => void;
	}

	let { detail, onClose }: Props = $props();

	let heading = $state<HTMLElement | null>(null);

	onMount(() => {
		heading?.focus();
	});
</script>

<section class="detail" aria-labelledby="public-session-title">
	<div class="detail__head">
		<h2 id="public-session-title" class="detail__title" tabindex="-1" bind:this={heading}>
			{detail.title}
		</h2>
		<button type="button" class="ui-button ui-button--secondary" onclick={onClose}>Close</button>
	</div>

	<dl class="detail__facts">
		{#if detail.timeLabel || detail.dayLabel}
			<div class="detail__fact">
				<dt>When</dt>
				<dd>{[detail.dayLabel, detail.timeLabel].filter(Boolean).join(' · ')}</dd>
			</div>
		{:else}
			<div class="detail__fact">
				<dt>When</dt>
				<dd class="detail__missing">A time has not been published yet.</dd>
			</div>
		{/if}
		<div class="detail__fact">
			<dt>Room</dt>
			<dd class:detail__missing={!detail.roomName}>
				{detail.roomName ?? 'A room has not been published yet.'}
			</dd>
		</div>
		<div class="detail__fact">
			<dt>Track</dt>
			<dd class:detail__missing={!detail.trackName}>
				{detail.trackName ?? 'A track has not been published yet.'}
			</dd>
		</div>
		<div class="detail__fact">
			<dt>Format</dt>
			<dd class:detail__missing={!detail.formatName}>
				{detail.formatName ?? 'A format has not been published yet.'}
			</dd>
		</div>
		<div class="detail__fact">
			<dt>Length</dt>
			<dd>{detail.durationMin} minutes</dd>
		</div>
		<div class="detail__fact">
			<dt>Speakers</dt>
			<dd class:detail__missing={detail.speakerNames.length === 0}>
				{detail.speakerNames.length > 0
					? detail.speakerNames.join(', ')
					: 'Speakers have not been published yet.'}
			</dd>
		</div>
	</dl>

	<div class="detail__description">
		<h3 class="detail__subtitle">Description</h3>
		<p class="detail__missing">{detail.description.message}</p>
	</div>
</section>

<style>
	.detail {
		display: grid;
		gap: var(--je-space-4);
		min-inline-size: 0;
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border-strong);
		border-radius: var(--je-radius-control);
		padding: var(--je-space-5);
	}

	.detail__head {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		justify-content: space-between;
		gap: var(--je-space-3);
	}

	.detail__title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: 1.35rem;
		font-weight: 700;
		line-height: var(--je-leading-snug);
		overflow-wrap: anywhere;
	}

	.detail__title:focus {
		outline: none;
	}

	.detail__title:focus-visible {
		box-shadow: var(--je-focus-ring);
		border-radius: 2px;
	}

	.detail__facts {
		margin: 0;
		display: grid;
		gap: var(--je-space-3);
	}

	.detail__fact {
		display: grid;
		gap: 0.15rem;
		min-inline-size: 0;
	}

	.detail__fact dt {
		font-size: 0.75rem;
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.detail__fact dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.detail__subtitle {
		margin: 0 0 var(--je-space-2);
		font-size: 0.75rem;
		font-weight: 650;
		color: var(--je-color-text-muted);
	}

	.detail__description p {
		margin: 0;
	}

	.detail__missing {
		font-style: italic;
		color: var(--je-color-text-muted);
	}

	@container (min-width: 40rem) {
		.detail__facts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.detail__description {
			grid-column: 1 / -1;
		}
	}
</style>
