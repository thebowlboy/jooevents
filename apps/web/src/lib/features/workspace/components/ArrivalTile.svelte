<script lang="ts">
	/**
	 * What has arrived, and over which window.
	 *
	 * The tile answers three questions in the order an organizer asks them:
	 * *how many are we holding* (the figure), *what is new* (the delta, in a
	 * window chosen from how often this person actually works here), and *where
	 * did they come from* (twelve weeks of arrivals, and the breakdown behind
	 * them).
	 *
	 * Discarded proposals are outside every figure above the fold, because they
	 * are not part of what the event has to work through — and inside the
	 * breakdown, because they are kept and recoverable and somebody eventually
	 * asks. That is the whole rule: a number in the total is work; a number in
	 * the panel is inventory.
	 *
	 * The breakdown opens on **press and focus**, never on hover. Hover-carried
	 * meaning never arrives on a touch device, so the figure carries a visible
	 * caption at rest that says what it is, and the plate and focus ring say it
	 * is pressable.
	 */
	import {
		describeArrivalPulse,
		describeArrivalWeek,
		type ArrivalWeek
	} from '@jooevents/contracts';
	import { Badge, Popover } from '$lib/ui';
	import type { SubmissionArrivals } from '$lib/api/types';
	import StatTile from './StatTile.svelte';

	let {
		arrivals = null,
		timezone = '',
		discardedHref
	}: {
		/**
		 * Absent while the figure is still being read. The placeholder is then
		 * this composition's own markup with skeleton fills — same delta line,
		 * same plot height, same caption — so the band's geometry comes from one
		 * stylesheet and cannot drift between the two states.
		 */
		readonly arrivals?: SubmissionArrivals | null;
		readonly timezone?: string;
		readonly discardedHref?: string;
	} = $props();

	/**
	 * One clock reading for the whole tile, taken at entry. Re-deriving it while
	 * a person reads would let "today" turn over under them mid-sentence, and
	 * every figure here is a claim about one instant.
	 */
	const now = Date.now();

	const pulse = $derived(arrivals?.pulse ?? null);
	const words = $derived(
		pulse ? describeArrivalPulse({ pulse, timezone, now }) : null
	);
	const weeks = $derived(
		(pulse?.weeks ?? []).map((week) => ({
			week,
			words: describeArrivalWeek({ week, timezone, now })
		}))
	);
	const peak = $derived(Math.max(1, ...(pulse?.weeks ?? []).map((week) => week.count)));

	/* Only the trays that hold something: a breakdown listing "0 late" spends a
	   line saying nothing happened. */
	const composition = $derived.by(() => {
		const held = arrivals?.held;
		if (!held) return [];
		return [
			held.inbox > 0 ? `${held.inbox} in the inbox` : '',
			held.setAside > 0 ? `${held.setAside} set aside` : '',
			held.late > 0 ? `${held.late} late` : ''
		].filter(Boolean);
	});

	/** A bar's height as a share of the tallest week, floored so a week that had
	    arrivals never renders as a week that had none. */
	function barHeight(week: ArrivalWeek): string {
		if (week.count === 0) return '0';
		return `${Math.max(12, Math.round((week.count / peak) * 100))}%`;
	}

	const figureName = $derived(
		pulse && words
			? `${pulse.total} held, ${words.delta === '' ? words.quiet.toLowerCase() : words.delta} — show the weekly breakdown`
			: ''
	);
</script>

{#if !pulse || !words}
	<!-- The same tile, holding its own shape: the plot on the value's line and a
	     delta beneath it, at the heights they resolve to. -->
	<StatTile label="Submissions" value="" pending>
		{#snippet valueAside()}
			<span class="spark"><span class="spark__plot"></span></span>
		{/snippet}
		{#snippet footer()}
			<span class="arrivals__delta"
				><span class="ui-skeleton arrivals__fill" style="inline-size: 7rem"></span></span>
		{/snippet}
	</StatTile>
{:else}
<StatTile label="Submissions" value={String(pulse.total)}>
	{#snippet valueAside()}
		<!-- The plot rides the number it plots. It is the trigger; the number is
		     not, because a headline count already owes its rows a landing and two
		     outcomes must never share one target. -->
		<Popover label={figureName} kind="figure" fill>
			{#snippet trigger()}
				<span class="spark">
					<span class="spark__plot" aria-hidden="true">
						{#each pulse.weeks as week, index (week.startsAt)}
							<span class="spark__slot">
								<span
									class="spark__bar"
									class:spark__bar--current={index === pulse.weeks.length - 1}
									style:block-size={barHeight(week)}></span>
							</span>
						{/each}
					</span>
					<!-- The resting statement of what the figure is, and the only thing
					     saying so before anything is hovered — which is the whole of
					     the discoverability a touch reader gets. -->
					<span class="spark__caption">{pulse.weeks.length} weeks</span>
				</span>
			{/snippet}
			{#snippet children()}
				<p class="panel__lede">{words.caption}</p>
				<table class="panel__table">
					<thead>
						<tr><th scope="col">Week</th><th scope="col">Dates</th><th scope="col">Arrived</th></tr>
					</thead>
					<tbody>
						{#each weeks as row (row.week.startsAt)}
							<tr class:panel__row--current={row.words?.current}>
								<th scope="row">{row.words?.relative ?? 'Week'}</th>
								<td class="panel__dates">{row.words?.range ?? ''}</td>
								<td class="panel__count">{row.week.count}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row" colspan="2">Held now</th>
							<td class="panel__count">{pulse.total}</td>
						</tr>
					</tfoot>
				</table>
				{#if composition.length > 0}
					<p class="panel__note">{composition.join(' · ')}.</p>
				{/if}
				{#if arrivals && arrivals.discarded > 0}
					<!-- Counted, kept, and deliberately outside every figure above:
					     said in words rather than left for someone to discover by
					     adding the trays up and finding a gap. -->
					<p class="panel__note">
						{arrivals.discarded}
						{arrivals.discarded === 1 ? 'proposal' : 'proposals'} marked as spam
						{arrivals.discarded === 1 ? 'is' : 'are'} not counted in that total.
						{#if discardedHref}
							<a href={discardedHref}>Open the spam tray</a>
						{/if}
					</p>
				{/if}
			{/snippet}
		</Popover>
	{/snippet}
	{#snippet footer()}
		<span class="arrivals__delta">
			{#if words.delta === ''}
				<span class="arrivals__quiet">{words.quiet}</span>
			{:else}
				<!-- Neutral, exactly like the New mark beside a submission row: one
				     concept, one look. Arrival is not a status and not a selection, so
				     it spends neither a status hue nor the marking family. -->
				<Badge tone="neutral" value={words.delta} />
			{/if}
		</span>
	{/snippet}
</StatTile>
{/if}

<style>
	.arrivals__delta {
		display: flex;
		min-block-size: 1.35rem;
		align-items: center;
	}

	.arrivals__fill {
		display: inline-block;
		block-size: 1lh;
		max-inline-size: 100%;
		vertical-align: bottom;
	}

	.arrivals__quiet {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	/* A sparkline on the value's line, not a block under it: plot then scale,
	   baseline to baseline, sized so the whole group fits inside the line box
	   the big figure already occupies. */
	.spark {
		display: flex;
		align-items: flex-end;
		gap: var(--je-space-2);
		min-inline-size: 0;
		/* The control's height, not the plot's: 18px of chart is a fine graphic
		   and a poor target, and this clears the 24px floor inside the line box
		   the value already occupies, so nothing moves to buy it. */
		min-block-size: 1.5rem;
	}

	/* Twelve weekly slots on one baseline. The bars are thin, the gaps are
	   surface rather than a stroke, and a week with nothing shows as an empty
	   slot above the rule — which is information, not a rendering fault. */
	.spark__plot {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		/* It fills whatever the value line has left. Bar heights are normalised to
		   the tallest week, so a wider tile draws the same shape at a different
		   aspect rather than a different chart — and a plot that could not shrink
		   painted 111px past its own tile at 390. */
		flex: 1 1 auto;
		min-inline-size: 3.5rem;
		block-size: 1.125rem;
		border-block-end: 1px solid var(--je-color-border);
		padding-block-end: 1px;
	}

	.spark__slot {
		flex: 1;
		display: flex;
		align-items: flex-end;
		min-inline-size: 0;
		/* Never thicker than the mark spec allows, however wide the tile gets. */
		max-inline-size: 1.5rem;
		block-size: 100%;
	}

	/* Emphasis rather than hue: the weeks behind are recessive ink and the week
	   in progress holds full ink. Arrival is not a status, so it spends no
	   status colour — and the accent budget stays with the banner and the
	   actions, where it buys something. */
	.spark__bar {
		inline-size: 100%;
		border-radius: 2px 2px 0 0;
		background: var(--je-color-text-subtle);
	}

	.spark__bar--current {
		background: var(--je-color-text);
	}

	/* The scale, in the tile's smallest ink and its own weight — it qualifies
	   the figure, it is not part of the value beside it. */
	.spark__caption {
		flex: 0 0 auto;
		font-size: var(--je-font-size-2xs);
		font-weight: 400;
		font-variant-numeric: normal;
		line-height: 1;
		color: var(--je-color-text-subtle);
		white-space: nowrap;
	}

	/* Below the organizer breakpoint the tile is a ~170px column, and the scale
	   label costs a third of it — twelve slots in what is left would be 1.7px
	   bars, which is precision the plot does not have. The words go and the
	   graphic keeps the room. The cost is real and recorded: on touch the plate
	   is the only affordance, as it already is for the standing plot. */
	@media (max-width: 920px) {
		.spark__caption {
			display: none;
		}
	}

	.panel__lede {
		margin: 0 0 var(--je-space-2);
		color: var(--je-color-text-muted);
	}

	.panel__table {
		inline-size: 100%;
		border-collapse: collapse;
		font-size: var(--je-font-size-xs);
	}

	.panel__table th,
	.panel__table td {
		padding-block: 2px;
		text-align: start;
		font-weight: 400;
		color: var(--je-color-text-muted);
	}

	.panel__table thead th {
		color: var(--je-color-text-subtle);
		border-block-end: 1px solid var(--je-color-border);
		padding-block-end: var(--je-space-1);
	}

	.panel__table tfoot th,
	.panel__table tfoot td {
		border-block-start: 1px solid var(--je-color-border);
		padding-block-start: var(--je-space-1);
		color: var(--je-color-text);
		font-weight: 600;
	}

	.panel__dates {
		color: var(--je-color-text-subtle);
	}

	/* A column of counts is read down, so it aligns and takes tabular figures. */
	.panel__count {
		text-align: end;
		font-variant-numeric: tabular-nums;
	}

	.panel__row--current th,
	.panel__row--current td {
		color: var(--je-color-text);
		font-weight: 600;
	}

	.panel__note {
		margin: var(--je-space-2) 0 0;
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}
</style>
