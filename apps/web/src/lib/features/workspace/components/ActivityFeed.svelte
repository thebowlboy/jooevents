<script lang="ts">
	import { Bot } from 'lucide-svelte';
	import { DATE_CLASS, describeRecency, formatRelative } from '@jooevents/contracts';
	import { ClampedText } from '$lib/ui';
	import type { ActivityItem } from '$lib/api/types';

	let {
		items = [],
		limit,
		timezone = '',
		now = Date.now()
	}: {
		items?: ActivityItem[];
		limit?: number;
		/** The event's zone. Distances are counted in it, never in the reader's. */
		timezone?: string;
		/** One clock reading for the panel, so no two rows disagree by a tick. */
		now?: number;
	} = $props();

	const shown = $derived(limit === undefined ? items : items.slice(0, limit));

	/**
	 * The distance in words, from the one date vocabulary. The feed used to be
	 * handed pre-rendered strings — `18 min ago` from a sample dataset, `6 hr
	 * ago` from the live port — two spellings of one unit on one surface, both
	 * ageing the moment they were written.
	 *
	 * The absolute stays reachable beside it, because a relative string stops
	 * being a record of anything after a couple of days. It is supplementary
	 * here, not the carrier: the visible words already answer "is this fresh?".
	 */
	function when(item: ActivityItem) {
		const described = timezone === '' ? null : describeRecency({ at: item.at, timezone, now });
		if (described) return described;
		const relative = formatRelative(item.at, now, { fallback: '' });
		return { relative, absolute: '', machine: '', title: '', accessibleText: relative };
	}

	const initials = (name: string) =>
		name
			.split(' ')
			.map((part) => part[0])
			.slice(0, 2)
			.join('');
</script>

<ol class="feed">
	{#each shown as item (item.id)}
		{@const at = when(item)}
		<li class="feed__row">
			{#if item.actor === 'agent'}
				<!-- The robot mark is the agent attribution; it carries the name an
				     assistive reader needs, so no second badge repeats it. -->
				<span class="ui-avatar ui-avatar--sm feed__avatar feed__avatar--agent" role="img" aria-label="Agent">
					<Bot size={13} aria-hidden="true" />
				</span>
			{:else}
				<span class="ui-avatar ui-avatar--sm feed__avatar" aria-hidden="true">{initials(item.name)}</span>
			{/if}
			<ClampedText lines={2} expandFromSurface label={item.name}>
				{#snippet children()}
					<strong>{item.name}</strong>
					{item.text}
					{#if at.relative !== ''}
						<time
							class="feed__time {DATE_CLASS.column}"
							datetime={at.machine}
							title={at.absolute}>· {at.relative}</time>
					{/if}
				{/snippet}
			</ClampedText>
		</li>
	{/each}
</ol>

<style>
	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	/* Two columns only: the avatar rail and everything else. The timestamp ends
	   the sentence inline, so a row that fits on one line costs one line — the
	   footer exists only when a clipped entry needs its toggle. */
	.feed__row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: var(--je-space-2);
		padding-block: var(--je-space-2);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.feed__row + .feed__row {
		border-top: 1px solid var(--je-color-border-subtle);
	}

	/* Anchored to the first text line rather than the row box: the first line
	   starts at the same offset in every row, so the rail stays straight across
	   natural row heights and the mark holds still when an entry expands
	   downward. The offset centres the 1.5rem mark on one line of row text. */
	.feed__avatar {
		margin-block-start: calc((var(--je-font-size-sm) * var(--je-leading-normal) - 1.5rem) / 2);
	}

	.feed__avatar--agent {
		background: var(--je-color-accent-lavender-soft);
		color: var(--je-color-accent-lavender-strong);
	}

	.feed__row strong {
		color: var(--je-color-text);
		font-weight: 600;
	}

	/* Figures and wrapping come from the shared date column; only ink is local. */
	.feed__time {
		color: var(--je-color-text-subtle);
	}
</style>
