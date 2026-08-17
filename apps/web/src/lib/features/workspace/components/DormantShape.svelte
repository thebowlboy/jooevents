<script lang="ts">
	/**
	 * The quieted shape of a region that will exist but has nothing in it yet.
	 *
	 * A blank panel with one sentence in it makes a person read before they can
	 * tell whether something is missing, broken, or simply not started. The
	 * dormant shape answers that pre-verbally: it is the real composition — the
	 * same plot box, the same row rhythm — drawn in structural ink, so the
	 * region reads as *present and not yet running* before a word is parsed.
	 * The sentence beside it then only has to name the condition.
	 *
	 * Three states stay distinct and must never be conflated:
	 *
	 * - **skeleton** — data is on its way. Solid `ui-skeleton` fills standing in
	 *   for text and controls, and they shimmer.
	 * - **dormant** (this) — data is absent or the region has not begun. The
	 *   composition's silhouette in border ink: rules and bars, never
	 *   text-shaped blocks, and no animation at all. The distinction is carried
	 *   by *shape and ink*, never by movement — `prefers-reduced-motion` stops
	 *   the skeleton's shimmer, and a treatment separated only by animation
	 *   would collapse into the skeleton for exactly the readers who cannot see
	 *   motion.
	 * - **failure** — the read broke, and it keeps the alert treatment it has.
	 *
	 * The geometry is small, fixed, and hand-written: no randomness, no derived
	 * ratios, no axis labels, and nothing carrying a value. It cannot be read as
	 * a measurement because it is drawn in the border family, which no real
	 * series uses — real bars take the recessive ink and the current period
	 * takes full ink.
	 *
	 * Decorative by construction, so it is `aria-hidden`; the sentence its
	 * caller renders is the whole accessible answer.
	 *
	 * On the Overview panels the `rows` shape still read as loading despite
	 * the ink distinction, so those panels carry a worded situation note
	 * (glyph + sentence) instead. `bars` keeps its chart-slot job, where
	 * geometry parity with a real plot is the point.
	 */

	let {
		shape,
		rows = 4
	}: {
		/** `bars` mirrors the weekly plot; `rows` mirrors a ranked count list. */
		readonly shape: 'bars' | 'rows';
		/** How many ranked rows to suggest. Ignored by `bars`. */
		readonly rows?: number;
	} = $props();

	/**
	 * Twelve fixed heights, matching the plot's twelve weekly slots. Varied
	 * rather than uniform because a flat row would say "every week the same",
	 * which is a claim; varied-but-fixed reads as *a chart lives here* and
	 * carries no number a reader could take away.
	 */
	const BAR_HEIGHTS = Object.freeze([34, 46, 30, 54, 38, 62, 42, 50, 32, 58, 40, 48]);

	/** Descending, because the lists this stands in for are ranked. */
	const ROW_WIDTHS = Object.freeze([72, 54, 40, 28, 20, 16]);

	const rowWidths = $derived(
		Array.from(
			{ length: Math.max(1, rows) },
			(_, index) => ROW_WIDTHS[Math.min(index, ROW_WIDTHS.length - 1)]!
		)
	);
</script>

{#if shape === 'bars'}
	<span class="dormant dormant--bars" aria-hidden="true">
		{#each BAR_HEIGHTS as height, index (index)}
			<span class="dormant__slot">
				<span class="dormant__bar" style:block-size={`${height}%`}></span>
			</span>
		{/each}
	</span>
{:else}
	<span class="dormant dormant--rows" aria-hidden="true">
		{#each rowWidths as width, index (index)}
			<span class="dormant__row">
				<span class="dormant__fill" style:inline-size={`${width}%`}></span>
			</span>
		{/each}
	</span>
{/if}

<style>
	.dormant {
		display: flex;
		min-inline-size: 0;
	}

	/* The plot's own box, to the pixel: same height, same slot gap, same
	   baseline rule — so a dormant panel and a charting one sit on one line
	   across a band, and the region does not resize when data first lands. */
	.dormant--bars {
		align-items: flex-end;
		gap: 2px;
		block-size: 2.75rem;
		border-block-end: 1px solid var(--je-color-border);
		padding-block-end: 1px;
	}

	.dormant__slot {
		flex: 1;
		display: flex;
		align-items: flex-end;
		min-inline-size: 0;
		max-inline-size: 1.5rem;
		block-size: 100%;
	}

	/* Structural ink, deliberately a step below the recessive ink real bars
	   take. A reader never has to decide whether this is data; the colour
	   family answers it before the sentence does. */
	.dormant__bar {
		inline-size: 100%;
		border-radius: 2px 2px 0 0;
		background: var(--je-color-border-strong);
	}

	.dormant--rows {
		flex-direction: column;
	}

	/* The count list's row rhythm: the same block padding and the same hairline
	   between rows, so a resolved list drops into this footprint. */
	.dormant__row {
		display: flex;
		align-items: center;
		padding-block: var(--je-space-2);
		min-block-size: 1.75rem;
	}

	.dormant__row + .dormant__row {
		border-block-start: 1px solid var(--je-color-border);
	}

	.dormant__fill {
		display: block;
		block-size: 0.5rem;
		border-radius: 0 2px 2px 0;
		background: var(--je-color-border-strong);
	}
</style>
