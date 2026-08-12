<script lang="ts">
	/**
	 * Where one score stands in its slice, as a mark a dense row can carry: the
	 * pack drawn at a countable size, this submission's place inside it, and the
	 * exact numbers one press away.
	 *
	 * Two channels, two meanings. Every plotted point is inked by its own value
	 * on the absolute good/bad ramp, so a pack that is uniformly weak looks weak;
	 * the focus marker keeps the relative band, strengthened so it dominates the
	 * tinted pack it sits in. The figure beside it stays the absolute number,
	 * because that is what a person quotes.
	 */
	import { Popover } from '$lib/ui';
	import { tintStep } from '$lib/api/standing';
	import type { ScoreStanding } from '$lib/api/types';

	interface Props {
		/** Null renders nothing: no population, no claim, no mark. */
		standing: ScoreStanding | null;
		/** `mark` is the strip alone, `figure` the numeral and phrase, `both` pairs them. */
		form?: 'mark' | 'figure' | 'both';
		/** Inline size of the strip, endpoint numerals included. */
		stripWidth?: string;
		/**
		 * What this standing belongs to (usually the submission title). Set aside
		 * into the disclosure's accessible name so two rows sharing an average
		 * stay distinguishable to speech input and the rotor.
		 */
		context?: string;
		/**
		 * Table-cell composition: the pack and the numeral only. Every sentence
		 * stays in the panel, and the strip drops its endpoint numerals — a
		 * dense cell has no line to give them, and prose trailing a cell's own
		 * suffix reads as one broken sentence.
		 */
		quiet?: boolean;
	}

	let { standing, form = 'both', stripWidth = '11rem', context, quiet = false }: Props = $props();

	const popLabel = $derived(
		standing
			? `${standing.value} of ${standing.scaleMax}${context ? ` for “${context}”` : ''}, standing details`
			: ''
	);

	/* --------------------------------------------------------------- geometry */

	/* One 240 × 22 field for both plotted forms, so a strip and a histogram in
	   the same column sit on the same baseline and read as one system. */
	const PLOT_X = 6;
	const PLOT_W = 228;
	const CELLS = 48;
	const CELL_W = PLOT_W / CELLS;
	const STACK = 4;
	const BASELINE = 19;
	const ROW_Y = 16.5;
	const BAR_SLOT = 10;
	const BAR_W = 8;
	const BAR_MAX = 15;
	const BAR_MIN = 1.5;

	/** Position on the scale, 0 at 1 and 1 at the scale's top. */
	function share(value: number, scaleMax: number): number {
		const span = scaleMax - 1;
		return Math.min(1, Math.max(0, span > 0 ? (value - 1) / span : 0));
	}

	function stripX(value: number, scaleMax: number): number {
		return PLOT_X + share(value, scaleMax) * PLOT_W;
	}

	/** The histogram fills its own 240 units, so its focus uses that mapping. */
	function barsX(value: number, scaleMax: number): number {
		return Math.min(236, Math.max(4, share(value, scaleMax) * 240));
	}

	/* ------------------------------------------------------------------- ink */

	/* Five steps of one ramp: bad is warm, good is green, the middle is quiet.
	   `tintStep` is the shared arithmetic, so the mark and any other surface
	   drawing the same values cannot drift apart. */
	const ramp = [
		{ fill: 'var(--je-color-danger-fill)', opacity: 0.7 },
		{ fill: 'var(--je-color-warning-fill)', opacity: 0.7 },
		{ fill: 'var(--je-color-text-subtle)', opacity: 0.5 },
		{ fill: 'var(--je-color-success-fill)', opacity: 0.45 },
		{ fill: 'var(--je-color-success-fill)', opacity: 0.8 }
	];

	interface Dot {
		cx: number;
		cy: number;
		fill: string;
		opacity: number;
	}

	/** Values are quantized into cells and stacked, four deep at most. */
	function dotsOf(points: number[], scaleMax: number): Dot[] {
		const stacked = new Array<number>(CELLS).fill(0);
		const out: Dot[] = [];
		for (const value of [...points].sort((a, b) => a - b)) {
			const cell = Math.min(
				CELLS - 1,
				Math.max(0, Math.floor(share(value, scaleMax) * CELLS))
			);
			const depth = stacked[cell];
			stacked[cell] += 1;
			if (depth >= STACK) continue;
			const tint = ramp[tintStep(value, scaleMax)];
			// The capped top dot is inked heavier: the cell holds more than it shows.
			const capped = depth === STACK - 1;
			out.push({
				cx: PLOT_X + (cell + 0.5) * CELL_W,
				cy: ROW_Y - depth * 4.5,
				fill: tint.fill,
				opacity: capped ? Math.min(0.9, tint.opacity + 0.2) : tint.opacity
			});
		}
		return out;
	}

	interface Bar {
		x: number;
		y: number;
		height: number;
		fill: string;
		opacity: number;
	}

	/** Bars are tinted by their own bin's centre value, on the same ramp. */
	function barsOf(bins: number[], scaleMax: number): Bar[] {
		const tallest = Math.max(...bins, 1);
		const span = scaleMax - 1;
		const out: Bar[] = [];
		bins.forEach((count, index) => {
			if (count === 0) return;
			const height = Math.max(BAR_MIN, (count / tallest) * BAR_MAX);
			const centre = 1 + ((index + 0.5) / bins.length) * span;
			const tint = ramp[tintStep(centre, scaleMax)];
			out.push({
				x: index * BAR_SLOT + 1,
				y: BASELINE - height,
				height,
				fill: tint.fill,
				opacity: tint.opacity
			});
		});
		return out;
	}

	/* ----------------------------------------------------------------- words */

	function reviewCount(reviews: number): string {
		return `${reviews} review${reviews === 1 ? '' : 's'}`;
	}

	function dotNote(dotK: number): string {
		return dotK > 1 ? `each dot ≈ ${dotK} submissions` : 'one dot per scored submission';
	}
</script>

{#snippet lines(s: ScoreStanding)}
	<p class="line line--lead">{s.value} average of {reviewCount(s.reviews)}</p>
	<p class="line">{s.phrase}</p>
	<p class="line line--meta">
		{s.slice.label} · median {s.median.toFixed(1)} of {s.n} scored
	</p>
	{#if s.points}
		<p class="line line--meta">{dotNote(s.dotK ?? 1)}</p>
	{/if}
{/snippet}

{#snippet plot(s: ScoreStanding)}
	<span class="strip">
		{#if !quiet}<span class="strip__end">1</span>{/if}
		<svg class="strip__viz" viewBox="0 0 240 22" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
			{#if s.points}
				<line
					x1={PLOT_X}
					y1={BASELINE}
					x2={PLOT_X + PLOT_W}
					y2={BASELINE}
					stroke="var(--je-color-border)"
					stroke-width="1" />
				{#each dotsOf(s.points, s.scaleMax) as dot, index (index)}
					<circle cx={dot.cx} cy={dot.cy} r="2" fill={dot.fill} opacity={dot.opacity} />
				{/each}
				<circle
					class="pulse"
					cx={stripX(s.value, s.scaleMax)}
					cy={ROW_Y}
					r="3.5"
					fill="none"
					stroke="var(--sm-marker)"
					stroke-width="1.5"
					vector-effect="non-scaling-stroke" />
				<circle
					cx={stripX(s.value, s.scaleMax)}
					cy={ROW_Y}
					r="3.5"
					fill="var(--sm-marker)"
					stroke="var(--je-color-surface)"
					stroke-width="1.5" />
			{:else if s.bins}
				{#each barsOf(s.bins, s.scaleMax) as bar, index (index)}
					<rect
						x={bar.x}
						y={bar.y}
						width={BAR_W}
						height={bar.height}
						fill={bar.fill}
						opacity={bar.opacity} />
				{/each}
				<line
					x1={barsX(s.value, s.scaleMax)}
					y1="2"
					x2={barsX(s.value, s.scaleMax)}
					y2={BASELINE}
					stroke="var(--sm-marker)"
					stroke-width="1.5" />
				<circle
					class="pulse"
					cx={barsX(s.value, s.scaleMax)}
					cy={ROW_Y}
					r="3.5"
					fill="none"
					stroke="var(--sm-marker)"
					stroke-width="1.5"
					vector-effect="non-scaling-stroke" />
				<circle
					cx={barsX(s.value, s.scaleMax)}
					cy={ROW_Y}
					r="3.5"
					fill="var(--sm-marker)"
					stroke="var(--je-color-surface)"
					stroke-width="1.5" />
			{/if}
		</svg>
		{#if !quiet}<span class="strip__end">{s.scaleMax}</span>{/if}
	</span>
{/snippet}

{#snippet figure(s: ScoreStanding)}
	<span class="fig">
		<span class="fig__num">{s.value.toFixed(1)}</span>
		{#if !quiet}<span class="fig__phrase">{s.phrase}</span>{/if}
	</span>
{/snippet}

{#if standing}
	<span
		class="mark"
		class:band-top={standing.band === 'top'}
		class:band-upper={standing.band === 'upper'}
		class:band-mid={standing.band === 'mid'}
		class:band-lower={standing.band === 'lower'}
		class:band-bottom={standing.band === 'bottom'}
		class:band-few={standing.band === 'few'}
		style:--sm-strip={stripWidth}>
		{#if form !== 'figure'}
			<span class="mark__plot">
				<!-- The wrapper decides the strip's width, so the button spans it. -->
				<Popover label={popLabel} kind="figure" fill>
					{#snippet trigger()}
						{@render plot(standing)}
					{/snippet}
					{#snippet children()}
						{@render lines(standing)}
					{/snippet}
				</Popover>
			</span>
		{/if}
		{#if form === 'figure'}
			<!-- Without the strip the figure is the mark, so it carries the panel. -->
			<span class="mark__figure">
				<Popover label={popLabel} kind="figure">
					{#snippet trigger()}
						{@render figure(standing)}
					{/snippet}
					{#snippet children()}
						{@render lines(standing)}
					{/snippet}
				</Popover>
			</span>
		{:else if form === 'both'}
			<span class="mark__figure">{@render figure(standing)}</span>
		{/if}
	</span>
{/if}

<style>
	/* One pair of custom properties carries the band: the marker's fill and the
	   figure's ink are the only channels position changes. */
	.band-top {
		--sm-marker: var(--je-color-success);
		--sm-figure: var(--je-color-success);
	}

	.band-upper {
		--sm-marker: var(--je-color-success-fill);
		--sm-figure: var(--je-color-success);
	}

	.band-mid {
		--sm-marker: var(--je-color-text-muted);
		--sm-figure: var(--je-color-text);
	}

	.band-lower {
		--sm-marker: var(--je-color-text-subtle);
		--sm-figure: var(--je-color-text-muted);
	}

	.band-bottom {
		--sm-marker: var(--je-color-danger);
		--sm-figure: var(--je-color-danger);
	}

	/* Too few to rank: the marker admits it carries no standing. */
	.band-few {
		--sm-marker: var(--je-color-text-subtle);
		--sm-figure: var(--je-color-text);
	}

	.mark {
		display: inline-flex;
		min-inline-size: 0;
		max-inline-size: 100%;
		align-items: center;
		gap: var(--je-space-3);
		block-size: 1.375rem;
	}

	.mark__plot {
		flex: 0 0 auto;
		inline-size: var(--sm-strip);
		max-inline-size: 100%;
	}

	.mark__figure {
		min-inline-size: 0;
	}

	/* The strip's full-width behaviour used to be forced from here, with
	   `:global(.ui-popover__trigger)`. That reached past the primitive's own
	   contract and, because it matched *every* trigger inside this component, it
	   also stretched the bare figure — whose plate then painted at the cell's
	   width while the numeral overflowed it, so the highlight rendered narrower
	   than the text it was highlighting. `Popover` now takes `fill` as a
	   supported prop and only the plot asks for it. */

	.strip {
		display: flex;
		min-inline-size: 0;
		align-items: center;
		gap: var(--je-space-1);
		block-size: 1.375rem;
	}

	.strip__viz {
		display: block;
		flex: 1 1 auto;
		min-inline-size: 0;
		block-size: 1.375rem;
		/* The plotted content stays inside the field; only the entrance ring
		   below leaves it, and a ring cut off at the baseline reads as a fault
		   rather than as decoration. Paint escapes, geometry does not: the box
		   is unchanged, so nothing around the mark moves. */
		overflow: visible;
	}

	/* The entrance, once. The marker says where this score landed; the ring says
	   "here" twice and is then finished, because a mark that keeps pulsing keeps
	   asking for attention that has already been given. It is decoration on a
	   figure that is already fully drawn: no layout, nothing in the accessible
	   tree (the field is `aria-hidden`), and nothing lost where it is skipped.
	   It cannot re-fire on disclosure either — the element is created once with
	   the mark, and opening the panel does not re-create the popover's trigger. */
	.pulse {
		opacity: 0;
		transform-box: fill-box;
		transform-origin: center;
	}

	/* Reduced motion is the same design, stiller: the marker alone, which is
	   already the strongest ink in the plot and carries the position on its own. */
	@media (prefers-reduced-motion: no-preference) {
		.pulse {
			/* Twice the overlay tier: the ring has to cross a pack of dots to be
			   read as travel, and the timing still derives from the vocabulary
			   rather than from a local millisecond. */
			animation: sm-pulse calc(var(--je-duration-slow) * 2) var(--je-ease-out) 2;
		}
	}

	/* 3.5 → 8 user units of radius, drawn as scale so the frames stay on the
	   compositor; `non-scaling-stroke` keeps the ring one weight as it grows. */
	@keyframes sm-pulse {
		from {
			opacity: 0.5;
			transform: scale(1);
		}
		to {
			opacity: 0;
			transform: scale(2.29);
		}
	}

	/* The scale's ends, stated once, so the pack's position is readable without
	   an axis: everything between these two numbers is the whole scale. */
	.strip__end {
		flex: 0 0 auto;
		font-size: var(--je-font-size-2xs);
		font-variant-numeric: tabular-nums;
		line-height: 1;
		color: var(--je-color-text-subtle);
	}

	.fig {
		display: flex;
		min-inline-size: 0;
		align-items: baseline;
		gap: var(--je-space-2);
		block-size: 1.375rem;
	}

	.fig__num {
		flex: 0 0 auto;
		font-size: var(--je-font-size-base);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.375rem;
		color: var(--sm-figure);
	}

	.fig__phrase {
		min-inline-size: 0;
		overflow: hidden;
		font-size: var(--je-font-size-xs);
		line-height: 1.375rem;
		color: var(--je-color-text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.line {
		margin: 0;
	}

	.line--lead {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.line--meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}
</style>
