<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Lock } from 'lucide-svelte';
	import { Popover } from '$lib/ui';
	import { computeStanding } from '$lib/api/standing';

	// Judged inside the operator shell's density, since the winning mark has to
	// survive a dense decisions table rather than a roomy specimen page.
	$effect(() => {
		const previous = document.documentElement.dataset.density;
		document.documentElement.dataset.density = 'compact';
		return () => {
			if (previous === undefined) delete document.documentElement.dataset.density;
			else document.documentElement.dataset.density = previous;
		};
	});

	/** One submission's standing inside the slice it is compared against. */
	interface Cohort {
		key: string;
		label: string;
		note: string;
		scaleMax: number;
		/** The OTHER submissions' review averages in the comparison slice. */
		others: number[];
		/** This submission's review average. */
		focus: number;
		focusReviews: number;
		sliceLabel: string;
	}

	type Bin = [value: number, count: number];

	/** Hand-authored distributions stay readable as counts-per-value. */
	function expand(bins: Bin[]): number[] {
		const out: number[] = [];
		for (const [value, count] of bins) {
			for (let index = 0; index < count; index += 1) out.push(value);
		}
		return out;
	}

	const cohorts: Cohort[] = [
		{
			key: 'high',
			label: 'Everyone high, one higher',
			note: '46 others packed 3.4–4.6; the leader sits clear of them all.',
			scaleMax: 5,
			others: expand([
				[3.4, 1],
				[3.5, 2],
				[3.6, 2],
				[3.7, 3],
				[3.8, 3],
				[3.9, 4],
				[4.0, 6],
				[4.1, 6],
				[4.2, 6],
				[4.3, 5],
				[4.4, 4],
				[4.5, 3],
				[4.6, 1]
			]),
			focus: 4.9,
			focusReviews: 3,
			sliceLabel: 'AI & Tooling'
		},
		{
			key: 'spread',
			label: 'Wide spread (10-point scale)',
			note: '51 others spread evenly from 2.1 to 9.4; an honest middle.',
			scaleMax: 10,
			others: expand([
				[2.1, 1],
				[2.3, 1],
				[2.4, 1],
				[2.6, 1],
				[2.8, 1],
				[2.9, 1],
				[3.1, 1],
				[3.2, 1],
				[3.4, 1],
				[3.6, 1],
				[3.7, 1],
				[3.9, 1],
				[4.0, 1],
				[4.2, 1],
				[4.3, 1],
				[4.5, 1],
				[4.6, 1],
				[4.8, 1],
				[4.9, 1],
				[5.1, 1],
				[5.2, 1],
				[5.4, 1],
				[5.5, 1],
				[5.7, 1],
				[5.8, 1],
				[6.0, 2],
				[6.2, 1],
				[6.3, 1],
				[6.5, 1],
				[6.6, 1],
				[6.8, 1],
				[6.9, 1],
				[7.1, 1],
				[7.2, 1],
				[7.4, 1],
				[7.5, 1],
				[7.7, 1],
				[7.8, 1],
				[8.0, 1],
				[8.1, 1],
				[8.3, 1],
				[8.4, 1],
				[8.6, 1],
				[8.7, 1],
				[8.9, 1],
				[9.0, 1],
				[9.1, 1],
				[9.2, 1],
				[9.3, 1],
				[9.4, 1]
			]),
			focus: 6.3,
			focusReviews: 4,
			sliceLabel: 'All tracks'
		},
		{
			key: 'low',
			label: 'Low outlier',
			note: '37 others clustered 2.8–4.3; one sits below all of them.',
			scaleMax: 5,
			others: expand([
				[2.8, 1],
				[2.9, 1],
				[3.0, 2],
				[3.1, 2],
				[3.2, 3],
				[3.3, 3],
				[3.4, 4],
				[3.5, 4],
				[3.6, 4],
				[3.7, 3],
				[3.8, 3],
				[3.9, 2],
				[4.0, 2],
				[4.1, 1],
				[4.2, 1],
				[4.3, 1]
			]),
			focus: 1.4,
			focusReviews: 2,
			sliceLabel: 'Web Platform'
		},
		{
			key: 'sparse',
			label: 'Too few to rank',
			note: 'Four others scored; no percentile claim is honest yet.',
			scaleMax: 5,
			others: [3.5, 3.9, 4.1, 4.4],
			focus: 4.5,
			focusReviews: 1,
			sliceLabel: 'Community'
		},
		{
			key: 'round',
			label: 'Full round (N=360)',
			note: '359 others mounded around 3.4, thin tails to 1.2 and 4.8.',
			scaleMax: 5,
			others: expand([
				[1.2, 1],
				[1.3, 1],
				[1.4, 1],
				[1.5, 1],
				[1.6, 2],
				[1.7, 2],
				[1.8, 2],
				[1.9, 3],
				[2.0, 3],
				[2.1, 4],
				[2.2, 4],
				[2.3, 5],
				[2.4, 6],
				[2.5, 7],
				[2.6, 9],
				[2.7, 11],
				[2.8, 13],
				[2.9, 15],
				[3.0, 17],
				[3.1, 19],
				[3.2, 21],
				[3.3, 22],
				[3.4, 23],
				[3.5, 23],
				[3.6, 22],
				[3.7, 20],
				[3.8, 18],
				[3.9, 16],
				[4.0, 15],
				[4.1, 12],
				[4.2, 9],
				[4.3, 8],
				[4.4, 7],
				[4.5, 6],
				[4.6, 5],
				[4.7, 4],
				[4.8, 2]
			]),
			focus: 4.3,
			focusReviews: 3,
			sliceLabel: 'Round 1 · all tracks'
		}
	];

	/* ---------------------------------------------------------------- math */

	type Band = 'top' | 'upper' | 'mid' | 'lower' | 'bottom' | 'few';

	function cohortSize(c: Cohort): number {
		return c.others.length + 1;
	}

	function allOf(c: Cohort): number[] {
		return [...c.others, c.focus];
	}

	function sortedAll(c: Cohort): number[] {
		return allOf(c).sort((a, b) => a - b);
	}

	/** The one shared implementation ranks here too, so the workbench can never
	    drift from what the product prints for identical data. */
	function standingOf(c: Cohort) {
		return computeStanding(c.focus, c.scaleMax, c.others, c.focusReviews, {
			label: c.sliceLabel
		});
	}

	function band(c: Cohort): Band {
		return standingOf(c).band;
	}

	function median(values: number[]): number {
		const sorted = [...values].sort((a, b) => a - b);
		const mid = sorted.length >> 1;
		return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}

	function quantile(sorted: number[], p: number): number {
		const position = (sorted.length - 1) * p;
		const low = Math.floor(position);
		const high = Math.ceil(position);
		return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
	}

	function phrase(c: Cohort): string {
		return standingOf(c).phrase;
	}

	function reviewCount(c: Cohort): string {
		return `${c.focusReviews} review${c.focusReviews === 1 ? '' : 's'}`;
	}

	/* ------------------------------------------------------------ geometry */

	/** The value→x mapping, stated over whatever domain a strip is drawn on. */
	function xIn(value: number, lo: number, hi: number): number {
		return 6 + ((value - lo) / (hi - lo)) * 228;
	}

	/** Every chart shares one value→x mapping so the four read as one system. */
	function xOf(value: number, scaleMax: number): number {
		return xIn(value, 1, scaleMax);
	}

	/** The zoom experiment's domain: the cohort's own span with a little air, so
	    the pack fills the strip instead of the scale. Deliberately not offered as
	    a table form — the row's caption says why. */
	function zoomDomain(c: Cohort): { lo: number; hi: number } {
		const values = allOf(c);
		return { lo: Math.min(...values) - 0.2, hi: Math.max(...values) + 0.1 };
	}

	/** Endpoint numerals are the only labels a strip carries, so a whole number
	    prints bare and everything else keeps its one decimal. */
	function endpointLabel(value: number): string {
		const rounded = Math.round(value * 10) / 10;
		return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
	}

	/* ----------------------------------------------------------------- ink */

	interface Tint {
		fill: string;
		opacity: number;
	}

	/** Absolute good/bad ink, five steps across the scale, read from the mark's
	    own value. An all-gray cohort hides which direction is better; this does
	    not. It says nothing about standing — the focus marker owns that. */
	function tint(value: number, scaleMax: number): Tint {
		const t = (value - 1) / (scaleMax - 1);
		if (t < 0.2) return { fill: 'var(--je-color-danger-fill)', opacity: 0.7 };
		if (t < 0.4) return { fill: 'var(--je-color-warning-fill)', opacity: 0.7 };
		if (t < 0.6) return { fill: 'var(--je-color-text-subtle)', opacity: 0.5 };
		if (t < 0.8) return { fill: 'var(--je-color-success-fill)', opacity: 0.45 };
		return { fill: 'var(--je-color-success-fill)', opacity: 0.8 };
	}

	const CELLS = 48;
	const CELL_W = 228 / CELLS;

	/** Past ~120 marks the strip stops being countable, so one dot stands for k. */
	function dotK(c: Cohort): number {
		return c.others.length > 120 ? Math.ceil(c.others.length / 120) : 1;
	}

	function dotValues(c: Cohort): number[] {
		const sorted = [...c.others].sort((a, b) => a - b);
		const k = dotK(c);
		if (k === 1) return sorted;
		const sampled: number[] = [];
		for (let index = 0; index < sorted.length; index += k) sampled.push(sorted[index]);
		return sampled;
	}

	interface Dot {
		cx: number;
		cy: number;
		/** The average this dot plots, which is also the value that tints it. */
		value: number;
		/** The capped fourth dot, inked heavier to admit the cell holds more. */
		more: boolean;
	}

	function dotsIn(c: Cohort, lo: number, hi: number): Dot[] {
		const cells: number[][] = Array.from({ length: CELLS }, (): number[] => []);
		for (const value of dotValues(c)) {
			const t = (xIn(value, lo, hi) - 6) / 228;
			const cell = Math.min(CELLS - 1, Math.max(0, Math.floor(t * CELLS)));
			cells[cell].push(value);
		}
		const out: Dot[] = [];
		cells.forEach((values, cell) => {
			const cx = 6 + (cell + 0.5) * CELL_W;
			const shown = Math.min(values.length, 4);
			for (let index = 0; index < shown; index += 1) {
				out.push({
					cx,
					cy: 16.5 - index * 4.5,
					value: values[index],
					more: values.length > 4 && index === 3
				});
			}
		});
		return out;
	}

	/** The full 1–scaleMax reading, which is what every table cell draws. */
	function dots(c: Cohort): Dot[] {
		return dotsIn(c, 1, c.scaleMax);
	}

	/* ----------------------------------------------------------- attention */

	type Cue = 'pulse' | 'glow';

	/** Latched once per cue and never cleared: the entrance cue is an arrival,
	    so re-running it would be the thing the foil below exists to argue
	    against. Each experiment row owns its own latch. */
	const seen = $state<Record<Cue, boolean>>({ pulse: false, glow: false });

	/** Arms a cue the first time its strip is actually on screen, which covers
	    both openings — a row already in view latches on mount, one further down
	    latches when it is scrolled to. The animation's iteration count is what
	    ends it; this only decides when it starts. Observing the `<svg>` rather
	    than the circle keeps the target an element with a real layout box. */
	function armOnView(cue: Cue | undefined) {
		return (node: Element) => {
			if (cue === undefined) return;
			const observer = new IntersectionObserver(
				(entries) => {
					if (!entries.some((entry) => entry.isIntersecting)) return;
					seen[cue] = true;
					observer.disconnect();
				},
				{ threshold: 0.6 }
			);
			observer.observe(node);
			return () => observer.disconnect();
		};
	}

	const BINS = 24;

	function binIndex(value: number, scaleMax: number): number {
		const t = (value - 1) / (scaleMax - 1);
		return Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)));
	}

	/** A bar carries no single average, so it is tinted by its bin's centre. */
	function binCenter(index: number, scaleMax: number): number {
		return 1 + ((index + 0.5) / BINS) * (scaleMax - 1);
	}

	function binCounts(c: Cohort): number[] {
		const counts = new Array<number>(BINS).fill(0);
		for (const value of allOf(c)) counts[binIndex(value, c.scaleMax)] += 1;
		return counts;
	}

	function barHeight(count: number, tallest: number): number {
		if (count === 0) return 0;
		return Math.max(1.5, (count / tallest) * 15);
	}

	/** The histogram fills its own 240 units, so its hairline uses that mapping. */
	function hairlineX(c: Cohort): number {
		const t = (c.focus - 1) / (c.scaleMax - 1);
		return Math.min(239.25, Math.max(0.75, t * 240));
	}

	/* ------------------------------------------------------------- content */

	interface Anchor {
		value: number;
		caption: string;
		sentence: string;
	}

	const anchors: Anchor[] = [
		{ value: 1, caption: 'Pass', sentence: 'Does not fit this event; you would not schedule it.' },
		{ value: 2, caption: 'Weak', sentence: 'A fixable idea that cannot compete this round.' },
		{
			value: 3,
			caption: 'Solid',
			sentence: 'Worth a slot if the track has room; you would not fight for it.'
		},
		{ value: 4, caption: 'Strong', sentence: 'You would advocate for it in a tie.' },
		{
			value: 5,
			caption: 'Must-have',
			sentence: 'You would trade another accepted talk to keep it.'
		}
	];

	const ANCHOR_EXAMPLE = 4;

	interface Verdict {
		name: string;
		text: string;
	}

	const verdicts: Verdict[] = [
		{
			name: 'V1 Dot strip',
			text: 'quantity, standing, and outliers all present; the pack is countable at a glance; degrades past ~120 by letting each dot stand for several. Recommended default.'
		},
		{
			name: 'V2 Mini histogram',
			text: 'best at full-round scale where mass matters more than count; a lone bar beyond the mound still betrays the outlier. Recommended as the automatic high-N form of V1.'
		},
		{
			name: 'V3 Quartile band',
			text: 'most compact and calmest, but the cohort’s size disappears; keep for dense cells only if V1 proves noisy in real tables.'
		},
		{
			name: 'V4 Figure + phrase',
			text: 'the zero-graphic fallback; works anywhere text works; the colored figure alone is ambiguous without its phrase. Always compose the figure beside V1/V2.'
		}
	];

	/** Section 5 hand-authors its own inks: a numeral row carries no marker. */
	const relativeRow: { value: number; tone: 'top' | 'upper' | 'mid' }[] = [
		{ value: 4.0, tone: 'mid' },
		{ value: 4.2, tone: 'mid' },
		{ value: 4.3, tone: 'mid' },
		{ value: 4.6, tone: 'upper' },
		{ value: 4.9, tone: 'top' }
	];

	/** The ramp spelled out in 5-point values; the swatch reuses tint() itself. */
	const tintSteps: { range: string; sample: number }[] = [
		{ range: '1–1.8', sample: 1.4 },
		{ range: '1.8–2.6', sample: 2.2 },
		{ range: '2.6–3.4', sample: 3.0 },
		{ range: '3.4–4.2', sample: 3.8 },
		{ range: '4.2–5', sample: 4.6 }
	];

	const LEGEND_SCALE_MAX = 5;

	const c1 = cohorts[0];
	const c2 = cohorts[1];
	const c3 = cohorts[2];
</script>

<svelte:head>
	<title>Score visuals · JooEvents design system</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<!-- ============================== chart bodies ============================ -->

<!-- `cue` is the attention experiment and nothing else: omitted, this is byte for
     byte the default strip every other section renders, so the experiment rows
     can only differ by the halo they add. -->

{#snippet dotStripBody(c: Cohort, cue?: Cue)}
	<span class="axis">
		<span class="axis__end">1</span>
		<svg
			class="viz"
			class:viz--cue={cue !== undefined}
			viewBox="0 0 240 22"
			preserveAspectRatio="xMinYMax meet"
			aria-hidden="true"
			{@attach armOnView(cue)}>
			<line x1="6" y1="19" x2="234" y2="19" stroke="var(--je-color-border)" stroke-width="1" />
			{#each dots(c) as dot, index (index)}
				{@const ink = tint(dot.value, c.scaleMax)}
				<circle
					cx={dot.cx}
					cy={dot.cy}
					r="2"
					fill={ink.fill}
					fill-opacity={dot.more ? Math.min(1, ink.opacity + 0.2) : ink.opacity} />
			{/each}
			{#if cue !== undefined}
				<circle
					class="cue"
					class:cue--on={seen[cue]}
					class:cue--glow={cue === 'glow'}
					cx={xOf(c.focus, c.scaleMax)}
					cy="16.5"
					r="3.5"
					fill="var(--sv-marker)"
					aria-hidden="true" />
			{/if}
			<circle
				cx={xOf(c.focus, c.scaleMax)}
				cy="16.5"
				r="3.5"
				fill="var(--sv-marker)"
				stroke="var(--je-color-surface)"
				stroke-width="1.5" />
		</svg>
		<span class="axis__end">{c.scaleMax}</span>
	</span>
{/snippet}

<!-- Same dots, same tint, same marker; only the domain changes. The axis line
     starts after a two-hairline break so the missing 1–3.2 is stated rather
     than implied by a numeral nobody reads. -->

{#snippet zoomStripBody(c: Cohort)}
	{@const zoom = zoomDomain(c)}
	<span class="axis">
		<span class="axis__end">{endpointLabel(zoom.lo)}</span>
		<svg class="viz" viewBox="0 0 240 22" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
			<line x1="12" y1="19" x2="234" y2="19" stroke="var(--je-color-border)" stroke-width="1" />
			<path
				d="M7 16.5 4 21.5 M10.5 16.5 7.5 21.5"
				fill="none"
				stroke="var(--je-color-border-strong)"
				stroke-width="1" />
			{#each dotsIn(c, zoom.lo, zoom.hi) as dot, index (index)}
				{@const ink = tint(dot.value, c.scaleMax)}
				<circle
					cx={dot.cx}
					cy={dot.cy}
					r="2"
					fill={ink.fill}
					fill-opacity={dot.more ? Math.min(1, ink.opacity + 0.2) : ink.opacity} />
			{/each}
			<circle
				cx={xIn(c.focus, zoom.lo, zoom.hi)}
				cy="16.5"
				r="3.5"
				fill="var(--sv-marker)"
				stroke="var(--je-color-surface)"
				stroke-width="1.5" />
		</svg>
		<span class="axis__end">{endpointLabel(zoom.hi)}</span>
	</span>
{/snippet}

{#snippet pulseStripBody(c: Cohort)}
	{@render dotStripBody(c, 'pulse')}
{/snippet}

{#snippet glowStripBody(c: Cohort)}
	{@render dotStripBody(c, 'glow')}
{/snippet}

{#snippet histogramBody(c: Cohort)}
	{@const counts = binCounts(c)}
	{@const tallest = Math.max(...counts)}
	<span class="axis">
		<span class="axis__end">1</span>
		<svg class="viz" viewBox="0 0 240 22" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
			{#each counts as count, index (index)}
				{@const h = barHeight(count, tallest)}
				{#if h > 0}
					{@const ink = tint(binCenter(index, c.scaleMax), c.scaleMax)}
					<rect
						x={index * 10 + 1}
						y={19 - h}
						width="8"
						height={h}
						fill={ink.fill}
						fill-opacity={ink.opacity} />
				{/if}
			{/each}
			<line
				x1={hairlineX(c)}
				y1="2"
				x2={hairlineX(c)}
				y2="19"
				stroke="var(--sv-marker)"
				stroke-width="1.5" />
		</svg>
		<span class="axis__end">{c.scaleMax}</span>
	</span>
{/snippet}

<!-- The two alternatives the tinted strip was judged against, kept runnable so
     the comparison in “the good/bad axis” is the real mark, not a picture. -->

{#snippet plainStripBody(c: Cohort)}
	<span class="axis">
		<span class="axis__end">1</span>
		<svg class="viz" viewBox="0 0 240 22" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
			<line x1="6" y1="19" x2="234" y2="19" stroke="var(--je-color-border)" stroke-width="1" />
			{#each dots(c) as dot, index (index)}
				<circle
					cx={dot.cx}
					cy={dot.cy}
					r="2"
					fill="var(--je-color-text-subtle)"
					opacity={dot.more ? 0.6 : 0.5} />
			{/each}
			<circle
				cx={xOf(c.focus, c.scaleMax)}
				cy="16.5"
				r="3.5"
				fill="var(--sv-marker)"
				stroke="var(--je-color-surface)"
				stroke-width="1.5" />
		</svg>
		<span class="axis__end">{c.scaleMax}</span>
	</span>
{/snippet}

{#snippet rampStripBody(c: Cohort)}
	<span class="axis">
		<span class="axis__end">1</span>
		<svg class="viz" viewBox="0 0 240 22" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
			<defs>
				<linearGradient id="sv-axis-ramp" x1="0" y1="0" x2="1" y2="0">
					<stop offset="0" stop-color="var(--je-color-danger-fill)" />
					<stop offset="0.5" stop-color="var(--je-color-warning-fill)" />
					<stop offset="1" stop-color="var(--je-color-success-fill)" />
				</linearGradient>
			</defs>
			<rect
				x="6"
				y="17.5"
				width="228"
				height="3"
				rx="1.5"
				fill="url(#sv-axis-ramp)"
				opacity="0.3" />
			{#each dots(c) as dot, index (index)}
				<circle
					cx={dot.cx}
					cy={dot.cy}
					r="2"
					fill="var(--je-color-text-subtle)"
					opacity={dot.more ? 0.6 : 0.5} />
			{/each}
			<circle
				cx={xOf(c.focus, c.scaleMax)}
				cy="16.5"
				r="3.5"
				fill="var(--sv-marker)"
				stroke="var(--je-color-surface)"
				stroke-width="1.5" />
		</svg>
		<span class="axis__end">{c.scaleMax}</span>
	</span>
{/snippet}

{#snippet quartileBody(c: Cohort)}
	{@const sorted = sortedAll(c)}
	{@const lowX = xOf(sorted[0], c.scaleMax)}
	{@const highX = xOf(sorted[sorted.length - 1], c.scaleMax)}
	{@const p25X = xOf(quantile(sorted, 0.25), c.scaleMax)}
	{@const p75X = xOf(quantile(sorted, 0.75), c.scaleMax)}
	{@const midX = xOf(median(sorted), c.scaleMax)}
	<svg class="viz" viewBox="0 0 240 22" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
		<rect
			x={lowX}
			y="14"
			width={Math.max(1, highX - lowX)}
			height="4"
			rx="2"
			fill="var(--je-color-surface-sunken)"
			stroke="var(--je-color-border)"
			stroke-width="1" />
		<rect
			x={p25X}
			y="13"
			width={Math.max(1, p75X - p25X)}
			height="6"
			rx="2"
			fill="var(--je-color-text-subtle)"
			opacity="0.35" />
		<line
			x1={midX}
			y1="11"
			x2={midX}
			y2="21"
			stroke="var(--je-color-text-muted)"
			stroke-width="1.5" />
		<circle
			cx={xOf(c.focus, c.scaleMax)}
			cy="16"
			r="3.5"
			fill="var(--sv-marker)"
			stroke="var(--je-color-surface)"
			stroke-width="1.5" />
	</svg>
{/snippet}

{#snippet figureBody(c: Cohort)}
	<span class="fig">
		<span class="fig__num">{c.focus.toFixed(1)}</span>
		<span class="fig__phrase">{phrase(c)}</span>
	</span>
{/snippet}

<!-- ============================ shared wrapper ============================ -->

{#snippet mark(c: Cohort, extra: string | null, body: Snippet<[Cohort]>, name: string)}
	{@const b = band(c)}
	<span
		class="sv"
		class:band-top={b === 'top'}
		class:band-upper={b === 'upper'}
		class:band-mid={b === 'mid'}
		class:band-lower={b === 'lower'}
		class:band-bottom={b === 'bottom'}
		class:band-few={b === 'few'}>
		<Popover label="{c.focus} of {c.scaleMax}, {name}, standing details" kind="figure" fill>
			{#snippet trigger()}
				{@render body(c)}
			{/snippet}
			{#snippet children()}
				<p class="pop__line pop__line--lead">{c.focus} average of {reviewCount(c)}</p>
				<p class="pop__line">{phrase(c)}</p>
				<p class="pop__line pop__line--meta">
					{c.sliceLabel} · median {median(allOf(c)).toFixed(1)} of {cohortSize(c)} scored
				</p>
				{#if extra}
					<p class="pop__line pop__line--meta">{extra}</p>
				{/if}
			{/snippet}
		</Popover>
	</span>
{/snippet}

{#snippet v1(c: Cohort)}
	{@const k = dotK(c)}
	{@render mark(
		c,
		k > 1 ? `each dot ≈ ${k} submissions` : 'one dot per scored submission',
		dotStripBody,
		'dot strip'
	)}
{/snippet}

{#snippet v2(c: Cohort)}
	{@render mark(c, null, histogramBody, 'mini histogram')}
{/snippet}

{#snippet v3(c: Cohort)}
	{@render mark(c, null, quartileBody, 'quartile band')}
{/snippet}

{#snippet v4(c: Cohort)}
	{@render mark(c, null, figureBody, 'figure and phrase')}
{/snippet}

{#snippet vPlain(c: Cohort)}
	{@render mark(c, 'one dot per scored submission', plainStripBody, 'dot strip without tint')}
{/snippet}

{#snippet vZoom(c: Cohort)}
	{@const zoom = zoomDomain(c)}
	{@render mark(
		c,
		`axis zoomed to ${endpointLabel(zoom.lo)}–${endpointLabel(zoom.hi)}, not the full 1–${c.scaleMax}`,
		zoomStripBody,
		'dot strip zoomed to the data'
	)}
{/snippet}

{#snippet vPulse(c: Cohort)}
	{@render mark(
		c,
		'one dot per scored submission',
		pulseStripBody,
		'dot strip with an entrance pulse'
	)}
{/snippet}

{#snippet vGlow(c: Cohort)}
	{@render mark(c, 'one dot per scored submission', glowStripBody, 'dot strip with a standing glow')}
{/snippet}

{#snippet vRamp(c: Cohort)}
	{@render mark(
		c,
		'one dot per scored submission',
		rampStripBody,
		'dot strip over a gradient underlay'
	)}
{/snippet}

<!-- ================================= page ================================ -->

<div class="page">
	<header class="page__head">
		<h1 class="page__title">Where does this score stand?</h1>
		<p class="page__lede">
			A standing visual must answer three things at a glance — roughly how many others were scored
			(quantity), where this one sits among them (standing), and whether anything sits alone
			(outliers) — inside one text line, in a table cell, with exact numbers one press away.
		</p>
	</header>

	<section class="block">
		<h2 class="block__title">Candidates against every shape</h2>
		<div class="matrix-scroll">
			<div class="matrix">
				<span class="matrix__corner"></span>
				<span class="matrix__head">V1 Dot strip</span>
				<span class="matrix__head">V2 Mini histogram</span>
				<span class="matrix__head">V3 Quartile band</span>
				<span class="matrix__head">V4 Figure + phrase</span>

				{#each cohorts as cohort (cohort.key)}
					<div class="matrix__rowhead">
						<strong class="matrix__label">{cohort.label}</strong>
						<span class="matrix__note">{cohort.note}</span>
						<span class="matrix__meta">{cohort.focus} · n={cohortSize(cohort)}</span>
					</div>
					<div class="matrix__cell">{@render v1(cohort)}</div>
					<div class="matrix__cell">{@render v2(cohort)}</div>
					<div class="matrix__cell">{@render v3(cohort)}</div>
					<div class="matrix__cell">{@render v4(cohort)}</div>
					{#if dotK(cohort) > 1}
						<p class="matrix__foot">
							Dot strip aggregates above ~120 marks: each dot stands for {dotK(cohort)} submissions,
							sampled evenly from the sorted slice, and the popover says so.
						</p>
					{/if}
				{/each}
			</div>
		</div>
	</section>

	<section class="block">
		<h2 class="block__title">The good/bad axis</h2>
		<div class="axes">
			<div class="axes__row">
				<span class="axes__name">Before — all gray</span>
				<span class="axes__mark">{@render vPlain(c2)}</span>
			</div>
			<div class="axes__row">
				<span class="axes__name">Tinted marks (default)</span>
				<span class="axes__mark">{@render v1(c2)}</span>
			</div>
			<div class="axes__row">
				<span class="axes__name">Gradient underlay (alternative)</span>
				<span class="axes__mark">{@render vRamp(c2)}</span>
			</div>
		</div>
		<ul class="legend">
			{#each tintSteps as step (step.range)}
				{@const ink = tint(step.sample, LEGEND_SCALE_MAX)}
				<li class="legend__item">
					<svg class="legend__dot" viewBox="0 0 8 8" aria-hidden="true">
						<circle cx="4" cy="4" r="3" fill={ink.fill} fill-opacity={ink.opacity} />
					</svg>
					<span class="legend__range">{step.range}</span>
				</li>
			{/each}
		</ul>
		<p class="note">
			Tint says how good the neighborhood is in absolute terms; the ringed marker says where this
			one stands within it — when they disagree, the disagreement is the information.
		</p>
	</section>

	<section class="block">
		<h2 class="block__title">Axis and attention experiments</h2>
		<p class="note">
			Every row below plots one cohort — 46 others packed 3.4–4.6, this one at 4.9 — so anything
			that reads differently is the treatment, not the data.
		</p>
		<div class="axes">
			<div class="axes__row">
				<span class="axes__name">Full scale (default)</span>
				<span class="axes__mark">{@render v1(c1)}</span>
			</div>

			<div class="axes__row">
				<span class="axes__name">Zoomed to the data</span>
				<span class="axes__mark">{@render vZoom(c1)}</span>
				<p class="axes__caption">
					Zoom trades cross-row comparability for resolution — two packs at different zooms look
					identical while meaning different things, so this stays out of tables. The tinted empty
					zone in the default is itself the fact that nobody sits low.
				</p>
			</div>

			<div class="axes__row">
				<span class="axes__name">Entrance pulse (recommended)</span>
				<span class="axes__mark">{@render vPulse(c1)}</span>
				<p class="axes__caption">
					Two beats the first time the row is seen, then never again: the cue explains an arrival
					and then stops asking for attention it has already been given. Reduced motion drops it
					outright — the ringed marker is the standing information with or without it.
				</p>
			</div>

			<div class="axes__row">
				<span class="axes__name">Standing glow (rejected foil)</span>
				<span class="axes__mark">{@render vGlow(c1)}</span>
				<p class="axes__caption">
					The same cue with its iteration count set to repeat forever. Ambient motion in a 20-row
					table is wrong: twenty marks breathing at once say nothing about any of them, and each
					one pulls the eye off the row the person is actually reading.
				</p>
			</div>
		</div>
	</section>

	<section class="block">
		<h2 class="block__title">In context</h2>
		<div class="ctx">
			<div class="ctx__row">
				<span class="ctx__title">Edge Caching Without Tears</span>
				<span class="ctx__strip">{@render v1(c1)}</span>
				<span class="ctx__fig">{@render v4(c1)}</span>
			</div>
			<div class="ctx__row">
				<span class="ctx__title">Lifecycle of a Dead Framework</span>
				<span class="ctx__strip">{@render v1(c3)}</span>
				<span class="ctx__fig">{@render v4(c3)}</span>
			</div>
		</div>
	</section>

	<section class="block">
		<h2 class="block__title">Reading it</h2>

		<div class="read">
			<h3 class="read__title">What the popover always carries</h3>
			<ul class="read__lines">
				<li>4.9 average of 3 reviews</li>
				<li>Highest of 47 scored</li>
				<li>AI &amp; Tooling · median 4.1 of 47 scored</li>
				<li>one dot per scored submission</li>
			</ul>
			<p class="note">
				Three lines, always in that order: what this submission scored, where that puts it, and what
				it was compared against. The strip forms add a fourth saying what one dot is worth — one per
				submission, or several once the slice is aggregated.
			</p>
		</div>

		<div class="read">
			<h3 class="read__title">Before you commit</h3>
			<div class="locked">
				<Lock size={13} aria-hidden="true" />
				<span>Unlocks when you commit your own review</span>
			</div>
			<p class="note">
				The aggregate is peer content, so it stays gated until your own review is committed. The
				placeholder holds the strip's exact height, so committing does not move the row.
			</p>
		</div>

		<div class="read">
			<h3 class="read__title" id="anchors-title">Anchored scale for new reviewers</h3>
			<div class="anchors" role="group" aria-labelledby="anchors-title">
				{#each anchors as anchor (anchor.value)}
					<span class="anchors__seg" class:anchors__seg--on={anchor.value === ANCHOR_EXAMPLE}>
						<Popover
							label="{anchor.value} {anchor.caption}, what this score means{anchor.value ===
							ANCHOR_EXAMPLE
								? ', example selection'
								: ''}"
							kind="figure">
							{#snippet trigger()}
								<span class="anchors__item">
									<span class="anchors__num">{anchor.value}</span>
									<span class="anchors__cap">{anchor.caption}</span>
								</span>
							{/snippet}
							{#snippet children()}
								<p class="pop__line pop__line--lead">{anchor.value} · {anchor.caption}</p>
								<p class="pop__line">{anchor.sentence}</p>
							{/snippet}
						</Popover>
					</span>
				{/each}
			</div>
			<p class="note">
				Anchor wording becomes chair-editable vocabulary later; the numbers stay fixed so scores
				remain comparable across rounds.
			</p>
		</div>
	</section>

	<section class="block">
		<h2 class="block__title">Why relative, not absolute</h2>
		<div class="compare">
			<div class="compare__row">
				<span class="compare__name">Absolute bands</span>
				<span class="compare__nums">
					{#each relativeRow as entry (entry.value)}
						<span class="numeral rel--abs">{entry.value.toFixed(1)}</span>
					{/each}
				</span>
			</div>
			<div class="compare__row">
				<span class="compare__name">Relative bands</span>
				<span class="compare__nums">
					{#each relativeRow as entry (entry.value)}
						<span
							class="numeral"
							class:rel--top={entry.tone === 'top'}
							class:rel--upper={entry.tone === 'upper'}
							class:rel--mid={entry.tone === 'mid'}>{entry.value.toFixed(1)}</span>
					{/each}
				</span>
			</div>
		</div>
		<p class="note">
			The numeral keeps its absolute meaning as ink; color and position carry relative standing.
		</p>

		<div class="read">
			<h3 class="read__title">Bottom band hue</h3>
			<div class="hues">
				<span class="hue">
					<span class="numeral hue--danger">1.4</span>
					<span class="hue__name">danger</span>
				</span>
				<span class="hue">
					<span class="numeral hue--warning">1.4</span>
					<span class="hue__name">warning</span>
				</span>
			</div>
			<p class="note">
				Danger is the recommended default: it borrows the grade colour people already read as “this
				one is failing”. Warning is the calmer alternative where a low score is a prompt to look
				rather than a verdict.
			</p>
		</div>
	</section>

	<section class="block">
		<h2 class="block__title">Verdicts</h2>
		<dl class="verdicts">
			{#each verdicts as verdict (verdict.name)}
				<div class="verdicts__entry">
					<dt class="verdicts__name">{verdict.name}</dt>
					<dd class="verdicts__text">{verdict.text}</dd>
				</div>
			{/each}
		</dl>
	</section>
</div>

<style>
	/* One pair of custom properties carries the band through all four variants:
	   the mark's fill and the numeral's ink are the only channels that change. */
	.band-top {
		--sv-marker: var(--je-color-success);
		--sv-numeral: var(--je-color-success);
	}

	.band-upper {
		--sv-marker: var(--je-color-success-fill);
		--sv-numeral: var(--je-color-success);
	}

	.band-mid {
		--sv-marker: var(--je-color-text-muted);
		--sv-numeral: var(--je-color-text);
	}

	.band-lower {
		--sv-marker: var(--je-color-text-subtle);
		--sv-numeral: var(--je-color-text-muted);
	}

	/* Full danger, not the fill: the marker has to dominate a tinted pack whose
	   low end is already carrying danger-fill. */
	.band-bottom {
		--sv-marker: var(--je-color-danger);
		--sv-numeral: var(--je-color-danger);
	}

	.band-few {
		--sv-marker: var(--je-color-text-subtle);
		--sv-numeral: var(--je-color-text);
	}

	/* The chart is the button. The disclosure primitive keeps its focus ring and
	   its press affordance; everything else is reset so the mark reads as a mark. */
	.sv {
		display: block;
		min-inline-size: 0;
		max-inline-size: 13rem;
	}

	/* The blanket full-width override that used to live here is gone: it caught
	   every trigger in the gallery, including the bare scale anchors, and
	   stretched them to their container so the hover plate painted wider — or,
	   where the container was narrow, narrower — than the thing it highlighted.
	   `Popover`'s `fill` prop carries it now, on the card that actually wants it. */

	.viz {
		display: block;
		min-inline-size: 0;
		flex: 1 1 auto;
		inline-size: 100%;
		block-size: 1.375rem;
	}

	/* The endpoints are the scale's only labels, so they flank the chart rather
	   than sit inside it: no glyph competes with the marks for pixels. */
	.axis {
		display: flex;
		min-inline-size: 0;
		align-items: center;
		gap: var(--je-space-1);
	}

	.axis__end {
		flex: 0 0 auto;
		font-size: var(--je-font-size-2xs);
		font-variant-numeric: tabular-nums;
		line-height: 1.375rem;
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
		color: var(--sv-numeral);
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

	.pop__line {
		margin: 0;
	}

	.pop__line--lead {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.pop__line--meta {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* -------------------------------------------------------------- page */

	.page {
		display: flex;
		max-inline-size: 72rem;
		flex-direction: column;
		gap: var(--je-space-10);
		margin-inline: auto;
		padding: var(--je-space-8) var(--je-space-6) var(--je-space-12);
	}

	.page__head {
		display: flex;
		max-inline-size: 52rem;
		flex-direction: column;
		gap: var(--je-space-3);
	}

	.page__title {
		margin: 0;
		font-family: var(--je-font-display);
		font-size: var(--je-font-size-2xl);
	}

	.page__lede {
		margin: 0;
		font-size: var(--je-font-size-md);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-4);
	}

	.block__title {
		margin: 0;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-muted);
	}

	.note {
		margin: 0;
		max-inline-size: 52rem;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	/* ------------------------------------------------------------ matrix */

	/* The wide grid scrolls inside its own wrapper; the document never does. */
	.matrix-scroll {
		overflow-x: auto;
		padding-block: var(--je-space-1);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.matrix {
		display: grid;
		min-inline-size: 59rem;
		grid-template-columns: minmax(11rem, 0.9fr) repeat(4, minmax(12rem, 1fr));
		/* Each mark sits on its cohort's name line, not in the middle of the
		   paragraph under it, so the pairing survives a five-row scan. */
		align-items: start;
		/* No column gap: the row rules are per-cell borders, and a gap would
		   break each separator into dashes at every column boundary. */
		gap: var(--je-space-3) 0;
		padding: var(--je-space-3) var(--je-space-4);
	}

	.matrix__corner {
		display: block;
	}

	.matrix__head {
		padding-inline-end: var(--je-space-4);
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-muted);
	}

	.matrix__rowhead {
		display: flex;
		min-inline-size: 0;
		flex-direction: column;
		gap: var(--je-space-1);
		padding-block: var(--je-space-2);
		padding-inline-end: var(--je-space-4);
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.matrix__label {
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.matrix__note {
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
	}

	.matrix__meta {
		font-size: var(--je-font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-subtle);
	}

	.matrix__cell {
		display: flex;
		min-inline-size: 0;
		align-items: center;
		padding-block: var(--je-space-2);
		padding-inline-end: var(--je-space-4);
		border-block-start: 1px solid var(--je-color-border-subtle);
	}

	.matrix__foot {
		grid-column: 1 / -1;
		margin: 0;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-subtle);
	}

	/* -------------------------------------------------------- good/bad axis */

	.axes {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
	}

	.axes__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-4);
		padding: var(--je-space-2) var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.axes__name {
		flex: 0 0 auto;
		inline-size: 14rem;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		color: var(--je-color-text-muted);
	}

	.axes__mark {
		flex: 0 1 13rem;
		min-inline-size: 0;
	}

	.axes__caption {
		flex: 1 1 100%;
		max-inline-size: 46rem;
		margin: 0;
		font-size: var(--je-font-size-xs);
		line-height: var(--je-leading-snug);
		color: var(--je-color-text-muted);
	}

	/* ------------------------------------------------------ attention cue */

	/* A second circle behind the marker, at the marker's own radius, grown by
	   transform rather than by `r`: transform and opacity are the standard's
	   animation surface, and scaling 3.5 by 8/3.5 is the same ring a radius ramp
	   to 8 would draw, without touching geometry every frame. It is invisible
	   until something animates it, so reduced motion and pre-arrival both render
	   the plain default strip. */
	.cue {
		transform-box: fill-box;
		transform-origin: center;
		opacity: 0;
	}

	/* The halo leaves the 22-unit strip at full size. Letting it paint outside
	   keeps the ring round; it reserves no space, so no row moves for it. */
	.viz--cue {
		overflow: visible;
	}

	@media (prefers-reduced-motion: no-preference) {
		.cue--on {
			animation-name: sv-cue;
			animation-duration: calc(var(--je-duration-slow) * 2);
			animation-timing-function: var(--je-ease-out);
			/* Two beats, then held at its own end state and gone for good. */
			animation-iteration-count: 2;
			animation-fill-mode: forwards;
		}

		/* The foil is the identical cue with one property changed, so the row
		   demonstrates ambient motion rather than a second design. */
		.cue--glow.cue--on {
			animation-iteration-count: infinite;
		}
	}

	@keyframes sv-cue {
		from {
			opacity: 0.5;
			transform: scale(1);
		}
		to {
			opacity: 0;
			transform: scale(2.2857);
		}
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.legend__item {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
	}

	.legend__dot {
		display: block;
		flex: 0 0 auto;
		inline-size: 0.5rem;
		block-size: 0.5rem;
	}

	.legend__range {
		font-size: var(--je-font-size-2xs);
		font-variant-numeric: tabular-nums;
		color: var(--je-color-text-muted);
	}

	/* ----------------------------------------------------------- context */

	.ctx {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
	}

	.ctx__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-3) var(--je-space-4);
		padding: var(--je-space-2) var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
		min-block-size: var(--je-row-height);
	}

	.ctx__title {
		flex: 0 1 18rem;
		min-inline-size: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.ctx__strip {
		flex: 0 0 auto;
		inline-size: 10rem;
	}

	.ctx__fig {
		flex: 0 1 14rem;
		min-inline-size: 0;
	}

	/* ------------------------------------------------------------ reading */

	.read {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
		padding: var(--je-space-3) var(--je-space-4);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.read__title {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.read__lines {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-1);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--je-font-size-sm);
		font-variant-numeric: tabular-nums;
	}

	.read__lines li:first-child {
		font-weight: 600;
	}

	.read__lines li:nth-child(n + 3) {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* Holds the strip's exact height so nothing shifts when the aggregate lands. */
	.locked {
		display: flex;
		max-inline-size: 20rem;
		align-items: center;
		gap: var(--je-space-2);
		block-size: 1.375rem;
		padding-inline: var(--je-space-2);
		border: 1px dashed var(--je-color-border-strong);
		border-radius: var(--je-radius-sm);
		background: var(--je-color-surface-sunken);
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* ------------------------------------------------------------ anchors */

	.anchors {
		display: inline-flex;
		flex-wrap: wrap;
		align-self: start;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--je-color-border);
		border-radius: calc(var(--je-radius-control) + 2px);
		background: var(--je-color-surface-sunken);
	}

	.anchors__seg :global(.ui-popover__trigger) {
		border-radius: var(--je-radius-control);
	}

	.anchors__seg--on :global(.ui-popover__trigger) {
		background: var(--je-color-surface);
		box-shadow: var(--je-shadow-sm);
	}

	.anchors__item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0;
		padding: var(--je-space-1) var(--je-space-2);
		color: var(--je-color-text-muted);
	}

	.anchors__seg--on .anchors__item {
		color: var(--je-color-text);
	}

	.anchors__num {
		font-size: var(--je-font-size-xs);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		line-height: var(--je-leading-tight);
	}

	.anchors__cap {
		font-size: var(--je-font-size-2xs);
		line-height: var(--je-leading-tight);
		color: var(--je-color-text-muted);
	}

	/* ------------------------------------------------------------ compare */

	.compare {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-2);
	}

	.compare__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--je-space-2) var(--je-space-4);
		padding: var(--je-space-2) var(--je-space-3);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		background: var(--je-color-surface);
	}

	.compare__name {
		flex: 0 0 auto;
		inline-size: 8rem;
		font-size: var(--je-font-size-xs);
		font-weight: 600;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-muted);
	}

	.compare__nums {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-4);
	}

	.numeral {
		font-size: var(--je-font-size-base);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.rel--abs {
		color: var(--je-color-success);
	}

	.rel--top {
		color: var(--je-color-success);
	}

	.rel--upper {
		color: var(--je-color-success-fill);
	}

	.rel--mid {
		color: var(--je-color-text);
	}

	.hues {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-6);
	}

	.hue {
		display: inline-flex;
		align-items: baseline;
		gap: var(--je-space-2);
	}

	.hue__name {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.hue--danger {
		color: var(--je-color-danger);
	}

	.hue--warning {
		color: var(--je-color-warning);
	}

	/* ----------------------------------------------------------- verdicts */

	.verdicts {
		display: flex;
		flex-direction: column;
		gap: var(--je-space-3);
		margin: 0;
	}

	.verdicts__entry {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-1) var(--je-space-3);
		padding-inline-start: var(--je-space-3);
		border-inline-start: 2px solid var(--je-color-border-strong);
	}

	.verdicts__name {
		flex: 0 0 auto;
		inline-size: 10rem;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
	}

	.verdicts__text {
		flex: 1 1 18rem;
		min-inline-size: 0;
		margin: 0;
		font-size: var(--je-font-size-sm);
		line-height: var(--je-leading-normal);
		color: var(--je-color-text-muted);
	}

	@media (max-width: 40rem) {
		.page {
			padding: var(--je-space-6) var(--je-space-4) var(--je-space-10);
			gap: var(--je-space-8);
		}

		.axes__name {
			inline-size: auto;
		}

		.compare__name {
			inline-size: auto;
		}

		.verdicts__name {
			inline-size: auto;
		}
	}
</style>
