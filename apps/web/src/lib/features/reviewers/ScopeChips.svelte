<script lang="ts">
	/**
	 * A reviewer's scope, rendered in the referenced entities' own voices:
	 * track chips carry the track's accent, session chips carry a lifecycle
	 * badge while collecting, format chips stay neutral, and a ref pointing at
	 * a retired entry is flagged quietly rather than dropped. An empty scope
	 * renders as words — the generalist default is the absence of scope, and
	 * words say that more honestly than an invented chip. The words themselves
	 * are the caller's: under the roster's "Reviews" column header "Everything"
	 * completes the sentence the header started, while a card with no header
	 * carries the full "Reviews everything".
	 */
	import type { ScopeDisplay } from './scope-display';

	let {
		entries,
		allLabel = 'Reviews everything'
	}: { entries: ScopeDisplay[]; allLabel?: string } = $props();
</script>

{#if entries.length === 0}
	<span class="all">{allLabel}</span>
{:else}
	<span class="chips">
		{#each entries as entry (entry.key)}
			<span class="chip">
				<span class="ui-badge ui-badge--{entry.accent}">
					{entry.label}{#if entry.retired}<span class="chip__flag">retired</span>{/if}
				</span>
				{#if entry.collecting}
					<span class="ui-badge ui-badge--info">Collecting</span>
				{/if}
			</span>
		{/each}
	</span>
{/if}

<style>
	.all {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.chips {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-1) var(--je-space-2);
	}

	/* A session chip and its lifecycle badge are one fact, so they travel as a
	   unit: the pair never wraps apart. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		white-space: nowrap;
	}

	/* The quiet flag: the entry keeps rendering permanently, and the flag only
	   says its target is no longer offered — a hint, not an alarm. */
	.chip__flag {
		margin-inline-start: var(--je-space-1);
		font-size: var(--je-font-size-2xs);
		font-weight: 400;
		color: var(--je-color-text-muted);
	}
</style>
