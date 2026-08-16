<script lang="ts">
	/**
	 * The event so far: the hero band. The figures an organizer loves to see,
	 * at display size — proposals, reviews, decided, accepted, speakers — over
	 * one wide cumulative funnel drawn on a single honest axis: received,
	 * decided, and accepted all count proposals, nested by definition, so the
	 * gap between the lines closing *is* the event going well.
	 *
	 * Colour is spent once, where it means something: accepted wears the
	 * learned success green (it is that status), the outer lines stay on the
	 * ink ladder. The digits live in the figures above — the chart carries
	 * shape, the press-open table carries every weekly value.
	 */
	import { describeArrivalWeek } from '@jooevents/contracts';
	import { Popover } from '$lib/ui';
	import type { PulseFunnelWeek, PulseHero } from '$lib/api/pulse-page-port';

	let {
		hero,
		timezone,
		now
	}: {
		readonly hero: PulseHero;
		readonly timezone: string;
		readonly now: number;
	} = $props();

	const funnel = $derived(hero.funnel ?? []);
	const hasDecided = $derived(funnel.some((week) => week.decided !== undefined));
	const hasAccepted = $derived(funnel.some((week) => week.accepted !== undefined));
	const seriesCount = $derived(1 + (hasDecided ? 1 : 0) + (hasAccepted ? 1 : 0));

	const weeks = $derived(
		funnel.map((week) => ({
			week,
			words: describeArrivalWeek({ week: { startsAt: week.startsAt, count: 0 }, timezone, now })
		}))
	);

	/* Chart geometry in viewBox units; strokes stay 2 CSS pixels via
	   non-scaling-stroke, so the box can stretch to any panel width. */
	const W = 100;
	const H = 40;
	const TOP = 3;

	const peak = $derived(Math.max(1, ...funnel.map((week) => week.received)));

	function y(value: number): number {
		return H - (value / peak) * (H - TOP);
	}

	/** A cumulative count holds until the next week begins: step-after. */
	function stepPath(values: readonly number[]): string {
		if (values.length === 0) return '';
		const dx = values.length > 1 ? W / (values.length - 1) : W;
		let path = `M 0 ${y(values[0]!).toFixed(2)}`;
		for (let index = 1; index < values.length; index += 1) {
			const x = (index * dx).toFixed(2);
			path += ` H ${x} V ${y(values[index]!).toFixed(2)}`;
		}
		return `${path} H ${W}`;
	}

	function fillPath(values: readonly number[]): string {
		const line = stepPath(values);
		return line === '' ? '' : `${line} V ${H} H 0 Z`;
	}

	const receivedLine = $derived(funnel.map((week) => week.received));
	const decidedLine = $derived(hasDecided ? funnel.map((week) => week.decided ?? 0) : []);
	const acceptedLine = $derived(hasAccepted ? funnel.map((week) => week.accepted ?? 0) : []);

	/**
	 * A story of one point has no shape: when everything so far landed in the
	 * week in progress, an area chart is an empty frame with one jump at its
	 * edge — which reads as broken, not as young. The words carry it until a
	 * second week exists to draw a line between.
	 */
	const tooYoung = $derived(
		funnel.length > 0 && funnel.slice(0, -1).every((week) => week.received === 0)
	);

	const last = $derived(funnel[funnel.length - 1]);
	const figureName = $derived.by(() => {
		if (!last) return '';
		const parts = [
			`${last.received} received`,
			...(last.decided !== undefined ? [`${last.decided} decided`] : []),
			...(last.accepted !== undefined ? [`${last.accepted} accepted`] : [])
		];
		return `The event so far: ${parts.join(', ')}, week by week — show the weekly totals`;
	});
</script>

<section class="story panel" aria-label="The event so far">
	<header class="panel__head"><h2>The event so far</h2></header>
	{#if hero.absence !== undefined}
		<p class="story__absence">{hero.absence}</p>
	{:else}
		<div class="story__figures">
			{#each hero.figures as figure (figure.label)}
				<div
					class="story__figure"
					class:story__figure--accepted={figure.label.toLowerCase() === 'accepted'}>
					<span class="story__value">{figure.value}</span>
					<span class="story__label">{figure.label}</span>
				</div>
			{/each}
		</div>
		{#if tooYoung}
			<p class="story__young">
				Everything so far arrived this week. The story charts here as the weeks add up.
			</p>
		{:else if funnel.length > 0}
			<Popover label={figureName} kind="figure" fill>
				{#snippet trigger()}
					<span class="story__chartrow">
						<svg
							class="story__chart"
							viewBox="0 0 {W} {H}"
							preserveAspectRatio="none"
							aria-hidden="true">
							<path class="story__fill story__fill--received" d={fillPath(receivedLine)} />
							{#if hasDecided}
								<path class="story__fill story__fill--decided" d={fillPath(decidedLine)} />
							{/if}
							{#if hasAccepted}
								<path class="story__fill story__fill--accepted" d={fillPath(acceptedLine)} />
							{/if}
							<path class="story__line story__line--received" d={stepPath(receivedLine)} />
							{#if hasDecided}
								<path class="story__line story__line--decided" d={stepPath(decidedLine)} />
							{/if}
							{#if hasAccepted}
								<path class="story__line story__line--accepted" d={stepPath(acceptedLine)} />
							{/if}
						</svg>
						<span class="story__under">
							{#if seriesCount > 1}
								<span class="story__legend" aria-hidden="true">
									<span class="story__key"><span class="story__swatch story__swatch--received"></span>received</span>
									{#if hasDecided}
										<span class="story__key"><span class="story__swatch story__swatch--decided"></span>decided</span>
									{/if}
									{#if hasAccepted}
										<span class="story__key"><span class="story__swatch story__swatch--accepted"></span>accepted</span>
									{/if}
								</span>
							{:else}
								<span class="story__key">received</span>
							{/if}
							<span class="story__caption">{funnel.length} weeks</span>
						</span>
					</span>
				{/snippet}
				{#snippet children()}
					<table class="story-panel__table">
						<thead>
							<tr>
								<th scope="col">Week</th>
								<th scope="col" class="story-panel__count">Received</th>
								{#if hasDecided}<th scope="col" class="story-panel__count">Decided</th>{/if}
								{#if hasAccepted}<th scope="col" class="story-panel__count">Accepted</th>{/if}
							</tr>
						</thead>
						<tbody>
							{#each weeks as row (row.week.startsAt)}
								<tr class:story-panel__row--current={row.words?.current}>
									<th scope="row">{row.words?.relative ?? 'Week'}</th>
									<td class="story-panel__count">{row.week.received}</td>
									{#if hasDecided}<td class="story-panel__count">{row.week.decided ?? ''}</td>{/if}
									{#if hasAccepted}<td class="story-panel__count">{row.week.accepted ?? ''}</td>{/if}
								</tr>
							{/each}
						</tbody>
					</table>
					<p class="story-panel__note">Counts are running totals up to each week.</p>
				{/snippet}
			</Popover>
		{/if}
	{/if}
</section>

<style>
	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		margin-block-end: var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.story__absence {
		margin: 0;
		min-block-size: 6.25rem;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	.story__young {
		margin: 0;
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
	}

	/* The vanity figures, at display size: this band is where the numbers an
	   organizer loves to glance at get their full weight. */
	.story__figures {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-4) var(--je-space-8);
		margin-block-end: var(--je-space-5);
	}

	/* Value first, at full display weight; the label is a caps whisper under
	   it. The band's hierarchy is the numbers — the words only file them. */
	.story__figure {
		display: grid;
		gap: var(--je-space-1);
	}

	.story__label {
		font-size: var(--je-font-size-2xs);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	.story__value {
		font-size: var(--je-font-size-3xl);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: var(--je-leading-tight);
	}

	/* Colour spent once, same rule as the chart: accepted is the figure the
	   whole funnel exists to grow. */
	.story__figure--accepted .story__value {
		color: var(--je-color-success);
	}

	.story__chartrow {
		display: grid;
		gap: var(--je-space-2);
		min-inline-size: 0;
	}

	.story__chart {
		inline-size: 100%;
		block-size: 7rem;
		display: block;
		border-block-end: 1px solid var(--je-color-border);
	}

	.story__fill {
		stroke: none;
	}

	/* One hue spent, where it means something: accepted is that status. The
	   outer bands stay on the ink ladder. */
	.story__fill--received {
		fill: color-mix(in srgb, var(--je-color-text) 7%, transparent);
	}

	.story__fill--decided {
		fill: color-mix(in srgb, var(--je-color-text) 13%, transparent);
	}

	.story__fill--accepted {
		fill: color-mix(in srgb, var(--je-color-success) 28%, transparent);
	}

	.story__line {
		fill: none;
		stroke-width: 2px;
		vector-effect: non-scaling-stroke;
	}

	.story__line--received {
		stroke: var(--je-color-text-subtle);
	}

	.story__line--decided {
		stroke: var(--je-color-text-muted);
	}

	.story__line--accepted {
		stroke: var(--je-color-success);
	}

	.story__under {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--je-space-3);
	}

	.story__legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-3);
	}

	.story__key {
		display: inline-flex;
		align-items: center;
		gap: var(--je-space-1);
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-muted);
	}

	.story__swatch {
		inline-size: 0.625rem;
		block-size: 0.625rem;
		border-radius: 2px;
	}

	.story__swatch--received {
		background: color-mix(in srgb, var(--je-color-text) 7%, transparent);
		border: 1px solid var(--je-color-text-subtle);
	}

	.story__swatch--decided {
		background: color-mix(in srgb, var(--je-color-text) 13%, transparent);
		border: 1px solid var(--je-color-text-muted);
	}

	.story__swatch--accepted {
		background: color-mix(in srgb, var(--je-color-success) 28%, transparent);
		border: 1px solid var(--je-color-success);
	}

	.story__caption {
		font-size: var(--je-font-size-2xs);
		color: var(--je-color-text-subtle);
		white-space: nowrap;
	}

	.story-panel__table {
		inline-size: 100%;
		border-collapse: collapse;
		font-size: var(--je-font-size-xs);
	}

	.story-panel__table th,
	.story-panel__table td {
		padding-block: 2px;
		text-align: start;
		font-weight: 400;
		color: var(--je-color-text-muted);
	}

	.story-panel__table thead th {
		color: var(--je-color-text-subtle);
		border-block-end: 1px solid var(--je-color-border);
		padding-block-end: var(--je-space-1);
	}

	.story-panel__count {
		text-align: end;
		font-variant-numeric: tabular-nums;
	}

	.story-panel__row--current th,
	.story-panel__row--current td {
		color: var(--je-color-text);
		font-weight: 600;
	}

	.story-panel__note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}
</style>
