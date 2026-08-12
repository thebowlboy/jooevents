<script lang="ts">
	/**
	 * Text with the spans a search matched marked in place.
	 *
	 * This is the honest answer to "why is this row here", and it teaches the
	 * field scope without a legend: a person watching the hit land in the
	 * abstract learns the abstract is searched, and a person whose query matched
	 * nothing visible learns it matched something they cannot see.
	 *
	 * The ranges are computed by the shared matcher, so what is marked here and
	 * what the query selected cannot disagree.
	 */
	import { highlight, type MatchRange } from '../api/search';

	interface Props {
		text: string;
		/** Source-coordinate spans. Empty renders the text untouched. */
		ranges?: readonly MatchRange[];
	}

	let { text, ranges = [] }: Props = $props();

	const segments = $derived(highlight(text, ranges));
</script>

<span class="ui-marked-text"
	>{#each segments as segment, index (index)}{#if segment.match}<mark class="ui-marked"
				>{segment.text}</mark
			>{:else}{segment.text}{/if}{/each}</span
>

<style>
	/* One box around the whole run, so the segments are never laid out by the
	   parent. Without it a marked title inside `.ui-table__primary` (a grid)
	   puts every segment on its own row, and inside a flex row it spreads them
	   with the container's own gap — a match splitting one title into three
	   pieces. A text primitive cannot assume its parent is normal flow, and the
	   number of segments it renders must never be visible in the layout. */
	.ui-marked-text {
		display: inline;
		min-inline-size: 0;
	}

	/* The UA mark is a solid yellow block with its own colour; this keeps the
	   text in the row's own ink and paints only behind it, so a marked title
	   still reads as a title. Padding with an exactly cancelling negative
	   margin means the tint clears the glyphs without moving anything on the
	   line — the same hold-the-space-change-the-paint discipline as every other
	   feedback in the product. */
	.ui-marked {
		background: var(--je-color-search-match);
		color: inherit;
		border-radius: var(--je-radius-xs);
		padding: 0.1em 0.12em;
		margin-inline: -0.12em;
		/* A hit that wraps across a line keeps its tint on both fragments. */
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
	}
</style>
