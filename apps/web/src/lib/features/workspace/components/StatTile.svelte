<script lang="ts">
	/**
	 * One figure in the Overview's key-numbers band: what it is, what it reads,
	 * how far along it is, and what that figure is composed of.
	 *
	 * The meter is drawn only where a real denominator exists. A ratio invented
	 * to give a tile a bar is worse than no bar — it makes an absence of
	 * measurement look like a measurement — and the digits stay in `sub` either
	 * way, so the bar is a second channel rather than the only one.
	 *
	 * Health is one input, not two. The sub-line's ink and the meter's fill are
	 * the same claim about the same figure, and giving them separate props is
	 * how a tile ends up amber above a green bar.
	 */
	import type { Snippet } from 'svelte';
	import { Meter } from '$lib/ui';
	import type { StatusTone } from '$lib/ui';

	interface Props {
		label: string;
		value: string;
		sub?: string;
		health?: 'ok' | 'attention' | 'blocked';
		progress?: { done: number; required: number };
		/**
		 * A figure that rides the value's own line, pushed to its end — a
		 * sparkline beside the number it plots. It goes here rather than on a row
		 * of its own because a row of its own is what made this tile 57px taller
		 * than its neighbours, and a band of four tiles with white space under
		 * three of them reads as a layout fault rather than as a figure.
		 */
		valueAside?: Snippet;
		/** Anything the figure carries beneath its own line — a delta, a note. */
		footer?: Snippet;
		/**
		 * Hold this tile's shape while the figure is still being read.
		 *
		 * The placeholder is this composition's own markup with skeleton fills
		 * rather than a hand-sized rectangle, so its geometry comes from the same
		 * CSS as the resolved tile and cannot drift from it. Which rows exist is
		 * decided by the same props the resolved tile takes — a tile that will
		 * carry a meter holds a meter's height, one that will not does not.
		 */
		pending?: boolean;
	}

	let {
		label,
		value,
		sub,
		health,
		progress,
		valueAside,
		footer,
		pending = false
	}: Props = $props();

	const tone: Record<'ok' | 'attention' | 'blocked', StatusTone> = {
		ok: 'positive',
		attention: 'caution',
		blocked: 'negative'
	};

	const percent = $derived(
		progress && progress.required > 0
			? Math.max(0, Math.min(100, Math.round((progress.done / progress.required) * 100)))
			: null
	);
</script>

<article class="tile">
	<span class="tile__label"
		>{#if pending}<span class="ui-skeleton tile__fill" style="inline-size: 5.5rem"></span>{:else}{label}{/if}</span>
	<span class="tile__value">
		<span class="tile__figure"
			>{#if pending}<span class="ui-skeleton tile__fill" style="inline-size: 3.5rem"></span>{:else}{value}{/if}</span>
		{#if valueAside}{@render valueAside()}{/if}
	</span>
	{#if pending && progress}
		<span class="ui-meter"></span>
	{:else if percent !== null && progress}
		<Meter
			value={percent}
			label={`${label}: ${progress.done} of ${progress.required}`}
			valueText={`${progress.done} of ${progress.required}`}
			tone={health ? tone[health] : 'neutral'} />
	{/if}
	{#if pending && sub}
		<span class="tile__sub"><span class="ui-skeleton tile__fill" style="inline-size: 9rem"></span></span>
	{:else if sub}
		<!-- Ink only where there is no meter. With a bar above it, the health is
		     already carried once, and tinting the sentence too is the same fact
		     encoded twice — which is how a tile ends up shouting a figure that is
		     merely in progress. -->
		<span
			class="tile__sub"
			class:tile__sub--attention={health === 'attention' && !progress}
			class:tile__sub--blocked={health === 'blocked' && !progress}>{sub}</span>
	{/if}
	{#if footer}{@render footer()}{/if}
</article>

<style>
	.tile {
		display: grid;
		gap: var(--je-space-1);
		align-content: start;
		padding: var(--je-space-3) var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.tile__label {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* A column of figures the eye runs down, so tabular figures — and a value
	   that can change under a reader must not make the tiles beside it jitter. */
	.tile__value {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-inline-size: 0;
		font-size: var(--je-font-size-xl);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: var(--je-leading-tight);
	}

	/* The number keeps its own width; anything riding beside it takes the rest
	   and shrinks first, so a long figure never gets squeezed by its own plot. */
	.tile__figure {
		flex: 0 0 auto;
	}

	.tile__sub {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* The word is already there; the ink only ranks it against its neighbours. */
	.tile__sub--attention {
		color: var(--je-color-warning);
		font-weight: 600;
	}

	.tile__sub--blocked {
		color: var(--je-color-danger);
		font-weight: 600;
	}

	/* One line box exactly, inside the element whose line it replaces. */
	.tile__fill {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}
</style>
