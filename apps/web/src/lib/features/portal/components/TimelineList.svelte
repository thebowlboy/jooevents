<script lang="ts">
	/**
	 * What has happened to one submission, oldest first.
	 *
	 * The list only ever grows downward: a correction appends an entry saying a
	 * correction was made, and nothing already written is edited or removed. That
	 * is the whole promise of the record — someone can read it top to bottom and
	 * see the order events actually happened in, including their own.
	 *
	 * Each entry says who acted in its own sentence, so nothing repeats that as a
	 * label beside it.
	 */
	import type { PortalTimelineEventView } from '$lib/api/portal/view-models';
	import { formatInstant } from '../format';

	let {
		events,
		timezone
	}: { events: readonly PortalTimelineEventView[]; timezone: string } = $props();

	const ordered = $derived(
		events.slice().sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
	);
</script>

<ol class="history">
	{#each ordered as event (event.id)}
		<li class="history__entry">
			<time class="history__time" datetime={event.occurredAt}>
				{formatInstant(event.occurredAt, timezone)}
			</time>
			<p class="history__summary">{event.summary}</p>
		</li>
	{/each}
</ol>

<style>
	.history {
		display: grid;
		gap: var(--je-space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The rail is one continuous line down the entries, so the order reads as a
	   sequence rather than as a stack of separate notes. */
	.history__entry {
		position: relative;
		display: grid;
		gap: var(--je-space-1);
		padding-inline-start: var(--je-space-5);
	}

	.history__entry::before {
		content: '';
		position: absolute;
		inset-inline-start: 0.28rem;
		inset-block: 0.55rem calc(-1 * var(--je-space-4));
		inline-size: 1px;
		background: var(--je-color-border);
	}

	.history__entry:last-child::before {
		display: none;
	}

	.history__entry::after {
		content: '';
		position: absolute;
		inset-inline-start: 0;
		inset-block-start: 0.35rem;
		inline-size: 0.45rem;
		block-size: 0.45rem;
		border-radius: var(--je-radius-round);
		background: var(--je-color-border-strong);
	}

	.history__time {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.history__summary {
		margin: 0;
		line-height: var(--je-leading-normal);
		max-inline-size: 62ch;
	}
</style>
