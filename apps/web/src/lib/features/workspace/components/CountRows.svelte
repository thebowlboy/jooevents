<script lang="ts" generics="T">
	/**
	 * A list of labelled counts with a quiet magnitude bar: the Pulse page's
	 * shared row shape for the decision spread and the per-track fill.
	 *
	 * Identity is carried by the lead cell (a badge, a track chip) and the
	 * digits carry the absolute; the bar is a second channel for comparison
	 * down the list, so it stays in neutral ink — these counts are not
	 * statuses, and colouring the bars would restate what the lead already
	 * says. Columns are declared once on the list and each row opts in with
	 * subgrid, so lead cells of different widths still resolve to one set of
	 * tracks.
	 */
	import type { Snippet } from 'svelte';

	let {
		rows,
		value,
		lead,
		digits
	}: {
		readonly rows: readonly T[];
		/** The magnitude the bar draws, per row. */
		readonly value: (row: T) => number;
		readonly lead: Snippet<[T]>;
		readonly digits: Snippet<[T]>;
	} = $props();

	const peak = $derived(Math.max(1, ...rows.map(value)));

	/** Floored so a row with something never renders as a row with nothing. */
	function barWidth(row: T): string {
		const count = value(row);
		if (count === 0) return '0';
		return `${Math.max(4, Math.round((count / peak) * 100))}%`;
	}
</script>

<ul class="crows">
	{#each rows as row, index (index)}
		<li class="crows__row">
			<span class="crows__lead">{@render lead(row)}</span>
			<span class="crows__bar" aria-hidden="true">
				<span class="crows__fill" style:inline-size={barWidth(row)}></span>
			</span>
			<span class="crows__digits">{@render digits(row)}</span>
		</li>
	{/each}
</ul>

<style>
	.crows {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.crows__row {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: subgrid;
		align-items: center;
		column-gap: var(--je-space-3);
		padding-block: var(--je-space-2);
	}

	.crows__row + .crows__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.crows__lead {
		display: flex;
		align-items: center;
		min-inline-size: 0;
	}

	.crows__bar {
		display: block;
		min-inline-size: 0;
	}

	/* A thin neutral mark with a rounded data end, anchored to the start. */
	.crows__fill {
		display: block;
		block-size: 0.5rem;
		border-radius: 0 2px 2px 0;
		background: var(--je-color-text-subtle);
	}

	/* The digits are compared down the list, so they align at the row's end,
	   at full ink, in tabular figures. */
	.crows__digits {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		text-align: end;
		white-space: nowrap;
	}

	/* Narrow widths restructure rather than squeeze: lead and digits share the
	   first line, the bar takes its own full line beneath — the copy column is
	   never crushed between two fixed-width neighbours. */
	@media (max-width: 920px) {
		.crows {
			grid-template-columns: minmax(0, 1fr) max-content;
		}

		.crows__row {
			grid-template-columns: subgrid;
			row-gap: var(--je-space-1);
		}

		.crows__lead {
			grid-row: 1;
			grid-column: 1;
		}

		.crows__digits {
			grid-row: 1;
			grid-column: 2;
			/* A long qualifier clause wraps under the count rather than pushing
			   the row past the viewport beside a long lead chip. */
			white-space: normal;
		}

		.crows__bar {
			grid-row: 2;
			grid-column: 1 / -1;
		}
	}
</style>
